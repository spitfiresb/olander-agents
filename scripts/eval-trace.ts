// Trace eval: like scripts/eval.ts (real model + tools + live P21, same path as
// /api/chat) but prints the FULL tool-call trace (which view/entity each call
// hit) and answer, and reports STABILITY across repeats. Purpose: measure
// whether the agent reaches the RIGHT view for a question and does so
// consistently, not just whether it returned something. Companion to eval.ts
// for verifying tool-routing whenever the system prompt changes.
//
//   REPEATS=3 CUSTOMER="Acme Inc" OUTFILE=/tmp/stab.txt npx tsx scripts/eval-trace.ts
//   npx tsx scripts/eval-trace.ts "who supplies 31C100SHCS?"     # ad-hoc, 1x
//
// env must load BEFORE app modules — tools.ts captures proxy creds at load.
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";

const STEP_CAP = 10;
const REPEATS = Number(process.env.REPEATS || "1");
const CUSTOMER = process.env.CUSTOMER || "";

const PROBES = [
  `Who's my main contact at ${CUSTOMER}? Give me their phone and email.`,
  `Who are the most recently added contacts for ${CUSTOMER}?`,
  `A customer sent me their part number ABC-123. Whose part is that and what's our item for it?`,
  `What's the supplier part number for 31C100SHCS?`,
  `Who do we buy 31C100SHCS from, and what's the lead time?`,
  `Who's the primary supplier for 4007JS16-16SS?`,
  `What's the lead time on 4007JS16-16SS?`,
  `What accessories or add-ons go with 31C100SHCS?`,
  `What can I substitute for 4007JS16-16SS if it's out of stock?`,
  `Is 31C100SHCS RoHS compliant?`,
  `What are the item classes on 31C100SHCS?`,
  `Has ${CUSTOMER} ever bought 31C100SHCS from us?`,
  `What do we sell ${CUSTOMER} the most?`,
];

type Call = { name: string; view: string; input: string; status: string };
type Row = {
  pass: boolean; steps: number; ok: number; errs: number;
  reason: string; calls: Call[]; answer: string;
};

function short(v: unknown, max = 220): string {
  let s: string;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}
// The view/entity a call targeted — the routing signal we care about.
function callView(name: string, input: unknown): string {
  const i = (input || {}) as Record<string, unknown>;
  if (i.viewName) return String(i.viewName);
  if (i.resource) return `${i.area ?? ""}/${i.resource}`;
  return name; // searchCatalog / searchDocuments have no view
}

