//! Thin wrapper around `croner` that works with [`NaiveDateTime`] (the
//! timezone-free type used throughout this codebase).
//!
//! All functions convert to/from `DateTime<Local>` internally so that cron
//! expressions behave in the user's local timezone — exactly what you'd want
//! for "fire every weekday at 09:00".

use chrono::{Local, NaiveDateTime, TimeZone};
use croner::parser::CronParser;

/// Parse a cron expression and find the next occurrence strictly after `after`.
///
/// Returns `None` if the expression is invalid or no future occurrence exists
/// within croner's year range.
pub fn next_from_cron(expression: &str, after: NaiveDateTime) -> Option<NaiveDateTime> {
    let cron = CronParser::builder()
        .build()
        .parse(expression)
        .ok()?;
    let dt = Local.from_local_datetime(&after).single()?;
    // `false` = exclusive: don't match `after` itself, find strictly next.
    let next = cron.find_next_occurrence(&dt, false).ok()?;
    Some(next.naive_local())
}

/// Validate a cron expression without computing any dates.
///
/// Returns `Ok(())` for valid expressions, or an error message string for
/// invalid ones. Use this before persisting to give the user early feedback.
pub fn validate_cron(expression: &str) -> Result<(), String> {
    CronParser::builder()
        .build()
        .parse(expression)
        .map(|_| ())
        .map_err(|e| format!("invalid cron expression: {e}"))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn next_from_cron_daily_at_nine() {
        let after = NaiveDate::from_ymd_opt(2026, 4, 10)
            .unwrap()
            .and_hms_opt(9, 0, 0)
            .unwrap();
        let next = next_from_cron("0 9 * * *", after);
        let expected = NaiveDate::from_ymd_opt(2026, 4, 11)
            .unwrap()
            .and_hms_opt(9, 0, 0)
            .unwrap();
        assert_eq!(next, Some(expected));
    }

    #[test]
    fn invalid_expression_returns_none() {
        let after = NaiveDate::from_ymd_opt(2026, 4, 10)
            .unwrap()
            .and_hms_opt(9, 0, 0)
            .unwrap();
        assert_eq!(next_from_cron("gibberish", after), None);
    }

    #[test]
    fn validate_accepts_valid() {
        assert!(validate_cron("0 9 * * 1-5").is_ok());
    }

    #[test]
    fn validate_rejects_invalid() {
        assert!(validate_cron("not valid").is_err());
    }
}
