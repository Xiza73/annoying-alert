//! Overlay window commands.
//!
//! Centralises operations that must happen from the Rust side (fullscreen
//! exit, programmatic close) because WebView2 on Windows blocks `window.close()`
//! when the window is in fullscreen mode (Tauri v2 known issue).

use tauri::{AppHandle, Manager};

use crate::commands::{CommandError, CommandResult};

/// Dismiss (close) an overlay window from the Rust side.
///
/// This is the workaround for a Tauri v2 + WebView2 + fullscreen bug on
/// Windows where calling `window.close()` from JS has no effect when the
/// window is fullscreen (intrusiveness level 5).
///
/// Steps:
/// 1. Look up the window by label `overlay-{reminder_id}`.
/// 2. Try to exit fullscreen first — WebView2 requires this before closing.
/// 3. Close the window.
///
/// Returns `Ok(())` if the window is already gone (idempotent).
#[tauri::command]
pub fn dismiss_overlay(app: AppHandle, reminder_id: i64) -> CommandResult<()> {
    let label = format!("overlay-{reminder_id}");

    let Some(window) = app.get_webview_window(&label) else {
        log::warn!("dismiss_overlay: window {label} not found");
        return Ok(()); // idempotente: no es error si ya cerró
    };

    // Exit fullscreen first — WebView2 + fullscreen can block close()
    if let Err(err) = window.set_fullscreen(false) {
        log::warn!("dismiss_overlay: failed to exit fullscreen for {label}: {err}");
        // best-effort: continue trying to close
    }

    if let Err(err) = window.close() {
        log::error!("dismiss_overlay: failed to close {label}: {err}");
        return Err(CommandError::InvalidInput(format!(
            "failed to close overlay {label}: {err}"
        )));
    }

    Ok(())
}
