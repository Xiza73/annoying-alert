/**
 * Reminder create/edit form.
 *
 * One component drives both flows: if `initialValues` is provided, it's
 * an edit; otherwise it's a create. The parent decides which backend
 * command to call via the `onSubmit` callback — this component only
 * knows how to render fields and validate them.
 *
 * # Shape
 *
 * The form uses a FLAT schema with a `kind` discriminator (see
 * `schemas.ts`). A Tabs row at the top selects the kind; the rest of
 * the form reacts to `watch("kind")` and renders only the fields
 * relevant to that variant. On submit, `formToCreateInput` rebuilds
 * the discriminated-union payload the Rust backend expects.
 *
 * # React 19 / React Compiler
 *
 * No useMemo / useCallback — the compiler handles memoization
 * automatically, so the code stays direct and readable.
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { Clock, Music, Repeat, Timer, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  listSavedSounds,
  type SavedSoundMeta,
  saveSoundFile,
} from "@/features/reminders/api";
import { CATEGORIES } from "@/features/reminders/categories";
import {
  defaultFormValues,
  formToCreateInput,
  REMINDER_COLORS,
  type ReminderFormInput,
  reminderFormSchema,
} from "@/features/reminders/schemas";
import type {
  Category,
  CreateReminderInput,
} from "@/features/reminders/types";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/shared/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Slider } from "@/shared/components/ui/slider";
import { Switch } from "@/shared/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/components/ui/tabs";
import { cn } from "@/shared/lib/utils";

export interface ReminderFormProps {
  /** Populate the fields for an edit flow; omit for create. */
  initialValues?: ReminderFormInput;
  /** Label for the primary submit button. */
  submitLabel?: string;
  /** Called with the mapped backend payload after successful validation. */
  onSubmit: (input: CreateReminderInput) => Promise<void>;
  /** Called when the user cancels — parent should close the Sheet. */
  onCancel: () => void;
}

