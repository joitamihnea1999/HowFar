#!/usr/bin/env bash
# Fetch the pinned komoot Photon jar into the gitignored photon data dir, where
# the photon / photon-import compose services mount it (as /photon/photon.jar).
# Photon builds its index from the Nominatim DB (-nominatim-import), so it derives
# from the SAME ONE Romania extract — this jar is just the pinned engine binary.
#
# Usage: docker/selfhost/fetch-photon-jar.sh
set -euo pipefail

PHOTON_VERSION="1.3.0"                        # pinned (komoot/photon release)
PHOTON_SHA256="a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5"
JAR_URL="https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${ROOT}/data/selfhost/photon"
OUT="${OUT_DIR}/photon.jar"

mkdir -p "$OUT_DIR"

verify() { echo "${PHOTON_SHA256}  $1" | sha256sum -c - >/dev/null 2>&1; }

# Idempotent, but re-verify: a pre-existing jar is trusted only if its checksum matches.
if [ -f "$OUT" ] && verify "$OUT"; then
  echo "Already present and sha256-verified: $OUT"
  ls -lh "$OUT"
  exit 0
fi

echo "Downloading photon-${PHOTON_VERSION}.jar (~94 MB) ..."
curl -fSL --retry 3 --retry-delay 5 -o "${OUT}.part" "$JAR_URL"
if ! verify "${OUT}.part"; then
  echo "ERROR: sha256 mismatch on the downloaded jar — refusing to keep it." >&2
  rm -f "${OUT}.part"; exit 1
fi
mv "${OUT}.part" "$OUT"                        # atomic publish
echo "Downloaded + sha256-verified:"
ls -lh "$OUT"
