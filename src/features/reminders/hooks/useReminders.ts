/**
 * Reminders state + actions hook.
 *
 * Owns the full list of reminders, the "last fired" banner state, and
 * the error banner state. Subscribes to the `reminder_fired` event from
 * the Rust scheduler so any background trigger is reflected in the UI
 * without a manual refresh.
 *
 * Components call `refresh`, `toggleActive`, `remove`, etc. — they never
 * touch the `invoke` wrappers directly. This keeps the UI pure and the
 * hook swappable for a store later (zustand, query, whatever).
 */

import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import {
  createReminder,
  deleteAllReminders,
  deleteReminder,
  listReminders,
  toggleReminderActive,
  updateReminder,
} from "@/features/reminders/api";
import type {
  CreateReminderInput,
  Reminder,
  UpdateReminderInput,
} from "@/features/reminders/types";

export interface UseRemindersResult {
  reminders: Reminder[];
  lastFired: Reminder | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  create: (input: CreateReminderInput) => Promise<Reminder>;
  update: (id: number, input: UpdateReminderInput) => Promise<Reminder>;
  toggleActive: (id: number) => Promise<void>;
  remove: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
  dismissLastFired: () => void;
}

export function useReminders(): UseRemindersResult {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [lastFired, setLastFired] = useState<Reminder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listReminders();
      setReminders(data);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to scheduler fire events. The Rust side emits one whenever
  // a reminder's `next_trigger` is reached, carrying the freshly updated
  // row as payload. We flash the banner and refresh so pomodoro phase
  // swaps and interval reschedules are visible immediately.
  useEffect(() => {
    const unlistenPromise = listen<Reminder>("reminder_fired", (event) => {
      setLastFired(event.payload);
      void refresh();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [refresh]);

  const create = useCallback(
    async (input: CreateReminderInput): Promise<Reminder> => {
      setLoading(true);
      try {
        setError(null);
        const created = await createReminder(input);
        setReminders((prev) => [created, ...prev]);
        return created;
      } catch (err) {
        setError(String(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const update = useCallback(
    async (id: number, input: UpdateReminderInput): Promise<Reminder> => {
      setLoading(true);
      try {
        setError(null);
        const updated = await updateReminder(id, input);
        setReminders((prev) =>
          prev.map((r) => (r.id === updated.id ? updated : r)),
        );
        return updated;
      } catch (err) {
        setError(String(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Optimistic replace-in-place for the toggled row. Falls back to a
  // full refresh on error so we never show stale UI.
  const toggleActive = useCallback(async (id: number) => {
    setLoading(true);
    try {
      setError(null);
      const updated = await toggleReminderActive(id);
      setReminders((prev) =>
        prev.map((r) => (r.id === updated.id ? updated : r)),
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const remove = useCallback(async (id: number) => {
    setLoading(true);
    try {
      setError(null);
      await deleteReminder(id);
      setReminders((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearAll = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      await deleteAllReminders();
      setReminders([]);
      setLastFired(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissLastFired = useCallback(() => setLastFired(null), []);

  return {
    reminders,
    lastFired,
    error,
    loading,
    refresh,
    create,
    update,
    toggleActive,
    remove,
    clearAll,
    dismissLastFired,
  };
}
