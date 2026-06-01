# Connecting ClipBrain with your AI

ClipBrain exposes your captured knowledge via MCP (Model Context Protocol). Any AI tool that supports MCP can search what you've saved and request compact cited context packs.

---

## Claude Code

Add to your MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    },
    "clipbrain": {
      "command": "bun",
      "args": ["/path/to/clipbrain/clipbrain-mcp.ts"],
      "env": {
        "CLIPBRAIN_SERVER_URL": "http://127.0.0.1:19285"
      }
    }
  }
}
```

Replace `/path/to/clipbrain` with where you cloned the repo. `gbrain` keeps the full knowledge engine tools; `clipbrain` adds the `context_pack` handoff tool.

Restart Claude Code. You should see ClipBrain tools in your tool list.

---

## OpenClaw

OpenClaw supports MCP via direct MCP config or its plugin system. Direct config is recommended because the ClipBrain MCP server needs the local repo path.

### Option A: Direct MCP config (recommended)

If your OpenClaw version supports `mcpServers` in config, add:

```json
{
  "mcpServers": {
    "gbrain": { "command": "gbrain", "args": ["serve"] },
    "clipbrain": {
      "command": "bun",
      "args": ["/path/to/clipbrain/clipbrain-mcp.ts"],
      "env": { "CLIPBRAIN_SERVER_URL": "http://127.0.0.1:19285" }
    }
  }
}
```

### Option B: Plugin manifest

Copy the plugin manifest into your OpenClaw extensions:

```bash
mkdir -p ~/.openclaw/extensions/gbrain-capture
cp /path/to/gbrain-capture/config/openclaw-plugin.json ~/.openclaw/extensions/gbrain-capture/plugin.json
```

Then add to your `openclaw.json` plugins section:

```json
{
  "plugins": {
    "allow": ["gbrain-capture"],
    "load": {
      "paths": ["~/.openclaw/extensions/gbrain-capture"]
    }
  }
}
```

The static plugin manifest keeps the broad `gbrain` tools portable. To expose `context_pack`, also add the `clipbrain` MCP server from Option A.

---

## Claude Desktop

Open Settings > Developer > Edit Config. Add to `mcpServers`:

```json
{
  "mcpServers": {
    "gbrain": { "command": "gbrain", "args": ["serve"] },
    "clipbrain": {
      "command": "bun",
      "args": ["/path/to/clipbrain/clipbrain-mcp.ts"],
      "env": { "CLIPBRAIN_SERVER_URL": "http://127.0.0.1:19285" }
    }
  }
}
```

Restart Claude Desktop.

---

## Cursor

Open Settings > MCP. Add a new server:

- Name: `gbrain`
- Command: `gbrain serve`
- Name: `clipbrain`
- Command: `bun /path/to/clipbrain/clipbrain-mcp.ts`

---

## Any MCP client

The MCP server commands are:

```
gbrain serve
bun /path/to/clipbrain/clipbrain-mcp.ts
```

They communicate via stdio. Connect them like any other MCP servers.

---

## System prompt (recommended for all clients)

Add this to your CLAUDE.md, system prompt, or equivalent config:

```
You have access to the user's personal knowledge base via the ClipBrain MCP tools.

Key tools:
- `query` — Hybrid semantic + keyword search across saved articles, notes, and highlights
- `search` — Keyword-only search (faster, works even when embeddings are missing)
- `context_pack` — Compact, cited handoff for agents with `[S#]` sources, snippets, summaries, claims, quotes, entities, questions, and actions

Use these tools when:
- The user asks about a topic they may have read about before
- The user references "that article" or "something I read"
- You want to ground your response in the user's prior reading
- The user asks you to recall or find something they saved

Do not use them for general knowledge questions the user hasn't likely saved content about.
```
