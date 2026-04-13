//! Background scheduler: the heartbeat of Waqyay.
//!
//! A dedicated OS thread wakes up every `TICK_INTERVAL` seconds, queries the
//! DB for reminders whose `next_trigger` has passed, and "fires" each one:
//!
//!   1. Compute the post-fire state via [`next_trigger::compute_after_fire`]
//!      (pure function — tested in isolation).
//!   2. Write the new state back: `UPDATE reminders SET ...`
//!   3. Record the event in `reminder_history (action='shown')`.
//!   4. Emit a Tauri event `reminder_fired` with the updated [`Reminder`] as
//!      payload so the frontend can react (toast, refresh list, play sound).
//!
//! # Why a separate thread and not `tokio::spawn`?
//!
//! `rusqlite` is synchronous. Wrapping sync blocking code in async buys us
//! nothing and pulls in the whole tokio runtime. A single OS thread with
//! `std::thread::sleep` is the idiomatic match here.
//!
//! # Why a separate SQLite connection?
//!
//! The Tauri commands share one `Connection` behind a `Mutex` (see
//! `db::DbState`). If the scheduler grabbed that same mutex, a long-running
//! command could stall the tick and vice versa. WAL mode lets SQLite have
//! many concurrent readers plus one writer across connections, so the
//! scheduler opens its own connection and runs independently.
//!
//! # Shutdown
//!
//! The thread has no explicit stop signal. When the Tauri process exits,
//! the OS reaps the thread. We don't hold any resources across ticks that
//! would leak (the `Connection` is closed by `Drop` on process exit). If we
//! ever need graceful shutdown (e.g. to flush pending writes), we can add
//! an `AtomicBool` stop flag.

pub mod cron_parser;
pub mod next_trigger;
pub mod quiet_hours;

use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{Local, NaiveDateTime};
use rusqlite::{params, Connection};
use tauri::{AppHandle, Emitter};

use crate::db::resolve_db_path;
use crate::models::{PomodoroPhase, Reminder, ReminderKind};
use crate::notifier;
use crate::scheduler::next_trigger::{compute_after_fire, AfterFire};
use crate::scheduler::quiet_hours::{is_within_quiet_hours, QuietHoursConfig};

/// How often the scheduler polls the DB for due reminders.
///
/// 5 seconds matches the Python app's default and gives us sub-10s latency
/// without hammering SQLite. The `check_interval` config key exists for
/// future runtime tuning but isn't read yet.
const TICK_INTERVAL: Duration = Duration::from_secs(5);

/// Name of the Tauri event emitted when a reminder fires. Keep this in sync
/// with the `listen()` call on the frontend.
pub const REMINDER_FIRED_EVENT: &str = "reminder_fired";

/// Launch the scheduler background thread. Call this once from the Tauri
/// `setup()` hook, AFTER `db::init_and_manage` has created the DB file.
///
/// The thread owns its own `AppHandle` clone (cheap — it's an `Arc`) so it
/// can emit events and resolve paths without borrowing from `setup()`.
pub fn start(app: &AppHandle) -> Result<()> {
    let app = app.clone();
    thread::Builder::new()
        .name("waqyay-scheduler".into())
        .spawn(move || {
            if let Err(e) = run_loop(app) {
                // We log-and-die: if the scheduler can't open its own DB
                // connection, there's no point retrying in a tight loop.
                // The Tauri UI still works (commands have their own conn),
                // so we fail loud but don't crash the whole app.
                log::error!("scheduler thread exited with error: {e:#}");
            }
        })
        .context("spawning scheduler thread")?;

    log::info!("scheduler started (tick = {:?})", TICK_INTERVAL);
    Ok(())
}

/// The main loop. Opens its own `Connection`, then ticks forever.
fn run_loop(app: AppHandle) -> Result<()> {
    let db_path = resolve_db_path(&app).context("scheduler: resolving db path")?;
    log::info!("scheduler: opening own connection at {}", db_path.display());

    let conn = Connection::open(&db_path)
        .with_context(|| format!("scheduler: opening {}", db_path.display()))?;

    // Same PRAGMAs as the command-side connection. WAL is per-database, not
    // per-connection, but setting it is idempotent and cheap.
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        ",
    )
    .context("scheduler: setting pragmas")?;

    loop {
        if let Err(e) = tick(&conn, &app) {
            // Errors inside a tick shouldn't kill the loop — a bad row
            // shouldn't halt the whole scheduler. Log and keep going.
            log::error!("scheduler tick failed: {e:#}");
        }
        thread::sleep(TICK_INTERVAL);
    }
}

/// Execute one polling tick: find due reminders and fire each one.
fn tick(conn: &Connection, app: &AppHandle) -> Result<()> {
    // `NaiveDateTime` (local) matches how we store `created_at` etc. — the
    // Python app uses `datetime('now', 'localtime')` in SQL defaults.
    let now = Local::now().naive_local();

    let due = fetch_due(conn, now).context("fetching due reminders")?;
    if due.is_empty() {
        return Ok(());
    }
    log::info!("scheduler: firing {} due reminder(s)", due.len());

    for reminder in due {
        if let Err(e) = fire(&reminder, conn, app, now) {
            log::error!("failed to fire reminder id={}: {e:#}", reminder.id);
        }
    }

    Ok(())
}

