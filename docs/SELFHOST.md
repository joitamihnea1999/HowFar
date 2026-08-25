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
| ORS (foot-walking + driving-car) | ~6.6 min | ~1.82 GiB (XMX 2 g) | 799 MB |
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
tiles 684 MB ≈ 7.5 GB). The **~2.25 GB of Protomaps base sources** the tile build downloads
(`data/selfhost/planetiler/`) is a **separate build cache**, not serving data — keep it only to
rebuild tiles faster, else `rm -rf data/selfhost/planetiler` reclaims it.

**Parity (public vs self-hosted, 2026-08-25):** all 27 checks pass (after a provenance preflight that
proves all three engines are the ones the app uses) — 18/18 rings (walk + car) with median boundary
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

The geocoder keeps answering `/search` + `/reverse` byte-identically without the flatnode (verified
by re-querying after removal + a container restart). If you later need the flatnode back (to enable
minutely updates), there is no in-place rebuild — re-import (~24 min).

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
set the app is byte-identical to the public deployment.

> **Tile cache after repointing `TILES_PMTILES_PATH`.** `/api/tiles` serves every archive
> from the same URL with `Cache-Control: max-age=86400`, so if you point an already-loaded
> origin at a *different* archive (e.g. the 25 MB Bucharest cut → the 684 MB all-Romania
> build, which has different internal offsets), the browser may interpret cached byte ranges
> against the wrong archive → a blank/garbled map. Hard-reload (empty cache) after switching,
> or use a fresh origin/port. The parity run (§7) already uses a separate port for exactly this.

## 7 — Parity check (public vs local)

The app reads provider env at process start, so run **two** instances from the SAME
build — the PUBLIC one with a clean env (do NOT merge the overlay into `.env`), the
LOCAL one with the self-host provider vars set INLINE on its command. The local one
uses a distinct `PROVIDER_DATA_REVISION` so the two ApiCache namespaces never cross.
Keep `.env` at its public defaults (the overlay values go inline below, not in `.env`).

```bash
npm run build

# PUBLIC instance — default providers (public Nominatim/Photon/ORS; needs ORS_API_KEY in .env):
PORT=3000 npm run start &

# LOCAL instance — self-host providers, set inline (a DISTINCT PROVIDER_DATA_REVISION),
# and point at the self-built tiles so the map serves them (not the public cut):
NOMINATIM_BASE_URL=http://localhost:8081 \
PHOTON_BASE_URL=http://localhost:2322 \
ORS_BASE_URL=http://localhost:8082/ors \
TILES_PMTILES_PATH=data/tiles/selfhost-romania.pmtiles \
PROVIDER_DATA_REVISION=romania-260824 \
NOMINATIM_MIN_INTERVAL_MS=0 PHOTON_MIN_INTERVAL_MS=0 ORS_MIN_INTERVAL_MS=0 \
PORT=3001 npm run start &

node docker/selfhost/parity-check.mjs --public http://localhost:3000 --local http://localhost:3001
```

The harness gates each ring on median AND worst-sector radial residual AND zero
cross-coverage mismatch AND the area band — a truncated ring casts a short ray in the
clipped bearings (caught by the worst-sector bound), and a wedge present in only one leg
is caught by the cross-coverage mismatch (a bearing one ring reaches and the other does
not). A provenance preflight first proves all three engines are the ones the app uses
(else it aborts). Tolerances: geocode + reverse ≤ 150 m (specific landmarks); rings
median ≤ ±10% / max ≤ ±15% / zero cross-coverage mismatch / area ±21%; suggest top hit
≤ 500 m. `--public-only` does a dry-run; `--self-test` validates the geometry instrument. **Bump `PROVIDER_DATA_REVISION` for a fresh run** (or purge
`ApiCache`) so the comparison re-hits the engines rather than serving cached rows.

## Teardown

```bash
docker compose -f docker/selfhost/docker-compose.yml down            # stop; keep volumes
docker compose -f docker/selfhost/docker-compose.yml down -v         # also delete engine volumes
rm -rf data/osm data/selfhost                                        # reclaim disk (gitignored)
```

## Caveats

- **Transit is not self-hosted** (GTFS licence gate) — it keeps its current provider.
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
