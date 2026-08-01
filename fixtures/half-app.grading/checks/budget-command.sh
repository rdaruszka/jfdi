#!/usr/bin/env bash
# Ticket: budget-command — deliberately underspecified; grade only what any
# reasonable design must satisfy, plus that decisions were actually logged.
set -euo pipefail
cd "$REPO"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PENNY_FILE="$work/penny.json"

# Some budget surface exists: not rejected as an unknown command.
# (Capture first — pipefail would let the CLI's own exit code mask grep's.)
out="$(node dist/cli.js budget 2>&1 || true)"
! echo "$out" | grep -qi "unknown command"

# The design choices were recorded in the ticket note's Decisions section.
grep -A 3 "^## Decisions" .jfdi/tickets/budget-command.md | grep -q "^- "
