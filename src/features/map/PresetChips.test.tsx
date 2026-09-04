import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PresetChips from "@/features/map/PresetChips";

// Static server render — pure presentation, so the markup IS the contract.
describe("PresetChips (phone-first — the two calibrated presets, Custom hidden)", () => {
  it("labels the chips off the served minutes per mode, exactly TWO, no Custom", () => {
    for (const [mode, mins] of [
      ["walk", [10, 20]],
      ["transit", [20, 40]],
      ["car", [10, 25]],
    ] as const) {
      const html = renderToStaticMarkup(<PresetChips mode={mode} value={0} onSelect={() => {}} />);
      for (const m of mins) expect(html).toContain(`${m} min`);
      // No Custom chip, no free-minute input — Custom is owner-deferred.
      expect(html.toLowerCase()).not.toContain("custom");
      expect(html).not.toContain("<input");
      // Exactly two chips.
      expect(html.match(/data-preset-min=/g)).toHaveLength(2);
    }
  });

  it("marks the selected index pressed", () => {
    const html = renderToStaticMarkup(<PresetChips mode="walk" value={1} onSelect={() => {}} />);
    // The 20-min chip (index 1) is pressed; the 10-min chip is not.
    expect(html).toMatch(/data-preset-min="20"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-preset-min="20"/);
  });
});
