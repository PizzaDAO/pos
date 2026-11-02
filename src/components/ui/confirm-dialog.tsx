/**
 * Accessible confirmation dialog (never `window.confirm`) plus a trash-icon
 * button that asks before running a destructive action. Presentational: the
 * caller still performs the action in `onConfirm`.
 */
"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  destructive = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = React.useId();
  return (
    <Dialog
      onClose={onCancel}
      labelledBy={`${id}-title`}
      placement="center"
    >
      <div
        role="alertdialog"
        className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-xl"
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            className="h-11 px-5"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Trash icon button (44px hit area, named) that confirms before deleting. */
export function ConfirmDeleteButton({
  label,
  detail,
  disabled,
  onConfirm,
  iconClassName = "h-4 w-4",
}: {
  /** What is being deleted, e.g. "Margherita" (used in the name + dialog). */
  label: string;
  /** Consequence text, e.g. "This also removes its 2 items." */
  detail?: string;
  disabled?: boolean;
  onConfirm: () => void | Promise<unknown>;
  iconClassName?: string;
}) {
  const [asking, setAsking] = React.useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={`Delete ${label}`}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        <Trash2
          className={`${iconClassName} text-destructive`}
          aria-hidden="true"
        />
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Delete ${label}?`}
          description={detail ?? "This can't be undone."}
          confirmLabel="Delete"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void onConfirm();
          }}
        />
      )}
    </>
  );
}
