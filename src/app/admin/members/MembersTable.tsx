"use client";

import { useMemo, useState, useTransition } from "react";
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
  const busy = isSaving || isRemoving;

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

  function remove(email: string) {
    if (
      !window.confirm(
        `Remove ${email}? They'll be signed out and lose access immediately. You can re-add them by email later.`,
      )
    ) {
      return;
    }
    setError(null);
    setRemovingEmail(email);
    startRemoving(async () => {
      try {
        await removeMemberAction(email);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't remove member.");
      } finally {
        setRemovingEmail(null);
      }
    });
  }

  const canSave = dirty.length > 0 && !busy;

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-brand-canvas/70 text-left text-xs uppercase tracking-wider text-brand-ink-soft">
            <tr>
              <th className="px-3 py-2 font-semibold align-middle">Member</th>
              <th className="px-3 py-2 font-semibold align-middle">Tier</th>
              <th className="px-3 py-1.5 text-right align-middle">
                <span className="sr-only">Actions</span>
                <button
                  type="button"
                  onClick={save}
                  disabled={!canSave}
                  className={`rounded-md px-3 py-1 text-xs font-medium normal-case tracking-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-1 ${
                    canSave
                      ? "bg-brand-red text-white hover:bg-brand-red/90"
                      : "cursor-not-allowed bg-brand-charcoal/10 text-brand-ink-soft"
                  }`}
                >
                  {isSaving ? "Saving…" : "Save changes"}
                </button>
              </th>
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
                      onClick={() => remove(m.email)}
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
    </div>
  );
}
