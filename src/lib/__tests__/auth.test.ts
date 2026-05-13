import { describe, expect, test } from "vitest";
import {
  evaluateTenant,
  normalizeEmail,
  parseBootstrapAdmins,
} from "@/lib/auth-allowlist";

const OLANDER_TID = "00000000-0000-0000-0000-000000000001";

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("  Rep@UOREGON.edu  ")).toBe("rep@uoregon.edu");
  });

  test("is idempotent on an already-normalized address", () => {
    expect(normalizeEmail("rep@example.com")).toBe("rep@example.com");
  });
});

describe("parseBootstrapAdmins", () => {
  test("returns [] for unset / empty / whitespace", () => {
    expect(parseBootstrapAdmins(undefined)).toEqual([]);
    expect(parseBootstrapAdmins(null)).toEqual([]);
    expect(parseBootstrapAdmins("")).toEqual([]);
    expect(parseBootstrapAdmins("   ")).toEqual([]);
  });

  test("splits, normalizes, and drops empty entries", () => {
    expect(parseBootstrapAdmins("A@x.com, b@Y.com ,,  c@z.com ")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });
});

describe("evaluateTenant", () => {
  test("fails closed when the tenant allowlist is empty", () => {
    expect(
      evaluateTenant(
        { tid: OLANDER_TID, email: "rep@example.com" },
        { allowedTenantIds: [] },
      ),
    ).toEqual({ ok: false, email: null });
  });

  test("rejects a wrong tenant id even with a fine email", () => {
    expect(
      evaluateTenant(
        { tid: "wrong-tid", email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toEqual({ ok: false, email: null });
  });

  test("rejects a missing tid claim", () => {
    expect(
      evaluateTenant(
        { email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toEqual({ ok: false, email: null });
  });

  test("rejects a wrong-type tid claim", () => {
    expect(
      evaluateTenant(
        { tid: 12345, email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toEqual({ ok: false, email: null });
  });

  test("rejects a nullish profile", () => {
    expect(
      evaluateTenant(null, { allowedTenantIds: [OLANDER_TID] }),
    ).toEqual({ ok: false, email: null });
  });

  test("rejects the right tenant with a missing or non-string email", () => {
    expect(
      evaluateTenant({ tid: OLANDER_TID }, { allowedTenantIds: [OLANDER_TID] }),
    ).toEqual({ ok: false, email: null });
    expect(
      evaluateTenant(
        { tid: OLANDER_TID, email: 42 },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toEqual({ ok: false, email: null });
  });

  test("accepts the right tenant and returns the normalized email", () => {
    expect(
      evaluateTenant(
        { tid: OLANDER_TID, email: "  Rep@Example.com " },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toEqual({ ok: true, email: "rep@example.com" });
  });

  // evaluateTenant deliberately does NOT check the email domain anymore — the
  // membership lookup in src/auth.ts (the `member` table) is the email gate. A
  // non-Olander address passes this stage; isAllowedMember is what rejects it.
  // Don't "fix" this back into a domain assertion.
  test("does not gate on email domain (membership check does that)", () => {
    expect(
      evaluateTenant(
        { tid: OLANDER_TID, email: "someone@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toEqual({ ok: true, email: "someone@example.com" });
  });
});
