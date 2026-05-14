import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { BackLink } from "@/components/BackLink";
import { ScopesBoard } from "./ScopesBoard";
import { loadScopesPageData } from "./data";

export const dynamic = "force-dynamic";

export default async function ScopesPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const data = await loadScopesPageData();

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>

        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">
          Data-access scopes
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-brand-ink-soft">
          Group P21 views into buckets you can grant to members. Admins always
          have full access; this page is for everyone else.
        </p>

        <div className="mt-6">
          <ScopesBoard
            scopes={data.scopes}
            assignments={data.assignments}
            unassignedViews={data.unassignedViews}
            viewMeta={data.viewMeta}
          />
        </div>
      </div>
    </div>
  );
}
