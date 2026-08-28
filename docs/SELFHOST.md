# Self-hosting the provider stack (LOCAL)

HowFar's provider hosts are all config-driven (`src/lib/env.ts`), so pointing the
app at self-hosted OSM engines instead of the public APIs is an `.env` change. This
doc is the runbook for standing those engines up locally from **one** Geofabrik
Romania extract, and for parity-checking them against the public providers.

> **Scope.** In: Nominatim (`/search`+`/reverse`), Photon (`/api`), OpenRouteService
> (walk + car isochrones), and the Protomaps basemap `.pmtiles`. **Out: transit.**
> Transit (`/api/transit`, `/api/reach`) still uses its current provider — self-hosting
> it (MOTIS) is blocked on a per-city GTFS commercial-licence check and is a later phase.
>
> **This is a local/dev stack.** It is not a production deployment (no TLS, no auth,
> ports bound to `127.0.0.1`). Production provisioning is a separate phase.

Everything **downloaded** lives under gitignored `data/` (`data/osm/` extract,
`data/selfhost/photon/` jar+index, `data/selfhost/planetiler/` generator checkout,
`data/tiles/*.pmtiles`). The **imported engine databases** (Nominatim Postgres, ORS
graph) live in **Docker named volumes** — deliberately, not bind-mounted under `data/`,
because a bind-mounted Postgres `PGDATA` fails `initdb` on a non-empty mount. They are
removed with `docker compose … down -v` (see Teardown). The compose file, scripts and
this doc are the only committed artefacts.

## Prerequisites

- Docker + Docker Compose v2.
- Disk: budget **~120 GB** during import (the Nominatim flatnode alone is ~106 GB). The
  runbook **deletes the flatnode by default** after the import (§2), dropping to **~8 GB**
  resident — see the table below. Downloads: extract ~312 MB,
  Photon jar ~98 MB, and a one-time **~2.25 GB** of Protomaps base sources for the tiles
  (Natural Earth + OSM water/land polygons + Daylight landcover; cached after first build).
