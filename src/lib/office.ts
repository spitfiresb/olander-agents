import mammoth from "mammoth";
import { strFromU8, unzipSync } from "fflate";

// Server-side text extraction for Office documents the model can't read
// natively. Mirrors the Excel→CSV path (src/lib/excel.ts): the chat route
// fetches the uploaded blob, extracts plain text, and synthesizes a text part
// for the model. The original blob URL stays in message.parts so the rep can
// still download the source file from their chip.
//
//   .docx → mammoth (battle-tested raw-text extraction).
//   .pptx → minimal OOXML slide-text extraction via fflate (no maintained
//           single-purpose lib exists; .pptx isn't among the docs reps upload
//           today, so a lighter-touch extractor is the right trade).
//
// Both degrade gracefully: extraction failures throw and the caller (the chat
// route) swaps in a "couldn't read this file" note rather than crashing the
// turn — same stance as the Excel path's catch.

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function isOfficeDocMimeType(mime: string | undefined | null): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return m === DOCX_MIME || m === PPTX_MIME;
}

// Decode the five predefined XML entities + numeric character references.
// `&amp;` is decoded LAST so an escaped entity like `&amp;lt;` round-trips to
// the literal text `&lt;` rather than being double-decoded to `<`.
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function toBuffer(buffer: ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(buffer)) return buffer;
  return Buffer.from(
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
  );
}

export async function docxBufferToText(
  buffer: ArrayBuffer | Uint8Array,
): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: toBuffer(buffer) });
  return value.trim();
}

function slideNumber(path: string): number {
  const m = path.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

export function pptxBufferToText(buffer: ArrayBuffer | Uint8Array): string {
  const data =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = unzipSync(data);
  // Slide parts are ppt/slides/slide1.xml, slide2.xml, … — sort numerically
  // so slide10 follows slide9 rather than slide1 (lexicographic order).
  const slidePaths = Object.keys(files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const blocks: string[] = [];
  slidePaths.forEach((path, i) => {
    const xml = strFromU8(files[path]);
    const lines: string[] = [];
    // Each <a:p>…</a:p> is a paragraph; concatenate its <a:t>…</a:t> run texts.
    for (const para of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const runs = [...para.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
        decodeXmlEntities(m[1]),
      );
      const line = runs.join("").trim();
      if (line) lines.push(line);
    }
    if (lines.length) {
      blocks.push(`--- Slide ${i + 1} ---\n${lines.join("\n")}`);
    }
  });
  return blocks.join("\n\n").trim();
}

export async function fetchAndConvertOffice(
  url: string,
  mediaType: string,
): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`office_fetch_failed:${resp.status}`);
  }
  const buffer = await resp.arrayBuffer();
  if (mediaType.toLowerCase() === PPTX_MIME) {
    return pptxBufferToText(buffer);
  }
  return docxBufferToText(buffer);
}
