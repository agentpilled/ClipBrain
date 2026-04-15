// ClipBrain — Content Script
// Runs in the page context (has DOM access). Uses Readability to extract article content.

(function () {
  // ─── YouTube detection ──────────────────────────────────────────────
  function isYouTubeVideo() {
    const hostname = location.hostname;
    if (hostname.includes("youtube.com") && /[?&]v=/.test(location.search)) return true;
    if (hostname === "youtu.be") return true;
    return false;
  }

  function getYouTubeVideoId() {
    const url = new URL(location.href);
    if (url.hostname === "youtu.be") return url.pathname.slice(1);
    return url.searchParams.get("v") || null;
  }

  // ─── YouTube transcript extraction (client-side) ────────────────────
  // Fetching caption URLs server-side fails because they expire immediately.
  // The content script can fetch them same-origin, with YouTube cookies intact.

  function extractTranscriptFromScripts() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (text.includes("captionTracks")) {
        const match = text.match(/"captionTracks":\[(.*?)\]/s);
        if (match) {
          const urlMatch = match[1].match(/"baseUrl":"(.*?)"/);
          if (urlMatch) {
            const captionUrl = urlMatch[1].replace(/\\u0026/g, "&");
            // Same-origin fetch — browser includes YouTube cookies automatically
            // Try json3 first, fall back to XML
            return fetch(captionUrl + "&fmt=json3")
              .then((r) => {
                if (!r.ok || r.headers.get("content-length") === "0") throw new Error("empty json3");
                return r.text();
              })
              .then((text) => {
                if (!text || text.length < 10) throw new Error("empty json3 response");
                const data = JSON.parse(text);
                return (data.events || [])
                  .filter((e) => e.segs)
                  .map((e) => ({
                    start: Math.floor((e.tStartMs || 0) / 1000),
                    text: (e.segs || []).map((s) => s.utf8 || "").join("").trim(),
                  }))
                  .filter((s) => s.text);
              })
              .catch(() => {
                // json3 failed, try default XML format
                console.log("ClipBrain: json3 failed, trying XML captions...");
                return fetch(captionUrl)
                  .then((r) => r.text())
                  .then((xml) => {
                    if (!xml || xml.length < 10) return null;
                    // Parse XML: <transcript><text start="0" dur="5.2">Hello world</text>...</transcript>
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(xml, "text/xml");
                    const textEls = doc.querySelectorAll("text");
                    if (!textEls.length) return null;
                    const segments = [];
                    for (const el of textEls) {
                      const start = Math.floor(parseFloat(el.getAttribute("start") || "0"));
                      // Decode HTML entities in the text
                      const div = document.createElement("div");
                      div.innerHTML = el.textContent || "";
                      const cleanText = div.textContent.trim();
                      if (cleanText) {
                        segments.push({ start, text: cleanText });
                      }
                    }
                    return segments.length > 0 ? segments : null;
                  })
                  .catch((err) => {
                    console.warn("ClipBrain: XML caption fetch also failed:", err);
                    return null;
                  });
              });
          }
        }
      }
    }
    return Promise.resolve(null);
  }

  function extractTranscriptFromPanel() {
    // Fallback: read from an already-open transcript panel
    const panel = document.querySelector("ytd-transcript-renderer");
    if (!panel) return null;

    const segmentEls = panel.querySelectorAll("ytd-transcript-segment-renderer");
    if (!segmentEls.length) return null;

    const segments = [];
    for (const el of segmentEls) {
      const timeEl = el.querySelector(".segment-timestamp");
      const textEl = el.querySelector(".segment-text");
      if (!textEl) continue;

      let start = 0;
      if (timeEl) {
        const parts = (timeEl.textContent || "").trim().split(":").map(Number);
        if (parts.length === 2) start = parts[0] * 60 + parts[1];
        else if (parts.length === 3) start = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }

      const text = (textEl.textContent || "").trim();
      if (text) segments.push({ start, text });
    }

    return segments.length ? segments : null;
  }

  if (isYouTubeVideo()) {
    const videoId = getYouTubeVideoId();
    if (!videoId) {
      console.warn("ClipBrain: YouTube page but no video ID found");
      return;
    }

    // Extract title from the page
    const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
                    document.querySelector("h1.ytd-video-primary-info-renderer") ||
                    document.querySelector("h1");
    const title = titleEl?.textContent?.trim() || document.title.replace(/ - YouTube$/, "").trim();

    // Extract channel name
    const channelEl = document.querySelector("ytd-channel-name yt-formatted-string a") ||
                      document.querySelector("#channel-name a") ||
                      document.querySelector("ytd-channel-name yt-formatted-string");
    const channel = channelEl?.textContent?.trim() || "";

    // Extract transcript client-side, then send to service worker
    extractTranscriptFromScripts().then((segments) => {
      // If script extraction failed, try the DOM panel fallback
      if (!segments) {
        segments = extractTranscriptFromPanel();
      }

      chrome.runtime.sendMessage({
        type: "youtube-capture",
        url: location.href,
        videoId: videoId,
        title: title,
        channel: channel,
        transcript: segments, // Array of {start, text} or null
      });
    });

    return; // Skip Readability — YouTube page HTML is useless
  }

  // ─── Standard web page capture ─────────────────────────────────────
  // Readability is injected before this script via lib/readability.js
  // It attaches to `window.Readability` or is available as `Readability` global
  const ReadabilityClass =
    typeof Readability !== "undefined" ? Readability : window.Readability;

  let article = null;
  try {
    // Clone the document so Readability's mutations don't affect the live page
    const docClone = document.cloneNode(true);
    if (ReadabilityClass) {
      const reader = new ReadabilityClass(docClone);
      article = reader.parse();
    }
  } catch (err) {
    console.warn("ClipBrain: Readability extraction failed:", err);
  }

  const selection = window.getSelection()?.toString() || null;

  chrome.runtime.sendMessage({
    type: "captured",
    url: location.href,
    title: document.title,
    content: article?.textContent || document.body?.innerText?.slice(0, 50000) || null,
    selection: selection,
  });
})();
