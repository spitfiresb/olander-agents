# Olander Agents Design Guide

## Philosophy

**"Industrial warmth, modern restraint"**

Internal AI assistant for the Olander team. Tonally + visually aligned with the parent brand (olander.com) without copying its layout — this is a chat product, not a marketing site.

> **Source of truth for tokens / chat-specific decisions:** `docs/plans/Chat_LLM.md` (§ Brand tokens, § Chat-message styling). This file is the *why* and the *brand context*; that file is the *what to ship*.

---

## Core Values

| Value | Description |
|-------|-------------|
| **Brand alignment** | Stay tonally + visually aligned with olander.com without copying its IA |
| **Restraint** | Two warm accents, one typeface, no decorative flourish |
| **Industrial warmth** | Cozy canvas wash + heavy charcoal chrome; long-trusted-supplier feel |
| **Action discipline** | Red is reserved for primary action affordances — never decoration |
| **Plain-spoken** | Lead with the user's outcome, not with our feature |

---

## Typography

### Font Stack

| Purpose | Font | Fallbacks |
|---------|------|-----------|
| **Brand (sans)** | Geist | system-ui, sans-serif |
| **Wordmark** | Inline SVG (`Logo.tsx`) | n/a — not a webfont |

Wired through `--font-brand` (`var(--font-geist-sans)`). Revisit if/when Olander hands us a real typeface.

### Usage Patterns

- **Wordmark**: very heavy weight, tight tracking, all caps — approximated by SVG, not a webfont
- **Section headings**: bold, sentence case
- **Body**: regular, ~16px, 1.5–1.6 line-height
- **Small UI labels (pills, captions)**: regular, slightly tracked

### Rule: ONE TYPEFACE

- No second sans (no Inter for body + Geist for headings)
- No decorative serif anywhere
- No monospace except for code/IDs

---

## Colors

### Palette: Two Warm Accents on Neutral Chrome

| Role | Hex | Where it appears | Token |
|---|---|---|---|
| Brand red | `#EB402E` | Wordmark box, primary CTA, Send button, assistant avatar | `--color-brand-red` |
| Sand / cream | `#E4D9C5` | User message bubble; `/40` for hover states on chips and pills | `--color-brand-sand` |
| Canvas (warm wash) | `#FAF7F1` | App body wash | `--color-brand-canvas` |
| Charcoal | `#2D2E29` | Primary text, sidebar, mobile top bar | `--color-brand-charcoal` |
| Soft ink | `#4A4B46` | Secondary text, captions, typing-indicator dots | `--color-brand-ink-soft` |
| Surface | `#FFFFFF` | Cards, assistant message bubbles, pills, composer | `--color-brand-surface` |

### Text Hierarchy

| Level | Token | Hex |
|-------|-------|-----|
| Primary | `--color-brand-charcoal` | `#2D2E29` |
| Secondary | `--color-brand-ink-soft` | `#4A4B46` |
| On-red (CTAs, wordmark, avatar) | `--color-brand-surface` | `#FFFFFF` |
| On-charcoal (sidebar) | `--color-brand-surface` | `#FFFFFF` (with `/40`–`/60` for muted) |

### Discipline: NO SECOND ACCENT

- Red is reserved for **primary action affordances** (sign-in CTA, Send, error retry link) and for the **brand mark itself** (wordmark box, assistant avatar)
- Sand is the user-message surface; never used for chrome
- Links, hover hints, and most focus rings reuse red or a tint of charcoal — never a new hue

### Note: three slightly-different reds in the wild

| Where | Hex |
|---|---|
| Locked product token (`--color-brand-red`) | `#EB402E` |
| Pixel-sampled from screenshot | ≈ `#EF3E24` |
| Hardcoded in traced reference SVG | `#F03920` |

Visually indistinguishable but not byte-identical. **If the reference SVG is ever used inline in code**, refactor its `<style>` block to use `currentColor` or a CSS var so the red tracks `--color-brand-red`. Flag with the team if/when Olander supplies an authoritative brand color spec.

---

## Geometry

### Border Radius Vocabulary

| Token | Use |
|---|---|
| `rounded-2xl` | Cards, message bubbles, composer |
| `rounded-full` | Pills, circular icon buttons (Send, Stop, Jump-to-latest) |
| `rounded-md` | Standard buttons (Sign in, New chat, mobile plus) |
| `rounded-sm` | Avatar, small focus-ring hit areas |
| `rounded-lg` | Inline alert banners (error retry strip) |

Soft, generous radii. Not sharp like a tech brand; not pillowy like a consumer app.

### Borders

- 1px hairline `charcoal/10` for cards on canvas
- 1px hairline `charcoal/15` for pills (slightly stronger so they read as interactive)
- `white/15` or `white/30` for borders on charcoal chrome

