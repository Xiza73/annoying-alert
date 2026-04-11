/**
 * Global app settings sheet.
 *
 * Backed by the `config` key/value table via `get_config` / `set_config`
 * IPC commands. Fields:
 *   - quiet_hours_enabled (switch)
 *   - quiet_hours_start / quiet_hours_end (HH:MM text inputs)
 *   - default_snooze_minutes (number input)
 *   - ntfy_server / ntfy_topic (text inputs for mobile push)
 *
 * Values are loaded once when the sheet opens and committed on "Guardar".
 * We do NOT persist per-field on blur because partially-saved quiet hours
 * (start without end) could produce a weird scheduler state.
 */

import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { Play, Save, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  cleanupUnusedSounds,
  getConfig,
  setConfig,
  type SweepReport,
} from "@/features/reminders/api";
import { playPreview } from "@/features/reminders/overlay/sound";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { Slider } from "@/shared/components/ui/slider";
import { Switch } from "@/shared/components/ui/switch";

/**
 * All the keys we touch in this sheet. Kept as a const tuple so we can
 * iterate them for the initial load without hardcoding the list twice.
 */
const CONFIG_KEYS = [
  "quiet_hours_enabled",
  "quiet_hours_start",
  "quiet_hours_end",
  "default_snooze_minutes",
  "ntfy_server",
  "ntfy_topic",
  "start_minimized",
  "alarm_volume",
] as const;

interface SettingsValues {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultSnoozeMinutes: string;
  ntfyServer: string;
  ntfyTopic: string;
  startMinimized: boolean;
  autostartEnabled: boolean;
  /**
   * Master volume multiplier for alarm playback (0..1). Applied on top
   * of the intrusiveness-level curve defined in `overlay/sound.ts`.
   */
  alarmVolume: number;
}

const DEFAULT_VALUES: SettingsValues = {
  quietHoursEnabled: false,
  quietHoursStart: "23:00",
  quietHoursEnd: "07:00",
  defaultSnoozeMinutes: "10",
  ntfyServer: "https://ntfy.sh",
  ntfyTopic: "",
  startMinimized: false,
  autostartEnabled: false,
  alarmVolume: 0.8,
};

/** Accepts `"HH:MM"` with optional leading zeros (e.g. "7:30" or "07:30"). */
function isValidHhmm(s: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.trim());
}

