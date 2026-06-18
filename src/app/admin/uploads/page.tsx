import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { BackLink } from "@/components/BackLink";
import {
  getMaxUploadMb,
  MAX_MAX_UPLOAD_MB,
  MIN_MAX_UPLOAD_MB,
} from "@/lib/upload-settings";
import { UploadSettingsForm } from "./UploadSettingsForm";

export const dynamic = "force-dynamic";

export default async function UploadSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const current = await getMaxUploadMb();

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">
          Upload settings
        </h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          The maximum size of a single file a rep can attach in chat. Raising it
          lets bigger PDFs and documents through; very large files still cost
          more to process and may exceed what the AI can read in one message.
        </p>

        <div className="mt-6">
          <UploadSettingsForm
            current={current}
            min={MIN_MAX_UPLOAD_MB}
            max={MAX_MAX_UPLOAD_MB}
          />
        </div>
      </div>
    </div>
  );
}
