// ClipBrain — MV3 Service Worker
// Receives extracted content from content script, POSTs to ClipBrain server, manages offline queue.

const GBRAIN_URL = "http://localhost:19285/api/capture";
const GBRAIN_YOUTUBE_URL = "http://localhost:19285/api/capture-youtube";
const GBRAIN_STATS_URL = "http://localhost:19285/api/stats";
const QUEUE_KEY = "captureQueue";
const CAPTURE_COUNT_KEY = "captureCount";
const MAX_QUEUE = 100;
const FLUSH_ALARM = "flushQueue";

// ─── Command listener ────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-page") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    // Gmail: trigger the already-injected gmail content script
    if (tab.url && tab.url.includes("mail.google.com")) {
      chrome.tabs.sendMessage(tab.id, { type: "trigger-gmail-capture" });
      return;
    }

    // Default: inject content script + readability lib into the active tab
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/readability.js", "content-script.js"],
    });
  } catch (err) {
    console.error("Failed to inject content script:", err);
    setTempBadge("!", "#cc0000", 3000);
  }
});

// ─── Message listener (from content script) ──────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "captured" || msg.type === "kindle-import") {
    handleCapture(msg, sender.tab?.id).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // Keep message port open for async response
  }

  if (msg.type === "gmail-capture") {
    handleGmailCapture(msg, sender.tab?.id).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "youtube-capture") {
    handleYouTubeCapture(msg, sender.tab?.id).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "content-script-error") {
    console.error("ClipBrain content script error:", msg.error);
    notifyTab(sender.tab?.id, false, "ClipBrain: " + (msg.error || "Failed to extract page content"));
    setTempBadge("!", "#cc0000", 3000);
    return;
  }
});

