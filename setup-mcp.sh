#!/usr/bin/env bash
# setup-mcp.sh — Configure ClipBrain MCP for Claude Code and/or OpenClaw
set -euo pipefail

# ─── Resolve paths ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_TS_PATH="$SCRIPT_DIR/node_modules/gbrain/src/cli.ts"

if [ ! -f "$CLI_TS_PATH" ]; then
  echo "Error: Could not find gbrain CLI at $CLI_TS_PATH"
  echo "Run ./setup.sh first to install dependencies."
  exit 1
fi

# Verify bun is available
if ! command -v bun &>/dev/null; then
  echo "Error: bun is not installed. Install it from https://bun.sh"
  exit 1
fi

echo "ClipBrain MCP Setup"
echo "==================="
echo ""
echo "CLI path: $CLI_TS_PATH"
echo ""

# ─── Ask which tool to configure ──────────────────────────────────────────────
echo "Which AI tool do you want to configure?"
echo "  1) Claude Code (default)"
echo "  2) OpenClaw"
echo "  3) Both"
echo ""
read -rp "Choice [1]: " CHOICE
CHOICE="${CHOICE:-1}"

CONFIGURE_CLAUDE=false
CONFIGURE_OPENCLAW=false

case "$CHOICE" in
  1) CONFIGURE_CLAUDE=true ;;
  2) CONFIGURE_OPENCLAW=true ;;
  3) CONFIGURE_CLAUDE=true; CONFIGURE_OPENCLAW=true ;;
  *) echo "Invalid choice."; exit 1 ;;
esac

# ─── JSON merge helper ────────────────────────────────────────────────────────
# Merges the gbrain mcpServers entry into a JSON settings file.
# Usage: merge_mcp_json <file>
merge_mcp_json() {
  local FILE="$1"
  local MCP_ENTRY
  MCP_ENTRY=$(cat <<JSONEOF
{
  "command": "bun",
  "args": ["run", "$CLI_TS_PATH", "serve"]
}
JSONEOF
)

  if [ ! -f "$FILE" ]; then
    # Create new file with just the mcpServers section
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

  # Backup existing file
  cp "$FILE" "${FILE}.bak"

  if command -v jq &>/dev/null; then
    # Use jq for reliable JSON merging
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
    # Fallback to python3
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
    echo "Warning: Neither jq nor python3 found. Cannot merge JSON automatically."
    echo "Please manually add the following to $FILE under \"mcpServers\":"
    echo ""
    echo "  \"gbrain\": {"
    echo "    \"command\": \"bun\","
    echo "    \"args\": [\"run\", \"$CLI_TS_PATH\", \"serve\"]"
    echo "  }"
    echo ""
    return 1
  fi
}

# ─── Configure Claude Code ────────────────────────────────────────────────────
CLAUDE_DONE=false
if [ "$CONFIGURE_CLAUDE" = true ]; then
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  echo ""
  echo "Configuring Claude Code..."

  merge_mcp_json "$CLAUDE_SETTINGS"
  echo "Claude Code configured. Restart Claude Code to activate."
  CLAUDE_DONE=true
fi

# ─── Configure OpenClaw ──────────────────────────────────────────────────────
OPENCLAW_DONE=false
if [ "$CONFIGURE_OPENCLAW" = true ]; then
  echo ""
  echo "Configuring OpenClaw..."

  # Find openclaw config directories
  OPENCLAW_CONFIGS=()
  for dir in "$HOME"/.openclaw*/; do
    if [ -d "$dir" ]; then
      OPENCLAW_CONFIGS+=("${dir}openclaw.json")
    fi
  done

  if [ ${#OPENCLAW_CONFIGS[@]} -eq 0 ]; then
    # Default path
    OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
    echo "No existing OpenClaw config found. Creating $OPENCLAW_CONFIG"
    mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
    merge_mcp_json "$OPENCLAW_CONFIG"
    echo "OpenClaw configured."
    OPENCLAW_DONE=true
  elif [ ${#OPENCLAW_CONFIGS[@]} -eq 1 ]; then
    merge_mcp_json "${OPENCLAW_CONFIGS[0]}"
    echo "OpenClaw configured."
    OPENCLAW_DONE=true
  else
    echo "Multiple OpenClaw configs found:"
    for i in "${!OPENCLAW_CONFIGS[@]}"; do
      echo "  $((i+1))) ${OPENCLAW_CONFIGS[$i]}"
    done
    read -rp "Which one? [1]: " OC_CHOICE
    OC_CHOICE="${OC_CHOICE:-1}"
    OC_INDEX=$((OC_CHOICE - 1))
    if [ "$OC_INDEX" -ge 0 ] && [ "$OC_INDEX" -lt ${#OPENCLAW_CONFIGS[@]} ]; then
      merge_mcp_json "${OPENCLAW_CONFIGS[$OC_INDEX]}"
      echo "OpenClaw configured."
      OPENCLAW_DONE=true
    else
      echo "Invalid choice. Skipping OpenClaw."
    fi
  fi
fi

# ─── Add system prompt to CLAUDE.md ──────────────────────────────────────────
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
CLAUDE_MD_DONE=false

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
  echo "System prompt added to $CLAUDE_MD"
  CLAUDE_MD_DONE=true
else
  echo "System prompt already present in $CLAUDE_MD"
  CLAUDE_MD_DONE=true
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────"
if [ "$CLAUDE_DONE" = true ]; then
  echo "✓ MCP configured for Claude Code"
fi
if [ "$OPENCLAW_DONE" = true ]; then
  echo "✓ MCP configured for OpenClaw"
fi
if [ "$CLAUDE_MD_DONE" = true ]; then
  echo "✓ System prompt added to ~/.claude/CLAUDE.md"
fi
echo ""
echo "Restart Claude Code, then try:"
echo "  \"What did I highlight in Awareness: Conversations with the Masters?\""
