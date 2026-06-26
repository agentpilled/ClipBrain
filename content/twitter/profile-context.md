# X Profile Context

Captured from public X data on 2026-06-26.

## Profile

- Handle: @agentpilled
- Display name: agentpilled
- Bio: creating creates creativity
- Joined: 2026-03-09
- Public counts at capture: 94 posts, 103 followers, 22 following, 18 likes, 5 media posts
- Verification: X Premium / blue verified, not legacy verified

## Canonical Post

- URL: https://x.com/agentpilled/status/2044763362194530624
- Date: 2026-04-16
- Format: origin story plus 28 second product video
- Public performance at capture: 34,661 views, 251 bookmarks, 87 likes, 10 replies, 4 reposts, 4 quotes
- Short excerpt: "I've always wanted one place..."
- Story arc: personal itch for one place containing Kindle highlights, blogs, saved posts, and YouTube videos; external spark from Karpathy on personal knowledge bases with LLMs and Garry Tan open sourcing GBrain for OpenClaw; ClipBrain as the eureka/build response.

## Voice Read

- The account already feels agent-native and recursive, not corporate.
- Strongest public signal is founder-origin story: personal itch -> external validation -> demo.
- The pinned post worked because it was specific, aspirational, and save-worthy for builders.
- Bookmarks materially outpaced likes, which suggests the audience saved it as a useful reference or future tool, not just a vibe post.
- The bio is abstract and playful; ClipBrain posts can be slightly weird, but product proof has to carry the weight.
- Reply voice is warm and direct: acknowledge the other builder first, then bridge to ClipBrain only when the connection is genuinely relevant.
- The best reusable mental models are concrete analogies: Readwise for agents/OpenClaw, clips into GBrain, Codex as plumbing and Claude as paint.

## Content Implications

- Prefer "I wanted this for myself" over launch-copy claims.
- Tie agent memory to concrete inputs: Kindle highlights, saved posts, blogs, PDFs, YouTube, notes.
- Make public posts feel like dispatches from a workshop, not a brand calendar.
- A good ClipBrain post should usually include one of: demo video, screenshot, repo diff, local command, changelog, or specific workflow.
- Continue the pinned narrative instead of replacing it: one place for what I know, made usable by agents.
- Avoid generic "agents need memory" takes unless they point back to a concrete personal workflow.
- Do not over-repeat the exact origin story block. For public launch, evolve it into new proof: a cleaner demo, a Kindle import walkthrough, a context-pack answer, or a real repo milestone.
- For replies, open with the thread's topic, then make ClipBrain the useful next thought. Avoid naked "check this out" promotion.

## Chrome Voice Sampling - 2026-06-26

- Read-only logged-in Chrome sampling captured 18 clean public posts/replies into ignored `content/twitter/voice-samples.local.md`.
- Two visibly truncated X posts were intentionally omitted from the local samples.
- Observed pattern: short standalone posts carry the product thesis; replies are warmer and often reuse the founder story when the surrounding thread is a fit.
- Observed pattern: the account mixes casual lowercase builder voice with strong product specificity.
- Operational rule: raw tweet text stays local and gitignored; tracked docs keep only summarized style signals.

## Current Limits

- Public X profile and GraphQL exposed profile metadata, the pinned post, and highlighted post.
- Public profile timeline returned empty through `UserTweets`; `UserTweetsAndReplies` and search routes were not available through the tested guest flow.
- TwStalker direct profile access was blocked by Cloudflare.
- Richer voice calibration now depends on refreshing `content/twitter/voice-samples.local.md` from public posts/replies or a direct export.
