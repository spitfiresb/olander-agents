"use client";

import { useState } from "react";
import {
  AlertIcon,
  CloseIcon,
  DocumentIcon,
  ImageIcon,
  PdfIcon,
  SpinnerIcon,
  SpreadsheetIcon,
} from "@/components/icons";

export type AttachmentChipStatus = "uploading" | "ready" | "error";

type Props = {
  filename: string;
  mediaType: string;
  size?: number;
  url?: string;
  // "composer" renders with status text + a remove button; "message" renders
  // as a compact link to the file (no status, no remove).
  variant: "composer" | "message";
  status?: AttachmentChipStatus;
  errorMessage?: string;
  onRemove?: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileTypeIcon({ mediaType }: { mediaType: string }) {
  if (mediaType.startsWith("image/")) return <ImageIcon />;
  if (mediaType === "application/pdf") return <PdfIcon />;
  if (
    mediaType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "text/csv" ||
    mediaType === "text/tab-separated-values"
  )
    return <SpreadsheetIcon />;
  return <DocumentIcon />;
}

export function AttachmentChip({
  filename,
  mediaType,
  size,
  url,
  variant,
  status = "ready",
  errorMessage,
  onRemove,
}: Props) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const isImage = mediaType.startsWith("image/");
  const showThumbnail =
    isImage && url && status === "ready" && !thumbnailFailed;
  const isError = status === "error";
  const isUploading = status === "uploading";

  const statusLine = isUploading
    ? "Uploading…"
    : isError
      ? errorMessage ?? "Upload failed"
      : size !== undefined
        ? formatBytes(size)
        : "";

  const inner = (
    <>
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md ${
          showThumbnail ? "bg-brand-charcoal/5" : "bg-brand-sand/60 text-brand-ink-soft"
        }`}
      >
        {showThumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setThumbnailFailed(true)}
          />
        ) : isUploading ? (
          <SpinnerIcon />
        ) : isError ? (
          <AlertIcon className="text-brand-red" />
        ) : (
          <FileTypeIcon mediaType={mediaType} />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-brand-charcoal">
          {filename}
        </span>
        {statusLine && (
          <span
            className={`truncate text-[10px] leading-tight ${
              isError ? "text-brand-red" : "text-brand-ink-soft"
            }`}
          >
            {statusLine}
          </span>
        )}
      </div>
    </>
  );

  const baseClasses = `inline-flex max-w-[240px] items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors ${
    isError
      ? "border-brand-red/40 bg-brand-red/5"
      : "border-brand-charcoal/15 bg-white"
  }`;

  if (variant === "message" && url && status === "ready") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClasses} hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2`}
        title={`Open ${filename}`}
      >
        {inner}
      </a>
    );
  }

  return (
    <div className={baseClasses}>
      {inner}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${filename}`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-brand-ink-soft transition-colors hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        >
          <CloseIcon className="!h-3 !w-3" />
        </button>
      )}
    </div>
  );
}
