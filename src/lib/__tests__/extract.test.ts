import { describe, expect, test } from "vitest";
import {
  extractTextFromBuffer,
  isReferenceDocMime,
  PDF_MIME,
  XLS_MIME,
  XLSX_MIME,
} from "@/lib/extract";

const enc = (s: string) => new TextEncoder().encode(s);

describe("isReferenceDocMime", () => {
  test("accepts the supported reference types", () => {
    for (const m of [
      PDF_MIME,
      XLSX_MIME,
      XLS_MIME,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
      "text/csv",
      "text/tab-separated-values",
    ]) {
      expect(isReferenceDocMime(m)).toBe(true);
    }
  });

  test("rejects images, archives, and falsy input", () => {
    expect(isReferenceDocMime("image/png")).toBe(false);
    expect(isReferenceDocMime("application/zip")).toBe(false);
    expect(isReferenceDocMime(undefined)).toBe(false);
    expect(isReferenceDocMime(null)).toBe(false);
    expect(isReferenceDocMime("")).toBe(false);
  });
});

describe("extractTextFromBuffer", () => {
  test("decodes plain text", async () => {
    const res = await extractTextFromBuffer(enc("hello world\n"), "text/plain");
    expect(res).toEqual({ text: "hello world", pageCount: null });
  });

  test("returns CSV content as text", async () => {
    const csv = "name,qty\nbolt,10";
    const res = await extractTextFromBuffer(enc(csv), "text/csv");
    expect(res).toEqual({ text: csv, pageCount: null });
  });

  test("is case-insensitive on the MIME type", async () => {
    const res = await extractTextFromBuffer(enc("hi"), "TEXT/PLAIN");
    expect(res).toEqual({ text: "hi", pageCount: null });
  });

  test("throws for an unsupported MIME type", async () => {
    await expect(
      extractTextFromBuffer(enc("x"), "image/png"),
    ).rejects.toThrow(/unsupported_reference_mime/);
  });
});
