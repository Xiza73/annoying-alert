//! Reminder commands: list, create, (later: update, delete, snooze, etc.)
//!
//! These are the first real commands that exercise the full pipeline:
//! React -> invoke -> IPC -> Rust handler -> SQLite -> serialized
//! discriminated union -> React state.

use chrono::{Duration, Local, NaiveDateTime};
use rusqlite::params;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::sounds::sweep_orphans;
use crate::commands::{CommandError, CommandResult};
use crate::db::DbState;
use crate::models::{Category, PomodoroPhase, RecurrenceRule, Reminder, ReminderKind};
use crate::notifier::overlay_label;
use crate::scheduler::next_trigger::compute_after_resume;

// ─── Input DTO ──────────────────────────────────────────────────────────────

/// Payload for `create_reminder`. Intentionally DIFFERENT from the full
/// `Reminder` struct because the frontend does NOT provide server-generated
/// fields (id, timestamps, next_trigger, cycles_completed, phase).
#[derive(Debug, Deserialize)]
pub struct CreateReminderInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub intrusiveness: i64,
    pub kind: ReminderKindInput,
    #[serde(default)]
    pub category: Option<Category>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sound_file: Option<String>,
    #[serde(default = "default_true")]
    pub send_desktop: bool,
    #[serde(default = "default_true")]
    pub send_mobile: bool,
}

fn default_true() -> bool {
    true
}

/// Input variant of [`ReminderKind`] that omits server-managed fields for
/// pomodoro (phase starts as `Work`, cycles start at 0).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReminderKindInput {
    Once {
        trigger_at: NaiveDateTime,
    },
    Recurring {
        rule: RecurrenceRule,
    },
    Pomodoro {
        work_minutes: i64,
        break_minutes: i64,
    },
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/// Return all reminders ordered by id (insertion order).
#[tauri::command]
pub fn list_reminders(state: State<'_, DbState>) -> CommandResult<Vec<Reminder>> {
    let conn = state.lock();
    let mut stmt = conn.prepare(
        "SELECT * FROM reminders
         ORDER BY
           is_active DESC,
           CASE WHEN next_trigger IS NULL THEN 1 ELSE 0 END,
           next_trigger ASC,
           id ASC",
    )?;
    let rows = stmt.query_map([], Reminder::from_row)?;
    let reminders: Vec<Reminder> = rows.collect::<Result<_, _>>()?;
    log::debug!("list_reminders: {} rows", reminders.len());
    Ok(reminders)
}

/// Fetch a single reminder by id. Used by the intrusive overlay window —
/// the window boots with a query param carrying the id and calls this
/// command to render the reminder's title/description/color.
///
/// Returns `CommandError::NotFound` if the row does not exist.
#[tauri::command]
pub fn get_reminder(state: State<'_, DbState>, id: i64) -> CommandResult<Reminder> {
    let conn = state.lock();
    conn.query_row(
        "SELECT * FROM reminders WHERE id = ?1",
        params![id],
        Reminder::from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            CommandError::NotFound(format!("reminder {id}"))
        }
        other => CommandError::Db(other),
    })
}

/// Wipe every reminder and its history. Intended for smoke-test cleanup
/// during development; will almost certainly be removed (or moved behind
/// a confirmation dialog) when we ship a real UI.
///
/// Returns the number of rows deleted from `reminders`. `reminder_history`
/// rows are removed via `ON DELETE CASCADE` declared in the schema.
#[tauri::command]
pub fn delete_all_reminders(
    app: AppHandle,
    state: State<'_, DbState>,
) -> CommandResult<usize> {
    let conn = state.lock();
    let deleted = conn.execute("DELETE FROM reminders", [])?;
    log::warn!("delete_all_reminders: removed {deleted} row(s)");

    // Best-effort orphan sweep. Wiping every reminder means every
    // custom sound is now unreferenced, so this is the one place
    // where we're guaranteed to reclaim space.
    if let Err(err) = sweep_orphans(&app, &conn) {
        log::warn!("orphan sweep after delete_all: {err}");
    }

    Ok(deleted)
}

