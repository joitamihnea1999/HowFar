/**
 * Two-phase map teardown (task 045, plan panel opus#3): run every controller
 * disposer first — in the given order, which the caller passes as REVERSE create
 * order — then remove the map LAST. This ordering is load-bearing: a disposer
 * that touches the map (e.g. `popup.dispose → route.clearRoutePath → map.getSource`)
 * must run while the map still exists, so `map.remove()` can only happen once
 * every disposer has. Extracted from the effect cleanup so the ordering is
 * unit-testable rather than only visible.
 */
export function teardownInOrder(disposers: ReadonlyArray<() => void>, removeMap: () => void): void {
  for (const dispose of disposers) dispose();
  removeMap();
}
