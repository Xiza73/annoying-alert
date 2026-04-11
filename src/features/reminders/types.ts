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

/**
 * Mirror of the Rust `Category` enum. The backend serializes variants
 * as snake_case strings; adding or renaming a value here means the
 * Rust side needs the matching change in `models/category.rs`.
 *
 * Display metadata (label, icon, accent color) lives in
 * `features/reminders/categories.ts` — this file is pure types.
 */
export type Category =
  | "general"
  | "health"
  | "work"
  | "study"
  | "personal"
  | "fitness"
  | "home"
  | "finance";

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
  category: Category;
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
  category?: Category;
  color?: string;
  sound_file?: string;
  send_desktop?: boolean;
  send_mobile?: boolean;
}

/**
 * Shape-identical to CreateReminderInput on purpose — the edit form
 * reuses the create form verbatim. The backend preserves created_at,
 * last_triggered, and pomodoro state across same-kind edits.
 */
export type UpdateReminderInput = CreateReminderInput;
