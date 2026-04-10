//! SQL schema definitions for Waqyay.
//!
//! Ported verbatim from the Python `intrusive-reminder/database.py` so that
//! a legacy SQLite file can be opened directly by this app without any data
//! transformation. Column names, types, CHECK constraints, DEFAULT values
//! and indexes all mirror the original.
//!
//! Any schema change MUST go through a migration in `db::migrations`, never
//! by editing these statements in place — the `CREATE TABLE IF NOT EXISTS`
//! here is only for bootstrapping a brand-new database.

/// Initial schema. Run once on a fresh database.
pub const INITIAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    intrusiveness INTEGER NOT NULL DEFAULT 3 CHECK(intrusiveness BETWEEN 1 AND 5),
    reminder_type TEXT NOT NULL CHECK(reminder_type IN ('once', 'recurring', 'pomodoro')),
    -- Para recordatorios puntuales
    trigger_at TEXT,
    -- Para recurrentes (cron o intervalo)
    cron_expression TEXT,
    interval_minutes INTEGER,
    -- Estado
    is_active INTEGER NOT NULL DEFAULT 1,
    last_triggered TEXT,
    next_trigger TEXT,
    snooze_until TEXT,
    -- Canales de notificacion
    send_mobile INTEGER NOT NULL DEFAULT 1,
    send_desktop INTEGER NOT NULL DEFAULT 1,
    sound_file TEXT DEFAULT 'default',
    color TEXT DEFAULT '#FF4444',
    -- Metadatos
    category TEXT DEFAULT 'general',
    -- Pomodoro (fases trabajo/descanso alternadas)
    pomodoro_work_minutes INTEGER,
    pomodoro_break_minutes INTEGER,
    pomodoro_phase TEXT DEFAULT 'work',
    pomodoro_cycles_completed INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS reminder_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER NOT NULL,
    triggered_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    action TEXT NOT NULL CHECK(action IN ('shown', 'dismissed', 'snoozed', 'completed')),
    FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_next_trigger
    ON reminders(next_trigger) WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_reminder_history_reminder_id
    ON reminder_history(reminder_id);
"#;

/// Default configuration values. Inserted with `INSERT OR IGNORE` so they
/// never override user-modified settings.
pub const DEFAULT_CONFIG: &[(&str, &str)] = &[
    ("ntfy_server", "https://ntfy.sh"),
    ("ntfy_topic", ""),
    ("global_intrusiveness_override", "0"),
    ("quiet_hours_start", "23:00"),
    ("quiet_hours_end", "07:00"),
    ("quiet_hours_enabled", "0"),
    ("default_snooze_minutes", "10"),
    ("check_interval", "5"),
    ("start_minimized", "0"),
    ("hide_to_tray_notice_shown", "0"),
    ("default_sound_l1", "default"),
    ("default_sound_l2", "default"),
    ("default_sound_l3", "default"),
    ("default_sound_l4", "default"),
    ("default_sound_l5", "default"),
];
