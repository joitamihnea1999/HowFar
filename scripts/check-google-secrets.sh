#!/usr/bin/env bash

set -euo pipefail

# Keep scan output value-safe: report only the Git target and path, never the
# matching line. Exact formats cover Google API keys, current OAuth secrets,
# service-account JSON, hardcoded OAuth assignments, and accidental public envs.
credential_pattern="AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{16,}|\"type\"[[:space:]]*:[[:space:]]*\"service_account\"|(AUTH_GOOGLE_SECRET|GOOGLE_CLIENT_SECRET|GOOGLE_OAUTH_CLIENT_SECRET)[[:space:]]*[:=][[:space:]]*[\"']?[0-9A-Za-z_-]{16,}|NEXT_PUBLIC_[A-Z0-9_]*GOOGLE[A-Z0-9_]*"
found=0

report_paths() {
  local target="$1"
  local paths="$2"

  if [[ -z "$paths" ]]; then
    return
  fi

  found=1
  while IFS= read -r path; do
    printf 'Potential Google credential in %s: %s\n' "$target" "$path"
  done <<< "$paths"
}

worktree_hits="$(git grep -I -l -E "$credential_pattern" -- . || true)"
report_paths "working tree" "$worktree_hits"

index_hits="$(git grep --cached -I -l -E "$credential_pattern" -- . || true)"
report_paths "Git index" "$index_hits"

while IFS= read -r revision; do
  revision_hits="$(git grep -I -l -E "$credential_pattern" "$revision" -- . || true)"
  if [[ -n "$revision_hits" ]]; then
    report_paths "commit ${revision:0:12}" "$revision_hits"
  fi
done < <(git rev-list --all)

tracked_env_files="$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v -E '(^|/)\.env\.example$' || true)"
if [[ -n "$tracked_env_files" ]]; then
  report_paths "tracked environment file" "$tracked_env_files"
fi

if (( found != 0 )); then
  printf 'Google credential safety check failed. Remove the value, rotate it if it was published, then rerun this command.\n' >&2
  exit 1
fi

printf 'Google credential safety check passed.\n'