### Shadows

**Soft elevation only on focus surfaces** (sign-in card, composer card). Otherwise flat — separation comes from the canvas/surface tonal shift.

---

## Layout (chat product)

The product is a **two-column app**: a charcoal sidebar (lg+) and a canvas main column. There is no marketing-site IA — no utility strip, no carousel, no category grid. The mobile collapse is the only place a top bar exists.

```
DESKTOP (lg+)
┌──────────────┬────────────────────────────────────────┐
│              │  thin demo-mode pill strip (h-12)      │
│  SIDEBAR     ├────────────────────────────────────────┤
│  charcoal    │                                        │
│  bg          │  message list (max-w-3xl, gap-8)       │
│              │                                        │
│  • Wordmark  │                                        │
│  • New chat  │                                        │
│  • History   │                                        │
│  • Help      │                                        │
│              │  composer (white card, red Send)       │
└──────────────┴────────────────────────────────────────┘

MOBILE / TABLET (< lg)
┌──────────────────────────────────────────────────────┐
│  charcoal top bar:  [Wordmark]   ····    [+ icon]    │
├──────────────────────────────────────────────────────┤
│  message list (max-w-3xl, gap-8)                     │
│  composer (white card, red Send)                     │
└──────────────────────────────────────────────────────┘
```

**Spacing rules:**
- Generous whitespace; let messages breathe
- Modular spacing — 8/16px rhythm; matches Tailwind defaults
- Center-align reserved for hero / empty states only

---

## Components

### Logo / wordmark lockup

```
- Asset: inline SVG (src/components/Logo.tsx), not raster
- Letters: white OLANDER in solid red rectangle, tight + heavy + all caps
- Red: tracks --color-brand-red so palette tweaks don't desync
- Variants: `hero` (sign-in surface), `topbar` (sidebar header + mobile bar)
- Composed with "Agents" — charcoal in light contexts, white on charcoal
- Empty state uses standalone <Logo size="md" /> (no "Agents" label)
```

### Buttons

```
- Primary CTA (sign-in, Send): brand-red surface, white text, no shadow
- Secondary (New chat in sidebar): white-ghost on charcoal — border-white/15
  bg-white/5 text-white. Doc's "charcoal ghost" only applies on canvas; on
  charcoal chrome the same visual logic projects to white/translucent.
- Send (in-chat): circular 40×40 red icon button
- Stop: circular 40×40 charcoal-ghost (white border, charcoal text)
```

### Cards

```
- Surface: white
- Border: 1px charcoal/10 hairline
- Corners: rounded-2xl
- Shadow: soft elevation only on focus surfaces (sign-in card, composer)
```

### Composer

```
- Surface: white card on canvas
- Border: 1px charcoal/15 hairline
- Corners: rounded-2xl
- Focus-within: border shifts to brand-red/40 + 1px ring at brand-red/20
- Send affordance: circular red icon button, right-anchored
- Stop swaps in during in-flight states (same shape, charcoal-ghost)
```

### Message bubbles

```
- User: bg-brand-sand, charcoal text, rounded-2xl, no border, right-aligned, max-w-[75%]
- Assistant: bg-white, charcoal/10 hairline, rounded-2xl, left-aligned, max-w-[90%]
- Both fade in via .animate-message-in (200ms, gated)
- Assistant bubble is paired with the avatar to its left
```

### Avatar

```
- Treatment: 28×28 (h-7 w-7), rounded-sm, bg-brand-red, white "O", font-bold
- Reads as a micro-wordmark — the only place red is used as a surface outside
  the actual wordmark and the Send button
```

### Pills

A small but load-bearing pattern. Used four ways:

```
- Suggestion chips (empty state)
- Demo-mode indicator (desktop top strip)
- Jump-to-latest (anchored over the message list)
- Regenerate / message actions (under the latest assistant turn)

Treatment:
- rounded-full
- bg-white surface
- 1px charcoal/15 hairline
- charcoal text, small (text-xs / text-sm)
- Hover: border deepens to charcoal/30, bg shifts to brand-sand/40
```

### Sidebar (desktop)

```
- Surface: bg-brand-charcoal, full-height
- Width: w-64
- Top: Wordmark (topbar variant), then "+ New chat" button
- Middle: history list (scroll), grouped by recency, white/40 caption labels
- Bottom: pinned "Need help? Contact IT" link
- All text on charcoal: white/60 muted, white on hover
- Dividers: border-white/10
```

### Icons

- Stroke-based, single-color, no fills, no gradients, no perspective
- Match the line-drawing technical-illustration look (closer to mechanical drawings than to default Lucide)
- **Exception:** vendor brand marks are reproduced in their canonical brand colors (e.g. the four-color Microsoft logo on the sign-in CTA). Don't monochrome a vendor mark in the name of style discipline.

