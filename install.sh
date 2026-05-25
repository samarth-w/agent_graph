#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# cgraph installer — works on macOS and Linux.
# No prerequisites needed (installs Node.js if missing).
#
# Usage:
# curl -fsSL https://raw.githubusercontent.com/samarth-w/agent_graph/main/install.sh | bash
#
#   # Or with options:
#   INSTALL_DIR=~/tools/cgraph bash install.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.cgraph-install}"
NODE_VERSION="${NODE_VERSION:-22.16.0}"
REPO_URL="${REPO_URL:-https://github.com/samarth-w/agent_graph.git}"

step()  { printf "\n\033[36m=> %s\033[0m\n" "$1"; }
ok()    { printf "   \033[32m%s\033[0m\n" "$1"; }
warn()  { printf "   \033[33m%s\033[0m\n" "$1"; }
fail()  { printf "   \033[31m%s\033[0m\n" "$1"; exit 1; }

echo
echo "============================"
echo "  cgraph Installer"
echo "============================"
echo

# --- 1. Check/Install Node.js ---
step "Checking Node.js..."

if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        ok "Found Node.js $NODE_VER (OK)"
        NODE_BIN=$(command -v node)
    else
        warn "Found Node.js $NODE_VER but need >= 18. Will install portable."
        NODE_BIN=""
    fi
else
    NODE_BIN=""
fi

if [ -z "$NODE_BIN" ]; then
    step "Installing portable Node.js $NODE_VERSION..."

    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) fail "Unsupported architecture: $ARCH" ;;
    esac
    case "$OS" in
        darwin) PLATFORM="darwin" ;;
        linux)  PLATFORM="linux" ;;
        *) fail "Unsupported OS: $OS" ;;
    esac

    NODE_DIST="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}"
    NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
    NODE_DIR="$INSTALL_DIR/node"

    mkdir -p "$INSTALL_DIR"

    echo "   Downloading $NODE_URL ..."
    curl -fsSL "$NODE_URL" | tar -xz -C "$INSTALL_DIR"
    rm -rf "$NODE_DIR"
    mv "$INSTALL_DIR/$NODE_DIST" "$NODE_DIR"

    NODE_BIN="$NODE_DIR/bin/node"
    NPM_BIN="$NODE_DIR/bin/npm"
    export PATH="$NODE_DIR/bin:$PATH"
    ok "Portable Node.js installed at $NODE_DIR"
fi

# Verify
VER=$(node --version 2>/dev/null || true)
[ -n "$VER" ] || fail "Node.js not working. Install manually from https://nodejs.org"
ok "Using Node.js $VER"

# --- 2. Get cgraph source ---
step "Setting up cgraph..."

CGRAPH_DIR="$INSTALL_DIR/cgraph"

if [ -f "$CGRAPH_DIR/package.json" ]; then
    ok "cgraph source already exists at $CGRAPH_DIR"
    if [ -d "$CGRAPH_DIR/.git" ] && command -v git >/dev/null 2>&1; then
        echo "   Pulling latest..."
        (cd "$CGRAPH_DIR" && git pull --ff-only 2>/dev/null || true)
    fi
elif command -v git >/dev/null 2>&1; then
    echo "   Cloning repository..."
    git clone "$REPO_URL" "$CGRAPH_DIR"
else
    echo "   Downloading as zip (no git needed)..."
    ZIP_URL="${REPO_URL%.git}/archive/refs/heads/main.zip"
    mkdir -p "$CGRAPH_DIR"
    TMPZIP=$(mktemp)
    curl -fsSL "$ZIP_URL" -o "$TMPZIP"
    unzip -qo "$TMPZIP" -d "$INSTALL_DIR"
    # GitHub zips extract to repo-name-branch/
    EXTRACTED=$(ls -d "$INSTALL_DIR"/cgraph-* 2>/dev/null | head -1)
    if [ -n "$EXTRACTED" ] && [ -d "$EXTRACTED" ]; then
        rm -rf "$CGRAPH_DIR"
        mv "$EXTRACTED" "$CGRAPH_DIR"
    fi
    rm -f "$TMPZIP"
fi

[ -f "$CGRAPH_DIR/package.json" ] || fail "cgraph source not found at $CGRAPH_DIR"

# --- 3. Install + build ---
step "Installing dependencies..."
cd "$CGRAPH_DIR"
npm install --no-fund --no-audit 2>&1 | tail -1
ok "Dependencies installed"

step "Building..."
npm run build 2>&1 | tail -1
ok "Build complete"

# --- 4. Create launcher ---
step "Creating launcher..."

BIN_DIR="$INSTALL_DIR/bin"
mkdir -p "$BIN_DIR"

NODE_BIN="${NODE_BIN:-$(command -v node)}"

cat > "$BIN_DIR/cgraph" <<LAUNCHER
#!/bin/sh
exec "$NODE_BIN" "$CGRAPH_DIR/bin/cgraph.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/cgraph"
ok "Launcher at $BIN_DIR/cgraph"

# --- 5. Add to PATH ---
step "Configuring PATH..."

SHELL_NAME=$(basename "${SHELL:-/bin/bash}")
case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
    *)    RC_FILE="$HOME/.bashrc" ;;
esac

PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
if [ "$SHELL_NAME" = "fish" ]; then
    PATH_LINE="set -gx PATH $BIN_DIR \$PATH"
fi

if ! grep -q "$BIN_DIR" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# cgraph" >> "$RC_FILE"
    echo "$PATH_LINE" >> "$RC_FILE"
    ok "Added to $RC_FILE"
    warn "Run: source $RC_FILE  (or restart your terminal)"
else
    ok "$BIN_DIR already in $RC_FILE"
fi

export PATH="$BIN_DIR:$PATH"

# --- 6. Verify ---
step "Verifying..."
TEST_VER=$("$BIN_DIR/cgraph" --version 2>&1 || true)
ok "cgraph $TEST_VER installed!"

# --- 6. Configure VS Code user-level MCP (works in ALL workspaces) ---
step "Configuring VS Code MCP (user-level, all workspaces)..."

# Find VS Code settings directory
if [ "$(uname -s)" = "Darwin" ]; then
    VSCODE_SETTINGS_DIR="$HOME/Library/Application Support/Code/User"
else
    VSCODE_SETTINGS_DIR="$HOME/.config/Code/User"
fi
VSCODE_SETTINGS_FILE="$VSCODE_SETTINGS_DIR/settings.json"

NODE_BIN_ESCAPED=$(echo "$NODE_BIN" | sed 's/\//\\\//g')
CGRAPH_JS_ESCAPED=$(echo "$CGRAPH_DIR/bin/cgraph.js" | sed 's/\//\\\//g')

if [ -f "$VSCODE_SETTINGS_FILE" ] && grep -q '"cgraph"' "$VSCODE_SETTINGS_FILE" 2>/dev/null; then
    ok "cgraph MCP already configured in VS Code settings"
elif command -v python3 >/dev/null 2>&1; then
    # Use python3 for safe JSON manipulation
    mkdir -p "$VSCODE_SETTINGS_DIR"
    [ -f "$VSCODE_SETTINGS_FILE" ] || echo '{}' > "$VSCODE_SETTINGS_FILE"

    python3 -c "
import json, sys

with open('$VSCODE_SETTINGS_FILE', 'r') as f:
    try:
        settings = json.load(f)
    except:
        settings = {}

if 'mcp' not in settings:
    settings['mcp'] = {}
if 'servers' not in settings['mcp']:
    settings['mcp']['servers'] = {}

settings['mcp']['servers']['cgraph'] = {
    'command': '$NODE_BIN',
    'args': ['$CGRAPH_DIR/bin/cgraph.js', 'serve', '--mcp'],
    'cwd': '\${workspaceFolder}'
}

with open('$VSCODE_SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
" 2>/dev/null

    if [ $? -eq 0 ]; then
        ok "Added cgraph MCP server to VS Code user settings"
        ok "cgraph is now available in ALL workspaces — no per-project setup needed"
    else
        warn "Could not auto-configure VS Code. See manual setup below."
    fi
else
    warn "python3 not found — cannot auto-configure VS Code settings"
    warn "Add this to your VS Code settings.json manually (see below)"
fi

# --- 7. Configure Copilot to prefer cgraph tools ---
step "Configuring Copilot agent instructions..."

INSTRUCTION_TEXT="Use cgraph MCP tools (cgraph_node, cgraph_callers, cgraph_callees, cgraph_search, cgraph_explore, cgraph_context, cgraph_impact, cgraph_trace, cgraph_affected, cgraph_export, cgraph_changed) for code exploration instead of read_file or grep_search. Only use read_file for raw config files or non-code assets."

if grep -q 'codeGeneration.instructions' "$VSCODE_SETTINGS_FILE" 2>/dev/null; then
    ok "Copilot codeGeneration.instructions already configured"
elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json

with open('$VSCODE_SETTINGS_FILE', 'r') as f:
    try:
        settings = json.load(f)
    except:
        settings = {}

settings['github.copilot.chat.codeGeneration.instructions'] = [
    {'text': '$INSTRUCTION_TEXT'}
]

with open('$VSCODE_SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\\n')
" 2>/dev/null

    if [ $? -eq 0 ]; then
        ok "Added Copilot instruction: prefer cgraph tools for code exploration"
    else
        warn "Could not auto-configure Copilot instructions."
    fi
else
    warn "python3 not found — add codeGeneration.instructions manually (see README)"
fi

# --- 8. Verify ---
step "Verifying..."
TEST_VER=$("$BIN_DIR/cgraph" --version 2>&1 || true)
ok "cgraph $TEST_VER installed!"

# --- Done ---
echo
echo "============================"
echo "  Installation Complete!"
echo "============================"
echo
echo "  Install dir:  $INSTALL_DIR"
echo "  Command:      cgraph"
echo "  Node:         $NODE_BIN"
echo
echo "  VS Code MCP:  Configured globally (user settings)"
echo "                Works in ALL workspaces automatically"
echo "                Auto-indexes on first Copilot query"
echo
echo "  That's it — open any project in VS Code and ask Copilot!"
echo
echo "  CLI also available:"
echo "    cgraph index              # manual index"
echo "    cgraph status             # check what was indexed"
echo "    cgraph search myFunction  # find symbols"
echo "    cgraph callers myFunction # who calls it?"
echo
