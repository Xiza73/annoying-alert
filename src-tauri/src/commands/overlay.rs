//! Overlay window commands.
//!
//! Centralises operations that must happen from the Rust side (fullscreen
//! exit, programmatic destroy) because WebView2 on Windows silently ignores
//! `window.close()` during the fullscreen → normal transition (Tauri v2 known issue).

use tauri::{AppHandle, Manager};

use crate::commands::{CommandError, CommandResult};

/// Dismiss (destroy) an overlay window from the Rust side.
///
/// This is the workaround for a Tauri v2 + WebView2 + fullscreen bug on
/// Windows where `window.close()` fails silently during the fullscreen →
/// normal transition (intrusiveness level 5).
///
/// Steps:
/// 1. Look up the window by label `overlay-{reminder_id}`.
/// 2. Try to exit fullscreen first — WebView2 requires this before destroy.
/// 3. Sleep 50 ms to let WebView2 process the fullscreen transition.
/// 4. Destroy the window unconditionally (`destroy()` bypasses CloseRequested).
///
/// Returns `Ok(())` if the window is already gone (idempotent).
#[tauri::command]
pub fn dismiss_overlay(app: AppHandle, reminder_id: i64) -> CommandResult<()> {
    let label = format!("overlay-{reminder_id}");

    let Some(window) = app.get_webview_window(&label) else {
        log::warn!("dismiss_overlay: window {label} not found");
        return Ok(()); // idempotente: no es error si ya cerró
    };

    // Exit fullscreen first — WebView2 + fullscreen can ignore destroy/close
    if let Err(err) = window.set_fullscreen(false) {
        log::warn!("dismiss_overlay: failed to exit fullscreen for {label}: {err}");
        // best-effort: continue trying to destroy
    }

    // Give WebView2 a tick to process the fullscreen transition before destroy
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Use destroy() instead of close() — unconditional, no CloseRequested event,
    // bypasses any JS interceptor and any window-in-transition silent-failure.
    if let Err(err) = window.destroy() {
        log::error!("dismiss_overlay: failed to destroy {label}: {err}");
        return Err(CommandError::InvalidInput(format!(
            "failed to destroy overlay {label}: {err}"
        )));
    }

    Ok(())
}