async function handleCapture(data, tabId) {
  const payload = {
    url: data.url,
    title: data.title,
    content: data.content,
    selection: data.selection,
    capturedAt: new Date().toISOString(),
  };

  try {
    const resp = await fetch(GBRAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok || resp.status === 202) {
      await incrementCaptureCount();
      notifyTab(tabId, true);
    } else {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server returned HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn("ClipBrain capture failed:", err.message);
    // If it looks like a network error (server unreachable), queue for retry
    if (err.message.includes("fetch") || err.message.includes("Failed") || err.message.includes("NetworkError")) {
      await enqueue(payload);
      notifyTab(tabId, false, "ClipBrain offline — capture queued for retry");
      ensureAlarm();
    } else {
      notifyTab(tabId, false, "Capture failed: " + err.message);
    }
    setTempBadge("!", "#cc0000", 3000);
  }
}

async function handleGmailCapture(data, tabId) {
  // Build a gmail:// URL for dedup and slug generation
  // Use subject + sender as the identity (Gmail URLs contain thread IDs but are unstable)
  const subjectSlug = (data.subject || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const fromSlug = (data.fromSlug || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const gmailUrl = `gmail://${fromSlug}/${subjectSlug}`;

  const payload = {
    url: gmailUrl,
    title: data.title || data.subject || 'Untitled email',
    content: data.body || '',
    selection: null,
    capturedAt: new Date().toISOString(),
    // Extra metadata for the server
    emailFrom: data.from || '',
    emailDate: data.date || '',
    emailSubject: data.subject || '',
  };

  try {
    const resp = await fetch(GBRAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok || resp.status === 202) {
      await incrementCaptureCount();
      notifyTab(tabId, true, "Email saved to ClipBrain \u2713");
    } else {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server returned HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn("ClipBrain Gmail capture failed:", err.message);
    if (err.message.includes("fetch") || err.message.includes("Failed") || err.message.includes("NetworkError")) {
      await enqueue(payload);
      notifyTab(tabId, false, "ClipBrain offline — email queued for retry");
      ensureAlarm();
    } else {
      notifyTab(tabId, false, "Email capture failed: " + err.message);
    }
    setTempBadge("!", "#cc0000", 3000);
  }
}

async function handleYouTubeCapture(data, tabId) {
  const payload = {
    url: data.url,
    videoId: data.videoId,
    title: data.title,
    channel: data.channel,
  };

  try {
    const resp = await fetch(GBRAIN_YOUTUBE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok || resp.status === 202) {
      await incrementCaptureCount();
      notifyTab(tabId, true, "Saved transcript to ClipBrain \u2713");
    } else if (resp.status === 422) {
      const body = await resp.json().catch(() => ({}));
      notifyTab(tabId, false, body.error || "No transcript available for this video");
    } else {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server returned HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn("ClipBrain YouTube capture failed:", err.message);
    if (err.message.includes("fetch") || err.message.includes("Failed") || err.message.includes("NetworkError")) {
      await enqueue({ ...payload, _type: "youtube" });
      notifyTab(tabId, false, "ClipBrain offline — capture queued for retry");
      ensureAlarm();
    } else {
      notifyTab(tabId, false, err.message || "YouTube capture failed");
    }
    setTempBadge("!", "#cc0000", 3000);
  }
}

// ─── Toast notification on the page ──────────────────────────────────
function notifyTab(tabId, success, customMessage) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["toast.js"],
  }).then(() => {
    chrome.tabs.sendMessage(tabId, {
      type: "showToast",
      success,
      message: customMessage || null,
    });
  }).catch(() => {
    // Tab may have been closed or is a restricted page — ignore
  });
}

// ─── Badge helpers ───────────────────────────────────────────────────
function setBadge(text, color) {
  if (!chrome.action) return;
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function setTempBadge(text, color, ms = 2000) {
  setBadge(text, color);
  setTimeout(() => updateBadgeFromCount(), ms);
}

async function incrementCaptureCount() {
  const { [CAPTURE_COUNT_KEY]: count = 0 } = await chrome.storage.local.get(CAPTURE_COUNT_KEY);
  const newCount = count + 1;
  await chrome.storage.local.set({ [CAPTURE_COUNT_KEY]: newCount });
  setBadge(newCount.toString(), "#4ade80");
}

async function updateBadgeFromCount() {
  const { [CAPTURE_COUNT_KEY]: count = 0 } = await chrome.storage.local.get(CAPTURE_COUNT_KEY);
  if (count > 0) {
    setBadge(count.toString(), "#4ade80");
  } else {
    setBadge("", "#4ade80");
  }
}

async function syncBadgeFromServer() {
  try {
    const resp = await fetch(GBRAIN_STATS_URL, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const stats = await resp.json();
    const total = (stats.articles || 0) + (stats.books || 0) + (stats.videos || 0);
    if (total > 0) {
      await chrome.storage.local.set({ [CAPTURE_COUNT_KEY]: total });
      setBadge(total.toString(), "#4ade80");
    }
  } catch {
    // Server offline — don't show badge
  }
}

// ─── Offline queue ───────────────────────────────────────────────────
async function enqueue(item) {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  queue.push(item);
  // FIFO eviction: drop oldest if over limit
  while (queue.length > MAX_QUEUE) {
    queue.shift();
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function flushQueue() {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  if (queue.length === 0) return;

  const remaining = [];
  for (const item of queue) {
    try {
      const resp = await fetch(GBRAIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      if (!resp.ok && resp.status !== 202) {
        remaining.push(item);
      }
    } catch {
      // Still offline — keep the rest and stop trying
      remaining.push(...queue.slice(queue.indexOf(item)));
      break;
    }
  }

  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });

  if (remaining.length === 0) {
    setTempBadge("\u2713", "#22863a", 2000);
  }
}

// ─── Alarm for queue flush ───────────────────────────────────────────
function ensureAlarm() {
  chrome.alarms.get(FLUSH_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    flushQueue();
  }
});

// On startup, try to flush any queued items and sync badge
flushQueue();
syncBadgeFromServer();
