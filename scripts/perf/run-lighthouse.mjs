// Lighthouse mobile (deliverable 1). Runs the Lighthouse "mobile" preset (Moto G-class:
// 4x CPU slowdown + Slow 4G, simulated) against the main map flow and reports the median
// of N runs for Performance score, TTI, LCP, TBT, CLS (+ FCP, Speed Index for context).
//
// Emulated (default): launches a local headless Chrome and lets Lighthouse apply its
// standard mobile emulation. Real device (PERF_DEVICE=real): points Lighthouse at the
// device's adb-forwarded remote-debugging port and uses the device's REAL conditions
// (screenEmulation disabled, throttlingMethod 'provided') — see README.
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TARGET_URL, RUNS, IS_REAL_DEVICE, CDP_PORT, BUDGETS, median } from "./config.mjs";
import { webglRenderer } from "./browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const METRICS = [
  ["performanceScore", (lhr) => Math.round((lhr.categories.performance.score ?? 0) * 100)],
  ["ttiMs", (lhr) => lhr.audits["interactive"]?.numericValue ?? NaN],
  ["lcpMs", (lhr) => lhr.audits["largest-contentful-paint"]?.numericValue ?? NaN],
  ["tbtMs", (lhr) => lhr.audits["total-blocking-time"]?.numericValue ?? NaN],
  ["cls", (lhr) => lhr.audits["cumulative-layout-shift"]?.numericValue ?? NaN],
  ["fcpMs", (lhr) => lhr.audits["first-contentful-paint"]?.numericValue ?? NaN],
  ["speedIndexMs", (lhr) => lhr.audits["speed-index"]?.numericValue ?? NaN],
];

async function oneRun(port) {
  const opts = {
    port,
    output: "json",
    logLevel: "error",
    onlyCategories: ["performance"],
    formFactor: "mobile",
  };
  if (IS_REAL_DEVICE) {
    // Use the real device's actual screen + network; don't double-emulate.
    opts.screenEmulation = { disabled: true };
    opts.throttlingMethod = "provided";
  }
  const runnerResult = await lighthouse(TARGET_URL, opts);
  return runnerResult.lhr;
}

async function main() {
  let chrome = null;
  let port = CDP_PORT;
  if (!IS_REAL_DEVICE) {
    chrome = await launch({
      chromeFlags: ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    port = chrome.port;
  }

  // Record the WebGL renderer once (software rasterization on a display-less host inflates
  // paint-bound metrics like LCP/TBT). Best-effort; never blocks the run.
  let gl = { renderer: "unknown", software: null };
  if (!IS_REAL_DEVICE) {
    try {
      const b = await puppeteer.connect({ browserURL: `http://localhost:${port}`, defaultViewport: null });
      const pg = (await b.pages())[0] ?? (await b.newPage());
      gl = await webglRenderer(pg);
      b.disconnect();
    } catch {}
  }

  const runs = [];
  let failedRuns = 0;
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`[lighthouse] run ${i + 1}/${RUNS} ...\n`);
    const lhr = await oneRun(port);
    // A run that errored (Lighthouse `runtimeError`, or a null category score) must NOT be
    // scored as a real 0 and folded into the median — drop it and count the failure.
    if (lhr.runtimeError || lhr.categories?.performance?.score == null) {
      failedRuns++;
      process.stderr.write(`           run FAILED (${lhr.runtimeError?.code ?? "null score"}) — excluded\n`);
      continue;
    }
    const row = {};
    for (const [k, f] of METRICS) row[k] = f(lhr);
    runs.push(row);
    process.stderr.write(
      `           perf=${row.performanceScore} TTI=${Math.round(row.ttiMs)}ms LCP=${Math.round(row.lcpMs)}ms TBT=${Math.round(row.tbtMs)}ms CLS=${row.cls?.toFixed?.(3)}\n`,
    );
  }
  if (runs.length === 0) {
    console.error(`[lighthouse] all ${RUNS} runs failed — no reliable result. Exiting non-zero.`);
    if (chrome) await chrome.kill();
    process.exit(1);
  }

  const medians = {};
  for (const [k] of METRICS) medians[k] = median(runs.map((r) => r[k]).filter((v) => Number.isFinite(v)));

  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    device: IS_REAL_DEVICE ? "real-android (provided throttling)" : "emulated (Lighthouse mobile preset: Moto G-class, 4x CPU, Slow 4G, simulated)",
    emulationBased: !IS_REAL_DEVICE,
    webglRenderer: gl.renderer,
    softwareWebgl: gl.software,
    completedRuns: runs.length,
    failedRuns,
    reliable: failedRuns === 0,
    runs,
    medians,
    budgets: { ttiMs: BUDGETS.ttiMs, lighthouseMobile: BUDGETS.lighthouseMobile },
    verdicts: {
      lighthouseMobile: { value: medians.performanceScore, budget: BUDGETS.lighthouseMobile, pass: medians.performanceScore >= BUDGETS.lighthouseMobile },
      tti: { valueMs: Math.round(medians.ttiMs), budgetMs: BUDGETS.ttiMs, pass: medians.ttiMs <= BUDGETS.ttiMs },
    },
  };

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "lighthouse.json"), JSON.stringify(report, null, 2));

  console.log(`\n=== LIGHTHOUSE MOBILE (median of ${RUNS}) — ${report.device} ===`);
  console.log(`Performance score : ${medians.performanceScore}   (budget ≥${BUDGETS.lighthouseMobile} → ${report.verdicts.lighthouseMobile.pass ? "PASS" : "FAIL"})`);
  console.log(`TTI               : ${Math.round(medians.ttiMs)} ms  (budget ≤${BUDGETS.ttiMs} → ${report.verdicts.tti.pass ? "PASS" : "FAIL"})`);
  console.log(`LCP               : ${Math.round(medians.lcpMs)} ms`);
  console.log(`TBT               : ${Math.round(medians.tbtMs)} ms`);
  console.log(`CLS               : ${medians.cls?.toFixed?.(3)}`);
  console.log(`FCP / SpeedIndex  : ${Math.round(medians.fcpMs)} ms / ${Math.round(medians.speedIndexMs)} ms`);
  if (!IS_REAL_DEVICE) console.log(`WebGL renderer   : ${gl.renderer}${gl.software ? "  ⚠ SOFTWARE (inflates paint-bound metrics)" : ""}`);
  if (report.emulationBased) console.log(`[EMU] emulation-based — re-measure on a real Android (see README).`);
  console.log(`Wrote ${join(outDir, "lighthouse.json")}`);

  if (chrome) await chrome.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
