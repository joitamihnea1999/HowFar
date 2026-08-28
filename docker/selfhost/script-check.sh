#!/usr/bin/env bash
# Static + fail-loud checks for the dev:selfhost scripts. Wired into `npm run check` /
# `check:ci` so a future edit that breaks them is caught by a gate, not just by the one-off
# manual run that first validated them.
#
# Hermetic by design: needs only bash + mktemp (NO docker daemon, NO network), writes only
# to a private mktemp dir, and is parallel-safe. It proves two things:
#   1. both scripts parse            -> bash -n
#   2. dev-selfhost.sh's preflight FAILS LOUD (exit 2) when the built artifacts are absent,
#      so it can never fall through to a silent `docker compose up` first-run import.
# It reproduces the fail-loud guard by running --dry-run from a copied, artifact-less root;
# the host-file checks run before any docker call, so the run exits 2 without a daemon.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[script-check] bash -n ..."
bash -n "$SCRIPT_DIR/dev-selfhost.sh"
bash -n "$SCRIPT_DIR/stop-selfhost.sh"
bash -n "$SCRIPT_DIR/script-check.sh"

echo "[script-check] fail-loud preflight (artifact-less root must exit 2) ..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/docker/selfhost"
cp "$SCRIPT_DIR/dev-selfhost.sh" "$SCRIPT_DIR/env.selfhost.example" "$tmp/docker/selfhost/"
set +e
bash "$tmp/docker/selfhost/dev-selfhost.sh" --dry-run >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 2 ]; then
  echo "[script-check] FAIL: preflight against an artifact-less root returned $rc, expected 2 (the fail-loud guard is broken)." >&2
  exit 1
fi

echo "[script-check] OK: scripts parse; preflight fails loud (exit 2) when built artifacts are absent."
