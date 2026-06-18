// Split extracted document text into retrieval-sized chunks. Paragraph-aware:
// packs whole paragraphs into windows up to maxChars, and only hard-splits a
// single paragraph that's bigger than the window (with overlap, so a fact that
// straddles the split isn't lost). Char-based rather than token-based to stay
// dependency-free; ~1500 chars ≈ 350-450 tokens, comfortably inside Voyage's
// per-input limit while keeping each chunk topically tight.

export type DocChunk = { index: number; text: string };

export const DEFAULT_MAX_CHARS = 1500;
export const DEFAULT_OVERLAP_CHARS = 150;
// Backstop against a pathologically large document producing a runaway number
// of embed calls + Qdrant points. Callers should log when this trips.
export const MAX_CHUNKS = 6000;

export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): DocChunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const overlap = Math.min(
    opts.overlapChars ?? DEFAULT_OVERLAP_CHARS,
    Math.floor(maxChars / 2),
  );

  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // Paragraph alone exceeds the window — flush what we have, then hard-split
      // it with overlap so we don't drop a boundary-straddling fact.
      flush();
      const step = Math.max(1, maxChars - overlap);
      for (let i = 0; i < para.length; i += step) {
        chunks.push(para.slice(i, i + maxChars));
        if (i + maxChars >= para.length) break;
      }
      continue;
    }
    const joinedLen = current ? current.length + 2 + para.length : para.length;
    if (joinedLen > maxChars) {
      flush();
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  flush();

  return chunks
    .slice(0, MAX_CHUNKS)
    .map((text, index) => ({ index, text }));
}
