// Unit tests for the pure bundle classifier (task 017). Runs with the built-in
// `node --test` — NO puppeteer/chrome, so it executes in the app's check:ci without the
// isolated perf deps. Proves the INITIAL/LAZY split rule that both the measurement and the CI
// budget gate depend on, so a regression in the rule fails a close (not just a measurement).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyByMark, hasMapEngine, bucketOf } from "./bundle-classify.mjs";

const E = (name, startTime, _bucket) => ({ name, startTime, _bucket });

test("no mark ⇒ every entry is INITIAL (pre-defer baseline reading)", () => {
  const entries = [E("a.js", 10), E("b.js", 900)];
  const r = classifyByMark(entries, null);
  assert.equal(r.boundaryDetected, false);
  assert.equal(r.initial.length, 2);
  assert.equal(r.lazy.length, 0);
});

test("with a mark, requests strictly AFTER it are LAZY, before/at it are INITIAL", () => {
  const mark = 500;
  const entries = [
    E("shell.js", 120), // before → initial
    E("react.js", 300), // before → initial
    E("edge.js", 500), // exactly at mark → initial (conservative)
    E("map.js", 501), // after → lazy
    E("map2.js", 1400), // after → lazy
  ];
  const r = classifyByMark(entries, mark);
  assert.equal(r.boundaryDetected, true);
  assert.deepEqual(r.initial.map((e) => e.name), ["shell.js", "react.js", "edge.js"]);
  assert.deepEqual(r.lazy.map((e) => e.name), ["map.js", "map2.js"]);
});

test("the deferred-map case: maplibre requested after the mark lands in LAZY, not INITIAL", () => {
  const mark = 400;
  const entries = [
    E("shell.js", 100, "app+vendor"),
    E("react.js", 150, "react"),
    E("maplibre.js", 700, "maplibre"), // scheduled on idle after hf:interactive
    E("pmtiles.js", 720, "pmtiles"),
  ];
  const { initial, lazy } = classifyByMark(entries, mark);
  assert.equal(hasMapEngine(initial), false, "map engine must NOT be in the initial set");
  assert.equal(hasMapEngine(lazy), true, "map engine must be in the lazy set");
});

test("the trap it fixes: an idle-fired import inside the network-idle window is still LAZY", () => {
  // Under the old networkidle0 heuristic this maplibre request (fired shortly after paint, well
  // within the 500ms idle window) was counted INITIAL. Classified by the mark it is LAZY.
  const mark = 350;
  const entries = [E("shell.js", 200, "app+vendor"), E("maplibre.js", 360, "maplibre")];
  const { initial, lazy } = classifyByMark(entries, mark);
  assert.equal(hasMapEngine(initial), false);
  assert.equal(hasMapEngine(lazy), true);
});

test("hasMapEngine detects maplibre or pmtiles buckets only", () => {
  assert.equal(hasMapEngine([E("a", 1, "react"), E("b", 2, "app+vendor")]), false);
  assert.equal(hasMapEngine([E("a", 1, "pmtiles")]), true);
  assert.equal(hasMapEngine([E("a", 1, "maplibre")]), true);
});

test("bucketOf: the ENGINE (shader source) is maplibre; app code that only names maplibre CSS classes is NOT", () => {
  // Regression for the task-017 false positive: a 45 KB APP chunk that merely referenced the
  // `.maplibregl-ctrl` CSS class was mis-bucketed "maplibre" by the old bare-substring match,
  // which would have made the CI laziness gate mis-fire on a correctly-deferred build.
  const dir = mkdtempSync(join(tmpdir(), "bundle-classify-"));
  const engine = "engine.js";
  const appWithClass = "app-cluster.js";
  const plainApp = "app-plain.js";
  // Real engine bundles inline WebGL shader source as string literals.
  writeFileSync(join(dir, engine), 'var s="attribute vec2 a_pos; void main(){ gl_Position = u_matrix * vec4(a_pos,0,1); }"; maplibregl.Map=1;');
  // App code that positions the zoom control by class name — names maplibre, no shader.
  writeFileSync(join(dir, appWithClass), 'document.querySelector(".maplibregl-ctrl-bottom-right"); var cfg={"circle-radius":5};');
  writeFileSync(join(dir, plainApp), 'export const groceries = [{label:"Groceries"}];');

  assert.equal(bucketOf(engine, dir), "maplibre", "shader-bearing engine chunk is maplibre");
  assert.equal(bucketOf(appWithClass, dir), "app+vendor", "app chunk naming a maplibre CSS class is NOT maplibre");
  assert.equal(bucketOf(plainApp, dir), "app+vendor");
});

test("bucketOf: pmtiles chunk is pmtiles, not maplibre", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-classify-pm-"));
  writeFileSync(join(dir, "pm.js"), 'class PMTiles { constructor(){} } // pmtiles reader');
  assert.equal(bucketOf("pm.js", dir), "pmtiles");
});
