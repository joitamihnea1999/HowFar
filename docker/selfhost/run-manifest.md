# Self-host run manifest

Records exactly WHAT produced a given self-host build, so a rebuild is reproducible
and a parity result can be tied to the artefacts it was measured on. Update the
"resolved" and "measured" fields from a real run.

**Reproducibility scope (honest):** the extract (md5), engine images (digest), Photon jar
(sha256), and the tile generator (commit SHA) are all pinned, so the geocoder/routing
engines rebuild deterministically. The **basemap tile archive is NOT bit-reproducible**: the
protomaps/basemaps build downloads ~2.25 GB of upstream base datasets (Natural Earth, OSM
water/land polygons, Daylight landcover) via `--download` with no version pin, so a rebuild on
a fresh box gets whatever vintage is current upstream. The schema (source-layer set) is stable
across those vintages, so the map still renders; only the exact tile bytes may differ. Pinning
those sources (explicit `--*_path` inputs) is a future hardening.

## Data source (the ONE extract)

- Region: Romania (Geofabrik `europe/romania`)
- Pinned snapshot: **`romania-260824.osm.pbf`** (date 2026-08-24)
- Size: 326,778,421 B (~312 MB)
- md5: `abc00e5b575aa51efc9ab39ea34655f4` (verified against Geofabrik's published `.md5`)
- Matching cache token: `PROVIDER_DATA_REVISION=romania-260824`

## Engine image / binary pins

| Component | Pin | Resolved digest |
|---|---|---|
| Nominatim | `mediagis/nominatim:5.3` (Nominatim 5.3.2, osm2pgsql 1.11.0, PG 16, PostGIS 3.4) | `sha256:7923a8e67197fc6d4f4ecb7c0e8bbedffeddcfdf4519596fe946e46a28f5a9f8` |
| Photon | `komoot/photon` jar **1.3.0** (`photon-1.3.0.jar`, 94 MB) on `eclipse-temurin:21-jre` | jre `sha256:7a65df4b22d2de92d4e04056e884f3b9122d70b21e2847fd66084278bd0ce037` |
| ORS | `openrouteservice/openrouteservice:v9.10.0` | `sha256:cd7d8f3cc1b753b12d706577aca92f7bc952aa9ef9a685394ad86cef9f829473` |
| pmtiles generator | `protomaps/basemaps` @ commit **`a50c699adc60a45c899971b1e11275e61f13bfbf`** built via `maven:3.9-eclipse-temurin-21` (`sha256:8f6ac126f7810bb5549c4cd122d2bf0e9cda5bdeb0838aa928f09e779fd8bef8`) | — |

## Engine config (parity-relevant knobs)

- Nominatim: `IMPORT_STYLE=full` (faithful to the public instance).
- ORS: profiles `foot-walking` + `driving-car`; `ors.endpoints.isochrones.maximum_intervals=10`
  (default 1 would reject the app's 3-range payload), `maximum_range_time_default=18000`.
- Extent: `NEXT_PUBLIC_MAP_BBOX=25.8,44.2,26.4,44.7` (Bucharest + Ilfov).

## Measured resources (2026-08-25, full Romania extract, 16-core box; imports run one at a time)

| Engine | Wall-time | Peak RAM | On-disk |
|---|---|---|---|
| Nominatim import (`IMPORT_STYLE=full`) | ~24 min | ~4.2 GiB | PG DB 5.4 GB + flatnode **106 GB** |
| Photon index (from Nominatim DB) | ~2.7 min | ~0.75 GiB | 468 MB (+94 MB jar) |
| ORS graph (foot-walking + driving-car) | ~6.6 min | ~1.82 GiB (XMX 2 g) | 799 MB |
| pmtiles (protomaps/basemaps, all-Romania z0–15) | ~5 min + one-time ~2.25 GB base-source download | XMX 6 g | 684 MB |
| Extract download | ~1 min | — | 312 MB |

**Total footprint ≈ 114 GB, dominated by the Nominatim flatnode (106 GB).** Measured with `du -sh`
(actual blocks) — `du --apparent-size` reports the same 106 GB, so the file is genuinely dense, not a
sparse file whose `ls -l` size would overstate disk use. The flatnode is sized by the planet node-ID
space (not the extract), is only needed during import/replication, and can be deleted afterwards (no
minutely updates here) → **~8 GB** resident without it.

## Parity result (public providers vs self-hosted stack, 2026-08-25)

- Origins: Unirii (central) / Grozăvești (river barrier) / Berceni (periphery). Ring pace `normal`;
  car `preset=crowded` (pins the traffic slot so both legs send identical ranges).
- Ring gate (per band, all enforced): median sector residual ≤10% AND worst sector ≤15% AND area
  ratio within ±21%. Residual = ray/polygon boundary distance at 24 bearings (density-independent —
  not vertex binning; a ray from the interior origin always hits the boundary, so the worst-sector
  bound, not a coverage count, is the truncation guard). Geocode + reverse ≤150 m (specific
  landmarks); suggest top hit ≤500 m.
- A PROVENANCE preflight runs first and ABORTS unless all three engines are proven live AND the
  local app's answers match each local engine's OWN direct answer (Nominatim geocode ≤150 m, ORS
  15-min ring area ±2%, Photon suggest ≤500 m) — so a mis-started public-vs-public run or a cached
  run against a stopped engine cannot report parity. Validated both ways (identical legs → abort).
  Honest limit: because the self-hosted stack is a FAITHFUL replica of the public providers (that
  is exactly what the parity result proves), an output-level check cannot fully distinguish "app
  routed to local" from "app routed to a public host that returns the same answer". The preflight
  catches the realistic failures (an engine down, a grossly misrouted app, identical legs); a
  fully airtight proof needs request-level instrumentation (a per-engine proxy/counter), parked.
- **All 27 checks PASS** (`parity-check.mjs --public … --local …` exits 0):
  - **18/18 rings** — walk + car: median 0.0%, **worst sector ≤3.1%**, area 0.998–1.003.
  - **Geocode all ≤150 m** — Unirii (Piața Unirii) 0.0 m, Grozăvești (AFI Cotroceni) 0.0 m,
    Berceni (Piața Sudului) 109.7 m.
  - **Reverse all ≤150 m** (map-click label path) — 0.0 / 0.0 / 30.5 m.
  - **Suggest top hit ≤110 m** — Unirii 108 m, Grozăvești 0 m, Berceni 110 m.
- Note on area-name queries: a bare neighborhood name (e.g. just "Grozăvești") resolves to a
  different-but-valid representative point (~400 m) across geocoders; that is inherent geocoder
  ranking variance, not a self-host defect, so the parity set uses specific landmarks.
- Provenance (that the local leg really hit the self-hosted engines, not a misconfigured
  public-vs-public passthrough): the **area ratios are 0.998–1.003, NOT exactly 1.000** — a
  same-backend comparison (cache hit, or both legs on the public host) would return byte-identical
  geometry (ratio exactly 1.000). The sub-percent, non-unity differences are the operative proof the
  two legs ran on DIFFERENT engine instances. Corroborating: the local app was configured with
  `ORS_BASE_URL=localhost:8082` and sends no key to a non-public host (a public-ORS call would 403
  keyless), so its valid rings could only come from the local engine; same for Nominatim/Photon.
- Basemap: verified 2026-08-25 that the self-built `data/tiles/selfhost-romania.pmtiles` (684 MB,
  built host-owned via `build-tiles.sh` `--user`) has the reference's exact 9 source-layers and is
  Range-served by `/api/tiles` (HTTP 206, `PMTiles` magic) when the local app sets
  `TILES_PMTILES_PATH` at it → renders in the app's Protomaps style. The public default
  `data/tiles/bucharest.pmtiles` (25 MB) is untouched.

Extra pin: Photon jar `photon-1.3.0.jar` sha256 `a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5`.
