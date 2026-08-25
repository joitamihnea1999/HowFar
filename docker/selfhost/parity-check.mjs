#!/usr/bin/env node
// Parity check: does the app on the SELF-HOSTED stack return the same answers as
// the app on the PUBLIC providers?
//
// NOT part of check:ci — it needs two live app instances. Run TWO builds of the
// app (same NEXT_PUBLIC_MAP_BBOX, so one `next build` is fine) as two processes:
//   - PUBLIC:  default provider env, e.g. PORT=3000 next start
//   - LOCAL:   env.selfhost.example merged in (distinct PROVIDER_DATA_REVISION so
//              the ApiCache namespaces never cross), e.g. PORT=3001 next start
// then:  node docker/selfhost/parity-check.mjs --public http://localhost:3000 --local http://localhost:3001
//
// Modes:
//   --self-test     validate the geometry instrument on known fixtures, then exit
//   --public-only   hit only the public instance (local shown n/a) — proves the
//                   harness + math work BEFORE any self-host stack exists
//   (default)       full public-vs-local comparison; exits non-zero if any metric
//                   is outside tolerance.
//
// Tolerances (stated, with provenance — see docs/PROVIDERS.md 2026-07-24 audit):
//   - geocode: haversine distance between the two returned points <= 150 m
//     (rooftop/parcel jitter between OSM geocoders).
//   - rings: the audit's quantity was a RADIAL boundary residual, bar +/-10%.
//     Residual = ray/polygon boundary distance at 24 bearings (density-independent).
//     A ring passes only if ALL hold: median sector residual <= 0.10 AND worst
//     sector <= 0.15 (a tail bound, so a truncated ring — which casts a short ray in
//     the clipped bearings — can't hide behind the median) AND zero cross-coverage
//     mismatch (no bearing reached by only one of the two rings — the guard against a
//     wedge missing from one leg) AND area ratio within +/-21% (area = r^2 equivalent
//     of +/-10% radius). All enforced, not just printed.
//   - suggest: top type-ahead hit within 500 m (looser than exact geocode).
//   Before any of this, a PROVENANCE preflight proves the local leg is backed by the
//   LIVE self-hosted engines (distinct base URLs, engines healthy now, and the local
//   app's geocode matches the local Nominatim's own answer) — else it aborts.
//   NB this compares two ORS builds of the SAME engine family with the SAME
//   corrected ranges echoed, so the expected divergence is profile/extract-vintage
//   only. A result outside the bar is a FINDING to investigate, never a reason to
//   widen the bar.

const R_EARTH_M = 6371008.8;
const DEG = Math.PI / 180;

// ── geometry ────────────────────────────────────────────────────────────────
function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const la1 = a.lat * DEG, la2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Local equirectangular projection around a reference latitude → metres.
// Adequate for area/distance RATIOS over a city-sized isochrone.
function projector(refLatDeg) {
  const kx = R_EARTH_M * DEG * Math.cos(refLatDeg * DEG);
  const ky = R_EARTH_M * DEG;
  return ([lng, lat]) => [lng * kx, lat * ky];
}

