/**
 * Raycast-ish reminder card. One per row in the main list.
 *
 * Renders the color dot, title, kind badge, intrusiveness pips, relative
 * time to next trigger, and the actions (toggle active, edit, delete).
 *
 * The card does NOT know how to fetch or mutate reminders — it takes
 * callbacks and delegates upward. Keeps it trivially reusable inside a
 * future grouped/filtered view.
 */

import { Clock, Pencil, Repeat, Timer, Trash2 } from "lucide-react";

import type { Reminder } from "@/features/reminders/types";
import { Button } from "@/shared/components/ui/button";
import { Switch } from "@/shared/components/ui/switch";
import { formatRelative } from "@/shared/lib/datetime";
import { cn } from "@/shared/lib/utils";

export interface ReminderCardProps {
  reminder: Reminder;
  disabled?: boolean;
  onToggle: (id: number) => void;
  onEdit: (reminder: Reminder) => void;
  onDelete: (id: number) => void;
}

export function ReminderCard({
  reminder,
  disabled = false,
  onToggle,
  onEdit,
  onDelete,
}: ReminderCardProps) {
  const kindLabel = describeKind(reminder);
  const relative = formatRelative(reminder.next_trigger);

  return (
    <article
      className={cn(
        "group flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 transition-colors",
        "hover:border-primary/40 hover:bg-card/80",
        !reminder.is_active && "opacity-60",
      )}
    >
      {/* Color dot */}
      <span
        className="size-3 shrink-0 rounded-full ring-2 ring-background"
        style={{ backgroundColor: reminder.color }}
        aria-hidden
      />

      {/* Title + description */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-semibold text-foreground">
            {reminder.title}
          </h3>
          <IntrusivenessPips level={reminder.intrusiveness} />
        </div>
        {reminder.description && (
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {reminder.description}
          </p>
        )}
      </div>

      {/* Kind + next trigger */}
      <div className="hidden shrink-0 flex-col items-end gap-0.5 text-right sm:flex">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <KindIcon kind={reminder.kind.type} />
          <span>{kindLabel}</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {relative}
        </span>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        <Switch
          checked={reminder.is_active}
          onCheckedChange={() => onToggle(reminder.id)}
          disabled={disabled}
          aria-label={reminder.is_active ? "Desactivar" : "Activar"}
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onEdit(reminder)}
          disabled={disabled}
          aria-label="Editar"
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onDelete(reminder.id)}
          disabled={disabled}
          aria-label="Eliminar"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </article>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Intrusiveness level as five vertical pips. Filled pips use the primary
 * accent, empties use a muted bar — think of it like a signal-strength
 * indicator for how annoying the reminder will be when it fires.
 */
function IntrusivenessPips({ level }: { level: number }) {
  return (
    <div
      className="flex items-center gap-0.5"
      aria-label={`Intrusividad ${level} de 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={cn(
            "h-3 w-0.5 rounded-full",
            n <= level ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

function describeKind(reminder: Reminder): string {
  const { kind } = reminder;
  switch (kind.type) {
    case "once":
      return "una vez";
    case "recurring":
      return kind.rule.mode === "cron"
        ? `cron · ${kind.rule.expression}`
        : `cada ${kind.rule.minutes}m`;
    case "pomodoro":
      return `pomodoro ${kind.work_minutes}/${kind.break_minutes} · ${
        kind.phase === "work" ? "trabajo" : "descanso"
      }`;
  }
}

/**
 * Small dispatcher component that renders the right lucide icon for a
 * reminder kind. Lives at module scope so React 19's static-components
 * rule is happy (we can't assign a component to a local variable inside
 * the parent's render).
 */
function KindIcon({ kind }: { kind: Reminder["kind"]["type"] }) {
  const className = "size-3.5";
  switch (kind) {
    case "once":
      return <Clock className={className} aria-hidden />;
    case "recurring":
      return <Repeat className={className} aria-hidden />;
    case "pomodoro":
      return <Timer className={className} aria-hidden />;
  }
}
