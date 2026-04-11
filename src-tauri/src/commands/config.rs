//! Tauri commands over the `config` key/value table.
//!
//! Thin wrappers over [`crate::db::config`] so the frontend can read and
//! write global settings (quiet hours, default snooze, ntfy topic, etc.)
//! through a stable IPC surface.
//!
//! # Why string values, not typed ones?
//!
//! The `config` table is intentionally flat and stringly-typed — it
//! mirrors the Python schema verbatim, which stores everything as TEXT.
//! Type coercion (parse to int, parse "HH:MM", etc.) lives in the
//! consumer (scheduler or React), not here, so adding a new key doesn't
//! require touching the IPC contract.

use rusqlite::params;
use tauri::State;

use crate::commands::{CommandError, CommandResult};
use crate::db::{config as db_config, DbState};

/// Read a single config value by key. Returns the stored string, or
/// `None` if the key hasn't been seeded. The frontend handles type
/// conversion (e.g. `parseInt(value, 10)`).
#[tauri::command]
pub fn get_config(
    state: State<'_, DbState>,
    key: String,
) -> CommandResult<Option<String>> {
    let conn = state.lock();
    db_config::get(&conn, &key).map_err(CommandError::from)
}

/// Write a single config value by key. Creates the row if it doesn't
/// exist yet (UPSERT via `INSERT OR REPLACE`). The empty-string value
/// is valid (e.g. unset ntfy_topic).
#[tauri::command]
pub fn set_config(
    state: State<'_, DbState>,
    key: String,
    value: String,
) -> CommandResult<()> {
    if key.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "config key cannot be empty".into(),
        ));
    }

    let conn = state.lock();
    conn.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    log::info!("set_config: {key}={value}");
    Ok(())
}
