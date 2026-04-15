#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🧠 Setting up ClipBrain..."
echo ""

# ─── Step 1: Install dependencies ────────────────────────────────────────────
echo "→ Installing dependencies..."
bun install

# ─── Step 2: Build gbrain engine ──────────────────────────────────────────────
echo "→ Building gbrain engine..."
cd node_modules/gbrain
bun install
bun build --compile --outfile ../../bin/gbrain src/cli.ts
cd "$SCRIPT_DIR"

# ─── Step 3: Initialize gbrain database ──────────────────────────────────────
if [ ! -f ~/.gbrain/config.json ]; then
  echo "→ Initializing ClipBrain database..."
  ./bin/gbrain init
else
  echo "→ ClipBrain already initialized ✓"
fi

# ─── Step 4: Configure MCP for your AI ───────────────────────────────────────
echo ""
echo "→ Configuring AI connection..."

CLI_TS_PATH="$SCRIPT_DIR/node_modules/gbrain/src/cli.ts"

# Auto-detect which AI tools are installed
HAS_CLAUDE=false
HAS_OPENCLAW=false
OPENCLAW_CONFIGS=()

[ -d "$HOME/.claude" ] && HAS_CLAUDE=true

for dir in "$HOME"/.openclaw*/; do
  if [ -d "$dir" ] && [ -f "${dir}openclaw.json" ]; then
    HAS_OPENCLAW=true
    OPENCLAW_CONFIGS+=("${dir}openclaw.json")
  fi
done

