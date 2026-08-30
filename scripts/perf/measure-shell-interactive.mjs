// Shell-interactive vs map-visible measurement (task 017).
//
// Design note: the map loads UNPROMPTED (auto-load) — interaction-gating just to make Lighthouse
// green is metric-gaming and this project does not do it. The Lighthouse TTI budget (≤2.5 s) is
// reported as MISSED under auto-load, because the 327 KB engine still parses on the 4×-throttled
// main thread inside the interactive window. But the budget's INTENT was "the user can interact
// within 2.5 s", and with MapLibre deferred behind the paint-fast shell that is now TRUE: the
// search box is usable long before the map finishes loading. This probe reports that intent
// honestly, as two separable numbers under the SAME mobile emulation Lighthouse uses:
//
//   shell-interactive      — `hf:interactive` mark: the shell has hydrated and the search box is
//                            wired + typeable. This is the "can the user act?" number.
//   map-visible-unprompted — `hf:map-ready` mark: the deferred engine has loaded and the map is
//                            visible, with NO interaction driven (auto-load).
//
// Runs unchanged on a real Android (PERF_DEVICE=real) — the two real-device follow-ups the owner
// asked to record: shell-interactive ≤2.5 s and map-visible-unprompted ≤4 s.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openBrowser, closeBrowser, webglRenderer } from "./browser.mjs";
import { TARGET_URL, RUNS, DEVICE, median } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

async function markMs(page, name) {
  return page.evaluate((n) => {
    const m = performance.getEntriesByName(n, "mark")[0];
    return m ? m.startTime : null;
  }, name);
}

async function oneRun() {
  const ctx = await openBrowser();
  const { page } = ctx;
  try {
    await page.setCacheEnabled(false);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // shell-interactive: the combobox HTML is server-rendered and a native <input> accepts text
    // even before React hydrates, so "can I type" does NOT prove interactivity. The honest signal
    // is the `hf:interactive` mark — it is emitted by a React EFFECT, so its presence PROVES the
    // client bundle hydrated and effects ran (search handlers attached). Wait for it, then read
    // its startTime (relative to navigation). Corroborate that typing now drives React: ≥3 chars
    // must open the suggestion listbox (a wired handler, not native input behaviour).
    await page.waitForSelector('input[role="combobox"]', { timeout: 30000 });
    await page.waitForFunction(
      () => performance.getEntriesByName("hf:interactive", "mark").length > 0,
      { timeout: 30000 },
    );
    const shellInteractive = await markMs(page, "hf:interactive");
    let typeable = false;
    try {
      await page.click('input[role="combobox"]');
      await page.type('input[role="combobox"]', "Uni");
      await page.waitForSelector('[role="listbox"], [role="option"]', { timeout: 8000 });
      typeable = true;
      await page.$eval('input[role="combobox"]', (el) => { el.value = ""; });
    } catch {
      typeable = false; // suggest may be stubbed off / network slow; the mark is the primary signal
    }

    // map-visible-unprompted: NO interaction is driven toward the map — wait for the auto-load to
    // finish and read hf:map-ready. (The type above is into the search box; auto-load does not
    // depend on it, and clicking the input does not touch the map canvas.)
    await page.waitForSelector('[data-testid="app-map"][data-map-loaded="true"]', { timeout: 60000 });
    const mapVisible = await markMs(page, "hf:map-ready");

    const gl = await webglRenderer(page);
    return { shellInteractive, mapVisible, typeable, software: gl.software, renderer: gl.renderer };
  } finally {
    await closeBrowser(ctx);
  }
}

async function main() {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`[shell-interactive] run ${i + 1}/${RUNS} ...\n`);
    runs.push(await oneRun());
  }
  const shell = runs.map((r) => r.shellInteractive).filter((x) => x != null);
  const mapv = runs.map((r) => r.mapVisible).filter((x) => x != null);
  const allTypeable = runs.every((r) => r.typeable);
  const report = {
    takenAt: new Date().toISOString(),
    device: DEVICE,
    target: TARGET_URL,
    runs: RUNS,
    software: runs[0]?.software ?? null,
    renderer: runs[0]?.renderer ?? null,
    shellInteractiveMsMedian: shell.length ? +median(shell).toFixed(0) : null,
    mapVisibleMsMedian: mapv.length ? +median(mapv).toFixed(0) : null,
    searchTypeableEveryRun: allTypeable,
    perRun: runs,
    budgets: { shellInteractiveMs: 2500, mapVisibleMs: 4000 },
  };
  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "shell-interactive.json"), JSON.stringify(report, null, 2));

  const si = report.shellInteractiveMsMedian;
  const mv = report.mapVisibleMsMedian;
  console.log(`\n=== SHELL-INTERACTIVE vs MAP-VISIBLE (median of ${RUNS}) — device=${DEVICE} ===`);
  console.log(`Search usable (shell-interactive, hf:interactive): ${si} ms  (intent budget ≤2500 → ${si != null && si <= 2500 ? "PASS" : "over"})`);
  console.log(`Map visible unprompted (hf:map-ready):            ${mv} ms  (target ≤4000 → ${mv != null && mv <= 4000 ? "PASS" : "over"})`);
  console.log(`Search typeable every run: ${allTypeable}`);
  console.log(`WebGL: ${report.renderer}${report.software ? "  ⚠ SOFTWARE (map-visible paint inflated; real GPU faster)" : ""}`);
  if (DEVICE !== "real") console.log(`[EMU] emulation-based — the two real-Android follow-ups to record on device.`);
  console.log(`Wrote ${join(outDir, "shell-interactive.json")}`);

  // Fail CLOSED (never publish a passing shell-interactive number that the interaction check could
  // not corroborate): the `hf:interactive` mark proves the bundle hydrated, but if typing ≥3 chars
  // did NOT drive the suggest listbox on some run, the search handler may be broken — the "search
  // usable" claim is then unreliable and must not read as PASS.
  if (si == null) {
    console.error(`\n[shell] no hf:interactive mark observed — the shell never became interactive. FAIL.`);
    process.exit(1);
  }
  if (!allTypeable) {
    console.error(`\n[shell] the search box did not drive React (listbox) on every run — shell-interactive is UNRELIABLE. FAIL.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
