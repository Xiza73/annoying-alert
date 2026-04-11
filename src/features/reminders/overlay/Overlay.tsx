import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Clock, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getConfig,
  getReminder,
  snoozeReminder,
} from "@/features/reminders/api";
import { createOverlaySound } from "@/features/reminders/overlay/sound";
import type { Reminder } from "@/features/reminders/types";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * Preset snooze durations (in minutes) shown in the overlay menu. "Custom"
 * opens a native prompt for arbitrary values up to 24h (enforced by the
 * backend). 10 is the common default; 5/15/30/60 cover the rest without
 * being overwhelming.
 */
const SNOOZE_PRESETS = [5, 10, 15, 30, 60] as const;

/**
 * Intrusiveness level — mirrors Rust's 1..5 clamp. The level is chosen
 * at window-creation time based on the reminder's `intrusiveness` and
 * drives which overlay variant we render.
 */
export type OverlayLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Seconds before the "Hecho" button becomes clickable in the high-level
 * variants. Low levels are dismissable instantly; L4 forces a brief
 * acknowledgement pause; L5 holds the user hostage for longer.
 */
const LOCKDOWN_SECONDS: Record<OverlayLevel, number> = {
  1: 0,
  2: 0,
  3: 0,
  4: 3,
  5: 10,
};

/**
 * Seconds after which L1/L2 toasts auto-dismiss themselves. Higher levels
 * never auto-dismiss — the user must click through.
 */
const AUTO_DISMISS_SECONDS: Record<OverlayLevel, number | null> = {
  1: 8,
  2: 12,
  3: null,
  4: null,
  5: null,
};

/**
 * The intrusive reminder overlay.
 *
 * Rendered inside a dedicated Tauri webview window whose geometry +
 * placement + focus behavior was computed Rust-side from the reminder's
 * `intrusiveness` level (see `src-tauri/src/notifier/overlay.rs`). This
 * component just picks a visual variant matching that level.
 *
 * This component assumes it runs in its OWN webview window — never
 * embed it inside the main app tree. The `dismiss()` handler closes the
 * *current* window, which in the main app would nuke the whole UI.
 */
export function Overlay({
  reminderId,
  level,
}: {
  reminderId: number;
  level: OverlayLevel;
}) {
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockdownRemaining, setLockdownRemaining] = useState(
    LOCKDOWN_SECONDS[level],
  );
  const [defaultSnooze, setDefaultSnooze] = useState<number>(10);
  // Global volume multiplier read from the `alarm_volume` config key.
  // `null` while we're still waiting for the IPC read — we delay the
  // sound playback until this resolves so the first audible burst
  // already respects the user's setting.
  const [masterVolume, setMasterVolume] = useState<number | null>(null);

  useEffect(() => {
    getReminder(reminderId)
      .then(setReminder)
      .catch((err: unknown) => setError(String(err)));
  }, [reminderId]);

  // Read the global alarm volume once. Falls back to 0.8 if the key
  // is missing, unparseable, or the IPC call fails — we never want
  // the overlay to go silent just because config loading hiccupped.
  useEffect(() => {
    getConfig("alarm_volume")
      .then((value) => {
        const parsed = value !== null ? Number.parseFloat(value) : NaN;
        setMasterVolume(Number.isFinite(parsed) ? parsed : 0.8);
      })
      .catch(() => setMasterVolume(0.8));
  }, []);

  // Play the reminder sound once the data AND volume config load.
  // The sound loops until the component unmounts (dismiss / snooze /
  // toggle-off from the main window), matching the "impossible to
  // ignore" promise: short alarms don't leave a silent overlay.
  useEffect(() => {
    if (reminder === null) return;
    if (masterVolume === null) return;
    const controller = createOverlaySound(reminder.sound_file, level, {
      masterVolume,
      loop: true,
    });
    void controller.play();
    return () => controller.stop();
  }, [reminder, level, masterVolume]);

  // Read the user's configured default snooze once. Falls back to 10m
  // if the key is missing or unparseable — matches the schema seed.
  useEffect(() => {
    getConfig("default_snooze_minutes")
      .then((value) => {
        if (value === null) return;
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          setDefaultSnooze(parsed);
        }
      })
      .catch((err: unknown) => {
        console.warn("overlay: failed to read default_snooze_minutes", err);
      });
  }, []);

  async function handleSnooze(minutes: number) {
    try {
      await snoozeReminder(reminderId, minutes);
      await closeSelf(reminderId);
    } catch (err) {
      console.error("overlay: snooze failed", err);
      setError(String(err));
    }
  }

  // ── Auto-dismiss timer for L1/L2 ───────────────────────────────────────
  //
  // Fires a single setTimeout and closes the window when it expires.
  // Cleared on unmount / manual dismiss so we don't double-fire.
  useEffect(() => {
    const seconds = AUTO_DISMISS_SECONDS[level];
    if (seconds === null) return;
    if (reminder === null) return; // wait for data first

    const handle = window.setTimeout(() => {
      void closeSelf(reminderId);
    }, seconds * 1000);
    return () => window.clearTimeout(handle);
  }, [level, reminder, reminderId]);

  // ── Lockdown countdown for L4/L5 ───────────────────────────────────────
  //
  // 1-second interval decrementing the visible counter. When it hits 0
  // the "Hecho" button becomes enabled.
  useEffect(() => {
    if (LOCKDOWN_SECONDS[level] === 0) return;

    const handle = window.setInterval(() => {
      setLockdownRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(handle);
  }, [level]);


  if (error) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-black p-8 font-mono text-red-400">
        {error}
      </main>
    );
  }

  if (!reminder) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-black font-mono text-muted-foreground">
        cargando recordatorio #{reminderId}…
      </main>
    );
  }

  const canDismiss = lockdownRemaining === 0;

  switch (level) {
    case 1:
    case 2:
      return (
        <ToastVariant
          reminder={reminder}
          level={level}
          onDismiss={() => void closeSelf(reminderId)}
          onSnooze={() => void handleSnooze(defaultSnooze)}
          defaultSnooze={defaultSnooze}
        />
      );
    case 3:
      return (
        <StandardVariant
          reminder={reminder}
          onDismiss={() => void closeSelf(reminderId)}
          onSnooze={handleSnooze}
          defaultSnooze={defaultSnooze}
        />
      );
    case 4:
      return (
        <StandardVariant
          reminder={reminder}
          onDismiss={() => void closeSelf(reminderId)}
          onSnooze={handleSnooze}
          defaultSnooze={defaultSnooze}
          canDismiss={canDismiss}
          lockdownRemaining={lockdownRemaining}
          aggressive
        />
      );
    case 5:
      return (
        <FullscreenVariant
          reminder={reminder}
          canDismiss={canDismiss}
          lockdownRemaining={lockdownRemaining}
          onDismiss={() => void closeSelf(reminderId)}
          onSnooze={handleSnooze}
          defaultSnooze={defaultSnooze}
        />
      );
  }
}

