//! Typed accessors over the `config` key/value table.
//!
//! The `config` table is a flat dictionary of `(key TEXT PRIMARY KEY, value
//! TEXT NOT NULL)` rows seeded by [`crate::db::schema::DEFAULT_CONFIG`]. We
//! access it from two places:
//!
//! 1. The scheduler thread, to read notification-related settings on each
//!    fire (ntfy server/topic, quiet hours, etc.).
//! 2. Future "settings" Tauri commands that let the UI read/write values.
//!
//! This module stays tiny on purpose — no caching, no "settings struct",
//! just `get` / `get_or_default`. Reminders are infrequent events; looking
//! up a handful of rows per fire is nothing.
//!
//! If lookups ever become hot, we can memoize the whole table into a
//! `HashMap<String, String>` on startup and invalidate on writes. Don't
//! optimize until there's a profile saying it matters.

use rusqlite::{params, Connection, OptionalExtension};

/// Fetch a single config value by key. Returns `Ok(None)` if the key is
/// missing from the table (e.g. a new key we haven't seeded yet).
pub fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM config WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

/// Fetch a config value, falling back to `default` if the key is missing
/// or the DB read fails. Errors are logged but swallowed — config reads
/// should never crash the scheduler; falling back to a sane default is
/// always safer than blowing up the whole tick.
pub fn get_or_default(conn: &Connection, key: &str, default: &str) -> String {
    match get(conn, key) {
        Ok(Some(v)) => v,
        Ok(None) => default.to_string(),
        Err(e) => {
            log::warn!("config read failed for key={key:?}: {e}; using default");
            default.to_string()
        }
    }
}
