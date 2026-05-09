import { Logo } from "./Logo";

type WordmarkVariant = "hero" | "topbar";

export function Wordmark({ variant = "topbar" }: { variant?: WordmarkVariant }) {
  if (variant === "hero") {
    return (
      <div className="flex items-center gap-2 sm:gap-3">
        <Logo className="h-14 sm:h-24" />
        <span className="text-2xl font-medium text-brand-charcoal sm:text-3xl">
          Agents
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      <Logo size="sm" />
      <span className="text-base font-medium text-white">Agents</span>
    </div>
  );
}
