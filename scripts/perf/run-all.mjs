// Run every measurement in sequence, then print a combined pass/fail summary against the
// owner budgets. Sequential (not parallel) so the runs don't contend for CPU and skew each
// other. Each sub-runner also writes its own results/<name>.json.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUDGETS } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const START = Date.now();

const TARGETS = [
  ["analyze-bundle.mjs", "bundle.json"],
  ["run-lighthouse.mjs", "lighthouse.json"],
  ["run-runtime-profile.mjs", "runtime-profile.json"],
  ["run-api-latency.mjs", "api-latency.json"],
];

// Delete stale result files up front so a crashed runner can never leave a previous run's
// numbers to be read back as if fresh.
for (const [, out] of TARGETS) rmSync(join(RESULTS, out), { force: true });

let failed = 0;
for (const [script, out] of TARGETS) {
  const r = spawnSync(process.execPath, [join(HERE, script)], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`[all] FAIL: ${script} exited ${r.status}`);
    failed++;
  } else if (!existsSync(join(RESULTS, out))) {
    console.error(`[all] FAIL: ${script} produced no ${out}`);
    failed++;
  }
}

// Read only results this invocation produced (takenAt at/after START); anything older is
// stale and rejected so the summary never mixes runs.
const read = (f) => {
  const p = join(RESULTS, f);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.takenAt && new Date(j.takenAt).getTime() < START - 1000) {
    console.error(`[all] rejecting stale ${f} (takenAt ${j.takenAt} predates this run)`);
    return null;
  }
  return j;
};
const bundle = read("bundle.json");
const lh = read("lighthouse.json");
const rt = read("runtime-profile.json");
const api = read("api-latency.json");

const rows = [];
const push = (budget, measured, pass, emu) => rows.push({ budget, measured, verdict: pass ? "PASS" : "FAIL", emu: emu ? "[EMU]" : "" });

if (lh) push(`TTI ≤ ${BUDGETS.ttiMs} ms`, `${Math.round(lh.medians.ttiMs)} ms`, lh.medians.ttiMs <= BUDGETS.ttiMs, lh.emulationBased);
if (bundle) push(`initial JS ≤ ${BUDGETS.initialJsGzKB} KB gz`, `${bundle.initial.totalGzKB} KB`, bundle.initial.totalGzKB <= BUDGETS.initialJsGzKB, false);
if (lh) push(`Lighthouse mobile ≥ ${BUDGETS.lighthouseMobile}`, `${lh.medians.performanceScore}`, lh.medians.performanceScore >= BUDGETS.lighthouseMobile, lh.emulationBased);
if (rt) push(`pan/zoom ≥ ${BUDGETS.panZoomMedianFps} fps`, `${rt.panZoom.medianFps.median} fps`, rt.panZoom.medianFps.median >= BUDGETS.panZoomMedianFps, rt.emulationBased || rt.softwareWebgl);
if (rt) push(`pan/zoom worst frame ≤ ${BUDGETS.panZoomMaxFrameMs} ms`, `${rt.panZoom.maxFrameMs.median} ms`, rt.panZoom.maxFrameMs.median <= BUDGETS.panZoomMaxFrameMs, rt.emulationBased || rt.softwareWebgl);
if (api) for (const e of api.endpoints) push(`API ${e.endpoint} p95 ≤ ${e.budgetMs} ms`, `cold ${e.coldP95 ?? "—"} ms`, e.coldP95PassesBudget, false);

console.log(`\n================= COMBINED SUMMARY vs OWNER BUDGETS =================`);
if (rt && rt.softwareWebgl) console.log(`  ⚠ WebGL was SOFTWARE (${rt.webglRenderer}) — pan/zoom fps is inflated; real-device re-measure mandatory.`);
for (const r of rows) console.log(`  ${r.verdict === "PASS" ? "✅" : "❌"} ${r.budget.padEnd(34)} ${String(r.measured).padEnd(12)} ${r.emu}`);
const fails = rows.filter((r) => r.verdict === "FAIL").length;
console.log(`\n  ${fails} of ${rows.length} budgets failing. See docs/PERF_AUDIT.md for the gap list.`);
if (rt && !rt.renderFree) console.log(`  ⚠ gesture NOT render-free — investigate.`);
if (failed > 0) {
  console.error(`\n[all] ${failed} runner(s) failed — summary is INCOMPLETE. Exiting non-zero.`);
  process.exit(1);
}
