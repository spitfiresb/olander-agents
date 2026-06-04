import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { BackLink } from "@/components/BackLink";
import { getTrialStatus } from "@/lib/trial";
import { TrialUsageSummary } from "../TrialUsageSummary";
import { TrialControls } from "./TrialControls";

export const dynamic = "force-dynamic";

export default async function TrialPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const trial = await getTrialStatus();

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">Trial spend gate</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Temporary deployment-wide trial allowance. Once estimated spend crosses the limit, chat
          hard-stops for <strong>everyone</strong> — this admin page stays reachable so you can
          raise the limit or turn the gate off. Spend is an in-app estimate from token usage priced
          per model, so it trips <em>near</em> the limit, not to the exact cent.
        </p>

        <div className="mt-6">
          <TrialUsageSummary trial={trial} />
        </div>

        <TrialControls enabled={trial.enabled} limitUsd={trial.limitUsd} />
      </div>
    </div>
  );
}
