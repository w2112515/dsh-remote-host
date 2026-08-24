#!/bin/sh
# Point Remote at the prebuilds in this package. Safe to source more than once.
# Does not override variables the operator already set.
# Source from the package root: `. scripts/env.sh` (dash-safe; do not use $0).

ROOT=""
if [ -d "$PWD/native" ] && [ -f "$PWD/cordis.patch.yml" ]; then
  ROOT="$PWD"
elif [ -f "$PWD/env.sh" ] && [ -d "$PWD/../native" ]; then
  ROOT="$(CDPATH= cd -- "$PWD/.." && pwd)"
fi
if [ -z "$ROOT" ]; then
  echo "dsh-remote env.sh: cd to the package root first, then: . scripts/env.sh" >&2
  return 1 2>/dev/null || exit 1
fi

PLAT="$(node -p 'process.platform + "-" + process.arch')"
NAT="$ROOT/native/$PLAT"

if [ -z "${DSH_REMOTE_SECURITY_ADDON:-}" ] && [ -f "$NAT/dsh_remote_security_core.node" ]; then
  DSH_REMOTE_SECURITY_ADDON="$NAT/dsh_remote_security_core.node"
  export DSH_REMOTE_SECURITY_ADDON
fi

if [ -z "${DSH_REMOTE_IROH_BIN:-}" ]; then
  if [ -f "$NAT/dsh-remote-iroh" ]; then
    chmod +x "$NAT/dsh-remote-iroh" 2>/dev/null || true
    DSH_REMOTE_IROH_BIN="$NAT/dsh-remote-iroh"
    export DSH_REMOTE_IROH_BIN
  elif [ -f "$NAT/dsh-remote-iroh.exe" ]; then
    DSH_REMOTE_IROH_BIN="$NAT/dsh-remote-iroh.exe"
    export DSH_REMOTE_IROH_BIN
  fi
fi

if [ -z "${DSH_REMOTE_SECURITY_STORE:-}" ]; then
  DSH_REMOTE_SECURITY_STORE="${DSH_HOME:-$HOME/.dsh}/remote-host-security.bin"
  export DSH_REMOTE_SECURITY_STORE
fi
