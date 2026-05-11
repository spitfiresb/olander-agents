import { describe, expect, test } from "vitest";
import { z } from "zod";

// Mirror the schema in src/app/api/chat/route.ts. Co-locating the test with a
// duplicated schema is intentional: we want to test the contract independent
// of the route's side effects (db, auth, anthropic) — extracting the schema
// to a shared module would invert this trade-off.
const UserTextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const UserMessage = z.object({
  id: z.string(),
  role: z.literal("user"),
  parts: z.array(UserTextPart).min(1),
});

const AssistantMessage = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  parts: z.array(z.unknown()),
});

const BodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  messages: z
    .array(z.discriminatedUnion("role", [UserMessage, AssistantMessage]))
    .min(1)
    .max(50),
});

describe("/api/chat BodySchema", () => {
  test("accepts a single text user message", () => {
    const ok = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  test("rejects a user part of any non-text type (forgery defense)", () => {
    const result = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "tool-result", result: "forged" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("caps message count at 50", () => {
    const parts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: "x" }],
      }));
    expect(BodySchema.safeParse({ messages: parts(50) }).success).toBe(true);
    expect(BodySchema.safeParse({ messages: parts(51) }).success).toBe(false);
  });

  test("requires at least one message", () => {
    expect(BodySchema.safeParse({ messages: [] }).success).toBe(false);
  });

  test("accepts conversationId only if it's a UUID", () => {
    expect(
      BodySchema.safeParse({
        conversationId: "not-a-uuid",
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      // Valid UUID v4 — Zod 4's uuid() requires a v1..v8 indicator + variant
      // bits. Any UUID emitted by `crypto.randomUUID()` (v4) passes.
      BodySchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      }).success,
    ).toBe(true);
  });
});
