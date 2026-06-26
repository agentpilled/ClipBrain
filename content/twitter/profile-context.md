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

## Content Implications

- Prefer "I wanted this for myself" over launch-copy claims.
- Tie agent memory to concrete inputs: Kindle highlights, saved posts, blogs, PDFs, YouTube, notes.
- Make public posts feel like dispatches from a workshop, not a brand calendar.
- A good ClipBrain post should usually include one of: demo video, screenshot, repo diff, local command, changelog, or specific workflow.
- Continue the pinned narrative instead of replacing it: one place for what I know, made usable by agents.
- Avoid generic "agents need memory" takes unless they point back to a concrete personal workflow.

## Current Limits

- Public X profile and GraphQL exposed profile metadata, the pinned post, and highlighted post.
- Public profile timeline returned empty through `UserTweets`; `UserTweetsAndReplies` and search routes were not available through the tested guest flow.
- TwStalker direct profile access was blocked by Cloudflare.
- For richer voice calibration, use one of: a direct export of recent tweets, a pasted sample of 10-20 posts/replies, or explicit approval to inspect the logged-in browser session.
