export function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13.5 13.5" />
    </svg>
  );
}

// Tilted thumbtack — reads as "pinned to the top." Stroke-based to match the
// rest of the sidebar's icon vocabulary. `filled` swaps to a solid head so
// pinned rows show a more emphatic glyph than the hover-state pin button.
export function PinIcon({
  filled = false,
  className,
}: { filled?: boolean; className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path
        d="M9.5 1.5l5 5-1.8 1.2-3.4-.6-2.8 2.8.7 2-1.1 1.1-5-5 1.1-1.1 2 .7 2.8-2.8-.6-3.4z"
        fill={filled ? "currentColor" : "none"}
      />
      <path d="M5.8 10.2l-3.3 3.3" />
    </svg>
  );
}

export function PencilIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M11.5 2.5l2 2-8 8h-2v-2z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

export function HamburgerIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

export function CloseIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
