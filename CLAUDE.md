# ClipBrain — Chrome Extension + HTTP Server

## What it does

A Chrome extension (Manifest V3) that captures web page content and sends it to a local HTTP server, which stores it in a ClipBrain knowledge base via the `gbrain` CLI.

This project is self-contained: gbrain is pulled as a git dependency and built locally by `./setup.sh`. No global install required.

## Architecture

### Chrome Extension

MV3 service workers do NOT have DOM access, so the work is split:

- **content-script.js** — Injected into the active tab on demand. Has DOM access. Runs Mozilla's Readability.js to extract the article text from the page. Sends the extracted data back to the service worker via `chrome.runtime.sendMessage`.
- **kindle-content-script.js** — Auto-injected on `read.amazon.com/notebook*`. Parses Kindle highlights/notes from the Notebook page and sends them to the service worker as `kindle-import` messages. Shows a floating "Import to ClipBrain" button in the bottom-right corner.
- **service-worker.js** — Background service worker. Listens for the `capture-page` keyboard command, injects the content script, receives extracted content (types `captured` and `kindle-import`), and POSTs it to the local HTTP server. Manages an offline queue in `chrome.storage.local` and flushes it via `chrome.alarms`.
- **toast.js** — Injected into the page to show a brief success/failure notification.
- **lib/readability.js** — Vendored copy of Mozilla Readability.js (from `@mozilla/readability` npm package).

### HTTP Server (server.ts)

A standalone Bun HTTP server that:

- Listens on port 19285 (configurable via `--port` or `GBRAIN_CAPTURE_PORT` env)
- Receives POST /api/capture with `{ url, title, content, selection? }`
- Canonicalizes the URL, generates a slug, builds markdown with frontmatter
- Handles `kindle://` URLs specially: generates slugs as `kindle/{author}/{title}` from the title field
- Calls `gbrain put <slug>` via CLI (content piped via stdin)
- Returns 202 immediately (fire-and-forget)
- Handles CORS for chrome-extension:// origins

The server resolves the gbrain binary in this order: `GBRAIN_BIN` env var, `./bin/gbrain` (local build from setup.sh), then `gbrain` on PATH (global fallback).

## Setup

```bash
./setup.sh        # installs deps, builds gbrain, initializes database
bun run serve     # starts the capture server
```

## Testing

```bash
bun test
```

## Key shortcuts

- **Mac**: Cmd+Shift+S
- **Windows/Linux**: Ctrl+Shift+S
