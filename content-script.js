// ClipBrain — Content Script
// Runs in the page context (has DOM access). Uses Readability to extract article content.

(function () {
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
