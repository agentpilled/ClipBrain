#!/usr/bin/env bash
# setup-mcp.sh — Configure ClipBrain MCP for Claude Code and/or OpenClaw
set -euo pipefail

# ─── Resolve paths ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v bun &>/dev/null; then
  echo "Error: bun is not installed. Install it from https://bun.sh"
  exit 1
fi
BUN_PATH="$(command -v bun)"

if ! command -v gbrain &>/dev/null; then
  echo "gbrain CLI not found; installing it now..."
  bun install --global github:garrytan/gbrain
fi

if ! command -v gbrain &>/dev/null; then
  echo "Error: Could not find gbrain after installation."
  echo "Make sure Bun's global bin directory is on PATH, then re-run ./setup-mcp.sh"
  exit 1
fi

GBRAIN_PATH="$(command -v gbrain)"
MCP_COMMAND="$GBRAIN_PATH"
MCP_ARGS_JSON="[\"serve\"]"
CLIPBRAIN_MCP_COMMAND="$BUN_PATH"
CLIPBRAIN_MCP_ARGS_JSON="[\"$SCRIPT_DIR/clipbrain-mcp.ts\"]"
CLIPBRAIN_MCP_BASE_URL="${CLIPBRAIN_SERVER_URL:-http://127.0.0.1:19285}"

echo "ClipBrain MCP Setup"
echo "==================="
echo ""
echo "GBrain MCP command: $MCP_COMMAND $MCP_ARGS_JSON"
echo "ClipBrain MCP command: $CLIPBRAIN_MCP_COMMAND $CLIPBRAIN_MCP_ARGS_JSON"
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
# Merges the gbrain and clipbrain mcpServers entries into a JSON settings file.
# Usage: merge_mcp_json <file>
merge_mcp_json() {
  local FILE="$1"
  if [ ! -f "$FILE" ]; then
    # Create new file with just the mcpServers section
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

  # Backup existing file
  cp "$FILE" "${FILE}.bak"

  if command -v jq &>/dev/null; then
    # Use jq for reliable JSON merging
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
    # Fallback to python3
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
    echo "Warning: Neither jq nor python3 found. Cannot merge JSON automatically."
    echo "Please manually add the following to $FILE under \"mcpServers\":"
    echo ""
    echo "  \"gbrain\": {"
    echo "    \"command\": \"$MCP_COMMAND\","
    echo "    \"args\": $MCP_ARGS_JSON"
    echo "  },"
    echo "  \"clipbrain\": {"
    echo "    \"command\": \"$CLIPBRAIN_MCP_COMMAND\","
    echo "    \"args\": $CLIPBRAIN_MCP_ARGS_JSON,"
    echo "    \"env\": { \"CLIPBRAIN_SERVER_URL\": \"$CLIPBRAIN_MCP_BASE_URL\" }"
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
- `context_pack` — Compact, cited handoff for agents with `[S#]` sources, snippets, summaries, claims, quotes, entities, questions, and actions

Use these when the user asks about something they may have read, references "that article" or "that book", or when you want to ground your response in their prior reading.
MDEOF
  echo "System prompt added to $CLAUDE_MD"
  CLAUDE_MD_DONE=true
elif ! grep -q "context_pack" "$CLAUDE_MD" 2>/dev/null; then
  cat >> "$CLAUDE_MD" <<'MDEOF'

Additional ClipBrain MCP tool:
- `context_pack` — Compact, cited handoff for agents with `[S#]` sources, snippets, summaries, claims, quotes, entities, questions, and actions
MDEOF
  echo "System prompt updated in $CLAUDE_MD"
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
