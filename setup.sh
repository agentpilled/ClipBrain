#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🧠 Setting up ClipBrain..."
echo ""

# ─── Step 0: Check for bun ──────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "  ✗ Bun is required but not installed."
  echo ""
  echo "  Install it with:"
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo ""
  echo "  Then re-run: ./setup.sh"
  exit 1
fi
BUN_PATH="$(command -v bun)"

# ─── Step 1: Install dependencies ────────────────────────────────────────────
echo "→ Installing dependencies..."
bun install

# ─── Step 2: Ensure gbrain CLI ────────────────────────────────────────────────
echo "→ Checking gbrain CLI..."
if ! command -v gbrain &>/dev/null; then
  echo "  → Installing gbrain CLI..."
  bun install --global github:garrytan/gbrain
fi

if ! command -v gbrain &>/dev/null; then
  echo "  ✗ Could not find gbrain after installation."
  echo "    Make sure Bun's global bin directory is on PATH, then re-run ./setup.sh"
  exit 1
fi

GBRAIN_PATH="$(command -v gbrain)"
GBRAIN_VERSION="$("$GBRAIN_PATH" version 2>/dev/null || "$GBRAIN_PATH" --version 2>/dev/null || true)"
if [ -n "$GBRAIN_VERSION" ]; then
  echo "  ✓ gbrain CLI ($GBRAIN_VERSION)"
else
  echo "  ✓ gbrain CLI ($GBRAIN_PATH)"
fi

# ─── Step 3: Initialize gbrain database ──────────────────────────────────────
# gbrain init requires an embedding provider (or --no-embedding) or it prints
# guidance and exits 0 WITHOUT creating a brain. Detect the best available
# provider and always fall back to a functional keyword-only brain, so setup
# can never silently leave a new user with no brain.
SEMANTIC_ENABLED=true
if [ ! -f ~/.gbrain/config.json ]; then
  echo "→ Initializing ClipBrain database..."

  EMBED_FLAG="--no-embedding"
  EMBED_DESC="keyword-only (no semantic search yet)"
  if [ -n "$OPENAI_API_KEY" ]; then
    EMBED_FLAG="--embedding-model openai:text-embedding-3-large"
    EMBED_DESC="OpenAI embeddings"
  elif curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    EMBED_FLAG="--embedding-model ollama:nomic-embed-text"
    EMBED_DESC="local Ollama embeddings (nomic-embed-text)"
  fi
  echo "  → Embeddings: $EMBED_DESC"

  "$GBRAIN_PATH" init --pglite $EMBED_FLAG || true

  # init can exit 0 without creating a brain — verify before claiming success.
  if [ ! -f ~/.gbrain/config.json ]; then
    echo "  ✗ Brain was not created — gbrain init did not complete."
    echo "    Retry with an embedding provider:"
    echo "      export OPENAI_API_KEY=sk-...   &&  ./setup.sh"
    echo "    or create a keyword-only brain now:"
    echo "      gbrain init --pglite --no-embedding   &&  ./setup.sh"
    exit 1
  fi
  [ "$EMBED_FLAG" = "--no-embedding" ] && SEMANTIC_ENABLED=false
else
  echo "→ ClipBrain already initialized ✓"
  grep -q '"embedding_model"' ~/.gbrain/config.json 2>/dev/null || SEMANTIC_ENABLED=false
fi

# ─── Step 4: Configure MCP for your AI ───────────────────────────────────────
echo ""
echo "→ Configuring AI connection..."

