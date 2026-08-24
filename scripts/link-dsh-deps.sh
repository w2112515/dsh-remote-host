#!/bin/sh
# ESM cannot see DSH's nested @deepseek-ai from this package path.
# Link that directory into this package's node_modules.
set -e

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$ROOT/node_modules"

find_nested() {
  if [ -n "${DSH_NESTED_DEEPSEEK_AI:-}" ] && [ -d "$DSH_NESTED_DEEPSEEK_AI" ]; then
    printf '%s\n' "$DSH_NESTED_DEEPSEEK_AI"
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    g="$(npm root -g 2>/dev/null || true)"
    if [ -n "$g" ] && [ -d "$g/@deepseek-ai/dsh/node_modules/@deepseek-ai" ]; then
      printf '%s\n' "$g/@deepseek-ai/dsh/node_modules/@deepseek-ai"
      return 0
    fi
  fi
  if [ -d /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai ]; then
    printf '%s\n' /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
    return 0
  fi
  if command -v dsh >/dev/null 2>&1; then
    bin="$(command -v dsh)"
    resolved="$bin"
    if command -v readlink >/dev/null 2>&1; then
      resolved="$(readlink -f "$bin" 2>/dev/null || readlink "$bin" || printf '%s\n' "$bin")"
    fi
    case "$resolved" in
      */@deepseek-ai/dsh/*)
        prefix="${resolved%%/@deepseek-ai/dsh/*}/@deepseek-ai/dsh/node_modules/@deepseek-ai"
        if [ -d "$prefix" ]; then
          printf '%s\n' "$prefix"
          return 0
        fi
        ;;
    esac
  fi
  return 1
}

SRC="$(find_nested)" || {
  echo "link-dsh-deps: cannot find dsh nested @deepseek-ai. Install npm @deepseek-ai/dsh first." >&2
  exit 1
}

ln -sfn "$SRC" "$ROOT/node_modules/@deepseek-ai"
echo "linked $SRC -> $ROOT/node_modules/@deepseek-ai"

# Packed runtime still has some @dsh-remote/host imports (0.2.0 pack name).
mkdir -p "$ROOT/node_modules/@dsh-remote"
ln -sfn "$ROOT" "$ROOT/node_modules/@dsh-remote/host"
echo "linked $ROOT -> $ROOT/node_modules/@dsh-remote/host"

# Cordis resolves bundle names from the profile directory, not from $PWD.
PROFILE="${DSH_PROFILE:-web}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DEST_PARENT="$HOME_DIR/profiles/$PROFILE/node_modules/@w2112515"
mkdir -p "$DEST_PARENT"
ln -sfn "$ROOT" "$DEST_PARENT/dsh-remote-host"
echo "linked $ROOT -> $DEST_PARENT/dsh-remote-host"