/// Insert a new reminder. Server computes: id, timestamps, next_trigger,
/// and the initial pomodoro phase/cycles.
#[tauri::command]
pub fn create_reminder(
    state: State<'_, DbState>,
    input: CreateReminderInput,
) -> CommandResult<Reminder> {
    if input.title.trim().is_empty() {
        return Err(CommandError::InvalidInput("title cannot be empty".into()));
    }
    if !(1..=5).contains(&input.intrusiveness) {
        return Err(CommandError::InvalidInput(
            "intrusiveness must be between 1 and 5".into(),
        ));
    }

    let conn = state.lock();
    let now = Local::now().naive_local();

    // Compute kind-specific SQL column values. `None` for columns that
    // don't apply to this kind keeps the row consistent with CHECK
    // constraints and with our `from_row` expectations.
    let reminder_type = match &input.kind {
        ReminderKindInput::Once { .. } => "once",
        ReminderKindInput::Recurring { .. } => "recurring",
        ReminderKindInput::Pomodoro { .. } => "pomodoro",
    };

    let (trigger_at, cron_expression, interval_minutes) = match &input.kind {
        ReminderKindInput::Once { trigger_at } => (Some(*trigger_at), None, None),
        ReminderKindInput::Recurring { rule } => match rule {
            RecurrenceRule::Cron { expression } => (None, Some(expression.clone()), None),
            RecurrenceRule::Interval { minutes } => (None, None, Some(*minutes)),
        },
        ReminderKindInput::Pomodoro { .. } => (None, None, None),
    };

    let (pomo_work, pomo_break, pomo_phase, pomo_cycles) = match &input.kind {
        ReminderKindInput::Pomodoro {
            work_minutes,
            break_minutes,
        } => (
            Some(*work_minutes),
            Some(*break_minutes),
            Some(PomodoroPhase::Work.as_str()),
            Some(0i64),
        ),
        _ => (None, None, None, None),
    };

    // Initial next_trigger computation. For `cron` recurring we leave it
    // None until a cron parser module lands in Fase 5.
    let next_trigger: Option<NaiveDateTime> = match &input.kind {
        ReminderKindInput::Once { trigger_at } => Some(*trigger_at),
        ReminderKindInput::Recurring { rule } => match rule {
            RecurrenceRule::Interval { minutes } => {
                Some(now + Duration::minutes(*minutes))
            }
            RecurrenceRule::Cron { .. } => None,
        },
        ReminderKindInput::Pomodoro { work_minutes, .. } => {
            Some(now + Duration::minutes(*work_minutes))
        }
    };

    let category = input.category.unwrap_or_default().as_str();
    let color = input.color.as_deref().unwrap_or("#FF4444");
    let sound_file = input.sound_file.as_deref().unwrap_or("default");

    conn.execute(
        r#"
        INSERT INTO reminders (
            title, description, intrusiveness, reminder_type,
            trigger_at, cron_expression, interval_minutes,
            is_active, next_trigger,
            send_mobile, send_desktop, sound_file, color, category,
            pomodoro_work_minutes, pomodoro_break_minutes,
            pomodoro_phase, pomodoro_cycles_completed,
            created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4,
            ?5, ?6, ?7,
            1, ?8,
            ?9, ?10, ?11, ?12, ?13,
            ?14, ?15,
            ?16, ?17,
            ?18, ?18
        )
        "#,
        params![
            input.title.trim(),
            input.description,
            input.intrusiveness,
            reminder_type,
            trigger_at,
            cron_expression,
            interval_minutes,
            next_trigger,
            input.send_mobile,
            input.send_desktop,
            sound_file,
            color,
            category,
            pomo_work,
            pomo_break,
            pomo_phase,
            pomo_cycles,
            now,
        ],
    )?;

    let new_id = conn.last_insert_rowid();
    log::info!("created reminder id={new_id} type={reminder_type}");

    conn.query_row(
        "SELECT * FROM reminders WHERE id = ?1",
        [new_id],
        Reminder::from_row,
    )
    .map_err(CommandError::from)
}

// ─── Snooze ─────────────────────────────────────────────────────────────────

