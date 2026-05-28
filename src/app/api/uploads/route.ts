import { auth } from "@/auth";
import {
  ATTACHMENT_PREFIX,
  deleteAttachment,
  isAllowedMimeType,
  MAX_FILE_BYTES,
  uploadAttachment,
} from "@/lib/blob";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/csrf";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST: multipart upload — `file` field. Returns { attachment: { url, pathname,
// mediaType, size, filename } } on success. The URL is the gate at chat-route
// time: only the calling user's chat-attachments/{userId}/ prefix is accepted.
//
// DELETE: JSON body `{ pathname }`. Owner-scoped — the lib refuses if the
// pathname isn't under the caller's prefix.
export async function POST(req: Request) {
  if (!isSameOrigin(req.headers)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Same per-user cap as /api/chat — uploads count too. Stops a runaway
  // client from filling the blob store before the chat route ever runs.
  const rl = checkRateLimit(userId);
  if (!rl.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "file_too_large" }, { status: 413 });
  }
  if (!isAllowedMimeType(file.type)) {
    return Response.json({ error: "unsupported_mime" }, { status: 415 });
  }

  try {
    const attachment = await uploadAttachment(file, userId);
    return Response.json({ attachment }, { status: 201 });
  } catch (err) {
    console.error("[uploads] put failed:", err);
    return Response.json({ error: "upload_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!isSameOrigin(req.headers)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const pathname = (body as { pathname?: unknown })?.pathname;
  if (typeof pathname !== "string" || !pathname) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!pathname.startsWith(`${ATTACHMENT_PREFIX}/${userId}/`)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    await deleteAttachment(pathname, userId);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "forbidden") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    console.error("[uploads] del failed:", err);
    return Response.json({ error: "delete_failed" }, { status: 500 });
  }
}
