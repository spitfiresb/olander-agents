# Sanitization

This repository is a public extract of a private client project. The
application code, architecture, tests, and engineering documentation are intact.
Material that belongs to the client, or that would help someone reach their
systems, has been removed — from the working tree **and from the full git
history**, not just from the latest commit.

Nothing here is a security control. It is a confidentiality boundary: the
client owns their data model, their commercial rules, and their trademarks, and
none of those are mine to publish.

## Removed entirely

| What | Why |
|---|---|
| `docs/P21_API.md` | Reverse-engineered behavior of the client's specific Prophet 21 install, including undocumented quirks. Real work, but theirs. |
| `docs/P21_Schema.md` | 5,800-line human-readable schema dump taken from their instance. The machine-readable subset the app needs is kept (see below). |
| `docs/OLANDER_REQUESTS.md` | The client's internal feature requests and complaints. |
| `docs/Assignments.md` | Internal task assignments naming outside contacts. |
| `brand/` and `design references/` | The client's logo and screenshots of their marketing site, at both paths the assets ever lived at. Their trademarks. |
| `src/lib/ai/system-prompt.ts` | ~880 lines encoding their pricing and margin policy, per-view column hints tuned against live data, and a domain reference section. Replaced with a generic stand-in — see below. |

## Redacted in place

Hostnames, IP addresses, and infrastructure identifiers are replaced with
named placeholders (`<p21-host>`, `<proxy-ip>`, `<neon-project-id>`,
`<p21-database>`, and similar). The runbooks remain usable by anyone holding
the real values.

The client's hosting vendor and the individuals named in planning documents
are referred to generically. Contact addresses point at `example.com`.

No credentials were ever committed to this repository — verified across all
183 commits of the original history. There is nothing here to rotate.

## Replaced with a stand-in

**`src/lib/ai/system-prompt.ts`** — the production prompt was the single
densest piece of client IP in the project. The published version keeps the
module's interface (`SYSTEM_PROMPT`), the six-tool contract, the accuracy
guardrails, and the answer discipline, so the chat route still builds and runs
and the approach is legible. It is deliberately generic and is **not** the
prompt that shipped.

**`src/components/Logo.tsx`** and **`src/app/icon.svg`** — the shipped
component drew the client's registered wordmark as traced SVG paths, and the
favicon was their icon mark. Both are trademarks. The stand-ins keep the same
props, viewBox, and brand-red field, setting the name in a generic sans-serif
instead of the protected letterforms, so `Wordmark`, `TopRightLogo`,
`EmptyState`, and `/status` all lay out unchanged.

**Example SKU** — the canonical part number used throughout the tests and docs
was a real item from the client's catalog. It is replaced with a synthetic SKU
of the same shape (`PN12345-01`), consistently, so the fixtures still exercise
the alphanumeric-with-hyphen parsing they were written for.

## Deliberately kept

**`data/p21-schema.json`** is retained. It is worth explaining why, since it
looks like the most sensitive file in the repository and is not:

- Every column in it is stock Epicor Prophet 21 — `customer_id`,
  `customer_disc_pct`, and so on. A scan for user-defined or custom fields
  returns nothing. This is the ERP vendor's published data model, identical
  across every P21 installation, not anything the client invented.
- All 117 views are referenced by the application. The data-access scope
  catalog in `src/lib/scope-defaults.ts` assigns each one to a named scope, so
  trimming the file breaks the authorization model it drives.
- `src/lib/ai/__tests__/p21-fields.test.ts` scans the bundled schema and
  asserts that every cost, margin, profit, and COGS `Decimal` column is
  redacted — 69 of them. That test is the regression net for a real data-leak
  class, and it only works against a complete schema.

Removing it would have cost a security test and a working authorization model
to hide a commercial product's public data model.

## History

The git history is preserved — 178 commits, and contributor credit is intact.
Commits that touched only removed files were dropped, so the count is slightly
lower than the private repository's 183.
