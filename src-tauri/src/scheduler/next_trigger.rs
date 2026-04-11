//! Pure logic for computing "what happens after a reminder fires".
//!
//! This module has ZERO dependencies on SQLite, Tauri, threads, or
//! wall-clock time. Every function takes `now` as a parameter. That's
//! what lets us unit-test the state machines exhaustively without
//! needing a DB or a running app.
//!
//! The scheduler loop in `scheduler::mod` is thin glue: it reads due
//! reminders from SQLite, calls [`compute_after_fire`] on each, and
//! writes the new state back. All the "thinking" lives here.

use chrono::{Duration, NaiveDateTime};

use crate::models::{PomodoroPhase, RecurrenceRule, Reminder, ReminderKind};

/// The post-fire state of a reminder. Maps 1:1 to the SQL columns that
/// the scheduler updates after firing.
///
/// `pomodoro_phase_sql` and `pomodoro_cycles` are `None` for non-pomodoro
/// kinds — the scheduler uses `COALESCE(?, existing)` in the UPDATE to
/// leave those columns untouched for other kinds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AfterFire {
    pub next_trigger: Option<NaiveDateTime>,
    pub is_active: bool,
    pub pomodoro_phase_sql: Option<&'static str>,
    pub pomodoro_cycles: Option<i64>,
}

/// Given a reminder that just fired at `now`, compute the new state it
/// should transition to.
///
/// - `Once` → deactivates. Reminder stays in the DB for history but
///   won't fire again.
/// - `Recurring Interval` → next_trigger = now + interval_minutes.
///   Stays active forever until the user deactivates it.
/// - `Recurring Cron` → NOT YET IMPLEMENTED (Fase 4.5). For now we
///   leave `next_trigger = None` and log a warning. Reminder stays
///   active but dormant. No data loss; enabling it later is a one-line
///   change.
/// - `Pomodoro Work` → transition to Break, next_trigger = now +
///   break_minutes. Cycles unchanged.
/// - `Pomodoro Break` → transition to Work, next_trigger = now +
///   work_minutes. Cycles incremented by 1.
pub fn compute_after_fire(reminder: &Reminder, now: NaiveDateTime) -> AfterFire {
    match &reminder.kind {
        ReminderKind::Once { .. } => AfterFire {
            next_trigger: None,
            is_active: false,
            pomodoro_phase_sql: None,
            pomodoro_cycles: None,
        },

        ReminderKind::Recurring { rule } => match rule {
            RecurrenceRule::Interval { minutes } => AfterFire {
                next_trigger: Some(now + Duration::minutes(*minutes)),
                is_active: true,
                pomodoro_phase_sql: None,
                pomodoro_cycles: None,
            },
            RecurrenceRule::Cron { expression } => {
                log::warn!(
                    "cron reminders are not yet scheduled (id={}, expr={expression:?})",
                    reminder.id,
                );
                AfterFire {
                    next_trigger: None,
                    is_active: true,
                    pomodoro_phase_sql: None,
                    pomodoro_cycles: None,
                }
            }
        },

        ReminderKind::Pomodoro {
            work_minutes,
            break_minutes,
            phase,
            cycles_completed,
        } => match phase {
            // Work phase just finished → next is Break.
            PomodoroPhase::Work => AfterFire {
                next_trigger: Some(now + Duration::minutes(*break_minutes)),
                is_active: true,
                pomodoro_phase_sql: Some("break"),
                pomodoro_cycles: Some(*cycles_completed),
            },
            // Break phase just finished → next is Work, cycle++.
            PomodoroPhase::Break => AfterFire {
                next_trigger: Some(now + Duration::minutes(*work_minutes)),
                is_active: true,
                pomodoro_phase_sql: Some("work"),
                pomodoro_cycles: Some(*cycles_completed + 1),
            },
        },
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Category;

    /// Build a minimal Reminder with the given kind. All other fields
    /// are defaults since the state machine ignores them.
    fn reminder_with(kind: ReminderKind) -> Reminder {
        let ts = NaiveDateTime::parse_from_str(
            "2026-04-10 10:00:00",
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();
        Reminder {
            id: 42,
            title: "test".into(),
            description: String::new(),
            intrusiveness: 3,
            kind,
            is_active: true,
            last_triggered: None,
            next_trigger: None,
            snooze_until: None,
            send_mobile: true,
            send_desktop: true,
            sound_file: "default".into(),
            color: "#FF4444".into(),
            category: Category::General,
            created_at: ts,
            updated_at: ts,
        }
    }

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn once_deactivates_after_firing() {
        let r = reminder_with(ReminderKind::Once {
            trigger_at: at("2026-04-10 10:00:00"),
        });
        let after = compute_after_fire(&r, at("2026-04-10 10:00:00"));
        assert_eq!(
            after,
            AfterFire {
                next_trigger: None,
                is_active: false,
                pomodoro_phase_sql: None,
                pomodoro_cycles: None,
            }
        );
    }

    #[test]
    fn interval_reschedules_by_minutes() {
        let r = reminder_with(ReminderKind::Recurring {
            rule: RecurrenceRule::Interval { minutes: 15 },
        });
        let now = at("2026-04-10 10:00:00");
        let after = compute_after_fire(&r, now);
        assert_eq!(after.next_trigger, Some(at("2026-04-10 10:15:00")));
        assert!(after.is_active);
    }

    #[test]
    fn cron_stays_active_but_dormant() {
        let r = reminder_with(ReminderKind::Recurring {
            rule: RecurrenceRule::Cron {
                expression: "0 9 * * 1-5".into(),
            },
        });
        let after = compute_after_fire(&r, at("2026-04-10 10:00:00"));
        assert_eq!(after.next_trigger, None);
        assert!(after.is_active);
    }

    #[test]
    fn pomodoro_work_transitions_to_break_without_incrementing_cycles() {
        let r = reminder_with(ReminderKind::Pomodoro {
            work_minutes: 25,
            break_minutes: 5,
            phase: PomodoroPhase::Work,
            cycles_completed: 2,
        });
        let now = at("2026-04-10 10:00:00");
        let after = compute_after_fire(&r, now);
        assert_eq!(after.next_trigger, Some(at("2026-04-10 10:05:00")));
        assert_eq!(after.pomodoro_phase_sql, Some("break"));
        assert_eq!(after.pomodoro_cycles, Some(2));
        assert!(after.is_active);
    }

    #[test]
    fn pomodoro_break_transitions_to_work_and_increments_cycles() {
        let r = reminder_with(ReminderKind::Pomodoro {
            work_minutes: 25,
            break_minutes: 5,
            phase: PomodoroPhase::Break,
            cycles_completed: 2,
        });
        let now = at("2026-04-10 10:00:00");
        let after = compute_after_fire(&r, now);
        assert_eq!(after.next_trigger, Some(at("2026-04-10 10:25:00")));
        assert_eq!(after.pomodoro_phase_sql, Some("work"));
        assert_eq!(after.pomodoro_cycles, Some(3));
        assert!(after.is_active);
    }
}
