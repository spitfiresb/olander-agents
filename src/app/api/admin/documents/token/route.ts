import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "@/auth";
import { isSameOrigin } from "@/lib/csrf";
import { MAX_DOC_BYTES } from "@/lib/document-limits";
import { REFERENCE_DOC_MIMES } from "@/lib/extract";

export const dynamic = "force-dynamic";

// Issues a short-lived client upload token so the browser can upload a
// reference document straight to Vercel Blob — bypassing the serverless
// request-body limit (~4.5 MB) that would block large files like a product
// catalog. Admin-gated at token-generation time: a non-admin can't get a token,
// so they can't upload. The row + ingestion are created by a second call to
// POST /api/admin/documents once the blob upload finishes. The size ceiling
// (MAX_DOC_BYTES) is enforced here too, so a forged direct call can't exceed it.

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request.headers)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const session = await auth();
        if (session?.user?.role !== "admin") {
          throw new Error("forbidden");
        }
        return {
          allowedContentTypes: [...REFERENCE_DOC_MIMES],
          maximumSizeInBytes: MAX_DOC_BYTES,
          addRandomSuffix: true,
        };
      },
      // The row + ingestion are created by POST /api/admin/documents after the
      // client finishes the upload (works locally too, unlike the Blob webhook).
      onUploadCompleted: async () => {},
    });
    return Response.json(jsonResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "upload_token_failed";
    const status = msg === "forbidden" ? 403 : 400;
    return Response.json({ error: msg }, { status });
  }
}
