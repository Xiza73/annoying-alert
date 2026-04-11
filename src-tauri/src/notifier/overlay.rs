//! Custom Tauri webview windows as the "desktop" notification channel.
//!
//! The whole point of Waqyay is to be *impossible to ignore*. Windows toast
//! notifications go through the OS notification center, which users can
//! mute, hide, disable in Focus Assist, or simply get numb to. So we
//! sidestep them entirely: every fired reminder gets its own dedicated
//! webview window, created from Rust via [`tauri::WebviewWindowBuilder`].
//!
//! # Intrusiveness scaling (Fase 5.5.1)
//!
//! The window geometry, placement, and focus behavior all scale with
//! `reminder.intrusiveness` (1..5). See [`OverlayConfig::for_level`] for
//! the full table. High-level summary:
//!
//! | Level | Size      | Placement  | Focus | Fullscreen |
//! |-------|-----------|------------|-------|------------|
//! | 1     | 360×120   | top-right  | no    | no         |
//! | 2     | 440×180   | top-right  | no    | no         |
//! | 3     | 640×420   | center     | yes   | no         |
//! | 4     | 820×560   | center     | yes   | no         |
//! | 5     | monitor   | fullscreen | yes   | yes        |
//!
//! All levels share: undecorated, always-on-top, skip-taskbar, no shadow.
//! L5 additionally asks Tauri for true fullscreen. The React overlay then
//! decides dismiss behavior (countdown, auto-close, etc.) based on the
//! `level` query param.
//!
//! # Same React app, different route
//!
//! The overlay window loads the same Vite bundle as the main app but
//! with query params `?mode=overlay&id=<reminder_id>&level=<1..5>`. The
//! entry `src/main.tsx` inspects `window.location.search` at boot and
//! renders a dedicated `<Overlay>` component. One Vite build, two React
//! trees, zero extra bundling work.
//!
//! # Thread safety
//!
//! We're called from the scheduler background thread. Tauri v2's
//! `WebviewWindowBuilder::build()` MUST run on the main thread — we
//! use `AppHandle::run_on_main_thread` to dispatch the construction
//! closure to the event loop. This is async (fire-and-forget); we
//! don't block waiting for the window to actually appear.

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::models::Reminder;

/// Geometry + window flags derived from an intrusiveness level.
///
/// A plain struct so it's trivial to test: the scaling logic is pure
/// data, no `AppHandle` needed until we actually build the window.
#[derive(Debug, Clone, Copy)]
struct OverlayConfig {
    width: f64,
    height: f64,
    placement: Placement,
    focused: bool,
    fullscreen: bool,
}

/// Where the overlay appears on screen. Fullscreen covers everything;
/// TopRight pins to the top-right corner (toast-style); Center is
/// smack in the middle of the primary monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    Center,
    TopRight,
    Fullscreen,
}

impl OverlayConfig {
    /// Compute the config for a given intrusiveness level. Out-of-range
    /// values are clamped into 1..=5. The baseline (L3) matches the
    /// pre-scaling dimensions so existing reminders don't jump visually.
    fn for_level(level: i64) -> Self {
        match level.clamp(1, 5) {
            1 => Self {
                width: 360.0,
                height: 120.0,
                placement: Placement::TopRight,
                focused: false,
                fullscreen: false,
            },
            2 => Self {
                width: 440.0,
                height: 180.0,
                placement: Placement::TopRight,
                focused: false,
                fullscreen: false,
            },
            3 => Self {
                width: 640.0,
                height: 420.0,
                placement: Placement::Center,
                focused: true,
                fullscreen: false,
            },
            4 => Self {
                width: 820.0,
                height: 560.0,
                placement: Placement::Center,
                focused: true,
                fullscreen: false,
            },
            _ => Self {
                // Filled in at build time from the primary monitor's
                // logical size. We keep placeholder values here so
                // the struct is still trivially `Copy`.
                width: 1920.0,
                height: 1080.0,
                placement: Placement::Fullscreen,
                focused: true,
                fullscreen: true,
            },
        }
    }
}

/// Spawn an intrusive overlay window for the given reminder.
///
/// Fire-and-forget: we dispatch the window-builder closure to the main
/// thread and return immediately. Any construction error is logged from
/// inside the closure because we can't propagate errors across the
/// main-thread boundary synchronously.
pub fn show(app: &AppHandle, reminder: &Reminder) -> Result<()> {
    // Unique label per reminder id. If the same reminder fires twice in
    // a row (e.g. a pomodoro cycle) and the previous overlay is still
    // open, Tauri's builder will return an error because labels must be
    // unique. We check for an existing window first and just refocus it.
    let label = format!("overlay-{}", reminder.id);

    if let Some(existing) = app.get_webview_window(&label) {
        log::debug!("overlay: window {label} already exists, refocusing");
        let _ = existing.set_focus();
        return Ok(());
    }

    let level = reminder.intrusiveness;
    let config = OverlayConfig::for_level(level);

    // Build the URL that `src/main.tsx` will inspect to pick the right
    // React tree. `WebviewUrl::App` treats the argument as a path/URL
    // relative to the app's dist dir (or the dev server in `tauri dev`).
    // Query params survive the join on both sides. `level` drives the
    // frontend variant (compact toast / standard / locked fullscreen).
    let url_path = format!(
        "index.html?mode=overlay&id={}&level={}",
        reminder.id, level
    );
    let url = WebviewUrl::App(url_path.into());

    let app_clone = app.clone();
    let label_owned = label.clone();

    // Dispatch the build to the main thread. Tauri v2 requires window
    // creation from the main event loop thread.
    app.run_on_main_thread(move || {
        match build_overlay_window(&app_clone, &label_owned, url, config) {
            Ok(_) => {
                log::info!("overlay window {label_owned} created (level={level})")
            }
            Err(e) => log::error!("overlay window {label_owned} failed: {e:#}"),
        }
    })
    .context("dispatching overlay build to main thread")?;

    Ok(())
}

