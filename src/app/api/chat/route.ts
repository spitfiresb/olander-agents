import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { z } from "zod";
import { auth } from "@/auth";
import { getModel } from "@/lib/ai/model";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { tools } from "@/lib/ai/tools";

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
  const devBypass =
    process.env.NODE_ENV !== "production" && process.env.ALLOW_UNAUTHED_DEV === "1";
  if (!devBypass) {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

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
    messages: await convertToModelMessages(parsed.data.messages as UIMessage[]),
    tools,
    stopWhen: stepCountIs(3),
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
