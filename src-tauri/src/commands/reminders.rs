//! Reminder commands: list, create, (later: update, delete, snooze, etc.)
//!
//! These are the first real commands that exercise the full pipeline:
//! React -> invoke -> IPC -> Rust handler -> SQLite -> serialized
//! discriminated union -> React state.

use chrono::{Duration, Local, NaiveDateTime};
use rusqlite::params;
use serde::Deserialize;
use tauri::State;

use crate::commands::{CommandError, CommandResult};
use crate::db::DbState;
use crate::models::{PomodoroPhase, RecurrenceRule, Reminder};

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
    pub category: Option<String>,
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
    let mut stmt = conn.prepare("SELECT * FROM reminders ORDER BY id ASC")?;
    let rows = stmt.query_map([], Reminder::from_row)?;
    let reminders: Vec<Reminder> = rows.collect::<Result<_, _>>()?;
    log::debug!("list_reminders: {} rows", reminders.len());
    Ok(reminders)
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

    let category = input.category.as_deref().unwrap_or("general");
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
