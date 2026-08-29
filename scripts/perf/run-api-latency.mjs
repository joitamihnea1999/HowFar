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
const SAMPLES = Number(process.env.PERF_API_SAMPLES ?? 12);

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
  const ctx = await openBrowser({ throttle: false });
  const { page } = ctx;
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const probes = endpointProbes();
  const out = [];
  for (const probe of probes) {
    // COLD: each sample a fresh cache key (unique URL). One provider round trip apiece.
    const cold = [];
    let coldStatus = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const r = await timeFetch(page, ORIGIN + probe.cold());
      coldStatus = r.status;
      if (r.status < 400) cold.push(r.ms);
    }
    // WARM: prime once, then repeat the identical URL → ApiCache hits.
    await timeFetch(page, ORIGIN + probe.warm);
    const warm = [];
    let warmStatus = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const r = await timeFetch(page, ORIGIN + probe.warm);
      warmStatus = r.status;
      if (r.status < 400) warm.push(r.ms);
    }
    const row = {
      endpoint: probe.key,
      budgetMs: probe.budgetMs,
      coldStatus,
      warmStatus,
      cold: cold.length ? { p50: +median(cold).toFixed(1), p95: +percentile(cold, 95).toFixed(1), n: cold.length } : null,
      warm: warm.length ? { p50: +median(warm).toFixed(1), p95: +percentile(warm, 95).toFixed(1), n: warm.length } : null,
    };
    // Budget verdict is taken on the COLD p95 — a first-touch user with a fresh
    // address/coord always pays the cache-miss cost, and unique inputs dominate real usage.
    // Warm (ApiCache hit) is near-instant and reported alongside as the returning-user case.
    row.coldP95PassesBudget = row.cold ? row.cold.p95 <= probe.budgetMs : null;
    row.warmP95PassesBudget = row.warm ? row.warm.p95 <= probe.budgetMs : null;
    row.coldP95 = row.cold ? row.cold.p95 : null;
    out.push(row);
    console.error(
      `[api] ${probe.key.padEnd(10)} cold p50/p95 ${row.cold?.p50 ?? "—"}/${row.cold?.p95 ?? "—"} ms · warm p50/p95 ${row.warm?.p50 ?? "—"}/${row.warm?.p95 ?? "—"} ms (budget ${probe.budgetMs}) status c=${coldStatus} w=${warmStatus}`,
    );
  }

  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    samplesPerCell: SAMPLES,
    device: ctx.emulated ? "throttled" : "unthrottled (stack latency; add real-device network RTT on-device)",
    note:
      "cold = ApiCache miss (fresh key per sample) → full provider/PostGIS round trip; warm = " +
      "ApiCache hit. Budget verdict on COLD p95 (first-touch). Transit/reach excluded (not " +
      "self-hosted). Real-device network RTT (~50-150ms on 4G) adds on top of these local " +
      "numbers. NB the amenities endpoint's cold cost INCLUDES a cold ORS isochrone call " +
      "(resolveClip→walkingIsochrone), not just the PostGIS intersect. These are single-" +
      "request/serial numbers, not load-tested. Re-running the harness without flushing " +
      "ApiCache turns fixed-list cold keys (suggest/geocode) warm — see the cache-flush note.",
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
  console.log(`(verdict on COLD p95 = first-touch cache-miss; warm = ApiCache hit, returning user)`);
  console.log(`\nWrote ${join(outDir, "api-latency.json")}`);
  await closeBrowser(ctx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
