import { excelBufferToCsv } from "@/lib/excel";
import {
  DOCX_MIME,
  PPTX_MIME,
  docxBufferToText,
  pptxBufferToText,
} from "@/lib/office";

// Unified plain-text extraction for reference documents the model will search
// via RAG. Reuses the converters added for chat attachments (mammoth/fflate/
// xlsx) and adds PDF text extraction via unpdf (serverless-friendly, no native
// deps). Images are intentionally NOT supported — they have no extractable
// text without OCR (a future addition).

export const PDF_MIME = "application/pdf";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const XLS_MIME = "application/vnd.ms-excel";
const TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
]);

// MIME types an admin may upload to the reference-document library.
export const REFERENCE_DOC_MIMES: readonly string[] = [
  PDF_MIME,
  DOCX_MIME,
  PPTX_MIME,
  XLSX_MIME,
  XLS_MIME,
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
];

export function isReferenceDocMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return REFERENCE_DOC_MIMES.includes(mime.toLowerCase());
}

function toUint8(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

async function pdfBufferToText(
  buffer: ArrayBuffer | Uint8Array,
): Promise<string> {
  // Lazy import — unpdf is ESM and only needed on the ingest path, never on the
  // chat hot path.
  const { extractText, getDocumentProxy } = await import("unpdf");
  // unpdf/pdf.js explicitly rejects a Node Buffer (which is a Uint8Array
  // subclass) and demands a plain Uint8Array, so always copy into one —
  // `toUint8` would otherwise pass a Buffer straight through.
  const u8 =
    buffer instanceof Uint8Array
      ? Uint8Array.from(buffer)
      : new Uint8Array(buffer);
  const pdf = await getDocumentProxy(u8);
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  return merged.trim();
}

// Extract plain text from a supported document buffer. Throws
// `unsupported_reference_mime:<mime>` for anything not in REFERENCE_DOC_MIMES.
export async function extractTextFromBuffer(
  buffer: ArrayBuffer | Uint8Array,
  mediaType: string,
): Promise<string> {
  const mime = (mediaType || "").toLowerCase();
  if (mime === PDF_MIME) return pdfBufferToText(buffer);
  if (mime === DOCX_MIME) return docxBufferToText(buffer);
  if (mime === PPTX_MIME) return pptxBufferToText(buffer);
  if (mime === XLSX_MIME || mime === XLS_MIME) return excelBufferToCsv(buffer);
  if (TEXT_MIMES.has(mime)) {
    return new TextDecoder("utf-8").decode(toUint8(buffer)).trim();
  }
  throw new Error(`unsupported_reference_mime:${mime}`);
}

export async function fetchAndExtractText(
  url: string,
  mediaType: string,
): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`doc_fetch_failed:${resp.status}`);
  }
  const buffer = await resp.arrayBuffer();
  return extractTextFromBuffer(buffer, mediaType);
}