- RAM: the imports are the heavy part. Every service has an explicit `mem_limit`
  and heap cap tuned for a modest box — **run the imports one at a time** (below),
  not all at once, or you will drive a small machine into swap. The pmtiles build needs
  ~6 GB heap (planetiler parses the whole extract's nodes); run it with the serving engines
  stopped.

All commands are run from the `HowFar/` app root.

## Measured resources

> Measured 2026-08-25 on a 16-core box (imports run one at a time), full Romania extract
> `romania-260824.osm.pbf`. Your numbers will vary with hardware. See also
> `docker/selfhost/run-manifest.md` for the exact image digests + parity result.

| Engine | Import/build wall-time | Peak RAM | On-disk |
|---|---|---|---|
| Nominatim (`IMPORT_STYLE=full`) | ~24 min | ~4.2 GiB | PG DB 5.4 GB + flatnode **106 GB** (deleted by default post-import → ~8 GB) |
| Photon (index from Nominatim DB) | ~2.7 min | ~0.75 GiB | 468 MB (+94 MB jar) |
| ORS (foot-walking + driving-car) | ~6.6 min | ~1.82 GiB (XMX 2 g) | graph 799 MB + **752 MB SRTM elevation cache** |
| pmtiles (protomaps/basemaps) | ~5 min + one-time ~2.25 GB base-source download | XMX 6 g | 684 MB (all-Romania z0–15) |
| **Extract download** | ~1 min | — | 312 MB |

**Peak ≈ 114 GB during import, almost all the Nominatim flatnode (106 GB); ~8 GB resident once
the flatnode is pruned (default).** The flatnode is sized by the planet node-ID space, not the
extract, and is read only during import and minutely/replication updates — a serve-only instance
(plain `/search` + `/reverse`, all this app does) never touches it. §2 deletes it by default; the
geocoder keeps answering byte-identically (verified: `/search` + `/reverse` return the same coords
after the flatnode is removed and the container restarted). Keep it only if you plan to run OSM
replication (`KEEP_FLATNODE=1`, §2). **Tradeoff if you delete and later need it back:** no
in-place rebuild — you re-import Nominatim (~24 min). The "~8 GB resident" counts the serving
engine data + the pmtiles archive (Nominatim DB 5.4 GB + Photon 468 MB + jar 94 MB + ORS 799 MB +
tiles 684 MB ≈ 7.5 GB) plus a **752 MB SRTM elevation cache** (`ors-elevation` volume). ORS fetches
SRTM elevation for its graph build (as the public ORS does — so it is faithful for parity, not a
divergence), but SRTM is an **external, unpinned** input downloaded on demand, like the tile base
sources: the routing graph is only as reproducible as whatever SRTM vintage is current upstream. To
drop it (at the cost of elevation-aware routing that public ORS has), disable ORS elevation and
re-validate parity. The **~2.25 GB of Protomaps base sources** the tile build downloads
(`data/selfhost/planetiler/`) is a **separate build cache**, not serving data — keep it only to
rebuild tiles faster, else `rm -rf data/selfhost/planetiler` reclaims it.

**Parity (public vs self-hosted, 2026-08-25):** all 27 checks pass (after a provenance preflight that
checks all three engines are live and the local app's answers match each local engine's own — see
the run-manifest for the honest limit) — 18/18 rings (walk + car) with median boundary
residual 0.0%, worst sector ≤3.1%, area 0.998–1.003 across Unirii/Grozăvești/Berceni × 3 bands;
geocode ≤150 m and reverse ≤150 m at all three specific-landmark origins; Photon suggest top hit
≤110 m. (A bare neighborhood-name geocode query varies ~400 m across geocoders — inherent ranking
variance, so the set uses specific landmarks.) Run it yourself with `docker/selfhost/parity-check.mjs` (§7).

## 1 — Fetch the extract (and the Photon jar)

```bash
docker/selfhost/fetch-romania-extract.sh          # → data/osm/romania-260824.osm.pbf (md5-verified)
docker/selfhost/fetch-photon-jar.sh               # → data/selfhost/photon/photon.jar (pinned 1.3.0)
```

`--dry-run` on the extract fetcher prints the size and downloads nothing.

> **Run this BEFORE any `docker compose … up`.** The compose file bind-mounts
> `data/osm/romania-260824.osm.pbf`; if you `up` before the file exists, Docker
> silently creates that path as a **directory**, and the fetcher would then keep
> re-downloading (its `[ -f ]` check fails on a directory). If you hit that, remove the
> stray directory and re-fetch. Fetch first and this can't happen.

## 2 — Nominatim (import runs on first `up`)

```bash
docker compose -f docker/selfhost/docker-compose.yml up -d nominatim
# Watch the import; it can take a long time. Healthy = /status returns 0.
docker compose -f docker/selfhost/docker-compose.yml logs -f nominatim
```

Smoke test once healthy:

```bash
curl -s 'http://localhost:8081/search?format=jsonv2&countrycodes=ro&q=Piata+Unirii+Bucuresti&limit=1' | head
curl -s 'http://localhost:8081/reverse?format=jsonv2&lat=44.4268&lon=26.1025' | head
```

Once those return (import succeeded), reclaim the ~106 GB flatnode — **the default**, since a
serve-only instance never reads it:

```bash
docker/selfhost/prune-flatnode.sh                 # delete flatnode.file → ~8 GB resident
# KEEP_FLATNODE=1 docker/selfhost/prune-flatnode.sh   # keep it (only if you run OSM replication)
```

`prune-flatnode.sh` refuses unless the Nominatim container reports `healthy`, so it cannot delete the
flatnode out from under a running import: the `mediagis/nominatim` image runs the import to completion
and only THEN starts the webserver, so `/status` (which drives the healthcheck) does not answer `0`
until the import — including the flatnode write — has finished. A fresh import takes ~24 min to reach
healthy; a serve restart, ~15 s. The geocoder keeps answering `/search` + `/reverse` byte-identically
without the flatnode (verified by re-querying after removal + a container restart). If you later need
the flatnode back (to enable minutely updates), there is no in-place rebuild — re-import (~24 min).

## 3 — Photon (index built FROM the Nominatim DB)

Photon derives from the same extract by importing the Nominatim database, then serves
its own index (no DB needed at serve time). Run the import once Nominatim is healthy:

```bash
docker compose -f docker/selfhost/docker-compose.yml --profile import run --rm photon-import
docker compose -f docker/selfhost/docker-compose.yml up -d photon
curl -s 'http://localhost:2322/api?q=unirii&bbox=25.8,44.2,26.4,44.7&limit=3' | head
```

## 4 — OpenRouteService (graph build runs on first `up`)

```bash
docker compose -f docker/selfhost/docker-compose.yml up -d ors
docker compose -f docker/selfhost/docker-compose.yml logs -f ors      # healthy = /ors/v2/health
```

Smoke test with the app's EXACT isochrone payload (3 intervals — the config raises
`maximum_intervals` so this does not 502):

