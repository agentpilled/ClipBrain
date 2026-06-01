# Changelog

## Unreleased

- Added `bun run doctor` for first-run diagnostics across Bun, `gbrain`, extension assets, local server health, runtime diagnostics, and MCP setup.
- Added `bun run launch:check` for public release validation.
- Centralized robust `gbrain list` scanning so dashboard stats, graph, reprocess, diagnostics, and corpus reports see the same ClipBrain capture set.
- Added public privacy and security documentation.
- Renamed public package and OpenClaw metadata from the old capture prototype name to ClipBrain.
- Switched launchd generation to `com.clipbrain.serve` with compatibility unloading for the legacy service label.
