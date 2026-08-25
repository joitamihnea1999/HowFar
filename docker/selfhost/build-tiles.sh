#!/usr/bin/env bash
# Build the self-hosted basemap pmtiles FROM the ONE Romania extract, in the
# Protomaps basemap schema that the app's map style (@protomaps/basemaps ^5.7.2,
# src/features/map/map-setup.ts) expects.
#
# WHY not stock planetiler: a plain planetiler run emits the OpenMapTiles schema,
# whose source-layer names do NOT match the Protomaps style → the map renders
# blank. The Protomaps schema is produced by the protomaps/basemaps Planetiler
# BUILD PROFILE, compiled from source. This script builds that jar (in a
# maven+temurin container, so no host Java/Maven is needed) and runs it.
#
# Reproducibility: the generator is pinned to a specific commit SHA via
# PROTOMAPS_BASEMAPS_REF (default below), and the built jar is cached per-SHA so a
# ref change forces a rebuild rather than silently reusing a stale jar. The npm
# styles version and this repo's git tags are decoupled, so the authoritative
# schema check is by OUTPUT: the emitted archive must carry the same source-layers
# as the current basemap archive, not by version string.
#
# Output is written to a temp file then atomically moved into place, so the tiles
# route (which serves whatever file is at the path) never sees a half-written archive.
#
# Usage: docker/selfhost/build-tiles.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="${ROOT}/data/selfhost/planetiler"      # gitignored; holds the checkout + built jar
EXTRACT="${ROOT}/data/osm/romania-260824.osm.pbf" # the ONE extract (pinned)
# Pinned to the commit that produced the measured/parity-checked tiles. Override
# only deliberately (and bump the run manifest + PROVIDER_DATA_REVISION with it).
PROTOMAPS_BASEMAPS_REF="${PROTOMAPS_BASEMAPS_REF:-a50c699adc60a45c899971b1e11275e61f13bfbf}"
BUILD_IMAGE="maven:3.9-eclipse-temurin-21@sha256:8f6ac126f7810bb5549c4cd122d2bf0e9cda5bdeb0838aa928f09e779fd8bef8"
# Planetiler parses the whole extract's nodes in pass1 (Romania ≈ 40 M nodes);
# the default in-heap node map OOMs at 2 GB. 6 GB heap + memory-mapped node/temp
# storage builds Romania reliably. The tile build is a one-time offline step, so a
# transient 6–8 GB footprint is acceptable (run it with the serving engines stopped).
XMX="${TILES_XMX:-6g}"
MEM_LIMIT="${TILES_MEM_LIMIT:-8g}"