export function ReminderForm({
  initialValues,
  submitLabel = "Guardar",
  onSubmit,
  onCancel,
}: ReminderFormProps) {
  const form = useForm<ReminderFormInput>({
    // @hookform/resolvers 5.2.2 hardcodes `_zod.version.minor: 0` in its
    // TS types, but Zod 4.3.x ships with minor=3, so overload resolution
    // fails at compile time even though runtime dispatch (via
    // `isZod4Schema`) works. We cast through `never` to accept it — the
    // resolver itself will parse with the correct schema at runtime.
    resolver: zodResolver(reminderFormSchema as never),
    defaultValues: initialValues ?? defaultFormValues(),
    mode: "onBlur",
  });

  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = form;

  // `useWatch` is the React-Compiler-safe alternative to `form.watch()`.
  // The function returned by `watch()` is a closure RHF can't guarantee
  // is memo-stable, so the Compiler skips optimizing components that
  // use it. `useWatch` is a proper hook with a stable signature —
  // Compiler happily memoizes around it.
  const kind = useWatch({ control, name: "kind" });
  const color = useWatch({ control, name: "color" });
  const category = useWatch({ control, name: "category" }) ?? "general";
  const intrusiveness = useWatch({ control, name: "intrusiveness" });
  const recurrenceMode =
    useWatch({ control, name: "recurrence_mode" }) ?? "interval";
  const sendDesktop = useWatch({ control, name: "send_desktop" }) ?? true;
  const sendMobile = useWatch({ control, name: "send_mobile" }) ?? true;
  const soundFile = useWatch({ control, name: "sound_file" }) ?? "default";

  // Sound picker state.
  //
  // `savedSounds` is the gallery of audio files already persisted under
  // the app data dir, loaded once on mount. After a successful upload
  // we refetch so the just-added sound shows up in the Select without
  // a reload. `soundUploading` drives the spinner; `soundError` is
  // shown inline under the picker.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [savedSounds, setSavedSounds] = useState<SavedSoundMeta[]>([]);
  const [soundUploading, setSoundUploading] = useState(false);
  const [soundError, setSoundError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listSavedSounds()
      .then((list) => {
        if (!cancelled) setSavedSounds(list);
      })
      .catch((err: unknown) => {
        // Non-fatal: the user can still upload new sounds even if the
        // gallery fails to load. Just log so we notice in dev.
        console.error("listSavedSounds failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSoundFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Always clear the input so re-picking the same file still fires
    // `change`. Otherwise a second pick of the same name is a no-op.
    event.target.value = "";
    if (!file) return;

    // 10 MB matches the Rust cap in save_sound_file. Checking here gives
    // the user instant feedback instead of waiting for IPC.
    const MAX_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      setSoundError("El archivo supera los 10 MB");
      return;
    }

    setSoundError(null);
    setSoundUploading(true);
    try {
      // FileReader → data URL is the simplest way to get base64 in the
      // browser. We strip the `data:...;base64,` prefix before sending
      // to Rust, which expects raw base64.
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== "string") {
            reject(new Error("FileReader did not return a string"));
            return;
          }
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => {
          reject(reader.error ?? new Error("FileReader failed"));
        };
        reader.readAsDataURL(file);
      });

      const saved = await saveSoundFile(file.name, base64);
      setValue("sound_file", saved.filename, { shouldValidate: true });
      // Refetch so the gallery picks up the new file (or bumps its
      // reference count if the same bytes were re-uploaded).
      try {
        const list = await listSavedSounds();
        setSavedSounds(list);
      } catch (err) {
        console.error("listSavedSounds refetch failed", err);
      }
    } catch (err) {
      console.error("sound upload failed", err);
      setSoundError(
        err instanceof Error ? err.message : "No se pudo guardar el sonido",
      );
    } finally {
      setSoundUploading(false);
    }
  }


  async function submit(data: ReminderFormInput) {
    // Resolver has already validated, but we still need to run the
    // schema once more to get the parsed/coerced output shape. The
    // cheapest way is just to re-parse — superRefine is idempotent.
    const parsed = reminderFormSchema.parse(data);
    const payload = formToCreateInput(parsed);
    await onSubmit(payload);
  }

  return (
    <form
      onSubmit={handleSubmit(submit)}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
    >
      {/* ── Kind tabs ─────────────────────────────────────────────────────── */}
      <Tabs
        value={kind}
        onValueChange={(value) =>
          setValue("kind", value as ReminderFormInput["kind"], {
            shouldValidate: true,
          })
        }
      >
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="once">
            <Clock />
            <span>Una vez</span>
          </TabsTrigger>
          <TabsTrigger value="recurring">
            <Repeat />
            <span>Recurrente</span>
          </TabsTrigger>
          <TabsTrigger value="pomodoro">
            <Timer />
            <span>Pomodoro</span>
          </TabsTrigger>
        </TabsList>

        {/* ── Once ────────────────────────────────────────────────────────── */}
        <TabsContent value="once" className="mt-3">
          <Field
            label="Fecha y hora"
            error={errors.trigger_at?.message}
            htmlFor="trigger_at"
          >
            <Input
              id="trigger_at"
              type="datetime-local"
              {...register("trigger_at")}
            />
          </Field>
        </TabsContent>

        {/* ── Recurring ───────────────────────────────────────────────────── */}
        <TabsContent value="recurring" className="mt-3 space-y-3">
          <RadioGroup
            value={recurrenceMode}
            onValueChange={(v) =>
              setValue(
                "recurrence_mode",
                v as ReminderFormInput["recurrence_mode"],
                { shouldValidate: true },
              )
            }
            className="flex gap-4"
          >
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <RadioGroupItem value="interval" /> Intervalo
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <RadioGroupItem value="cron" /> Cron
            </label>
          </RadioGroup>

          {recurrenceMode === "interval" ? (
            <Field
              label="Cada cuántos minutos"
              error={errors.interval_minutes?.message}
              htmlFor="interval_minutes"
            >
              <Input
                id="interval_minutes"
                type="number"
                min={1}
                step={1}
                {...register("interval_minutes")}
              />
            </Field>
          ) : (
            <Field
              label="Expresión cron"
              hint="Formato POSIX: min hora dia mes dia-semana"
              error={errors.cron_expression?.message}
              htmlFor="cron_expression"
            >
              <Input
                id="cron_expression"
                type="text"
                placeholder="0 9 * * 1-5"
                {...register("cron_expression")}
              />
            </Field>
          )}
        </TabsContent>

        {/* ── Pomodoro ────────────────────────────────────────────────────── */}
        <TabsContent value="pomodoro" className="mt-3">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Trabajo (min)"
              error={errors.work_minutes?.message}
              htmlFor="work_minutes"
            >
              <Input
                id="work_minutes"
                type="number"
                min={1}
                step={1}
                {...register("work_minutes")}
              />
            </Field>
            <Field
              label="Descanso (min)"
              error={errors.break_minutes?.message}
              htmlFor="break_minutes"
            >
              <Input
                id="break_minutes"
                type="number"
                min={1}
                step={1}
                {...register("break_minutes")}
              />
            </Field>
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Common fields ─────────────────────────────────────────────────── */}
      <Field
        label="Título"
        error={errors.title?.message}
        htmlFor="title"
      >
        <Input
          id="title"
          type="text"
          placeholder="Tomar agua"
          autoFocus
          {...register("title")}
        />
      </Field>

      <Field
        label="Descripción"
        error={errors.description?.message}
        htmlFor="description"
      >
        <Input
          id="description"
          type="text"
          placeholder="Opcional"
          {...register("description")}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Categoría"
          error={errors.category?.message}
          htmlFor="category"
        >
          <Select
            value={category}
            onValueChange={(v) =>
              setValue("category", v as Category, { shouldValidate: true })
            }
          >
            <SelectTrigger id="category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(({ key, label, icon: Icon, accent }) => (
                <SelectItem key={key} value={key}>
                  <span className="flex items-center gap-2">
                    <Icon className="size-4" style={{ color: accent }} />
                    {label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={`Intrusividad · ${intrusiveness ?? 3}/5`}
          error={errors.intrusiveness?.message}
          htmlFor="intrusiveness"
        >
          <Slider
            id="intrusiveness"
            min={1}
            max={5}
            step={1}
            value={[Number(intrusiveness ?? 3)]}
            onValueChange={(v) => {
              const next = v[0];
              if (typeof next === "number") {
                setValue("intrusiveness", next, { shouldValidate: true });
              }
            }}
            className="py-2"
          />
        </Field>
      </div>

      {/* ── Color palette ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label>Color</Label>
        <div className="flex flex-wrap gap-2">
          {REMINDER_COLORS.map((c) => {
            const selected = color === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() =>
                  setValue("color", c, { shouldValidate: true })
                }
                className={cn(
                  "size-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition-transform",
                  selected
                    ? "ring-primary scale-110"
                    : "ring-transparent hover:scale-105",
                )}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
                aria-pressed={selected}
              />
            );
          })}
        </div>
      </div>

      {/* ── Sound picker ──────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label htmlFor="sound_file">Sonido</Label>
        <div className="flex items-center gap-2">
          <Select
            value={soundFile}
            onValueChange={(v) => {
              // Orphan Select values can't directly trigger side
              // effects, so we hijack the sentinel `__upload__` option
              // to open the native file picker and leave the form
              // value unchanged. The handler will update it when the
              // upload completes.
              if (v === "__upload__") {
                fileInputRef.current?.click();
                return;
              }
              setSoundError(null);
              setValue("sound_file", v, { shouldValidate: true });
            }}
            disabled={soundUploading}
          >
            <SelectTrigger id="sound_file" className="flex-1">
              <span className="flex items-center gap-2">
                <Music className="size-4 text-muted-foreground" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                Sonido por defecto (beep sintético)
              </SelectItem>
              {savedSounds.map((s) => (
                <SelectItem key={s.filename} value={s.filename}>
                  <span className="flex items-center gap-2">
                    <span>{s.display_name}</span>
                    <span className="text-xs text-muted-foreground">
                      · {(s.bytes / 1024).toFixed(0)} KB
                      {s.references > 0 && ` · usado ${s.references}×`}
                    </span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value="__upload__">
                <span className="flex items-center gap-2 text-primary">
                  <Upload className="size-4" />
                  Subir nuevo archivo…
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          {/*
            Hidden native file input. Opened via the sentinel option
            above. `accept="audio/*"` filters the OS picker; real
            extension validation happens in Rust (save_sound_file →
            ALLOWED_EXTS).
          */}
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a"
            className="hidden"
            onChange={handleSoundFile}
          />
        </div>
        {soundUploading && (
          <p className="text-xs text-muted-foreground">Subiendo sonido…</p>
        )}
        {soundError && <p className="text-xs text-destructive">{soundError}</p>}
      </div>

      {/* ── Channels ──────────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card/50 p-3">
        <ChannelRow
          label="Desktop (overlay intrusivo)"
          checked={sendDesktop}
          onCheckedChange={(v) =>
            setValue("send_desktop", v, { shouldValidate: true })
          }
        />
        <ChannelRow
          label="Mobile (push vía ntfy)"
          checked={sendMobile}
          onCheckedChange={(v) =>
            setValue("send_mobile", v, { shouldValidate: true })
          }
        />
      </div>

      {/* ── Footer buttons ────────────────────────────────────────────────── */}
      <div className="mt-auto flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancelar
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Guardando..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}

function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ChannelRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
