import { redirect } from "next/navigation";
import { activeSession } from "@/auth";
import { getTrialBannerData } from "@/lib/trial";
import { getMaxUploadBytes } from "@/lib/upload-settings";
import { ChatShell } from "./ChatShell";

export default async function ChatPage() {
  const session = await activeSession();
  if (!session?.user) redirect("/");

  const [trial, maxUploadBytes] = await Promise.all([
    getTrialBannerData(),
    getMaxUploadBytes(),
  ]);

  return (
    <ChatShell
      isAdmin={session.user.role === "admin"}
      trial={trial}
      maxUploadBytes={maxUploadBytes}
    />
  );
}
