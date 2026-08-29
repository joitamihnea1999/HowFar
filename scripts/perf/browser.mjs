// Shared Chrome control for the perf harness. Two modes, one interface:
//   emulated → launch a local headless Chrome (chrome-launcher) and apply CPU + 4G +
//              mobile-viewport emulation via CDP, so it mimics a mid-range phone.
//   real     → attach (puppeteer.connect) to a Chrome already running on a real Android,
//              reached over its adb-forwarded remote-debugging port. NO emulation — the
//              device is the device. This is the one-command real-device re-run path.
//
// Everything downstream (bundle, runtime profile, API latency) drives the returned page,
// so the SAME measurement code runs on both the emulator and a real handset.
import { launch } from "chrome-launcher";
import puppeteer from "puppeteer-core";
import {
  CPU_SLOWDOWN,
  NETWORK_4G,
  MOBILE_VIEWPORT,
  IS_REAL_DEVICE,
  CDP_PORT,
} from "./config.mjs";

// opts.throttle (default true): apply CPU + 4G emulation. Pass false for API-latency
// probing, where we want the stack's own latency, not a simulated-transport number.
export async function openBrowser(opts = {}) {
  const throttle = opts.throttle !== false;
  if (IS_REAL_DEVICE) {
    // Real device: attach over the adb-forwarded DevTools port. The device's own CPU and
    // radio provide the real throttling, so we apply none.
    const browserURL = `http://localhost:${CDP_PORT}`;
    const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    return { browser, page, chrome: null, emulated: false };
  }

  // Emulated: launch a headless Chrome we fully control.
  const chrome = await launch({
    chromeFlags: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--window-size=${MOBILE_VIEWPORT.width},${MOBILE_VIEWPORT.height}`,
    ],
  });
  const browser = await puppeteer.connect({
    browserURL: `http://localhost:${chrome.port}`,
    defaultViewport: null,
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  if (throttle) await applyEmulation(page);
  return { browser, page, chrome, emulated: throttle };
}

// Apply mid-range-phone emulation to a page (CPU 4x, Slow 4G, mobile viewport). Uses CDP
// directly so the exact same knobs as Lighthouse's mobile preset are set.
export async function applyEmulation(page) {
  const client = await page.createCDPSession();
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: NETWORK_4G.latencyMs,
    downloadThroughput: NETWORK_4G.downloadThroughputBps,
    uploadThroughput: NETWORK_4G.uploadThroughputBps,
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  await page.setViewport({
    width: MOBILE_VIEWPORT.width,
    height: MOBILE_VIEWPORT.height,
    deviceScaleFactor: MOBILE_VIEWPORT.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });
  return client;
}

// Read the UNMASKED WebGL renderer for the page's GL context. On a display-less CI/dev host
// this is SwiftShader (software rasterization), which materially inflates GL-bound metrics
// (pan/zoom fps especially) — so every report records it and the audit discloses it. Returns
// { renderer, software } where `software` is true for SwiftShader/llvmpipe/software backends.
export async function webglRenderer(page) {
  try {
    const renderer = await page.evaluate(() => {
      const cv = document.createElement("canvas");
      const gl = cv.getContext("webgl") || cv.getContext("experimental-webgl");
      if (!gl) return "NO_WEBGL";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "UNKNOWN";
    });
    return { renderer, software: /swiftshader|llvmpipe|software|swrast/i.test(renderer) };
  } catch {
    return { renderer: "UNAVAILABLE", software: null };
  }
}

export async function closeBrowser(ctx) {
  try {
    if (ctx.chrome) {
      // We LAUNCHED this Chrome (local emulator, throttled or not) — kill it so the process
      // exits. This is independent of whether throttling was applied.
      await ctx.browser.close();
      await ctx.chrome.kill();
    } else {
      // Real device: we only attached, so disconnect and leave the device's Chrome running.
      ctx.browser.disconnect();
    }
  } catch {
    /* best-effort teardown */
  }
}