/**
 * Humanize a byte count for the sound cleanup report. We only show
 * one fractional digit and cap at MB — sound files are tiny and the
 * sweep is rare, so more precision is noise.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SettingsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [values, setValues] = useState<SettingsValues>(DEFAULT_VALUES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleanup sweep state. Lives outside `values` because it's a one-shot
  // action (not a field to persist) and we want to show the report
  // inline without triggering the "saved ✓" banner.
  const [sweeping, setSweeping] = useState(false);
  const [lastSweep, setLastSweep] = useState<SweepReport | null>(null);

  async function handleCleanupSounds() {
    setSweeping(true);
    setError(null);
    try {
      const report = await cleanupUnusedSounds();
      setLastSweep(report);
    } catch (err) {
      setError(String(err));
    } finally {
      setSweeping(false);
    }
  }

  // Load every time the sheet opens, not once on mount — the user may
  // have edited config elsewhere (future tray menu, etc.) while this
  // component was still mounted but closed.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Autostart lives in the OS registry, not the `config` table, so
    // we ask the plugin for it in parallel with the config reads.
    Promise.all([
      ...CONFIG_KEYS.map((k) => getConfig(k)),
      isAutostartEnabled().catch(() => false),
    ])
      .then((results) => {
        if (cancelled) return;
        const configResults = results.slice(
          0,
          CONFIG_KEYS.length,
        ) as (string | null)[];
        const autostart = results[CONFIG_KEYS.length] as boolean;
        const map = Object.fromEntries(
          CONFIG_KEYS.map((k, i) => [k, configResults[i] ?? null]),
        );
        // Parse the alarm_volume float from its TEXT storage. Any
        // garbage (missing key, NaN, non-numeric) falls back to the
        // 0.8 default so the slider always has a valid position.
        const rawVolume = map["alarm_volume"];
        const parsedVolume =
          rawVolume !== null && rawVolume !== undefined
            ? Number.parseFloat(rawVolume)
            : NaN;
        const alarmVolume = Number.isFinite(parsedVolume)
          ? Math.min(1, Math.max(0, parsedVolume))
          : DEFAULT_VALUES.alarmVolume;

        setValues({
          quietHoursEnabled: map["quiet_hours_enabled"] === "1",
          quietHoursStart: map["quiet_hours_start"] ?? DEFAULT_VALUES.quietHoursStart,
          quietHoursEnd: map["quiet_hours_end"] ?? DEFAULT_VALUES.quietHoursEnd,
          defaultSnoozeMinutes:
            map["default_snooze_minutes"] ?? DEFAULT_VALUES.defaultSnoozeMinutes,
          ntfyServer: map["ntfy_server"] ?? DEFAULT_VALUES.ntfyServer,
          ntfyTopic: map["ntfy_topic"] ?? DEFAULT_VALUES.ntfyTopic,
          startMinimized: map["start_minimized"] === "1",
          autostartEnabled: autostart,
          alarmVolume,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleSave() {
    // Validate before writing anything.
    if (!isValidHhmm(values.quietHoursStart)) {
      setError("quiet_hours_start: formato inválido (HH:MM)");
      return;
    }
    if (!isValidHhmm(values.quietHoursEnd)) {
      setError("quiet_hours_end: formato inválido (HH:MM)");
      return;
    }
    const snooze = Number.parseInt(values.defaultSnoozeMinutes, 10);
    if (!Number.isFinite(snooze) || snooze < 1 || snooze > 1440) {
      setError("default_snooze_minutes: debe estar entre 1 y 1440");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await Promise.all([
        setConfig("quiet_hours_enabled", values.quietHoursEnabled ? "1" : "0"),
        setConfig("quiet_hours_start", values.quietHoursStart.trim()),
        setConfig("quiet_hours_end", values.quietHoursEnd.trim()),
        setConfig("default_snooze_minutes", String(snooze)),
        setConfig("ntfy_server", values.ntfyServer.trim()),
        setConfig("ntfy_topic", values.ntfyTopic.trim()),
        setConfig("start_minimized", values.startMinimized ? "1" : "0"),
        // Persist with 2 decimals: the slider has 20 steps (0.05),
        // which is plenty, and the shorter string keeps debugging
        // the config table more pleasant.
        setConfig("alarm_volume", values.alarmVolume.toFixed(2)),
        // Mirror the autostart toggle into the OS registry. We check
        // the current state first to avoid no-op writes that would
        // bump `HKCU\...\Run` last-modified for nothing.
        (async () => {
          const current = await isAutostartEnabled().catch(() => null);
          if (current === values.autostartEnabled) return;
          if (values.autostartEnabled) {
            await enableAutostart();
          } else {
            await disableAutostart();
          }
        })(),
      ]);
      toast.success("Configuración guardada");
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-6 overflow-x-hidden overflow-y-auto px-6 py-6 sm:max-w-xl"
      >
        <SheetHeader className="p-0">
          <SheetTitle>Configuración</SheetTitle>
          <SheetDescription>
            Ajustes globales. Se aplican a todos los recordatorios.
          </SheetDescription>
        </SheetHeader>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ── Alarm volume + preview ──────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-heading text-lg">
              <Volume2 className="size-4" />
              Volumen de alarma
            </h3>
            <p className="text-xs text-muted-foreground">
              Multiplicador global aplicado a todos los recordatorios.
              Por debajo sigue escalando según el nivel de intrusividad.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Slider
              value={[Math.round(values.alarmVolume * 100)]}
              min={0}
              max={100}
              step={5}
              onValueChange={(arr) =>
                setValues((v) => ({
                  ...v,
                  alarmVolume: (arr[0] ?? 0) / 100,
                }))
              }
              className="flex-1"
              aria-label="Volumen de alarma"
            />
            <span className="w-12 text-right font-mono text-xs text-muted-foreground">
              {Math.round(values.alarmVolume * 100)}%
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void playPreview(3, values.alarmVolume);
              }}
            >
              <Play className="mr-2 size-4" />
              Probar
            </Button>
          </div>
        </section>

        {/* ── Quiet hours ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-heading text-lg">Horas silenciosas</h3>
              <p className="text-xs text-muted-foreground">
                Durante este rango, los recordatorios se bajan a nivel 1
                (toast compacto). Nunca se pierden.
              </p>
            </div>
            <Switch
              checked={values.quietHoursEnabled}
              onCheckedChange={(checked) =>
                setValues((v) => ({ ...v, quietHoursEnabled: checked }))
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qh-start">Desde</Label>
              <Input
                id="qh-start"
                value={values.quietHoursStart}
                disabled={!values.quietHoursEnabled}
                onChange={(e) =>
                  setValues((v) => ({ ...v, quietHoursStart: e.target.value }))
                }
                placeholder="23:00"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qh-end">Hasta</Label>
              <Input
                id="qh-end"
                value={values.quietHoursEnd}
                disabled={!values.quietHoursEnabled}
                onChange={(e) =>
                  setValues((v) => ({ ...v, quietHoursEnd: e.target.value }))
                }
                placeholder="07:00"
              />
            </div>
          </div>
        </section>

        {/* ── Default snooze ──────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <Label htmlFor="default-snooze">Snooze por defecto (minutos)</Label>
          <Input
            id="default-snooze"
            type="number"
            min={1}
            max={1440}
            value={values.defaultSnoozeMinutes}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                defaultSnoozeMinutes: e.target.value,
              }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Valor que usa el overlay al tocar el ícono rápido de posponer.
          </p>
        </section>

        {/* ── Startup ─────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <h3 className="font-heading text-lg">Arranque</h3>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Iniciar con Windows</p>
              <p className="text-xs text-muted-foreground">
                Agrega Waqyay al arranque del usuario (HKCU Run). No
                requiere permisos de administrador.
              </p>
            </div>
            <Switch
              checked={values.autostartEnabled}
              onCheckedChange={(checked) =>
                setValues((v) => ({ ...v, autostartEnabled: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Iniciar minimizado</p>
              <p className="text-xs text-muted-foreground">
                Al abrir Waqyay, la ventana principal arranca oculta en
                la bandeja. El scheduler sigue corriendo. Ideal combinado
                con «Iniciar con Windows».
              </p>
            </div>
            <Switch
              checked={values.startMinimized}
              onCheckedChange={(checked) =>
                setValues((v) => ({ ...v, startMinimized: checked }))
              }
            />
          </div>
        </section>

        {/* ── Sounds cleanup ──────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="font-heading text-lg">Sonidos guardados</h3>
            <p className="text-xs text-muted-foreground">
              Los audios personalizados se guardan en tu carpeta de datos
              local con un nombre basado en el hash del contenido. Al
              borrar un recordatorio, los huérfanos se limpian solos.
              Este botón fuerza una pasada manual.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCleanupSounds}
              disabled={sweeping || loading}
            >
              <Trash2 className="mr-2 size-4" />
              {sweeping ? "Limpiando..." : "Limpiar sonidos no usados"}
            </Button>
            {lastSweep && (
              <p className="text-xs text-muted-foreground">
                {lastSweep.removed === 0
                  ? `Sin huérfanos (${lastSweep.scanned} archivo${
                      lastSweep.scanned === 1 ? "" : "s"
                    } revisado${lastSweep.scanned === 1 ? "" : "s"}).`
                  : `Borrados ${lastSweep.removed} archivo${
                      lastSweep.removed === 1 ? "" : "s"
                    } · ${formatBytes(lastSweep.bytes_freed)} liberados.`}
              </p>
            )}
          </div>
        </section>

        {/* ── ntfy ────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="font-heading text-lg">Push móvil (ntfy)</h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ntfy-server">Servidor</Label>
            <Input
              id="ntfy-server"
              value={values.ntfyServer}
              onChange={(e) =>
                setValues((v) => ({ ...v, ntfyServer: e.target.value }))
              }
              placeholder="https://ntfy.sh"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ntfy-topic">Tópico</Label>
            <Input
              id="ntfy-topic"
              value={values.ntfyTopic}
              onChange={(e) =>
                setValues((v) => ({ ...v, ntfyTopic: e.target.value }))
              }
              placeholder="waqyay-tu-nombre"
            />
            <p className="text-xs text-muted-foreground">
              Dejá vacío para deshabilitar los push móviles.
            </p>
          </div>
        </section>

        <div className="mt-auto flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cerrar
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            <Save className="mr-2 size-4" />
            Guardar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
