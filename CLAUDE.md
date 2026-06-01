# ClipBrain — Chrome Extension + HTTP Server

## What it does

A Chrome extension (Manifest V3) that captures web page content and sends it to a local HTTP server, which stores it in a ClipBrain knowledge base via the `gbrain` CLI.

This project uses the installed `gbrain` CLI. `./setup.sh` installs it globally with Bun if it is missing.

## Architecture

### Chrome Extension

MV3 service workers do NOT have DOM access, so the work is split:

- **content-script.js** — Injected into the active tab on demand. Has DOM access. On YouTube video pages, extracts the video ID, title, channel name, and **transcript** (from the page's inline `captionTracks` data, fetched same-origin so YouTube cookies are included). Falls back to reading the transcript panel DOM if the script extraction fails. Sends a `youtube-capture` message with the transcript segments already extracted. On all other pages, runs Mozilla's Readability.js to extract the article text. Sends the extracted data back to the service worker via `chrome.runtime.sendMessage`.
- **kindle-content-script.js** — Auto-injected on `read.amazon.com/notebook*`. Parses Kindle highlights/notes from the Notebook page and sends them to the service worker as `kindle-import` messages. Shows a floating "Import to ClipBrain" button in the bottom-right corner.
- **gmail-content-script.js** — Injected into Gmail after the user grants the optional `mail.google.com` permission from the popup. Detects open emails, extracts subject, sender, date, and clean body text (stripping Gmail UI chrome, signatures, tracking pixels). Shows a floating "Clip to ClipBrain" button when an email is open. Supports both button click and Cmd+Shift+S. Sends `gmail-capture` messages to the service worker. Handles threaded conversations (joins all messages). Uses `gmail://` URL scheme for dedup. Slugs stored as `email/{from-slug}/{subject-slug}`.
- **service-worker.js** — Background service worker. Listens for the `capture-page` keyboard command, injects the content script, receives extracted content (types `captured`, `kindle-import`, and `youtube-capture`), and POSTs it to the local HTTP server. YouTube captures go to `/api/capture-youtube`. Manages an offline queue in `chrome.storage.local` and flushes it via `chrome.alarms`.
- **toast.js** — Injected into the page to show a brief success/failure notification.
- **lib/readability.js** — Vendored copy of Mozilla Readability.js (from `@mozilla/readability` npm package).

### HTTP Server (server.ts)

A standalone Bun HTTP server that:

- Listens on port 19285 (configurable via `--port` or `GBRAIN_CAPTURE_PORT` env)
- Receives POST /api/capture with `{ url, title, content, selection? }`
- Receives POST /api/capture-youtube with `{ url, videoId, title, channel, transcript }` — transcript segments are extracted client-side by the content script (same-origin fetch with YouTube cookies); the server formats them with timestamps and saves as `youtube/{channel-slug}/{title-slug}`
- Canonicalizes the URL, generates a slug, builds markdown with frontmatter
- Handles `kindle://` URLs specially: generates slugs as `kindle/{author}/{title}` from the title field
- Handles `gmail://` URLs: generates slugs as `email/{from-slug}/{subject-slug}`
- Calls `gbrain put <slug>` via CLI (content piped via stdin)
- Returns 202 immediately (fire-and-forget)
- Handles CORS for chrome-extension:// origins
- Appends every capture to `.captures.jsonl` (append-only, gitignored) and exposes `GET /api/digest?since=ISO|days=N` — returns captures since a date grouped by type (kindle/web/youtube/email/pdf) plus a Slack-friendly markdown summary. Kindle entries include `newHighlights` (delta vs previous capture).
- Exposes `GET /api/context-pack?q=...&limit=...` — returns structured sources plus agent-ready markdown with `[S#]` citations, retrieval snippets, summaries, claims, quotes, entities, open questions, and actions.

The server resolves the gbrain binary in this order: `GBRAIN_BIN` env var, then `gbrain` on `PATH`.

### MCP Bridge (clipbrain-mcp.ts)

ClipBrain registers a small MCP server alongside `gbrain serve`:

- `gbrain` MCP keeps the broad knowledge-engine tools (`query`, `search`, `get_page`, graph tools, etc.)
- `clipbrain` MCP exposes `context_pack`, which calls the local HTTP server and returns the same cited handoff used by `/api/context-pack`

The ClipBrain MCP server is local-only by default and reads `CLIPBRAIN_SERVER_URL` from the host environment, falling back to `http://127.0.0.1:19285`.

### Post-Processing (post-process.ts)

After each capture, if `OPENAI_API_KEY` is set, the server runs AI post-processing in the background:
- Generates a 2-3 sentence summary
- Creates 3-5 semantic tags
- Finds connections to existing content in the knowledge base
- Extracts knowledge atoms: claims, quotes, entities, open questions, and actions
- Enriches the markdown with `## Summary`, `## Why It Matters`, `## Knowledge Atoms`, and `## Related` sections
- If `gbrain put` rejects an enriched page because the embedding context is too
  large, stores the parent as a compact Knowledge Compiler page and writes the
  raw source into searchable `clipbrain-source/.../chunk-NNN` pages
- Re-syncs to Obsidian with wikilinks

Post-processing is fire-and-forget: failures never affect the capture flow. If `OPENAI_API_KEY` is not set, everything works without it.

### Knowledge Backfill (backfill.ts)

Older captures can be upgraded into the current Knowledge Compiler format with:

```bash
bun run backfill --limit 20          # dry run
bun run backfill --apply --limit 5   # writes enriched pages
```

The backfill targets ClipBrain slugs (`kindle/`, `web/`, `pdf/`, `youtube/`, `email/`) whose `compiler_version` is missing or outdated. Use `--force` only when intentionally refreshing already-current pages.

Use `bun run corpus` for a read-only corpus quality report. It flags likely
test captures, Kindle import artifacts, truncated titles, duplicate title
groups, and pages still pending backfill.
`cleanup-apply --action merge_duplicate` dry-runs duplicate deletes with a
quoted/highlight evidence safety check. `--execute` still requires exact
approval tokens and blocks merge deletes whose evidence is not verified.

Shared corpus listing should go through `gbrain-list.ts`. It broadens `gbrain
list` scans across type/sort combinations and deduplicates by slug, which keeps
dashboard stats, graph views, diagnostics, reprocess flows, and corpus reports
consistent even when the default `gbrain list` window misses older captures.

## Setup

```bash
./setup.sh        # installs deps, ensures gbrain CLI, initializes database, auto-starts server via launchd
bun run doctor    # verifies local server, extension assets, gbrain, and MCP setup
```

The server auto-starts on login via launchd. To manually start: `bun run serve`

## Testing

```bash
bun run doctor
bun audit
bun test
bash -n setup.sh setup-mcp.sh config/install-launchd.sh
```

## Key shortcuts

- **Mac**: Cmd+Shift+S
- **Windows/Linux**: Ctrl+Shift+S
## Design Context

### Users
Power users of AI assistants (Claude Code, OpenClaw) who read a lot: web articles, Kindle books, notes. They want their AI to know what they've read. Technical, taste-driven, care about tools that feel premium.

### Brand Personality
**Quiet. Sharp. Alive.**

ClipBrain is the invisible memory layer between your reading life and your AI. It should feel like a well-organized mind, not a filing cabinet.

### Aesthetic Direction
**Obsidian meets Linear.**

- **From Obsidian**: dark mode default, knowledge-density, text-first hierarchy, markdown-native rendering, purple/violet tones, the feeling of looking into your own mind
- **From Linear**: ultraclean spacing, smooth micro-animations, monospace accents for metadata, premium polish, nothing unnecessary, the feeling of a tool made by people who care

**Anti-references**: no corporate dashboards (Salesforce), no generic note apps (Google Keep), no busy UI (Jira), no bright colors or playful elements

**Theme**: dark only. Deep space background (#08081a range). Cards with subtle glass-morphism. Accent colors: violet (#8b5cf6) for primary brand, emerald (#4ade80) for success/web, amber (#f59e0b) for Kindle/books.

### Color Palette
- Background: #08081a (deep space)
- Surface 1: #0f0f23 (cards)
- Surface 2: #161633 (hover, elevated)
- Border: #1e1e3e (subtle)
- Border hover: #2d2d5e
- Text primary: #e4e4ed
- Text secondary: #7a7a9a
- Text muted: #4a4a6a
- Accent primary: #8b5cf6 (violet)
- Accent success: #4ade80 (emerald)
- Accent warm: #f59e0b (amber/kindle)
- Accent danger: #ef4444
- Highlight bar: left border 2px solid accent color

### Typography
- Headings: system font, -apple-system, weight 600-700, tight letter-spacing (-0.02em)
- Body: system font, 14px, weight 400, line-height 1.6
- Metadata: monospace (SF Mono, JetBrains Mono fallback), 12px, weight 400, text-secondary color
- Highlights (quotes): 14px, italic, text-primary, with left border accent bar

### Spacing
- Base unit: 4px
- Card padding: 20px
- Section gap: 32px
- Card gap: 12px
- Content max-width: 800px, centered

### Design Principles

1. **Text is the interface.** Highlights, notes, and titles ARE the UI. Don't bury them under chrome.
2. **Density over decoration.** Show more content, less UI furniture. Every pixel earns its place.
3. **Quiet until needed.** Animations are subtle (150-200ms). Colors are muted. Accents appear only for meaning (kindle=amber, web=emerald, action=violet).
4. **Monospace for metadata, sans-serif for reading.** Page numbers, dates, slugs in mono. Highlights and titles in the reading font.
5. **Glass, not plastic.** Surfaces have depth (subtle borders, slight elevation on hover) but never look like buttons unless they are buttons.

### Logo Concept
A **paperclip** morphing into a **brain** silhouette. The clip's curved wire forms one hemisphere of the brain, the other half is the clip's straight arm. Minimal, works at 16px. Single color (violet #8b5cf6 on dark, or white).
