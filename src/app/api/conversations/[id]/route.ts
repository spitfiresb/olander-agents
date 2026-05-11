import { auth } from "@/auth";
import {
  getConversation,
  loadMessages,
  renameConversation,
  softDeleteConversation,
} from "@/lib/conversations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const conv = await getConversation(session.user.id, id);
  if (!conv) return Response.json({ error: "not_found" }, { status: 404 });
  const msgs = await loadMessages(session.user.id, id);
  return Response.json({ conversation: conv, messages: msgs ?? [] });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const title = (body as { title?: unknown }).title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const ok = await renameConversation(session.user.id, id, title);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ok = await softDeleteConversation(session.user.id, id);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
