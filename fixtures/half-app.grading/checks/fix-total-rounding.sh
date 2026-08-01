#!/usr/bin/env bash
# Ticket: fix-total-rounding — totals always show exactly two decimals
set -euo pipefail
cd "$REPO"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PENNY_FILE="$work/penny.json"
penny() { node dist/cli.js "$@"; }

penny add 0.10 snacks --date 2026-07-01
penny add 0.20 snacks --date 2026-07-02
[ "$(penny total)" = "Total: 0.30" ]

# Empty ledger.
export PENNY_FILE="$work/empty.json"
[ "$(penny total)" = "Total: 0.00" ]

# List output stays as it was.
export PENNY_FILE="$work/penny.json"
penny list | grep -q "#1  2026-07-01       0.10  snacks"
