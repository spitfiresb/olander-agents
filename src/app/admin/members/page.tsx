import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { normalizeEmail } from "@/lib/auth-allowlist";
import { listMembers } from "@/lib/members";
import { bucketsFromCatalog, loadScopeCatalog } from "@/lib/scopes";
import { BackLink } from "@/components/BackLink";
import { AddMemberForm } from "./AddMemberForm";
import { MembersTable } from "./MembersTable";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const myEmail = session.user.email ? normalizeEmail(session.user.email) : null;
  const [members, catalog] = await Promise.all([
    listMembers(),
    loadScopeCatalog(),
  ]);
  const buckets = bucketsFromCatalog(catalog);

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>

        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">
          Members
        </h1>

        <div className="mt-6">
          <AddMemberForm />
        </div>

        <div className="mt-6">
          <MembersTable
            members={members}
            myEmail={myEmail}
            buckets={buckets}
          />
        </div>
      </div>
    </div>
  );
}
