# Stage 4 — Chat-header dropdown + empty-state polish + tool-result actions

**Status:** 4a **shipped 2026-05-18** (commits `bd4cac6` refactor + `99cbabc` feature). 4b and 4c queued.

A self-contained plan doc so a future session can pick up Stage 4 without
re-deriving anything from conversation history. Companion to `handoff.md`
at the repo root — that file is the live-state snapshot; this file is the
per-sub-stage implementation plan.

---

## Stage 4a — Chat-header dropdown

### Deliverable

A persistent chat-title affordance at the top of the chat surface with a
chevron-triggered dropdown menu. Menu items: **Pin / Unpin**, **Rename**
(inline), **Export as markdown**, **Delete** (with confirmation). Header
renders only when a conversation is loaded; empty state is unchanged.

### Decisions (locked)

| Question | Answer | Reason |
|---|---|---|
| Export filename | Slugified chat title (`{slug}.md`), fallback to id when title is empty/just-whitespace | Reps' Downloads folders want recognizable names; one-line route change |
| Delete confirmation | Native `window.confirm()` for v1; upgrade to admin-style dialog in Stage 5 alongside a similar sidebar uplift | Ships fast; matches sidebar's current (no-confirm) baseline well enough that we aren't creating a new inconsistency |
| Mobile chat-title bar | Second bar **below** the existing charcoal top bar; `bg-brand-canvas` with charcoal text and a `border-b border-brand-charcoal/[0.06]` hairline | Charcoal bar stays app-chrome (history/brand/account); canvas bar is content-chrome (the chat you're in). Matches DESIGN.md tonal split. |
| Sidebar action duplication | Keep both sidebar hover actions AND chat header dropdown actions for v1 | Different access patterns: sidebar is fast for mouse power users; header is mobile + discoverability. Reversible. |
| Chevron rotation on open | Yes — `rotate-180 transition-transform duration-150` | Subtle state-change motion per DESIGN.md "subtle, state-change only" rule |

### UI placement

#### Desktop (lg+)

Rework the existing desktop top strip (`ChatShell.tsx:594`). Currently:
`relative ... justify-center` with `absolute right-4` for the account menu
and an empty center.

Becomes: `flex items-center justify-between px-4`. Title trigger on the
left (renders only when a conversation is active); account menu on the
right.

```
BEFORE                                                  AFTER
┌────────────────────────────────────────┐    ┌────────────────────────────────────────────┐
│  (empty)                  [acct menu]  │    │  [Title]  [▼]                 [acct menu]  │
└────────────────────────────────────────┘    └────────────────────────────────────────────┘
   h-12, justify-center                          h-12, justify-between, title trigger LEFT
```

#### Mobile (< lg)

Add a second bar below the existing charcoal mobile top bar. The charcoal
bar (hamburger / wordmark / account) stays untouched; the new canvas-
colored bar sits below it.

```
┌──────────────────────────────────────────────────────────┐
│  charcoal:  [☰] [wordmark]                  [acct menu]  │  ← existing, unchanged
├──────────────────────────────────────────────────────────┤
│  canvas:    [Title] [▼]                                  │  ← NEW, only when chat loaded
├──────────────────────────────────────────────────────────┤
│  message list                                            │
│  composer                                                │
└──────────────────────────────────────────────────────────┘
```

#### Dropdown menu surface

White card matching `AccountMenu`'s styling:
`rounded-2xl border border-brand-charcoal/10 bg-white py-1 shadow-md
animate-menu-in`. Items use `hover:bg-brand-sand/40`. Delete item is
`text-brand-red`. Separator above Delete: `<div className="my-1 h-px
bg-brand-charcoal/10" />`.

```
┌─────────────────────────────┐
│  ⤴ Pin                      │   ← swaps to "Unpin" + filled glyph when pinned
│  ✎ Rename                   │
│  ⬇ Export as markdown       │
│  ───────────────────────    │
│  🗑 Delete                  │   ← red text, separator above
└─────────────────────────────┘
```

### Files

#### Created

| Path | Purpose |
|---|---|
| `src/app/chat/ChatHeader.tsx` | Title + chevron trigger + dropdown menu + inline rename mode |
| `src/app/chat/RenameInput.tsx` | Extracted from `Sidebar.tsx` so the header can reuse it verbatim |
| `src/lib/slug.ts` | Filename-safe slug helper for export filenames |
| `src/lib/__tests__/slug.test.ts` | 7 unit tests on `slugify` (cases, diacritics, cap, edge cases, fastener title) |

**Originally planned `src/app/chat/__tests__/ChatHeader.test.tsx`** — dropped. The codebase's vitest config is `environment: "node"` with zero existing React component tests. Standing up jsdom + React Testing Library for one component is its own conversation; not in 4a scope. Component behavior verified via local browser smoke.

#### Modified

| Path | What changed |
|---|---|
| `src/app/chat/ChatShell.tsx` | Derived `activeConversation` from the `conversations` array + `conversationId`; renders `<ChatHeader />` inside the desktop top strip and as a new mobile chat-title bar; reworked desktop strip from `justify-center` to `justify-between`; added `deleteWithConfirm` helper around `onDeleteConversation` (native `window.confirm` per the decision table above) |
| `src/app/chat/Sidebar.tsx` | Imports `RenameInput` from the new file; imports `TrashIcon` from the shared icons module. No behavior change |
| `src/components/icons.tsx` | Added `ChevronDownIcon`, `DownloadIcon`, and the lifted `TrashIcon` |
| `src/lib/conversations.ts` | `exportConversationMarkdown` return type widened from `Promise<string \| null>` to `Promise<{ markdown: string; title: string } \| null>` so the route can use the title for the filename |
| `src/app/api/conversations/[id]/export/route.ts` | Switched `Content-Disposition` filename from `conversation-{id}.md` to `${slugify(title) || id}.md` |
| `scripts/verify-persistence.ts` | Updated for the new `exportConversationMarkdown` return shape |

### Component shape — `ChatHeader.tsx`

```ts
type Props = {
  conversationId: string;
  title: string;
  pinnedAt: string | null;
  status: ChatStatus;  // disables Delete during streaming/submitted
  onRename: (id: string, nextTitle: string) => Promise<void> | void;
  onTogglePin: (id: string, nextPinned: boolean) => void;
  onDelete: (id: string) => void;   // ChatShell wraps with confirm()
  variant?: "desktop" | "mobile";
};
```

Internal state: `menuOpen: boolean`, `editing: boolean`, a `containerRef`
for click-outside detection. All pattern-matched to `AccountMenu`.

### State + data flow

The handlers already exist in `ChatShell` (lines 480-521). We just call
them from a new surface:

```
[ChatHeader Pin button click]
    → onTogglePin(id, !pinnedAt)
       → ChatShell.onTogglePin → optimistic state update → PATCH /api/conversations/[id] → refresh sidebar

[ChatHeader Rename submit]
    → onRename(id, nextTitle)
       → ChatShell.onRenameConversation → optimistic update → PATCH → refresh sidebar

[ChatHeader Delete (after confirm)]
    → onDelete(id)
       → ChatShell.onDeleteConversation → DELETE → refresh → if active, startNewChat()
       → Header disappears because conversationId resets to null

[ChatHeader Export]
    → <a href="/api/conversations/[id]/export" download> click
       → Browser GETs the route → server returns markdown with Content-Disposition: attachment
       → Browser saves as {slug}.md
```

No new state in ChatShell. Active conversation lookup:
`const active = conversations.find(c => c.id === conversationId) ?? null`.

### Per-item behavior

| Item | Icon | Disabled when |
|---|---|---|
| **Pin / Unpin** | `PinIcon filled={pinnedAt!=null}` | never (metadata-only) |
| **Rename** | `PencilIcon` | never (metadata-only) |
| **Export as markdown** | `DownloadIcon` (new) | never — route reads committed rows; in-flight content arrives once persisted |
| **Delete** | `TrashIcon` (lifted), red text | `status === "streaming"` or `status === "submitted"` |

### Accessibility + keyboard

Mirror `AccountMenu`:

- Trigger: `aria-haspopup="menu"`, `aria-expanded={menuOpen}`, `aria-label="Conversation menu"`
- Menu: `role="menu"` with `animate-menu-in` (gated behind `prefers-reduced-motion` in `globals.css`)
- Items: `role="menuitem"`
- Focus ring on canvas: `focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2`
- Esc closes menu, returns focus to trigger
- Click outside (`pointerdown` listener on document) closes menu
- Tab cycles items in DOM order
- Inline rename: input auto-focuses + selects on mount (RenameInput already does this)

Up/Down arrow nav between items is **not** in scope for v1 — Tab works
fine and AccountMenu doesn't do it either.

### Edge cases

| Case | Behavior |
|---|---|
| `conversationId == null` | Header doesn't render; desktop top strip still shows account menu |
| Title is `"New chat"` (default seed) | Render as-is; Rename works |
| 200-char title | Truncate trigger label with ellipsis; full title appears in rename input |
| Two tabs renaming same chat | Last write wins (current API behavior); next refresh corrects optimistic state |
| Rename mid-stream | Allowed — metadata-only |
| Delete mid-stream | Item disabled (see table above) |
| Export when only one turn exists | Valid markdown with just that turn |
| Export mid-stream | Persisted rows only; in-flight turn omitted until it lands |
| Network failure on PATCH/DELETE | ChatShell's `try/finally` + refresh corrects the optimistic state |
| Network failure on export | Browser shows native "failed to download" — acceptable for v1 |
| Mobile drawer open + header dropdown open | Both visible; they don't overlap |
| Long title pushing into account menu | `min-w-0` on title's flex child + `truncate`; account menu has `shrink-0` |

### Dependencies

**No new npm packages.** Hand-rolled menu (pattern from `AccountMenu`),
native `<a download>` for export, existing API endpoints, existing
Tailwind tokens.

### Commit plan

**Commit 1: `refactor(chat): extract RenameInput + shared TrashIcon`**
- Move `RenameInput` from `Sidebar.tsx` to `src/app/chat/RenameInput.tsx`
- Lift `TrashIcon` from `Sidebar.tsx` to `src/components/icons.tsx`
- Add `ChevronDownIcon` and `DownloadIcon` to `icons.tsx`
- Update `Sidebar.tsx` imports
- Zero behavior change

**Commit 2: `feat(chat): chat-header with title and dropdown menu`**
- New `ChatHeader.tsx` (trigger + menu + inline rename)
- `ChatShell.tsx` rework: derive active conversation, render header in
  desktop strip + mobile second bar, pass handlers, wrap delete with
  `confirm()`, gate delete on `status`
- Update export route to use slugified title in `Content-Disposition`
- New test file: `__tests__/ChatHeader.test.tsx`
- Lint, build, test clean before commit

### Testing

#### Vitest (added)
- 7 new tests on `slugify` (`src/lib/__tests__/slug.test.ts`):
  spaces/casing, diacritics, runs of punctuation, 80-char cap,
  empty/punctuation-only fallback, fastener-shaped real-world title

#### Vitest (regression)
- All existing tests pass after the `RenameInput` extraction + the
  `exportConversationMarkdown` return-type widening
- Total run: 100 tests pass (was 93 before slug, 77 in pre-merge handoff)

#### Vitest (originally planned, deferred)
- `ChatHeader.test.tsx` — codebase has no React component test
  infrastructure (vitest is node-environment). Standing up jsdom + RTL
  for one component is its own scoping discussion; component behavior
  verified via local browser smoke instead.

#### Browser smoke (local, no Vercel preview required)
1. Sign in, open a chat with messages
2. Title + chevron appear top-left of chat surface
3. Menu opens with 4 items, Delete in red, separator above Delete
4. Pin → row moves to Pinned in sidebar, label flips to Unpin
5. Rename → input shows with title selected; Enter saves, Esc cancels
6. Export → `{slug}.md` lands in Downloads, renders as markdown
7. Delete → confirm → chat disappears, sidebar refreshes, empty state
8. Repeat key steps on lg breakpoint (devtools mobile preset)
9. Hydration check: no console mismatch warnings

### TESTING.md regression checklist coverage
- §2 (Chat): UserTextPart still rejects non-text parts; `BodySchema.max(50)`;
  `stepCountIs(6)`; `auth()` gate. None touched.
- §5 (DB): no schema change.
- §6 (UI): focus rings, reduced-motion gating — all inherited from
  AccountMenu pattern.

---

## Stage 4b — Empty-state polish (queued)

Replace the bare "Ask about a customer, item, or order…" placeholder
with personalized recent-conversation cards. Clicking a card opens the
chat.

To be expanded when we start. Open questions for later: how many cards
(3? 6?), what each card surfaces (last message? title only?), keyboard
nav (arrow keys?), how it behaves for a brand-new user with zero history.

Files (anticipated): `src/app/chat/EmptyState.tsx` (new),
`src/app/chat/ChatShell.tsx` (empty branch swap).

---

## Stage 4c — Tool-result actions (queued)

`Copy as CSV` / `Copy as TSV` / `Copy as markdown` inside
`ToolCallCard.tsx`. Useful when reps paste P21 query results straight
into a customer email. Pure clipboard work, no backend change.

To be expanded when we start. Open questions for later: where the copy
buttons live (top-right of the card? menu like 4a?), what subset of tool
calls get them (only `viewsQuery`? all?), what counts as "the result"
for serialization.

Files (anticipated): `src/app/chat/ToolCallCard.tsx`,
`src/lib/clipboard.ts` (new, tiny helper).

---

## Reference

- `handoff.md` §2 — live state snapshot
- `handoff.md` §7 — short stage descriptions (points back here)
- `handoff.md` §8 — decisions log (mirrors the 4a decision table above)
- `CLAUDE.md`, `CLAUDE.local.md` — workflow rules
- `DESIGN.md` — visual tokens, color discipline, focus-ring rules
- `TESTING.md` — pre-PR regression checklist
- `src/app/chat/ChatShell.tsx` — `AccountMenu` (lines 649-726) is the
  dropdown pattern we mirror
