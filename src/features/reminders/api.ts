/**
 * Thin wrapper around Tauri's `invoke` for reminder commands.
 *
 * Every backend call lives here so React components never touch
 * `@tauri-apps/api` directly. This keeps the UI testable (mock this
 * module) and gives us a single place to add logging, retries, or
 * typed error parsing later.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  CreateReminderInput,
  Reminder,
  UpdateReminderInput,
} from "./types";

export async function listReminders(): Promise<Reminder[]> {
  return invoke<Reminder[]>("list_reminders");
}

export async function getReminder(id: number): Promise<Reminder> {
  return invoke<Reminder>("get_reminder", { id });
}

export async function createReminder(
  input: CreateReminderInput,
): Promise<Reminder> {
  return invoke<Reminder>("create_reminder", { input });
}

export async function updateReminder(
  id: number,
  input: UpdateReminderInput,
): Promise<Reminder> {
  return invoke<Reminder>("update_reminder", { id, input });
}

export async function deleteReminder(id: number): Promise<void> {
  return invoke<void>("delete_reminder", { id });
}

/**
 * Flip `is_active` on a reminder. Does not touch `next_trigger` — the
 * scheduler just skips inactive rows, so toggling is the cheapest way to
 * pause/resume without losing the schedule.
 */
export async function toggleReminderActive(id: number): Promise<Reminder> {
  return invoke<Reminder>("toggle_reminder_active", { id });
}

/**
 * Dev-only cleanup helper. Wipes the entire reminders table. Bound to
 * the "Clear all" button in the Phase 2 smoke-test UI; will disappear
 * (or move behind a confirm dialog) when the real UI lands.
 */
export async function deleteAllReminders(): Promise<number> {
  return invoke<number>("delete_all_reminders");
}

/**
 * Snooze a reminder for the given number of minutes from now. The
 * scheduler's due query filters on `snooze_until <= now`, so the row is
 * simply skipped on every tick until the snooze expires. Used by the
 * overlay "Snooze" button.
 */
export async function snoozeReminder(
  id: number,
  minutes: number,
): Promise<Reminder> {
  return invoke<Reminder>("snooze_reminder", { id, minutes });
}

/**
 * Read a single config value by key. Returns `null` if the key was not
 * seeded — callers are expected to provide their own fallback in that
 * case.
 */
export async function getConfig(key: string): Promise<string | null> {
  const value = await invoke<string | null>("get_config", { key });
  return value;
}

/** Write a single config value by key. Creates the row if missing. */
export async function setConfig(key: string, value: string): Promise<void> {
  return invoke<void>("set_config", { key, value });
}

/**
 * Result of a successful sound upload. `filename` is the content-hashed
 * name to store in `reminders.sound_file`; `bytes` is the raw file size
 * for the "1.2 KB" display in the form.
 */
export interface SavedSound {
  filename: string;
  bytes: number;
}

/**
 * Persist a picked audio file under the app data dir. Caller is expected
 * to have already base64-encoded the bytes (cheap via FileReader).
 */
export async function saveSoundFile(
  originalName: string,
  base64: string,
): Promise<SavedSound> {
  return invoke<SavedSound>("save_sound_file", {
    originalName,
    base64,
  });
}

/**
 * Fetch a previously saved sound as a `data:audio/...;base64,...` URL
 * ready to assign to `<audio src={...}>`. Throws if the file is missing.
 */
export async function getSoundDataUrl(filename: string): Promise<string> {
  return invoke<string>("get_sound_data_url", { filename });
}

/**
 * Metadata for a sound already persisted under the app data dir.
 * Returned by {@link listSavedSounds} so the ReminderForm can render
 * a gallery picker without re-uploading files.
 */
export interface SavedSoundMeta {
  filename: string;
  bytes: number;
  /** How many reminders currently point at this file. */
  references: number;
}

/**
 * List every saved sound file with its reference count. Sorted
 * most-referenced first, then alphabetically.
 */
export async function listSavedSounds(): Promise<SavedSoundMeta[]> {
  return invoke<SavedSoundMeta[]>("list_saved_sounds");
}

/**
 * Report from {@link cleanupUnusedSounds}: how many files were
 * inspected, how many were deleted, and how many bytes were reclaimed.
 */
export interface SweepReport {
  scanned: number;
  removed: number;
  bytes_freed: number;
}

/**
 * Run a manual orphan sweep: delete every sound file under the app
 * data dir that no reminder currently references. Auto-sweep also
 * runs after every reminder delete, but this is the "free me X MB
 * right now" button for the SettingsSheet.
 */
export async function cleanupUnusedSounds(): Promise<SweepReport> {
  return invoke<SweepReport>("cleanup_unused_sounds");
}