MCP_COMMAND="$GBRAIN_PATH"
MCP_ARGS_JSON="[\"serve\"]"
CLIPBRAIN_MCP_COMMAND="$BUN_PATH"
CLIPBRAIN_MCP_ARGS_JSON="[\"$SCRIPT_DIR/clipbrain-mcp.ts\"]"
CLIPBRAIN_MCP_BASE_URL="${CLIPBRAIN_SERVER_URL:-http://127.0.0.1:19285}"

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
      "command": "$MCP_COMMAND",
      "args": $MCP_ARGS_JSON
    },
    "clipbrain": {
      "command": "$CLIPBRAIN_MCP_COMMAND",
      "args": $CLIPBRAIN_MCP_ARGS_JSON,
      "env": {
        "CLIPBRAIN_SERVER_URL": "$CLIPBRAIN_MCP_BASE_URL"
      }
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
    jq \
      --arg gbrain_command "$MCP_COMMAND" \
      --argjson gbrain_args "$MCP_ARGS_JSON" \
      --arg clipbrain_command "$CLIPBRAIN_MCP_COMMAND" \
      --argjson clipbrain_args "$CLIPBRAIN_MCP_ARGS_JSON" \
      --arg clipbrain_base_url "$CLIPBRAIN_MCP_BASE_URL" '
      .mcpServers = (.mcpServers // {}) |
      .mcpServers.gbrain = {
        "command": $gbrain_command,
        "args": $gbrain_args
      } |
      .mcpServers.clipbrain = {
        "command": $clipbrain_command,
        "args": $clipbrain_args,
        "env": {
          "CLIPBRAIN_SERVER_URL": $clipbrain_base_url
        }
      }
    ' "$FILE" > "$TMP" && mv "$TMP" "$FILE"
  elif command -v python3 &>/dev/null; then
    python3 - "$FILE" "$MCP_COMMAND" "$MCP_ARGS_JSON" "$CLIPBRAIN_MCP_COMMAND" "$CLIPBRAIN_MCP_ARGS_JSON" "$CLIPBRAIN_MCP_BASE_URL" <<'PYEOF'
import json, sys
filepath, gbrain_command, gbrain_args_json, clipbrain_command, clipbrain_args_json, clipbrain_base_url = sys.argv[1:7]
with open(filepath, 'r') as f:
    data = json.load(f)
if 'mcpServers' not in data:
    data['mcpServers'] = {}
data['mcpServers']['gbrain'] = {
    "command": gbrain_command,
    "args": json.loads(gbrain_args_json)
}
data['mcpServers']['clipbrain'] = {
    "command": clipbrain_command,
    "args": json.loads(clipbrain_args_json),
    "env": {
        "CLIPBRAIN_SERVER_URL": clipbrain_base_url
    }
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
- `context_pack` — Compact, cited handoff for agents with `[S#]` sources, snippets, summaries, claims, quotes, entities, questions, and actions

Use these when the user asks about something they may have read, references "that article" or "that book", or when you want to ground your response in their prior reading.
MDEOF
  echo "  ✓ System prompt (CLAUDE.md)"
elif ! grep -q "context_pack" "$CLAUDE_MD" 2>/dev/null; then
  cat >> "$CLAUDE_MD" <<'MDEOF'

Additional ClipBrain MCP tool:
- `context_pack` — Compact, cited handoff for agents with `[S#]` sources, snippets, summaries, claims, quotes, entities, questions, and actions
MDEOF
  echo "  ✓ System prompt updated (context_pack)"
fi

if [ -z "$CONFIGURED" ]; then
  echo "  ⚠ No AI tools detected. Install Claude Code or OpenClaw and re-run ./setup.sh"
fi

# ─── Step 4b: Install yt-dlp for YouTube support ────────────────────────────
echo ""
echo "→ Checking for yt-dlp..."
if ! command -v yt-dlp &>/dev/null; then
  echo "  → Installing yt-dlp (for YouTube transcripts)..."
  if command -v brew &>/dev/null; then
    brew install yt-dlp 2>/dev/null || echo "  ⚠ Could not install yt-dlp. YouTube capture won't work."
  else
    echo "  ⚠ yt-dlp not found. Install with: brew install yt-dlp (YouTube capture won't work without it)"
  fi
else
  echo "  ✓ yt-dlp"
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

  PLIST_DST="$HOME/Library/LaunchAgents/com.clipbrain.serve.plist"
  LEGACY_PLIST_DST="$HOME/Library/LaunchAgents/com.gbrain.serve.plist"
  # Generate plist with current paths
  BUN_DIR="$(dirname "$BUN_PATH")"
  OPENAI_ENV_BLOCK=""
  if [ -n "$OPENAI_API_KEY" ]; then
    OPENAI_ENV_BLOCK="
        <key>OPENAI_API_KEY</key>
        <string>$OPENAI_API_KEY</string>"
  fi

  cat > "$PLIST_DST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clipbrain.serve</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_PATH</string>
        <string>run</string>
        <string>server.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$BUN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>$OPENAI_ENV_BLOCK
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/clipbrain.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/clipbrain.log</string>
</dict>
</plist>
PLISTEOF

  # Load the service (unload first if exists)
  launchctl unload "$LEGACY_PLIST_DST" 2>/dev/null || true
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST"

  echo "→ Waiting for server to start..."
  for i in $(seq 1 15); do
    if curl -s --max-time 2 http://127.0.0.1:19285/health > /dev/null 2>&1; then
      echo "  ✓ Server running"
      break
    fi
    if [ $i -eq 15 ]; then
      echo "  ⚠ Server didn't start within 15 seconds. Check ~/Library/Logs/clipbrain.log"
    fi
    sleep 1
  done
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "✅ ClipBrain is ready!"
echo ""
echo "  ✓ Dependencies installed"
echo "  ✓ gbrain CLI ready"
echo "  ✓ Database initialized"
if [ "$(uname)" = "Darwin" ]; then
  echo "  ✓ Server running (auto-starts on login)"
fi
if echo "$CONFIGURED" | grep -q "claude"; then
  echo "  ✓ Claude Code connected"
fi
if echo "$CONFIGURED" | grep -q "openclaw"; then
  for config in "${OPENCLAW_CONFIGS[@]}"; do
    OPENCLAW_DIR_NAME=$(basename "$(dirname "$config")" | sed 's/^\.//')
    echo "  ✓ OpenClaw connected ($OPENCLAW_DIR_NAME)"
  done
fi
if [ -n "$OBSIDIAN_VAULT" ]; then
  SHORT_VAULT=$(echo "$OBSIDIAN_VAULT" | sed "s|^$HOME|~|")
  echo "  ✓ Obsidian: $SHORT_VAULT/ClipBrain"
fi
if [ -n "$OPENAI_API_KEY" ]; then
  echo "  ✓ Smart processing (GPT-4o-mini)"
else
  echo "  ○ Smart processing disabled (set OPENAI_API_KEY to enable)"
fi
if [ "$SEMANTIC_ENABLED" = false ]; then
  echo "  ○ Semantic search OFF — keyword + title search only."
  echo "    Enable: set OPENAI_API_KEY (or run Ollama), then:"
  echo "    gbrain config set embedding_model openai:text-embedding-3-large && gbrain embed --all"
else
  echo "  ✓ Semantic search enabled"
fi
if command -v yt-dlp &>/dev/null; then
  echo "  ✓ YouTube transcripts (yt-dlp)"
else
  echo "  ○ YouTube transcripts disabled (install yt-dlp to enable)"
fi
echo ""
echo "  Load the Chrome extension:"
echo "    chrome://extensions → Developer mode → Load unpacked → this folder"
echo ""
echo "  Then:"
echo "    • Cmd+Shift+S on any page to capture"
echo "    • read.amazon.com/notebook to import Kindle highlights"
echo "    • Drag PDFs onto http://127.0.0.1:19285"
echo "    • Cmd+Shift+S on YouTube videos for transcripts"
echo "    • http://127.0.0.1:19285 to browse your brain"

# Open Chrome extensions page for easy loading
if [ "$(uname)" = "Darwin" ]; then
  echo ""
  echo "Opening Chrome extensions page..."
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true

  # Also reveal the folder in Finder for drag & drop
  open -R "$SCRIPT_DIR" 2>/dev/null || true
fi
