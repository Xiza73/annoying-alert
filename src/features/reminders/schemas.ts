/**
 * Zod schemas for the reminder create/edit form.
 *
 * The form uses a FLAT schema (not a discriminated union) on purpose:
 * react-hook-form works more smoothly with a single field set that
 * stays stable across Tab changes. Cross-field validity lives in a
 * `superRefine` that inspects `kind` and requires the right subset.
 *
 * The flat form shape is then mapped to the backend's
 * [`CreateReminderInput`] by [`formToCreateInput`] at submit time —
 * that's the boundary where the discriminated union is rebuilt.
 *
 * # Zod 4 notes
 *
 * - Error messages use `{ error: "..." }` instead of `{ message: "..." }`.
 * - `z.coerce.number()` is used for text inputs so form strings become
 *   numbers before validation.
 */

import { z } from "zod";

import { CATEGORY_KEYS } from "@/features/reminders/categories";
import type {
  CreateReminderInput,
  Reminder,
  ReminderKindInput,
} from "@/features/reminders/types";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * The three reminder kinds. Kept as a `const` object so we get both a
 * runtime value (for Tab keys) and a derived type — single source of
 * truth pattern.
 */
export const REMINDER_KINDS = {
  ONCE: "once",
  RECURRING: "recurring",
  POMODORO: "pomodoro",
} as const;

export type ReminderKindTag = (typeof REMINDER_KINDS)[keyof typeof REMINDER_KINDS];

export const RECURRENCE_MODES = {
  INTERVAL: "interval",
  CRON: "cron",
} as const;

export type RecurrenceMode = (typeof RECURRENCE_MODES)[keyof typeof RECURRENCE_MODES];

/**
 * Palette of Raycast-ish accent colors the user can pick for a
 * reminder dot. The slider UI renders these as swatches.
 */
export const REMINDER_COLORS = [
  "#FF4444",
  "#FF9500",
  "#FFCC00",
  "#34C759",
  "#00C7BE",
  "#5AC8FA",
  "#7C5CFF",
  "#FF2D92",
] as const;

// ─── Form schema ────────────────────────────────────────────────────────────

/**
 * Flat shape of the reminder form. The fields that only matter for a
 * specific kind (`trigger_at`, `cron_expression`, etc.) are optional at
 * the type level and enforced conditionally inside `superRefine`.
 */
export const reminderFormSchema = z
  .object({
    // ── Common ─────────────────────────────────────────────────────────────
    title: z
      .string({ error: "El título es obligatorio" })
      .trim()
      .min(1, { error: "El título es obligatorio" })
      .max(200, { error: "Máximo 200 caracteres" }),
    description: z.string().max(2000).default(""),
    intrusiveness: z.coerce
      .number()
      .int()
      .min(1, { error: "Mínimo 1" })
      .max(5, { error: "Máximo 5" }),
    color: z.string().min(1).default("#FF4444"),
    // Closed enum — mirrors the Rust `Category` variants via
    // CATEGORY_KEYS. Adding a category means updating both sides.
    category: z.enum(CATEGORY_KEYS).default("general"),
    // Bare filename stored in `reminders.sound_file`. Empty string or
    // "default" means "use the synthetic beep pattern for the level".
    // Real filenames look like `<sha256>.<ext>` (see save_sound_file).
    sound_file: z.string().default("default"),
    send_desktop: z.boolean().default(true),
    send_mobile: z.boolean().default(true),

    // ── Kind discriminator ─────────────────────────────────────────────────
    kind: z.enum(["once", "recurring", "pomodoro"]),

    // ── Once ───────────────────────────────────────────────────────────────
    /**
     * `datetime-local` input value — "YYYY-MM-DDTHH:mm" (no seconds).
     * We append ":00" in the mapper before sending to the Rust backend.
     */
    trigger_at: z.string().optional(),

    // ── Recurring ──────────────────────────────────────────────────────────
    recurrence_mode: z.enum(["interval", "cron"]).optional(),
    interval_minutes: z.coerce.number().int().positive().optional(),
    cron_expression: z.string().trim().optional(),

    // ── Pomodoro ───────────────────────────────────────────────────────────
    work_minutes: z.coerce.number().int().positive().optional(),
    break_minutes: z.coerce.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    switch (data.kind) {
      case "once": {
        if (!data.trigger_at || data.trigger_at.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["trigger_at"],
            message: "Elegí fecha y hora",
          });
        }
        break;
      }
      case "recurring": {
        const mode = data.recurrence_mode ?? "interval";
        if (mode === "interval") {
          if (!data.interval_minutes || data.interval_minutes < 1) {
            ctx.addIssue({
              code: "custom",
              path: ["interval_minutes"],
              message: "Mínimo 1 minuto",
            });
          }
        } else {
          if (!data.cron_expression || data.cron_expression.length === 0) {
            ctx.addIssue({
              code: "custom",
              path: ["cron_expression"],
              message: "Expresión cron requerida",
            });
          }
        }
        break;
      }
      case "pomodoro": {
        if (!data.work_minutes || data.work_minutes < 1) {
          ctx.addIssue({
            code: "custom",
            path: ["work_minutes"],
            message: "Mínimo 1 minuto",
          });
        }
        if (!data.break_minutes || data.break_minutes < 1) {
          ctx.addIssue({
            code: "custom",
            path: ["break_minutes"],
            message: "Mínimo 1 minuto",
          });
        }
        break;
      }
    }
  });

