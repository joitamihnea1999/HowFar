// API latency from the browser (deliverable 4). Measures each self-hosted endpoint the
// map flow calls — suggest / geocode / reverse / isochrone / car / amenities — COLD (first
// hit, ApiCache miss → full provider/PostGIS round trip) and WARM (repeat → ApiCache hit),
// reporting p50/p95 per endpoint against the owner's budgets.
//
// Measured same-origin from a real browser (fetch + performance.now), NO CPU/network
// throttle: these budgets target the STACK's own latency (server + local transport), not a
// simulated 4G link. On a real device add the network RTT on top — flagged in the report.
//
// Transit + reach are deliberately excluded: NOT self-hosted (MOTIS/GTFS gate), they hit
// the public network under the overlay so their latency is not a property of the local stack.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openBrowser, closeBrowser } from "./browser.mjs";
import { ORIGIN, TARGET_URL, endpointProbes, percentile, median } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// ≥30 so cold p95 (nearest-rank index ⌈0.95·n⌉−1) is an actual tail percentile, not the
// single max sample (which n=12 collapsed it to).
const SAMPLES = Number(process.env.PERF_API_SAMPLES ?? 30);

// Time one request inside the page via fetch; returns ms (responseEnd - fetchStart from the
// Resource Timing entry, i.e. what the browser observed on the wire + server).
async function timeFetch(page, url) {
  return page.evaluate(async (u) => {
    const t0 = performance.now();
    const res = await fetch(u, { cache: "no-store" });
    await res.arrayBuffer();
    const dt = performance.now() - t0;
    return { ms: dt, status: res.status };
  }, url);
}

async function main() {
  // Reminder BEFORE measuring (not after): cold suggest/geocode reuse a fixed input pool and
  // ApiCache persists, so a repeat run without a flush measures warm values labeled "cold".
  console.error(`[api] For a true COLD run, flush ApiCache FIRST (else fixed suggest/geocode keys are warm):`);
  console.error(`      docker exec howfar-postgis psql -U howfar -d howfar -c 'DELETE FROM "ApiCache";'`);
  console.error(`[api] Sampling ${SAMPLES}/cell; cells with any non-2xx sample are marked UNRELIABLE and exit non-zero.\n`);

  const ctx = await openBrowser({ throttle: false });
  const { page } = ctx;
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const probes = endpointProbes();
  const out = [];
  let hardFail = false;
  for (const probe of probes) {
    // COLD: each sample a fresh cache key (unique URL). One provider round trip apiece.
    const cold = [];
    let coldFail = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const r = await timeFetch(page, ORIGIN + probe.cold());
      if (r.status < 400) cold.push(r.ms);
      else coldFail++;
    }
    // WARM: prime once, then repeat the identical URL → ApiCache hits.
    await timeFetch(page, ORIGIN + probe.warm);
    const warm = [];
    let warmFail = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const r = await timeFetch(page, ORIGIN + probe.warm);
      if (r.status < 400) warm.push(r.ms);
      else warmFail++;
    }
    // Fail CLOSED: a cell with any failed sample must not publish a passing p95 from a partial
    // subset — the whole harness run is unreliable. Require n === SAMPLES.
    if (coldFail > 0 || warmFail > 0) {
      hardFail = true;
      console.error(`[api] ${probe.key}: ${coldFail} cold + ${warmFail} warm sample(s) failed (non-2xx) — cell UNRELIABLE (need n===${SAMPLES}).`);
    }
    const row = {
      endpoint: probe.key,
      budgetMs: probe.budgetMs,
      coldFail,
      warmFail,
      reliable: coldFail === 0 && warmFail === 0,
      cold: cold.length ? { p50: +median(cold).toFixed(1), p95: +percentile(cold, 95).toFixed(1), n: cold.length } : null,
      warm: warm.length ? { p50: +median(warm).toFixed(1), p95: +percentile(warm, 95).toFixed(1), n: warm.length } : null,
    };
    // Budget verdict is taken on the COLD p95 — a first-touch user with a fresh
    // address/coord always pays the cache-miss cost, and unique inputs dominate real usage.
    // A cell with any failed sample cannot pass (reliable === false → verdict null).
    row.coldP95PassesBudget = row.reliable && row.cold ? row.cold.p95 <= probe.budgetMs : null;
    row.warmP95PassesBudget = row.reliable && row.warm ? row.warm.p95 <= probe.budgetMs : null;
    row.coldP95 = row.cold ? row.cold.p95 : null;
    out.push(row);
    console.error(
      `[api] ${probe.key.padEnd(10)} cold p50/p95 ${row.cold?.p50 ?? "—"}/${row.cold?.p95 ?? "—"} ms · warm p50/p95 ${row.warm?.p50 ?? "—"}/${row.warm?.p95 ?? "—"} ms (budget ${probe.budgetMs}) n=${cold.length}/${SAMPLES}${row.reliable ? "" : " ⚠UNRELIABLE"}`,
    );
  }

  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    samplesPerCell: SAMPLES,
    device: ctx.emulated ? "throttled" : "unthrottled (stack latency; add real-device network RTT on-device)",
    percentile: `nearest-rank, n=${SAMPLES} per cell (p95 index ⌈0.95·n⌉−1)`,
    reliable: !hardFail,
    note:
      "cold = ApiCache miss (fresh unique key per sample) → full provider/PostGIS round trip; " +
      "warm = ApiCache hit. Budget verdict on COLD p95 (first-touch), and only when the cell is " +
      "reliable (n===SAMPLES, no failed samples). Transit/reach excluded (not self-hosted). " +
      "Real-device network RTT (~50-150ms on 4G) adds on top of these local numbers. NB the " +
      "amenities endpoint's cold cost INCLUDES a cold ORS isochrone call (clipRingsFor→" +
      "walkingIsochrone, on the amenities cache miss), not just the PostGIS intersect. These are " +
      "single-request/serial numbers, not load-tested. suggest/geocode reuse a fixed input pool; " +
      "a repeat harness run needs an ApiCache flush to stay cold — see the printed reminder.",
    endpoints: out,
  };

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "api-latency.json"), JSON.stringify(report, null, 2));

  console.log(`\n=== API LATENCY (browser → local stack, ${SAMPLES} samples/cell, unthrottled) ===`);
  console.log(`NB cold suggest/geocode use fixed keys + ApiCache persists — for a true cold RE-RUN, first:`);
  console.log(`   docker exec howfar-postgis psql -U howfar -d howfar -c 'DELETE FROM "ApiCache";'`);
  console.log(`endpoint     cold p50/p95      warm p50/p95     budget   cold-p95 verdict`);
  for (const r of out) {
    const cold = r.cold ? `${r.cold.p50}/${r.cold.p95}`.padEnd(14) : "—".padEnd(14);
    const warm = r.warm ? `${r.warm.p50}/${r.warm.p95}`.padEnd(13) : "—".padEnd(13);
    const verdict = r.coldP95PassesBudget == null ? "n/a" : r.coldP95PassesBudget ? "PASS" : "FAIL";
    console.log(`${r.endpoint.padEnd(12)} ${cold}  ${warm}  ${String(r.budgetMs).padEnd(6)}  ${verdict}`);
  }
  console.log(`(verdict on COLD p95 = first-touch cache-miss, n=${SAMPLES}; warm = ApiCache hit, returning user)`);
  console.log(`\nWrote ${join(outDir, "api-latency.json")}`);
  await closeBrowser(ctx);
  if (hardFail) {
    console.error(`\n[api] one or more cells had failed samples — results UNRELIABLE. Exiting non-zero.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
