#!/usr/bin/env bash
# Fetch the self-hosted Bucharest basemap extract (Protomaps daily build).
# Usage: scripts/fetch-tiles.sh [BUILD_DATE]   e.g. 20260713 (default: yesterday UTC)
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DATE="${1:-$(date -u -d 'yesterday' +%Y%m%d)}"
BBOX="25.80,44.20,26.40,44.70" # Bucharest + Ilfov ring
OUT="data/tiles/bucharest.pmtiles"
PMTILES_VERSION="1.31.1"

mkdir -p data/tiles

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
