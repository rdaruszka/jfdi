#!/usr/bin/env bash
# Ticket: extract-storage — behavior regression guard for the refactor.
# (Refactor *quality* is Code Review's job; this only proves nothing broke.)
set -euo pipefail
cd "$REPO"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PENNY_FILE="$work/penny.json"
penny() { node dist/cli.js "$@"; }

[ "$(penny add 12.50 groceries oat milk --date 2026-07-03)" = "Added #1  2026-07-03      12.50  groceries  oat milk" ]
penny add 7.50 coffee --date 2026-07-04
penny total | grep -Eq "^Total: 20(\.00)?$"
[ "$(penny list | wc -l | tr -d ' ')" = "2" ]

# Missing-file case still means an empty ledger.
export PENNY_FILE="$work/other.json"
[ "$(penny list)" = "No entries." ]

# No command file touches node:fs directly anymore.
! grep -l "node:fs" src/commands/*.ts