/// Snooze a reminder for `minutes` minutes from now. Writes `snooze_until`
/// and records a `snoozed` row in history. The scheduler's `fetch_due`
/// query already filters on `snooze_until <= now`, so the reminder will
/// simply be skipped on every tick until the snooze expires.
///
/// Returns the updated reminder so the frontend can refresh the row
/// without a follow-up list call. Used by the overlay "Snooze" button.
#[tauri::command]
pub fn snooze_reminder(
    state: State<'_, DbState>,
    id: i64,
    minutes: i64,
) -> CommandResult<Reminder> {
    if !(1..=1440).contains(&minutes) {
        return Err(CommandError::InvalidInput(
            "snooze minutes must be between 1 and 1440 (24h)".into(),
        ));
    }

    let conn = state.lock();
    let now = Local::now().naive_local();
    let until = now + Duration::minutes(minutes);

    let updated = conn.execute(
        "UPDATE reminders SET snooze_until = ?1, updated_at = ?2 WHERE id = ?3",
        params![until, now, id],
    )?;
    if updated == 0 {
        return Err(CommandError::NotFound(format!("reminder {id}")));
    }

    conn.execute(
        "INSERT INTO reminder_history (reminder_id, triggered_at, action)
         VALUES (?1, ?2, 'snoozed')",
        params![id, now],
    )?;

    log::info!("snoozed reminder id={id} for {minutes}min (until {until})");

    conn.query_row(
        "SELECT * FROM reminders WHERE id = ?1",
        params![id],
        Reminder::from_row,
    )
    .map_err(CommandError::from)
}

// ─── Delete single ──────────────────────────────────────────────────────────

/// Delete a single reminder by id. `reminder_history` rows for that id
/// are removed via `ON DELETE CASCADE` from the schema.
///
/// Returns `CommandError::NotFound` if no row matched.
#[tauri::command]
pub fn delete_reminder(
    app: AppHandle,
    state: State<'_, DbState>,
    id: i64,
) -> CommandResult<()> {
    let conn = state.lock();
    let deleted = conn.execute("DELETE FROM reminders WHERE id = ?1", params![id])?;
    if deleted == 0 {
        return Err(CommandError::NotFound(format!("reminder {id}")));
    }
    log::info!("deleted reminder id={id}");

    // Best-effort orphan sweep: the reminder we just deleted may
    // have been the last one referencing its sound. Silent on
    // failure so the delete still reports success to the UI.
    if let Err(err) = sweep_orphans(&app, &conn) {
        log::warn!("orphan sweep after delete id={id}: {err}");
    }

    Ok(())
}

// ─── Toggle active ──────────────────────────────────────────────────────────

