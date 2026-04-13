/**
 * Waqyay main window. Raycast-inspired dark layout with the reminders
 * list front and center.
 *
 * State lives in [`useReminders`]. This component is the thin shell that
 * wires the hook to the presentational pieces: header, banners, list.
 *
 * The "Nuevo recordatorio" / edit buttons currently stub to a TODO —
 * Phase 3.4 will replace those stubs with a shadcn Sheet + RHF form.
 */

import { listen } from "@tauri-apps/api/event";
import { BellRing, Plus, RefreshCcw, Search, Settings, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { ReminderFormSheet } from "@/features/reminders/components/ReminderFormSheet";
import { RemindersList } from "@/features/reminders/components/RemindersList";
import { useReminders } from "@/features/reminders/hooks/useReminders";
import {
  type ReminderFormInput,
  reminderToFormValues,
} from "@/features/reminders/schemas";
import type {
  Category,
  CreateReminderInput,
  Reminder,
} from "@/features/reminders/types";
import { SettingsSheet } from "@/features/settings/SettingsSheet";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Toaster } from "@/shared/components/ui/sonner";
import { cn } from "@/shared/lib/utils";

/**
 * Local state for the form sheet. We track the reminder being edited
 * (or `null` for a create flow) separately from the open boolean so
 * the sheet can animate close without the initial values snapping back
 * to `undefined` mid-transition.
 */
interface FormSheetState {
  open: boolean;
  editingId: number | null;
  initialValues: ReminderFormInput | undefined;
}

const CLOSED_SHEET: FormSheetState = {
  open: false,
  editingId: null,
  initialValues: undefined,
};