/// Actual `WebviewWindowBuilder` call. Runs on the main thread.
///
/// Placement math (top-right and fullscreen) needs the primary monitor,
/// which is a main-thread-only operation in Tauri v2. Doing it here
/// keeps the threading rules clean.
fn build_overlay_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    config: OverlayConfig,
) -> Result<()> {
    // Resolve actual dimensions + position against the primary monitor.
    // Logical coords (CSS pixels) are what the builder expects on all
    // platforms, so we divide physical size by scale factor.
    let (width, height, pos) = resolve_geometry(app, config)?;

    let mut builder = WebviewWindowBuilder::new(app, label, url)
        .title("Waqyay")
        .inner_size(width, height)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(config.focused)
        // No shadow is cosmetic; undecorated windows on Windows can have
        // a weird default shadow rectangle that betrays their square shape.
        .shadow(false);

    // Position OR center, never both (Tauri errors if both are set).
    builder = match pos {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    // True fullscreen for L5. The webview fills the entire primary
    // monitor and takes over the space normally reserved for the
    // taskbar. Combined with `always_on_top` + `skip_taskbar` it's the
    // closest we can get to "impossible to ignore" without OS hooks.
    if config.fullscreen {
        builder = builder.fullscreen(true);
    }

    builder.build().context("building overlay webview window")?;

    Ok(())
}

/// Compute final (width, height, optional absolute position) from an
/// abstract `OverlayConfig`. For center-placed overlays we return `None`
/// for the position and let the builder call `.center()` itself.
fn resolve_geometry(
    app: &AppHandle,
    config: OverlayConfig,
) -> Result<(f64, f64, Option<(f64, f64)>)> {
    // `primary_monitor` is `Option` — headless CI or an unplugged HDMI
    // can return None. Fall back to the config's literal values so we
    // still produce *some* window rather than failing outright.
    let monitor = app
        .primary_monitor()
        .context("querying primary monitor")?;

    let Some(monitor) = monitor else {
        log::warn!("overlay: no primary monitor, falling back to centered literal size");
        return Ok((config.width, config.height, None));
    };

    let scale = monitor.scale_factor();
    let physical = monitor.size();
    let logical_w = physical.width as f64 / scale;
    let logical_h = physical.height as f64 / scale;

    match config.placement {
        Placement::Center => Ok((config.width, config.height, None)),

        Placement::TopRight => {
            // 20px margin from the right edge, 20px from the top. Clamp
            // to 0 in the unlikely case the config width exceeds the
            // monitor (e.g. a 320x240 VM).
            let margin = 20.0;
            let x = (logical_w - config.width - margin).max(0.0);
            let y = margin;
            Ok((config.width, config.height, Some((x, y))))
        }

        Placement::Fullscreen => {
            // Match the monitor exactly. Tauri's `.fullscreen(true)`
            // will override this at build time, but setting inner_size
            // explicitly avoids a visible flash of the placeholder
            // dimensions while the OS is still transitioning.
            Ok((logical_w, logical_h, Some((0.0, 0.0))))
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_1_and_2_are_toast_style_top_right_no_focus() {
        let l1 = OverlayConfig::for_level(1);
        assert_eq!(l1.placement, Placement::TopRight);
        assert!(!l1.focused);
        assert!(!l1.fullscreen);

        let l2 = OverlayConfig::for_level(2);
        assert_eq!(l2.placement, Placement::TopRight);
        assert!(!l2.focused);
    }

    #[test]
    fn level_3_is_centered_and_focused() {
        let cfg = OverlayConfig::for_level(3);
        assert_eq!(cfg.placement, Placement::Center);
        assert!(cfg.focused);
        assert!(!cfg.fullscreen);
        // Baseline must match the pre-scaling dimensions so existing
        // reminders don't jump when Fase 5.5.1 ships.
        assert_eq!(cfg.width, 640.0);
        assert_eq!(cfg.height, 420.0);
    }

    #[test]
    fn level_5_is_fullscreen() {
        let cfg = OverlayConfig::for_level(5);
        assert_eq!(cfg.placement, Placement::Fullscreen);
        assert!(cfg.fullscreen);
        assert!(cfg.focused);
    }

    #[test]
    fn out_of_range_levels_are_clamped() {
        let low = OverlayConfig::for_level(0);
        assert_eq!(low.placement, Placement::TopRight); // clamps to L1
        let high = OverlayConfig::for_level(99);
        assert_eq!(high.placement, Placement::Fullscreen); // clamps to L5
        let neg = OverlayConfig::for_level(-3);
        assert_eq!(neg.placement, Placement::TopRight); // clamps to L1
    }
}
