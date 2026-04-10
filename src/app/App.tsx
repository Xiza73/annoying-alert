import { useEffect, useState } from "react";

import {
  createReminder,
  listReminders,
} from "@/features/reminders/api";
import type { Reminder } from "@/features/reminders/types";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * Phase 2.5 smoke test UI — exercises the full pipeline:
 *   React -> invoke -> Rust command -> SQLite -> serialized discriminated
 *   union -> React state -> rendered list.
 *
 * This whole screen gets thrown away in Phase 4 when the real Waqyay UI
 * lands. Don't polish it, don't extract components from it, don't even
 * get attached to it. It's scaffolding.
 */
function App() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    try {
      setError(null);
      const data = await listReminders();
      setReminders(data);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createSamplePomodoro() {
    setLoading(true);
    try {
      setError(null);
      await createReminder({
        title: `Pomodoro ${new Date().toLocaleTimeString()}`,
        description: "smoke test from React",
        intrusiveness: 3,
        kind: { type: "pomodoro", work_minutes: 25, break_minutes: 5 },
        category: "trabajo",
        color: "#7C5CFF",
      });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function createSampleOnce() {
    setLoading(true);
    try {
      setError(null);
      const inFiveMinutes = new Date(Date.now() + 5 * 60 * 1000)
        .toISOString()
        .slice(0, 19);
      await createReminder({
        title: "Revisar correo",
        description: "un recordatorio puntual",
        intrusiveness: 2,
        kind: { type: "once", trigger_at: inFiveMinutes },
        category: "general",
      });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex h-screen flex-col gap-6 overflow-hidden bg-background p-8 text-foreground">
      <header className="flex flex-col gap-2">
        <div
          className={cn(
            "self-start rounded-xl border border-border bg-card px-5 py-2",
            "font-mono text-xs tracking-widest uppercase text-muted-foreground",
          )}
        >
          waqyay · phase 2 smoke test
        </div>
        <h1 className="font-heading text-4xl font-bold tracking-tight">
          <span>The reminder that </span>
          <span className="text-primary">calls your name.</span>
        </h1>
      </header>

      <section className="flex gap-2">
        <Button
          onClick={createSamplePomodoro}
          disabled={loading}
          size="lg"
        >
          + Pomodoro
        </Button>
        <Button
          onClick={createSampleOnce}
          disabled={loading}
          variant="secondary"
          size="lg"
        >
          + Once (5 min)
        </Button>
        <Button onClick={refresh} variant="ghost" size="lg">
          Refresh
        </Button>
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <h2 className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
          {reminders.length} reminder{reminders.length === 1 ? "" : "s"}
        </h2>
        {reminders.map((r) => (
          <article
            key={r.id}
            className="rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  className="size-3 rounded-full"
                  style={{ backgroundColor: r.color }}
                />
                <h3 className="font-semibold">{r.title}</h3>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                #{r.id} · {r.kind.type}
              </span>
            </div>
            {r.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {r.description}
              </p>
            )}
            <ReminderKindDetails reminder={r} />
          </article>
        ))}
      </section>
    </main>
  );
}

/**
 * Renders the kind-specific details. Thanks to the discriminated union,
 * TypeScript narrows `r.kind` inside each branch — no optional chaining
 * needed, no risk of reading a field that doesn't exist.
 */
function ReminderKindDetails({ reminder }: { reminder: Reminder }) {
  const { kind } = reminder;
  switch (kind.type) {
    case "once":
      return (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          fires at {kind.trigger_at}
        </p>
      );
    case "recurring":
      return (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {kind.rule.mode === "cron"
            ? `cron: ${kind.rule.expression}`
            : `every ${kind.rule.minutes} min`}
        </p>
      );
    case "pomodoro":
      return (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {kind.work_minutes}m work / {kind.break_minutes}m break · phase:{" "}
          {kind.phase} · cycles: {kind.cycles_completed}
        </p>
      );
  }
}

export default App;
