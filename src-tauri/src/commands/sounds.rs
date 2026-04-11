//! Custom reminder sound storage.
//!
//! # Design
//!
//! Users can attach custom `mp3`/`wav`/`ogg`/`flac` files to individual
//! reminders. The frontend reads the picked file via the browser's
//! `FileReader` API, base64-encodes it, and passes the bytes to Rust.
//! We then:
//!
//! 1. Decode the base64 payload.
//! 2. Compute a SHA-256 hash of the content → deterministic filename.
//! 3. Write the bytes to `<app_local_data>/sounds/<hash>.<ext>`.
//! 4. Return the bare filename (`<hash>.<ext>`) as the identifier to
//!    store in `reminders.sound_file`.
//!
//! # Why content-addressed?
//!
//! - Re-uploading the exact same file is free (idempotent write).
//! - No ID generation / collision handling.
//! - Orphan cleanup can diff the `reminders` table against the dir.
//! - Unit-testable with a fixed input.
//!
//! # Playback path
//!
//! [`get_sound_data_url`] reads the file back and returns a
//! `data:audio/<mime>;base64,<payload>` URL. The overlay's `<audio>`
//! element consumes it directly. No custom URI scheme, no asset
//! protocol configuration — works in dev, bundled, and MSI installs.
//!
//! Data URLs are ~33% larger than raw bytes but typical notification
//! sounds are 20-200 KB, so a single IPC round-trip is a non-issue.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::commands::{CommandError, CommandResult};
use crate::db::DbState;

/// Allowed audio extensions. Anything else is rejected at upload time
/// so we never serve a mime type we can't identify back.
const ALLOWED_EXTS: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a"];

/// Result of a successful sound save. Returned to the form so it can
/// store the bare filename in the reminder's `sound_file` column.
#[derive(Debug, Serialize)]
pub struct SavedSound {
    pub filename: String,
    pub bytes: usize,
}

/// Resolve the `<app_local_data>/sounds/` directory, creating it if
/// missing. Shared by save + read commands so they always agree.
fn sounds_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| CommandError::InvalidInput(format!("data dir: {e}")))?
        .join("sounds");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::InvalidInput(format!("mkdir sounds: {e}")))?;
    Ok(dir)
}

/// Accept an audio file from the frontend and persist it under a
/// content-hashed filename.
///
/// # Arguments
///
/// - `original_name` — the file the user picked, used only for the
///   extension. The stored filename derives from the SHA-256 hash.
/// - `base64` — the file bytes as a standard-alphabet base64 string.
///
/// Returns the bare filename (e.g. `"a5f3...c2.mp3"`) which the
/// frontend stores in `reminders.sound_file`.
#[tauri::command]
pub fn save_sound_file(
    app: AppHandle,
    original_name: String,
    base64: String,
) -> CommandResult<SavedSound> {
    // Extract + lowercase the extension, reject anything unknown. We
    // do this BEFORE base64 decoding so a user passing a bad file
    // gets a fast error instead of waiting for 10MB of decode work.
    let ext = std::path::Path::new(&original_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .ok_or_else(|| {
            CommandError::InvalidInput(format!(
                "file has no extension: {original_name}"
            ))
        })?;

    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(CommandError::InvalidInput(format!(
            "extension .{ext} not allowed; use one of {ALLOWED_EXTS:?}"
        )));
    }

    // Decode. `decode` validates the base64 alphabet and padding, so
    // any garbage from the frontend surfaces as a clean error.
    let bytes = B64.decode(base64.as_bytes()).map_err(|e| {
        CommandError::InvalidInput(format!("base64 decode: {e}"))
    })?;

    // Generous 10 MB cap. Notification sounds are short clips; this
    // exists to prevent a bug in the frontend from blowing up disk.
    const MAX: usize = 10 * 1024 * 1024;
    if bytes.len() > MAX {
        return Err(CommandError::InvalidInput(format!(
            "sound too large: {} bytes > {}",
            bytes.len(),
            MAX
        )));
    }

    // Content hash → deterministic filename. We use hex because path
    // components in Windows can't include base64's `/` or `+` chars.
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hex_digest(&hasher.finalize());
    let filename = format!("{hash}.{ext}");

    // Write (or overwrite — same hash, same bytes, idempotent).
    let dir = sounds_dir(&app)?;
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes)
        .map_err(|e| CommandError::InvalidInput(format!("write: {e}")))?;

    log::info!(
        "saved sound file {filename} ({} bytes) at {}",
        bytes.len(),
        path.display()
    );

    Ok(SavedSound {
        filename,
        bytes: bytes.len(),
    })
}

