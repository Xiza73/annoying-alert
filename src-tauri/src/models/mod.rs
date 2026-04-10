//! Domain models: plain data structs that cross the Rust<->SQLite and
//! Rust<->TypeScript boundaries.
//!
//! Each submodule defines its entity plus serde `#[derive]` impls so that
//! Tauri commands can return them directly and serde_json handles the
//! serialization automatically.

pub mod reminder;

pub use reminder::{PomodoroPhase, RecurrenceRule, Reminder, ReminderKind};
