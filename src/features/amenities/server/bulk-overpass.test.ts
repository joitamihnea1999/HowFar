import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/provider-http";

import { buildBulkOverpassQuery, fetchBulkOverpass } from "./bulk-overpass";

afterEach(() => vi.unstubAllGlobals());

function bodyResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("bulk Overpass transport", () => {
  it("builds one bounded out-geom query from every category predicate", () => {
    const query = buildBulkOverpassQuery();
    expect(query).toContain("[timeout:120]");
    expect(query).toContain("[maxsize:268435456]");
    expect(query).toContain("[shop~\"^(supermarket|convenience|greengrocer)$\"]");
    expect(query).toContain("[amenity~\"^(pharmacy)$\"]");
    expect(query).toContain("[leisure~\"^(park|garden)$\"]");
    expect(query).toContain("[amenity~\"^(school|kindergarten|university)$\"]");
    expect(query).toContain("out geom;");
    expect(query).not.toContain("around:");
  });

  it("tries hosts sequentially and stops after the first complete result", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        if (calls.length === 1) return new Response("busy", { status: 503 });
        return bodyResponse({ elements: [{ type: "node", id: 1 }] });
      }),
    );

    const snapshot = await fetchBulkOverpass({ endpoints: ["https://one.test", "https://two.test"] });
    expect(snapshot.endpoint).toBe("https://two.test");
    expect(calls).toEqual(["https://one.test", "https://two.test"]);
  });

  it("rejects declared and streamed bodies above the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        bodyResponse(
          { elements: [{ type: "node", id: 1 }] },
          { headers: { "content-length": "1000" } },
        ),
      ),
    );
    await expect(
      fetchBulkOverpass({ endpoints: ["https://one.test"], maxBytes: 20 }),
    ).rejects.toBeInstanceOf(ProviderError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bodyResponse({ elements: [{ type: "node", id: 1, name: "long" }] })),
    );
    await expect(
      fetchBulkOverpass({ endpoints: ["https://one.test"], maxBytes: 20 }),
    ).rejects.toThrow(/exceeds 20 bytes/);
  });

  it("defaults to today's public bulk pool when no endpoints are passed (task 007)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return bodyResponse({ elements: [{ type: "node", id: 1 }] });
      }),
    );
    const snapshot = await fetchBulkOverpass(); // no endpoints → config default
    expect(snapshot.endpoint).toBe("https://overpass-api.de/api/interpreter");
    expect(calls[0]).toBe("https://overpass-api.de/api/interpreter");
  });

  it("uses an OVERPASS_BULK_ENDPOINTS override when set (task 007)", async () => {
    vi.stubEnv("OVERPASS_BULK_ENDPOINTS", "https://bulk.internal/api/interpreter");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return bodyResponse({ elements: [{ type: "node", id: 1 }] });
      }),
    );
    try {
      const snapshot = await fetchBulkOverpass();
      expect(snapshot.endpoint).toBe("https://bulk.internal/api/interpreter");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects timeout/error remarks even when HTTP status is 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bodyResponse({ remark: "runtime error: Query timed out", elements: [{}] })),
    );
    await expect(fetchBulkOverpass({ endpoints: ["https://one.test"] })).rejects.toThrow(
      /remark.*timed out/i,
    );
  });
});
