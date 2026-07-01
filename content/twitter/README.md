# ClipBrain Twitter Agent

This folder defines the draft-only building-in-public system for ClipBrain.

Run:

```bash
bun run twitter:draft
```

The command reads public repo signals such as recent commits, `CHANGELOG.md`,
`README.md`, `content/twitter/profile-context.md`, and optional local voice
samples, then writes a daily draft pack to:

```bash
content/twitter/drafts/YYYY-MM-DD.md
```

Draft files are gitignored on purpose. They can include unfinished positioning,
personal founder voice, or content that should be reviewed before posting.

## Workflow

1. Build something real in ClipBrain.
2. Run `bun run twitter:draft`.
3. Review the generated short posts, thread, demo idea, engagement plan,
   reply queue, and warnings.
4. Edit by hand.
5. Post manually.

The agent does not call the X API, schedule posts, or publish anything.

`profile-context.md` contains public profile-level calibration for
`@agentpilled`. Update it when a new pinned post, strong post, or export gives a
better signal for voice and audience.

For raw voice samples, copy `content/twitter/voice-samples.example.md` to:

```bash
content/twitter/voice-samples.local.md
```

Paste one real post or reply per fenced text block. The local file is gitignored;
the agent summarizes its style signals without printing the raw samples in draft
packs.

Only use public posts/replies or an explicit export you are comfortable using
for drafting. Do not paste DMs, notifications, private emails, customer content,
or private captures into the voice sample file.

## Reply and engagement workflow

Replies are the main distribution loop for a small or recently quiet account.
Before running the agent, collect promising public conversations into a local
target file:

```bash
cp content/twitter/reply-targets.example.md content/twitter/reply-targets.local.md
```

Add one target per bullet:

```text
- https://x.com/someone/status/123456789 | Bridge MCP tools to memory with source-grounded context.
- Thread about local-first AI | Emphasize that local-first should still feel magical.
```

Then run:

```bash
bun run twitter:draft -- --topic "Chrome Web Store launch"
```

The generated pack includes:

- Search queries for finding relevant conversations
- A daily reply routine
- Saved reply targets
- A queue of reusable replies across MCP, local-first AI, agent memory,
  Kindle highlights, Readwise/Obsidian, GBrain, and product-link situations

Use links sparingly. Most replies should improve the thread without linking to
ClipBrain. Save links for moments where someone is explicitly asking for a
tool, demo, or implementation.

## Useful options

```bash
bun run twitter:draft -- --dry-run
bun run twitter:draft -- --date 2026-06-26
bun run twitter:draft -- --topic "first-run magic"
bun run twitter:draft -- --commit-limit 8
```

## Operating Rule

If a draft does not point to something real in the product, cut it or turn it
into a build task. The Twitter strategy is proof over hype.
