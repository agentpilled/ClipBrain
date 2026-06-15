# Changelog

## [0.2.2] - 2026-06-09

Fixed a silent setup failure. `./setup.sh` could print *"✅ ClipBrain is ready!"* without actually creating your brain — if no embedding provider was configured, `gbrain init` exits without creating one (exit 0), and setup didn't notice. Now setup detects your provider (OpenAI key → OpenAI embeddings; local Ollama → Ollama; otherwise a keyword-only brain), **always creates a working brain**, verifies it exists before claiming success, and tells you whether semantic search is on (and how to enable it). Captures and search work out of the box now, even without an API key.

## [0.2.1] - 2026-06-09

*"What did I highlight in X?"* now returns your **actual highlights**, not just an AI summary of them. The context pack surfaces a page's saved highlights and notes — the source-of-truth content — ahead of the derived summary, so asking about a book or article gives you back what you actually marked (capped, with a pointer to the full page for long sets). Completes the named-source experience from v0.2.0, which made the named source rank first.

## [0.2.0] - 2026-06-09

Ask your AI about a specific book, article, or video **by name** and get that exact source back. Queries like *"what did I highlight in Deep Work?"* or *"what did that AI moats video say?"* now surface the source you named **first**, instead of burying it under thematically-similar reading. The context pack adds a title-aware retrieval pass: any captured page whose title (or author) appears in your query is promoted ahead of the semantic results. Topic and open-ended queries (*"what have I read about decision-making?"*) are unchanged.

## [0.1.0] - 2026-06-06

Initial public release. Clip web pages, tweets, Kindle highlights, Gmail threads, YouTube transcripts, and PDFs into a local-first, agent-ready memory layer your AI tools can search over MCP. One shortcut (Cmd+Shift+S) and your AI never starts from zero.

- Added `bun run doctor` for first-run diagnostics across Bun, `gbrain`, extension assets, local server health, runtime diagnostics, and MCP setup.
- Added `bun run launch:check` for public release validation.
- Centralized robust `gbrain list` scanning so dashboard stats, graph, reprocess, diagnostics, and corpus reports see the same ClipBrain capture set.
- Added public privacy and security documentation.
- Renamed public package and OpenClaw metadata from the old capture prototype name to ClipBrain.
- Switched launchd generation to `com.clipbrain.serve` with compatibility unloading for the legacy service label.
