import { afterEach, describe, expect, it, vi } from "vitest";

import { providerFetch, roundCoord, sha256Hex, timedFetch, withRateLimit } from "./provider-http";

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
      rateHost: "compose.test",
      minIntervalMs: 0,
      timeoutMs: 1000,
      init: { headers: { "User-Agent": "test-agent" } },
    });
    expect(await res.text()).toBe("composed");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal); // timeout wiring reached fetch
    expect((seen[0]?.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
  });
});