```bash
curl -s -X POST 'http://localhost:8082/ors/v2/isochrones/foot-walking' \
  -H 'Content-Type: application/json' \
  -d '{"locations":[[26.1025,44.4268]],"range":[861,1744,2633]}' | head -c 300; echo
curl -s -X POST 'http://localhost:8082/ors/v2/isochrones/driving-car' \
  -H 'Content-Type: application/json' \
  -d '{"locations":[[26.1025,44.4268]],"range":[300,600,900]}' | head -c 300; echo
```

## 5 — Basemap tiles (Protomaps schema)

The tile build needs ~6 GB heap — **stop the serving engines first** on a small box so it
doesn't contend for RAM (their data persists; restart them after):

```bash
docker compose -f docker/selfhost/docker-compose.yml stop nominatim photon ors
docker/selfhost/build-tiles.sh          # → data/tiles/selfhost-romania.pmtiles (atomic)
docker compose -f docker/selfhost/docker-compose.yml start nominatim ors && \
  docker compose -f docker/selfhost/docker-compose.yml up -d photon
```

This builds the **protomaps/basemaps** Planetiler profile from source (in a
maven+temurin container) so the emitted `source-layer` names match the app's
`@protomaps/basemaps` style. A stock planetiler/OpenMapTiles run would render blank.
It writes to a **distinct** path (`data/tiles/selfhost-romania.pmtiles`, set in the
env overlay) so it never clobbers the public default `data/tiles/bucharest.pmtiles`.
Note the Basemaps jar ignores `--bbox`, so the archive covers the **whole extract
(all Romania)** — larger than the single-city cut, but Range-served and gated by the
app's `maxBounds`.

## 6 — Point the app at the stack

Merge `docker/selfhost/env.selfhost.example` into `.env` (keep your existing
`DATABASE_URL` / `AUTH_SECRET`), then run the app as usual. With none of those vars
set the app is byte-identical to the default public-provider configuration (what the retired public preview ran).

> **Tile cache after repointing `TILES_PMTILES_PATH`.** `/api/tiles` serves every archive
> from the same URL with `Cache-Control: max-age=86400`, so if you point an already-loaded
> origin at a *different* archive (e.g. the 25 MB Bucharest cut → the 684 MB all-Romania
> build, which has different internal offsets), the browser may interpret cached byte ranges
> against the wrong archive → a blank/garbled map. Hard-reload (empty cache) after switching,
> or use a fresh origin/port. The parity run (§7) already uses a separate port for exactly this.

## 6a — Day-2 dev loop (`npm run dev:selfhost`)

Once the one-time import/build above (§1–§5) is done, this brings the serving engines up
and starts the app against them in **one command** — no need to hand-merge the overlay into
`.env` or start each engine yourself:

```bash
npm run dev:selfhost                 # up (app db + nominatim + ors + photon) then `next dev`
npm run dev:selfhost -- --dry-run    # preflight only: report prerequisites, no side effects
npm run dev:selfhost:down            # stop engines + dev db (named volumes preserved)
```

