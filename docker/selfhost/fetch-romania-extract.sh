#!/usr/bin/env bash
# Fetch the Geofabrik Romania OSM extract that feeds the WHOLE self-host stack
# (Nominatim + Photon + ORS + planetiler all import from this ONE file).
#
# The extract is PINNED to a dated snapshot (not romania-latest) so a re-run
# reproduces the same search/routing results without a repository change (a
# mutable `-latest` tag would not be reproducible across rebuilds). Bump
# EXTRACT_DATE deliberately, and bump PROVIDER_DATA_REVISION with it (see
# env.selfhost.example) so the app's cache colds.
#
# Usage:
#   docker/selfhost/fetch-romania-extract.sh            # download + verify (idempotent)
#   docker/selfhost/fetch-romania-extract.sh --dry-run  # print target + size, download nothing
#
# The download is ~312 MB. It lands under the gitignored data/osm/ root.
set -euo pipefail

REGION_PATH="europe"
REGION="romania"
EXTRACT_DATE="260824"                       # Geofabrik snapshot YYMMDD (pinned)
EXTRACT_MD5="abc00e5b575aa51efc9ab39ea34655f4"   # pinned integrity digest (not trusted from the remote)
BASE="https://download.geofabrik.de/${REGION_PATH}"
PBF_NAME="${REGION}-${EXTRACT_DATE}.osm.pbf"
PBF_URL="${BASE}/${PBF_NAME}"

# Resolve the HowFar app root (two levels up from docker/selfhost/) so the
# extract always lands in the same gitignored place regardless of cwd.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${ROOT}/data/osm"
OUT="${OUT_DIR}/${PBF_NAME}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

echo "Extract:  ${PBF_URL}"
echo "Target:   ${OUT}"

# Expected size from a HEAD (also proves the pinned snapshot still exists).
EXPECTED_LEN="$(curl -fsIL "$PBF_URL" | awk 'tolower($0) ~ /^content-length:/ {v=$2} END{gsub(/\r/,"",v); print v}')"
if [ -n "${EXPECTED_LEN:-}" ]; then
  echo "Size:     ${EXPECTED_LEN} bytes (~$(( EXPECTED_LEN / 1024 / 1024 )) MB)"
else
  echo "Size:     (HEAD returned no content-length)"
fi

verify_md5() { # $1 = file; returns 0 iff it matches the PINNED md5 (no network)
  local got
  got="$(md5sum "$1" | awk '{print $1}')"
  echo "md5 want=${EXTRACT_MD5} got=${got}"
  [ "$EXTRACT_MD5" = "$got" ]
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] no download performed."
  exit 0
fi

mkdir -p "$OUT_DIR"

# Idempotent: keep an already-downloaded, verified extract.
if [ -f "$OUT" ] && verify_md5 "$OUT"; then
  echo "Already present and md5-verified — nothing to do."
  ls -lh "$OUT"
  exit 0
fi

echo "Downloading ${PBF_NAME} ..."
curl -fSL --retry 3 --retry-delay 5 -o "${OUT}.part" "$PBF_URL"

# Verify the .part BEFORE publishing (like fetch-photon-jar.sh) so a good file at
# the canonical path is never at risk, and an interrupt can't leave a corrupt file
# under the final name.
if ! verify_md5 "${OUT}.part"; then
  echo "ERROR: md5 mismatch on the downloaded extract — refusing to publish it." >&2
  rm -f "${OUT}.part"
  exit 1
fi
mv "${OUT}.part" "$OUT"          # atomic publish of the already-verified file

echo "Downloaded + md5-verified:"
ls -lh "$OUT"
