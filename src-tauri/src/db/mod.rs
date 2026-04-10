//! Database layer: connection management, schema bootstrap, migrations.
//!
//! # Lifecycle
//!
//! 1. During Tauri `setup()`, we resolve `app_local_data_dir()` and create
//!    `waqyay.db` inside it (creating the directory if needed).
//! 2. We apply the initial schema (`schema::INITIAL_SCHEMA`) and default
//!    config rows. These use `IF NOT EXISTS` / `INSERT OR IGNORE`, so this
//!    is safe to run on every start.
//! 3. We run pending migrations via `migrations::run`.
//! 4. We wrap the `Connection` in a `Mutex` and register it as Tauri state
//!    via `app.manage(DbState { ... })`. Every command that needs DB access
//!    asks for `State<'_, DbState>` and locks the mutex.
//!
//! # Concurrency
//!
//! Tauri invokes commands on a worker thread, so multiple commands may race
//! on the same connection. A single `Mutex<Connection>` serializes access.
//! This is the simplest correct option; if lock contention becomes a
//! bottleneck we can switch to `r2d2` + `r2d2_sqlite` for a real pool.
//!
//! # PRAGMAs
//!
//! - `journal_mode = WAL` — write-ahead logging, better concurrent reads
//!   and crash safety vs the default rollback journal.
//! - `foreign_keys = ON` — SQLite does NOT enforce FKs by default; we must
//!   turn them on per-connection.

pub mod migrations;
pub mod schema;

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// Tauri-managed state wrapping the SQLite connection.
///
/// Commands grab this via `State<'_, DbState>` and call `state.lock()` to
/// get mutable access to the underlying `Connection`.
pub struct DbState {
    pub conn: Mutex<Connection>,
}

impl DbState {
    /// Convenience: lock the connection, panicking on a poisoned mutex.
    ///
    /// Poisoning only happens if a previous holder panicked while holding
    /// the lock. In that case the DB state is probably corrupt anyway, so
    /// panicking is acceptable — we don't want to silently work on a
    /// possibly-broken transaction.
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db mutex poisoned")
    }
}

/// Resolve the path to `waqyay.db` inside the platform-specific local data
/// directory, creating the parent directory if it doesn't exist.
///
/// On Windows this resolves to:
///   `%LOCALAPPDATA%\com.xiza.waqyay\waqyay.db`
pub fn resolve_db_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .context("resolving app local data dir")?;

    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;

    Ok(data_dir.join("waqyay.db"))
}

/// Open the database at the given path, apply PRAGMAs, bootstrap the schema
/// and default config, and run pending migrations.
///
/// Returns a fully-initialized `Connection` ready to be wrapped in `DbState`.
pub fn open_and_init(db_path: &PathBuf) -> Result<Connection> {
    log::info!("opening db at {}", db_path.display());

    let mut conn = Connection::open(db_path)
        .with_context(|| format!("opening sqlite db at {}", db_path.display()))?;

    // PRAGMAs must be set on every new connection.
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        ",
    )
    .context("setting pragmas")?;

    // Bootstrap tables and indexes (idempotent).
    conn.execute_batch(schema::INITIAL_SCHEMA)
        .context("creating initial schema")?;

    // Seed default config values. `INSERT OR IGNORE` means user edits are
    // preserved across restarts.
    {
        let tx = conn.transaction().context("starting config seed tx")?;
        {
            let mut stmt = tx
                .prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?1, ?2)")
                .context("preparing config seed stmt")?;
            for (key, value) in schema::DEFAULT_CONFIG {
                stmt.execute([key, value])
                    .with_context(|| format!("seeding config key {key}"))?;
            }
        }
        tx.commit().context("committing config seed tx")?;
    }

    // Apply pending migrations.
    migrations::run(&mut conn).context("running migrations")?;

    log::info!("db ready");
    Ok(conn)
}

/// High-level helper: resolve path, open, init, wrap in `DbState`, and
/// register it with the Tauri app. Call this from the `setup()` hook.
pub fn init_and_manage(app: &AppHandle) -> Result<()> {
    let db_path = resolve_db_path(app).context("resolving db path")?;
    let conn = open_and_init(&db_path).context("initializing db")?;
    app.manage(DbState {
        conn: Mutex::new(conn),
    });
    Ok(())
}
