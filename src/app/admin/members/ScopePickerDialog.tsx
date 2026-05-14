"use client";

import { useEffect, useRef } from "react";
import { type Scope } from "@/lib/scopes";
import { ScopePickerForm } from "./ScopePickerForm";

// Per-member data-access editor. Opened from MembersTable when an admin
// clicks "Data access" on a user row; admin rows skip it (admins bypass the
// scope check). Mirrors the remove-user dialog pattern in MembersTable.tsx —
// native <dialog> for focus trap / Esc-to-close / top-layer rendering, with
// the same .confirm-dialog open/close animation from globals.css.

export type ScopeTarget = {
  email: string;
  label: string;
  // null = "use tier default" (the set flagged defaultForUser in scopes.ts).
  initial: Scope[] | null;
};

export function ScopePickerDialog({
  target,
  onClose,
  onSaved,
}: {
  target: ScopeTarget | null;
  onClose: () => void;
  onSaved: (email: string, scopes: Scope[] | null) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync the dialog's open/close with `target`. The fade-out animation lives
  // in globals.css under .confirm-dialog (@starting-style + allow-discrete)
  // so we don't need to keep inner content mounted during close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (target && !dialog.open) dialog.showModal();
    else if (!target && dialog.open) dialog.close();
  }, [target]);

  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={onDialogClick}
      aria-labelledby="scope-picker-title"
      className="confirm-dialog w-[calc(100%-3rem)] max-w-lg rounded-2xl border border-brand-charcoal/10 bg-white p-6 shadow-2xl"
    >
      {target ? (
        // Keyed remount so the form's local state (picked set, useDefault
        // toggle) resets cleanly whenever a different row is opened.
        <ScopePickerForm
          key={target.email}
          target={target}
          onCancel={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </dialog>
  );
}
