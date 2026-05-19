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

export function PaperclipIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M13.5 7.5l-6 6a3.5 3.5 0 1 1-5-5l6-6a2.5 2.5 0 1 1 3.5 3.5l-6 6a1.5 1.5 0 1 1-2-2l5.5-5.5" />
    </svg>
  );
}

// Microphone — capsule head, holder arc, stand, and base bar. Stroke-based
// to match the rest of the composer icon row. The composer's listening state
// swaps the button background (not the glyph) so the symbol stays stable.
export function MicIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="6" y="2" width="4" height="8" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0" />
      <path d="M8 12.5v2" />
      <path d="M5.5 14.5h5" />
    </svg>
  );
}

export function CameraIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M2 5.5h2l1-1.5h6l1 1.5h2v8H2z" />
      <circle cx="8" cy="9" r="2.5" />
    </svg>
  );
}

// Generic document icon — folded-corner page. Used as the fallback for any
// attachment that isn't an image / PDF / spreadsheet.
export function DocumentIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 1.5h6l3.5 3.5v9H3z" />
      <path d="M9 1.5v3.5h3.5" />
    </svg>
  );
}

// Document with a small "PDF" marker — lets the chip read at a glance which
// file kind it is without color (DESIGN.md "no second hue" rule).
export function PdfIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 1.5h6l3.5 3.5v9H3z" />
      <path d="M9 1.5v3.5h3.5" />
      <path d="M5.5 8.5v3M5.5 8.5h1a.8.8 0 0 1 0 1.6h-1" strokeWidth="1.2" />
      <path d="M8.5 8.5v3M8.5 8.5h1.2M8.5 10h1" strokeWidth="1.2" />
    </svg>
  );
}

// Spreadsheet icon — grid lines on a page. For xlsx/xls/csv chips.
export function SpreadsheetIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 1.5h10v13H3z" />
      <path d="M3 5.5h10M3 9.5h10M6.5 5.5v9M9.5 5.5v9" />
    </svg>
  );
}

// Picture frame — used as a fallback for image chips while the thumbnail
// is still loading (or if it fails).
export function ImageIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2 11l3.5-3.5L9 11l2-2 3 3" />
    </svg>
  );
}

// Used while a chip is in the "uploading" state. CSS spin animation is in
// globals.css (animate-spin from Tailwind preset).
export function SpinnerIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={`animate-spin ${className ?? ""}`}
      aria-hidden
    >
      <path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" />
    </svg>
  );
}

// Used in the chip "error" state.
export function AlertIcon({ className }: { className?: string } = {}) {
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
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 5v3.5" />
      <circle cx="8" cy="11" r="0.4" fill="currentColor" />
    </svg>
  );
}

// Trash glyph — three-line lid with a curved bin. Lifted from Sidebar.tsx
// so the chat-header dropdown can use the same icon. Stroke-based to match
// the sidebar/composer vocabulary.
export function TrashIcon({ className }: { className?: string } = {}) {
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
      <path d="M3 4h10" />
      <path d="M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4" />
      <path d="M4 4l1 9.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1L12 4" />
    </svg>
  );
}

// Caret-down for menu triggers. The chat-header dropdown rotates it 180°
// when the menu is open as a subtle state-change affordance.
export function ChevronDownIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3.5 6L8 10.5 12.5 6" />
    </svg>
  );
}

// Down-arrow into a tray — "save to disk." Used on the Export as markdown
// menu item in the chat-header dropdown.
export function DownloadIcon({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8 2v8" />
      <path d="M4.5 7.5L8 11l3.5-3.5" />
      <path d="M2.5 13.5h11" />
    </svg>
  );
}
