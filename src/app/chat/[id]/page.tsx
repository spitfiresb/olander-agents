import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { ChatShell } from "../ChatShell";
import { loadMessages, getConversation } from "@/lib/conversations";
import type { UIMessage } from "ai";

type Props = { params: Promise<{ id: string }> };

export default async function ConversationPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) notFound();

  const conv = await getConversation(session.user.id, id);
  if (!conv) notFound();

  const rows = await loadMessages(session.user.id, id);
  const initialMessages: UIMessage[] = (rows ?? []).map((row) => ({
    id: row.id,
    role: row.role as "user" | "assistant" | "system",
    parts: row.parts as UIMessage["parts"],
  }));

  return (
    <ChatShell
      initialConversationId={id}
      initialMessages={initialMessages}
      isAdmin={session.user.role === "admin"}
    />
  );
}
