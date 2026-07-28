import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MARKER_PICK_PAD_PX,
  markerPickPad,
  pickAllWithin,
  pickNearestWithin,
  type PickPoint,
} from "./marker-pick";
import { pinFootprintRadius } from "@/features/amenities/amenity-cluster";

const at = (x: number, y: number) => ({ x, y });

describe("pickNearestWithin", () => {
  it("returns null for an empty candidate list", () => {
    expect(pickNearestWithin([], at(10, 10), MARKER_PICK_PAD_PX)).toBeNull();
  });

  it("returns null when every candidate is outside the pad box", () => {
    const candidates = [at(0, 0), at(100, 100)];
    expect(pickNearestWithin(candidates, at(50, 50), 12)).toBeNull();
  });

  it("picks the candidate within pad, even off-center (the 12px forgiving target)", () => {
    const marker = at(50, 50);
    // 9px east of the marker center — inside the pad, would have missed a 5px circle.
    expect(pickNearestWithin([marker], at(59, 50), 12)).toBe(marker);
    // 13px east — outside the pad box.
    expect(pickNearestWithin([marker], at(63, 50), 12)).toBeNull();
  });

  it("picks the NEAREST when several candidates share the box", () => {
    const near = at(52, 50);
    const far = at(58, 50);
    expect(pickNearestWithin([far, near], at(50, 50), 12)).toBe(near);
  });

  it("box uses Chebyshev bounds but ordering is euclidean", () => {
    // Corner candidate is within the box (|dx|,|dy| ≤ 12) but euclidean-farther
    // than the axis candidate — the axis one must win.
    const corner = at(60, 60); // d² = 200
    const axis = at(62, 50); // |dx| = 12 → in box, d² = 144
    expect(pickNearestWithin([corner, axis], at(50, 50), 12)).toBe(axis);
  });

  it("keeps the earliest candidate on an exact distance tie", () => {
    const a = at(45, 50);
    const b = at(55, 50);
    expect(pickNearestWithin([a, b], at(50, 50), 12)).toBe(a);
    expect(pickNearestWithin([b, a], at(50, 50), 12)).toBe(b);
  });

  it("property: null iff no candidate in box; otherwise the true nearest in-box candidate", () => {
    const point = fc.record({ x: fc.integer({ min: -500, max: 500 }), y: fc.integer({ min: -500, max: 500 }) });
    fc.assert(
      fc.property(
        fc.array(point, { maxLength: 40 }),
        point,
        fc.integer({ min: 1, max: 50 }),
        (candidates, click, pad) => {
          const inBox = (c: PickPoint) =>
            Math.abs(c.x - click.x) <= pad && Math.abs(c.y - click.y) <= pad;
          const d2 = (c: PickPoint) => (c.x - click.x) ** 2 + (c.y - click.y) ** 2;

          const picked = pickNearestWithin(candidates, click, pad);
          const eligible = candidates.filter(inBox);
          if (eligible.length === 0) {
            expect(picked).toBeNull();
          } else {
            expect(picked).not.toBeNull();
            expect(inBox(picked!)).toBe(true);
            const best = Math.min(...eligible.map(d2));
            expect(d2(picked!)).toBe(best);
            // Earliest-wins among equal-distance candidates.
            expect(picked).toBe(candidates.find((c) => inBox(c) && d2(c) === best));
          }
        },
      ),
    );
  });
});

describe("pickAllWithin", () => {
  const mark = (x: number, y: number, id = `${x},${y}`) => ({ x, y, id });

  it("returns every candidate in the pad, nearest first", () => {
    const hits = pickAllWithin([mark(0, 0), mark(3, 0), mark(1, 0)], { x: 0, y: 0 }, 12);
    expect(hits.map((h) => h.id)).toEqual(["0,0", "1,0", "3,0"]);
  });

  it("excludes candidates outside the pad box, matching pickNearestWithin's rule", () => {
    const cands = [mark(0, 0), mark(13, 0), mark(0, 13), mark(12, 12)];
    const hits = pickAllWithin(cands, { x: 0, y: 0 }, 12);
    expect(hits.map((h) => h.id)).toEqual(["0,0", "12,12"]);
  });

  it("agrees with pickNearestWithin on the first element and on emptiness", () => {
    // The two must never disagree about what a click resolves to, or the hover
    // affordance would stop predicting the click.
    const cands = [mark(5, 5), mark(2, 1), mark(9, 9)];
    for (const point of [{ x: 0, y: 0 }, { x: 6, y: 6 }, { x: 100, y: 100 }]) {
      const all = pickAllWithin(cands, point, 12);
      const nearest = pickNearestWithin(cands, point, 12);
      expect(all[0] ?? null).toEqual(nearest);
    }
  });

  it("deduplicates tile-boundary repeats via the key function", () => {
    // MapLibre returns a feature once per tile it appears in; without the key the
    // same marker would be offered twice in the picker list.
    const dupes = [mark(1, 1, "a"), mark(1, 1, "a"), mark(2, 2, "b")];
    expect(pickAllWithin(dupes, { x: 0, y: 0 }, 12, (c) => c.id).map((h) => h.id)).toEqual(["a", "b"]);
    expect(pickAllWithin(dupes, { x: 0, y: 0 }, 12).map((h) => h.id)).toEqual(["a", "a", "b"]);
  });

  it("is stable for equal distances so repeated clicks give the same order", () => {
    const tied = [mark(3, 0, "first"), mark(0, 3, "second"), mark(-3, 0, "third")];
    expect(pickAllWithin(tied, { x: 0, y: 0 }, 12).map((h) => h.id)).toEqual(["first", "second", "third"]);
  });

  it("returns an empty array rather than null when nothing is in range", () => {
    expect(pickAllWithin([mark(50, 50)], { x: 0, y: 0 }, 12)).toEqual([]);
    expect(pickAllWithin([], { x: 0, y: 0 }, 12)).toEqual([]);
  });
});

describe("markerPickPad", () => {
  // Task 061 made pins zoom-scaled while the pad stayed a fixed 12px, so at high zoom
  // the visible outer ring of a pin could be clicked and ignored (found in review).
  it("never shrinks below the historical floor, so low zooms keep their generous target", () => {
    for (const zoom of [11, 12, 13]) {
      expect(markerPickPad(pinFootprintRadius(zoom, true))).toBe(MARKER_PICK_PAD_PX);
    }
  });

  it("covers the whole rendered mark once a pin outgrows that floor", () => {
    for (const zoom of [17, 19, 22]) {
      const footprint = pinFootprintRadius(zoom, true);
      expect(footprint).toBeGreaterThan(MARKER_PICK_PAD_PX);
      expect(markerPickPad(footprint)).toBe(footprint);
    }
  });

  it("makes a click on a high-zoom pin's outer ring land, which is the actual bug", () => {
    const pad = markerPickPad(pinFootprintRadius(22, true));
    const marker = { x: 100, y: 100 };
    // 15px out: inside the drawn mark at z22, outside the old fixed pad.
    const onOuterRing = { x: 115, y: 100 };
    expect(pickNearestWithin([marker], onOuterRing, MARKER_PICK_PAD_PX)).toBeNull();
    expect(pickNearestWithin([marker], onOuterRing, pad)).toEqual(marker);
  });
});
