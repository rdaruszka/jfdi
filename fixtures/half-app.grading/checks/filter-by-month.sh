#!/usr/bin/env bash
# Ticket: filter-by-month — penny list --month YYYY-MM
set -euo pipefail
cd "$REPO"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PENNY_FILE="$work/penny.json"
penny() { node dist/cli.js "$@"; }

penny add 12.50 groceries --date 2026-07-01
penny add 4.25 coffee --date 2026-07-15
penny add 8.00 groceries --date 2026-08-02

out="$(penny list --month 2026-07)"
[ "$(echo "$out" | wc -l | tr -d ' ')" = "2" ]
! echo "$out" | grep -q "2026-08"

[ "$(penny list --month 2025-01)" = "No entries." ]

# Malformed month values are usage errors.
if penny list --month 2026-7 2>/dev/null; then exit 1; fi
if penny list --month July 2>/dev/null; then exit 1; fi

# Composes with --category when both exist (AND semantics).
if penny list --category groceries >/dev/null 2>&1; then
  both="$(penny list --month 2026-07 --category groceries)"
  [ "$(echo "$both" | wc -l | tr -d ' ')" = "1" ]
  echo "$both" | grep -q "2026-07-01"
fi
