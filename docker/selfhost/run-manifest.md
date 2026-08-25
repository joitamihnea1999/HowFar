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
across those vintages, so the map still renders; only the exact tile bytes may differ. This
non-bit-reproducibility is an **accepted tradeoff** (2026-08-25): the base data is
dated upstream, the schema is stable, and parity is verified against the rendered output — pinning
those sources (explicit `--*_path` inputs) is deliberately NOT built. It stays a future hardening
option if bit-exact tile rebuilds ever become a requirement.

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
| Nominatim import (`IMPORT_STYLE=full`) | ~24 min | ~4.2 GiB | PG DB 5.4 GB + flatnode **106 GB** (pruned by default post-import → ~8 GB) |
| Photon index (from Nominatim DB) | ~2.7 min | ~0.75 GiB | 468 MB (+94 MB jar) |
| ORS graph (foot-walking + driving-car) | ~6.6 min | ~1.82 GiB (XMX 2 g) | 799 MB |
| pmtiles (protomaps/basemaps, all-Romania z0–15) | ~5 min + one-time ~2.25 GB base-source download | XMX 6 g | 684 MB |
| Extract download | ~1 min | — | 312 MB |

**Peak footprint ≈ 114 GB during import, dominated by the Nominatim flatnode (106 GB); ~8 GB resident
after the default prune.** Measured with `du -sh` (actual blocks) — `du --apparent-size` reports the
same 106 GB, so the file is genuinely dense, not a sparse file whose `ls -l` size would overstate disk
use. The flatnode is sized by the planet node-ID space (not the extract) and is read only during import
and minutely/replication updates. `docker/selfhost/prune-flatnode.sh` deletes it **by default** after
the import (opt out with `KEEP_FLATNODE=1` for replication setups) → **~8 GB** resident. Verified
2026-08-25: after deleting `flatnode.file` and restarting the container, `/search` (Piața Unirii →
44.4280060, 26.1025098) and `/reverse` (44.4268, 26.1025) return **byte-identical** coords to the
with-flatnode answers, confirming a serve-only instance does not need it. Getting it back = re-import (~24 min).

## Parity result (public providers vs self-hosted stack, 2026-08-25)

- Origins: Unirii (central) / Grozăvești (river barrier) / Berceni (periphery). Ring pace `normal`;
  car `preset=crowded` (pins the traffic slot so both legs send identical ranges).
- Ring gate (per band, all enforced): median sector residual ≤10% AND worst sector ≤15% AND zero
  cross-coverage mismatch AND area ratio within ±21%. Residual = ray/polygon boundary distance at
  24 bearings (density-independent — not vertex binning). Cross-coverage mismatch = count of bearings
  reached by only ONE of the two rings; a wedge missing from just one leg (whose small area loss can
  sit inside ±21%) is caught here and by the worst-sector bound. Geocode + reverse ≤150 m (specific
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
  public-vs-public passthrough): the **primary proof is the mechanized preflight** (§ above) —
  distinct base URLs, all three engines proven live, and the local app's answer matched to each
  local engine's OWN direct answer — **plus** the keyless-ORS argument: the local app is configured
  `ORS_BASE_URL=localhost:8082` and sends no key to a non-public host (a public-ORS call would 403
  keyless), so its valid rings can only come from the local engine; the same base-URL wiring holds
  for Nominatim/Photon. Corroborating only (NOT proof on its own): the area ratios print as
  0.998–1.003 rather than exactly 1.000, consistent with two different engine instances — but this
  is weak evidence (a cache row from an older vintage of the *same* host would also be non-unity, and
  `toFixed(3)` rounds true-1.000 rows indistinguishably), so it is not relied on.
- Basemap: verified 2026-08-25 that the self-built `data/tiles/selfhost-romania.pmtiles` (684 MB,
  built host-owned via `build-tiles.sh` `--user`) has the reference's exact 9 source-layers and is
  Range-served by `/api/tiles` (HTTP 206, `PMTiles` magic) when the local app sets
  `TILES_PMTILES_PATH` at it → renders in the app's Protomaps style. The public default
  `data/tiles/bucharest.pmtiles` (25 MB) is untouched.

Extra pin: Photon jar `photon-1.3.0.jar` sha256 `a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5`.