// Shoelace area (m^2) of a single linear ring in projected coords.
function ringAreaProjected(coords) {
  let a = 0;
  for (let i = 0, n = coords.length; i < n; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Area (m^2) of a GeoJSON Polygon/MultiPolygon: sum exterior rings, subtract holes.
function geometryAreaM2(geometry, refLatDeg) {
  const proj = projector(refLatDeg);
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  let total = 0;
  for (const poly of polys) {
    poly.forEach((ring, idx) => {
      const a = ringAreaProjected(ring.map(proj));
      total += idx === 0 ? a : -a; // ring[0] = exterior, rest = holes
    });
  }
  return total;
}

// Radial boundary distance by RAY/POLYGON INTERSECTION (not vertex binning, which
// gives sparse/empty sectors on small rings with few vertices). For each of `bins`
// evenly-spaced bearings, cast a ray from the origin and take the FARTHEST crossing
// of any exterior-ring edge — the outer reach boundary in that direction. This is
// density-independent: every bearing that the boundary encloses yields a distance,
// so coverage reflects real geometry, not vertex count. Holes ignored (outer reach).
function radialProfile(geometry, origin, bins = 24) {
  const proj = projector(origin.lat);
  const O = proj([origin.lng, origin.lat]);
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  // Exterior-ring edges in metres, relative to the origin.
  const edges = [];
  for (const poly of polys) {
    const ring = poly[0].map(proj);
    for (let i = 0; i < ring.length - 1; i++) {
      edges.push([[ring[i][0] - O[0], ring[i][1] - O[1]], [ring[i + 1][0] - O[0], ring[i + 1][1] - O[1]]]);
    }
  }
  const out = [];
  for (let b = 0; b < bins; b++) {
    const ang = (b / bins) * 2 * Math.PI;         // ray direction (dx, dy) from the origin
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let best = null;
    for (const [[x1, y1], [x2, y2]] of edges) {
      // Solve origin + t*(dx,dy) = a + s*(b-a), t>0, s in [0,1]. (origin is the local (0,0); a,b = edge ends.)
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;         // parallel
      const t = (x1 * ey - y1 * ex) / den;         // distance along the ray (metres)
      const s = (x1 * dy - y1 * dx) / den;         // position along the edge
      if (t > 0 && s >= 0 && s <= 1 && (best == null || t > best)) best = t;
    }
    out.push(best);                                // null only if the ray hits no edge (origin outside)
  }
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// |ratio-1| per matched radial sector. Returns median AND the worst sector — the
// gate looks at the TAIL, not just the median, so a truncated ring (which casts a
// short ray in its clipped bearings → a large single-sector residual) can't pass.
// ALSO returns `mismatch`: bearings where exactly ONE ring encloses the origin (one
// profile null, the other a distance). Matched-only residuals are blind to a wedge
// missing from just one leg (both-null and both-present bearings look fine while the
// absent wedge's small area loss stays inside the area band) — `mismatch` is the
// cross-coverage guard that catches it. This is NOT the tautological single-ring
// coverage dropped earlier: it compares the TWO rings' bearing coverage to each other.
function radialResidual(profA, profB) {
  const rs = [];
  let mismatch = 0;
  for (let i = 0; i < profA.length; i++) {
    const aOk = profA[i] != null, bOk = profB[i] != null;
    if (aOk && bOk && profB[i] > 0) rs.push(Math.abs(profA[i] / profB[i] - 1));
    else if (aOk !== bOk) mismatch++;   // one ring reaches this bearing, the other does not
  }
  if (!rs.length) return { median: NaN, max: NaN, mismatch };
  return { median: median(rs), max: Math.max(...rs), mismatch };
}

// ── fixtures / self-test (rule 13: validate the instrument before trusting it) ─
function selfTest() {
  const ref = 44.43;
  const proj = projector(ref);
  // A ~1km x 1km square near Bucharest. INDEPENDENT check: a rectangle's area is
  // width×height from the projected corner spans — a DIFFERENT formula than the
  // shoelace sum, so a regression in ringAreaProjected/geometryAreaM2 fails here.
  const d = 0.0045; // ~0.5 km each side of centre in lat; lng scaled by cos(lat)
  const sq = [[26.10 - d, 44.43 - d], [26.10 + d, 44.43 - d], [26.10 + d, 44.43 + d], [26.10 - d, 44.43 + d], [26.10 - d, 44.43 - d]];
  const P = sq.map(proj);
  const analytic = Math.abs(P[1][0] - P[0][0]) * Math.abs(P[2][1] - P[1][1]); // width × height
  const viaGeom = geometryAreaM2({ type: "Polygon", coordinates: [sq] }, ref);
  assertClose("square area (shoelace vs width×height)", viaGeom, analytic, 1e-6);

  // MultiPolygon with a hole: outer square minus a centred quarter-size hole,
  // plus a detached second polygon. Area = outer - hole + second.
  const hole = [[26.10 - d / 2, 44.43 - d / 2], [26.10 + d / 2, 44.43 - d / 2], [26.10 + d / 2, 44.43 + d / 2], [26.10 - d / 2, 44.43 + d / 2], [26.10 - d / 2, 44.43 - d / 2]];
  const second = [[26.20, 44.50], [26.21, 44.50], [26.21, 44.51], [26.20, 44.51], [26.20, 44.50]];
  const mp = { type: "MultiPolygon", coordinates: [[sq, hole], [second]] };
  const expect = analytic - ringAreaProjected(hole.map(proj)) + ringAreaProjected(second.map(proj));
  assertClose("multipolygon-with-hole area", geometryAreaM2(mp, ref), expect, 1e-6);

  // Reversed winding must not change |area| (shoelace uses abs()).
  const rev = { type: "Polygon", coordinates: [[...sq].reverse()] };
  assertClose("reversed winding area", geometryAreaM2(rev, ref), analytic, 1e-6);

  // Haversine sanity: 1 degree of latitude ~= 111.2 km.
  assertClose("haversine 1deg lat", haversineM({ lat: 44, lng: 26 }, { lat: 45, lng: 26 }), 111195, 0.01);

  // Radial metric: identical geometry → residual 0; a 20%-scaled ring → residual ~0.20.
  const origin = { lat: 44.43, lng: 26.10 };
  const ringGeom = (scale) => {
    const pts = [];
    for (let a = 0; a < 360; a += 30) {
      const r = 0.01 * scale; // ~1 km radius * scale
      pts.push([origin.lng + r * Math.cos(a * DEG) / Math.cos(origin.lat * DEG), origin.lat + r * Math.sin(a * DEG)]);
    }
    pts.push(pts[0]);
    return { type: "Polygon", coordinates: [pts] };
  };
  const base = radialProfile(ringGeom(1), origin);
  assertClose("radial residual (identical)", radialResidual(base, base).median + 1, 1, 1e-9);
  const scaled = radialResidual(radialProfile(ringGeom(1.2), origin), base);
  assertClose("radial residual median (1.20× scaled)", scaled.median, 0.20, 0.02);
  assertClose("radial residual max (1.20× scaled)", scaled.max, 0.20, 0.02);
  // A FEW distorted sectors: median stays ≈0 (so the median gate would pass) but
  // max ≈1.0 catches it — proves the tail gate does work, not just the median.
  const spike = base.map((v, i) => (i < 3 ? v * 2 : v)); // 3 of 24 sectors 2× out
  const sres = radialResidual(spike, base);
  assertClose("3-sector spike: median stays low", sres.median, 0.0, 1e-9);
  assertClose("3-sector spike: caught by MAX", sres.max, 1.0, 0.01);
  assertClose("identical ring: zero cross-coverage mismatch", radialResidual(base, base).mismatch, 0, 1e-9);

  // MISSING-WEDGE (one leg not reaching a bearing the other does): the matched-sector
  // residuals stay 0 and the small area loss can sit inside the area band, so ONLY the
  // cross-coverage mismatch catches it. A 4-of-24 wedge absent from the local leg.
  const wedge = base.map((v, i) => (i >= 6 && i < 10 ? null : v));
  const wres = radialResidual(wedge, base);
  assertClose("missing-wedge: matched sectors still 0 residual", wres.median, 0.0, 1e-9);
  assertClose("missing-wedge: mismatch counts the absent bearings", wres.mismatch, 4, 1e-9);

  // Exercise the VERDICT PREDICATE itself (not just the computed values) so a
  // deleted gate clause is caught — pass/fail fixtures for each threshold.
  assertBool("verdict: identical ring passes", ringVerdict({ median: 0, max: 0, mismatch: 0 }, 1.0), true);
  assertBool("verdict: median just over fails", ringVerdict({ median: 0.11, max: 0.11, mismatch: 0 }, 1.0), false);
  assertBool("verdict: worst sector over fails (median ok)", ringVerdict({ median: 0.0, max: 0.16, mismatch: 0 }, 1.0), false);
  assertBool("verdict: area over fails (residual ok)", ringVerdict({ median: 0.0, max: 0.0, mismatch: 0 }, 1.25), false);
  assertBool("verdict: NaN residual fails", ringVerdict({ median: NaN, max: NaN, mismatch: 0 }, 1.0), false);
  assertBool("verdict: cross-coverage mismatch fails (missing wedge)", ringVerdict({ median: 0.0, max: 0.0, mismatch: 4 }, 1.0), false);

  console.log("SELF-TEST PASS — geometry instrument + verdict predicate validated (15 fixtures).");
}

function assertClose(name, got, want, relTol) {
  const rel = Math.abs(got - want) / Math.abs(want || 1);
  if (rel > relTol) { console.error(`SELF-TEST FAIL: ${name}: got ${got}, want ${want} (rel ${rel})`); process.exit(2); }
  console.log(`  ok ${name}: ${got.toFixed(2)} ~= ${want.toFixed(2)} (rel ${rel.toExponential(2)})`);
}

function assertBool(name, got, want) {
  if (got !== want) { console.error(`SELF-TEST FAIL: ${name}: got ${got}, want ${want}`); process.exit(2); }
  console.log(`  ok ${name}: ${got}`);
}

// ── origins (the 2026-07-24 audit set; coords fixed + recorded here) ──────────
// geoQuery is a SPECIFIC landmark (not a bare neighborhood name): the 150 m
// tolerance is calibrated for rooftop/parcel-level places. Bare area-name queries
// (e.g. just "Grozăvești") legitimately resolve to different-but-valid representative
// points across geocoders and are NOT a fair test of this tolerance — see suggest,
// which exercises the type-ahead path instead.
const ORIGINS = [
  { name: "Unirii (central)",           geoQuery: "Piața Unirii, București",           suggestQuery: "piata unirii", lat: 44.4268, lng: 26.1025 },
  { name: "Grozăvești (river barrier)", geoQuery: "AFI Cotroceni, București",           suggestQuery: "afi cotroceni", lat: 44.4419, lng: 26.0616 },
  { name: "Berceni (periphery)",        geoQuery: "Piața Sudului, București",           suggestQuery: "piata sudului", lat: 44.3830, lng: 26.1230 },
];
const GEOCODE_TOL_M = 150;
const REVERSE_TOL_M = 150;        // reverse geocode (map-click label path) — same rooftop tolerance as forward
const SUGGEST_TOL_M = 500;        // type-ahead top hit — looser than exact geocode (ranking/centroid differences)
const RING_RADIAL_TOL = 0.10;     // MEDIAN sector residual (the audit's ±10% quantity)
const RING_RADIAL_MAX = 0.15;     // WORST single sector — the truncation guard: a ring clipped on one side has the
                                  // ray hit the clip boundary far short in those bearings → a large max residual.
const RING_AREA_TOL = 0.21;       // area band, ENFORCED: 1.10²−1 ≈ 0.21 = the area-equivalent of the
                                  // MEDIAN ±10% radius bound (the primary signal); a whole-ring size
                                  // drift the per-sector residuals could average out is caught here.
const EXPECTED_RINGS = 3; // the app always requests 3 nested bands (ors.ts normalize() enforces it)

// A ring passes iff the median residual, the worst-sector residual, the CROSS-coverage
// (no bearing reached by only one of the two rings), AND the area ratio are all in band.
// `mismatch===0` is the density-independent guard against a wedge missing from one leg —
// a hole matched-sector residuals + a within-band area ratio would otherwise miss.
function ringVerdict(res, areaRatio) {
  return Number.isFinite(res.median)
    && res.median <= RING_RADIAL_TOL
    && res.max <= RING_RADIAL_MAX
    && res.mismatch === 0
    && Math.abs(areaRatio - 1) <= RING_AREA_TOL;
}

// The self-hosted engine endpoints (env.selfhost.example). Overridable so the
// provenance preflight can point at a non-default deployment.
const ENGINES = {
  nominatim: process.env.PARITY_NOMINATIM || "http://localhost:8081",
  photon: process.env.PARITY_PHOTON || "http://localhost:2322",
  ors: process.env.PARITY_ORS || "http://localhost:8082/ors",
};
// The provenance cross-check POSTs the app's foot-walking ranges to the local ORS
// and queries the local Photon with the app's bbox/focus. These MUST track the app:
// the ranges are the normal-pace ORS seconds (pace.ts) and the bbox is
// NEXT_PUBLIC_MAP_BBOX — both overridable so a pace tune (task 064 did one) or a
// different city doesn't make the preflight falsely abort.
const PROV_ORS_RANGE = (process.env.PARITY_ORS_RANGE || "861,1744,2633").split(",").map(Number);
const PROV_BBOX = process.env.NEXT_PUBLIC_MAP_BBOX || "25.8,44.2,26.4,44.7";
const [PROV_LON, PROV_LAT] = (() => { const b = PROV_BBOX.split(",").map(Number); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; })();

// PROVENANCE preflight — proves the local leg is really backed by the self-hosted
// engines (not a mis-started public-vs-public passthrough, and not stale ApiCache
// rows served while an engine is stopped). Returns [] on success or a list of
// failure strings.
async function provenancePreflight(publicBase, localBase, o) {
  const problems = [];
  // 1. The two app instances must be distinct (a copy-paste that points both at
  //    the same port would "pass" trivially).
  if (publicBase === localBase) problems.push("public and local base URLs are identical");
  // 2. Every self-hosted engine must be reachable RIGHT NOW — so a "PARITY OK"
  //    can't come from cached rows while the engine is down/upgraded.
  const probes = [
    [`${ENGINES.nominatim}/status?format=json`, "nominatim"],
    [`${ENGINES.photon}/api?q=bucuresti&limit=1`, "photon"],
    [`${ENGINES.ors}/v2/health`, "ors"],
  ];
  for (const [url, name] of probes) {
    try { const r = await fetch(url); if (!r.ok) problems.push(`${name} engine not healthy (${r.status})`); }
    catch (e) { problems.push(`${name} engine unreachable: ${e.message}`); }
  }
  // 3. Cross-check: the LOCAL app's geocode must match the LOCAL Nominatim's own
  //    answer (within GEOCODE_TOL_M) — i.e. the app really routed to the local
  //    engine, not silently to the public host.
  try {
    const appPt = await getJson(localBase, `/api/geocode?q=${encodeURIComponent(o.geoQuery)}`);
    const direct = await getJson(ENGINES.nominatim, `/search?format=jsonv2&countrycodes=ro&q=${encodeURIComponent(o.geoQuery)}&limit=1`);
    const d0 = direct?.[0];
    if (!d0) problems.push("local Nominatim returned no direct result for the cross-check query");
    else {
      const dist = haversineM(appPt, { lat: +d0.lat, lng: +d0.lon });
      if (dist > GEOCODE_TOL_M) problems.push(`Nominatim: local app geocode is ${dist.toFixed(0)} m from the local Nominatim's own answer — app may not be using the local engine`);
    }
  } catch (e) { problems.push(`Nominatim cross-check failed: ${e.message}`); }
  // 4. ORS cross-check: the local app's walk ring must match a DIRECT POST to the
  //    local ORS (same payload) — proves the app routed rings to the local engine,
  //    not a public ORS with the inherited key. Compared by 15-min ring area.
  try {
    const appRings = await ringsFor(localBase, o, "walk");
    const r = await fetch(`${ENGINES.ors}/v2/isochrones/foot-walking`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations: [[o.lng, o.lat]], range: PROV_ORS_RANGE }),
    });
    if (!r.ok) problems.push(`ORS direct isochrone failed (${r.status})`);
    else {
      const j = await r.json();
      const feats = j.features ?? [];
      if (feats.length !== 3 || !appRings.length) problems.push("ORS cross-check: unexpected feature/ring count");
      else {
        // The direct ORS 15-min feature vs the app's 15-min ring: same engine → same area.
        const areaD = geometryAreaM2(feats[0].geometry, o.lat);
        const areaP = geometryAreaM2(appRings[0].geometry, o.lat);
        // Fail-CLOSED on a degenerate ring: a zero/NaN area would make the ratio
        // NaN, and `Math.abs(NaN-1) > 0.02` is false — silently passing the preflight.
        if (!(areaP > 0) || !Number.isFinite(areaD)) problems.push("ORS cross-check: degenerate ring area (zero/NaN) — cannot verify provenance");
        else {
          const ratio = areaD / areaP;
          if (Math.abs(ratio - 1) > 0.02) problems.push(`ORS: app 15-min ring differs ${((ratio - 1) * 100).toFixed(1)}% from the local ORS's own answer — app may not be using the local engine`);
        }
      }
    }
  } catch (e) { problems.push(`ORS cross-check failed: ${e.message}`); }
  // 5. Photon cross-check: the local app's top suggestion must match a DIRECT query
  //    to the local Photon (within SUGGEST_TOL_M).
  try {
    const appSug = (await getJson(localBase, `/api/suggest?q=${encodeURIComponent(o.suggestQuery)}`)).suggestions?.[0];
    // Match the params the app sends Photon (bbox + Bucharest focus), else an
    // unconstrained direct query returns a global top hit and the check is meaningless.
    const r = await fetch(`${ENGINES.photon}/api?q=${encodeURIComponent(o.suggestQuery)}&bbox=${PROV_BBOX}&lat=${PROV_LAT}&lon=${PROV_LON}&limit=1&lang=en`);
    const pj = r.ok ? await r.json() : null;
    const pc = pj?.features?.[0]?.geometry?.coordinates;
    if (!appSug || !pc) problems.push("Photon cross-check: missing app or direct suggestion");
    else {
      const dist = haversineM(appSug, { lat: pc[1], lng: pc[0] });
      if (dist > SUGGEST_TOL_M) problems.push(`Photon: app suggestion is ${dist.toFixed(0)} m from the local Photon's own answer — app may not be using the local engine`);
    }
  } catch (e) { problems.push(`Photon cross-check failed: ${e.message}`); }
  return problems;
}

