"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { removeMemberAction, setTiersAction } from "./actions";
import { TierDropdown, type Tier } from "./TierDropdown";

type Member = { email: string; name: string | null; role: Tier };

export function MembersTable({
  members,
  myEmail,
}: {
  members: Member[];
  myEmail: string | null;
}) {
  const serverRole = useMemo(
    () => new Map(members.map((m) => [m.email, m.role])),
    [members],
  );
  // Pending (toggled-but-not-saved) tiers, by email. An entry that matches the
  // current server value — including after a save lands — counts as not-dirty.
  const [pending, setPending] = useState<Record<string, Tier>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  const [isRemoving, startRemoving] = useTransition();
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  // Set when the user clicks "Remove user" on a row. The modal opens and
  // gates the actual server call behind an explicit Confirm click.
  const [pendingRemoval, setPendingRemovalRaw] = useState<
    { email: string; label: string } | null
  >(null);
  // Mirrors pendingRemoval but clears on a delay matching the dialog close
  // animation, so the label keeps rendering while the dialog fades out.
  // Always updated via setPendingRemoval (below) — never directly.
  const [displayedRemoval, setDisplayedRemoval] = useState<
    { email: string; label: string } | null
  >(null);
  const clearDisplayedTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busy = isSaving || isRemoving;

  // Single update path so every change to pendingRemoval also keeps
  // displayedRemoval in sync — immediate on open, delayed on close. All
  // call-sites use this instead of setPendingRemovalRaw.
  function setPendingRemoval(value: { email: string; label: string } | null) {
    if (clearDisplayedTimerRef.current !== null) {
      window.clearTimeout(clearDisplayedTimerRef.current);
      clearDisplayedTimerRef.current = null;
    }
    if (value) {
      setDisplayedRemoval(value);
    } else {
      clearDisplayedTimerRef.current = window.setTimeout(() => {
        setDisplayedRemoval(null);
        clearDisplayedTimerRef.current = null;
      }, 220);
    }
    setPendingRemovalRaw(value);
  }

  // Cancel the pending displayed-clear timer if the component unmounts
  // (e.g. user navigates away mid-close-animation).
  useEffect(() => {
    return () => {
      if (clearDisplayedTimerRef.current !== null) {
        window.clearTimeout(clearDisplayedTimerRef.current);
      }
    };
  }, []);

  // Drive the native <dialog> open/close from React state. `showModal()`
  // puts the dialog in the browser's top layer (above everything, ignores
  // z-index), traps focus, and wires up Esc-to-close for us. Centering +
  // entry/exit animation live in globals.css under `.confirm-dialog`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pendingRemoval && !dialog.open) {
      dialog.showModal();
    } else if (!pendingRemoval && dialog.open) {
      dialog.close();
    }
  }, [pendingRemoval]);

  const dirty = useMemo(() => {
    const out: { email: string; role: Tier }[] = [];
    for (const [email, role] of Object.entries(pending)) {
      const server = serverRole.get(email);
      if (server !== undefined && server !== role) out.push({ email, role });
    }
    return out;
  }, [pending, serverRole]);

  function setRowTier(email: string, t: Tier) {
    setError(null);
    setPending((p) => {
      const next = { ...p };
      if (serverRole.get(email) === t) delete next[email];
      else next[email] = t;
      return next;
    });
  }

  function save() {
    if (dirty.length === 0) return;
    setError(null);
    startSaving(async () => {
      try {
        await setTiersAction(dirty);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save changes.");
      }
    });
  }

  function requestRemoval(email: string, label: string) {
    if (busy) return;
    setError(null);
    setPendingRemoval({ email, label });
  }

  function confirmRemoval() {
    if (!pendingRemoval) return;
    const email = pendingRemoval.email;
    setError(null);
    setRemovingEmail(email);
    startRemoving(async () => {
      try {
        await removeMemberAction(email);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't remove member.");
      } finally {
        setRemovingEmail(null);
        setPendingRemoval(null);
      }
    });
  }

  // Clicking the dialog backdrop (the dimmed area outside the card) lands
  // on the <dialog> element itself, not its inner content. Use that to
  // dismiss — but never mid-removal, since that would leave the user with
  // a "Removing…" toast and no way to see the outcome land in the table.
  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (isRemoving) return;
    if (e.target === dialogRef.current) setPendingRemoval(null);
  }

  const canSave = dirty.length > 0 && !busy;

  return (
    <div>
      {/* Save button lives outside the table card, above it, right-aligned.
          Visible column headers were removed entirely — kept in
          <thead className="sr-only"> so screen readers still get column
          context when navigating the cells. */}
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-1 ${
            canSave
              ? "bg-brand-red text-white hover:bg-brand-red/90"
              : "cursor-not-allowed bg-brand-charcoal/10 text-brand-ink-soft"
          }`}
        >
          {isSaving ? "Saving…" : "Save changes"}
        </button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead className="sr-only">
            <tr>
              <th>Member</th>
              <th>Tier</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => {
              const isSelf = myEmail != null && myEmail === m.email;
              const tier = pending[m.email] ?? m.role;
              const rowRemoving = isRemoving && removingEmail === m.email;
              return (
                <tr
                  key={m.email}
                  className={i % 2 === 0 ? "bg-white" : "bg-brand-canvas/40"}
                >
                  <td className="px-3 py-2 align-middle">
                    <div className="text-brand-charcoal">
                      {m.name ?? m.email}
                      {isSelf ? (
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-brand-ink-soft">
                          you
                        </span>
                      ) : null}
                    </div>
                    {m.name ? (
                      <div className="font-mono text-[12px] text-brand-ink-soft">
                        {m.email}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <TierDropdown
                      value={tier}
                      onChange={(t) => setRowTier(m.email, t)}
                      disabled={isSelf || busy}
                    />
                  </td>
                  <td className="px-3 py-2 text-right align-middle">
                    <button
                      type="button"
                      onClick={() => requestRemoval(m.email, m.name ?? m.email)}
                      disabled={isSelf || busy}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-brand-red transition-colors hover:bg-brand-red/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      {rowRemoving ? "Removing…" : "Remove user"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-6 text-center text-sm text-brand-ink-soft"
                >
                  No members yet. Add one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {error ? <p className="mt-2 text-sm text-brand-red">{error}</p> : null}

      {/* Confirm-removal modal. Always in the DOM; visibility driven by
          showModal()/close() in the useEffect above. The native <dialog>
          gives us focus trap, Esc-to-close, and top-layer rendering for
          free. Centering + open/close animations are in globals.css under
          the .confirm-dialog class — using @starting-style + allow-discrete
          so the dialog can transition in AND out of display:none. */}
      <dialog
        ref={dialogRef}
        onClose={() => setPendingRemoval(null)}
        onClick={onDialogClick}
        aria-labelledby="remove-member-title"
        className="confirm-dialog w-[calc(100%-3rem)] max-w-md rounded-2xl border border-brand-charcoal/10 bg-white p-6 shadow-2xl"
      >
        {displayedRemoval ? (
          <div>
            <h2
              id="remove-member-title"
              className="text-base font-semibold text-brand-charcoal"
            >
              Remove this user?
            </h2>
            <p className="mt-2 text-sm text-brand-ink-soft">
              <span className="font-medium text-brand-charcoal">
                {displayedRemoval.label}
              </span>{" "}
              will be signed out and lose access immediately. You can re-add
              them by email later.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRemoval(null)}
                disabled={isRemoving}
                className="rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-charcoal/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-charcoal/30 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRemoval}
                disabled={isRemoving}
                autoFocus
                className="rounded-md bg-brand-red px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRemoving ? "Removing…" : "Remove user"}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
