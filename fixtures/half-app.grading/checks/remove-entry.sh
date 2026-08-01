#!/usr/bin/env bash
# Ticket: remove-entry — deletion with stable, never-reused ids
set -euo pipefail
cd "$REPO"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PENNY_FILE="$work/penny.json"
penny() { node dist/cli.js "$@"; }

penny add 1.00 a --date 2026-07-01
penny add 2.00 b --date 2026-07-02
penny add 3.00 c --date 2026-07-03

penny remove 2
out="$(penny list)"
echo "$out" | grep -q "#1"
echo "$out" | grep -q "#3"
! echo "$out" | grep -q "#2"

# Total reflects the removal (1 + 3 = 4).
penny total | grep -Eq "^Total: 4(\.00)?$"

# A removed id is never reused.
added="$(penny add 4.00 d --date 2026-07-04)"
! echo "$added" | grep -q "#2"
penny list | grep -q "4.00"

# Unknown and malformed ids: error, exit 1, ledger untouched.
if penny remove 99 2>/dev/null; then exit 1; fi
if penny remove banana 2>/dev/null; then exit 1; fi
[ "$(penny list | wc -l | tr -d ' ')" = "3" ]
