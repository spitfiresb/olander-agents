"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

// Two surfaces share this component: the sidebar row (charcoal bg, white
// text) and the chat header (canvas bg, charcoal text). The variant switch
// keeps both surface styles in one place so a future tweak to the rename
// affordance lands everywhere at once.
type Variant = "sidebar" | "canvas";

const variantClasses: Record<Variant, string> = {
  sidebar:
    "block w-full rounded-md border border-white/40 bg-white/10 py-1.5 pl-2 pr-2 text-sm text-white outline-none focus:border-white/60 disabled:opacity-50",
  canvas:
    "block w-full rounded-md border border-brand-charcoal/30 bg-white py-1 px-2 text-sm text-brand-charcoal outline-none focus:border-brand-red/40 disabled:opacity-50",
};

type Props = {
  initial: string;
  onCommit: (next: string) => Promise<void> | void;
  onCancel: () => void;
  variant?: Variant;
};

export function RenameInput({ initial, onCommit, onCancel, variant = "sidebar" }: Props) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus + select-all when entering edit mode so typing replaces the
    // existing title cleanly. setState-in-effect is intentional via ref-focus.
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onCommit(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="block">
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          // Treat blur as commit-on-change, cancel-on-no-change so a
          // distracted user doesn't lose their edit by clicking away.
          if (value.trim() && value !== initial) {
            void onCommit(value);
          } else {
            onCancel();
          }
        }}
        disabled={saving}
        maxLength={120}
        className={variantClasses[variant]}
      />
    </form>
  );
}
