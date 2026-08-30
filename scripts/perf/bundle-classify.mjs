// Pure, dependency-free bundle-classification helpers (task 017). Extracted from
// analyze-bundle.mjs so they can be unit-tested with the built-in node:test runner WITHOUT
// pulling in puppeteer/chrome-launcher — which matters because the perf deps are deliberately
// isolated from the app tree (scripts/perf/package.json) and are NOT installed in the app's
// `check:ci`. Keeping the classifier here lets both the measurement (analyze-bundle.mjs) and
// the CI budget gate (perf-budget.mjs) share ONE proven implementation, and lets the gate's
// unit test run with zero extra installs.
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Attribute a chunk file to a library bucket by grepping its on-disk bytes for signatures.
 * BEST-EFFORT for turf/d3 (minification mangles names — absence is not proof of absence; only
 * presence is conclusive); CONCLUSIVE for maplibre/pmtiles/react whose runtime strings survive.
 */
export function bucketOf(fileName, chunkDir) {
  const p = join(chunkDir, basename(fileName));
  if (!existsSync(p)) return "unknown";
  const txt = readFileSync(p, "latin1");
  // The ACTUAL MapLibre GL engine bundle carries WebGL shader SOURCE as string literals
  // (`gl_Position` / `gl_FragColor` / `u_matrix` / `a_pos`). These survive minification (shaders
  // are strings) and appear ONLY in the engine — never in app code that merely references a
  // `.maplibregl-*` CSS class or a style-spec property name. A bare `maplibregl` substring match
  // false-positived a 45 KB app chunk as "maplibre" (task 017), which would make the CI laziness
  // gate mis-fire; the engine bucket therefore requires a shader marker, not just the name.
  if (/gl_Position|gl_FragColor|\bu_matrix\b|\ba_pos\b/.test(txt)) return "maplibre";
  // The pmtiles LIBRARY carries its own internal identifiers (`EtagMismatch`, `TileType`,
  // `FileSource`, the `PMTiles` class). App code only ever names the `pmtiles://` protocol SCHEME
  // (lowercase, in the map style) — which the old `\bpmtiles\b` match false-positived as the
  // library (task 017). Require a library internal, not the scheme string.
  if (/EtagMismatch|\bPMTiles\b|\bTileType\b|\bFileSource\b/.test(txt)) return "pmtiles";
  if (/react-dom|scheduler\.production|react\.production/.test(txt)) return "react";
  if (/@turf|booleanPointInPolygon|turf/.test(txt)) return "turf";
  if (/d3-contour|contourDensity|d3\.contours/.test(txt)) return "d3-contour";
  return "app+vendor";
}

/**
 * Split JS resource-timing entries into INITIAL vs LAZY by an explicit interactive mark
 * (task 017). PURE — no I/O, no browser.
 *
 * @param entries  [{ name, startTime, ... }] — startTime relative to navigation start
 * @param markTime number|null — time of `hf:interactive`; null ⇒ no deferral boundary emitted
 * @returns { initial, lazy, boundaryDetected }
 *
 * Rule: markTime==null ⇒ EVERY entry is INITIAL (the correct reading for a build with no
 * boundary — e.g. the pre-defer baseline). Otherwise an entry is LAZY iff it was requested
 * STRICTLY AFTER the mark (`startTime > markTime`); a chunk racing the mark exactly counts as
 * INITIAL — the conservative direction for a budget (borderline bytes count toward the ceiling),
 * and the deferred map is scheduled strictly after the mark anyway. Immune to the `networkidle0`
 * trap where an idle-fired import lands inside the initial window and is miscounted as critical.
 */
export function classifyByMark(entries, markTime) {
  if (markTime == null) {
    return { initial: entries.slice(), lazy: [], boundaryDetected: false };
  }
  const initial = [];
  const lazy = [];
  for (const e of entries) {
    if (e.startTime > markTime) lazy.push(e);
    else initial.push(e);
  }
  return { initial, lazy, boundaryDetected: true };
}

/** True iff any entry in the set is bucketed maplibre or pmtiles (the deferral target). */
export function hasMapEngine(entries) {
  return entries.some((e) => e._bucket === "maplibre" || e._bucket === "pmtiles");
}
