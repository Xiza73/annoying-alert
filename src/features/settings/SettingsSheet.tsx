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

import { Save } from "lucide-react";
import { useEffect, useState } from "react";

import { getConfig, setConfig } from "@/features/reminders/api";
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
] as const;

interface SettingsValues {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultSnoozeMinutes: string;
  ntfyServer: string;
  ntfyTopic: string;
  startMinimized: boolean;
}

const DEFAULT_VALUES: SettingsValues = {
  quietHoursEnabled: false,
  quietHoursStart: "23:00",
  quietHoursEnd: "07:00",
  defaultSnoozeMinutes: "10",
  ntfyServer: "https://ntfy.sh",
  ntfyTopic: "",
  startMinimized: false,
};

/** Accepts `"HH:MM"` with optional leading zeros (e.g. "7:30" or "07:30"). */
function isValidHhmm(s: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.trim());
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
  const [saved, setSaved] = useState(false);

  // Load every time the sheet opens, not once on mount — the user may
  // have edited config elsewhere (future tray menu, etc.) while this
  // component was still mounted but closed.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);

    Promise.all(CONFIG_KEYS.map((k) => getConfig(k)))
      .then((results) => {
        if (cancelled) return;
        const map = Object.fromEntries(
          CONFIG_KEYS.map((k, i) => [k, results[i] ?? null]),
        );
        setValues({
          quietHoursEnabled: map["quiet_hours_enabled"] === "1",
          quietHoursStart: map["quiet_hours_start"] ?? DEFAULT_VALUES.quietHoursStart,
          quietHoursEnd: map["quiet_hours_end"] ?? DEFAULT_VALUES.quietHoursEnd,
          defaultSnoozeMinutes:
            map["default_snooze_minutes"] ?? DEFAULT_VALUES.defaultSnoozeMinutes,
          ntfyServer: map["ntfy_server"] ?? DEFAULT_VALUES.ntfyServer,
          ntfyTopic: map["ntfy_topic"] ?? DEFAULT_VALUES.ntfyTopic,
          startMinimized: map["start_minimized"] === "1",
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
      ]);
      setSaved(true);
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
        className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader>
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
        {saved && !error && (
          <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
            Guardado ✓
          </div>
        )}

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
        <section className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-heading text-lg">Arranque</h3>
            <p className="text-xs text-muted-foreground">
              Iniciar Waqyay minimizado en la bandeja del sistema. El
              scheduler sigue corriendo; la ventana principal queda oculta
              hasta que hagas click en el ícono del tray.
            </p>
          </div>
          <Switch
            checked={values.startMinimized}
            onCheckedChange={(checked) =>
              setValues((v) => ({ ...v, startMinimized: checked }))
            }
          />
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
