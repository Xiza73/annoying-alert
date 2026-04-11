//! System tray icon + menu for Waqyay.
//!
//! The app lives in the tray. Closing the main window doesn't quit —
//! it hides the window, and the tray icon is the user's way back in.
//! Only the "Salir" menu item (or a real `std::process::exit`) actually
//! terminates the process, so the scheduler keeps running and
//! reminders keep firing even when the UI is "closed".
//!
//! # Design
//!
//! - **Left click on tray** → toggle main window (show/focus if hidden,
//!   hide if visible). Mirrors the OS-standard behavior of Slack,
//!   Discord, etc.
//! - **Menu** → explicit entries for Show, Settings (opens main window
//!   + tells the frontend to pop the SettingsSheet), and Quit.
//! - **Close-request on `main`** → intercepted; hides the window instead
//!   of letting the OS destroy it. The only exit path is the Quit menu
//!   item.
//!
//! # Start minimized
//!
//! If the `start_minimized` config key is `"true"`, the main window is
//! hidden immediately after setup completes. The tray icon is the
//! user's only affordance to open it. Great for auto-start scenarios.

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

/// Custom menu item IDs. Short, stable, and matched by string in the
/// menu event handler — Tauri 2's menu API is stringly-typed.
const MENU_SHOW: &str = "show";
const MENU_SETTINGS: &str = "settings";
const MENU_QUIT: &str = "quit";

/// Event emitted to the frontend when the user clicks "Configuración"
/// in the tray menu. `App.tsx` listens for this and opens the
/// SettingsSheet. Using an event (not a command) keeps the tray
/// Rust-side stateless.
pub const OPEN_SETTINGS_EVENT: &str = "tray://open-settings";

/// Build the tray icon, attach the menu, and wire the close-request
/// interceptor on the main window. Called from `lib.rs::run` after the
/// scheduler is live.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id("waqyay-tray")
        .tooltip("Waqyay — recordatorios imposibles de ignorar")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundled window icon should exist"),
        )
        .menu(&menu)
        // `false`: left-click should NOT auto-open the menu. We handle
        // left-click ourselves (toggle main window) in `on_tray_icon_event`.
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_icon_event)
        .build(app)?;

    attach_close_interceptor(app);

    Ok(())
}

/// Build the context menu shown on right-click.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Mostrar Waqyay", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Configuración…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Salir", true, None::<&str>)?;

    Menu::with_items(app, &[&show, &settings, &separator, &quit])
}

/// Router for menu clicks. Matches on the stable string IDs.
fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        MENU_SHOW => show_and_focus_main(app),
        MENU_SETTINGS => {
            show_and_focus_main(app);
            // Fire-and-forget: the frontend listens via a `listen` call
            // in App.tsx. If no listener is attached yet (unlikely —
            // the main window is now visible), the event is dropped,
            // which is fine: the user can still click the settings icon.
            if let Err(err) = app.emit(OPEN_SETTINGS_EVENT, ()) {
                log::warn!("failed to emit {OPEN_SETTINGS_EVENT}: {err}");
            }
        }
        MENU_QUIT => {
            // Real exit. Skips the close-request interceptor because
            // `app.exit` tears down the event loop directly instead of
            // closing the window.
            app.exit(0);
        }
        other => log::warn!("unknown tray menu id: {other}"),
    }
}

/// Left-click (release) toggles the main window. Right-click is
/// handled implicitly by Tauri (it opens the menu we attached above).
fn handle_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_main(tray.app_handle());
    }
}

/// Intercept `close-requested` on the `main` window: hide instead of
/// destroy. Attached once per process from [`build`].
fn attach_close_interceptor(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        log::warn!("main window missing during tray setup; skipping close interceptor");
        return;
    };

    let handle = app.clone();
    main.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("main") {
                if let Err(err) = window.hide() {
                    log::error!("failed to hide main window on close-request: {err}");
                }
            }
        }
    });
}

/// Show-and-focus the main window. Creates nothing — the window always
/// exists from `tauri.conf.json`; it's just hidden when the user "closes".
fn show_and_focus_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("main window missing on show request");
        return;
    };
    if let Err(err) = window.show() {
        log::error!("failed to show main window: {err}");
        return;
    }
    if let Err(err) = window.unminimize() {
        log::warn!("failed to unminimize main window: {err}");
    }
    if let Err(err) = window.set_focus() {
        log::warn!("failed to focus main window: {err}");
    }
}

/// Hide if visible, show if hidden. Used by left-click on the tray icon.
fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("main window missing on toggle");
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            if let Err(err) = window.hide() {
                log::error!("failed to hide main window on toggle: {err}");
            }
        }
        Ok(false) => show_and_focus_main(app),
        Err(err) => log::warn!("failed to query main window visibility: {err}"),
    }
}

/// Hide the main window at startup if the `start_minimized` config key
/// is truthy. Called from `lib.rs::run` immediately after the tray is
/// built. Kept separate from [`build`] so the tray can still be unit-
/// tested without touching the DB.
pub fn maybe_start_minimized(app: &AppHandle) {
    let enabled = match read_start_minimized(app) {
        Ok(v) => v,
        Err(err) => {
            log::warn!("failed to read start_minimized config: {err}");
            return;
        }
    };
    if !enabled {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(err) = window.hide() {
        log::warn!("failed to hide main window at startup: {err}");
    }
}

/// Read the `start_minimized` config row as a bool. Missing → false.
fn read_start_minimized(app: &AppHandle) -> anyhow::Result<bool> {
    let state = app.state::<crate::db::DbState>();
    let conn = state.lock();
    let value = crate::db::config::get(&conn, "start_minimized")?;
    Ok(matches!(value.as_deref(), Some("true" | "1")))
}
