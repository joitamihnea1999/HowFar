// Bundle analysis (deliverable 2). Authoritative source = what the browser actually pulls
// over the wire for the map route, because Turbopack chunk names are hashed and Next 16's
// build output no longer prints per-route sizes (verified task 017: no app-build-manifest.json,
// build-manifest.json `pages` is empty for the App Router — there is NO static route→chunk map).
//
// INITIAL vs LAZY is classified by an EXPLICIT lifecycle mark, not by network settling
// (task 017). The eager shell emits `performance.mark('hf:interactive')` the
// moment it is mounted + interactive and BEFORE it schedules the deferred map-engine import;
// a JS chunk whose request STARTED before that mark is INITIAL (critical path), one that
// started after is LAZY (deferred). This is provider-free and immune to the old trap where an
// idle-triggered import fired inside the `networkidle0` window and was mis-counted as initial.
//
// Graceful fallback (rule 13 — one instrument, one rule, applied to before AND after): if the
// page emits NO `hf:interactive` mark (e.g. the pre-defer baseline build), EVERY JS chunk is
// classified INITIAL — which is the correct reading for a build with no deferral boundary. So
// the number moving between before/after reflects the real architecture change, not a changed
// instrument. `boundaryDetected` records which rule fired.
import { launch } from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { TARGET_URL, BUDGETS } from "./config.mjs";
import { bucketOf as bucketOfIn, classifyByMark, hasMapEngine } from "./bundle-classify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNK_DIR = join(HERE, "..", "..", ".next", "static", "chunks");
const INTERACTIVE_MARK = process.env.PERF_INTERACTIVE_MARK ?? "hf:interactive";
const bucketOf = (fileName) => bucketOfIn(fileName, CHUNK_DIR);

async function collectJs(page) {
  const entries = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.initiatorType === "script" || /\.js(\?|$)/.test(e.name))
      .map((e) => ({
        name: e.name,
        startTime: e.startTime,
        responseEnd: e.responseEnd,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
      })),
  );
  return entries.filter((e) => /_next\/static\/chunks\//.test(e.name));
}

function summarize(list) {
  const byBucket = {};
  let totalGz = 0;
  let totalRaw = 0;
  for (const r of list) {
    const b = bucketOf(r.name);
    let gz = r.transferSize;
    const p = join(CHUNK_DIR, basename(r.name));
    const raw = existsSync(p) ? readFileSync(p).length : r.decodedBodySize || 0;
    if (!gz || gz < 100) gz = existsSync(p) ? gzipSync(readFileSync(p)).length : r.encodedBodySize || 0;
    byBucket[b] = (byBucket[b] || 0) + gz;
    totalGz += gz;
    totalRaw += raw;
    r._gz = gz;
    r._raw = raw;
    r._bucket = b;
  }
  return { byBucket, totalGz, totalRaw };
}