/**
 * The INPUT type — what react-hook-form accepts. Optional fields stay
 * optional, so the user can leave them blank until they switch tabs.
 */
export type ReminderFormInput = z.input<typeof reminderFormSchema>;

/**
 * The OUTPUT type — what superRefine guarantees after parsing. Still
 * flat (we don't switch to a discriminated union here), but with
 * coercions applied.
 */
export type ReminderFormOutput = z.output<typeof reminderFormSchema>;

// ─── Mapper ─────────────────────────────────────────────────────────────────

/**
 * Convert the flat, parsed form output into the discriminated union
 * shape the Rust backend expects (`CreateReminderInput`).
 *
 * This is the single place where the form's flat shape meets the API's
 * discriminated union — keeping it in one function means the component
 * stays dumb about the wire format.
 *
 * Assumes `data` has already been validated by [`reminderFormSchema`],
 * so the fields relevant to `data.kind` are definitely populated.
 */
export function formToCreateInput(
  data: ReminderFormOutput,
): CreateReminderInput {
  const kind: ReminderKindInput = buildKindInput(data);
  return {
    title: data.title,
    description: data.description,
    intrusiveness: data.intrusiveness,
    color: data.color,
    category: data.category,
    sound_file: data.sound_file,
    send_desktop: data.send_desktop,
    send_mobile: data.send_mobile,
    kind,
  };
}

function buildKindInput(data: ReminderFormOutput): ReminderKindInput {
  switch (data.kind) {
    case "once": {
      // datetime-local gives "YYYY-MM-DDTHH:mm" — Rust's NaiveDateTime
      // deserializer expects seconds too, so pad with ":00".
      const trigger = data.trigger_at ?? "";
      const normalized = trigger.length === 16 ? `${trigger}:00` : trigger;
      return { type: "once", trigger_at: normalized };
    }
    case "recurring": {
      const mode = data.recurrence_mode ?? "interval";
      if (mode === "interval") {
        return {
          type: "recurring",
          rule: { mode: "interval", minutes: data.interval_minutes ?? 0 },
        };
      }
      return {
        type: "recurring",
        rule: { mode: "cron", expression: data.cron_expression ?? "" },
      };
    }
    case "pomodoro":
      return {
        type: "pomodoro",
        work_minutes: data.work_minutes ?? 25,
        break_minutes: data.break_minutes ?? 5,
      };
  }
}

// ─── Defaults + Reminder → form ─────────────────────────────────────────────

/**
 * Default form state for the "Nuevo recordatorio" flow. Picks a
 * reasonable `trigger_at` five minutes in the future so the user just
 * has to hit save to smoke-test.
 */
export function defaultFormValues(): ReminderFormInput {
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
  return {
    title: "",
    description: "",
    intrusiveness: 3,
    color: "#FF4444",
    category: "general",
    sound_file: "default",
    send_desktop: true,
    send_mobile: true,
    kind: "once",
    trigger_at: toDatetimeLocal(fiveMinFromNow),
    recurrence_mode: "interval",
    interval_minutes: 30,
    cron_expression: "",
    work_minutes: 25,
    break_minutes: 5,
  };
}

/**
 * Format a `Date` as a local `datetime-local` input value
 * ("YYYY-MM-DDTHH:mm"). Sibling to `toNaiveLocal` in shared/lib but
 * drops seconds — the HTML input can't display them.
 */
function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Project an existing [`Reminder`] back to the flat form shape so the
 * edit flow can prefill every field. Irrelevant fields for the current
 * kind get sensible defaults — if the user switches tabs we don't want
 * blank inputs.
 *
 * Naive datetimes from the backend come in as "YYYY-MM-DDTHH:MM:SS";
 * `datetime-local` inputs render "YYYY-MM-DDTHH:mm", so we slice.
 */
export function reminderToFormValues(reminder: Reminder): ReminderFormInput {
  const defaults = defaultFormValues();
  const common: Partial<ReminderFormInput> = {
    title: reminder.title,
    description: reminder.description,
    intrusiveness: reminder.intrusiveness,
    color: reminder.color,
    category: reminder.category,
    sound_file: reminder.sound_file,
    send_desktop: reminder.send_desktop,
    send_mobile: reminder.send_mobile,
  };

  switch (reminder.kind.type) {
    case "once":
      return {
        ...defaults,
        ...common,
        kind: "once",
        trigger_at: reminder.kind.trigger_at.slice(0, 16),
      };
    case "recurring": {
      const rule = reminder.kind.rule;
      if (rule.mode === "interval") {
        return {
          ...defaults,
          ...common,
          kind: "recurring",
          recurrence_mode: "interval",
          interval_minutes: rule.minutes,
        };
      }
      return {
        ...defaults,
        ...common,
        kind: "recurring",
        recurrence_mode: "cron",
        cron_expression: rule.expression,
      };
    }
    case "pomodoro":
      return {
        ...defaults,
        ...common,
        kind: "pomodoro",
        work_minutes: reminder.kind.work_minutes,
        break_minutes: reminder.kind.break_minutes,
      };
  }
}
