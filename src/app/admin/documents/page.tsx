import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { BackLink } from "@/components/BackLink";
import { listReferenceDocuments } from "@/lib/documents";
import { DocumentManager, type DocumentDTO } from "./DocumentManager";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const docs = await listReferenceDocuments();
  const initial: DocumentDTO[] = docs.map((d) => ({
    id: d.id,
    filename: d.filename,
    mediaType: d.mediaType,
    sizeBytes: d.sizeBytes,
    status: d.status,
    chunkCount: d.chunkCount,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
  }));

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">
          Reference documents
        </h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Upload company documents — policies, manuals, the employee handbook,
          quality procedures, product catalogs — for the assistant to search and
          cite in chat. Supported: PDF, Word, PowerPoint, Excel, and text/CSV.
          Large files (catalogs) are fine. Scanned/image-only PDFs can&apos;t be
          read yet.
        </p>

        <div className="mt-6">
          <DocumentManager initialDocuments={initial} />
        </div>
      </div>
    </div>
  );
}
