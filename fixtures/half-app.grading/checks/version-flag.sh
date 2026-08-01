#!/usr/bin/env bash
# Card-only ticket: --version prints the version from package.json
set -euo pipefail
cd "$REPO"

expected="$(node -p "require('./package.json').version")"
node dist/cli.js --version | grep -q "$expected"
