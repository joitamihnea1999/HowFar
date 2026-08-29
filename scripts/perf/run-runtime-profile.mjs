// Runtime profile of the three hot interactions (deliverable 3):
//   A. address select → ring reveal
//   B. mode toggle (walk → car)
//   C. pan/zoom gesture
// For each we capture main-thread long-task time, and React COMMIT count. For (C) we also
// capture frame cadence (median fps + worst frame) during the gesture.
//
// React commit counting works WITHOUT touching app code: we install a minimal
// __REACT_DEVTOOLS_GLOBAL_HOOK__ before any script runs; production React still calls
// onCommitFiberRoot on every commit if the hook is present (this is what DevTools relies
// on). A commit == one React render pass reaching the DOM. The owner's architecture claim
// is that pan/zoom is render-free — i.e. interaction C should produce ~0 commits.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openBrowser, closeBrowser } from "./browser.mjs";
import { TARGET_URL, BUDGETS, median, percentile } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const INSTRUMENT = () => {
  // React commit counter (installed before React loads).
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

  // Long-task observer (cumulative).
  window.__longtasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longtasks.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}

  // Frame recorder (rAF interval sampling), started/stopped on demand.
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

async function main() {
  const ctx = await openBrowser();
  const { page } = ctx;
  await page.evaluateOnNewDocument(INSTRUMENT);

  const results = [];
  await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="app-map"] canvas', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500)); // let the initial camera settle

  // ---- A. address select → ring reveal ----
  const a = await delta(
    page,
    async () => {
      const iso = page.waitForResponse((r) => /\/api\/isochrone/.test(r.url()), { timeout: 30000 }).catch(() => null);
      await page.click('input[role="combobox"]');
      await page.type('input[role="combobox"]', "Piata Unirii");
      await page.waitForSelector('[role="option"]', { timeout: 15000 });
      await page.click('[role="option"]');
      await iso;
      await new Promise((r) => setTimeout(r, 2500)); // ring reveal animation + amenities
    },
    "A: address select → ring reveal",
  );
  results.push(a);

  // ---- B. mode toggle (walk → car) ----
  // On the mobile shell, selecting an address COLLAPSES the top command dock to a
  // StatePill to give the map the screen (shell.dock === "collapsed"). The Travel-mode
  // control only re-mounts when the pill is expanded, so expand it FIRST (setup, outside
  // the measured window) — otherwise the toggle isn't in the DOM.
  const pill = await page.$('[data-testid="state-pill"]');
  if (pill) {
    await pill.click();
    await page.waitForSelector('[role="group"][aria-label="Travel mode"] button', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 800));
  }
  const b = await delta(
    page,
    async () => {
      const car = page.waitForResponse((r) => /\/api\/car/.test(r.url()), { timeout: 15000 }).catch(() => null);
      const btns = await page.$$('[role="group"][aria-label="Travel mode"] button');
      if (btns.length >= 3) await btns[2].click(); // walk[0] transit[1] car[2]
      await car;
      await new Promise((r) => setTimeout(r, 2000));
    },
    "B: mode toggle (walk→car)",
  );
  results.push(b);

  // ---- C. pan/zoom gesture (should be render-free) ----
  // Find a point that actually hits the map canvas (not the command dock or result sheet).
  // If the drag started on an overlay the map wouldn't move and we'd falsely read ~60fps
  // idle — so verify elementFromPoint lands on the canvas before dragging.
  const box = await page.$eval('[data-testid="app-map"] canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
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
    box.x,
    box.y,
    box.w,
    box.h,
  );
  if (!pick.hit) console.error("[profile] WARNING: could not find a clear canvas point; pan may hit an overlay");
  const cy = pick.y;

  const readFrames = () =>
    page.evaluate(() => {
      window.__frameRec.on = false;
      const t = window.__frameRec.times;
      const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      return d;
    });
  const frameStats = (raw) => {
    const intervals = raw.filter((x) => x > 0 && x < 1000);
    const medFrame = median(intervals);
    return {
      frames: intervals.length,
      medianFrameMs: +medFrame.toFixed(2),
      medianFps: +(1000 / medFrame).toFixed(1),
      maxFrameMs: +Math.max(...intervals, 0).toFixed(2),
      p95FrameMs: +percentile(intervals, 95).toFixed(2),
      framesOver32ms: intervals.filter((x) => x > BUDGETS.panZoomMaxFrameMs).length,
    };
  };

  // Let the mode-toggle's ring reveal + amenity placement fully settle so the idle window
  // is genuinely idle (not measuring the tail of interaction B).
  await new Promise((r) => setTimeout(r, 2500));

  // Idle BASELINE (control): same ~3.5s window, no input. Establishes the throttled render
  // ceiling and the ambient React-commit rate, so "render-free gesture" means gesture
  // commits are no more than idle commits — a single settle-commit is not per-frame churn.
  await page.evaluate(() => {
    window.__frameRec = { on: true, times: [] };
  });
  const idle = await delta(page, async () => new Promise((r) => setTimeout(r, 3500)), "IDLE baseline (no input)");
  idle._frames = frameStats(await readFrames());

  await page.evaluate(() => {
    window.__frameRec = { on: true, times: [] };
  });
  const c = await delta(
    page,
    async () => {
      // Pan: a slow drag across the map (mouse == MapLibre DragPan handler).
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 30; i++) {
        await page.mouse.move(cx - i * 4, cy - i * 2);
        await new Promise((r) => setTimeout(r, 16));
      }
      await page.mouse.up();
      // Zoom: a few wheel steps.
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel({ deltaY: -120 });
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 400));
    },
    "C: pan/zoom gesture",
  );
  Object.assign(c, frameStats(await readFrames()));
  c.idleCommits = idle.commits;
  c.idleMedianFps = idle._frames.medianFps;
  results.splice(2, 0, idle); // keep idle before the gesture in the printed order
  results.push(c);

  const report = {
    takenAt: new Date().toISOString(),
    target: TARGET_URL,
    device: ctx.emulated ? "emulated (4x CPU, Slow 4G, mobile viewport)" : "real-android (attached)",
    emulationBased: ctx.emulated,
    note:
      "React COMMIT count via an injected __REACT_DEVTOOLS_GLOBAL_HOOK__ (prod React still " +
      "fires onCommitFiberRoot). Interaction C (pan/zoom) is expected render-free (~0 commits) " +
      "if the controller architecture keeps gestures out of React. Frame cadence via rAF sampling.",
    interactions: results,
    panZoom: {
      medianFps: c.medianFps,
      maxFrameMs: c.maxFrameMs,
      p95FrameMs: c.p95FrameMs,
      framesOver32ms: c.framesOver32ms,
      totalFrames: c.frames,
      commitsDuringGesture: c.commits,
      idleCommitsSameWindow: c.idleCommits,
      idleMedianFps: c.idleMedianFps,
      budgets: { medianFps: BUDGETS.panZoomMedianFps, maxFrameMs: BUDGETS.panZoomMaxFrameMs },
      verdictFps: c.medianFps >= BUDGETS.panZoomMedianFps ? "PASS" : "FAIL",
      verdictMaxFrame: c.maxFrameMs <= BUDGETS.panZoomMaxFrameMs ? "PASS" : "FAIL",
      // Render-free == the gesture adds no React commits beyond the ambient idle rate.
      renderFree: c.commits <= c.idleCommits,
      renderFreeNote: `gesture ${c.commits} commit(s) vs idle ${c.idleCommits} in an equal window`,
    },
  };

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "runtime-profile.json"), JSON.stringify(report, null, 2));

  console.log(`\n=== RUNTIME PROFILE — ${report.device} ===`);
  for (const r of results) {
    console.log(`\n${r.label}`);
    console.log(`  wall ${r.wallMs} ms · React commits ${r.commits} · main-thread long-task ${Math.round(r.longtaskMs)} ms (${r.longtaskCount} tasks)`);
    if (r._frames) console.log(`  idle: median ${r._frames.medianFps} fps · worst ${r._frames.maxFrameMs} ms (throttled render ceiling)`);
    if (r.medianFps !== undefined)
      console.log(`  pan/zoom: median ${r.medianFps} fps (${r.medianFrameMs} ms/frame) · worst ${r.maxFrameMs} ms · p95 ${r.p95FrameMs} ms · frames>32ms: ${r.framesOver32ms}/${r.frames}`);
  }
  console.log(`\nGesture render-free (gesture commits ≤ idle commits): ${report.panZoom.renderFree ? "YES ✓ (claim holds — " + report.panZoom.renderFreeNote + ")" : "NO ✗ — " + report.panZoom.renderFreeNote + " (claim in doubt)"}`);
  console.log(`pan/zoom median fps ${report.panZoom.medianFps} (budget ≥55 → ${report.panZoom.verdictFps}) · worst frame ${report.panZoom.maxFrameMs} ms (budget ≤32 → ${report.panZoom.verdictMaxFrame})`);
  if (report.emulationBased) console.log(`[EMU] emulation-based — re-measure on a real Android (see README).`);
  console.log(`Wrote ${join(outDir, "runtime-profile.json")}`);

  await closeBrowser(ctx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
