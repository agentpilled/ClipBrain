// ClipBrain — Content Script
// Runs in the page context (has DOM access). Uses Readability to extract article content.

(function () {
  try {
  // ─── Gmail detection — skip Readability, handled by gmail-content-script.js ──
  if (location.hostname === 'mail.google.com') {
    console.log('ClipBrain: on Gmail — skipping Readability, gmail-content-script handles this');
    return;
  }

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

  // ─── YouTube: transcript extracted server-side via yt-dlp ────────────

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

    // Send to service worker — transcript is extracted server-side via yt-dlp
    chrome.runtime.sendMessage({
      type: "youtube-capture",
      url: location.href,
      videoId: videoId,
      title: title,
      channel: channel,
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

  } catch (err) {
    console.error("ClipBrain: content script error:", err);
    // Notify the service worker so it can show an error toast
    try {
      chrome.runtime.sendMessage({
        type: "content-script-error",
        error: err.message || "Unknown error extracting page content",
      });
    } catch (_) {
      // If we can't even send the message, there's nothing more to do
    }
  }
})();
