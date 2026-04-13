// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

pub mod commands;
pub mod db;
pub mod models;
pub mod notifier;
pub mod scheduler;
pub mod tray;

/// Sample command kept from the Tauri scaffold. Used by the bootstrap
/// smoke test in `src/app/App.tsx` to confirm the IPC bridge is wired up.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging. Respects `RUST_LOG` env var; falls back to `info`
    // for this crate only so third-party crates don't drown us in debug.
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("waqyay_lib=info,warn"),
    )
    .init();

    tauri::Builder::default()
        // Single-instance MUST be the first plugin registered. When a
        // second instance launches, this plugin fires the callback in
        // the already-running process and then immediately exits the
        // second process — so whatever we do in the callback (show the
        // main window, focus it) happens inside instance #1.
        //
        // This matches the Python app's behavior where relaunching the
        // shortcut used to spawn a parallel process with its own
        // scheduler, producing double fires.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            log::info!("single-instance: second launch detected, focusing main window");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // Autostart on login. No extra args — if the user has
        // `start_minimized` enabled the tray module reads that config
        // key at startup, so a plain launch is enough.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Initialize the SQLite database and register it as Tauri state.
            // Any command can now grab it via `State<'_, db::DbState>`.
            db::init_and_manage(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(format!("db init: {e:#}"))))?;

            // Start the background scheduler thread. It opens its own DB
            // connection (WAL makes this safe) and emits `reminder_fired`
            // events whenever a due reminder is processed.
            scheduler::start(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(format!("scheduler: {e:#}"))))?;

            // System tray: tray icon + menu + close-to-tray interceptor.
            // Must come after db init because `maybe_start_minimized`
            // reads the `start_minimized` config key via DbState.
            tray::build(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(format!("tray: {e:#}"))))?;
            tray::maybe_start_minimized(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::reminders::list_reminders,
            commands::reminders::get_reminder,
            commands::reminders::create_reminder,
            commands::reminders::update_reminder,
            commands::reminders::delete_reminder,
            commands::reminders::delete_all_reminders,
            commands::reminders::toggle_reminder_active,
            commands::reminders::snooze_reminder,
            commands::config::get_config,
            commands::config::set_config,
            commands::sounds::save_sound_file,
            commands::sounds::get_sound_data_url,
            commands::sounds::list_saved_sounds,
            commands::sounds::cleanup_unused_sounds,
            commands::overlay::dismiss_overlay,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