# Read the extent + output path from .env by name (never `source` .env — a secret
# with a space or $(...) would break under set -euo pipefail). Same pattern and
# same two vars as scripts/fetch-tiles.sh, so "which region / which archive" has
# ONE source of truth.
read_env_key() { # $1 = key; echoes the .env value (unquoted) or nothing
  [ -f "${ROOT}/.env" ] || return 0
  { grep -E "^$1=" "${ROOT}/.env" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
BBOX="${NEXT_PUBLIC_MAP_BBOX:-$(read_env_key NEXT_PUBLIC_MAP_BBOX)}"
BBOX="${BBOX:-25.8,44.2,26.4,44.7}"                       # default: Bucharest + Ilfov ring
OUT_REL="${TILES_PMTILES_PATH:-$(read_env_key TILES_PMTILES_PATH)}"
# Default to a DISTINCT self-host path (NOT the public default data/tiles/bucharest.pmtiles)
# so building the local tiles never clobbers the public-cut archive that the DEFAULT
# config serves. env.selfhost.example points TILES_PMTILES_PATH here for the self-host run.
OUT_REL="${OUT_REL:-data/tiles/selfhost-romania.pmtiles}"
# TILES_PMTILES_PATH may be absolute or relative-to-cwd. The build container mounts
# ONLY ../../data, so the output MUST live under data/ — normalize to a path relative
# to ROOT and reject anything outside data/ (incl. `..` traversal or an abs path
# elsewhere), which would otherwise target an unmounted path or escape the root.
case "$OUT_REL" in
  /*)
    case "$OUT_REL" in
      "${ROOT}/"*) OUT_WORK_REL="${OUT_REL#${ROOT}/}" ;;
      *) echo "ERROR: TILES_PMTILES_PATH ($OUT_REL) is outside the HowFar root; point it under data/." >&2; exit 1 ;;
    esac ;;
  *) OUT_WORK_REL="$OUT_REL" ;;
esac
case "$OUT_WORK_REL" in
  data/*) : ;;                                  # ok — the mounted, gitignored data tree
  *) echo "ERROR: TILES_PMTILES_PATH must resolve under data/ (got '$OUT_WORK_REL'); only data/ is mounted into the build." >&2; exit 1 ;;
esac
case "$OUT_WORK_REL" in
  *..*) echo "ERROR: TILES_PMTILES_PATH must not contain '..' path traversal." >&2; exit 1 ;;
esac
OUT="${ROOT}/${OUT_WORK_REL}"

[ -f "$EXTRACT" ] || { echo "ERROR: extract not found: $EXTRACT — run fetch-romania-extract.sh first." >&2; exit 1; }
mkdir -p "$BUILD_DIR" "$(dirname "$OUT")"

echo "Generator ref: ${PROTOMAPS_BASEMAPS_REF}"
echo "Extract:       ${EXTRACT}"
echo "BBOX:          ${BBOX}"
echo "Output:        ${OUT}"

# Build (once) + run + atomic-publish inside ONE maven+temurin container. The
# container sees the HowFar root at /work; the extract, build dir and output dir
# are all under it. The mv happens inside the container (same mount → atomic), so
# the tiles route never observes a half-written archive.
#
# Runs as the HOST user (--user) so every artifact (the vendored checkout, the
# maven repo, the published .pmtiles) is owned by you, not root — no post-build
# chown. Only ../../data is mounted (extract read-only), NOT the whole repo, so the
# cloned generator + maven deps cannot touch source or .env even by accident.
# HOME is redirected under the gitignored build dir so the maven repo (~/.m2) lands there.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${ROOT}/data:/work/data" \
  -v "${ROOT}/data/osm:/work/data/osm:ro" \
  -w /work \
  -e HOME=/work/data/selfhost/planetiler \
  -e MAVEN_OPTS="-Xmx${XMX}" \
  -e JAVA_TOOL_OPTIONS="-Xmx${XMX}" \
  -e PB_REF="${PROTOMAPS_BASEMAPS_REF}" \
  -e OUT_WORK_REL="${OUT_WORK_REL}" \
  -e BBOX="${BBOX}" \
  -e XMX="${XMX}" \
  --memory="${MEM_LIMIT}" \
  "$BUILD_IMAGE" \
  bash -euo pipefail -c '
    SRC=/work/data/selfhost/planetiler/basemaps
    if [ ! -d "$SRC/.git" ]; then
      git clone https://github.com/protomaps/basemaps.git "$SRC"
    fi
    git -C "$SRC" fetch --depth 1 origin "$PB_REF"
    git -C "$SRC" checkout FETCH_HEAD
    SHA=$(git -C "$SRC" rev-parse HEAD)
    echo "RESOLVED_PROTOMAPS_SHA=$SHA"    # record in run-manifest.md
    # Cache the built jar KEYED ON THE RESOLVED SHA: a ref change forces a rebuild
    # rather than silently reusing a jar built from a different commit.
    JAR=$(ls "$SRC"/tiles/target/*-with-deps.jar 2>/dev/null | head -n1 || true)
    if [ -z "$JAR" ] || [ "$(cat "$SRC/.built-sha" 2>/dev/null || true)" != "$SHA" ]; then
      mvn -q -f "$SRC/tiles/pom.xml" -DskipTests clean package
      JAR=$(ls "$SRC"/tiles/target/*-with-deps.jar | head -n1)
      echo "$SHA" > "$SRC/.built-sha"
    fi
    echo "Using jar: $JAR (built from $SHA)"
    OUT_ABS="/work/${OUT_WORK_REL}"
    # Temp name MUST keep the .pmtiles extension — planetiler infers the archive
    # format from it. mktemp gives a collision-proof unique name (dot-prefixed) so
    # concurrent builds never share a temp and the tiles route never serves a
    # half-written archive.
    TMP="$(mktemp -u "$(dirname "$OUT_ABS")/.building.XXXXXX.$(basename "$OUT_ABS")")"
    # Run from a GITIGNORED working dir so planetiler'\''s relative data/sources/ +
    # data/tmp/ (the ~2.25 GB Protomaps base set: Natural Earth, OSM water/land
    # polygons, Daylight landcover — downloaded once, cached) never touch the
    # committed tree.
    WORK=/work/data/selfhost/planetiler/work
    mkdir -p "$WORK"; cd "$WORK"
    # --download fetches the standard Protomaps base datasets that the basemap
    # schema needs ALONGSIDE the OSM extract (this is how build.protomaps.com works).
    java -Xmx"$XMX" -jar "$JAR" \
      --osm-path=/work/data/osm/romania-260824.osm.pbf \
      --download=true --force \
      --bbox="$BBOX" \
      --output="$TMP"
    mv "$TMP" "$OUT_ABS"
    ls -lh "$OUT_ABS"
  '
echo "Built + published: ${OUT}"
