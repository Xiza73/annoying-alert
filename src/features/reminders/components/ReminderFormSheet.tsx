/**
 * Thin wrapper that mounts [`ReminderForm`] inside a shadcn Sheet.
 *
 * The parent controls the open state and passes the submit handler.
 * When `initialValues` is provided, the sheet title/description switch
 * to "edit" copy — otherwise it's a "create" flow. Keeping the distinction
 * at this boundary lets `ReminderForm` stay mode-agnostic.
 */

import { ReminderForm } from "@/features/reminders/components/ReminderForm";
import type { ReminderFormInput } from "@/features/reminders/schemas";
import type { CreateReminderInput } from "@/features/reminders/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";

export interface ReminderFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues?: ReminderFormInput;
  onSubmit: (input: CreateReminderInput) => Promise<void>;
}

export function ReminderFormSheet({
  open,
  onOpenChange,
  initialValues,
  onSubmit,
}: ReminderFormSheetProps) {
  const isEdit = initialValues !== undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border px-4 pt-5 pb-3">
          <SheetTitle className="text-lg">
            {isEdit ? "Editar recordatorio" : "Nuevo recordatorio"}
          </SheetTitle>
          <SheetDescription>
            {isEdit
              ? "Ajustá los campos y guardá. Waqyay recalcula el próximo disparo."
              : "Elegí el tipo, configurá los detalles y dejá que Waqyay te interrumpa."}
          </SheetDescription>
        </SheetHeader>

        <ReminderForm
          {...(initialValues !== undefined ? { initialValues } : {})}
          submitLabel={isEdit ? "Guardar cambios" : "Crear recordatorio"}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
