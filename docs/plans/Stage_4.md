# Stage 4 — Chat-header dropdown + empty-state polish + tool-result actions

**Status (2026-05-19):**
- **4a — Chat-header dropdown — shipped** (`bd4cac6` refactor + `99cbabc` feature)
- **4b — Empty-state recent-conversation cards — shipped** (`61c164a` API snippet + `ba0d48f` UI)
- **Maintenance fix in flight:** `5a188bf` (idempotent user-message insert on retry)
- **4c — Tool-result actions — planned, awaiting C1–C5 ratification.** Two-commit plan; no DB migration; no new deps; ~25 unit tests on the serializers.

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

## Stage 4b — Empty-state polish

**Status:** shipped 2026-05-19. Commits `61c164a` (API snippet) + `ba0d48f` (UI).

### Deliverable

Returning rep on `/chat` sees their **six most-recent chats as cards**
(title + first-question snippet + relative time + pin glyph if pinned)
above the existing suggestion chips. Clicking a card resumes. New users
with zero history see the existing cold-start view unchanged.

### Decisions (locked)

| Question | Answer | Reason |
|---|---|---|
| Card count | 6 (2 cols × 3 rows on `sm+`) | A day's worth of recent work without scrolling on most laptops |
| Snippet content | First user-message text, LEFT 220 chars server-side, CSS line-clamp-2 client-side | It's the *question* — what reps need to recognize. Stable across the chat's life. |
| Section header above cards | Small uppercase `RECENT` label (matches sidebar group caption style) | Already in the design vocabulary |
| Suggestion chips when history exists | Kept below the cards under a small `Or try` label | Frames the chips as a secondary fallback rather than a competing surface |
| Cold-start view (zero history) | Untouched from pre-4b | New-user UX is on-brand; clutter not earned. Polish note carried into Stage 5 — see "Cold-start polish" below |
| Card order | Pinned first, then `updatedAt` desc | Same as sidebar — one ordering across all surfaces |
| Pin glyph on card | Yes, top-right corner when pinned (filled glyph) | Same signal as the sidebar's pinned rows |
| Click target | Full card is one `<Link href="/chat/{id}">` | Native browser semantics; middle-click opens a new tab |
| Relative time format | "just now" / "X min ago" / "X hr ago" / "Yesterday" / "X days ago" / "MMM D" / "MMM YYYY" beyond a year | Reads like a person talks; absolute dates after a week |
| Snippet missing (attachment-only first message) | Skip the snippet line; title + time render alone | Sparse is fine, no placeholder needed |
| Locale | en-US pinned | Olander reps are English-speaking; avoids SSR/CSR hydration mismatches |
| New deps | None | Hand-rolled relative-time helper; native Intl.DateTimeFormat |

### Files

#### Created
| Path | Purpose |
|---|---|
| `src/lib/relative-time.ts` | `formatRelativeTime(iso, now?)` — pure function with injectable clock for testability |
| `src/lib/__tests__/relative-time.test.ts` | 8 tests covering every bucket boundary + future-timestamp clamp |
| `src/app/chat/RecentChatsGrid.tsx` | Grid + card component; consumes `ConversationSummary[]`; slices to `limit` (default 6) |

