import { beforeEach, describe, expect, it, vi } from "vitest";

const { suggest } = vi.hoisted(() => ({ suggest: vi.fn() }));
vi.mock("@/lib/providers/photon", () => ({ suggest }));

import { ProviderError } from "@/lib/providers/http";

import { GET } from "./route";

const call = (q?: string) =>
  GET(new Request(`http://localhost/api/suggest${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`));

// Braces matter: mockReset() returns the mock, and a function returned from
// beforeEach runs as a TEARDOWN that would call the mock after every test.
beforeEach(() => {
  suggest.mockReset();
});

describe("GET /api/suggest", () => {
  it("returns empty (no upstream) for a query under 3 chars", async () => {
    const res = await call("Pi");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(suggest).not.toHaveBeenCalled();
  });

  it("returns empty (no upstream) when q is missing", async () => {
    expect(await (await call()).json()).toEqual({ suggestions: [] });
    expect(suggest).not.toHaveBeenCalled();
  });

  it("returns the suggestion list on success", async () => {
    suggest.mockResolvedValue([{ label: "Union Square, Bucharest", lat: 44.428, lng: 26.1025 }]);
    const res = await call("union");
    expect(res.status).toBe(200);
    expect((await res.json()).suggestions).toHaveLength(1);
  });

  it("502 + a logged cause when the provider fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    suggest.mockRejectedValue(new ProviderError("photon responded 503"));
    expect((await call("union")).status).toBe(502);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[api:suggest] ProviderError: photon responded 503");
    logged.mockRestore();
  });
});
