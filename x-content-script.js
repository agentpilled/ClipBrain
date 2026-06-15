// ClipBrain — X (Twitter) Bookmarks Content Script
// Injected on all of x.com / twitter.com. X is a SPA, so a content script
// scoped to /i/bookmarks only injects on a full page load of that URL — soft
// navigations (clicking "Bookmarks" in the sidebar) never trigger it. To make
// the button reliable, we inject everywhere and watch the SPA route, mounting
// the button only while the user is on the bookmarks page.
//
// The bookmarks timeline is virtualized (X drops off-screen nodes), so we
// auto-scroll and harvest tweets into a Map keyed by tweet id as they render,
// then send each as a normal web capture (type: "captured" → /api/capture).
// Each tweet becomes its own page (web/x-com/{handle}/status/{id}), deduped by
// URL, so re-importing is idempotent.

(function () {
  if (window.__clipbrainXReady) return;
  window.__clipbrainXReady = true;

  // ─── Tunables ───────────────────────────────────────────────────────
  const MAX_TWEETS = 2000; // safety cap
  const SCROLL_PAUSE = 850; // ms between scrolls (let X render the next batch)
  const STAGNANT_LIMIT = 6; // consecutive no-growth scrolls => reached the end
  const SEND_THROTTLE = 140; // ms between sends (gentle on background enrichment)

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let btn = null;

  // ─── Route awareness (SPA-safe) ─────────────────────────────────────
  function onBookmarksPage() {
    return /^\/i\/bookmarks/.test(location.pathname);
  }

  function mountButton() {
    if (btn && document.body.contains(btn)) return; // already mounted
    btn = document.createElement("button");
    btn.id = "clipbrain-x-import";
    btn.textContent = "Import bookmarks to ClipBrain";
    Object.assign(btn.style, {
      position: "fixed", bottom: "24px", right: "24px", zIndex: "2147483647",
      padding: "12px 20px", borderRadius: "8px", fontSize: "14px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontWeight: "500", color: "#fff", background: "#8b5cf6", border: "none",
      cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
      transition: "opacity 0.2s ease, background 0.2s ease",
    });
    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.background = "#7c3aed"; });
    btn.addEventListener("mouseleave", () => { if (!btn.dataset.done) btn.style.background = "#8b5cf6"; });
    btn.addEventListener("click", () => { if (!btn.disabled) runImport(); });
    document.body.appendChild(btn);
    console.log("ClipBrain X: button mounted on bookmarks page");
  }

  function unmountButton() {
    if (btn) { btn.remove(); btn = null; }
    const panel = document.getElementById("clipbrain-x-summary");
    if (panel) panel.remove();
  }

  function syncRoute() {
    if (onBookmarksPage()) mountButton();
    else unmountButton();
  }

  // Watch SPA route changes: patch history methods + popstate + a poll fallback.
  (function installRouteWatcher() {
    const fire = () => window.dispatchEvent(new Event("clipbrain:locationchange"));
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    window.addEventListener("popstate", fire);
    window.addEventListener("clipbrain:locationchange", syncRoute);
    setInterval(syncRoute, 1500); // belt-and-suspenders for any missed transition
  })();

  // ─── Parse one tweet <article> ──────────────────────────────────────
  function parseTweet(article) {
    try {
      let href = null;
      for (const a of article.querySelectorAll('a[href*="/status/"]')) {
        const h = a.getAttribute("href") || "";
        if (/^\/[^/]+\/status\/\d+/.test(h)) { href = h.split("?")[0]; break; }
      }
      if (!href) return null;

      const id = (href.match(/status\/(\d+)/) || [])[1] || null;
      const handle = (href.match(/^\/([^/]+)\/status/) || [])[1] || null;
      if (!id || !handle) return null;

      let displayName = null;
      const nameEl = article.querySelector('[data-testid="User-Name"]');
      if (nameEl) {
        const parts = nameEl.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
        displayName = parts[0] || null;
      }

      let text = "";
      const textEl = article.querySelector('[data-testid="tweetText"]');
      if (textEl) text = textEl.innerText.trim();

      const timeEl = article.querySelector("time[datetime]");
      const date = timeEl ? timeEl.getAttribute("datetime") : null;

      const hasMedia = !!article.querySelector(
        '[data-testid="tweetPhoto"], video, [data-testid="card.wrapper"]'
      );

      return { id, handle, displayName, text, url: `https://x.com${href}`, date, hasMedia };
    } catch (e) {
      return null;
    }
  }

  // ─── Markdown + title ───────────────────────────────────────────────
  function formatMarkdown(t) {
    const who = t.displayName ? `${t.displayName} (@${t.handle})` : `@${t.handle}`;
    const when = t.date ? ` · ${t.date.slice(0, 10)}` : "";
    const lines = [`**${who}**${when}`, ""];
    if (t.text) lines.push(t.text, "");
    else if (t.hasMedia) lines.push("_(media tweet — no text)_", "");
    lines.push(`[View on X](${t.url})`);
    return lines.join("\n");
  }

  function buildTitle(t) {
    const who = t.displayName || `@${t.handle}`;
    const snippet = (t.text || (t.hasMedia ? "media tweet" : "tweet")).replace(/\s+/g, " ").trim();
    const short = snippet.length > 80 ? snippet.slice(0, 80) + "…" : snippet;
    return `${who}: ${short}`;
  }

  function send(t) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "captured", url: t.url, title: buildTitle(t), content: formatMarkdown(t), selection: null },
        (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: true });
        }
      );
    });
  }

  // ─── Scroll + harvest (virtualized-list safe) ───────────────────────
  function harvest(seen) {
    const arts = document.querySelectorAll(
      'article[data-testid="tweet"], [data-testid="cellInnerDiv"] article, article[role="article"]'
    );
    for (const a of arts) {
      const t = parseTweet(a);
      if (t && !seen.has(t.id)) seen.set(t.id, t);
    }
  }

  async function collectAllTweets(onProgress) {
    const seen = new Map();
    let stagnant = 0;
    harvest(seen);
    onProgress(seen.size);
    while (stagnant < STAGNANT_LIMIT && seen.size < MAX_TWEETS) {
      const before = seen.size;
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await delay(SCROLL_PAUSE);
      harvest(seen);
      onProgress(seen.size);
      stagnant = seen.size === before ? stagnant + 1 : 0;
    }
    return Array.from(seen.values());
  }

  // ─── Import flow ────────────────────────────────────────────────────
  async function runImport() {
    if (!btn) return;
    btn.disabled = true;
    btn.style.cursor = "wait";
    btn.dataset.done = "";
    btn.style.background = "#7c3aed";
    btn.textContent = "Scanning bookmarks…";

    let tweets = [];
    try {
      tweets = await collectAllTweets((n) => { if (btn) btn.textContent = `Scanning… ${n} found`; });
    } catch (e) {
      console.error("ClipBrain X: scan failed", e);
    }
    console.log(`ClipBrain X: collected ${tweets.length} tweets`);

    if (tweets.length === 0) {
      finishButton("No bookmarks found — scroll once, then retry", "#b08800");
      return;
    }

    let ok = 0, fail = 0;
    for (let i = 0; i < tweets.length; i++) {
      if (btn) btn.textContent = `Saving… ${i + 1}/${tweets.length}`;
      const r = await send(tweets[i]);
      if (r && r.ok !== false) ok++; else fail++;
      await delay(SEND_THROTTLE);
    }
    console.log(`ClipBrain X: saved ${ok}, failed ${fail}`);

    showSummary(ok, fail, tweets);
  }

  // ─── Summary panel ──────────────────────────────────────────────────
  function showSummary(ok, fail, tweets) {
    if (btn) btn.style.display = "none";

    const sample = tweets.find((t) => t.text) || tweets[0];
    const topic = sample && sample.handle ? `@${sample.handle}` : "my bookmarks";
    const samplePrompt = `What did I bookmark from ${topic}?`;

    const panel = document.createElement("div");
    panel.id = "clipbrain-x-summary";
    Object.assign(panel.style, {
      position: "fixed", bottom: "24px", right: "24px", zIndex: "2147483647",
      background: "#0f0f23", borderRadius: "12px", padding: "20px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)", color: "#e4e4ed",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      maxWidth: "340px", minWidth: "280px", lineHeight: "1.5", border: "1px solid #1e1e3e",
    });

    const header = document.createElement("div");
    header.style.cssText = "font-size:16px;font-weight:600;margin-bottom:6px;color:#4ade80";
    header.textContent = "✓ Bookmarks imported to ClipBrain";
    panel.appendChild(header);

    const count = document.createElement("div");
    count.style.cssText = "font-size:13px;color:#7a7a9a;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1e1e3e";
    count.textContent = `${ok} tweet${ok !== 1 ? "s" : ""} saved` + (fail ? ` · ${fail} failed` : "");
    panel.appendChild(count);

    const tryLabel = document.createElement("div");
    tryLabel.style.cssText = "font-size:11px;color:#7a7a9a;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px";
    tryLabel.textContent = "Then ask your AI";
    panel.appendChild(tryLabel);

    const promptBox = document.createElement("div");
    Object.assign(promptBox.style, {
      background: "#161633", borderRadius: "8px", padding: "10px 12px",
      fontSize: "13px", color: "#a5b4fc", cursor: "pointer",
      border: "1px solid #1e1e3e", marginBottom: "16px",
    });
    promptBox.textContent = `"${samplePrompt}"`;
    promptBox.title = "Click to copy";
    promptBox.addEventListener("click", () => {
      navigator.clipboard.writeText(samplePrompt).then(() => {
        const prev = promptBox.textContent;
        promptBox.textContent = "Copied!";
        promptBox.style.color = "#4ade80";
        setTimeout(() => { promptBox.textContent = prev; promptBox.style.color = "#a5b4fc"; }, 1500);
      });
    });
    panel.appendChild(promptBox);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:space-between;align-items:center";

    const dash = document.createElement("a");
    dash.href = "http://127.0.0.1:19285";
    dash.target = "_blank";
    dash.textContent = "Open dashboard →";
    dash.style.cssText = "font-size:12px;color:#8b5cf6;text-decoration:none";
    buttons.appendChild(dash);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close ✕";
    Object.assign(closeBtn.style, {
      background: "#8b5cf6", border: "none", color: "#fff",
      padding: "6px 14px", borderRadius: "6px", fontSize: "12px", cursor: "pointer",
    });
    closeBtn.addEventListener("click", () => {
      panel.remove();
      if (btn) {
        btn.style.display = "";
        btn.disabled = false;
        btn.style.cursor = "pointer";
        btn.dataset.done = "";
        btn.style.background = "#8b5cf6";
        btn.style.padding = "8px 14px";
        btn.style.fontSize = "12px";
        btn.textContent = "Re-import bookmarks";
      }
    });
    buttons.appendChild(closeBtn);
    panel.appendChild(buttons);

    document.body.appendChild(panel);
  }

  function finishButton(text, bg) {
    if (!btn) return;
    btn.textContent = text;
    btn.style.background = bg;
    btn.disabled = false;
    btn.style.cursor = "pointer";
    btn.dataset.done = "true";
  }

  // ─── Init ───────────────────────────────────────────────────────────
  syncRoute();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncRoute);
  }
})();