#### Modified
| Path | What changed |
|---|---|
| `src/lib/conversations.ts` | `listConversations` and `searchConversations` now select an extra `snippet` column via a correlated subquery on the oldest non-superseded user message's `searchText`, capped `LEFT 220` |
| `src/app/chat/Sidebar.tsx` | `ConversationSummary` type widened with `snippet: string \| null` — sidebar doesn't render it, just propagates |
| `src/app/chat/EmptyState.tsx` | Split into `ColdStartView` (today's exact JSX) + `WarmStartView` (logo + RECENT label + grid + "Or try" label + chips). Branch on `conversations.length === 0` |
| `src/app/chat/MessageList.tsx` | Accepts `conversations: ConversationSummary[]`; forwards to `<EmptyState>` |
| `src/app/chat/ChatShell.tsx` | Passes `conversations={conversations}` into `<MessageList />` |

### Behavioral diff (what changes for the rep)

| Scenario | Before | After |
|---|---|---|
| Resume yesterday's lookup | Open sidebar → scroll → click | One card-click on the main surface |
| Brand-new rep | Logo + 4 chips | Identical (unchanged) |
| Mobile rep | Hamburger → drawer → scroll → tap | Three cards visible above the fold |

### Edge cases handled

| Case | Behavior |
|---|---|
| `conversations` empty during initial fetch | ColdStartView renders briefly until refresh completes; minor visual flicker, accepted for v1 |
| Conversation with only attachments | Snippet line collapses; title + time only |
| Future timestamp (clock skew) | Clamped to "just now" |
| Long title / snippet | Truncate at single line / `line-clamp-2` |
| Pinned chat from a month ago | Floats to top with pin glyph; relative time still honest ("May 12") |

### Testing

- 8 new tests on `formatRelativeTime` (bucket boundaries, future timestamps)
- All existing tests still pass (108 total, up from 100 after Stage 4a)
- Browser smoke checklist: new chat → cards visible; pin → glyph appears + card reorders; long title truncates; mobile narrows to single column; click → resumes

### Carry-forward note: Cold-start polish (Stage 5)

User flagged 2026-05-19 that the cold-start view "could be improved"
but agreed to defer alongside other Stage 5 chrome polish. When
revisiting: consider whether the "How can I help today?" greeting +
generic suggestion chips is the right onboarding for a first-time rep,
or whether a more guided / branded first-run experience earns its keep.
**Out of 4b scope; do not touch in 4b.**

---

## Stage 4c — Tool-result actions

**Status:** planned 2026-05-19, awaiting user ratification of C1–C5
(see end of this section). Two-commit execution plan; ~25 unit tests;
no new deps; no DB migration.

### Deliverable

When a tool-call card succeeds and has tabular data, expanding it
reveals three small pill buttons — **CSV / TSV / MD** — above the
result table. One click copies the result in that format to the rep's
clipboard. Reps can paste a P21 query result straight into Excel
(CSV/TSV), Outlook (MD), or Slack (MD) without re-typing or
screenshotting.

### Decisions (recommended; awaiting ratification)

| Question | Recommendation | Why |
|---|---|---|
| Button location | Expanded body, above the `DetailTable`, right-aligned | Rep has already chosen to look at the data before they need to copy it — collapsed card is for scanning, expanded is for action |
| Visible when | Only when card is expanded AND tool succeeded AND extractable rows exist | Hide when collapsed (signal-vs-noise), hide on error (no data), hide on non-tabular result |
| Button style | Text-labeled pills, `text-xs`, charcoal text, `border-charcoal/15` hairline, `hover:bg-brand-sand/40` | Matches DESIGN.md pill vocabulary already used for jump-to-latest / regenerate |
| Format set | CSV, TSV, Markdown — three buttons, no implicit default | Each has a distinct paste target; no point hiding two behind a menu |
| Click feedback | Button label flips to "Copied" for 1.5s then reverts | Standard pattern; one focal point per button rather than a global toast |
| `entityGet` handling | Wrap single object in 1-row array, serialize normally; also surfaces it in the existing DetailTable (small UX upgrade) | Reps occasionally want full customer/part record as one-row CSV; bundling the extension is cheap |
| `searchCatalog.score` column | Include in copied output | Information the rep can use; trivial to strip on paste if not wanted |
| Errors / pending / empty result | No buttons shown | Nothing to copy |
| Clipboard API failure | Silent — button just doesn't flip to "Copied" | Modern browsers grant write access on user gesture; rare failure path doesn't warrant UI |
| Mobile | Same buttons, same behavior (no hover-required interaction) | Buttons sit in expanded body, always-visible there |
| Position when table is truncated to 5 of N rows | Buttons copy ALL rows, not just the visible 5 | Reps want the full dataset, not a preview |
| Markdown front-matter (timestamp, tool name) | Skip — just the table | Rep can prepend context when pasting |

### Visual diff

```
Today (expanded card):              After 4c (expanded card):
┌──────────────────────────┐         ┌──────────────────────────┐
│ ✓ Inventory query     ▲ │         │ ✓ Inventory query     ▲ │
│   Found 12 rows          │         │   Found 12 rows          │
├──────────────────────────┤         ├──────────────────────────┤
│ View   p21_view_inv_mast │         │ View   p21_view_inv_mast │
│ Filter startswith…       │         │ Filter startswith…       │
│                          │         │                          │
│ [table — 5 of 12 rows]   │         │     [CSV] [TSV] [MD]  ← new
│                          │         │ [table — 5 of 12 rows]   │
└──────────────────────────┘         └──────────────────────────┘
```

After clicking a button, its label flips to "Copied" for 1.5s.

### Files

#### Create
| Path | Purpose | LOC |
|---|---|---|
| `src/lib/tool-result-format.ts` | `toCsv(rows)`, `toTsv(rows)`, `toMarkdown(rows)` + cell-format + header-collection helpers | ~80 |
| `src/lib/__tests__/tool-result-format.test.ts` | ~25 unit tests on escape rules, empty arrays, mixed-shape rows, null/Date/nested-object cells | ~120 |

#### Modify
| Path | What changes |
|---|---|
| `src/components/chat/ToolCallCard.tsx` | Extend `extractRows` to wrap `entityGet`'s single-object output in a 1-row array; add `CopyRow` + `CopyButton` internal components; render `<CopyRow rows={rows} />` above `<DetailTable>` in the expanded conditional |

#### Don't touch
- API routes, tool definitions (`src/lib/ai/tools.ts`), chat route — copy is pure client-side
- DB schema — no migration
- `ResultsTable.tsx` — visual table renderer is fine as-is
- 4a's `ChatHeader.tsx` / 4b's `RecentChatsGrid.tsx` — orthogonal

### Serializer details

**Header collection.** First row's keys = canonical order; later rows' new keys appended in first-seen order. Stable + intuitive.

**Cell formatting.** Strings passthrough; numbers/booleans via `String(value)`; null/undefined → empty; Date → `.toISOString()`; nested objects/arrays → compact `JSON.stringify`.

**Escape rules.**
- **CSV (RFC 4180):** if cell contains `,` `"` `\n` or `\r`, wrap in `"…"` and double internal `"`
- **TSV (Excel-paste):** collapse tabs/CR/LF inside cells to a single space (no quoting; tabs would break columns)
- **Markdown (GFM):** escape pipes as `\|`; collapse CR/LF to a single space (newlines break the row)

**Empty array.** All three serializers return `""`. The gate in `ToolCallCard` (`rows.length > 0`) prevents an empty button row anyway; serializers handle it defensively.

### Component shape

`CopyRow` (internal to `ToolCallCard.tsx`):

```tsx
function CopyRow({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-3 flex justify-end gap-1.5">
      <CopyButton label="CSV" build={() => toCsv(rows)} />
      <CopyButton label="TSV" build={() => toTsv(rows)} />
      <CopyButton label="MD"  build={() => toMarkdown(rows)} />
    </div>
  );
}
```

`CopyButton` carries its own `copied` state, 1.5s timeout, and an `aria-label` (verbose form so screen readers don't read "MD" as a meaningless abbreviation). `build` is a thunk so we don't run all three serializers eagerly on every render. Button has a `min-w-[3.5rem]` so the row doesn't reflow when the label flips to "Copied".

### Result-shape extraction

Extend `extractRows` to also wrap `entityGet`'s single-object output:

```ts
function extractRows(output: unknown): Row[] | null {
  if (!output || typeof output !== "object") return null;
  if ("error" in output) return null;
  if ("rows" in output && Array.isArray((output as { rows?: unknown }).rows)) {
    return (output as { rows: Row[] }).rows.filter(isPlainObject);
  }
  if ("matches" in output && Array.isArray((output as { matches?: unknown }).matches)) {
    return (output as { matches: Row[] }).matches.filter(isPlainObject);
  }
  // entityGet returns a single record; wrap it.
  if (!Array.isArray(output) && Object.keys(output).length > 0) {
    return [output as Row];
  }
  return null;
}
```

Side benefit: the existing `DetailTable` will now render `entityGet` results as a 1-row table (today they don't render at all). Small UX upgrade bundled in.

### Edge cases

| Case | Behavior |
|---|---|
| Tool still streaming | No buttons (state !== "success") |
| Tool errored | No buttons |
| Result `{ rows: [] }` | No buttons (rows.length === 0) |
| Result `{ rows: [...one row...] }` | Buttons present; serializers emit 1-row output |
| `entityGet` succeeded | Wrapped → 1-row table + buttons |
| Cell contains `,` `"` `\n` `\|` | Format-specific escape rules apply |
| Cell is `null` / `undefined` / Date / nested object | Cell-formatter handles each |
| Rows have inconsistent keys | Headers are union (first-row order, then new-key insertion order); missing cells empty |
| Very large result (>1000 rows) | Clipboard handles up to ~10 MB; comfortably under that |
| Clipboard permission denied | Silent — button doesn't flip to "Copied" |
| User collapses card mid-"Copied" state | Component unmounts; state gone; harmless |

### Dependencies

**No new npm packages.** Hand-rolled serializers; native `navigator.clipboard`; existing Tailwind tokens.

### Commit plan

1. **`feat(chat): tool-result format serializers`** — `tool-result-format.ts` + ~25 unit tests. No UI shift; nothing imports it yet.
2. **`feat(chat): copy CSV/TSV/markdown buttons on tool-result cards`** — `ToolCallCard.tsx` extension + browser smoke.

### Testing

#### Vitest (added, ~25 tests)
- CSV: simple table, comma in cell (quote-wrap), embedded `"` (doubled), newline in cell (quote-wrap), null/undefined → empty, Date → ISO, nested object → JSON.stringify, empty array → "", mixed-shape rows → union headers
- TSV: tab/newline in cells → space; otherwise CSV-like coverage
- Markdown: 3-row table renders with header divider, pipe escape, newline collapse, empty array → ""
- Helpers: `collectHeaders` (insertion-order union), `formatCell` (per-type expected output)

#### Vitest (regression)
- All current tests pass after the `extractRows` extension

#### Browser smoke (local, no Vercel preview)
1. `viewsQuery` returning multiple rows → expand → CSV/TSV/MD buttons appear above the table
2. CSV → paste into Excel → columns split, commas inside cells (e.g., addresses) stay intact
3. TSV → paste into Excel → same column structure; numbers preserve format
4. MD → paste into markdown preview / Slack / VS Code → renders as table with header divider
5. `entityGet` → expand → buttons present → copy → single-row table
6. Force tool error → expand → no buttons
7. Mid-stream → no buttons
8. Two-button quick clicks → both work; independent "Copied" states
9. Collapse card → buttons gone
10. Mobile breakpoint → buttons visible, tap works

### Open questions (C1–C5 — awaiting user ratification)

**C1.** Buttons in collapsed card too, or expanded-only? — recommend **expanded-only**.

**C2.** Position above the table — right-aligned, left-aligned, or centered? — recommend **right-aligned**.

**C3.** Markdown front-matter (one-line `<!-- tool — date -->` at top of MD copy)? — recommend **skip; minimal output**.

**C4.** "Download as CSV" option for large results? — recommend **skip for v1; clipboard handles up to ~10 MB**.

**C5.** Bundle the `entityGet → 1-row table` extension into commit 2, or split first? — recommend **bundle; copy buttons need the extension anyway, and a 1-row table is a UX win worth landing together**.

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
