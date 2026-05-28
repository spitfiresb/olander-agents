// Filename-safe slug. Used by the conversation export route to give the
// downloaded markdown a recognizable name (the rep's chat title) instead of
// a UUID. NFKD-then-strip is intentional so accented characters become their
// ASCII equivalents rather than dashes ("Müller" → "muller", not "m-ller").
//
// Caps at 80 chars so a chatty title doesn't produce an unwieldy filename,
// and falls back to an empty string when the input has no alphanumeric
// content — callers can substitute the conversation id then.

// Combining-diacritic range U+0300–U+036F; matches every accent that NFKD
// decomposes off its base letter. The Unicode property escape `\p{M}` would
// be more idiomatic but requires the `u` flag — sticking with explicit hex
// for transparency.
const DIACRITICS = /[̀-ͯ]/g;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
