import { activeSession } from "@/auth";
import { exportConversationMarkdown } from "@/lib/conversations";
import { slugify } from "@/lib/slug";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const session = await activeSession();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const result = await exportConversationMarkdown(session.user.id, id);
  if (result == null) return Response.json({ error: "not_found" }, { status: 404 });
  // Slugified title for the downloaded filename — reps' Downloads folders
  // want recognizable names. Falls back to the conversation id when the
  // title is empty / only-punctuation (slugify returns "" then).
  const filename = `${slugify(result.title) || id}.md`;
  return new Response(result.markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
