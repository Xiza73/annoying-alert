// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

pub mod commands;
pub mod db;
pub mod models;

/// Sample command kept from the Tauri scaffold. Used by the bootstrap
/// smoke test in `src/app/App.tsx` to confirm the IPC bridge is wired up.
/// Will be removed once real reminder commands land in Fase 2.4.
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Initialize the SQLite database and register it as Tauri state.
            // Any command can now grab it via `State<'_, db::DbState>`.
            db::init_and_manage(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(format!("db init: {e:#}"))))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::reminders::list_reminders,
            commands::reminders::create_reminder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