// ─── Snooze menu ─────────────────────────────────────────────────────────────

/**
 * A small popover with preset durations + a "custom" entry. Hidden by
 * default; toggled by the parent variant's "Posponer" button. The
 * custom path uses `window.prompt` — ugly but zero-dependency, and the
 * overlay runs in its own webview so a native prompt is fine.
 */
function SnoozeMenu({
  open,
  defaultSnooze,
  onPick,
  onClose,
}: {
  open: boolean;
  defaultSnooze: number;
  onPick: (minutes: number) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  function handleCustom() {
    const raw = window.prompt(
      "Posponer por cuántos minutos? (1 - 1440)",
      String(defaultSnooze),
    );
    if (raw === null) {
      onClose();
      return;
    }
    const minutes = Number.parseInt(raw, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      window.alert("Valor inválido. Usá un número entre 1 y 1440.");
      return;
    }
    onPick(minutes);
  }

  // Merge defaults + presets, dedup, sort ascending. This way the
  // user's configured default always appears even if it's 7 or 45.
  const minutesList = Array.from(
    new Set<number>([...SNOOZE_PRESETS, defaultSnooze]),
  ).sort((a, b) => a - b);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex min-w-[280px] flex-col gap-2 rounded-xl border border-violet-500/30 bg-zinc-950 p-5 shadow-2xl">
        <p className="mb-1 text-center font-mono text-xs uppercase tracking-widest text-violet-300/70">
          posponer por
        </p>
        {minutesList.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onPick(m)}
            className="rounded-md border border-violet-500/20 bg-violet-500/5 px-4 py-2 text-left text-white transition hover:border-violet-400 hover:bg-violet-500/20"
          >
            {formatMinutes(m)}
            {m === defaultSnooze && (
              <span className="ml-2 text-xs text-violet-300/60">default</span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={handleCustom}
          className="rounded-md border border-violet-500/20 bg-transparent px-4 py-2 text-left text-violet-200 transition hover:border-violet-400 hover:bg-violet-500/10"
        >
          Otro…
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-1 rounded-md px-4 py-1.5 text-xs text-violet-300/60 hover:text-violet-200"
        >
          cancelar
        </button>
      </div>
    </div>
  );
}

/** Pretty-print a minute count as "10m", "1h", "1h 30m". */
function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (rest === 0) return `${h}h`;
  return `${h}h ${rest}m`;
}

// ─── Dismiss helper ──────────────────────────────────────────────────────────

/**
 * Close the current webview window via a Rust command.
 *
 * On Windows, Tauri v2 + WebView2 blocks `window.close()` from JS when the
 * window is in fullscreen mode (L5 overlays). The `dismiss_overlay` Rust
 * command works around this by calling `set_fullscreen(false)` before closing.
 *
 * Falls back to direct JS close if the Tauri command fails for any reason,
 * so we never end up strictly worse than before.
 */
async function closeSelf(reminderId: number) {
  try {
    await invoke("dismiss_overlay", { reminderId });
  } catch (err) {
    console.error("overlay: failed to dismiss via command", err);
    // Fallback: try direct JS close
    try {
      await getCurrentWebviewWindow().close();
    } catch (err2) {
      console.error("overlay: fallback close also failed", err2);
    }
  }
}

// ─── Variant: Toast (L1, L2) ─────────────────────────────────────────────────

/**
 * Compact toast-style overlay for low intrusiveness. Sits in the
 * top-right corner, shows a one-line title (plus description for L2),
 * and auto-dismisses after a few seconds.
 */
function ToastVariant({
  reminder,
  level,
  onDismiss,
  onSnooze,
  defaultSnooze,
}: {
  reminder: Reminder;
  level: 1 | 2;
  onDismiss: () => void;
  onSnooze: () => void;
  defaultSnooze: number;
}) {
  return (
    <main className="relative flex h-screen w-screen items-center gap-3 overflow-hidden rounded-lg border border-violet-500/30 bg-zinc-950/95 px-4 py-3 text-white shadow-2xl backdrop-blur">
      {/* Color chip */}
      <div
        aria-hidden
        className="size-2.5 shrink-0 rounded-full ring-2 ring-white/10"
        style={{ backgroundColor: reminder.color }}
      />

      {/* Title + optional description */}
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-sm font-semibold">{reminder.title}</p>
        {level === 2 && reminder.description && (
          <p className="truncate text-xs text-violet-200/70">
            {reminder.description}
          </p>
        )}
      </div>

      {/* Quick-snooze (uses default). No menu at this size — keeping the
          toast minimal. Click posts one `snoozeReminder` and closes. */}
      <button
        type="button"
        onClick={onSnooze}
        className="shrink-0 rounded-md p-1 text-violet-300/70 transition hover:bg-violet-500/20 hover:text-white"
        aria-label={`Posponer ${defaultSnooze}m`}
        title={`Posponer ${defaultSnooze}m`}
      >
        <Clock className="size-4" />
      </button>

      {/* Dismiss X */}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 text-violet-300/70 transition hover:bg-violet-500/20 hover:text-white"
        aria-label="Cerrar"
      >
        <X className="size-4" />
      </button>
    </main>
  );
}

// ─── Variant: Standard (L3, L4) ──────────────────────────────────────────────

/**
 * The classic centered overlay. Level 3 is the baseline. Level 4 reuses
 * the same layout but with more dramatic typography and a lockdown
 * countdown on the "Hecho" button.
 */
function StandardVariant({
  reminder,
  onDismiss,
  onSnooze,
  defaultSnooze,
  canDismiss = true,
  lockdownRemaining = 0,
  aggressive = false,
}: {
  reminder: Reminder;
  onDismiss: () => void;
  onSnooze: (minutes: number) => void;
  defaultSnooze: number;
  canDismiss?: boolean;
  lockdownRemaining?: number;
  aggressive?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <main
      className={cn(
        "relative flex h-screen w-screen flex-col items-center justify-center gap-8 overflow-hidden text-white select-none",
        aggressive
          ? "bg-gradient-to-br from-rose-950 via-violet-900 to-black"
          : "bg-gradient-to-br from-violet-950 via-violet-900 to-black",
      )}
    >
      {/* Pulsing halo behind the content — makes the whole window feel
          alive and urgent. Pointer-events none so it never eats clicks. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 animate-pulse",
          aggressive
            ? "bg-[radial-gradient(ellipse_at_center,rgba(244,63,94,0.35),transparent_70%)]"
            : "bg-[radial-gradient(ellipse_at_center,rgba(124,92,255,0.35),transparent_70%)]",
        )}
      />

      {/* Brand chip */}
      <div className="relative rounded-full border border-violet-400/40 bg-violet-500/10 px-4 py-1 font-mono text-xs uppercase tracking-[0.3em] text-violet-200">
        waqyay · recordatorio
      </div>

      <div
        aria-hidden
        className="relative size-4 rounded-full ring-4 ring-white/10"
        style={{ backgroundColor: reminder.color }}
      />

      <h1
        className={cn(
          "relative px-12 text-center font-heading font-bold leading-tight tracking-tight drop-shadow-[0_0_40px_rgba(124,92,255,0.6)]",
          aggressive ? "text-7xl" : "text-6xl",
        )}
      >
        {reminder.title}
      </h1>

      {reminder.description && (
        <p className="relative max-w-2xl px-12 text-center text-xl text-violet-100/90">
          {reminder.description}
        </p>
      )}

      <div className="relative mt-4 flex items-center gap-3">
        <Button
          onClick={onDismiss}
          size="lg"
          disabled={!canDismiss}
          className="h-14 px-12 text-lg font-semibold shadow-[0_0_30px_rgba(124,92,255,0.5)] disabled:opacity-60"
        >
          {canDismiss ? "Hecho" : `Hecho · ${lockdownRemaining}s`}
        </Button>
        <Button
          onClick={() => setMenuOpen(true)}
          size="lg"
          variant="outline"
          className="h-14 border-violet-400/40 bg-transparent px-6 text-base text-violet-100 hover:bg-violet-500/10"
        >
          <Clock className="mr-2 size-4" />
          Posponer
        </Button>
      </div>

      <div className="absolute bottom-6 font-mono text-[10px] uppercase tracking-widest text-violet-300/50">
        #{reminder.id} · nivel {reminder.intrusiveness} · {reminder.kind.type}
      </div>

      <SnoozeMenu
        open={menuOpen}
        defaultSnooze={defaultSnooze}
        onPick={(m) => {
          setMenuOpen(false);
          onSnooze(m);
        }}
        onClose={() => setMenuOpen(false)}
      />
    </main>
  );
}

// ─── Variant: Fullscreen lockdown (L5) ───────────────────────────────────────

/**
 * Maximum intrusion: fullscreen takeover, long lockdown countdown, and
 * Alt+F4 interception (handled in the parent via `onCloseRequested`).
 * This is the variant used for genuinely critical reminders where the
 * user opted in to being hostage for 10+ seconds.
 */
function FullscreenVariant({
  reminder,
  canDismiss,
  lockdownRemaining,
  onDismiss,
  onSnooze,
  defaultSnooze,
}: {
  reminder: Reminder;
  canDismiss: boolean;
  lockdownRemaining: number;
  onDismiss: () => void;
  onSnooze: (minutes: number) => void;
  defaultSnooze: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <main className="relative flex h-screen w-screen flex-col items-center justify-center gap-12 overflow-hidden bg-gradient-to-br from-black via-rose-950 to-black text-white select-none">
      {/* Double halo — red on the outside, violet core. Adds weight. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 animate-pulse bg-[radial-gradient(ellipse_at_center,rgba(244,63,94,0.4),transparent_65%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(124,92,255,0.25),transparent_55%)]"
      />

      <div className="relative rounded-full border border-rose-400/50 bg-rose-500/10 px-5 py-1.5 font-mono text-sm uppercase tracking-[0.4em] text-rose-200">
        waqyay · máxima prioridad
      </div>

      <div
        aria-hidden
        className="relative size-6 rounded-full ring-4 ring-white/20"
        style={{ backgroundColor: reminder.color }}
      />

      <h1 className="relative px-16 text-center font-heading text-8xl font-black leading-tight tracking-tight drop-shadow-[0_0_60px_rgba(244,63,94,0.7)]">
        {reminder.title}
      </h1>

      {reminder.description && (
        <p className="relative max-w-4xl px-16 text-center text-2xl text-rose-100/90">
          {reminder.description}
        </p>
      )}

      <div className="relative mt-4 flex items-center gap-4">
        <Button
          onClick={onDismiss}
          size="lg"
          disabled={!canDismiss}
          className="h-16 px-16 text-xl font-semibold shadow-[0_0_50px_rgba(244,63,94,0.6)] disabled:opacity-50"
        >
          {canDismiss ? "Hecho" : `Espera · ${lockdownRemaining}s`}
        </Button>
        <Button
          onClick={() => setMenuOpen(true)}
          size="lg"
          variant="outline"
          disabled={!canDismiss}
          className="h-16 border-rose-400/40 bg-transparent px-10 text-lg text-rose-100 hover:bg-rose-500/10 disabled:opacity-40"
        >
          <Clock className="mr-2 size-5" />
          Posponer
        </Button>
      </div>

      <div className="absolute bottom-8 font-mono text-xs uppercase tracking-widest text-rose-300/60">
        #{reminder.id} · nivel {reminder.intrusiveness} · {reminder.kind.type}
      </div>

      <SnoozeMenu
        open={menuOpen}
        defaultSnooze={defaultSnooze}
        onPick={(m) => {
          setMenuOpen(false);
          onSnooze(m);
        }}
        onClose={() => setMenuOpen(false)}
      />
    </main>
  );
}
