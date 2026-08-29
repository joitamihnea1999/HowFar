// Bundle analysis (deliverable 2). Authoritative source = what the browser actually pulls
// over the wire for the map route, because Turbopack chunk names are hashed and Next 16's
// build output no longer prints per-route sizes. We load the page, read Resource Timing
// (transferSize == gzipped bytes on the wire), then attribute each JS chunk to MapLibre /
// pmtiles / react-dom / app+vendor by grepping the on-disk chunk for library signatures.
// A second pass drives one interaction so we can separate INITIAL (critical-path) JS from
// LAZY chunks that only load after the user acts.
import { launch } from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { TARGET_URL } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNK_DIR = join(HERE, "..", "..", ".next", "static", "chunks");

function bucketOf(fileName) {
  const p = join(CHUNK_DIR, basename(fileName));
  if (!existsSync(p)) return "unknown";
  const txt = readFileSync(p, "latin1");
  if (/maplibregl|maplibre-gl/i.test(txt)) return "maplibre";
  if (/\bpmtiles\b|PMTiles/.test(txt)) return "pmtiles";
  if (/react-dom|scheduler\.production|react\.production/.test(txt)) return "react";
  // NB turf/d3 detection by name is BEST-EFFORT: production minification mangles function
  // names, so a chunk that bundles @turf/boolean-point-in-polygon (pulled in by the client
  // reach-band helper, src/features/map/reach.ts) usually shows NO "turf" string. Absence of
  // a match is therefore NOT proof of absence in the bundle — only presence is conclusive.
  if (/@turf|booleanPointInPolygon|turf/.test(txt)) return "turf";
  if (/d3-contour|contourDensity|d3\.contours/.test(txt)) return "d3-contour";
  return "app+vendor";
}

async function collectJs(page) {
  // Resource Timing gives per-resource transferSize (gz on wire) + decodedBodySize (raw).
  const entries = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.initiatorType === "script" || /\.js(\?|$)/.test(e.name))
      .map((e) => ({
        name: e.name,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
      })),
  );
  // Also the initial HTML document's inline scripts are negligible; ignore.
  return entries.filter((e) => /_next\/static\/chunks\//.test(e.name));
}

function summarize(list) {
  const byBucket = {};
  let totalGz = 0;
  let totalRaw = 0;
  for (const r of list) {
    const b = bucketOf(r.name);
    // Prefer wire transferSize; fall back to gzipping the on-disk chunk (0 when served from
    // cache / a real device where transferSize can be 0).
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

  await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 60000 });
  const initial = await collectJs(page);
  const initialNames = new Set(initial.map((e) => basename(e.name)));

  // Drive one interaction (address select + car toggle) to trigger lazy chunks, if any.
  let interactionOk = false;
  try {
    await page.waitForSelector('input[role="combobox"]', { timeout: 10000 });
    await page.click('input[role="combobox"]');
    await page.type('input[role="combobox"]', "Piata Unirii");
    await page.waitForSelector('[role="option"]', { timeout: 8000 });
    await page.click('[role="option"]');
    await new Promise((r) => setTimeout(r, 2500));
    const carBtn = await page.$$('[role="group"][aria-label="Travel mode"] button');
    if (carBtn.length < 3) throw new Error("mode toggle not reached");
    await carBtn[2].click();
    await new Promise((r) => setTimeout(r, 2000));
    interactionOk = true;
  } catch (e) {
    console.error("[bundle] interaction pass INCOMPLETE:", e.message, "— lazy-chunk result marked unreliable");
  }

  const afterAll = await collectJs(page);
  const lazy = afterAll.filter((e) => !initialNames.has(basename(e.name)));

  const initSum = summarize(initial);
  const lazySum = summarize(lazy);

  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    lazyReliable: interactionOk, // false ⇒ the interaction didn't complete; "0 lazy" is unproven
    note:
      "transferSize == gzipped bytes on the wire (cache disabled). Buckets attributed by " +
      "signature-grepping the on-disk Turbopack chunk; turf/d3 detection is name-based and " +
      "BEST-EFFORT (minification mangles names, so absence of a match is not proof of absence). " +
      "@turf/boolean-point-in-polygon IS pulled into the client via the reach-band helper " +
      "(src/features/map/reach.ts) but is tiny; d3-contour is server-only (transit grid). " +
      "Either way both are immaterial to the ~470 KB total, which is MapLibre-dominated.",
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

  console.log(`\n=== BUNDLE (initial / critical-path JS, gzipped) ===`);
  console.log(`Total initial JS gz: ${report.initial.totalGzKB} KB  (raw ${report.initial.totalRawKB} KB)`);
  console.log(`Budget: 350 KB gz incl. MapLibre → ${report.initial.totalGzKB <= 350 ? "PASS" : "FAIL"}`);
  console.log(`By bucket (gz KB):`, report.initial.byBucketGzKB);
  console.log(`\nLargest initial chunks:`);
  for (const c of report.initial.chunks.slice(0, 8)) console.log(`  ${c.gzKB.toString().padStart(7)} KB gz  [${c.bucket}]  ${c.file}  (raw ${c.rawKB} KB)`);
  console.log(`\nLazy (loaded only after interaction): ${report.lazy.totalGzKB} KB gz across ${report.lazy.chunks.length} chunk(s)`);
  for (const c of report.lazy.chunks.slice(0, 8)) console.log(`  ${c.gzKB.toString().padStart(7)} KB gz  [${c.bucket}]  ${c.file}`);
  console.log(`\nWrote ${join(outDir, "bundle.json")}`);

  browser.disconnect();
  await chrome.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