/// Flip the `is_active` flag on a reminder.
///
/// # Resume semantics (fix for pause/resume immediate-fire bug)
///
/// Naively flipping `is_active` is NOT enough: if an interval reminder
/// was paused 10 minutes ago, its stored `next_trigger` is long past
/// and the scheduler would fire it on the very next tick. That's
/// exactly what users reported as "I paused it for 5 minutes, resumed,
/// and it rang immediately".
///
/// To prevent that, when we're transitioning *inactive → active* we
/// call [`compute_after_resume`] to rebase `next_trigger` onto "now".
/// Pomodoro phase and cycle counters are NOT touched — we're resuming,
/// not restarting.
///
/// Also, if an overlay window for this reminder happens to be open
/// when the user pauses (or when they resume, as a safety net), we
/// close it. Leaving an orphaned overlay ringing after a pause would
/// be extremely confusing.
#[tauri::command]
pub fn toggle_reminder_active(
    app: AppHandle,
    state: State<'_, DbState>,
    id: i64,
) -> CommandResult<Reminder> {
    let conn = state.lock();
    let now = Local::now().naive_local();

    // Load the current row first so we can (a) know which direction the
    // toggle goes, and (b) feed it into `compute_after_resume` without a
    // second round-trip.
    let current: Reminder = conn
        .query_row(
            "SELECT * FROM reminders WHERE id = ?1",
            params![id],
            Reminder::from_row,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CommandError::NotFound(format!("reminder {id}"))
            }
            other => CommandError::from(other),
        })?;

    let will_be_active = !current.is_active;

    // Resume path: rebase next_trigger so stale scheduling can't fire
    // an immediate ghost alarm.
    let new_next_trigger: Option<NaiveDateTime> = if will_be_active {
        compute_after_resume(&current, now)
    } else {
        // Pause path: leave next_trigger as-is. The scheduler skips
        // inactive rows anyway, and preserving the value lets
        // `compute_after_resume` rebase against a known shape later.
        current.next_trigger
    };

    conn.execute(
        r#"
        UPDATE reminders
           SET is_active   = ?1,
               next_trigger = ?2,
               updated_at  = ?3
         WHERE id = ?4
        "#,
        params![will_be_active, new_next_trigger, now, id],
    )?;
    log::info!(
        "toggled reminder id={id} active={will_be_active} next_trigger={new_next_trigger:?}"
    );

    // Drop the DB lock before touching any Tauri windows — window ops
    // might dispatch to the main thread and we don't want to hold the
    // mutex across that boundary.
    drop(conn);

    // Best-effort: close any overlay window still open for this
    // reminder. On pause this kills the currently-ringing alarm; on
    // resume it's a safety net against zombie windows.
    let label = overlay_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        if let Err(err) = window.close() {
            log::warn!("failed to close overlay window {label}: {err}");
        }
    }

    let conn = state.lock();
    conn.query_row(
        "SELECT * FROM reminders WHERE id = ?1",
        params![id],
        Reminder::from_row,
    )
    .map_err(CommandError::from)
}

// ─── Update ─────────────────────────────────────────────────────────────────

/// Payload for `update_reminder`. Shape-identical to [`CreateReminderInput`]
/// on purpose — the edit form reuses the create form verbatim, so the
/// backend expects the same fields back. `id` is passed as a separate
/// argument, not embedded in the body.
///
/// Server-managed fields (created_at, last_triggered, timestamps, cycles,
/// phase) are NOT part of this payload. The backend preserves or recomputes
/// them based on the kind transition rules documented below.
#[derive(Debug, Deserialize)]
pub struct UpdateReminderInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub intrusiveness: i64,
    pub kind: ReminderKindInput,
    #[serde(default)]
    pub category: Option<Category>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sound_file: Option<String>,
    #[serde(default = "default_true")]
    pub send_desktop: bool,
    #[serde(default = "default_true")]
    pub send_mobile: bool,
}

