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

const ALLOWED_FILE_MIME_RE =
  /^(image\/(png|jpe?g|webp|gif)|application\/pdf|text\/(plain|csv|tab-separated-values)|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel)$/;

const UserFilePart = z.object({
  type: z.literal("file"),
  mediaType: z
    .string()
    .max(128)
    .regex(ALLOWED_FILE_MIME_RE, "unsupported mediaType"),
  url: z.string().url().max(1024),
  filename: z.string().max(255),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(10 * 1024 * 1024)
    .optional(),
});

const UserMessage = z.object({
  id: z.string(),
  role: z.literal("user"),
  parts: z
    .array(z.discriminatedUnion("type", [UserTextPart, UserFilePart]))
    .min(1),
});

const AssistantMessage = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  parts: z.array(z.unknown()),
});

const BodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  // Mirror of route.ts — any short non-empty string, not strictly UUID, so
  // the SDK's base64-ish client ids pass the same as drizzle's DB UUIDs.
  editedMessageId: z.string().min(1).max(128).optional(),
  messages: z
    .array(z.discriminatedUnion("role", [UserMessage, AssistantMessage]))
    .min(1)
    .max(50),
});

const sampleFilePart = {
  type: "file" as const,
  mediaType: "application/pdf",
  url: "https://abc.public.blob.vercel-storage.com/chat-attachments/u/uuid-q.pdf",
  filename: "quote.pdf",
};

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

  test("accepts a user message with a text part and a file part", () => {
    const ok = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [
            { type: "text", text: "Check stock on these" },
            sampleFilePart,
          ],
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  test("rejects a user part of any non-text/non-file type (forgery defense)", () => {
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

  test("rejects a file part with an unsupported mediaType", () => {
    const result = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ ...sampleFilePart, mediaType: "application/zip" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a file part smuggling a text/* subtype not on the allowlist", () => {
    const result = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ ...sampleFilePart, mediaType: "text/html" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a file part with a malformed URL", () => {
    const result = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ ...sampleFilePart, url: "not-a-url" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a file part exceeding the 10MB size cap", () => {
    const result = BodySchema.safeParse({
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ ...sampleFilePart, size: 11 * 1024 * 1024 }],
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

  test("accepts editedMessageId as any short non-empty string", () => {
    const baseMessages = [
      {
        id: "m1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "edited body" }],
      },
    ];
    // Accept both formats the system actually emits:
    //  - SDK-generated client ids (~16-char base64-ish) on freshly-sent turns
    //  - drizzle $defaultFn UUIDs for older DB-loaded turns
    expect(
      BodySchema.safeParse({
        editedMessageId: "OZAjwQRiQE2DVAaO",
        messages: baseMessages,
      }).success,
    ).toBe(true);
    expect(
      BodySchema.safeParse({
        editedMessageId: "22222222-2222-4222-8222-222222222222",
        messages: baseMessages,
      }).success,
    ).toBe(true);
    // Reject empty strings (treats "" as "no edit," but the field is
    // optional, so callers should just omit instead).
    expect(
      BodySchema.safeParse({
        editedMessageId: "",
        messages: baseMessages,
      }).success,
    ).toBe(false);
    // Cap at 128 chars to keep the lookup column reasonable.
    expect(
      BodySchema.safeParse({
        editedMessageId: "x".repeat(129),
        messages: baseMessages,
      }).success,
    ).toBe(false);
    // Optional — omitting it is fine on a normal (non-edit) request.
    expect(
      BodySchema.safeParse({ messages: baseMessages }).success,
    ).toBe(true);
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