/// Query reminders whose `next_trigger` has passed and which are not
/// currently snoozed. Returns at most a few rows under normal usage.
fn fetch_due(conn: &Connection, now: NaiveDateTime) -> Result<Vec<Reminder>> {
    let mut stmt = conn
        .prepare(
            "
            SELECT * FROM reminders
            WHERE is_active = 1
              AND next_trigger IS NOT NULL
              AND next_trigger <= ?1
              AND (snooze_until IS NULL OR snooze_until <= ?1)
            ORDER BY next_trigger ASC
            ",
        )
        .context("preparing due query")?;

    let rows = stmt
        .query_map(params![now], Reminder::from_row)
        .context("executing due query")?;

    let reminders: Vec<Reminder> = rows
        .collect::<rusqlite::Result<_>>()
        .context("collecting due rows")?;

    Ok(reminders)
}

/// Fire a single reminder: compute next state, persist it, record history,
/// then emit a Tauri event with the refreshed row.
fn fire(
    reminder: &Reminder,
    conn: &Connection,
    app: &AppHandle,
    now: NaiveDateTime,
) -> Result<()> {
    let AfterFire {
        next_trigger,
        is_active,
        pomodoro_phase_sql,
        pomodoro_cycles,
    } = compute_after_fire(reminder, now);

    log::info!(
        "fire id={} title={:?} next_trigger={:?} is_active={}",
        reminder.id,
        reminder.title,
        next_trigger,
        is_active,
    );

    // Persist state change. `COALESCE(?, existing)` on the pomodoro columns
    // means we leave them untouched for non-pomodoro kinds (where we pass
    // NULL), but overwrite them for pomodoro reminders.
    conn.execute(
        "
        UPDATE reminders
        SET last_triggered = ?1,
            next_trigger   = ?2,
            is_active      = ?3,
            pomodoro_phase = COALESCE(?4, pomodoro_phase),
            pomodoro_cycles_completed = COALESCE(?5, pomodoro_cycles_completed),
            snooze_until   = NULL,
            updated_at     = ?1
        WHERE id = ?6
        ",
        params![
            now,
            next_trigger,
            is_active as i64,
            pomodoro_phase_sql,
            pomodoro_cycles,
            reminder.id,
        ],
    )
    .context("updating reminder after fire")?;

    // Record the event. `action='shown'` is the only value we emit from the
    // scheduler itself — dismissed / snoozed / completed come from the UI.
    conn.execute(
        "
        INSERT INTO reminder_history (reminder_id, triggered_at, action)
        VALUES (?1, ?2, 'shown')
        ",
        params![reminder.id, now],
    )
    .context("inserting history row")?;

    // Build the updated reminder in memory — we already know every field
    // that the UPDATE touched, so a second DB round-trip is unnecessary.
    let updated = {
        let mut r = reminder.clone();
        r.last_triggered = Some(now);
        r.next_trigger = next_trigger;
        r.is_active = is_active;
        r.snooze_until = None;
        // Apply pomodoro phase/cycles only when the kind is actually Pomodoro
        // and compute_after_fire produced new values (Some). Non-pomodoro
        // kinds leave these as None so we skip them entirely.
        if let (ReminderKind::Pomodoro { phase, cycles_completed, .. }, Some(phase_str), Some(cycles)) =
            (&mut r.kind, pomodoro_phase_sql, pomodoro_cycles)
        {
            *phase = PomodoroPhase::from_sql(phase_str);
            *cycles_completed = cycles;
        }
        r
    };

    // Fire-and-forget: if the webview is gone (window closed), `emit` errors
    // but we don't want to crash the scheduler over it. Log and continue.
    // We emit the TRUE state (without quiet-hours downgrade) so the list
    // UI reflects the reminder's configured intrusiveness, not the
    // temporary clamp used for this particular fire.
    if let Err(e) = app.emit(REMINDER_FIRED_EVENT, &updated) {
        log::warn!("failed to emit {REMINDER_FIRED_EVENT}: {e}");
    }

    // Quiet hours downgrade: if we're inside the configured window,
    // clamp this one fire's intrusiveness to 1 (compact toast). We do
    // NOT persist this — the stored reminder keeps its real level, only
    // the notifier sees the clamped copy. Dropping a reminder is worse
    // than showing a soft nudge at 3am, so we never skip.
    let to_notify = apply_quiet_hours_downgrade(conn, updated.clone(), now);

    // Dispatch to intrusive overlay window and ntfy push. Channel errors
    // are logged inside `notifier::notify` so the scheduler loop is
    // unaffected. The overlay builder needs `AppHandle` to spawn a new
    // webview window; ntfy needs the DB connection to read config.
    notifier::notify(app, conn, &to_notify);

    Ok(())
}

/// If quiet hours are active right now, return a copy of `reminder` with
/// `intrusiveness = 1`. Otherwise return the input untouched. This is the
/// whole quiet-hours feature — a single in-memory clamp on the fire-path.
fn apply_quiet_hours_downgrade(
    conn: &Connection,
    reminder: Reminder,
    now: NaiveDateTime,
) -> Reminder {
    let Some(config) = QuietHoursConfig::load(conn) else {
        return reminder;
    };

    if !is_within_quiet_hours(now.time(), &config) {
        return reminder;
    }

    if reminder.intrusiveness <= 1 {
        // Already at the floor — nothing to clamp.
        return reminder;
    }

    log::info!(
        "quiet hours: downgrading reminder id={} from L{} to L1",
        reminder.id,
        reminder.intrusiveness
    );
    Reminder {
        intrusiveness: 1,
        ..reminder
    }
}
