"use client";

import { upload } from "@vercel/blob/client";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

export type DocumentDTO = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  status: "processing" | "ready" | "failed";
  chunkCount: number;
  error: string | null;
  createdAt: string;
};

// Path prefix + accepted types are duplicated from the server (src/lib/extract.ts,
// src/lib/documents.ts) on purpose: this is a client component and must not
// import server-only modules (db, blob, etc.). The server re-validates both.
const REFERENCE_DOC_PREFIX = "reference-docs";
const ACCEPT_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
].join(",");

// Fallback MIME by extension when the browser reports an empty file.type.
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: DocumentDTO["status"] }) {
  const cls =
    status === "ready"
      ? "bg-green-50 text-green-700 border-green-200"
      : status === "failed"
        ? "bg-brand-red/10 text-brand-red border-brand-red/30"
        : "bg-amber-50 text-amber-700 border-amber-200";
  const label =
    status === "ready" ? "Ready" : status === "failed" ? "Failed" : "Processing…";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

export function DocumentManager({
  initialDocuments,
}: {
  initialDocuments: DocumentDTO[];
}) {
  const [documents, setDocuments] = useState<DocumentDTO[]>(initialDocuments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/documents", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { documents: DocumentDTO[] };
      setDocuments(data.documents ?? []);
    } catch {
      // transient; the next poll/refresh will catch up
    }
  }, []);

  // Poll while any document is still processing, so the status flips to
  // Ready/Failed without a manual refresh.
  useEffect(() => {
    if (!documents.some((d) => d.status === "processing")) return;
    const t = setTimeout(() => void refresh(), 3000);
    return () => clearTimeout(t);
  }, [documents, refresh]);

  async function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // allow re-picking the same file
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of files) {
        const mediaType = mimeFor(file);
        if (!ACCEPT_MIME.split(",").includes(mediaType)) {
          setError(`${file.name}: unsupported file type`);
          continue;
        }
        // Direct browser→Blob upload, authorized by the token route. Bypasses
        // the serverless body-size limit. A single PUT (no multipart) is the
        // reliable path at our file sizes — multipart's multi-step handshake
        // was stalling the upload before it could complete.
        const blob = await upload(`${REFERENCE_DOC_PREFIX}/${file.name}`, file, {
          access: "public",
          handleUploadUrl: "/api/admin/documents/token",
          contentType: mediaType,
        });
        // Record + kick off ingestion.
        const res = await fetch("/api/admin/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blobUrl: blob.url,
            blobPathname: blob.pathname,
            filename: file.name,
            mediaType,
            sizeBytes: file.size,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(`${file.name}: ${body.error ?? "upload failed"}`);
        }
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string, filename: string) {
    if (!window.confirm(`Remove "${filename}" from the reference library?`)) return;
    try {
      await fetch(`/api/admin/documents?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await refresh();
    } catch {
      setError("Couldn't delete — try again.");
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="rounded-md bg-brand-red px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {busy ? "Uploading…" : "Upload document"}
        </button>
        <span className="text-xs text-brand-ink-soft">
          Indexing runs in the background — large files take a minute.
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_MIME}
        onChange={onPickFiles}
        className="hidden"
        tabIndex={-1}
      />
      {error ? <p className="mt-2 text-sm text-brand-red">{error}</p> : null}

      <div className="mt-5 overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-brand-canvas/70 text-left text-xs uppercase tracking-wider text-brand-ink-soft">
            <tr>
              <th className="px-3 py-2 font-semibold">Document</th>
              <th className="px-3 py-2 text-right font-semibold">Size</th>
              <th className="px-3 py-2 text-right font-semibold">Chunks</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id} className="border-t border-brand-charcoal/10 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-brand-charcoal">{d.filename}</div>
                  {d.status === "failed" && d.error ? (
                    <div className="mt-0.5 text-[11px] text-brand-red">{d.error}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-brand-ink-soft">
                  {formatBytes(d.sizeBytes)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-brand-ink-soft">
                  {d.chunkCount || "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={d.status} />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void onDelete(d.id, d.filename)}
                    className="rounded text-xs font-medium text-brand-red hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {documents.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-brand-ink-soft">
                  No documents yet. Upload one to make it searchable in chat.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
