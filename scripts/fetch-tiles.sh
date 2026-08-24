#!/usr/bin/env bash
# Fetch the self-hosted Bucharest basemap extract (Protomaps daily build).
# Usage: scripts/fetch-tiles.sh [BUILD_DATE]   e.g. 20260713 (default: yesterday UTC)
# The build date is PINNED in .github/workflows/ci.yml (TILES_BUILD) and in
# railway.json's buildCommand — bump both together, deliberately.
set -euo pipefail

cd "$(dirname "$0")/.."

# Pick up config from .env so "point at another city" is a single .env edit that
# reaches the tile extract too (task 007). We read ONLY the two public knobs by
# name — never `source` .env, which would execute secrets (a password with a
# space or $(...) would break or run under `set -euo pipefail`). An already-set
# environment variable wins over .env; absent → today's Bucharest default.
read_env_key() { # $1 = key name; echoes the .env value (unquoted) or nothing
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
NEXT_PUBLIC_MAP_BBOX="${NEXT_PUBLIC_MAP_BBOX:-$(read_env_key NEXT_PUBLIC_MAP_BBOX)}"
TILES_PMTILES_PATH="${TILES_PMTILES_PATH:-$(read_env_key TILES_PMTILES_PATH)}"

BUILD_DATE="${1:-$(date -u -d 'yesterday' +%Y%m%d)}"
# Extent + output path are the SAME env vars the app reads (bounds.ts /
# tiles route) — one source of truth for "which region / which archive".
# NEXT_PUBLIC_MAP_BBOX is "minLng,minLat,maxLng,maxLat", exactly pmtiles'
# --bbox order (west,south,east,north).
BBOX="${NEXT_PUBLIC_MAP_BBOX:-25.80,44.20,26.40,44.70}" # default: Bucharest + Ilfov ring
OUT="${TILES_PMTILES_PATH:-data/tiles/bucharest.pmtiles}"
PMTILES_VERSION="1.31.1"

mkdir -p "$(dirname "$OUT")"

if ! command -v pmtiles >/dev/null 2>&1; then
  echo "pmtiles CLI not found — downloading v${PMTILES_VERSION} to .cache/ ..."
  mkdir -p .cache
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ASSET="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" ;;
    Linux-aarch64) ASSET="go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz" ;;
    Darwin-arm64) ASSET="go-pmtiles_${PMTILES_VERSION}_Darwin_arm64.tar.gz" ;;
    *) echo "Unsupported platform $(uname -s)-$(uname -m); install pmtiles manually: https://github.com/protomaps/go-pmtiles/releases" >&2; exit 1 ;;
  esac
  curl -sL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${ASSET}" | tar -xz -C .cache pmtiles
  PMTILES=".cache/pmtiles"
else
  PMTILES="pmtiles"
fi

echo "Extracting bbox ${BBOX} from build ${BUILD_DATE} ..."
"$PMTILES" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" "$OUT" --bbox="$BBOX"
ls -lh "$OUT"
