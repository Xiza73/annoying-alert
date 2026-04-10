//! Lightweight version-based migration runner.
//!
//! We track the applied schema version in SQLite's built-in `user_version`
//! pragma. No need for a separate meta-table — this is the canonical SQLite
//! way to version a database, and it's atomic with the rest of the schema.
//!
//! ## Adding a new migration
//!
//! 1. Bump `TARGET_VERSION` by 1.
//! 2. Add a new `(version, sql)` tuple to `MIGRATIONS`, in order.
//! 3. The runner applies every migration whose version > current_user_version,
//!    wrapped in a single transaction per migration.
//!
//! Migrations are never re-run or rolled back. If you need to undo something,
//! you add a NEW migration that undoes it. Database history is append-only.

use rusqlite::Connection;

/// Current target schema version. Increment when adding a migration.
pub const TARGET_VERSION: i32 = 1;

/// Ordered list of migrations. Each tuple is `(version, sql)`. The SQL may
/// contain multiple statements and is executed with `execute_batch`.
const MIGRATIONS: &[(i32, &str)] = &[
    // Version 1 is a no-op marker: the initial schema is created by
    // `schema::INITIAL_SCHEMA` during bootstrap, so we just bump the
    // user_version to 1 to signal the DB is at the baseline.
    (1, "-- baseline, created by INITIAL_SCHEMA"),
];

/// Read the current schema version from SQLite's `user_version` pragma.
pub fn current_version(conn: &Connection) -> rusqlite::Result<i32> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// Apply all pending migrations up to `TARGET_VERSION`.
///
/// Each migration runs in its own transaction: if one fails, that migration
/// is rolled back and the function returns an error, leaving the DB at the
/// last successfully-applied version.
pub fn run(conn: &mut Connection) -> rusqlite::Result<()> {
    let current = current_version(conn)?;
    log::info!(
        "db migrations: current_version={current}, target_version={TARGET_VERSION}",
    );

    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        log::info!("applying migration v{version}");
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // We commit the migration SQL and the version bump together so a
        // crash between the two cannot leave the DB in an inconsistent state.
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        tx.commit()?;
    }

    let final_version = current_version(conn)?;
    log::info!("db migrations: done, version={final_version}");
    Ok(())
}

