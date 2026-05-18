// Shown instantly while an /admin* page server-renders (it does `await auth()`
// — a Neon round-trip — plus its own data query). A thin gray halo with a
// charcoal arc sweeping around it.
export default function AdminLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-brand-canvas">
      <svg
        viewBox="0 0 24 24"
        className="h-10 w-10 text-brand-charcoal animate-spin motion-reduce:animate-none"
        role="status"
        aria-label="Loading"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeOpacity="0.15"
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray="16 100"
        />
      </svg>
    </div>
  );
}
