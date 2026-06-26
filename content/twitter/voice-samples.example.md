# Voice Samples Example

Copy this file to `content/twitter/voice-samples.local.md` and paste 10-20
real posts or replies from `@agentpilled`.

`voice-samples.local.md` is ignored by git. Use it for raw public voice samples,
rough notes, and posts you do not want to publish into the repo.

## Format

Use one fenced block per post or reply:

```text
the thing i want from ClipBrain is simple:

i read something once.
my agents can use it later.
```

```text
This is exactly where memory gets interesting.

Tools let agents act, but saved context tells them what matters to you.
```

Optional metadata before a block is fine:

```markdown
- URL: https://x.com/agentpilled/status/...
- Notes: strong bookmark ratio, attached demo
```

The Twitter agent reads fenced text blocks only. It summarizes their style into
source signals and checklist items; it does not print the raw samples in draft
packs.
