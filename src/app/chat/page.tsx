import { redirect } from "next/navigation";
import { activeSession } from "@/auth";
import { getTrialBannerData } from "@/lib/trial";
import { ChatShell } from "./ChatShell";

export default async function ChatPage() {
  const session = await activeSession();
  if (!session?.user) redirect("/");

  const trial = await getTrialBannerData();

  return <ChatShell isAdmin={session.user.role === "admin"} trial={trial} />;
}
