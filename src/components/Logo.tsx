// SANITIZED FOR PUBLIC RELEASE
//
// The shipped component drew the client's registered wordmark as traced SVG
// paths. That is their trademark, so it is not published here. This stand-in
// keeps the same props, viewBox, and brand-red field, and sets the name in a
// generic sans-serif instead of the protected letterforms — so every consumer
// (Wordmark, TopRightLogo, EmptyState, /status) lays out unchanged.

const HEIGHT_CLASS: Record<"xs" | "sm" | "md" | "lg", string> = {
  xs: "h-6",
  sm: "h-8",
  md: "h-16",
  lg: "h-24",
};

export function Logo({
  size = "sm",
  className,
}: {
  size?: keyof typeof HEIGHT_CLASS;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 150 51.2"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Olander"
      className={`w-auto select-none ${className ?? HEIGHT_CLASS[size]}`}
    >
      <rect width="150" height="51" fill="var(--color-brand-red)" />
      <text
        x="75"
        y="25.5"
        fill="#FFFFFF"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="20"
        fontWeight="600"
        letterSpacing="1.5"
      >
        OLANDER
      </text>
    </svg>
  );
}
