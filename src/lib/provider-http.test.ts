import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isRetriableFetchError,
  providerFetch,
  ProviderError,
  retryOnceOnTransient,
  roundCoord,
  sha256Hex,
  timedFetch,
  withRateLimit,
} from "./provider-http";

describe("helpers", () => {
  it("sha256Hex is stable and 64 hex chars", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });

  it("roundCoord fixes to 5 decimals", () => {
    expect(roundCoord(44.426789)).toBe("44.42679");
    expect(roundCoord(26.1)).toBe("26.10000");
  });
});

describe("withRateLimit", () => {
  it("serializes concurrent same-host calls with >= interval spacing", async () => {
    const starts: number[] = [];
    const interval = 60;
    const task = () => {
      starts.push(Date.now());
      return Promise.resolve("ok");
    };
    await Promise.all([
      withRateLimit("host-a", interval, task),
      withRateLimit("host-a", interval, task),
      withRateLimit("host-a", interval, task),
    ]);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(interval - 20);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(interval - 20);
  });

  it("keeps the chain alive after a rejected call", async () => {
    await expect(
      withRateLimit("host-b", 5, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(withRateLimit("host-b", 5, () => Promise.resolve("recovered"))).resolves.toBe(
      "recovered",
    );
  });

  it("bypasses the serialize-chain at interval 0 — concurrent callers do NOT queue (task 009)", async () => {
    // Self-host "no throttle": three same-bucket calls at interval 0 must all
    // start before any resolves, i.e. run concurrently rather than one-at-a-time.
    const starts: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const task = () => {
      starts.push(Date.now());
      return gate.then(() => "ok");
    };
    const all = Promise.all([
      withRateLimit("zero-bucket", 0, task),
      withRateLimit("zero-bucket", 0, task),
      withRateLimit("zero-bucket", 0, task),
    ]);
    // Let microtasks settle; with a bypass all three fn()s have started already.
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toHaveLength(3); // would be 1 if the chain still serialized
    release();
    await all;
  });
});

describe("timedFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aborts the underlying request when it exceeds the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }),
    );
    await expect(timedFetch("http://example.test", {}, 30)).rejects.toThrow(/abort/i);
  });

  it("returns the response when it resolves in time", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("ok")));
    const res = await timedFetch("http://example.test", {}, 1000);
    expect(await res.text()).toBe("ok");
  });

  it("aborts the underlying request when an external signal fires (multi-host race loser)", async () => {
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          seenSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }),
    );
    const external = new AbortController();
    // Long internal timeout, so only the EXTERNAL signal can end this call.
    const pending = timedFetch("http://example.test", {}, 30_000, external.signal);
    external.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(seenSignal?.aborted).toBe(true); // external abort propagated to fetch
  });
});

