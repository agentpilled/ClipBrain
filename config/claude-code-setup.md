# Connecting ClipBrain with your AI

ClipBrain exposes your captured knowledge via MCP (Model Context Protocol). Any AI tool that supports MCP can search what you've saved.

---

## Claude Code

Add to your MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "/path/to/gbrain-capture/bin/gbrain",
      "args": ["serve"]
    }
  }
}
```

Replace `/path/to/gbrain-capture` with where you cloned the repo.

Restart Claude Code. You should see ClipBrain tools in your tool list.

---

## OpenClaw

OpenClaw supports MCP via its plugin system. Two options:

### Option A: Plugin manifest (recommended)

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

### Option B: Direct MCP config

If your OpenClaw version supports `mcpServers` in config, add:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "/path/to/gbrain-capture/bin/gbrain",
      "args": ["serve"]
    }
  }
}
```

---

## Claude Desktop

Open Settings > Developer > Edit Config. Add to `mcpServers`:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "/path/to/gbrain-capture/bin/gbrain",
      "args": ["serve"]
    }
  }
}
```

Restart Claude Desktop.

---

## Cursor

Open Settings > MCP. Add a new server:

- Name: `gbrain`
- Command: `/path/to/gbrain-capture/bin/gbrain serve`

---

## Any MCP client

The MCP server command is:

```
/path/to/gbrain-capture/bin/gbrain serve
```

It communicates via stdio. Connect it like any other MCP server.

---

## System prompt (recommended for all clients)

Add this to your CLAUDE.md, system prompt, or equivalent config:

```
You have access to the user's personal knowledge base via the ClipBrain MCP tools.

Key tools:
- `query` — Hybrid semantic + keyword search across saved articles, notes, and highlights
- `search` — Keyword-only search (faster, works even when embeddings are missing)

Use these tools when:
- The user asks about a topic they may have read about before
- The user references "that article" or "something I read"
- You want to ground your response in the user's prior reading
- The user asks you to recall or find something they saved

Do not use them for general knowledge questions the user hasn't likely saved content about.
```
