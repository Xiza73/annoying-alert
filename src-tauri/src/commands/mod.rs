//! Tauri commands exposed to the frontend via `invoke("name", args)`.
//!
//! Each submodule groups commands by feature area. Register new commands
//! in the `invoke_handler!` macro inside `lib.rs::run()`.
//!
//! # Error handling
//!
//! Tauri requires command errors to implement `serde::Serialize` so they
//! can cross the IPC bridge. [`CommandError`] is our single error type for
//! all commands; it implements `From<rusqlite::Error>` so `?` works
//! naturally inside handlers.
//!
//! The custom `Serialize` impl converts the error to a plain string via
//! its `Display` impl — the frontend gets a string and can show it in a
//! toast without needing to know our internal error taxonomy.

pub mod reminders;

use serde::{Serialize, Serializer};

/// Error type for all Tauri commands.
///
/// Wraps common backend errors (DB, validation, not-found) behind one
/// type. The `Display` impl is what the frontend actually receives, so
/// keep the messages user-friendly.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("not found: {0}")]
    #[allow(dead_code)] // will be used by get_reminder, update_reminder in next phases
    NotFound(String),
}

/// Manual `Serialize` so Tauri can send the error across the IPC bridge.
/// We just flatten it to its `Display` representation — the frontend
/// doesn't need to discriminate error kinds, it shows the message.
impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias: every command returns this.
pub type CommandResult<T> = Result<T, CommandError>;
