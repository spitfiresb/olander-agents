import { after } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isSameOrigin } from "@/lib/csrf";
import { isReferenceDocMime } from "@/lib/extract";
import {
  createReferenceDocument,
  deleteReferenceDocument,
  listReferenceDocuments,
  processReferenceDocument,
  REFERENCE_DOC_PREFIX,
} from "@/lib/documents";

// 300s so the post-response ingestion (extract → chunk → embed → upsert) run by
// `after()` has runtime budget on a large document. Requires Fluid Compute (the
// chat route relies on the same).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<{
  id?: string;
  email?: string | null;
} | null> {
  const session = await auth();
  if (session?.user?.role !== "admin") return null;
  return session.user;
}

const CreateBody = z.object({
  blobUrl: z.string().url().max(2048),
  blobPathname: z.string().min(1).max(1024),
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative().max(200 * 1024 * 1024),
});

// SSRF gate: the URL is fetched server-side during ingestion, so it must point
// at our Vercel Blob store under the reference-docs prefix — never an arbitrary
// host an admin (or a forged request) supplied.
function isOwnReferenceBlob(url: string, pathname: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!u.hostname.endsWith(".public.blob.vercel-storage.com")) return false;
  return pathname.startsWith(`${REFERENCE_DOC_PREFIX}/`);
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const documents = await listReferenceDocuments();
  return Response.json({ documents });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req.headers)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const admin = await requireAdmin();
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { blobUrl, blobPathname, filename, mediaType, sizeBytes } = parsed.data;

  if (!isReferenceDocMime(mediaType)) {
    return Response.json({ error: "unsupported_mime" }, { status: 415 });
  }
  if (!isOwnReferenceBlob(blobUrl, blobPathname)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const doc = await createReferenceDocument({
    filename,
    mediaType,
    sizeBytes,
    blobUrl,
    blobPathname,
    uploadedBy: admin.id ?? admin.email ?? null,
  });

  // Ingest after the response is sent so the upload feels instant; the admin UI
  // polls status until it flips to ready/failed. Fluid Compute keeps the
  // function alive for the after() callback up to maxDuration.
  after(async () => {
    await processReferenceDocument(doc.id);
  });

  return Response.json({ document: doc }, { status: 201 });
}

export async function DELETE(req: Request) {
  if (!isSameOrigin(req.headers)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const admin = await requireAdmin();
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "bad_request" }, { status: 400 });

  const ok = await deleteReferenceDocument(id);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
