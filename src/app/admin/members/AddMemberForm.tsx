"use client";

import { useRef, useState, useTransition } from "react";
import { addMemberAction } from "./actions";
import { TierDropdown, type Tier } from "./TierDropdown";

export function AddMemberForm() {
  const [role, setRole] = useState<Tier>("user");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await addMemberAction(formData);
        formRef.current?.reset();
        setRole("user");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't add member.");
      }
    });
  }

  return (
    <div>
      <form
        ref={formRef}
        action={onSubmit}
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-brand-charcoal/10 bg-white p-5"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-brand-ink-soft">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="off"
            placeholder="name@company.com"
            className="w-72 rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm text-brand-charcoal placeholder:text-brand-ink-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-brand-ink-soft">Tier</span>
          <TierDropdown value={role} onChange={setRole} name="role" disabled={pending} />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-red px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add member"}
        </button>
      </form>
      {error ? <p className="mt-2 text-sm text-brand-red">{error}</p> : null}
    </div>
  );
}
