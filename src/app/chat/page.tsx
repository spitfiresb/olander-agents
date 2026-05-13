import { redirect } from "next/navigation";
import { activeSession } from "@/auth";
import { ChatShell } from "./ChatShell";

export default async function ChatPage() {
  const session = await activeSession();
  if (!session?.user) redirect("/");

  return <ChatShell isAdmin={session.user.role === "admin"} />;
}
