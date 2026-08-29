// Runtime profile of the three hot interactions (deliverable 3), repeated over N runs:
//   A. address select → ring reveal
//   B. mode toggle (walk → car)
//   C. pan/zoom gesture  (real TOUCH: one-finger pan + two-finger pinch, via CDP)
// For each we capture main-thread long-task time and React COMMIT count; for (C) also frame
// cadence (median fps + worst frame) during the gesture, against an equal-length IDLE control.
//
// React commit counting works WITHOUT touching app code: we install a minimal
// __REACT_DEVTOOLS_GLOBAL_HOOK__ before any script runs; production React still calls
// onCommitFiberRoot on every commit if the hook is present. A commit == one render pass. The
// owner's architecture claim is that pan/zoom is render-free — interaction C should add no
// commits over idle.
//
// Reported numbers are the MEDIAN across PERF_RUNS runs (each a fresh page load), with the
// per-run range, so run-to-run variance is visible (not a single-shot claim).
//
// CAVEAT recorded in every report: on a display-less host the WebGL renderer is SwiftShader
// (software rasterization), which inflates the pan/zoom fps figure — real-device re-measure
// is mandatory for that row, not advisory.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openBrowser, closeBrowser, webglRenderer } from "./browser.mjs";
import { TARGET_URL, RUNS, BUDGETS, median, percentile } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const INSTRUMENT = () => {
  const hook = {
    supportsFiber: true,
    renderers: new Map(),
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onCommitFiberRoot() {
      window.__perfCommits = (window.__perfCommits || 0) + 1;
    },
    inject() {
      return 1;
    },
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: false });
  window.__perfCommits = 0;
  window.__longtasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longtasks.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  window.__frameRec = { on: false, times: [] };
  const tick = (t) => {
    if (window.__frameRec.on) window.__frameRec.times.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function marks(page) {
  return page.evaluate(() => ({
    commits: window.__perfCommits || 0,
    longtaskMs: (window.__longtasks || []).reduce((a, b) => a + b, 0),
    longtaskCount: (window.__longtasks || []).length,
  }));
}

async function delta(page, fn, label) {
  await page.evaluate(() => {
    window.__perfCommits = 0;
    window.__longtasks = [];
  });
  const t0 = Date.now();
  await fn();
  const wallMs = Date.now() - t0;
  const m = await marks(page);
  return { label, wallMs, ...m };
}

const readFrames = (page) =>
  page.evaluate(() => {
    window.__frameRec.on = false;
    const t = window.__frameRec.times;
    const d = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    return d;
  });
const startFrames = (page) => page.evaluate(() => {
  window.__frameRec = { on: true, times: [] };
});
const MIN_FRAMES = 20;
function frameStats(raw) {
  // Keep real stalls (a 500 ms frozen frame is exactly what the worst-frame budget targets);
  // drop only clearly-bogus intervals (rAF paused when the tab is backgrounded, > 5 s).
  const intervals = raw.filter((x) => x > 0 && x < 5000);
  const medFrame = median(intervals);
  // Fail CLOSED on too few frames: a frozen main thread records few ticks, which would make
  // maxFrameMs collapse to Math.max(...[],0)=0 and falsely PASS the "no frame >32ms" budget —
  // the worse the stall, the better the score. Mark the run unreliable instead.
  const reliable = intervals.length >= MIN_FRAMES;
  return {
    frames: intervals.length,
    reliable,
    medianFrameMs: +medFrame.toFixed(2),
    medianFps: +(1000 / medFrame).toFixed(1),
    maxFrameMs: +Math.max(...intervals, 0).toFixed(2),
    p95FrameMs: +percentile(intervals, 95).toFixed(2),
    framesOver32ms: intervals.filter((x) => x > BUDGETS.panZoomMaxFrameMs).length,
  };
}

// ---- CDP touch helpers (drive MapLibre's Touch* handlers, the real mobile path) ----
// Frames are dispatched on a FIXED wall-clock cadence and NOT awaited one-by-one — awaiting
// each dispatchTouchEvent (it resolves on the renderer's ACK) would let a slow renderer set
// the input rate, so the emulator and a real device would receive different gestures and the
// fps figures wouldn't be comparable. We schedule every frame at step·interval and await the
// whole batch at the end.
const CADENCE_MS = 16;
async function dispatchSequence(client, frames) {
  const promises = [];
  const t0 = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const due = t0 + i * CADENCE_MS;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    promises.push(client.send("Input.dispatchTouchEvent", frames[i]).catch(() => {}));
  }
  await Promise.all(promises);
}
async function touchPan(client, cx, cy) {
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y) }];
  const frames = [{ type: "touchStart", touchPoints: pt(cx, cy) }];
  for (let i = 1; i <= 30; i++) frames.push({ type: "touchMove", touchPoints: pt(cx - i * 4, cy - i * 2) });
  frames.push({ type: "touchEnd", touchPoints: [] });
  await dispatchSequence(client, frames);
}
async function touchPinch(client, cx, cy) {
  const two = (d) => [
    { x: Math.round(cx - d), y: Math.round(cy), id: 0 },
    { x: Math.round(cx + d), y: Math.round(cy), id: 1 },
  ];
  const frames = [{ type: "touchStart", touchPoints: two(20) }];
  for (let i = 1; i <= 20; i++) frames.push({ type: "touchMove", touchPoints: two(20 + i * 6) });
  frames.push({ type: "touchEnd", touchPoints: [] });
  await dispatchSequence(client, frames);
}

