# Limitations

Known gaps and caveats that aren't bugs but will bite if forgotten.

## Data-access scopes: catalog is a snapshot, not live

The scope catalog (`scope`, `scope_view`, `scope_entity` tables) is seeded
from `src/lib/scope-defaults.ts`, which is itself derived from
`data/p21-schema.json` — a one-time snapshot of every P21 Data Services view
captured by `scripts/droplet/dump-p21-schema.sh` on the droplet.

**Consequence:** if Olander's P21 schema changes after our last snapshot
(new view added, view renamed, view removed), our catalog will be out of
sync until someone re-syncs it. Concretely:

- **New P21 view appears.** Our catalog doesn't know about it. For non-admins
  it falls through deny-by-default and returns `uncategorized_resource`.
  Admins can still call it (admins bypass all scope checks). The view will
  surface under "Unassigned" at `/admin/scopes` once the next dump runs and
  the seed is regenerated.
- **Existing P21 view is renamed.** Our entry points at the old name, so
  every non-admin call to the new name is denied as uncategorized. Admins
  see no change.
- **P21 view is removed.** Our entry is dead data — it'll never match an
  incoming request, so nothing breaks, but it sits in the catalog forever
  until someone notices.

**Resync procedure** (whoever is on droplet duty):

1. SSH to the droplet.
2. `bash scripts/droplet/dump-p21-schema.sh > /tmp/P21_Schema.md`
3. `scp` it back into the repo as `docs/P21_Schema.md`.
4. Locally: `node scripts/build-p21-catalog.mjs` to regenerate
   `data/p21-schema.json`.
5. Update `src/lib/scope-defaults.ts` to assign any new views to a bucket
   (or leave them to fall under "Unassigned" in the admin UI).
6. Generate + run a migration that re-seeds, or use the "Reset to defaults"
   action at `/admin/scopes` if you're OK losing any admin-side moves.

There's no automated drift detection. We rely on someone noticing
`uncategorized_resource` errors in chat or in logs.

## Data-access scopes: bucket-level enforcement, not column-level

Scope checks operate on whole views, not individual columns. Several
operational P21 views carry margin/cost columns alongside operational
columns — when that happens we have three options, each imperfect:

1. **Keep the view in its operational bucket** — accept that the cost
   columns are readable through a default-on scope. The bucket-level model
   can't selectively hide them.
2. **Move the view to `pricing`** — non-admins lose operational use of the
   view unless explicitly granted pricing access.
3. **Add column-level filtering** — meaningful new feature, not built.

Decisions we've made:

- **`p21_view_lot` lives in `pricing`** (option 2). It carries `sku_cost`
  per lot with no operational justification for non-admin visibility.
  Trade-off: non-admin lot questions ("what lots do we have of part X?")
  now require the opt-in `pricing` scope. Other lot views
  (`p21_view_lot_bin_*`, `p21_view_lot_detail`) stay in `traceability`
  because they carry no cost.

- **`p21_view_invoice_line` / `p21_view_oe_hdr` / `p21_view_oe_line` /
  `p21_view_inv_loc` / `p21_view_transfer_line` / `p21_view_inventory_receipts_line`
  stay in their operational buckets** (option 1). These all carry
  margin-revealing columns (COGS, gross_margin, standard_cost, sku_markup,
  landed_cost, etc.) but moving them to `pricing` would break daily
  operational chat workflows for non-admin reps. Known leak; revisit when
  column-level filtering exists.

## Data-access scopes: catalog ≠ snapshot file (one known case)

The seed catalog includes `pathguide_lot_number_attribute_view`, which is
real and shows up in the P21 schema dump (`docs/P21_Schema.md`). It does
**not** appear in `data/p21-schema.json` because `scripts/build-p21-catalog.mjs`
filters parsed views to canonical `p21_view_*` names only. That filter
exists because `src/lib/ai/tools.ts` applies the same regex to tool input,
so a non-canonical view name can never be called via `viewsQuery` anyway.

Net effect: the entry sits in the catalog as harmless dead data. Don't
remove it without confirming whether the WMS team intends to surface it
via a different tool later.