function App() {
  const {
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
  } = useReminders();

  const [sheet, setSheet] = useState<FormSheetState>(CLOSED_SHEET);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Derive unique categories present in the loaded reminders (compiler memoizes)
  const uniqueCategories = [
    ...new Set(reminders.map((r) => r.category)),
  ] as Category[];

  // Apply both filters in render — no useMemo needed (React Compiler handles it)
  const filteredReminders = reminders.filter((r) => {
    const matchesCategory = selectedCategory === null || r.category === selectedCategory;
    const matchesSearch =
      searchQuery === "" ||
      r.title.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Tray menu → settings bridge. The "Configuración…" item in the tray
  // fires this event (see src-tauri/src/tray.rs::OPEN_SETTINGS_EVENT).
  // The tray handler also shows/focuses the main window first, so by
  // the time we receive it the window is already visible.
  useEffect(() => {
    const unlisten = listen("tray://open-settings", () => {
      setSettingsOpen(true);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  function handleNewReminder() {
    setSheet({ open: true, editingId: null, initialValues: undefined });
  }

  function handleEditReminder(reminder: Reminder) {
    setSheet({
      open: true,
      editingId: reminder.id,
      initialValues: reminderToFormValues(reminder),
    });
  }

  function handleSheetOpenChange(open: boolean) {
    if (!open) setSheet(CLOSED_SHEET);
    else setSheet((prev) => ({ ...prev, open: true }));
  }

  async function handleSubmit(input: CreateReminderInput) {
    if (sheet.editingId !== null) {
      await update(sheet.editingId, input);
    } else {
      await create(input);
    }
    setSheet(CLOSED_SHEET);
  }

  return (
    <main className="flex h-screen flex-col gap-6 overflow-hidden bg-background p-8 text-foreground">
      <Header
        loading={loading}
        onNewReminder={handleNewReminder}
        onRefresh={refresh}
        onClearAll={clearAll}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {lastFired && (
        <FiredBanner reminder={lastFired} onDismiss={dismissLastFired} />
      )}

      {error && <ErrorBanner message={error} />}

      <FilterBar
        uniqueCategories={uniqueCategories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <RemindersList
        reminders={filteredReminders}
        disabled={loading}
        onToggle={toggleActive}
        onEdit={handleEditReminder}
        onDelete={remove}
      />

      <ReminderFormSheet
        open={sheet.open}
        onOpenChange={handleSheetOpenChange}
        {...(sheet.initialValues !== undefined
          ? { initialValues: sheet.initialValues }
          : {})}
        onSubmit={handleSubmit}
      />

      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />

      <Toaster richColors position="bottom-right" />
    </main>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

interface HeaderProps {
  loading: boolean;
  onNewReminder: () => void;
  onRefresh: () => void;
  onClearAll: () => void;
  onOpenSettings: () => void;
}

function Header({
  loading,
  onNewReminder,
  onRefresh,
  onClearAll,
  onOpenSettings,
}: HeaderProps) {
  return (
    <header className="flex flex-col gap-4">
      <div
        className={cn(
          "flex items-center gap-2 self-start rounded-xl border border-border bg-card px-4 py-1.5",
          "font-mono text-[10px] tracking-[0.2em] uppercase text-muted-foreground",
        )}
      >
        <BellRing className="size-3 text-primary" />
        <span>waqyay</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-heading text-4xl font-bold tracking-tight">
          <span>El recordatorio que </span>
          <span className="text-primary">te llama por tu nombre.</span>
        </h1>

        <div className="flex items-center gap-2">
          <Button size="lg" onClick={onNewReminder} disabled={loading}>
            <Plus className="size-4" />
            Nuevo recordatorio
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Recargar"
          >
            <RefreshCcw className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onOpenSettings}
            aria-label="Configuración"
          >
            <Settings className="size-4" />
          </Button>
          <ConfirmDialog
            title="¿Borrar todos los recordatorios?"
            description="Vas a eliminar TODOS los recordatorios de la base. Esta acción no se puede deshacer."
            confirmLabel="Borrar todo"
            destructive
            disabled={loading}
            onConfirm={onClearAll}
          >
            <Button
              size="icon"
              variant="ghost"
              disabled={loading}
              aria-label="Borrar todos"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </ConfirmDialog>
        </div>
      </div>
    </header>
  );
}

function FiredBanner({
  reminder,
  onDismiss,
}: {
  reminder: Reminder;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-sm">
      <div>
        <span className="font-semibold text-primary">🔔 {reminder.title}</span>{" "}
        <span className="text-muted-foreground">
          disparado · #{reminder.id} · próximo: {reminder.next_trigger ?? "—"}
        </span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md p-1 text-muted-foreground hover:bg-primary/20 hover:text-primary"
        aria-label="Cerrar notificación"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

// ─── FilterBar ───────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<Category, string> = {
  general: "General",
  health: "Salud",
  work: "Trabajo",
  study: "Estudio",
  personal: "Personal",
  fitness: "Fitness",
  home: "Hogar",
  finance: "Finanzas",
};

interface FilterBarProps {
  uniqueCategories: Category[];
  selectedCategory: Category | null;
  onSelectCategory: (cat: Category | null) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

function FilterBar({
  uniqueCategories,
  selectedCategory,
  onSelectCategory,
  searchQuery,
  onSearchChange,
}: FilterBarProps) {
  const hasCategories = uniqueCategories.length > 0;

  if (!hasCategories && searchQuery === "") {
    // Render the search bar alone — still useful even without categories
    return (
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          placeholder="Buscar por título…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 text-sm"
          aria-label="Buscar recordatorios"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          placeholder="Buscar por título…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 text-sm"
          aria-label="Buscar recordatorios"
        />
      </div>

      {/* Category chips — only shown when at least one reminder has a category */}
      {hasCategories && (
        <div
          className="flex gap-1.5 overflow-x-auto pb-0.5"
          role="group"
          aria-label="Filtrar por categoría"
        >
          {/* "Todas" chip */}
          <button
            type="button"
            onClick={() => onSelectCategory(null)}
            aria-pressed={selectedCategory === null}
            className={cn(
              "shrink-0 rounded-full px-3 py-0.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              selectedCategory === null
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground",
            )}
          >
            Todas
          </button>

          {uniqueCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onSelectCategory(cat)}
              aria-pressed={selectedCategory === cat}
              className={cn(
                "shrink-0 rounded-full px-3 py-0.5 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                selectedCategory === cat
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
