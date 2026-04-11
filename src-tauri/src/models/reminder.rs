//! Domain model for reminders.
//!
//! We use Rust's algebraic data types to make invalid reminder states
//! *unrepresentable*. A `Reminder::Once` simply does not have a
//! `cron_expression` field to accidentally read — it doesn't exist in the
//! type at all. Same story for pomodoro phases, recurrence modes, etc.
//!
//! The SQL schema stays flat (for backward compat with the Python app),
//! so the [`Reminder::from_row`] conversion does a little pattern matching
//! on the `reminder_type` discriminator column to build the right variant.
//!
//! # Serialization to the frontend
//!
//! Thanks to `#[serde(tag = "type")]`, `ReminderKind` serializes as a
//! TypeScript-friendly discriminated union:
//!
//! ```json
//! { "type": "once", "trigger_at": "2026-04-10T15:00:00" }
//! { "type": "recurring", "rule": { "mode": "cron", "expression": "0 9 * * 1-5" } }
//! { "type": "pomodoro", "work_minutes": 25, "break_minutes": 5, "phase": "work", "cycles_completed": 0 }
//! ```
//!
//! React consumes this as an exhaustive `switch (kind.type) { ... }` with
//! full type narrowing.

use chrono::NaiveDateTime;
use rusqlite::Row;
use serde::{Deserialize, Serialize};

use crate::models::category::Category;

// ─── Sub-types ──────────────────────────────────────────────────────────────

/// Pomodoro phase. The reminder alternates between `Work` and `Break` on
/// each trigger, incrementing `cycles_completed` on every `Break -> Work`
/// transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PomodoroPhase {
    Work,
    Break,
}

impl PomodoroPhase {
    /// Parse the TEXT column value stored by SQLite. Any unknown string
    /// defaults to `Work` — this matches the Python schema default and is
    /// the safer fallback (a stray bad value doesn't lose the reminder).
    fn from_sql(s: &str) -> Self {
        match s {
            "break" => Self::Break,
            _ => Self::Work,
        }
    }

    /// Render back to the string form the DB expects.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Break => "break",
        }
    }
}

/// How a `Recurring` reminder repeats. Either a cron expression OR a
/// fixed interval, never both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RecurrenceRule {
    /// Cron-style schedule, e.g. "0 9 * * 1-5" for every weekday at 9am.
    Cron { expression: String },

    /// Fixed interval in minutes from the previous trigger.
    Interval { minutes: i64 },
}

// ─── ReminderKind discriminated union ───────────────────────────────────────

/// The type-specific payload of a reminder. The `#[serde(tag = "type")]`
/// attribute gives us an internally-tagged JSON representation, which maps
/// 1:1 to a TypeScript discriminated union on the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReminderKind {
    /// Fires exactly once at `trigger_at`, then goes inactive.
    Once { trigger_at: NaiveDateTime },

    /// Fires on a schedule defined by `rule`.
    Recurring { rule: RecurrenceRule },

    /// Pomodoro: alternates between `work_minutes` of focus and
    /// `break_minutes` of rest. `phase` indicates the *next* trigger type.
    Pomodoro {
        work_minutes: i64,
        break_minutes: i64,
        phase: PomodoroPhase,
        cycles_completed: i64,
    },
}

// ─── Reminder top-level struct ──────────────────────────────────────────────

