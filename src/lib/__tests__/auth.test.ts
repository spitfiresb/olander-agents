import { describe, expect, test } from "vitest";
import { isAllowedDomain, evaluateSignIn } from "@/lib/auth-allowlist";

const OLANDER_TID = "00000000-0000-0000-0000-000000000001";

describe("isAllowedDomain", () => {
  test("accepts olander.com", () => {
    expect(isAllowedDomain("rep@example.com")).toBe(true);
  });

  test("rejects unknown domains", () => {
    expect(isAllowedDomain("rep@example.com")).toBe(false);
    expect(isAllowedDomain("rep@example.co")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(isAllowedDomain("Rep@EXAMPLE.COM")).toBe(true);
  });

  test("rejects empty / nullish", () => {
    expect(isAllowedDomain(null)).toBe(false);
    expect(isAllowedDomain(undefined)).toBe(false);
    expect(isAllowedDomain("")).toBe(false);
  });

  test("does not accept substring matches without @", () => {
    expect(isAllowedDomain("reolander.com")).toBe(false);
  });
});

describe("evaluateSignIn", () => {
  test("rejects when tenant allowlist is empty (fail closed)", () => {
    expect(
      evaluateSignIn(
        { tid: OLANDER_TID, email: "rep@example.com" },
        { allowedTenantIds: [] },
      ),
    ).toBe(false);
  });

  test("rejects when tenant id is wrong", () => {
    expect(
      evaluateSignIn(
        { tid: "wrong-tid", email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toBe(false);
  });

  test("rejects right tenant but wrong domain (spoofed email)", () => {
    expect(
      evaluateSignIn(
        { tid: OLANDER_TID, email: "spoof@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toBe(false);
  });

  test("accepts right tenant + right domain", () => {
    expect(
      evaluateSignIn(
        { tid: OLANDER_TID, email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toBe(true);
  });

  test("rejects when tid claim is missing", () => {
    expect(
      evaluateSignIn(
        { email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toBe(false);
  });

  test("rejects when tid claim is the wrong type", () => {
    expect(
      evaluateSignIn(
        { tid: 12345, email: "rep@example.com" },
        { allowedTenantIds: [OLANDER_TID] },
      ),
    ).toBe(false);
  });

  test("rejects nullish profile", () => {
    expect(
      evaluateSignIn(null, { allowedTenantIds: [OLANDER_TID] }),
    ).toBe(false);
  });
});
