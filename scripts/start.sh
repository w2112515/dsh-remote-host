#!/bin/sh
# Boot loopback dsh web + Remote projection. Source the setup env file first.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if [ -f "$HOME_DIR/remote-host.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME_DIR/remote-host.env"
  set +a
fi
# env.sh locates natives from $PWD (package root).
# shellcheck disable=SC1091
. "$ROOT/scripts/env.sh"
WEB="${DSH_WEB_PORT:-3180}"
exec dsh --profile web --patch "$ROOT/cordis.patch.yml" --host 127.0.0.1 --port "$WEB" --no-open
