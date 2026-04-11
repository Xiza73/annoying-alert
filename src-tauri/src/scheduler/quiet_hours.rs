//! Quiet hours: soft-mute window during which high-intrusiveness
//! reminders are downgraded to L1 instead of being dropped.
//!
//! # Design
//!
//! We intentionally do NOT skip reminders that fire inside the quiet
//! window — losing a reminder is the worst possible UX for an app whose
//! identity is "impossible to ignore". Instead, when the window is
//! active we clamp the notification's intrusiveness to 1 (compact
//! top-right toast, auto-dismisses in 8s). The user sees something,
//! gets a gentle nudge, and their sleep is not wrecked.
//!
//! # Wrap-around
//!
//! Quiet hours are stored as two `HH:MM` strings. The window is
//! considered to wrap past midnight whenever `start > end` (e.g.
//! `23:00` → `07:00`). We test both the happy case and the wrap-around
//! case below because the comparison logic is subtly different.
//!
//! # Where the config comes from
//!
//! Three keys on the `config` table, all seeded by the schema:
//!
//! - `quiet_hours_enabled` — "1" or "0" (any other value = disabled)
//! - `quiet_hours_start`   — "HH:MM"
//! - `quiet_hours_end`     — "HH:MM"
//!
//! This module never touches SQL; the caller fetches them and passes
//! the parsed struct in. Keeps the logic pure and unit-testable.

use chrono::{NaiveTime, Timelike};
use rusqlite::Connection;

use crate::db::config as db_config;

/// Parsed quiet-hours configuration. `None` means "disabled" so the
/// caller doesn't have to carry a separate flag around.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuietHoursConfig {
    pub start: NaiveTime,
    pub end: NaiveTime,
}

impl QuietHoursConfig {
    /// Load from the `config` table. Returns `None` if disabled, if the
    /// enabled flag is missing, or if either time fails to parse. A
    /// corrupt row should never break the scheduler — we log and
    /// behave as if quiet hours were off.
    pub fn load(conn: &Connection) -> Option<Self> {
        let enabled = db_config::get_or_default(conn, "quiet_hours_enabled", "0");
        if enabled != "1" {
            return None;
        }
        let start_raw = db_config::get_or_default(conn, "quiet_hours_start", "23:00");
        let end_raw = db_config::get_or_default(conn, "quiet_hours_end", "07:00");

        match (parse_hhmm(&start_raw), parse_hhmm(&end_raw)) {
            (Some(start), Some(end)) => Some(Self { start, end }),
            _ => {
                log::warn!(
                    "quiet hours: invalid HH:MM start={start_raw:?} end={end_raw:?}; disabling"
                );
                None
            }
        }
    }
}

/// Parse a `HH:MM` string to a `NaiveTime`. Returns `None` on malformed
/// input — callers decide how to fall back.
fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

/// True iff `now` is currently inside the quiet-hours window.
///
/// Handles the wrap-around case (`start > end`, e.g. 23:00 → 07:00) by
/// flipping the comparison: inside the window means `now >= start` OR
/// `now < end`, not AND.
///
/// When `start == end` the window is considered "empty" and never
/// matches. This matches the Python app's behavior.
pub fn is_within_quiet_hours(now: NaiveTime, config: &QuietHoursConfig) -> bool {
    let start = truncate_to_minute(config.start);
    let end = truncate_to_minute(config.end);
    let now = truncate_to_minute(now);

    if start == end {
        return false;
    }

    if start < end {
        // Same-day window (e.g. 13:00 - 15:00).
        now >= start && now < end
    } else {
        // Wrap-around window (e.g. 23:00 - 07:00).
        now >= start || now < end
    }
}

/// Strip seconds/nanos so comparisons are "by the minute". The config
/// only stores HH:MM; matching at sub-minute precision would make tests
/// flaky and the UX indistinguishable.
fn truncate_to_minute(t: NaiveTime) -> NaiveTime {
    NaiveTime::from_hms_opt(t.hour(), t.minute(), 0).unwrap_or(t)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn same_day_window_inclusive_start_exclusive_end() {
        let cfg = QuietHoursConfig {
            start: hm(13, 0),
            end: hm(15, 0),
        };
        assert!(!is_within_quiet_hours(hm(12, 59), &cfg));
        assert!(is_within_quiet_hours(hm(13, 0), &cfg));
        assert!(is_within_quiet_hours(hm(14, 30), &cfg));
        assert!(!is_within_quiet_hours(hm(15, 0), &cfg));
        assert!(!is_within_quiet_hours(hm(16, 0), &cfg));
    }

    #[test]
    fn wrap_around_window_covers_midnight() {
        let cfg = QuietHoursConfig {
            start: hm(23, 0),
            end: hm(7, 0),
        };
        assert!(is_within_quiet_hours(hm(23, 0), &cfg));
        assert!(is_within_quiet_hours(hm(23, 30), &cfg));
        assert!(is_within_quiet_hours(hm(0, 0), &cfg));
        assert!(is_within_quiet_hours(hm(3, 15), &cfg));
        assert!(is_within_quiet_hours(hm(6, 59), &cfg));
        assert!(!is_within_quiet_hours(hm(7, 0), &cfg));
        assert!(!is_within_quiet_hours(hm(12, 0), &cfg));
        assert!(!is_within_quiet_hours(hm(22, 59), &cfg));
    }

    #[test]
    fn empty_window_never_matches() {
        let cfg = QuietHoursConfig {
            start: hm(10, 0),
            end: hm(10, 0),
        };
        assert!(!is_within_quiet_hours(hm(10, 0), &cfg));
        assert!(!is_within_quiet_hours(hm(0, 0), &cfg));
    }

    #[test]
    fn parse_hhmm_rejects_garbage() {
        assert_eq!(parse_hhmm("23:00"), Some(hm(23, 0)));
        assert_eq!(parse_hhmm(" 07:30 "), Some(hm(7, 30)));
        assert_eq!(parse_hhmm("7:30"), Some(hm(7, 30)));
        assert_eq!(parse_hhmm("25:00"), None);
        assert_eq!(parse_hhmm("garbage"), None);
        assert_eq!(parse_hhmm(""), None);
    }
}
