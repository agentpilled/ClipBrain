# ClipBrain

Your AI doesn't know what you've read. ClipBrain fixes that.

Save web articles and Kindle highlights to a local knowledge base. When you talk to Claude or OpenClaw, they can search everything you've captured and reference it in conversation.

**"What did I highlight in Sapiens?"** Just works.

## Get started

You need [Bun](https://bun.sh) and Chrome. That's it.

```bash
git clone https://github.com/agentpilled/gbrain-capture
cd gbrain-capture
./setup.sh
```

This single command:
- Installs all dependencies
- Builds the gbrain knowledge engine
- Creates a local database (no cloud, everything stays on your machine)
- Auto-configures Claude Code and/or OpenClaw (auto-detects what you have)
- Installs a background service so the capture server runs automatically

After setup, load the Chrome extension:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → pick the `gbrain-capture` folder

Done. That's the whole setup.

## Capturing content

### Web articles

On any webpage, press **Cmd+Shift+S** (Mac) or **Ctrl+Shift+S** (Windows/Linux).

The page content is extracted, indexed, and stored locally. You'll see a brief notification confirming the capture.

### Kindle highlights

1. Go to [read.amazon.com/notebook](https://read.amazon.com/notebook)
2. A button appears: **Import to ClipBrain**
3. Choose **This book** (current) or **All books** (imports every book automatically)

The extension clicks through each book in your library, extracts all highlights and notes, and stores them with the book title and author.

### Browsing your brain

Click the ClipBrain extension icon in Chrome to:
- **Search** across everything you've captured
- See **recent captures**
- View **stats** (articles, books, highlights)

## Using with your AI

After setup, your AI already has access. Just talk naturally:

- *"What did I highlight in Awareness by Anthony de Mello?"*
- *"Find my notes about storytelling"*
- *"What books have I read about psychology?"*
- *"Summarize the highlights from The Bitcoin Standard"*

Your AI uses ClipBrain's search (semantic + keyword, hybrid) to find relevant content from your captures and uses it in the conversation.

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
                          │                    │
                          ▼                    ▼
                   ┌──────────────────────────────┐
                   │  gbrain (local database)      │
                   │  PGLite + pgvector            │
                   │  embeddings + hybrid search   │
                   └──────────────────────────────┘
```

1. **Capture**: Chrome extension extracts content (Readability.js for web, DOM parsing for Kindle)
2. **Index**: The gbrain engine chunks the text, generates embeddings (OpenAI), stores in a local Postgres database
3. **Search**: When your AI needs context, it calls ClipBrain's search tool via MCP (semantic + keyword hybrid)

Everything runs locally. No data leaves your machine except for generating embeddings (OpenAI API).

## Requirements

- [Bun](https://bun.sh) (JavaScript runtime)
- Chrome or Chromium
- `OPENAI_API_KEY` environment variable (for generating embeddings)

## Project structure

```
gbrain-capture/
├── setup.sh                 One-command setup
├── server.ts                HTTP capture server (Bun)
├── manifest.json            Chrome extension (Manifest V3)
├── service-worker.js        Background: captures, queue, badge
├── content-script.js        Web page extraction (Readability.js)
├── kindle-content-script.js Kindle Notebook extraction
├── popup.html/js/css        Extension popup UI
├── config/
│   ├── com.gbrain.serve.plist   macOS auto-start
│   └── claude-code-setup.md     Manual MCP setup guide
└── node_modules/gbrain/     gbrain engine (auto-installed)
```
