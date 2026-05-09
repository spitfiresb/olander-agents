import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ChatShell } from "./ChatShell";

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <ChatShell
      user={{
        name: session.user.name ?? null,
        email: session.user.email ?? null,
      }}
    />
  );
}
