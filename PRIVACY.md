# Privacy

ClipBrain is local-first. There is no ClipBrain cloud service.

## What stays local

- Captured pages, Kindle highlights, Gmail thread text, YouTube transcript text, and PDF text are stored through your local `gbrain` database.
- The local HTTP server binds to `127.0.0.1:19285` by default.
- Runtime files such as `.captures.jsonl`, `.clipbrain.json`, `.highlight-counts.json`, and cleanup backups are local and gitignored.
- Optional Obsidian sync writes markdown files to your local vault.

## Optional network calls

ClipBrain can work without AI enrichment. If `OPENAI_API_KEY` is set, captured text may be sent to OpenAI for summaries, tags, connections, and Knowledge Compiler atoms.

YouTube capture may use `yt-dlp` when installed. That tool contacts YouTube to fetch transcript or metadata when needed.

The `gbrain` CLI may use the embedding/provider configuration you have set up for your local brain. Check your `gbrain` provider settings for exact model/network behavior.

## Browser permissions

The Chrome extension uses `activeTab`, `scripting`, `tabs`, `storage`, and `alarms` to capture the current page, queue failed captures, and retry when the local server is back online.

Gmail access is optional. ClipBrain requests `https://mail.google.com/*` only after you click **Enable Gmail** in the popup.

## What ClipBrain does not do

- It does not run a hosted backend.
- It does not upload your corpus to a ClipBrain service.
- It does not sell or share captured content.
- It does not require OpenAI enrichment for basic capture and search.

## Removing local data

ClipBrain stores knowledge in your local `gbrain` database. Use `gbrain` tools to inspect or delete saved pages. Runtime logs and local state can also be removed from the repo checkout and `~/Library/Logs/clipbrain.log` on macOS.
