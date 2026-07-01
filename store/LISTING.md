# ClipBrain — Chrome Web Store submission kit

Everything needed to publish ClipBrain to the Chrome Web Store. Copy-paste the
fields below into the Developer Dashboard. Build artifacts and assets live in
this `store/` folder.

Published listing:
https://chromewebstore.google.com/detail/clipbrain/gmoehecpamcidfjdeonfigjenpjbbjoa

---

## 0. What's in this folder

| File | What it is |
|------|------------|
| `dist/clipbrain-extension-v<version>.zip` | The packaged extension to upload (run `build-extension-zip.sh` to regenerate) |
| `build-extension-zip.sh` | Rebuilds the zip from the exact set of files Chrome loads |
| `screenshots/01-capture.png`, `02-dashboard.png`, `03-kindle.png` | Store screenshots, 1280×800 (upload all three) |
| `LISTING.md` | This file |

Icon (128×128) is already in the repo at `icons/icon128.png` — the dashboard
reads it from the uploaded package automatically.

---

## 1. Before you start (your part — I can't do these)

1. **Developer account + one-time $5 fee.** Go to
   https://chrome.google.com/webstore/devconsole and register. The $5 USD
   registration is a payment you must make yourself.
2. **Heads-up — ClipBrain is two parts.** This extension is the *capture* half.
   It does nothing on its own: it sends captures to the **ClipBrain local
   server** the user runs on their own machine (`127.0.0.1:19285`). The listing
   below states this clearly so nobody installs the extension expecting it to
   work standalone and leaves a 1-star "doesn't work" review. The server is the
   free open-source repo + `./setup.sh`.

---

## 2. Store listing tab (copy-paste)

**Item name**
```
ClipBrain
```

**Summary** (max 132 chars)
```
Clip web pages, tweets, Kindle highlights & videos into a local-first memory your AI agents can search over MCP.
```

**Category**
```
Productivity
```
(Alternative: *Developer Tools* — the audience is AI/dev power users. Productivity reaches wider; pick one.)

**Language**
```
English (United States)
```

**Homepage URL**
```
https://agentpilled.github.io/ClipBrain/docs/
```

**Support URL**
```
https://github.com/agentpilled/ClipBrain/issues
```

**Detailed description**
```
ClipBrain is the memory layer between your reading life and your AI.

⚠️ REQUIRES THE FREE CLIPBRAIN LOCAL SERVER. This extension is the capture half
of ClipBrain. It sends what you clip to a small open-source server you run on
your own computer — it does nothing on its own. One-time setup (free):
  git clone https://github.com/agentpilled/ClipBrain
  cd ClipBrain && ./setup.sh
Full instructions: https://github.com/agentpilled/ClipBrain

WHAT IT DOES
Clip any web page, tweet, Kindle highlight, YouTube transcript, Gmail thread, or
PDF into a local-first knowledge base your AI agents can search — over the Model
Context Protocol (MCP). One shortcut (Cmd+Shift+S / Ctrl+Shift+S) and your AI
never starts from zero.

WHY CLIPBRAIN
• Your reading becomes your AI's context. Ask Claude or any MCP client "what did
  I highlight in Deep Work?" or "what have I read about decision-making?" and get
  your own sources back — with citations.
• Local-first. Captures are stored on YOUR computer through your local database.
  There is no ClipBrain cloud. Nothing is uploaded to a ClipBrain server, ever.
• Built for AI power users. If you use Claude Code, OpenClaw, or any MCP-capable
  assistant, ClipBrain gives it durable memory of everything you've read.

WHAT YOU CAN CAPTURE
• Web articles — clean text via Mozilla Readability
• Tweets / X posts
• Kindle highlights & notes — from read.amazon.com/notebook
• YouTube transcripts
• Gmail threads — optional, only after you enable it in the popup
• PDFs

HOW IT WORKS
1. This Chrome extension captures the current page on Cmd+Shift+S (or the
   toolbar button) and sends it to…
2. …your ClipBrain local server (127.0.0.1:19285), which stores the capture and
   exposes it to your AI over MCP.

PRIVACY
• No ClipBrain cloud. No hosted backend. Your corpus never leaves your machine
  through ClipBrain.
• The extension only talks to your local server (127.0.0.1).
• Optional AI enrichment: if YOU configure an OpenAI key on your local server,
  captured text may be sent to OpenAI for summaries and tags. It's off by
  default and entirely under your control.
Full privacy policy: https://github.com/agentpilled/ClipBrain/blob/main/PRIVACY.md

Open source (MIT): https://github.com/agentpilled/ClipBrain
```

---

## 3. Graphic assets

