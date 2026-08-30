// CI initial-JS budget gate (task 017). The DETERMINISTIC half of the
// perf enforcement: it asserts, on the real build, that MapLibre is deferred and the initial
// (critical-path) JS is under the owner budget. It runs the validated bundle instrument
// (analyze-bundle.mjs) against a live `next start` and asserts on its JSON report.
//
// NEVER skip-green: analyze-bundle exits non-zero if the page did not load / Resource Timing
// was empty (a broken instrument is a FAILURE, not a pass), and this gate exits non-zero if that
// spawn fails, if the report is missing, or if any budget/laziness assertion fails. There is no
// "deps missing ⇒ pass" path — an absent browser/harness fails the gate loudly.
//
// Budgets asserted (the deterministic, un-gameable ones — the Lighthouse SCORE is deliberately NOT
// hard-gated here; see perf-lighthouse.mjs and the note on metric-gaming):
//   1. the page emits the hf:interactive boundary (else the deferral regressed and "initial" would
//      silently re-absorb MapLibre — a regression, so fail);
//   2. MapLibre/pmtiles is NOT in the initial set (it must be lazy);
//   3. initial-route JS gz ≤ BUDGETS.initialJsGzKB.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUDGETS } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, "results", "bundle.json");

function fail(msg) {
  console.error(`\n[perf:budget] FAIL — ${msg}`);
  process.exit(1);
}

// (1) Run the bundle instrument against the live server. It hard-exits non-zero on an instrument
// failure (page didn't load / empty timing), which propagates here as a throw → gate FAILS.
try {
  execFileSync("node", [join(HERE, "analyze-bundle.mjs")], { stdio: "inherit" });
} catch {
  fail("the bundle instrument (analyze-bundle.mjs) did not complete — server not up, or Chrome/puppeteer missing. A missing harness is a FAILURE, never a skip.");
}

if (!existsSync(REPORT)) fail(`no report at ${REPORT} — the instrument produced nothing.`);
const r = JSON.parse(readFileSync(REPORT, "utf8"));

const problems = [];
if (!r.boundaryDetected) {
  problems.push("the page emitted NO hf:interactive mark — the map-defer boundary regressed; without it the instrument would count MapLibre as initial. Restore performance.mark('hf:interactive') in the eager shell before the engine import.");
}
if (r.initialHasMaplibre) {
  problems.push("MapLibre/pmtiles is in the INITIAL set — the engine is back on the first-load critical path. Ensure the ONLY value import of maplibre-gl/pmtiles is the dynamic import() inside AppMap's deferred effect (grep: no `from \"maplibre-gl\"` without `import type`).");
}
if (!r.lazyHasMaplibre && !r.initialHasMaplibre) {
  // "off the critical path", not "removed" — the map must still load. If MapLibre is in NEITHER
  // set the engine never loaded (a broken build, or someone gaming the budget by deleting the map),
  // which is a failure, not a pass. This is what keeps the budget honest.
  problems.push("MapLibre is in NEITHER the initial NOR the lazy set — the engine did not load at all. The budget is 'off the critical path', not 'removed': the map must still hydrate. Check the deferred import actually runs.");
}
const budget = BUDGETS.initialJsGzKB;
if (r.initial.totalGzKB > budget) {
  problems.push(`initial-route JS is ${r.initial.totalGzKB} KB gz > ${budget} KB budget. Buckets: ${JSON.stringify(r.initial.byBucketGzKB)}.`);
}

if (problems.length) {
  console.error(`\n[perf:budget] FAIL — ${problems.length} budget violation(s):`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `\n[perf:budget] PASS — initial ${r.initial.totalGzKB} KB gz ≤ ${budget}; MapLibre lazy (boundary @ ${r.markTimeMs} ms); lazy=${r.lazy.totalGzKB} KB.`,
);
