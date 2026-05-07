import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai/model";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";

export const maxDuration = 60;

const BodySchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["system", "user", "assistant"]),
        parts: z.array(z.unknown()),
      }),
    )
    .min(1)
    .max(50),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  let model;
  try {
    model = getModel();
  } catch (err) {
    console.error("[chat] model init failed:", err);
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(parsed.data.messages as UIMessage[]),
    abortSignal: req.signal,
    onError: ({ error }) => {
      console.error("[chat] stream error:", error);
    },
    onFinish: ({ usage }) => {
      console.log("[chat] usage", usage);
    },
  });

  return result.toUIMessageStreamResponse();
}