| Asset | Spec | Source | Status |
|-------|------|--------|--------|
| Store icon | 128×128 PNG | `icons/icon128.png` | ✅ ready (read from package) |
| Screenshots | 1280×800 PNG, 1–5 | `store/screenshots/01,02,03` | ✅ ready — upload all three |
| Small promo tile | 440×280 PNG | — | optional, skip for v1 |
| Marquee promo | 1400×560 PNG | — | optional, skip for v1 |

The three screenshots are real UI shots auto-fitted onto the brand background
(#08081a). They're fine for launch; upgrade to captioned marketing shots later
if you want more polish (re-run nothing — just replace the files in
`store/screenshots/`).

---

## 4. Privacy practices tab (copy-paste)

**Single purpose**
```
ClipBrain captures content from web pages the user explicitly chooses — via a
keyboard shortcut or a button — and sends it to a server running locally on the
user's own computer, so the user's AI tools can search what they've read. Its
single purpose is capturing web content into the user's local knowledge base.
```

**Permission justifications** (one per permission)

- `activeTab`
```
Reads the content of the tab the user is actively capturing, only when they
press the capture shortcut or click the extension. No background access.
```
- `scripting`
```
Injects the content-extraction script (Mozilla Readability) into the active tab
on demand to read the article, highlight, or transcript text the user chose to
capture.
```
- `tabs`
```
Reads the active tab's URL and title to build the capture, messages the injected
content scripts, and updates the toolbar badge to reflect capture state as the
user switches tabs.
```
- `storage`
```
Queues captures locally when the local server is temporarily unreachable so no
capture is lost, and stores lightweight extension preferences.
```
- `alarms`
```
Periodically retries (flushes) the offline capture queue so queued captures are
saved once the local server is reachable again.
```
- Host permission `http://localhost:19285/*`, `http://127.0.0.1:19285/*`
```
Sends captured content to the user's own ClipBrain server running locally on
their machine. This is the only network endpoint the extension contacts.
```
- Optional host permission `https://mail.google.com/*`
```
Optional and only requested if the user clicks "Enable Gmail" in the popup. Lets
ClipBrain show a "Clip to ClipBrain" button inside Gmail and capture the open
thread's text.
```

**Are you using remote code?**
```
No — all extension code is contained in the uploaded package. No remotely hosted
code is fetched or executed.
```

**Data usage**
The extension transmits captured content **only to the user's own machine
(127.0.0.1)**; the developer receives nothing. When the form asks what data the
item handles, declare honestly and let the privacy policy clarify it stays local:
- Check **"Website content"** (the page text the user captures).
- Check **"Personal communications"** *only if* you keep Gmail capture in the
  listing (the optional email-thread text).
- Leave the rest unchecked.

Certify all three statements **TRUE** (they are):
- ☑ I do not sell or transfer user data to third parties outside the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**
```
https://github.com/agentpilled/ClipBrain/blob/main/PRIVACY.md
```

---

## 5. Submit (step by step)

1. https://chrome.google.com/webstore/devconsole → sign in → pay the one-time $5
   if you haven't.
2. **New Item** → upload `store/dist/clipbrain-extension-v0.2.5.zip`.
3. **Store listing** tab → paste name, summary, description, category, language;
   confirm the icon; upload the 3 screenshots from `store/screenshots/`;
   set Homepage URL to `https://agentpilled.github.io/ClipBrain/docs/` and Support
   URL to `https://github.com/agentpilled/ClipBrain/issues`.
4. **Privacy practices** tab → paste the single purpose, each permission
   justification, set remote code = No, fill data usage + the 3 certifications,
   paste the privacy policy URL.
5. **Distribution** tab → Visibility: **Public** (or **Unlisted** for a soft
   launch where only people with the link can install); all regions.
6. **Submit for review.**

---

## 6. After you submit

- Review usually takes a few hours to a few days. You get an email on
  approval or rejection (with the reason).
- Once approved it's live: **1-click install + automatic updates** for everyone.
- If rejected, the email names the exact issue — fix, re-upload, resubmit. The
  most common cause is a permission whose justification the reviewer wants
  expanded; the justifications above are written to pre-empt that.

---

## 7. Shipping an update later

The extension and the server version independently. Server-only changes (like
v0.2.0–v0.2.4, which were all in `server.ts`) do **not** need a store update.

When you change **extension** code (anything in the zip's file list):
1. Bump `"version"` in `manifest.json` — it must be strictly higher than the
   live version (Chrome uses it for auto-update).
2. `bash store/build-extension-zip.sh` → new zip in `store/dist/`.
3. Upload the new zip in the dashboard → submit. Users auto-update within hours.
