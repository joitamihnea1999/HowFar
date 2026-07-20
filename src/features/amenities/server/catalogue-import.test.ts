import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CategoryCounts } from "./catalogue-import";
import { CatalogueImportError, validateCategoryDeltas } from "./catalogue-import";

const previous: CategoryCounts = {
  groceries: 100,
  pharmacies: 100,
  parks: 100,
  schools: 100,
  transit: 100,
};

describe("catalogue count validation", () => {
  it("rejects empty categories and suspicious weekly deltas", () => {
    expect(() => validateCategoryDeltas(null, { ...previous, parks: 0 })).toThrow(/parks is empty/);
    expect(() => validateCategoryDeltas(previous, { ...previous, parks: 49 })).toThrow(/dropped/);
    expect(() => validateCategoryDeltas(previous, { ...previous, parks: 301 })).toThrow(/grew/);
  });

  it("accepts every non-empty count within the documented delta envelope (property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          groceries: fc.integer({ min: 50, max: 300 }),
          pharmacies: fc.integer({ min: 50, max: 300 }),
          parks: fc.integer({ min: 50, max: 300 }),
          schools: fc.integer({ min: 50, max: 300 }),
          transit: fc.integer({ min: 50, max: 300 }),
        }),
        (current) => {
          expect(() => validateCategoryDeltas(previous, current)).not.toThrow();
        },
      ),
    );
  });

  it("uses a typed operational error for validation failures", () => {
    expect(() => validateCategoryDeltas(previous, { ...previous, schools: 0 })).toThrow(
      CatalogueImportError,
    );
  });
});
