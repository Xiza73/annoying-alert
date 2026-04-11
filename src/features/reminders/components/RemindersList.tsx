/**
 * The main reminders list. Renders a stack of [`ReminderCard`] rows,
 * or an empty state when the user hasn't created anything yet.
 *
 * Pure presentational — all data and callbacks come from the parent
 * (typically [`useReminders`]).
 */

import { BellOff } from "lucide-react";

import { ReminderCard } from "@/features/reminders/components/ReminderCard";
import type { Reminder } from "@/features/reminders/types";

export interface RemindersListProps {
  reminders: Reminder[];
  disabled?: boolean;
  onToggle: (id: number) => void;
  onEdit: (reminder: Reminder) => void;
  onDelete: (id: number) => void;
}

export function RemindersList({
  reminders,
  disabled = false,
  onToggle,
  onEdit,
  onDelete,
}: RemindersListProps) {
  if (reminders.length === 0) {
    return <EmptyState />;
  }

  const activeCount = reminders.filter((r) => r.is_active).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
          {reminders.length} recordatorio{reminders.length === 1 ? "" : "s"}
        </h2>
        <span className="text-xs text-muted-foreground">
          {activeCount} activo{activeCount === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {reminders.map((r) => (
          <li key={r.id}>
            <ReminderCard
              reminder={r}
              disabled={disabled}
              onToggle={onToggle}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="rounded-full border border-border bg-card p-4">
        <BellOff className="size-8 text-muted-foreground" aria-hidden />
      </div>
      <div>
        <p className="font-semibold text-foreground">Sin recordatorios aún</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Creá uno y Waqyay te va a interrumpir cuando toque.
        </p>
      </div>
    </div>
  );
}
