#!/usr/bin/env bash
# Grade a half-app run: acceptance checks per ticket, applied to the repo a
# JFDI run merged into. Usage:
#
#   grade.sh <repo-dir> [check-name...]     # default: every check
#
# Each check exercises the BUILT artifact against the ticket's acceptance
# criteria (never the diff). Exit 0 iff every requested check passes.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: grade.sh <repo-dir> [check-name...]" >&2
  exit 2
fi

repo="$(cd "$1" && pwd)"
shift
checks_dir="$(cd "$(dirname "$0")/checks" && pwd)"

if [ "$#" -gt 0 ]; then
  checks=("$@")
else
  checks=()
  for f in "$checks_dir"/*.sh; do
    checks+=("$(basename "$f" .sh)")
  done
fi

echo "building $repo ..."
(cd "$repo" && pnpm install --prefer-offline >/dev/null && pnpm build >/dev/null)

pass=0
fail=0
for check in "${checks[@]}"; do
  if REPO="$repo" bash "$checks_dir/$check.sh" >/dev/null 2>&1; then
    echo "PASS $check"
    pass=$((pass + 1))
  else
    echo "FAIL $check"
    fail=$((fail + 1))
  fi
done

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
