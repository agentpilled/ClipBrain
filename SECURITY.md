# Security

ClipBrain is designed as a local tool. Treat the local server as access to your personal knowledge base.

## Defaults

- The server binds to `127.0.0.1:19285` by default.
- Browser requests are origin-checked.
- Write endpoints can be protected with `CLIPBRAIN_API_TOKEN`.
- Runtime secrets and local state are gitignored.

## Hardening

- Do not bind the server to `0.0.0.0` unless you are on a trusted, isolated network.
- Set `CLIPBRAIN_API_TOKEN` before exposing write endpoints beyond the browser extension.
- Keep `OPENAI_API_KEY` in your shell, launchd environment, or secret manager. Do not commit it.
- Review optional provider settings in `gbrain`; embeddings and enrichment may contact third-party APIs depending on your configuration.
- Run `bun audit` and `bun run doctor` before sharing a build.

## Reporting Issues

If you find a vulnerability, open a GitHub security advisory or a private issue with:

- Affected version or commit
- Reproduction steps
- Impact
- Any relevant logs with secrets removed

Do not include real API keys, captured private content, or personal database dumps in reports.
