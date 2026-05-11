import { auth } from "@/auth";
import { exportConversationMarkdown } from "@/lib/conversations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const md = await exportConversationMarkdown(session.user.id, id);
  if (md == null) return Response.json({ error: "not_found" }, { status: 404 });
  return new Response(md, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="conversation-${id}.md"`,
      "Cache-Control": "no-store",
    },
  });
}