describe("providerFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("composes the rate limiter and the timed fetch (the path every provider call takes)", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response("composed"));
    });
    const res = await providerFetch("http://example.test", {
      provider: "nominatim",
      rateHost: "compose.test",
      minIntervalMs: 0,
      timeoutMs: 1000,
      init: { headers: { "User-Agent": "test-agent" } },
    });
    expect(await res.text()).toBe("composed");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal); // timeout wiring reached fetch
    expect((seen[0]?.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
  });

  it("keys the rate-limit bucket per PROVIDER, so two providers on ONE host don't serialize (task 009)", async () => {
    // The self-host bug this fixes: with all providers behind one domain, a
    // host-only bucket collapsed them into one chain (a slow MOTIS call blocked
    // a fast autocomplete). Bucket = `${provider}@${host}`, so distinct
    // providers on the SAME host run concurrently.
    const INTERVAL = 120;
    const starts: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", () => {
      starts.push(Date.now());
      return gate.then(() => new Response("ok"));
    });
    const shared = "one.domain.test";
    const both = Promise.all([
      providerFetch("http://one.domain.test/a", { provider: "transit", rateHost: shared, minIntervalMs: INTERVAL, timeoutMs: 5000 }),
      providerFetch("http://one.domain.test/b", { provider: "photon", rateHost: shared, minIntervalMs: INTERVAL, timeoutMs: 5000 }),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toHaveLength(2); // both started; a shared chain would show 1
    release();
    await both;
  });

  it("collapses case/trailing-dot host aliases into ONE bucket (no 2× race on one server)", async () => {
    // A hand-written pool could hold `overpass-api.de` and `overpass-api.de.`
    // (or a case variant): same server, so they MUST share one serialized bucket.
    const INTERVAL = 120;
    const starts: number[] = [];
    vi.stubGlobal("fetch", () => {
      starts.push(Date.now());
      return Promise.resolve(new Response("ok"));
    });
    await Promise.all([
      providerFetch("http://overpass-api.de/a", { provider: "overpass", rateHost: "overpass-api.de", minIntervalMs: INTERVAL, timeoutMs: 5000 }),
      providerFetch("http://overpass-api.de./b", { provider: "overpass", rateHost: "overpass-api.de.", minIntervalMs: INTERVAL, timeoutMs: 5000 }),
      providerFetch("http://OVERPASS-API.DE/c", { provider: "overpass", rateHost: "OVERPASS-API.DE", minIntervalMs: INTERVAL, timeoutMs: 5000 }),
    ]);
    expect(starts).toHaveLength(3);
    // one shared bucket ⇒ each spaced ≥ interval (a split would start them together)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(INTERVAL - 20);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(INTERVAL - 20);
  });

  it("still serializes two calls of the SAME provider+host with >= interval spacing", async () => {
    const INTERVAL = 120;
    const starts: number[] = [];
    vi.stubGlobal("fetch", () => {
      starts.push(Date.now());
      return Promise.resolve(new Response("ok"));
    });
    await Promise.all([
      providerFetch("http://h/a", { provider: "ors", rateHost: "h", minIntervalMs: INTERVAL, timeoutMs: 5000 }),
      providerFetch("http://h/b", { provider: "ors", rateHost: "h", minIntervalMs: INTERVAL, timeoutMs: 5000 }),
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(INTERVAL - 20);
  });
});

describe("isRetriableFetchError", () => {
  it("is TRUE for the project's network-failure shapes (undici TypeError) and abort/timeout", () => {
    expect(isRetriableFetchError(new TypeError("network down"))).toBe(true);
    expect(isRetriableFetchError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetriableFetchError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe(true);
    expect(isRetriableFetchError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(true);
  });

  it("is FALSE for a wrapped upstream STATUS (ProviderError) — deterministic, must not be retried", () => {
    expect(isRetriableFetchError(new ProviderError("transitous responded 503"))).toBe(false);
    expect(isRetriableFetchError(new ProviderError("responded 429"))).toBe(false);
  });

  it("is FALSE for a plain non-network Error and non-errors", () => {
    expect(isRetriableFetchError(new Error("some deterministic bug"))).toBe(false);
    expect(isRetriableFetchError({})).toBe(false);
    expect(isRetriableFetchError(null)).toBe(false);
  });
});

describe("retryOnceOnTransient", () => {
  it("retries ONCE on a transient failure then returns the success", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");
    await expect(retryOnceOnTransient(attempt, { backoffMs: 0 })).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a deterministic error (rethrows after ONE call)", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new ProviderError("responded 503"));
    await expect(retryOnceOnTransient(attempt, { backoffMs: 0 })).rejects.toThrow(/503/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when canRetry() is false (budget spent) — rethrows the transient", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(retryOnceOnTransient(attempt, { backoffMs: 0, canRetry: () => false })).rejects.toThrow(/fetch failed/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("caps at ONE retry — two transient failures reject after exactly 2 calls", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(retryOnceOnTransient(attempt, { backoffMs: 0 })).rejects.toThrow(/fetch failed/);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("ProviderError.retriable", () => {
  it("defaults to false and can be set true", () => {
    expect(new ProviderError("x").retriable).toBe(false);
    expect(new ProviderError("x", { retriable: true }).retriable).toBe(true);
  });
});
