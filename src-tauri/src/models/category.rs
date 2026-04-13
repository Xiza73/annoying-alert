//! Reminder category — a closed enum of domains the user might want
//! to organize reminders by (health, work, study, etc.).
//!
//! # Why an enum instead of free text
//!
//! The original Python ancestor of this app used a plain TEXT column
//! with no validation, which meant typos ("helath") and inconsistent
//! casing ("Work" vs "work") ended up scattered in the DB. An enum on
//! the Rust side forces the UI to pick from a finite set, so the
//! filter/group features we may want later work cleanly.
//!
//! # DB storage
//!
//! The column stays `TEXT` on the SQLite side (no migration needed —
//! the loader must accept whatever categories existed in any old DB).
//! Unknown strings
//! fall back to [`Category::General`] in [`Category::from_sql`] so
//! legacy data never crashes the loader.
//!
//! # Frontend mirror
//!
//! TypeScript mirrors this enum as a union type in
//! `src/features/reminders/types.ts`. Display metadata (icon, color,
//! label) lives on the frontend in `categories.ts` — the backend
//! doesn't care about UI concerns.

use serde::{Deserialize, Serialize};

/// A closed set of reminder categories. Serialized as snake_case
/// strings both to the frontend (via serde) and to the DB (via
/// [`Category::as_str`]).
///
/// Order matters for the frontend picker — the Select dropdown renders
/// in declaration order, so the most common categories come first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    General,
    Health,
    Work,
    Study,
    Personal,
    Fitness,
    Home,
    Finance,
}

impl Default for Category {
    fn default() -> Self {
        Self::General
    }
}

impl Category {
    /// String form used when writing the value to SQLite. Keep this in
    /// sync with the snake_case serde representation so a round-trip
    /// through the DB and through the JSON bridge yields the same
    /// variant.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Health => "health",
            Self::Work => "work",
            Self::Study => "study",
            Self::Personal => "personal",
            Self::Fitness => "fitness",
            Self::Home => "home",
            Self::Finance => "finance",
        }
    }

    /// Parse a value read from SQLite. **Lenient**: any unknown string
    /// falls back to `General`. This is intentional — legacy rows from
    /// the Python app may carry arbitrary category strings, and we'd
    /// rather show them under "General" than refuse to load them.
    pub fn from_sql(s: &str) -> Self {
        match s {
            "general" => Self::General,
            "health" => Self::Health,
            "work" => Self::Work,
            "study" => Self::Study,
            "personal" => Self::Personal,
            "fitness" => Self::Fitness,
            "home" => Self::Home,
            "finance" => Self::Finance,
            _ => Self::General,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_through_sql() {
        for cat in [
            Category::General,
            Category::Health,
            Category::Work,
            Category::Study,
            Category::Personal,
            Category::Fitness,
            Category::Home,
            Category::Finance,
        ] {
            assert_eq!(Category::from_sql(cat.as_str()), cat);
        }
    }

    #[test]
    fn unknown_sql_falls_back_to_general() {
        assert_eq!(Category::from_sql(""), Category::General);
        assert_eq!(Category::from_sql("helath"), Category::General);
        assert_eq!(Category::from_sql("Work"), Category::General); // case matters
    }

    #[test]
    fn serde_emits_snake_case() {
        let json = serde_json::to_string(&Category::Finance).unwrap();
        assert_eq!(json, "\"finance\"");

        let parsed: Category = serde_json::from_str("\"health\"").unwrap();
        assert_eq!(parsed, Category::Health);
    }

    #[test]
    fn default_is_general() {
        assert_eq!(Category::default(), Category::General);
    }
}
