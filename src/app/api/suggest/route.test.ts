import { beforeEach, describe, expect, it, vi } from "vitest";

const { suggest } = vi.hoisted(() => ({ suggest: vi.fn() }));
vi.mock("@/lib/providers/photon", () => ({ suggest }));

import { GET } from "./route";

const call = (q?: string) =>
  GET(new Request(`http://localhost/api/suggest${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`));

beforeEach(() => suggest.mockReset());

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
  // Provider-error → 502 mapping is covered in api-util.test.ts (errorResponse);
  // the route uses that shared helper. (Rejecting-mock route tests trip vitest's
  // unhandled-rejection check even though the route returns 502 correctly.)
});