async function main() {
  const { generateText, stepCountIs } = await import("ai");
  const { getGenerationParams, getModel, getModelId } = await import("../src/lib/ai/model");
  const { SYSTEM_PROMPT } = await import("../src/lib/ai/system-prompt");
  const { buildTools } = await import("../src/lib/ai/tools");

  const TODAY = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const STUB_CATALOG = { scopes: new Map(), viewToScope: new Map(), entityToScope: new Map() };
  const SYSTEM =
    `Today is ${TODAY} (Pacific time, America/Los_Angeles). Use this as the anchor ` +
    `for any relative date filter ("today", "this week", "last N days", etc.).\n\n` +
    SYSTEM_PROMPT;

  async function runOne(q: string): Promise<Row> {
    const calls: Call[] = [];
    try {
      const gen = getGenerationParams();
      const res = await generateText({
        model: getModel(), system: SYSTEM, prompt: q,
        tools: buildTools("all", STUB_CATALOG as never),
        temperature: gen.temperature, maxOutputTokens: gen.maxOutputTokens,
        providerOptions: gen.providerOptions, stopWhen: stepCountIs(STEP_CAP),
        prepareStep: ({ stepNumber }: { stepNumber: number }) =>
          stepNumber >= STEP_CAP - 1 ? { toolChoice: "none" } : {},
      });
      let ok = 0, errs = 0;
      for (const step of res.steps) {
        const tcs = (step as { toolCalls?: Array<{ toolName: string; input?: unknown; args?: unknown }> }).toolCalls ?? [];
        const trs = (step as { toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }> }).toolResults ?? [];
        for (const tc of tcs) {
          const input = tc.input ?? tc.args;
          const out = trs.find((r) => r.toolName === tc.toolName);
          const o = out?.output ?? out?.result;
          const isErr = o && typeof o === "object" && "error" in (o as object);
          const rows = o && typeof o === "object" && "rows" in (o as object)
            ? (o as { rows?: unknown[] }).rows?.length : undefined;
          if (isErr) errs++; else ok++;
          calls.push({
            name: tc.toolName, view: callView(tc.toolName, input), input: short(input),
            status: isErr ? `ERROR ${short((o as { error?: unknown }).error, 90)}` : `ok${rows !== undefined ? ` (${rows} rows)` : ""}`,
          });
        }
      }
      const steps = res.steps.length, text = res.text.trim();
      const reasons: string[] = [];
      if (!text) reasons.push("blank");
      if (steps >= STEP_CAP) reasons.push(`step cap (${steps})`);
      if (errs > 0 && ok === 0) reasons.push(`all ${errs} calls errored`);
      return { pass: reasons.length === 0, steps, ok, errs, reason: reasons.join("; ") || "ok", calls, answer: text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { pass: false, steps: 0, ok: 0, errs: 0, reason: `threw: ${msg.slice(0, 140)}`, calls, answer: "" };
    }
  }

  // routing signature = sorted unique set of views touched (ignores order/retries)
  const sig = (r: Row) => [...new Set(r.calls.map((c) => c.view))].sort().join(" + ") || "(no tools)";

  const argv = process.argv.slice(2);
  const queries = argv.length ? argv : PROBES;
  const reps = REPEATS;
  console.log(`Stability eval — ${queries.length} probes x ${reps} on ${getModelId()} (today=${TODAY}, customer=${CUSTOMER || "<none>"})\n`);

  const out: string[] = [`# ${getModelId()} today=${TODAY} customer=${CUSTOMER || "<none>"} repeats=${reps}`];
  const summary: string[] = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const runs: Row[] = [];
    for (let r = 0; r < reps; r++) runs.push(await runOne(q));

    const head = `\n[P${qi + 1}] ${q}`;
    console.log(head); out.push(head);
    const sigs = new Set<string>();
    for (let r = 0; r < runs.length; r++) {
      const row = runs[r];
      sigs.add(sig(row));
      const line = `  run${r + 1}: ${row.pass ? "PASS" : "FAIL"} [steps ${row.steps}, ok ${row.ok}, err ${row.errs}] ${row.reason === "ok" ? "" : "(" + row.reason + ")"} routes: ${sig(row)}`;
      console.log(line); out.push(line);
      out.push(...row.calls.map((c, i) => `      [${i + 1}] ${c.name} ${c.input} -> ${c.status}`));
      out.push(`      ANSWER: ${row.answer.replace(/\n/g, " ").slice(0, 400)}`);
    }
    const passes = runs.filter((r) => r.pass).length;
    const steps = runs.map((r) => r.steps).join(",");
    const errs = runs.map((r) => r.errs).join(",");
    const routing = sigs.size === 1 ? `STABLE (${[...sigs][0]})` : `DRIFT: ${[...sigs].map((s) => `{${s}}`).join(" vs ")}`;
    const s = `[P${qi + 1}] liveness ${passes}/${reps} | steps [${steps}] | errs [${errs}] | routing ${routing}`;
    console.log("  => " + s); out.push("  => " + s); summary.push(s);
  }

  const block = "\n===== STABILITY SUMMARY =====\n" + summary.join("\n");
  console.log(block); out.push(block);
  const outfile = process.env.OUTFILE;
  if (outfile) { writeFileSync(outfile, out.join("\n") + "\n"); console.log(`\nwrote ${outfile}`); }
}

main().catch((e) => { console.error("eval-trace crashed:", e); process.exit(1); });
