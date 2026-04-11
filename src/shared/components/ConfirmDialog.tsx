/**
 * Reusable confirmation dialog built on top of shadcn `AlertDialog`.
 *
 * Wrap any trigger element as a child and pass `onConfirm` — the dialog
 * handles open state internally. Use `destructive` for delete flows so
 * the confirm button gets the destructive variant.
 *
 * Example:
 *   <ConfirmDialog
 *     title="¿Borrar recordatorio?"
 *     description="Esta acción no se puede deshacer."
 *     confirmLabel="Borrar"
 *     destructive
 *     onConfirm={() => remove(id)}
 *   >
 *     <Button size="icon" variant="ghost"><Trash2 /></Button>
 *   </ConfirmDialog>
 */

import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/components/ui/alert-dialog";

export interface ConfirmDialogProps {
  children: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  children,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = false,
  disabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild disabled={disabled}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              void onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