// Read the MapLibre camera (exposed at window.__hfMap by AppMap) — a SOUND movement proof:
// unlike a canvas screenshot hash, an unchanged center+zoom means the gesture truly did
// nothing, and background tile/label repaint can't spoof it.
async function camera(page) {
  return page.evaluate(() => {
    const m = window.__hfMap;
    if (!m) return null;
    const c = m.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing() };
  });
}
function cameraMoved(a, b) {
  if (!a || !b) return null; // map not reachable — can't prove either way
  return Math.abs(a.lng - b.lng) > 1e-6 || Math.abs(a.lat - b.lat) > 1e-6 || Math.abs(a.zoom - b.zoom) > 1e-3;
}

// One touch pan+pinch over a clear canvas point, with frame capture. Returns frame stats +
// whether the camera actually moved.
async function gestureOnce(page, client, box, label) {
  const cx = box.x + box.w / 2;
  const pick = await page.evaluate(
    (bx, by, bw, bh) => {
      for (const frac of [0.5, 0.55, 0.45, 0.6, 0.4, 0.65]) {
        const y = by + bh * frac;
        const el = document.elementFromPoint(bx + bw / 2, y);
        if (el && el.tagName === "CANVAS") return { y, hit: true };
      }
      return { y: by + bh * 0.5, hit: false };
    },
    box.x, box.y, box.w, box.h,
  );
  if (!pick.hit) throw new Error(`${label}: no clear canvas point (overlays cover the map)`);
  const cy = pick.y;
  const before = await camera(page);
  await startFrames(page);
  const d = await delta(
    page,
    async () => {
      await touchPan(client, cx, cy);
      await new Promise((r) => setTimeout(r, 200));
      await touchPinch(client, cx, cy);
      await new Promise((r) => setTimeout(r, 400));
    },
    label,
  );
  Object.assign(d, frameStats(await readFrames(page)));
  const after = await camera(page);
  d.cameraMoved = cameraMoved(before, after);
  if (d.cameraMoved === false) throw new Error(`${label}: the MapLibre camera did not change — the synthetic touch had NO effect; refusing to report an idle cadence as a pan/zoom result`);
  return d;
}

// A different address per run so each run's ring-reveal is genuinely cold (the server-side
// ApiCache would otherwise make runs 2+ warm; the DB flush is gated by the interlock).
const RUN_ADDRESSES = ["Piata Unirii", "Piata Romana", "Piata Victoriei", "Gara de Nord", "Piata Universitatii", "Arcul de Triumf"];