/// A reminder as stored in the database and exposed to the frontend.
///
/// Fields that are common to all kinds (title, intrusiveness, notification
/// channels, scheduling state) live here at the top level. Fields that only
/// make sense for a specific kind live inside the `kind` enum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reminder {
    pub id: i64,
    pub title: String,
    pub description: String,
    /// Must be in 1..=5. Enforced by a SQLite CHECK constraint on insert.
    pub intrusiveness: i64,

    /// Type-specific payload (once / recurring / pomodoro).
    pub kind: ReminderKind,

    // ── Scheduling state (common) ──────────────────────────────────────────
    pub is_active: bool,
    pub last_triggered: Option<NaiveDateTime>,
    pub next_trigger: Option<NaiveDateTime>,
    pub snooze_until: Option<NaiveDateTime>,

    // ── Notification channels (common) ─────────────────────────────────────
    pub send_mobile: bool,
    pub send_desktop: bool,
    pub sound_file: String,
    pub color: String,

    // ── Metadata ───────────────────────────────────────────────────────────
    /// Closed enum of reminder domains (health/work/study/…). Stored
    /// as snake_case TEXT in SQLite, parsed leniently on load so
    /// legacy rows with unknown values fall back to `General`.
    pub category: Category,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl Reminder {
    /// Build a `Reminder` from a rusqlite row. Expects the row to contain
    /// ALL columns of the `reminders` table (use `SELECT *` or an explicit
    /// list in the same order as the schema).
    ///
    /// This is NOT implemented as `TryFrom<&Row>` because we want to be
    /// explicit at call sites: the conversion can fail on bad data, and
    /// hiding that behind an implicit `.into()` would be confusing.
    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        let reminder_type: String = row.get("reminder_type")?;

        let kind = match reminder_type.as_str() {
            "once" => {
                // `trigger_at` is NOT NULL by convention for `once` kind,
                // but the column is nullable at the SQL level (shared with
                // other kinds). If it's missing on a `once` reminder, the
                // row is corrupt.
                let trigger_at: Option<NaiveDateTime> = row.get("trigger_at")?;
                ReminderKind::Once {
                    trigger_at: trigger_at.ok_or_else(|| {
                        rusqlite::Error::InvalidColumnType(
                            0,
                            "trigger_at is NULL on a 'once' reminder".into(),
                            rusqlite::types::Type::Null,
                        )
                    })?,
                }
            }

            "recurring" => {
                // Prefer cron if both happen to be set (legacy data safety).
                let cron: Option<String> = row.get("cron_expression")?;
                let interval: Option<i64> = row.get("interval_minutes")?;
                let rule = match (cron, interval) {
                    (Some(expression), _) => RecurrenceRule::Cron { expression },
                    (None, Some(minutes)) => RecurrenceRule::Interval { minutes },
                    (None, None) => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            0,
                            "recurring reminder has neither cron nor interval".into(),
                            rusqlite::types::Type::Null,
                        ));
                    }
                };
                ReminderKind::Recurring { rule }
            }

            "pomodoro" => ReminderKind::Pomodoro {
                work_minutes: row.get("pomodoro_work_minutes")?,
                break_minutes: row.get("pomodoro_break_minutes")?,
                phase: row
                    .get::<_, String>("pomodoro_phase")
                    .map(|s| PomodoroPhase::from_sql(&s))?,
                cycles_completed: row.get("pomodoro_cycles_completed")?,
            },

            other => {
                return Err(rusqlite::Error::InvalidColumnType(
                    0,
                    format!("unknown reminder_type: {other}"),
                    rusqlite::types::Type::Text,
                ));
            }
        };

        Ok(Reminder {
            id: row.get("id")?,
            title: row.get("title")?,
            description: row.get("description")?,
            intrusiveness: row.get("intrusiveness")?,
            kind,
            is_active: row.get("is_active")?,
            last_triggered: row.get("last_triggered")?,
            next_trigger: row.get("next_trigger")?,
            snooze_until: row.get("snooze_until")?,
            send_mobile: row.get("send_mobile")?,
            send_desktop: row.get("send_desktop")?,
            sound_file: row.get("sound_file")?,
            color: row.get("color")?,
            category: row
                .get::<_, String>("category")
                .map(|s| Category::from_sql(&s))?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    /// Convenience accessor returning the discriminator string used by the
    /// `reminder_type` column. Handy for INSERT/UPDATE statements.
    pub fn kind_discriminator(&self) -> &'static str {
        match &self.kind {
            ReminderKind::Once { .. } => "once",
            ReminderKind::Recurring { .. } => "recurring",
            ReminderKind::Pomodoro { .. } => "pomodoro",
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pomodoro_phase_from_sql_defaults_to_work() {
        assert_eq!(PomodoroPhase::from_sql("work"), PomodoroPhase::Work);
        assert_eq!(PomodoroPhase::from_sql("break"), PomodoroPhase::Break);
        assert_eq!(PomodoroPhase::from_sql(""), PomodoroPhase::Work);
        assert_eq!(PomodoroPhase::from_sql("garbage"), PomodoroPhase::Work);
    }

    #[test]
    fn reminder_kind_serializes_as_tagged_union() {
        let once = ReminderKind::Once {
            trigger_at: NaiveDateTime::parse_from_str(
                "2026-04-10 15:00:00",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        };
        let json = serde_json::to_string(&once).unwrap();
        assert!(json.contains(r#""type":"once""#));
        assert!(json.contains(r#""trigger_at""#));

        let recurring = ReminderKind::Recurring {
            rule: RecurrenceRule::Cron {
                expression: "0 9 * * 1-5".into(),
            },
        };
        let json = serde_json::to_string(&recurring).unwrap();
        assert!(json.contains(r#""type":"recurring""#));
        assert!(json.contains(r#""mode":"cron""#));
        assert!(json.contains(r#""expression":"0 9 * * 1-5""#));

        let pomodoro = ReminderKind::Pomodoro {
            work_minutes: 25,
            break_minutes: 5,
            phase: PomodoroPhase::Work,
            cycles_completed: 3,
        };
        let json = serde_json::to_string(&pomodoro).unwrap();
        assert!(json.contains(r#""type":"pomodoro""#));
        assert!(json.contains(r#""phase":"work""#));
        assert!(json.contains(r#""cycles_completed":3"#));
    }

    #[test]
    fn kind_discriminator_matches_variant() {
        let r = Reminder {
            id: 1,
            title: "test".into(),
            description: String::new(),
            intrusiveness: 3,
            kind: ReminderKind::Pomodoro {
                work_minutes: 25,
                break_minutes: 5,
                phase: PomodoroPhase::Work,
                cycles_completed: 0,
            },
            is_active: true,
            last_triggered: None,
            next_trigger: None,
            snooze_until: None,
            send_mobile: true,
            send_desktop: true,
            sound_file: "default".into(),
            color: "#FF4444".into(),
            category: Category::General,
            created_at: NaiveDateTime::parse_from_str(
                "2026-04-10 10:00:00",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            updated_at: NaiveDateTime::parse_from_str(
                "2026-04-10 10:00:00",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        };
        assert_eq!(r.kind_discriminator(), "pomodoro");
    }
}
