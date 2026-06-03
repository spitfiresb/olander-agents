"use client";

import {
  type ChangeEvent,
  type ClipboardEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
  useRef,
} from "react";
import type { ChatStatus } from "ai";
import { CameraIcon, PaperclipIcon } from "@/components/icons";
import { AttachmentChip } from "./AttachmentChip";

// Client-side state for a single attachment chip. Lives in ChatShell because
// the drop overlay (also in ChatShell) is another entry point; the composer
// just renders the chips and provides the button/paste affordances.
export type ComposerAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  status: "uploading" | "ready" | "error";
  url?: string;
  pathname?: string;
  errorMessage?: string;
};

// Mirror of src/lib/blob.ts ALLOWED_MIME — duplicated here so the file input
// `accept` attribute filters at the OS picker level, and so the paste/drop
// paths can pre-reject before the network call. Server is still the
// authoritative validator (TESTING.md §2).
const ACCEPT_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
].join(",");

type Props = {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: ChatStatus;
  error: Error | undefined;
  attachments: ComposerAttachment[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onRegenerate: () => void;
};

function friendlyErrorMessage(error: Error): string {
  const msg = error.message ?? "";
  if (msg.includes("server_misconfigured"))
    return "AI service isn't configured yet. Please contact your admin.";
  if (msg.includes("provider_auth"))
    return "AI provider rejected credentials. Please contact your admin.";
  if (msg.includes("rate_limited"))
    return "AI is busy right now. Try again in a moment.";
  if (msg.includes("provider_unavailable"))
    return "AI service is temporarily unavailable. Try again shortly.";
  if (msg.includes("bad_request"))
    return "Couldn't send your message. Please refresh and try again.";
  if (msg.includes("forbidden"))
    return "That attachment isn't valid for your account. Please re-upload.";
  return "Something went wrong. Please try again.";
}

export function Composer({
  input,
  setInput,
  status,
  error,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
  onStop,
  onRegenerate,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const trimmed = input.trim();
  const readyCount = attachments.filter((a) => a.status === "ready").length;
  const stillUploading = attachments.some((a) => a.status === "uploading");
  const canSend =
    status === "ready" &&
    !stillUploading &&
    (trimmed.length > 0 || readyCount > 0);
  const inFlight = status === "submitted" || status === "streaming";

  const submit = () => {
    if (!canSend) return;
    onSubmit();
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      onAddFiles(e.clipboardData.files);
    }
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFiles(e.target.files);
    }
    // Reset so picking the same file twice still fires `change`.
    e.target.value = "";
  };

  return (
    <div className="shrink-0 bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-4 pb-4 pt-2 sm:px-6">
        {error && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-brand-red/30 bg-brand-red/5 px-4 py-2.5 text-sm text-brand-charcoal">
            <span className="flex items-center gap-2">
              <WarningIcon />
              {friendlyErrorMessage(error)}
            </span>
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded font-medium text-brand-red hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
            >
              Retry
            </button>
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-2 rounded-2xl border border-brand-charcoal/15 bg-white p-2 shadow-[0_-4px_16px_-12px_rgba(45,46,41,0.15)] transition-colors focus-within:border-brand-red/40 focus-within:ring-1 focus-within:ring-brand-red/20"
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-brand-charcoal/10 px-1 pb-2">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  filename={a.filename}
                  mediaType={a.mediaType}
                  size={a.size}
                  url={a.url}
                  variant="composer"
                  status={a.status}
                  errorMessage={a.errorMessage}
                  onRemove={() => onRemoveAttachment(a.id)}
                />
              ))}
            </div>
          )}
          <div className="flex items-end gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-brand-ink-soft transition-colors hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
            >
              <PaperclipIcon />
            </button>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              aria-label="Take a photo"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-brand-ink-soft transition-colors hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 lg:hidden"
            >
              <CameraIcon />
            </button>
            <textarea
              data-composer-input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask about a customer, item, or order…"
              rows={1}
              className="max-h-32 min-h-9 flex-1 resize-none border-none bg-transparent px-2 py-2 text-sm leading-relaxed text-brand-charcoal placeholder:text-brand-ink-soft/70 focus:outline-none [field-sizing:content]"
            />
            {inFlight ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand-charcoal/30 bg-white text-brand-charcoal transition-colors hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send message"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </form>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_MIME}
          onChange={handleFileInputChange}
          className="hidden"
          tabIndex={-1}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileInputChange}
          className="hidden"
          tabIndex={-1}
        />
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 13V3" />
      <path d="M3 8l5-5 5 5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="shrink-0 text-brand-red"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v4" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" />
    </svg>
  );
}
