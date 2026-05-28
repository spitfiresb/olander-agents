#!/usr/bin/env node
// Parse docs/P21_Schema.md (output of scripts/droplet/dump-p21-schema.sh) into
// data/p21-schema.json — the structured catalog that backs the describeView
// tool and the system-prompt view listing. Re-run whenever P21_Schema.md
// changes.
//
//   node scripts/build-p21-catalog.mjs
//
// Reads:  docs/P21_Schema.md
// Writes: data/p21-schema.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "docs/P21_Schema.md");
const OUT_DIR = join(ROOT, "data");
const OUT = join(OUT_DIR, "p21-schema.json");

const md = readFileSync(SRC, "utf8");

// View sections look like:
//   #### `p21_view_address`  <a id="p21_view_address"></a>
//
//   116 columns. Keys: id.
//
//   | Column | Type | Nullable | Key |
//   |---|---|---|---|
//   | `id` | Decimal | false | ✓ |
//   | `name` | String | false |  |
//   ...
//
// We split on the section header lines, then parse each block's column table.
const sections = md.split(/\n#### `/).slice(1); // first chunk is the preamble

const views = [];
for (const section of sections) {
  // The view name is the chunk up to the closing backtick.
  const nameEnd = section.indexOf("`");
  if (nameEnd === -1) continue;
  const name = section.slice(0, nameEnd);

  // Only keep canonical p21_view_* views — the tool input schema rejects
  // anything else (see SAFE view-name regex in src/lib/ai/tools.ts), so a
  // legacy view like `pathguide_lot_number_attribute_view` would never be
  // callable even if we listed it.
  if (!/^p21_view_[a-z0-9_]+$/i.test(name)) continue;

  const columns = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    // Match: | `col_name` | Type | true|false | ✓ or blank |
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([A-Za-z0-9]+)\s*\|\s*(true|false)\s*\|\s*(✓)?\s*\|$/);
    if (!m) continue;
    columns.push({
      name: m[1],
      type: m[2],
      nullable: m[3] === "true",
      key: m[4] === "✓",
    });
  }

  if (columns.length > 0) views.push({ name, columns });
}

views.sort((a, b) => a.name.localeCompare(b.name));

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(views, null, 2) + "\n");

const totalColumns = views.reduce((acc, v) => acc + v.columns.length, 0);
console.log(`Wrote ${OUT} — ${views.length} views, ${totalColumns} columns.`);
