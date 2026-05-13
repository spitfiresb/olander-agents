import { describe, expect, test } from "vitest";
import {
  isAllowedMimeType,
  isExcelMimeType,
  ownsAttachmentUrl,
  sanitizeFilename,
} from "@/lib/blob";

describe("isAllowedMimeType", () => {
  test("accepts the documented supported types", () => {
    expect(isAllowedMimeType("image/png")).toBe(true);
    expect(isAllowedMimeType("image/jpeg")).toBe(true);
    expect(isAllowedMimeType("image/webp")).toBe(true);
    expect(isAllowedMimeType("image/gif")).toBe(true);
    expect(isAllowedMimeType("application/pdf")).toBe(true);
    expect(isAllowedMimeType("text/csv")).toBe(true);
    expect(isAllowedMimeType("text/plain")).toBe(true);
    expect(
      isAllowedMimeType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
  });

  test("rejects unsupported types", () => {
    expect(isAllowedMimeType("application/zip")).toBe(false);
    expect(isAllowedMimeType("video/mp4")).toBe(false);
    expect(isAllowedMimeType("application/x-msdownload")).toBe(false);
  });

  test("rejects falsy input", () => {
    expect(isAllowedMimeType("")).toBe(false);
    expect(isAllowedMimeType(undefined)).toBe(false);
    expect(isAllowedMimeType(null)).toBe(false);
  });
});

describe("isExcelMimeType", () => {
  test("matches xlsx + legacy xls", () => {
    expect(
      isExcelMimeType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
    expect(isExcelMimeType("application/vnd.ms-excel")).toBe(true);
  });

  test("does not match plain text-like CSVs", () => {
    expect(isExcelMimeType("text/csv")).toBe(false);
    expect(isExcelMimeType("text/plain")).toBe(false);
    expect(isExcelMimeType("application/pdf")).toBe(false);
  });
});

describe("ownsAttachmentUrl", () => {
  const ownUrl =
    "https://abc123.public.blob.vercel-storage.com/chat-attachments/user-abc/uuid-doc.pdf";
  const otherUserUrl =
    "https://abc123.public.blob.vercel-storage.com/chat-attachments/user-xyz/uuid-doc.pdf";
  const wrongPrefixUrl =
    "https://abc123.public.blob.vercel-storage.com/random/user-abc/foo.pdf";
  const wrongHostUrl =
    "https://evil.example.com/chat-attachments/user-abc/uuid-doc.pdf";

  test("accepts the caller's own prefix on a Vercel Blob host", () => {
    expect(ownsAttachmentUrl(ownUrl, "user-abc")).toBe(true);
  });

  test("rejects another user's prefix", () => {
    expect(ownsAttachmentUrl(otherUserUrl, "user-abc")).toBe(false);
  });

  test("rejects a URL that doesn't start with the chat-attachments prefix", () => {
    expect(ownsAttachmentUrl(wrongPrefixUrl, "user-abc")).toBe(false);
  });

  test("rejects a non-Vercel-Blob host (SSRF gate)", () => {
    expect(ownsAttachmentUrl(wrongHostUrl, "user-abc")).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(ownsAttachmentUrl("not a url", "user-abc")).toBe(false);
    expect(ownsAttachmentUrl("", "user-abc")).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  test("preserves alphanumerics, dot, dash, underscore", () => {
    expect(sanitizeFilename("parts_list-v2.xlsx")).toBe("parts_list-v2.xlsx");
  });

  test("replaces spaces and special chars with dashes", () => {
    expect(sanitizeFilename("foo bar/baz?.xlsx")).toBe("foo-bar-baz-.xlsx");
  });

  test("strips path traversal slashes (dots are kept since extensions need them)", () => {
    // Dots survive — filename.ext needs them. Slashes don't, so a path
    // like ../../etc/passwd becomes ..-..-etc-passwd: harmless as a flat name.
    expect(sanitizeFilename("../../etc/passwd")).toBe("..-..-etc-passwd");
  });

  test("replaces unicode", () => {
    expect(sanitizeFilename("café.pdf")).toBe("caf-.pdf");
  });

  test("falls back to 'file' for an empty result", () => {
    expect(sanitizeFilename("")).toBe("file");
  });

  test("clamps overly long names", () => {
    const long = "a".repeat(500) + ".pdf";
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(160);
  });
});