What it does, in order (`docker/selfhost/dev-selfhost.sh`):

1. **Preflight (read-only, starts nothing).** Checks Docker is present, the built **host
   artifacts** exist — the self-built tiles archive (`TILES_PMTILES_PATH`, default
   `data/tiles/selfhost-romania.pmtiles`), the Photon index (`data/selfhost/photon/photon_data`)
   and jar — the imported **engine volumes** exist (`howfar-selfhost_nominatim-data`,
   `howfar-selfhost_ors-graphs`), and the required provider overlay keys are set. If anything
   is missing it prints what to build and exits `2`, pointing back here — it will **not**
   silently kick off the ~24-min Nominatim import that a bare `docker compose up` would after a
   `down -v` (drops the engine volumes) or `rm -rf data/osm` (drops the extract). `--dry-run`
   stops after this step. Two limits, kept honest: engine-volume verification needs the Docker
   daemon (if it's unreachable the check is skipped and preflight says so, since `up` then fails
   fast anyway), and it confirms the volumes *exist*, not that an import ran to completion — an
   interrupted import leaves a volume behind, so watch the health wait on the first start after
   an aborted import.
2. Brings up the app's dev Postgres (root `docker-compose.yml` `db`) and the provider serve
   stack (`nominatim`, `ors`, `photon`).
3. **Waits for the dev `db` and the three engines to report `healthy`**, bounded by
   `SELFHOST_WAIT_SECS` (default 300). If they don't — a fresh box still importing/building, a
   cold-starting db, or a crash — it exits **without** starting the app, so the app is never
   pointed at a cold db or dead engines. Raise the timeout
   for a first cold serve on slow disks, or watch `docker compose -f docker/selfhost/docker-compose.yml logs -f nominatim ors`.
4. Layers the provider overlay into the app's **process environment** (read straight from
   `env.selfhost.example`, so the two never drift) and runs `next dev`. Next.js does not
   override an env var already set in the process, so **`.env` is never touched** — it keeps
   its public defaults, and only this command runs the app against the local engines. Your
   existing `DATABASE_URL` / `AUTH_SECRET` in `.env` are still used (the overlay is providers
   only). This is the automated equivalent of §6 without the merge-into-`.env` step. It also
   prints a one-time **hard-reload** reminder: if this origin previously loaded a *different*
   tile archive (e.g. the public Bucharest cut under a plain `npm run dev`), empty-cache reload
   once or the map may render blank/garbled from stale byte ranges — the same cache trap §6
   warns about.

