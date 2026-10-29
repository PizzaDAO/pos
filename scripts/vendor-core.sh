#!/usr/bin/env bash
# Re-pack @openpizza/core from a local checkout into vendor/ and re-point the dependency.
# Usage: npm run core:vendor -- ../core/packages/core
set -euo pipefail
SRC="${1:?usage: core:vendor <path to core/packages/core>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TGZ="$(cd "$SRC" && npm pack --silent --pack-destination "$ROOT/vendor" | tail -1)"
find "$ROOT/vendor" -name 'openpizza-core-*.tgz' ! -name "$TGZ" -delete
cd "$ROOT"
npm pkg set "dependencies.@openpizza/core=file:vendor/$TGZ"
rm -rf node_modules/@openpizza/core
npm install
echo "vendored vendor/$TGZ"