async function oneRun(page, client, runIdx) {
  await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="app-map"] canvas', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const boxOf = () => page.$eval('[data-testid="app-map"] canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // CONTROL: a pan/zoom on the BARE BASEMAP (before any address is selected), so the cost of
  // the app layers (rings + amenity symbols/labels) can be isolated from MapLibre's baseline
  // — otherwise "15 fps" can't tell us whether simplifying those layers (the gap #4 fix) helps.
  const bare = await gestureOnce(page, client, await boxOf(), "BARE basemap pan/zoom (control)");

  // A. address select → ring reveal. Assert the isochrone call SUCCEEDS (don't swallow a
  // failure and then report a bogus "interaction").
  const address = RUN_ADDRESSES[runIdx % RUN_ADDRESSES.length];
  const a = await delta(
    page,
    async () => {
      const iso = page.waitForResponse((r) => /\/api\/isochrone/.test(r.url()), { timeout: 30000 });
      await page.click('input[role="combobox"]');
      await page.type('input[role="combobox"]', address);
      await page.waitForSelector('[role="option"]', { timeout: 15000 });
      await page.click('[role="option"]');
      const res = await iso;
      if (res.status() >= 400) throw new Error(`address-select: /api/isochrone returned ${res.status()} — refusing to report a failed ring-reveal as a measurement`);
      await new Promise((r) => setTimeout(r, 2500));
    },
    `A: address select → ring reveal (${address})`,
  );

  // B. mode toggle (walk → car). On mobile the dock collapses to a state-pill after
  // selection; expand it first (setup, outside the measured window) to re-mount ModeToggle.
  const pill = await page.$('[data-testid="state-pill"]');
  if (pill) {
    await pill.click();
    await page.waitForSelector('[role="group"][aria-label="Travel mode"] button', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 800));
  }
  const b = await delta(
    page,
    async () => {
      const car = page.waitForResponse((r) => /\/api\/car/.test(r.url()), { timeout: 15000 });
      const btns = await page.$$('[role="group"][aria-label="Travel mode"] button');
      if (btns.length < 3) throw new Error("mode toggle: fewer than 3 mode buttons found — interaction cannot be measured");
      await btns[2].click(); // walk[0] transit[1] car[2]
      const res = await car;
      if (res.status() >= 400) throw new Error(`mode toggle: /api/car returned ${res.status()} — refusing to report a failed toggle as a measurement`);
      await new Promise((r) => setTimeout(r, 2000));
    },
    "B: mode toggle (walk→car)",
  );
  // Fail loudly unless the mode actually changed — a silently-missed click would report a
  // bogus "toggle" result.
  const carPressed = await page.$eval(
    '[role="group"][aria-label="Travel mode"] button:nth-child(3)',
    (el) => el.getAttribute("aria-pressed"),
  ).catch(() => null);
  if (carPressed !== "true") throw new Error(`mode toggle did NOT switch to car (aria-pressed=${carPressed}) — refusing to report a bogus interaction`);

  // C. pan/zoom (touch) WITH the app layers loaded. Settle first so the following idle window
  // is truly idle. Sound movement proof via the MapLibre camera (window.__hfMap).
  await new Promise((r) => setTimeout(r, 2500));
  const c = await gestureOnce(page, client, await boxOf(), "C: pan/zoom (touch, app layers)");

  // Idle control sized to the gesture's wall time, so render-free compares like with like.
  await new Promise((r) => setTimeout(r, 1500));
  await startFrames(page);
  const idle = await delta(page, async () => new Promise((r) => setTimeout(r, Math.max(1000, c.wallMs))), "IDLE baseline");
  idle._frames = frameStats(await readFrames(page));

  c.commitRate = +(c.commits / (c.wallMs / 1000)).toFixed(3);
  idle.commitRate = +(idle.commits / (idle.wallMs / 1000)).toFixed(3);

  return { bare, a, b, idle, c };
}

