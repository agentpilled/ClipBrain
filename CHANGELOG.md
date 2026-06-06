# Changelog

## [0.1.0] - 2026-06-06

Initial public release. Clip web pages, tweets, Kindle highlights, Gmail threads, YouTube transcripts, and PDFs into a local-first, agent-ready memory layer your AI tools can search over MCP. One shortcut (Cmd+Shift+S) and your AI never starts from zero.

- Added `bun run doctor` for first-run diagnostics across Bun, `gbrain`, extension assets, local server health, runtime diagnostics, and MCP setup.
- Added `bun run launch:check` for public release validation.
- Centralized robust `gbrain list` scanning so dashboard stats, graph, reprocess, diagnostics, and corpus reports see the same ClipBrain capture set.
- Added public privacy and security documentation.
- Renamed public package and OpenClaw metadata from the old capture prototype name to ClipBrain.
- Switched launchd generation to `com.clipbrain.serve` with compatibility unloading for the legacy service label.
