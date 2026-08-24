#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$ROOT/scripts/setup.mjs" "$@"
