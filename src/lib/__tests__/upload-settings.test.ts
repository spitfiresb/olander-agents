import { describe, expect, test } from "vitest";
import {
  clampMaxUploadMb,
  DEFAULT_MAX_UPLOAD_MB,
  MAX_MAX_UPLOAD_MB,
  MIN_MAX_UPLOAD_MB,
} from "@/lib/upload-settings";

describe("clampMaxUploadMb", () => {
  test("passes through an in-range whole number", () => {
    expect(clampMaxUploadMb(25)).toBe(25);
    expect(clampMaxUploadMb(MIN_MAX_UPLOAD_MB)).toBe(MIN_MAX_UPLOAD_MB);
    expect(clampMaxUploadMb(MAX_MAX_UPLOAD_MB)).toBe(MAX_MAX_UPLOAD_MB);
  });

  test("clamps below the minimum up to the minimum", () => {
    expect(clampMaxUploadMb(0)).toBe(MIN_MAX_UPLOAD_MB);
    expect(clampMaxUploadMb(-100)).toBe(MIN_MAX_UPLOAD_MB);
  });

  test("clamps above the maximum down to the ceiling", () => {
    expect(clampMaxUploadMb(MAX_MAX_UPLOAD_MB + 1)).toBe(MAX_MAX_UPLOAD_MB);
    expect(clampMaxUploadMb(100_000)).toBe(MAX_MAX_UPLOAD_MB);
  });

  test("floors fractional values", () => {
    expect(clampMaxUploadMb(12.9)).toBe(12);
  });

  test("falls back to the default for non-finite input", () => {
    expect(clampMaxUploadMb(Number.NaN)).toBe(DEFAULT_MAX_UPLOAD_MB);
    expect(clampMaxUploadMb(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_UPLOAD_MB);
  });

  test("bounds are coherent", () => {
    expect(MIN_MAX_UPLOAD_MB).toBeLessThanOrEqual(DEFAULT_MAX_UPLOAD_MB);
    expect(DEFAULT_MAX_UPLOAD_MB).toBeLessThanOrEqual(MAX_MAX_UPLOAD_MB);
  });
});
