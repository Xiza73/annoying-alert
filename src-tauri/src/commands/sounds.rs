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

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::commands::{CommandError, CommandResult};

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
