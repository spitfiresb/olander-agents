import { auth } from "@/auth";
import { listConversations, createConversation } from "@/lib/conversations";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await listConversations(session.user.id);
  return Response.json({ conversations: rows });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — fall through to default title
  }
  const title =
    typeof (body as { title?: unknown }).title === "string"
      ? ((body as { title: string }).title)
      : "Untitled chat";
  const conv = await createConversation(session.user.id, title);
  return Response.json({ conversation: conv }, { status: 201 });
}
