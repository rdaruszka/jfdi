#!/usr/bin/env bash
# Ticket: filter-by-category — penny list --category <name>
set -euo pipefail
cd "$REPO"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PENNY_FILE="$work/penny.json"
penny() { node dist/cli.js "$@"; }

penny add 12.50 groceries oat milk --date 2026-07-01
penny add 4.25 coffee --date 2026-07-02
penny add 8.00 groceries eggs --date 2026-07-03

out="$(penny list --category groceries)"
[ "$(echo "$out" | wc -l | tr -d ' ')" = "2" ]
echo "$out" | grep -q "oat milk"
echo "$out" | grep -q "eggs"
! echo "$out" | grep -q "coffee"

# Case-insensitive exact match.
[ "$(penny list --category GROCERIES)" = "$out" ]

# No matches → same message as an empty ledger, exit 0.
[ "$(penny list --category travel)" = "No entries." ]

# Missing value is a usage error.
if penny list --category 2>/dev/null; then exit 1; fi

# Unfiltered list unchanged.
[ "$(penny list | wc -l | tr -d ' ')" = "3" ]
