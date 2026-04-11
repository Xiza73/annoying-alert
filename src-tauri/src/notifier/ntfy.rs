//! Mobile notifications via ntfy.sh HTTP push.
//!
//! # Protocol
//!
//! ntfy.sh is ridiculously simple:
//!
//!   POST {server}/{topic}
//!   Title:    {title}
//!   Priority: {1..5}
//!   body:     {description}
//!
//! Everything subscribed to that topic (the Android/iOS ntfy app, a web
//! client, curl, whatever) gets the push within a second. No auth by
//! default. The topic is a shared secret — anyone who knows the name can
//! read AND send — so users pick unguessable names.
//!
//! # Config
//!
//! Both `ntfy_server` and `ntfy_topic` live in the `config` key/value
//! table. If `ntfy_topic` is empty we silently skip (the user hasn't set
//! up mobile yet). If `ntfy_server` is missing we fall back to the
//! public instance at https://ntfy.sh.
//!
//! # Priority mapping
//!
//! ntfy uses 1..5 where 1 is "min" (silent on phone) and 5 is "max"
//! (overrides DnD). Our intrusiveness scale is already 1..5 with the
//! same semantics so we pass it through 1:1.

use anyhow::{bail, Result};
use rusqlite::Connection;

use crate::db::config;
use crate::models::Reminder;

/// Default ntfy server if the config row is missing. Matches the seed
/// value in `db::schema::DEFAULT_CONFIG` — duplicated here as a safety
/// net for installations whose `config` table somehow lost rows.
const DEFAULT_SERVER: &str = "https://ntfy.sh";

/// Timeout for the HTTP call. Keep it tight: we don't want a slow ntfy
/// server to block a scheduler tick. Fire-and-forget semantics — if the
/// user is offline, the reminder already fired locally anyway.
const HTTP_TIMEOUT_SECS: u64 = 5;

/// Send a reminder to the user's ntfy topic. No-op if `ntfy_topic` is
/// not configured (empty string).
pub fn push(conn: &Connection, reminder: &Reminder) -> Result<()> {
    let topic = config::get_or_default(conn, "ntfy_topic", "");
    if topic.trim().is_empty() {
        log::debug!("ntfy: topic not configured, skipping push");
        return Ok(());
    }

    let server = config::get_or_default(conn, "ntfy_server", DEFAULT_SERVER);
    let url = format!("{}/{}", server.trim_end_matches('/'), topic);

    let body = if reminder.description.is_empty() {
        reminder.title.clone()
    } else {
        reminder.description.clone()
    };

    // ntfy expects the Priority header as a stringified integer 1..5.
    // We clamp just in case a malformed row slipped past the SQL CHECK
    // constraint — defense in depth never hurts.
    let priority = reminder.intrusiveness.clamp(1, 5).to_string();

    log::info!(
        "ntfy: POST {url} priority={priority} title={:?}",
        reminder.title
    );

    let response = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .set("Title", &reminder.title)
        .set("Priority", &priority)
        .set("Tags", "bell")
        .send_string(&body);

    match response {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            bail!("ntfy returned HTTP {code}: {text}");
        }
        Err(ureq::Error::Transport(t)) => {
            bail!("ntfy transport error: {t}");
        }
    }
}