/// Update an existing reminder. The update is a full-body replace of all
/// editable columns, NOT a partial patch — the frontend always sends the
/// complete form state.
///
/// # Kind transition rules
///
/// - `created_at` is preserved. `updated_at` is set to now.
/// - `last_triggered` is preserved (history is sacred).
/// - `next_trigger` is recomputed from the new kind, exactly like
///   `create_reminder` does.
/// - For pomodoro: if the previous kind was ALSO pomodoro, `phase` and
///   `cycles_completed` are preserved. If the kind changed from
///   once/recurring to pomodoro, both reset (phase=Work, cycles=0).
/// - Inactive reminders are not reactivated by an update. Use
///   `toggle_reminder_active` for that.
#[tauri::command]
pub fn update_reminder(
    state: State<'_, DbState>,
    id: i64,
    input: UpdateReminderInput,
) -> CommandResult<Reminder> {
    if input.title.trim().is_empty() {
        return Err(CommandError::InvalidInput("title cannot be empty".into()));
    }
    if !(1..=5).contains(&input.intrusiveness) {
        return Err(CommandError::InvalidInput(
            "intrusiveness must be between 1 and 5".into(),
        ));
    }

    let conn = state.lock();
    let now = Local::now().naive_local();

    // Load the existing row so we can preserve pomodoro state across
    // same-kind edits and know whether the kind actually changed.
    let existing: Reminder = conn
        .query_row(
            "SELECT * FROM reminders WHERE id = ?1",
            params![id],
            Reminder::from_row,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                CommandError::NotFound(format!("reminder {id}"))
            }
            other => CommandError::Db(other),
        })?;

    let reminder_type = match &input.kind {
        ReminderKindInput::Once { .. } => "once",
        ReminderKindInput::Recurring { .. } => "recurring",
        ReminderKindInput::Pomodoro { .. } => "pomodoro",
    };

    let (trigger_at, cron_expression, interval_minutes) = match &input.kind {
        ReminderKindInput::Once { trigger_at } => (Some(*trigger_at), None, None),
        ReminderKindInput::Recurring { rule } => match rule {
            RecurrenceRule::Cron { expression } => (None, Some(expression.clone()), None),
            RecurrenceRule::Interval { minutes } => (None, None, Some(*minutes)),
        },
        ReminderKindInput::Pomodoro { .. } => (None, None, None),
    };

    // Pomodoro state preservation: only keep phase/cycles if BOTH old and
    // new kind are pomodoro. Any kind transition resets the state machine.
    let (pomo_work, pomo_break, pomo_phase, pomo_cycles) = match &input.kind {
        ReminderKindInput::Pomodoro {
            work_minutes,
            break_minutes,
        } => {
            let (preserved_phase, preserved_cycles) = match &existing.kind {
                ReminderKind::Pomodoro {
                    phase,
                    cycles_completed,
                    ..
                } => (phase.as_str(), *cycles_completed),
                _ => (PomodoroPhase::Work.as_str(), 0i64),
            };
            (
                Some(*work_minutes),
                Some(*break_minutes),
                Some(preserved_phase),
                Some(preserved_cycles),
            )
        }
        _ => (None, None, None, None),
    };

    // next_trigger recomputation mirrors create_reminder. For pomodoro
    // mid-cycle (phase == break), we use break_minutes instead of
    // work_minutes so the edit doesn't break the user's current rhythm.
    let next_trigger: Option<NaiveDateTime> = match &input.kind {
        ReminderKindInput::Once { trigger_at } => Some(*trigger_at),
        ReminderKindInput::Recurring { rule } => match rule {
            RecurrenceRule::Interval { minutes } => Some(now + Duration::minutes(*minutes)),
            RecurrenceRule::Cron { .. } => None,
        },
        ReminderKindInput::Pomodoro {
            work_minutes,
            break_minutes,
        } => {
            let minutes_for_next = match &existing.kind {
                ReminderKind::Pomodoro {
                    phase: PomodoroPhase::Break,
                    ..
                } => *break_minutes,
                _ => *work_minutes,
            };
            Some(now + Duration::minutes(minutes_for_next))
        }
    };

    let category = input.category.unwrap_or_default().as_str();
    let color = input.color.as_deref().unwrap_or("#FF4444");
    let sound_file = input.sound_file.as_deref().unwrap_or("default");

    conn.execute(
        r#"
        UPDATE reminders SET
            title = ?1,
            description = ?2,
            intrusiveness = ?3,
            reminder_type = ?4,
            trigger_at = ?5,
            cron_expression = ?6,
            interval_minutes = ?7,
            next_trigger = ?8,
            send_mobile = ?9,
            send_desktop = ?10,
            sound_file = ?11,
            color = ?12,
            category = ?13,
            pomodoro_work_minutes = ?14,
            pomodoro_break_minutes = ?15,
            pomodoro_phase = ?16,
            pomodoro_cycles_completed = ?17,
            snooze_until = NULL,
            updated_at = ?18
        WHERE id = ?19
        "#,
        params![
            input.title.trim(),
            input.description,
            input.intrusiveness,
            reminder_type,
            trigger_at,
            cron_expression,
            interval_minutes,
            next_trigger,
            input.send_mobile,
            input.send_desktop,
            sound_file,
            color,
            category,
            pomo_work,
            pomo_break,
            pomo_phase,
            pomo_cycles,
            now,
            id,
        ],
    )?;

    log::info!("updated reminder id={id} type={reminder_type}");

    conn.query_row(
        "SELECT * FROM reminders WHERE id = ?1",
        params![id],
        Reminder::from_row,
    )
    .map_err(CommandError::from)
}