/// Read a previously saved sound back as a `data:audio/<mime>;base64,...`
/// URL ready for direct assignment to an `<audio src={...}>` element.
///
/// Returns [`CommandError::NotFound`] if the filename refers to a file
/// that was deleted or never existed.
#[tauri::command]
pub fn get_sound_data_url(
    app: AppHandle,
    filename: String,
) -> CommandResult<String> {
    // Reject any path separators — we only serve files that live
    // directly inside `sounds/`, not arbitrary paths the frontend
    // could sneak in.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(CommandError::InvalidInput(
            "filename must be a bare name".into(),
        ));
    }

    let dir = sounds_dir(&app)?;
    let path = dir.join(&filename);
    if !path.exists() {
        return Err(CommandError::NotFound(format!("sound {filename}")));
    }

    let bytes = std::fs::read(&path)
        .map_err(|e| CommandError::InvalidInput(format!("read: {e}")))?;
    let mime = mime_for(&filename);
    let encoded = B64.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Map a filename extension to the `audio/*` MIME type expected by
/// the `<audio>` element. Unknown extensions fall back to `audio/mpeg`
/// which is the safest default across browsers and Tauri's webview.
fn mime_for(filename: &str) -> &'static str {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        _ => "audio/mpeg",
    }
}

/// Encode a 32-byte SHA-256 digest as a lowercase hex string without
/// allocating through `format!` in a loop.
fn hex_digest(digest: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ─── Orphan sweep ──────────────────────────────────────────────────────────

/// Report of a sweep pass: how many files we looked at, how many we
/// removed, and how many bytes we freed. Returned as the command
/// result and also logged when the sweep runs automatically after a
/// reminder delete.
#[derive(Debug, Serialize)]
pub struct SweepReport {
    pub scanned: usize,
    pub removed: usize,
    pub bytes_freed: u64,
}

/// Delete every file inside `sounds/` that isn't referenced by any
/// reminder's `sound_file` column. The `"default"` sentinel is always
/// excluded (it's not a file; it's a marker meaning "use the synthetic
/// beep").
///
/// This is the core primitive. Both the user-triggered
/// [`cleanup_unused_sounds`] command and the post-delete auto-sweep in
/// `commands::reminders` call it. Kept `pub(crate)` so we can share
/// the implementation without leaking internals past the commands module.
pub(crate) fn sweep_orphans(app: &AppHandle, conn: &Connection) -> CommandResult<SweepReport> {
    let dir = sounds_dir(app)?;

    // Collect every filename that's still referenced. `DISTINCT`
    // keeps the set small even with thousands of reminders.
    let mut stmt = conn.prepare(
        "SELECT DISTINCT sound_file FROM reminders \
         WHERE sound_file IS NOT NULL AND sound_file != 'default'",
    )?;
    let referenced: HashSet<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| CommandError::InvalidInput(format!("readdir sounds: {e}")))?;

    let mut scanned = 0usize;
    let mut removed = 0usize;
    let mut bytes_freed = 0u64;

    for entry in entries.flatten() {
        // Skip anything that isn't a regular file (subdirs,
        // symlinks to dirs, etc.). Our own code never puts
        // anything but flat files in here, but we stay defensive.
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }

        scanned += 1;
        let name = entry.file_name().to_string_lossy().into_owned();
        if referenced.contains(&name) {
            continue;
        }

        // Peek the size BEFORE the remove so we can report it even
        // though the file is gone by the time the caller sees the report.
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {
                removed += 1;
                bytes_freed += size;
                log::info!("swept orphan sound {name} ({size} bytes)");
            }
            Err(e) => log::warn!("failed to remove orphan sound {name}: {e}"),
        }
    }

    Ok(SweepReport {
        scanned,
        removed,
        bytes_freed,
    })
}

