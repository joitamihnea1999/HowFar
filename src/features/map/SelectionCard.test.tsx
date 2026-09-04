import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import SelectionCard from "@/features/map/SelectionCard";

// Static server render — pure presentation of the selection state.
describe("SelectionCard (phone-first — preset legend + honest reach copy)", () => {
  it("shows the selected preset minute in the legend + the honest reach explainer", () => {
    const html = renderToStaticMarkup(
      <SelectionCard label="Str. Lipscani 5" message={null} mode="walk" selectedMin={20} loading={false} />,
    );
    expect(html).toContain("Str. Lipscani 5");
    expect(html).toContain("Walking");
    expect(html).toContain("≤ 20 min");
    expect(html).toContain("20-minute walk"); // the explainer names the served minute
  });

  it("carries the barrier caveat for walk + transit (owner honesty requirement), NOT for car", () => {
    const walk = renderToStaticMarkup(
      <SelectionCard label="X" message={null} mode="walk" selectedMin={10} loading={false} />,
    );
    expect(walk).toContain("reach-caveat");
    expect(walk.toLowerCase()).toContain("shorter than shown");

    const transit = renderToStaticMarkup(
      <SelectionCard label="X" message={null} mode="transit" selectedMin={40} loading={false} />,
    );
    expect(transit).toContain("reach-caveat");

    const car = renderToStaticMarkup(
      <SelectionCard label="X" message={null} mode="car" selectedMin={25} loading={false} car={{ basis: "estimate", slotId: "s", slotLabel: "typical" }} />,
    );
    expect(car).not.toContain("reach-caveat"); // car has 0% over-claim, no barrier caveat
  });

  it("renders the failure message as an alert, no legend", () => {
    const html = renderToStaticMarkup(
      <SelectionCard label={null} message="That spot is outside Bucharest." mode="walk" selectedMin={10} loading={false} />,
    );
    expect(html).toContain("That spot is outside Bucharest.");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("ring-explainer");
  });

  it("renders nothing when there is no label, message, or loading state", () => {
    const html = renderToStaticMarkup(
      <SelectionCard label={null} message={null} mode="walk" selectedMin={10} loading={false} />,
    );
    expect(html).toBe("");
  });
});
