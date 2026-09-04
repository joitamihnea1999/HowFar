import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ModePresetBar from "@/features/map/ModePresetBar";

describe("ModePresetBar (phone-first — one compact bar: mode icons + presets)", () => {
  it("renders all three mode icons and the active mode's two presets, marking the active mode", () => {
    const html = renderToStaticMarkup(
      <ModePresetBar mode="walk" presetIndex={0} onSwitchMode={() => {}} onSelectPreset={() => {}} />,
    );
    for (const m of ["walk", "transit", "car"]) expect(html).toContain(`data-testid="mode-icon-${m}"`);
    // Active = walk; its two presets show.
    expect(html).toMatch(/data-testid="mode-icon-walk"[^>]*data-mode-active="true"/);
    expect(html).toContain("10 min");
    expect(html).toContain("20 min");
  });

  it("switches the chip labels with the active mode (labels off the served minutes)", () => {
    const transit = renderToStaticMarkup(
      <ModePresetBar mode="transit" presetIndex={0} onSwitchMode={() => {}} onSelectPreset={() => {}} />,
    );
    expect(transit).toContain("20 min");
    expect(transit).toContain("40 min");
  });

  it("flags a failed mode on its icon (never a takeover, degraded state)", () => {
    const html = renderToStaticMarkup(
      <ModePresetBar mode="transit" presetIndex={0} onSwitchMode={() => {}} onSelectPreset={() => {}} failedMode="transit" />,
    );
    expect(html.toLowerCase()).toContain("unavailable");
  });
});
