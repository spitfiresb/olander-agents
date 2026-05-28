"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { UIMessage } from "ai";
import { PencilIcon } from "@/components/icons";
import { AttachmentChip } from "./AttachmentChip";

type FilePart = {
  type: "file";
  mediaType: string;
  url: string;
  filename: string;
  size?: number;
};

type TextPart = { type: "text"; text: string };

const isTextPart = (p: unknown): p is TextPart =>
  typeof p === "object" &&
  p !== null &&
  "type" in p &&
  (p as { type: string }).type === "text";

const isFilePart = (p: unknown): p is FilePart =>
  typeof p === "object" &&
  p !== null &&
  "type" in p &&
  (p as { type: string }).type === "file" &&
  "url" in p &&
  "mediaType" in p &&
  "filename" in p;

type Props = {
  message: UIMessage;
  // True when the chat is idle (status === "ready"). The component combines
  // this with its own "does this message have file parts?" check to decide
  // whether to render the edit affordance — file-bearing messages can't be
  // edited in v1 (revisit later).
  canEdit: boolean;
  onEditAndResend: (messageId: string, newText: string) => void;
};

export function EditableUserBubble({
  message,
  canEdit,
  onEditAndResend,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const userText = message.parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join("\n\n");
  const userFiles = message.parts.filter(isFilePart);
  const hasFiles = userFiles.length > 0;
  // v1 lock: messages with attachments are not editable. Tracked as a
  // future-revisit item in handoff.md — re-picking files mid-edit is its own
  // design problem.
  const editable = canEdit && !hasFiles && userText.length > 0;

  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // Cursor at end of existing content. Not select-all — feels less
    // destructive when the rep is making a small edit (a typo, an extra
    // qualifier) rather than rewriting.
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [isEditing]);

  function enterEditMode() {
    setEditText(userText);
    setIsEditing(true);
  }

  function cancel() {
    setIsEditing(false);
    setEditText("");
  }

  function save() {
    const trimmed = editText.trim();
    if (!trimmed) return;
    if (trimmed === userText.trim()) {
      cancel();
      return;
    }
    onEditAndResend(message.id, trimmed);
    setIsEditing(false);
    setEditText("");
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  }

  if (isEditing) {
    const canSave = editText.trim().length > 0 && canEdit;
    return (
      <div className="flex justify-end animate-message-in">
        <div className="flex w-full max-w-[80%] flex-col items-end gap-2">
          <div className="w-full rounded-2xl border border-brand-charcoal/15 bg-white p-2 shadow-sm">
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              className="block w-full max-h-64 min-h-16 resize-none border-none bg-transparent px-2 py-2 text-sm leading-relaxed text-brand-charcoal focus:outline-none [field-sizing:content]"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                className="inline-flex h-8 items-center rounded-full border border-brand-charcoal/15 bg-white px-3 text-xs font-medium text-brand-charcoal transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!canSave}
                className="inline-flex h-8 items-center rounded-full bg-brand-red px-3 text-xs font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save &amp; Resend
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex justify-end animate-message-in">
      <div className="flex max-w-[80%] flex-col items-end gap-2">
        {hasFiles && (
          <div className="flex flex-wrap justify-end gap-2">
            {userFiles.map((f, i) => (
              <AttachmentChip
                key={`${f.url}-${i}`}
                filename={f.filename}
                mediaType={f.mediaType}
                size={f.size}
                url={f.url}
                variant="message"
                status="ready"
              />
            ))}
          </div>
        )}
        {userText && (
          <div className="flex items-end gap-2">
            {editable && (
              <button
                type="button"
                onClick={enterEditMode}
                aria-label="Edit message"
                className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-brand-ink-soft opacity-0 transition-all hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas group-hover:opacity-100"
              >
                <PencilIcon />
              </button>
            )}
            <div className="whitespace-pre-wrap rounded-2xl bg-brand-sand px-4 py-2.5 leading-relaxed text-brand-charcoal">
              {userText}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