/// User-invoked cleanup. Runs [`sweep_orphans`] and returns the report
/// to the frontend so the SettingsSheet can show "borrados N archivos
/// (X KB)".
#[tauri::command]
pub fn cleanup_unused_sounds(
    app: AppHandle,
    state: State<'_, DbState>,
) -> CommandResult<SweepReport> {
    let conn = state.lock();
    sweep_orphans(&app, &conn)
}

// ─── Gallery / list ────────────────────────────────────────────────────────

/// Metadata for a single saved sound. Returned to the frontend so the
/// ReminderForm can render a picker of already-uploaded sounds without
/// re-uploading the same file twice.
#[derive(Debug, Serialize)]
pub struct SavedSoundMeta {
    pub filename: String,
    pub bytes: u64,
    /// How many reminders currently point at this file. Lets the UI
    /// show "usado por 3 recordatorios" and makes it obvious which
    /// sounds are safe to delete.
    pub references: usize,
}

/// List every sound file in the sounds dir with its reference count.
///
/// Sorted so the most-used sounds are first, then alphabetically for
/// a stable display order. Files with unknown extensions are filtered
/// out — they shouldn't exist (save_sound_file enforces the allowlist)
/// but better to hide them from the UI than to crash on an audio/mpeg
/// mime lookup later.
#[tauri::command]
pub fn list_saved_sounds(
    app: AppHandle,
    state: State<'_, DbState>,
) -> CommandResult<Vec<SavedSoundMeta>> {
    let dir = sounds_dir(&app)?;
    let conn = state.lock();

    // One row per distinct filename → count. HashMap lookup is O(1)
    // inside the dir walk below.
    let mut stmt = conn.prepare(
        "SELECT sound_file, COUNT(*) FROM reminders \
         WHERE sound_file IS NOT NULL AND sound_file != 'default' \
         GROUP BY sound_file",
    )?;
    let refs: HashMap<String, usize> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
        })?
        .filter_map(Result::ok)
        .collect();

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| CommandError::InvalidInput(format!("readdir sounds: {e}")))?;

    let mut out: Vec<SavedSoundMeta> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }

        let filename = entry.file_name().to_string_lossy().into_owned();
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        let Some(ext) = ext else { continue };
        if !ALLOWED_EXTS.contains(&ext.as_str()) {
            continue;
        }

        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let references = refs.get(&filename).copied().unwrap_or(0);
        out.push(SavedSoundMeta {
            filename,
            bytes,
            references,
        });
    }

    // Most-referenced first, ties broken by filename for determinism.
    out.sort_by(|a, b| {
        b.references
            .cmp(&a.references)
            .then_with(|| a.filename.cmp(&b.filename))
    });

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_digest_is_64_chars() {
        let h = hex_digest(&[0u8; 32]);
        assert_eq!(h.len(), 64);
        assert_eq!(h, "0".repeat(64));
        let h = hex_digest(&[0xab; 32]);
        assert_eq!(h, "ab".repeat(32));
    }

    #[test]
    fn mime_for_known_extensions() {
        assert_eq!(mime_for("x.mp3"), "audio/mpeg");
        assert_eq!(mime_for("X.WAV"), "audio/wav");
        assert_eq!(mime_for("beep.ogg"), "audio/ogg");
        assert_eq!(mime_for("noext"), "audio/mpeg");
    }
}
