// Run every measurement in sequence, then print a combined pass/fail summary against the
// owner budgets. Sequential (not parallel) so the runs don't contend for CPU and skew each
// other. Each sub-runner also writes its own results/<name>.json.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUDGETS } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = (script) => {
  const r = spawnSync(process.execPath, [join(HERE, script)], { stdio: "inherit", env: process.env });
  if (r.status !== 0) console.error(`[all] ${script} exited ${r.status}`);
};

run("analyze-bundle.mjs");
run("run-lighthouse.mjs");
run("run-runtime-profile.mjs");
run("run-api-latency.mjs");

const read = (f) => (existsSync(join(HERE, "results", f)) ? JSON.parse(readFileSync(join(HERE, "results", f), "utf8")) : null);
const bundle = read("bundle.json");
const lh = read("lighthouse.json");
const rt = read("runtime-profile.json");
const api = read("api-latency.json");

const rows = [];
const push = (budget, measured, pass, emu) => rows.push({ budget, measured, verdict: pass ? "PASS" : "FAIL", emu: emu ? "[EMU]" : "" });

if (lh) push(`TTI ≤ ${BUDGETS.ttiMs} ms`, `${Math.round(lh.medians.ttiMs)} ms`, lh.medians.ttiMs <= BUDGETS.ttiMs, lh.emulationBased);
if (bundle) push(`initial JS ≤ ${BUDGETS.initialJsGzKB} KB gz`, `${bundle.initial.totalGzKB} KB`, bundle.initial.totalGzKB <= BUDGETS.initialJsGzKB, false);
if (lh) push(`Lighthouse mobile ≥ ${BUDGETS.lighthouseMobile}`, `${lh.medians.performanceScore}`, lh.medians.performanceScore >= BUDGETS.lighthouseMobile, lh.emulationBased);
if (rt) push(`pan/zoom ≥ ${BUDGETS.panZoomMedianFps} fps`, `${rt.panZoom.medianFps} fps`, rt.panZoom.medianFps >= BUDGETS.panZoomMedianFps, rt.emulationBased);
if (rt) push(`pan/zoom worst frame ≤ ${BUDGETS.panZoomMaxFrameMs} ms`, `${rt.panZoom.maxFrameMs} ms`, rt.panZoom.maxFrameMs <= BUDGETS.panZoomMaxFrameMs, rt.emulationBased);
if (api) for (const e of api.endpoints) push(`API ${e.endpoint} p95 ≤ ${e.budgetMs} ms`, `cold ${e.coldP95 ?? "—"} ms`, e.coldP95PassesBudget, false);

console.log(`\n================= COMBINED SUMMARY vs OWNER BUDGETS =================`);
for (const r of rows) console.log(`  ${r.verdict === "PASS" ? "✅" : "❌"} ${r.budget.padEnd(34)} ${String(r.measured).padEnd(12)} ${r.emu}`);
const fails = rows.filter((r) => r.verdict === "FAIL").length;
console.log(`\n  ${fails} of ${rows.length} budgets failing. See docs/PERF_AUDIT.md for the gap list.`);
if (rt && !rt.panZoom.renderFree) console.log(`  ⚠ gesture NOT render-free — investigate.`);
