/**
 * TypeScript mirror of the Rust `Reminder` domain model.
 *
 * These types MUST stay in sync with `src-tauri/src/models/reminder.rs`.
 * We'll auto-generate them in a future phase (tauri-specta or similar),
 * but for now we maintain them by hand — the compiler won't catch a drift
 * between the two sides, only runtime errors will.
 *
 * The discriminator tags (`type`, `mode`) mirror the Rust `#[serde(tag)]`
 * attributes, which gives us exhaustive `switch` checking in React code
 * that consumes `ReminderKind`.
 */

// ─── Primitives ─────────────────────────────────────────────────────────────

/**
 * ISO-8601 naive timestamp as produced by chrono's `NaiveDateTime` serde
 * impl, e.g. "2026-04-10T15:00:00". No timezone — interpret as local.
 */
export type NaiveDateTime = string;

export type PomodoroPhase = "work" | "break";

// ─── Discriminated unions ───────────────────────────────────────────────────

export type RecurrenceRule =
  | { mode: "cron"; expression: string }
  | { mode: "interval"; minutes: number };

export type ReminderKind =
  | { type: "once"; trigger_at: NaiveDateTime }
  | { type: "recurring"; rule: RecurrenceRule }
  | {
      type: "pomodoro";
      work_minutes: number;
      break_minutes: number;
      phase: PomodoroPhase;
      cycles_completed: number;
    };

// ─── Entities ───────────────────────────────────────────────────────────────

export interface Reminder {
  id: number;
  title: string;
  description: string;
  intrusiveness: number;
  kind: ReminderKind;
  is_active: boolean;
  last_triggered: NaiveDateTime | null;
  next_trigger: NaiveDateTime | null;
  snooze_until: NaiveDateTime | null;
  send_mobile: boolean;
  send_desktop: boolean;
  sound_file: string;
  color: string;
  category: string;
  created_at: NaiveDateTime;
  updated_at: NaiveDateTime;
}

// ─── Input DTOs (server-generated fields omitted) ───────────────────────────

export type ReminderKindInput =
  | { type: "once"; trigger_at: NaiveDateTime }
  | { type: "recurring"; rule: RecurrenceRule }
  | { type: "pomodoro"; work_minutes: number; break_minutes: number };

export interface CreateReminderInput {
  title: string;
  description?: string;
  intrusiveness: number;
  kind: ReminderKindInput;
  category?: string;
  color?: string;
  sound_file?: string;
  send_desktop?: boolean;
  send_mobile?: boolean;
}
