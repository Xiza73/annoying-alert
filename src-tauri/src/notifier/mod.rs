//! Multi-channel reminder notifier.
//!
//! Given a fired [`Reminder`], this module is responsible for actually
//! *reaching the user*. It has two channels:
//!
//! - [`overlay`]: a dedicated intrusive Tauri webview window that sits
//!   always-on-top with no chrome. This is the whole point of Waqyay —
//!   we do NOT use Windows toast notifications because those can be
//!   muted, hidden, or numb to the user.
//! - [`ntfy`]: HTTP POST to an ntfy.sh topic for mobile push. Uses `ureq`.
//!
//! The scheduler calls [`notify`] from its background thread after
//! persisting the post-fire state. Both channels are best-effort: a
//! failure to deliver is logged and swallowed. We never want a network
//! hiccup or a GPU stall to corrupt the scheduler's state machine.

mod ntfy;
mod overlay;

use rusqlite::Connection;
use tauri::AppHandle;

use crate::models::Reminder;

/// Dispatch a reminder to all enabled notification channels.
///
/// Reads the per-reminder `send_desktop` / `send_mobile` flags and only
/// fires the channels the user has opted into for that reminder. Any
/// channel error is logged but never propagated — notification failures
/// must not corrupt scheduler state.
pub fn notify(app: &AppHandle, conn: &Connection, reminder: &Reminder) {
    if reminder.send_desktop {
        if let Err(e) = overlay::show(app, reminder) {
            log::warn!(
                "overlay notification failed (id={}): {e:#}",
                reminder.id
            );
        }
    }

    if reminder.send_mobile {
        if let Err(e) = ntfy::push(conn, reminder) {
            log::warn!(
                "ntfy push failed (id={}): {e:#}",
                reminder.id
            );
        }
    }
}