async function main() {
  const ctx = await openBrowser();
  const { page } = ctx;
  const client = await page.createCDPSession();
  await client.send("Network.setCacheDisabled", { cacheDisabled: true }); // no HTTP cache across runs
  await page.evaluateOnNewDocument(INSTRUMENT);

  const gl = await (async () => {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    return webglRenderer(page);
  })();

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`[profile] run ${i + 1}/${RUNS} ...\n`);
    runs.push(await oneRun(page, client, i));
  }

  // Aggregate: median (+ range) across runs of each per-run figure.
  const across = (sel) => runs.map(sel);
  const agg = (xs) => ({ median: +median(xs).toFixed(2), min: +Math.min(...xs).toFixed(2), max: +Math.max(...xs).toFixed(2) });

  const panZoom = {
    medianFps: agg(across((r) => r.c.medianFps)),
    maxFrameMs: agg(across((r) => r.c.maxFrameMs)),
    // The "no frame > 32ms" budget is absolute — one bad frame in any run violates it, so the
    // verdict is taken on the WORST frame across ALL runs, not the median of per-run worsts.
    worstFrameAllRunsMs: +Math.max(...across((r) => r.c.maxFrameMs)).toFixed(2),
    framesOver32ms: agg(across((r) => r.c.framesOver32ms)),
    commitsDuringGesture: agg(across((r) => r.c.commits)),
    commitRate: agg(across((r) => r.c.commitRate)),
    idleCommits: agg(across((r) => r.idle.commits)),
    idleCommitRate: agg(across((r) => r.idle.commitRate)),
    idleFps: agg(across((r) => r.idle._frames.medianFps)),
    longtaskMs: agg(across((r) => r.c.longtaskMs)),
  };
  const interactionA = { commits: agg(across((r) => r.a.commits)), longtaskMs: agg(across((r) => r.a.longtaskMs)) };
  const interactionB = { commits: agg(across((r) => r.b.commits)), longtaskMs: agg(across((r) => r.b.longtaskMs)) };

  // Render-free == the gesture's commit RATE does not exceed idle's (matched-duration windows).
  const renderFree = runs.every((r) => r.c.commitRate <= r.idle.commitRate + 0.01);
  // Every gesture must have (a) actually moved the camera and (b) recorded enough frames.
  const allReliable = runs.every((r) => r.c.reliable && r.bare.reliable && r.c.cameraMoved !== false);
  const bareFps = agg(across((r) => r.bare.medianFps));
  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    runs: RUNS,
    device: ctx.emulated ? "emulated (4x CPU, Slow 4G, mobile viewport)" : "real-android (attached)",
    emulationBased: ctx.emulated,
    webglRenderer: gl.renderer,
    softwareWebgl: gl.software,
    gesture: "touch (one-finger pan + two-finger pinch, via CDP Input.dispatchTouchEvent)",
    note:
      "Median (+range) across N runs. React commits via injected __REACT_DEVTOOLS_GLOBAL_HOOK__. " +
      (gl.software
        ? "WebGL is SOFTWARE (SwiftShader) on this host — the pan/zoom fps is inflated by software rasterization; real-device re-measure is MANDATORY for that row."
        : "WebGL renderer recorded above."),
    perRun: runs.map((r, i) => ({
      run: i + 1,
      A: { commits: r.a.commits, longtaskMs: Math.round(r.a.longtaskMs) },
      B: { commits: r.b.commits, longtaskMs: Math.round(r.b.longtaskMs) },
      idle: { fps: r.idle._frames.medianFps, commits: r.idle.commits },
      panZoom: { fps: r.c.medianFps, maxFrameMs: r.c.maxFrameMs, over32: r.c.framesOver32ms, commits: r.c.commits },
    })),
    interactionA,
    interactionB,
    barePanZoomFps: bareFps, // control: bare basemap, no app layers
    panZoom,
    reliable: allReliable,
    renderFree,
    renderFreeBasis: "gesture commit RATE ≤ idle commit RATE, matched-duration windows, every run",
    cameraMoveProof: "window.__hfMap center/zoom changed by the gesture (sound; not a pixel hash)",
    verdictFps: panZoom.medianFps.median >= BUDGETS.panZoomMedianFps ? "PASS" : "FAIL",
    verdictMaxFrame: panZoom.worstFrameAllRunsMs <= BUDGETS.panZoomMaxFrameMs ? "PASS" : "FAIL",
  };

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "runtime-profile.json"), JSON.stringify(report, null, 2));

  console.log(`\n=== RUNTIME PROFILE — ${report.device}, median of ${RUNS} runs ===`);
  console.log(`WebGL renderer: ${gl.renderer}${gl.software ? "  ⚠ SOFTWARE (inflates pan/zoom fps)" : ""}`);
  console.log(`A address→rings: ${interactionA.commits.median} commits, ${Math.round(interactionA.longtaskMs.median)} ms long-task`);
  console.log(`B mode toggle  : ${interactionB.commits.median} commits, ${Math.round(interactionB.longtaskMs.median)} ms long-task`);
  console.log(`Idle baseline  : ${panZoom.idleFps.median} fps, ${panZoom.idleCommits.median} commits`);
  console.log(`Bare basemap pan/zoom (control, no app layers): median ${bareFps.median} fps [${bareFps.min}–${bareFps.max}]`);
  console.log(`Pan/zoom (touch, app layers): median ${panZoom.medianFps.median} fps [${panZoom.medianFps.min}–${panZoom.medianFps.max}] (budget ≥55 → ${report.verdictFps}) · worst frame (all runs) ${panZoom.worstFrameAllRunsMs} ms (budget ≤32 → ${report.verdictMaxFrame})`);
  if (!allReliable) console.log(`⚠ some run was UNRELIABLE (too few frames or camera did not move) — treat with caution`);
  console.log(`Gesture render-free (commit RATE ≤ idle, matched windows, every run): ${renderFree ? "YES ✓ (claim holds)" : "NO ✗"} — gesture ${panZoom.commitRate.min}–${panZoom.commitRate.max}/s vs idle ${panZoom.idleCommitRate.min}–${panZoom.idleCommitRate.max}/s`);
  if (report.emulationBased) console.log(`[EMU] emulation-based${gl.software ? " + SOFTWARE WebGL" : ""} — re-measure on a real Android (see README).`);
  console.log(`Wrote ${join(outDir, "runtime-profile.json")}`);

  await closeBrowser(ctx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
