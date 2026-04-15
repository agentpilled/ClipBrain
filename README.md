# ClipBrain

Your AI doesn't know what you've read. ClipBrain fixes that.

Save web articles and Kindle highlights to a local knowledge base. When you talk to Claude or OpenClaw, they can search everything you've captured and reference it in conversation.

**"What did I highlight in Sapiens?"** Just works.

## Get started

You need [Bun](https://bun.sh) and Chrome.

```bash
git clone https://github.com/agentpilled/gbrain-capture
cd gbrain-capture
./setup.sh
```

This single command:
- Installs all dependencies
- Builds the knowledge engine
- Creates a local database (everything stays on your machine)
- Auto-configures Claude Code and/or OpenClaw
- Connects to Obsidian (if installed)
- Installs a background service so the server runs automatically

Then load the Chrome extension:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → pick the `gbrain-capture` folder

Done.

## Capturing content

### Web articles

Press **Cmd+Shift+S** (Mac) or **Ctrl+Shift+S** (Windows/Linux) on any page.

Or click the ClipBrain extension icon → **Capture this page**.

### Kindle highlights

1. Go to [read.amazon.com/notebook](https://read.amazon.com/notebook)
2. Click **Import to ClipBrain** (bottom right)
3. Choose **This book** or **All books**

The extension clicks through each book in your library, extracts all highlights and notes, and imports them.

### PDFs

Drag any PDF onto the [dashboard](http://localhost:19285) to import it. Or click the upload button.

The text is extracted, indexed, and searchable by your AI.

## Dashboard

Open **http://localhost:19285** to browse your knowledge base:

- Search across all captures
- Filter by books or articles
- Expand any book to see all highlights and notes
- View stats

The extension popup also has a link: **Full dashboard**.

## Obsidian sync

If you use Obsidian, ClipBrain syncs your captures as markdown files to your vault.

**Auto-detected during setup**: if Obsidian is installed, `setup.sh` finds your vault and enables sync automatically. A `ClipBrain/` folder appears in your vault with all captures.

**Manual setup**: if you install Obsidian later, open the dashboard (localhost:19285) and click **Connect Obsidian** in the bottom bar. Enter your vault path and it syncs everything.

Your captures appear in Obsidian as clean markdown with frontmatter, organized in `ClipBrain/kindle/` and `ClipBrain/web/`.

## Using with your AI

After setup, your AI already has access. Just talk naturally:

- *"What did I highlight in Awareness by Anthony de Mello?"*
- *"Find my notes about storytelling"*
- *"What books have I read about psychology?"*
- *"Summarize the highlights from The Bitcoin Standard"*

Works with **Claude Code**, **OpenClaw**, **Claude Desktop**, and any MCP-compatible tool.

## How it works

```
  You browse & read                        You ask your AI
        │                                        │
  Cmd+Shift+S or                          "What did I read
  Kindle import                            about X?"
        │                                        │
        ▼                                        ▼
  ┌───────────┐    ┌──────────────┐    ┌──────────────┐
  │  Chrome    │───▶│  Capture     │    │  MCP Server  │
  │  Extension │    │  Server      │    │  (auto)      │
  └───────────┘    │  (auto)      │    └──────┬───────┘
                   └──────┬───────┘           │
                          │ also writes .md    │
                          ▼                    ▼
                   ┌──────────────────────────────┐
                   │  Local database (pgvector)    │
                   │  + Obsidian vault (optional)  │
                   └──────────────────────────────┘
```

1. **Capture**: Chrome extension extracts content (Readability.js for web, DOM parsing for Kindle)
2. **Index**: Chunks the text, generates embeddings (OpenAI), stores in a local Postgres database
3. **Sync**: Writes markdown to your Obsidian vault (if connected)
4. **Search**: Your AI calls ClipBrain's search via MCP (semantic + keyword hybrid)

Everything runs locally. No data leaves your machine except for generating embeddings (OpenAI API).

## Requirements

- [Bun](https://bun.sh)
- Chrome or Chromium
- `OPENAI_API_KEY` environment variable (optional — enables AI summaries, tags, and connections)
- Obsidian (optional, for vault sync)
