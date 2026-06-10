// End-to-end eval: runs the canonical demo queries through the REAL model +
// tools + P21 (the same code path as /api/chat) and FAILS if any query returns
// a blank answer, hits the step cap (a loop), or can't ground its answer because
// every tool call errored. This is the net that catches query-generation
// regressions — e.g. the OData date-literal bug, where every date-ranged query
// silently failed — BEFORE they reach users. Run after a deploy, or against a
// Vercel preview before merging.
//
//   npm run eval                       # all canonical queries
//   npx tsx scripts/eval.ts "your q"   # one ad-hoc query
//
// Uses .env.local (OpenAI key, droplet proxy creds). Hits LIVE P21 and spends a
// little model budget, so run it deliberately, not on every commit.
//
// NOTE: env must load BEFORE the app modules — tools.ts captures the proxy creds
// at module-load time, so we dotenv first and import the app via dynamic import.
import { config } from "dotenv";
config({ path: ".env.local" });

const STEP_CAP = 10;

// Accuracy-regression probes — the question classes that used to return a
// confident wrong number (the CEO's "$20k largest order"). These exercise the
// aggregate tool + the "Accuracy guardrails" prompt rules end-to-end. Liveness
// is the automated bar here too (a non-blank, grounded answer that didn't loop);
// eyeball the previews to confirm the model routed to aggregate / invoice_hdr /
// availability math and disclosed partial or access-limited results rather than
// inventing a number. Kept separate from SUGGESTION_POOL so the demo chips stay
// curated.
const ACCURACY_PROBES = [
  "What's our largest order?",
  "What's our biggest invoice?",
  "How many open sales orders do we have right now?",
  "What did we invoice in total over the last 30 days?",
  "Who are our top 5 customers by invoiced revenue?",
  "How many of 31C100SHCS can we actually ship right now?",
  // Grain / sentinel / dead-stock class (the per-location dead-stock bug):
  // eyeball that the model rolls up locations, treats a 1990 last_sale_date as
  // "never sold" (no fabricated age), and doesn't list per-location phantoms.
  "Show me our top 10 dead stock items and how long they've been sitting unsold.",
  "Which parts are out of stock at every location?",
  "When did 4007JS16-16SS last sell, and do we have any on hand right now?",
];

const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

type Row = {
  q: string;
  pass: boolean;
  steps: number;
  ok: number;
  errs: number;
  reason: string;
  preview: string;
};

async function main() {
  // Dynamic imports: app modules load AFTER dotenv has populated process.env.
  const { generateText, stepCountIs } = await import("ai");
  const { getGenerationParams, getModel, getModelId } = await import("../src/lib/ai/model");
  const { SYSTEM_PROMPT } = await import("../src/lib/ai/system-prompt");
  const { buildTools } = await import("../src/lib/ai/tools");
  const { SUGGESTION_POOL } = await import("../src/lib/suggestions");

  const STUB_CATALOG = { scopes: new Map(), viewToScope: new Map(), entityToScope: new Map() };
  const SYSTEM =
    `Today is ${TODAY} (Pacific time, America/Los_Angeles). Use this as the anchor ` +
    `for any relative date filter ("today", "this week", "last N days", etc.).\n\n` +
    SYSTEM_PROMPT;

  async function runOne(q: string): Promise<Row> {
    try {
      const gen = getGenerationParams();
      const res = await generateText({
        model: getModel(),
        system: SYSTEM,
        prompt: q,
        tools: buildTools("all", STUB_CATALOG as never),
        temperature: gen.temperature,
        maxOutputTokens: gen.maxOutputTokens,
        providerOptions: gen.providerOptions,
        stopWhen: stepCountIs(STEP_CAP),
        prepareStep: ({ stepNumber }: { stepNumber: number }) =>
          stepNumber >= STEP_CAP - 1 ? { toolChoice: "none" } : {},
      });

      // Count tool results by success/error directly (no regex double-counting).
      let ok = 0;
      let errs = 0;
      for (const step of res.steps) {
        for (const tr of step.toolResults ?? []) {
          const out = (tr as { output?: unknown; result?: unknown }).output ??
            (tr as { result?: unknown }).result;
          if (out && typeof out === "object" && "error" in out) errs++;
          else ok++;
        }
      }
      const steps = res.steps.length;
      const text = res.text.trim();
      const reasons: string[] = [];
      if (!text) reasons.push("blank answer");
      if (steps >= STEP_CAP) reasons.push(`hit step cap (${steps} = likely loop)`);
      // Tried tools but every call failed → answer can't be grounded.
      if (errs > 0 && ok === 0) reasons.push(`all ${errs} tool calls errored`);
      return {
        q,
        pass: reasons.length === 0,
        steps,
        ok,
        errs,
        reason: reasons.join("; ") || "ok",
        preview: text.slice(0, 90).replace(/\s+/g, " "),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { q, pass: false, steps: 0, ok: 0, errs: 0, reason: `threw: ${msg.slice(0, 120)}`, preview: "" };
    }
  }

  const argv = process.argv.slice(2);
  const queries = argv.length ? argv : [...SUGGESTION_POOL, ...ACCURACY_PROBES];
  console.log(`Eval — ${queries.length} queries on ${getModelId()} (today=${TODAY})\n`);

  const rows: Row[] = [];
  for (const q of queries) {
    const r = await runOne(q);
    rows.push(r);
    console.log(`${r.pass ? "✅" : "❌"} [steps ${r.steps}, ok ${r.ok}, err ${r.errs}] ${q}`);
    console.log(`     ↳ ${r.pass ? `${r.preview}…` : r.reason}`);
  }

  const failed = rows.filter((r) => !r.pass);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed.`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((r) => `  - ${r.q} — ${r.reason}`).join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("eval crashed:", e);
  process.exit(1);
});