Stop the app with **Ctrl-C** (it runs in the foreground); stop everything the command started
— the provider engines **and** the dev `db` — with `npm run dev:selfhost:down`, which runs
`docker compose … stop` and **preserves the named volumes** so the next start is a ~15 s serve,
not a ~24 min re-import. To keep the shared `db` running (another app is on :5433), stop only
the engines with `docker compose -f docker/selfhost/docker-compose.yml --profile serve --profile import stop`.
For a fuller teardown (remove containers, or delete the volumes) see [Teardown](#teardown).

> **Not covered here.** `dev:selfhost` only starts the `db` **container**; applying the schema
> (`prisma migrate deploy`) and importing the amenity catalogue (`npm run amenities:refresh`)
> are the normal app setup (README Quick start), unchanged. And **transit is still not
> self-hosted** — `/api/transit` and `/api/reach` keep their public provider (the MOTIS/GTFS
> gate), so those routes hit the network even under `dev:selfhost`.

## 7 — Parity check (public vs local)

The app reads provider env at process start, so run **two** instances from the SAME
build — the PUBLIC one with a clean env (do NOT merge the overlay into `.env`), the
LOCAL one with the self-host provider vars set INLINE on its command. The local one
uses a distinct `PROVIDER_DATA_REVISION` so the two ApiCache namespaces never cross.
Keep `.env` at its public defaults (the overlay values go inline below, not in `.env`).

```bash
npm run build

# PUBLIC instance — set the PUBLIC provider bases INLINE (do NOT rely on .env: if you
# merged the overlay in §6, .env now points at localhost and BOTH legs would hit the
# self-hosted engines, reporting a vacuous 27/27). Give it its OWN fresh revision token
# so it queries the providers rather than serving old ApiCache rows. Needs ORS_API_KEY in .env.
NOMINATIM_BASE_URL=https://nominatim.openstreetmap.org \
PHOTON_BASE_URL=https://photon.komoot.io \
ORS_BASE_URL=https://api.openrouteservice.org \
PROVIDER_DATA_REVISION=public-$(date +%s) \
PORT=3000 npm run start &

# LOCAL instance — self-host providers, set inline (a DISTINCT PROVIDER_DATA_REVISION),
# and point at the self-built tiles so the map serves them (not the public cut):
NOMINATIM_BASE_URL=http://localhost:8081 \
PHOTON_BASE_URL=http://localhost:2322 \
ORS_BASE_URL=http://localhost:8082/ors \
TILES_PMTILES_PATH=data/tiles/selfhost-romania.pmtiles \
PROVIDER_DATA_REVISION=romania-260824-$(date +%s) \
NOMINATIM_MIN_INTERVAL_MS=0 PHOTON_MIN_INTERVAL_MS=0 ORS_MIN_INTERVAL_MS=0 \
PORT=3001 npm run start &

node docker/selfhost/parity-check.mjs --public http://localhost:3000 --local http://localhost:3001
```

Setting the public bases inline (not via `.env`) is what makes §7 correct regardless of
whether §6's overlay is in `.env`; the per-run `$(date +%s)` revision suffix colds BOTH
ApiCache namespaces so the comparison re-hits the live providers on each leg rather than
serving cached rows (there is no expiry reaper — see Caveats).

The harness gates each ring on FULL bearing coverage on both legs AND median AND
worst-sector radial residual AND the area band. A wedge clipped from an *enclosing*
ring casts a short ray in those bearings → caught by the worst-sector bound; the
full-coverage gate (`n === bins`) is the separate guard for a ring that fails to
*enclose* the origin (a null/short-of-boundary ray), so a partial-coverage comparison
can never pass on a shrunken sample. A provenance preflight first checks all three
engines are live and the local app's answers match each local engine's own (else it
aborts; see run-manifest for the honest limit). Tolerances: geocode + reverse ≤ 150 m
(specific landmarks); rings full-coverage / median ≤ ±10% / max ≤ ±15% / area ±21%;
suggest top hit ≤ 500 m. `--public-only` does a dry-run; `--self-test` validates the geometry instrument. **Bump `PROVIDER_DATA_REVISION` for a fresh run** (or purge
`ApiCache`) so the comparison re-hits the engines rather than serving cached rows.

## Teardown

```bash
docker compose -f docker/selfhost/docker-compose.yml down            # stop; keep volumes
docker compose -f docker/selfhost/docker-compose.yml down -v         # also delete engine volumes
rm -rf data/osm data/selfhost                                        # reclaim disk (gitignored)
```

## Caveats

- **Transit is not self-hosted** (GTFS licence gate) — it keeps its current provider.
- **Tile attribution now credits every bundled source.** The protomaps/basemaps build bundles more
  than OpenStreetMap — Natural Earth, OSM water/land polygons, and **Daylight landcover** (derived
  from ESA WorldCover), which carry their own attribution requirements. (Our build takes landcover
  from `daylight-landcover.gpkg`; it does **not** pass `--overture`, so no Overture Buildings/Places
  layers are bundled — the upstream `LICENSE_DATA.md` "See the Overture Maps Attribution Guidelines"
  pointer is for ESA's own prescribed wording, applied below.) The authoritative list is
  protomaps/basemaps' own `LICENSE_DATA.md`; the local copy under
  `data/selfhost/planetiler/basemaps/` is a transient build artifact (gitignored, removed by the
  cleanup below), so cite the durable upstream at the build-pinned commit:
  <https://github.com/protomaps/basemaps/blob/a50c699adc60a45c899971b1e11275e61f13bfbf/LICENSE_DATA.md>
  (that commit is recorded in `docker/selfhost/run-manifest.md`). The map's attribution control
  (`src/features/map/map-setup.ts`) credits OpenStreetMap (ODbL) — which also covers the ODbL
  water/land coastline polygons (osmdata.openstreetmap.de), being OSM-derived — plus **ESA
  WorldCover landcover under CC BY 4.0 with the licence link and a "modified" indication, via
  Daylight** (CC BY 4.0 §3(a)(1)(B) requires flagging modification — Daylight vectorised ESA's
  raster; the ESA link goes to ESA's data-access page, and README carries the fuller "contains
  modified Copernicus Sentinel data … processed by the ESA WorldCover consortium" acknowledgement),
  and Natural Earth (public-domain; shown by owner decision). The exact ESA WorldCover vintage is not
  pinned in the current build (parked — add the year at go-live). Note the dark flavor *defines* a `landcover` layer
  but fades it to opacity 0 above z7, and the city-extent `maxBounds` (`NEXT_PUBLIC_MAP_BBOX`) keeps
  the camera above z7 today, so those pixels do not paint at this extent — the ESA data is
  nonetheless **bundled in the served pmtiles archive** regardless, and a wider extent (P4) could
  drop the floor to where it paints, so the CC BY 4.0 credit is carried for the distribution either
  way. The same credit string serves the public build.protomaps.com cut and this self-built archive,
  since both bundle the same sources. (Basis: the public cut's PMTiles metadata declares a
  `landcover` vector layer — the same 9 source-layers as the self-built archive — and the bbox
  extract retains the z0–z7 tiles where that layer is opaque; both run the same protomaps/basemaps
  profile. This is a schema + same-profile argument, not a per-feature decode.) (The basemap POI-icon sprite is Mapzen/`tangrams/icons`, MIT;
  it is hot-linked from `protomaps.github.io` — referenced, not redistributed — but its MIT notice
  is carried in README's Attribution section for good measure.) The owner decision was to SHOW the
  credits, not to drop Daylight
  landcover from the build. **Still open (parked, tracked for go-live):** the raw `.pmtiles` archive
  served by `/api/tiles` embeds only OSM in its own TileJSON metadata — a direct archive download
  (bypassing the map) would not carry the ESA/Natural-Earth credit; embedding the full notice in the
  archive metadata is a build-pipeline change beyond this UI task.
- **Basemap glyphs + sprite** are still fetched keyless from `protomaps.github.io`
  (tracked polish item, `docs/PROVIDERS.md`) — only the tiles are self-hosted here.
- **Run imports one at a time.** Peak RAM, not disk, is the constraint on a small box.
- **Reproducibility:** the extract md5, engine image digests, Photon jar sha256, and the
  resolved protomaps/basemaps commit are recorded in `docker/selfhost/run-manifest.md`
  (the tile archive itself is schema-stable but not bit-reproducible — its base datasets
  are unpinned upstream; see the manifest).
- **Rebuilding from a NEWER extract touches several files + is a full re-import.** The
  extract filename is currently repeated in a few places — when you change it, edit ALL of
  them together (they are not yet single-sourced): `EXTRACT_DATE` in
  `docker/selfhost/fetch-romania-extract.sh` (+ its `EXTRACT_MD5`), the two PBF bind-mount
  paths in `docker/selfhost/docker-compose.yml` (nominatim + ors), and the `EXTRACT`/`--osm-path`
  in `docker/selfhost/build-tiles.sh`. THEN: the Nominatim DB and ORS graph persist in named
  volumes and are reused as-is, so a new extract needs `docker compose -f
  docker/selfhost/docker-compose.yml down -v` (drop the volumes) + re-import + re-run the Photon
  import + `build-tiles.sh`. THEN bump `PROVIDER_DATA_REVISION` and pair it with
  `DELETE FROM "ApiCache"` (there is no expiry reaper yet). Bumping the revision alone would cold
  the cache and refill it from the OLD graph/DB.