# JSON merge helper
merge_mcp_json() {
  local FILE="$1"

  if [ ! -f "$FILE" ]; then
    mkdir -p "$(dirname "$FILE")"
    cat > "$FILE" <<JSONEOF
{
  "mcpServers": {
    "gbrain": {
      "command": "bun",
      "args": ["run", "$CLI_TS_PATH", "serve"]
    }
  }
}
JSONEOF
    return
  fi

  cp "$FILE" "${FILE}.bak"

  if command -v jq &>/dev/null; then
    local TMP
    TMP=$(mktemp)
    jq --arg cli "$CLI_TS_PATH" '
      .mcpServers = (.mcpServers // {}) |
      .mcpServers.gbrain = {
        "command": "bun",
        "args": ["run", $cli, "serve"]
      }
    ' "$FILE" > "$TMP" && mv "$TMP" "$FILE"
  elif command -v python3 &>/dev/null; then
    python3 - "$FILE" "$CLI_TS_PATH" <<'PYEOF'
import json, sys
filepath, cli_path = sys.argv[1], sys.argv[2]
with open(filepath, 'r') as f:
    data = json.load(f)
if 'mcpServers' not in data:
    data['mcpServers'] = {}
data['mcpServers']['gbrain'] = {
    "command": "bun",
    "args": ["run", cli_path, "serve"]
}
with open(filepath, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF
  else
    echo "  ⚠ Cannot auto-configure (install jq or python3). See config/claude-code-setup.md"
    return 1
  fi
}

CONFIGURED=""

# Configure Claude Code if detected
if [ "$HAS_CLAUDE" = true ]; then
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  merge_mcp_json "$CLAUDE_SETTINGS" && CONFIGURED="${CONFIGURED}claude "
  echo "  ✓ Claude Code"
fi

# Configure OpenClaw if detected
if [ "$HAS_OPENCLAW" = true ]; then
  for config in "${OPENCLAW_CONFIGS[@]}"; do
    merge_mcp_json "$config" && CONFIGURED="${CONFIGURED}openclaw "
    echo "  ✓ OpenClaw ($(basename $(dirname $config)))"
  done
fi

# Add system prompt to CLAUDE.md
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if ! grep -q "ClipBrain MCP\|GBrain MCP" "$CLAUDE_MD" 2>/dev/null; then
  mkdir -p "$(dirname "$CLAUDE_MD")"
  cat >> "$CLAUDE_MD" <<'MDEOF'

## ClipBrain - Personal Knowledge Base

You have access to the user's personal knowledge base via ClipBrain MCP tools.

Key tools:
- `query` — Hybrid semantic + keyword search across saved articles, notes, and Kindle highlights
- `search` — Keyword-only search (faster, works when embeddings are missing)

Use these when the user asks about something they may have read, references "that article" or "that book", or when you want to ground your response in their prior reading.
MDEOF
  echo "  ✓ System prompt (CLAUDE.md)"
fi

if [ -z "$CONFIGURED" ]; then
  echo "  ⚠ No AI tools detected. Run ./setup-mcp.sh manually to configure."
fi

# ─── Step 5: Detect Obsidian ─────────────────────────────────────────────────
echo ""
echo "→ Checking for Obsidian..."

OBSIDIAN_VAULT=""
# Find .obsidian directories (indicating a vault)
for vault_dir in $(find "$HOME/Documents" "$HOME/Desktop" "$HOME" -maxdepth 4 -name ".obsidian" -type d 2>/dev/null | head -5); do
  OBSIDIAN_VAULT="$(dirname "$vault_dir")"
  break
done

if [ -n "$OBSIDIAN_VAULT" ]; then
  echo "  Found vault: $OBSIDIAN_VAULT"

  # Create ClipBrain folder in vault
  mkdir -p "$OBSIDIAN_VAULT/ClipBrain/kindle"
  mkdir -p "$OBSIDIAN_VAULT/ClipBrain/web"

  # Write config
  cat > "$SCRIPT_DIR/.clipbrain.json" <<JSONEOF
{
  "obsidian": {
    "enabled": true,
    "vaultPath": "$OBSIDIAN_VAULT",
    "folder": "ClipBrain"
  }
}
JSONEOF

  echo "  ✓ Obsidian sync enabled (captures → $OBSIDIAN_VAULT/ClipBrain/)"
else
  # No obsidian, write disabled config
  cat > "$SCRIPT_DIR/.clipbrain.json" <<JSONEOF
{
  "obsidian": {
    "enabled": false,
    "vaultPath": "",
    "folder": "ClipBrain"
  }
}
JSONEOF
  echo "  Obsidian not found (install it later and re-run setup)"
fi

# ─── Step 5b: Detect OpenAI API key for smart processing ────────────────────
echo ""
echo "→ Checking for AI processing..."

if [ -n "$OPENAI_API_KEY" ]; then
  echo "  ✓ Smart processing enabled (GPT-4o-mini)"
  # Update .clipbrain.json processing.enabled = true
  if command -v jq &>/dev/null; then
    TMP=$(mktemp)
    jq '.processing = {"enabled": true, "model": "gpt-4o-mini", "provider": "openai"}' "$SCRIPT_DIR/.clipbrain.json" > "$TMP" && mv "$TMP" "$SCRIPT_DIR/.clipbrain.json"
  elif command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$SCRIPT_DIR/.clipbrain.json', 'r') as f:
    data = json.load(f)
data['processing'] = {'enabled': True, 'model': 'gpt-4o-mini', 'provider': 'openai'}
with open('$SCRIPT_DIR/.clipbrain.json', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
  fi
else
  echo "  OPENAI_API_KEY not set — smart processing disabled"
  echo "  Set it to enable AI summaries, tags, and connections"
  # Update .clipbrain.json processing.enabled = false
  if command -v jq &>/dev/null; then
    TMP=$(mktemp)
    jq '.processing = {"enabled": false, "model": "gpt-4o-mini", "provider": "openai"}' "$SCRIPT_DIR/.clipbrain.json" > "$TMP" && mv "$TMP" "$SCRIPT_DIR/.clipbrain.json"
  elif command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$SCRIPT_DIR/.clipbrain.json', 'r') as f:
    data = json.load(f)
data['processing'] = {'enabled': False, 'model': 'gpt-4o-mini', 'provider': 'openai'}
with open('$SCRIPT_DIR/.clipbrain.json', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
  fi
fi

# ─── Step 6: Install auto-start (macOS) ──────────────────────────────────────
if [ "$(uname)" = "Darwin" ]; then
  echo ""
  echo "→ Installing background service..."

  # Update plist with correct paths
  PLIST_SRC="$SCRIPT_DIR/config/com.gbrain.serve.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.gbrain.serve.plist"
  BUN_PATH="$(which bun)"

  # Generate plist with current paths
  cat > "$PLIST_DST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.gbrain.serve</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_PATH</string>
        <string>run</string>
        <string>server.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname $BUN_PATH):/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/gbrain-capture.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/gbrain-capture.log</string>
</dict>
</plist>
PLISTEOF

  # Load the service (unload first if exists)
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST"
  echo "  ✓ Capture server (auto-starts on login)"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Setup complete!"
echo ""
echo "One last step — load the Chrome extension:"
echo "  1. Open chrome://extensions"
echo "  2. Turn on Developer mode (top right)"
echo "  3. Click 'Load unpacked' → select this folder"
echo ""
echo "The capture server is running in the background."
if [ -n "$CONFIGURED" ]; then
  echo "Your AI is already connected. Try asking:"
  echo '  "What did I highlight in my Kindle books?"'
fi
