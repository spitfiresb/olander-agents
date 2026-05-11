import { describe, expect, test } from "vitest";
import { isSameOrigin } from "@/lib/csrf";

function h(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("isSameOrigin", () => {
  test("matches Origin host to Host", () => {
    expect(
      isSameOrigin(h({ host: "<app-host>", origin: "https://<app-host>" })),
    ).toBe(true);
  });

  test("rejects different host", () => {
    expect(
      isSameOrigin(h({ host: "<app-host>", origin: "https://evil.com" })),
    ).toBe(false);
  });

  test("falls back to Referer when Origin missing", () => {
    expect(
      isSameOrigin(
        h({ host: "<app-host>", referer: "https://<app-host>/chat" }),
      ),
    ).toBe(true);
    expect(
      isSameOrigin(h({ host: "<app-host>", referer: "https://evil.com/x" })),
    ).toBe(false);
  });

  test("allows when neither Origin nor Referer is present (same-origin or s2s)", () => {
    expect(isSameOrigin(h({ host: "<app-host>" }))).toBe(true);
  });

  test("rejects when Host header is missing", () => {
    expect(isSameOrigin(h({ origin: "https://<app-host>" }))).toBe(false);
  });

  test("rejects when source is not a parseable URL", () => {
    expect(
      isSameOrigin(h({ host: "<app-host>", origin: "not-a-url" })),
    ).toBe(false);
  });

  test("host comparison includes port", () => {
    expect(
      isSameOrigin(h({ host: "localhost:3000", origin: "http://localhost:3000" })),
    ).toBe(true);
    expect(
      isSameOrigin(h({ host: "localhost:3000", origin: "http://localhost:4000" })),
    ).toBe(false);
  });
});
