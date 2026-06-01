# ClipBrain Agent Instructions

This file is for Codex and other coding agents working in this repo. Claude Code
can use `CLAUDE.md`; keep this file shorter and focused on operational rules.

## Project Shape

ClipBrain is a Chrome extension plus a local Bun HTTP server. The extension
captures web pages, Kindle highlights, Gmail threads, YouTube transcripts, and
PDFs. The server writes captures to the user's local knowledge base through the
installed `gbrain` CLI and optionally syncs markdown to Obsidian.

Important files:

- `server.ts`: local HTTP API, dashboard routes, capture handling, diagnostics
- `clipbrain-mcp.ts`: ClipBrain-specific MCP tools that call the local server
- `backfill.ts`: controlled Knowledge Compiler backfill for legacy captures
- `corpus-report.ts`: read-only corpus quality report for junk/duplicate audit
- `service-worker.js`: MV3 background worker, capture dispatch, offline queue
- `content-script.js`, `kindle-content-script.js`, `gmail-content-script.js`: page extractors
- `post-process.ts`: optional OpenAI enrichment after a capture is saved
- `dashboard.html`, `popup.html`, `popup.js`: local UI surfaces
- `setup.sh`, `setup-mcp.sh`: local install and MCP configuration
- `test/`: Bun tests for server and post-processing behavior

## Runtime Facts

- Use Bun. Primary checks are `bun test`, `bun audit`, and shell syntax checks
  for setup scripts.
- The server binds to `127.0.0.1:19285` by default. It can be overridden with
  `--host`, `--port`, `GBRAIN_CAPTURE_HOST`, and `GBRAIN_CAPTURE_PORT`.
- MCP setup registers both `gbrain` (`gbrain serve`) and `clipbrain`
  (`bun clipbrain-mcp.ts`). Keep `gbrain` for broad brain tools; use
  `clipbrain` for ClipBrain-specific agent handoffs such as `context_pack`.
- Do not reintroduce a vendored `gbrain` dependency or local `./bin/gbrain`
  build path. The app should use `GBRAIN_BIN` when set, then `gbrain` from
  `PATH`.
- `package-lock.json` is intentionally absent. This repo uses `bun.lock`.
- Runtime data files such as `.captures.jsonl`, `.highlight-count`,
  `.highlight-counts.json`, and `.clipbrain.json` must stay out of commits.
  Tests should use `CLIPBRAIN_DATA_DIR` for isolated state.
- Use `bun run backfill --limit N` for a dry-run before applying compiler
  upgrades with `bun run backfill --apply --limit N`.
- Use `bun run corpus` to inspect likely junk, duplicate titles, and pending
  compiler upgrades. It is read-only.

## Security Boundaries

- Keep the server local-first. Do not bind to `0.0.0.0` by default.
- Preserve origin checks: allow Chrome extension origins and matching loopback
  dashboard origins, reject unrelated web origins.
- Preserve optional write auth via `CLIPBRAIN_API_TOKEN`.
- Do not log, print, or commit real API keys or tokens.

## Product And Design

For UX or visual changes, preserve the existing dark, dense, text-first product
feel. The detailed design context lives in `CLAUDE.md`; use it as the source of
truth instead of duplicating long design notes here.

## Before Committing

Run:

```bash
bun audit
bun test
bash -n setup.sh setup-mcp.sh config/install-launchd.sh
```

If the local service is relevant, also verify:

```bash
curl -sS http://127.0.0.1:19285/health
curl -sS http://127.0.0.1:19285/api/diagnostics
```
