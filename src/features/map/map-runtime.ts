// Lazy holder for the MapLibre runtime (task 017 — keep the 327 KB gz engine off the
// first-load critical path). AppMap dynamically `import("maplibre-gl")`s the engine on idle,
// AFTER the shell is interactive, then calls `setMapGl` with the loaded module; the map
// controllers reach the runtime constructors (`Marker`, `Popup`, …) through `mapGl()`.
//
// The load-bearing property: NOTHING here — and nothing that imports only this + `import type
// maplibre-gl` — statically imports the maplibre-gl VALUE. So the whole map-controller subtree
// stays maplibre-free in the initial bundle, and the engine lands in a lazy chunk reached only
// by AppMap's runtime `import()`. The `import(...)` in the type below is a TYPE query only
// (erased at build time — it creates no runtime import edge).

/** The maplibre-gl module namespace — the runtime constructors (`Map`, `Marker`, `Popup`,
 * `NavigationControl`, `addProtocol`, …) are its named exports. */
export type MapGl = typeof import("maplibre-gl");

let gl: MapGl | null = null;

/** Called once by AppMap right after `await import("maplibre-gl")`, before any controller runs. */
export function setMapGl(loaded: MapGl): void {
  gl = loaded;
}

/**
 * The loaded MapLibre runtime. Throws if called before `setMapGl` — which cannot happen in the
 * real flow (controllers are constructed inside AppMap's init effect, strictly after the engine
 * import resolves and `setMapGl` runs), so the throw is a loud invariant guard, not a code path.
 */
export function mapGl(): MapGl {
  if (!gl) {
    throw new Error("MapLibre runtime not loaded — setMapGl(...) must run before map controllers");
  }
  return gl;
}

/** Test-only reset so a suite that installs a fake runtime does not leak into the next. */
export function __resetMapGlForTest(): void {
  gl = null;
}
