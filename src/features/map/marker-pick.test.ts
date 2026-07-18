import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MARKER_PICK_PAD_PX, pickNearestWithin, type PickPoint } from "./marker-pick";

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