async function getJson(base, path) {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${base}${path} → HTTP ${res.status}`);
  return res.json();
}

async function ringsFor(base, o, kind) {
  const q = kind === "walk"
    ? `/api/isochrone?lat=${o.lat}&lng=${o.lng}&pace=normal`
    : `/api/car?lat=${o.lat}&lng=${o.lng}&preset=crowded`; // pin the slot (crowded=am-peak ×2.1) → identical ranges both legs
  const j = await getJson(base, q);
  return j.rings ?? [];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) { selfTest(); return; }
  selfTest(); // always validate the instrument first

  const publicBase = argVal(args, "--public") || "http://localhost:3000";
  const localBase = args.includes("--public-only") ? null : (argVal(args, "--local") || "http://localhost:3001");
  console.log(`\nPUBLIC = ${publicBase}\nLOCAL  = ${localBase ?? "(public-only dry-run)"}\n`);

  // Provenance gate: before trusting any parity number, prove the local leg is
  // actually backed by the LIVE self-hosted engines. A failure here aborts (a
  // "PARITY OK" against a misconfigured or cache-only run is worse than no run).
  if (localBase) {
    const problems = await provenancePreflight(publicBase, localBase, ORIGINS[0]);
    if (problems.length) {
      console.error("PROVENANCE PREFLIGHT FAILED — refusing to report parity:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(2);
    }
    console.log("provenance preflight OK — local engines live + app routes to them\n");
  }

  let failures = 0;
  const rows = [];

  const fail = () => { failures++; };

  for (const o of ORIGINS) {
    // Geocode (specific landmark → apples-to-apples; 150 m bar)
    try {
      const pub = await getJson(publicBase, `/api/geocode?q=${encodeURIComponent(o.geoQuery)}`);
      let dist = null, verdict = "n/a";
      if (localBase) {
        const loc = await getJson(localBase, `/api/geocode?q=${encodeURIComponent(o.geoQuery)}`);
        dist = haversineM(pub, loc);
        const pass = dist <= GEOCODE_TOL_M; if (!pass) fail();
        verdict = pass ? "PASS" : "FAIL";
      }
      rows.push(["geocode", o.name, "-", localBase ? `${dist.toFixed(1)} m` : "n/a", `<= ${GEOCODE_TOL_M} m`, verdict]);
    } catch (e) { rows.push(["geocode", o.name, "-", "ERR", "-", String(e.message)]); fail(); }

    // Reverse geocode (the map-click LABEL path) — both legs reverse the same origin
    // coordinate; the nearest-address point returned must match.
    try {
      const pub = await getJson(publicBase, `/api/reverse?lat=${o.lat}&lng=${o.lng}`);
      let dist = null, verdict = "n/a";
      if (localBase) {
        const loc = await getJson(localBase, `/api/reverse?lat=${o.lat}&lng=${o.lng}`);
        dist = haversineM(pub, loc);
        const pass = dist <= REVERSE_TOL_M; if (!pass) fail();
        verdict = pass ? "PASS" : "FAIL";
      }
      rows.push(["reverse", o.name, "-", localBase ? `${dist.toFixed(1)} m` : "n/a", `<= ${REVERSE_TOL_M} m`, verdict]);
    } catch (e) { rows.push(["reverse", o.name, "-", "ERR", "-", String(e.message)]); fail(); }

    // Suggest (Photon type-ahead) — top hit must land at the SAME place (not just exist)
    try {
      const pub = await getJson(publicBase, `/api/suggest?q=${encodeURIComponent(o.suggestQuery)}`);
      const pubTop = pub.suggestions?.[0] ?? null;
      let verdict = "n/a", detail = pubTop ? `pub top: ${(pubTop.label || "").slice(0, 30)}` : "no pub hit";
      if (!pubTop) fail();
      if (localBase) {
        const loc = await getJson(localBase, `/api/suggest?q=${encodeURIComponent(o.suggestQuery)}`);
        const locTop = loc.suggestions?.[0] ?? null;
        const dist = pubTop && locTop ? haversineM(pubTop, locTop) : null;
        const pass = dist != null && dist <= SUGGEST_TOL_M;
        if (!pass) fail();
        verdict = pass ? "PASS" : "FAIL";
        detail = dist == null ? "no local hit" : `top hit ${dist.toFixed(0)} m apart`;
      }
      rows.push(["suggest", o.name, "-", localBase ? detail : (pubTop ? "pub hit" : "no hit"), `top ≤ ${SUGGEST_TOL_M} m`, verdict]);
    } catch (e) { rows.push(["suggest", o.name, "-", "ERR", "-", String(e.message)]); fail(); }

    // Rings: walk + car — require exactly EXPECTED_RINGS on BOTH legs
    for (const kind of ["walk", "car"]) {
      try {
        const pubRings = await ringsFor(publicBase, o, kind);
        const locRings = localBase ? await ringsFor(localBase, o, kind) : [];
        if (pubRings.length !== EXPECTED_RINGS || (localBase && locRings.length !== EXPECTED_RINGS)) {
          rows.push([`${kind}`, o.name, `${pubRings.length} rings`, localBase ? `${locRings.length} rings` : "n/a",
            `exactly ${EXPECTED_RINGS} each`, "FAIL"]);
          fail();
          continue;
        }
        for (let i = 0; i < pubRings.length; i++) {
          const pg = pubRings[i].geometry;
          const areaP = geometryAreaM2(pg, o.lat);
          let res = null, areaRatio = null, verdict = "n/a", detail = "n/a";
          if (localBase) {
            const lg = locRings[i].geometry;
            res = radialResidual(radialProfile(lg, o), radialProfile(pg, o));
            areaRatio = geometryAreaM2(lg, o.lat) / areaP;
            const pass = ringVerdict(res, areaRatio);
            if (!pass) fail();
            verdict = pass ? "PASS" : "FAIL";
            detail = `med ${(res.median * 100).toFixed(1)}% max ${(res.max * 100).toFixed(1)}% area×${areaRatio.toFixed(3)}`;
          }
          rows.push([
            `${kind} ${pubRings[i].minutes}min`, o.name,
            `${(areaP / 1e6).toFixed(2)} km²`,
            detail,
            `med≤${RING_RADIAL_TOL * 100}% max≤${RING_RADIAL_MAX * 100}% area±${RING_AREA_TOL * 100}%`, verdict,
          ]);
        }
      } catch (e) { rows.push([`${kind}`, o.name, "-", "ERR", "-", String(e.message)]); fail(); }
    }
  }

  console.log(table(["metric", "origin", "public", "local vs public", "tolerance", "verdict"], rows));
  console.log(`\n${failures === 0 ? "PARITY OK" : `PARITY FAILURES: ${failures}`}`);
  // Any failure (missing rings, ERR, out-of-tolerance) exits non-zero in EVERY mode.
  process.exit(failures > 0 ? 1 : 0);
}

function argVal(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }
function table(head, rows) {
  const all = [head, ...rows];
  const w = head.map((_, c) => Math.max(...all.map((r) => String(r[c] ?? "").length)));
  const line = (r) => r.map((c, i) => String(c ?? "").padEnd(w[i])).join("  ");
  return [line(head), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(line)].join("\n");
}

main().catch((e) => { console.error(e); process.exit(2); });
