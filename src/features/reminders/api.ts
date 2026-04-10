/**
 * Thin wrapper around Tauri's `invoke` for reminder commands.
 *
 * Every backend call lives here so React components never touch
 * `@tauri-apps/api` directly. This keeps the UI testable (mock this
 * module) and gives us a single place to add logging, retries, or
 * typed error parsing later.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CreateReminderInput, Reminder } from "./types";

export async function listReminders(): Promise<Reminder[]> {
  return invoke<Reminder[]>("list_reminders");
}

export async function createReminder(
  input: CreateReminderInput,
): Promise<Reminder> {
  return invoke<Reminder>("create_reminder", { input });
}
