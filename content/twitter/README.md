# ClipBrain Twitter Agent

This folder defines the draft-only building-in-public system for ClipBrain.

Run:

```bash
bun run twitter:draft
```

The command reads public repo signals such as recent commits, `CHANGELOG.md`,
`README.md`, and `content/twitter/profile-context.md`, then writes a daily
draft pack to:

```bash
content/twitter/drafts/YYYY-MM-DD.md
```

Draft files are gitignored on purpose. They can include unfinished positioning,
personal founder voice, or content that should be reviewed before posting.

## Workflow

1. Build something real in ClipBrain.
2. Run `bun run twitter:draft`.
3. Review the generated short posts, thread, demo idea, replies, and warnings.
4. Edit by hand.
5. Post manually.

The agent does not call the X API, schedule posts, or publish anything.

`profile-context.md` contains public profile-level calibration for
`@agentpilled`. Update it when a new pinned post, strong post, or export gives a
better signal for voice and audience.

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
