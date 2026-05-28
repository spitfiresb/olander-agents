import { del, put } from "@vercel/blob";

// Per-user, per-message chat attachments. Stored under a userId-prefixed
// path so the URL itself is the ownership gate at runtime: the chat route
// rejects a request whose UserFilePart.url isn't prefixed with the caller's
// own chat-attachments/{userId}/. Phase-1 doc-management lives elsewhere;
// see CLAUDE.local.md "My scope" for the namespacing decision.

export const ATTACHMENT_PREFIX = "chat-attachments";
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_FILENAME_LEN = 160;

const ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
]);

export type UploadedAttachment = {
  url: string;
  pathname: string;
  mediaType: string;
  size: number;
  filename: string;
};

export function isAllowedMimeType(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return ALLOWED_MIME.has(mime.toLowerCase());
}

export function isExcelMimeType(mime: string | undefined | null): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel"
  );
}

// Strip path-traversal and special chars. Keeps alphanumerics, dot, dash,
// underscore — enough for filenames the user will recognize in chips, none
// of the surprise characters that would break URL paths or shell quoting.
export function sanitizeFilename(name: string): string {
  const stripped = name.replace(/[^A-Za-z0-9._-]/g, "-");
  return stripped.slice(0, MAX_FILENAME_LEN) || "file";
}

// SSRF-defense + ownership gate. The chat route receives URLs from the
// client and turns around to fetch them server-side (Excel→CSV path); a
// non-Vercel-Blob host or another user's prefix must be rejected before
// the fetch lands.
export function ownsAttachmentUrl(url: string, userId: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!u.hostname.endsWith(".public.blob.vercel-storage.com")) return false;
  return u.pathname.startsWith(`/${ATTACHMENT_PREFIX}/${userId}/`);
}

export async function uploadAttachment(
  file: File,
  userId: string,
): Promise<UploadedAttachment> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("file_too_large");
  }
  if (!isAllowedMimeType(file.type)) {
    throw new Error("unsupported_mime");
  }
  const sanitized = sanitizeFilename(file.name);
  const uuid = crypto.randomUUID();
  const pathname = `${ATTACHMENT_PREFIX}/${userId}/${uuid}-${sanitized}`;
  const blob = await put(pathname, file, {
    access: "public",
    addRandomSuffix: false,
    contentType: file.type,
  });
  return {
    url: blob.url,
    pathname: blob.pathname,
    mediaType: file.type,
    size: file.size,
    filename: file.name,
  };
}

// Only deletes blobs that live under the caller's own prefix. The chat
// composer calls this when the user removes a chip before sending.
export async function deleteAttachment(
  pathname: string,
  userId: string,
): Promise<void> {
  if (!pathname.startsWith(`${ATTACHMENT_PREFIX}/${userId}/`)) {
    throw new Error("forbidden");
  }
  await del(pathname);
}