async function main() {
  const chrome = await launch({
    chromeFlags: ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const browser = await puppeteer.connect({ browserURL: `http://localhost:${chrome.port}`, defaultViewport: null });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setCacheEnabled(false);

  // networkidle0 waits for the deferred map chunk to finish loading too (it is requested on
  // idle shortly after the shell paints), so the LAZY set is populated without any interaction.
  await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 60000 });
  // Give an auto-deferred (idle-scheduled) map load a moment in case it starts just after idle.
  await new Promise((r) => setTimeout(r, 1500));

  const all = await collectJs(page);
  const markTime = await page.evaluate((mark) => {
    const m = performance.getEntriesByName(mark, "mark")[0];
    return m ? m.startTime : null;
  }, INTERACTIVE_MARK);

  // Instrument reliability (never skip-green) — the wire read must have produced JS chunks;
  // an empty read means the page never loaded / Resource Timing was unavailable → HARD FAIL.
  if (all.length === 0) {
    console.error("[bundle] FATAL: no JS chunks seen over the wire — page did not load or Resource Timing empty.");
    browser.disconnect();
    await chrome.kill();
    process.exit(2);
  }

  const { initial, lazy, boundaryDetected } = classifyByMark(all, markTime);
  const initSum = summarize(initial);
  const lazySum = summarize(lazy);

  const initialHasMaplibre = hasMapEngine(initial);
  const lazyHasMaplibre = hasMapEngine(lazy);

  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    interactiveMark: INTERACTIVE_MARK,
    boundaryDetected, // true ⇒ page emitted hf:interactive and we split by it; false ⇒ all-initial fallback
    markTimeMs: markTime == null ? null : +markTime.toFixed(1),
    initialHasMaplibre,
    lazyHasMaplibre,
    budgetKB: BUDGETS.initialJsGzKB,
    note:
      "INITIAL vs LAZY split by the hf:interactive mark (requests before the mark = initial). " +
      "No mark ⇒ all-initial (pre-defer baseline). transferSize == gz on the wire (cache disabled). " +
      "Buckets attributed by signature-grepping the on-disk chunk; turf/d3 detection is name-based " +
      "BEST-EFFORT (minified names) so absence is not proof of absence — only presence is conclusive.",
    initial: {
      totalGzBytes: initSum.totalGz,
      totalGzKB: +(initSum.totalGz / 1024).toFixed(1),
      totalRawKB: +(initSum.totalRaw / 1024).toFixed(1),
      byBucketGzKB: Object.fromEntries(
        Object.entries(initSum.byBucket).map(([k, v]) => [k, +(v / 1024).toFixed(1)]),
      ),
      chunks: initial
        .map((e) => ({ file: basename(e.name), bucket: e._bucket, gzKB: +(e._gz / 1024).toFixed(1), rawKB: +(e._raw / 1024).toFixed(1) }))
        .sort((a, b) => b.gzKB - a.gzKB),
    },
    lazy: {
      totalGzKB: +(lazySum.totalGz / 1024).toFixed(1),
      chunks: lazy
        .map((e) => ({ file: basename(e.name), bucket: e._bucket, gzKB: +(e._gz / 1024).toFixed(1) }))
        .sort((a, b) => b.gzKB - a.gzKB),
    },
  };

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "bundle.json"), JSON.stringify(report, null, 2));

  const pass = report.initial.totalGzKB <= BUDGETS.initialJsGzKB;
  console.log(`\n=== BUNDLE (initial / critical-path JS, gzipped) ===`);
  console.log(`Boundary detected (hf:interactive mark): ${boundaryDetected}${boundaryDetected ? ` @ ${report.markTimeMs} ms` : " (all-initial fallback)"}`);
  console.log(`Total initial JS gz: ${report.initial.totalGzKB} KB  (raw ${report.initial.totalRawKB} KB)`);
  console.log(`Budget: ${BUDGETS.initialJsGzKB} KB gz → ${pass ? "PASS" : "FAIL"}`);
  console.log(`By bucket (gz KB):`, report.initial.byBucketGzKB);
  console.log(`MapLibre in INITIAL set: ${initialHasMaplibre}   |   MapLibre in LAZY set: ${lazyHasMaplibre}`);
  console.log(`\nLargest initial chunks:`);
  for (const c of report.initial.chunks.slice(0, 8)) console.log(`  ${c.gzKB.toString().padStart(7)} KB gz  [${c.bucket}]  ${c.file}  (raw ${c.rawKB} KB)`);
  console.log(`\nLazy (requested after hf:interactive): ${report.lazy.totalGzKB} KB gz across ${report.lazy.chunks.length} chunk(s)`);
  for (const c of report.lazy.chunks.slice(0, 8)) console.log(`  ${c.gzKB.toString().padStart(7)} KB gz  [${c.bucket}]  ${c.file}`);
  console.log(`\nWrote ${join(outDir, "bundle.json")}`);

  browser.disconnect();
  await chrome.kill();
}

// Only run the browser flow when invoked directly, so the pure helpers can be unit-tested.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
