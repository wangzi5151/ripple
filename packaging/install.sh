#!/usr/bin/env bash
set -euo pipefail
PREFIX="${RIPPLE_PREFIX:-${HOME}/.local/share/ripple}"
BIN_DIR="${RIPPLE_BIN_DIR:-${HOME}/.local/bin}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$PREFIX" "$BIN_DIR"
cp -a "$SCRIPT_DIR/app/." "$PREFIX/"
cat > "$BIN_DIR/ripple" <<EOF
#!/usr/bin/env bash
exec node "$PREFIX/server/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/ripple"
printf 'Ripple installed to %s\n' "$PREFIX"
printf 'Run: %s\n' "$BIN_DIR/ripple"
printf 'Open: http://localhost:8787\n' 