---

## Motion & Animation

### Principles

- **Subtle**: state changes only, no decorative motion
- **Reduced-motion aware**: gate animations behind `prefers-reduced-motion: no-preference`

### Timing

| Animation | Duration |
|-----------|----------|
| Message in (fade-up) | 200ms |
| Button hover / focus | 150ms |

> **Implementation note:** `.animate-message-in` is correctly gated in `globals.css`. The typing indicator currently uses Tailwind's `animate-bounce`, which is **not** gated — track as a known gap.

---

## Brand Voice

### Tone

Olander speaks like a long-trusted industrial supplier: confident, plain-spoken, problem-focused. Reflect that in product copy.

### Voice rules

- Short. Active. Concrete.
- Lead with the user's outcome, not with our feature.
- No emoji. No exclamation marks. No marketing-speak ("revolutionize", "next-gen", "AI-powered").
- Use second person ("you") sparingly — Olander tends toward declarative.
- Soften system messages industrial-friendly ("AI service isn't configured yet — contact your admin"), not playful ("Oops! 🤖").

---

## Accessibility

- **Contrast:** charcoal `#2D2E29` on canvas `#FAF7F1` clears AA for body text. Brand red `#EB402E` on white clears AA for large text and UI components but **fails AA for body-size text** — never use it as a paragraph color. White on brand red passes for the wordmark, primary CTAs, and avatar.
- **Focus rings:** three contexts —
  - On canvas: `ring-2 ring-brand-red ring-offset-2` (full red, high visibility)
  - Composer focus-within: `ring-1 ring-brand-red/20` + `border-brand-red/40` (subtle, since the whole card is the affordance)
  - On charcoal chrome: `ring-2 ring-white/40 ring-offset-brand-charcoal` (red is invisible on charcoal — switch to white)
- **Motion:** every animation should be gated behind `prefers-reduced-motion: no-preference`. (See implementation note above re typing indicator.)
- **Targets:** the 40×40 circular Send/Stop buttons sit at the lower bound of WCAG 2.5.5 AAA — do not shrink them further.

---

## Design Checklist

When creating new UI components:

- [ ] Using Geist (`var(--font-brand)`) — no second typeface
- [ ] 1px charcoal/10 hairline border on cards
- [ ] `rounded-2xl` for cards/bubbles, `rounded-full` for pills/icon-buttons, `rounded-md` for standard buttons
- [ ] Soft elevation only on focus surfaces, otherwise flat
- [ ] Red reserved for primary actions and the brand mark — never decoration
- [ ] No second accent color
- [ ] Body color is charcoal `#2D2E29`, not red
- [ ] Focus ring picked for the surface (red on canvas, red/20 inside composer, white/40 on charcoal)
- [ ] Animations gated behind `prefers-reduced-motion: no-preference`
- [ ] No emoji, no exclamation marks, no marketing-speak in copy
- [ ] Vendor brand marks keep their canonical colors

---

## Reference assets

Lives in `brand/` at the project root.

| File | What it is | Notes |
|---|---|---|
| `brand/client_landing_page.png` | full screenshot of olander.com home, 2026-05 | brand context only — not a layout reference for this product |
| `brand/client_logo.svg` | full true lockup (white wordmark in red box), vector | **canonical logo for design work.** Olander never shows the wordmark without the red box, so always reach for this one. |

### Logo asset boundary

`brand/client_logo.svg` is for **design reference only** — pasting into mockups, comparing layouts, etc. The in-app logo is `src/components/Logo.tsx` (inline SVG, color tracks `--color-brand-red`). Don't import the reference SVG into the product; if `Logo.tsx` ever drifts visually, re-trace from the reference, don't link to it.

---

## Key Files

| Purpose | Location |
|---------|----------|
| Brand tokens (canonical) | `docs/plans/Chat_LLM.md` § Brand tokens |
| Chat-specific styling decisions | `docs/plans/Chat_LLM.md` § Chat-message styling |
| Brand tokens (CSS) | `src/app/globals.css` |
| In-app logo (inline SVG) | `src/components/Logo.tsx` |
| Wordmark composition | `src/components/Wordmark.tsx` |
| Reference logo (do not import) | `brand/client_logo.svg` |
| Live brand reference | https://www.olander.com |

---

## Open design questions

- **Typeface.** Geist is a placeholder; if Olander supplies a brand typeface, swap by changing one CSS var.
- **Dark mode.** `globals.css` keeps a `prefers-color-scheme: dark` block but the brand has no dark palette. Open team item.
- **Typing-indicator motion.** `animate-bounce` runs for users with `prefers-reduced-motion: reduce`. Replace with a gated keyframe like `.animate-message-in`.
