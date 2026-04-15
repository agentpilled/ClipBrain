// ClipBrain Popup — vanilla JS

const API_BASE = "http://localhost:19285";

// ─── DOM refs ────────────────────────────────────────────────────────
const $onboarding = document.getElementById("onboarding");
const $main = document.getElementById("main");
const $statusDot = document.getElementById("statusDot");
const $searchInput = document.getElementById("searchInput");
const $searchResults = document.getElementById("searchResults");
const $recentSection = document.getElementById("recentSection");
const $recentList = document.getElementById("recentList");
const $emptyState = document.getElementById("emptyState");
const $statsBar = document.getElementById("statsBar");
const $onlineContent = document.getElementById("onlineContent");
const $offlineContent = document.getElementById("offlineContent");

// ─── Helpers ─────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function apiFetch(path) {
  const resp = await fetch(API_BASE + path);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  if (diff < 604800000) return Math.floor(diff / 86400000) + "d ago";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function iconForType(item) {
  if (item.type === "kindle" || (item.slug && item.slug.startsWith("kindle/"))) return "\u{1F4D6}";
  return "\u{1F310}";
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "\u2026" : str;
}

function renderItem(item) {
  const el = document.createElement("div");
  el.className = "item";
  el.title = "Click to copy title";
  el.innerHTML = `
    <span class="item-icon">${iconForType(item)}</span>
    <div class="item-body">
      <div class="item-title">${escapeHtml(truncate(item.title || item.slug || "Untitled", 60))}</div>
      ${item.snippet ? `<div class="item-snippet">${escapeHtml(truncate(item.snippet, 80))}</div>` : ""}
    </div>
    <span class="item-date">${formatDate(item.date || item.captured_at)}</span>
  `;
  el.addEventListener("click", () => {
    navigator.clipboard.writeText(item.title || item.slug || "");
  });
  return el;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setupCopyBox(boxId, toastId) {
  const box = document.getElementById(boxId);
  const toast = document.getElementById(toastId);
  if (!box || !toast) return;
  box.addEventListener("click", () => {
    const text = box.querySelector("span:last-child")?.textContent || "";
    navigator.clipboard.writeText(text).then(() => {
      toast.classList.add("visible");
      setTimeout(() => toast.classList.remove("visible"), 1500);
    });
  });
}

// ─── Onboarding ──────────────────────────────────────────────────────

function showStep(n) {
  document.querySelectorAll(".onboarding-step").forEach((el) => el.classList.remove("active"));
  const step = document.getElementById("step" + n);
  if (step) step.classList.add("active");
}

function setupOnboarding() {
  document.getElementById("onb-next1")?.addEventListener("click", () => showStep(2));
  document.getElementById("onb-next2")?.addEventListener("click", () => showStep(3));
  document.getElementById("onb-skip2")?.addEventListener("click", () => showStep(3));
  document.getElementById("onb-done")?.addEventListener("click", () => {
    chrome.storage.local.set({ onboardingDone: true });
    $onboarding.style.display = "none";
    $main.style.display = "block";
    loadMainContent();
  });
  setupCopyBox("onb-cmd", "onb-copied");
}

// ─── Search ──────────────────────────────────────────────────────────

const doSearch = debounce(async (query) => {
  if (!query.trim()) {
    $searchResults.innerHTML = "";
    $recentSection.style.display = "";
    return;
  }

  $searchResults.innerHTML = '<div class="search-loading">Searching...</div>';
  $recentSection.style.display = "none";

  try {
    const data = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
    $searchResults.innerHTML = "";
    if (data.results && data.results.length > 0) {
      data.results.forEach((item) => $searchResults.appendChild(renderItem(item)));
    } else {
      $searchResults.innerHTML = '<div class="search-loading">No results found</div>';
    }
  } catch {
    $searchResults.innerHTML = '<div class="search-loading">Search failed</div>';
  }
}, 300);

// ─── Load main content ──────────────────────────────────────────────

async function loadMainContent() {
  // Load recent captures
  try {
    const data = await apiFetch("/api/recent?limit=10");
    $recentList.innerHTML = "";
    if (data.results && data.results.length > 0) {
      data.results.forEach((item) => $recentList.appendChild(renderItem(item)));
      $recentSection.style.display = "";
      $emptyState.style.display = "none";
    } else {
      $recentSection.style.display = "none";
      $emptyState.style.display = "";
    }
  } catch {
    $recentSection.style.display = "none";
    $emptyState.style.display = "";
  }

  // Load stats
  try {
    const stats = await apiFetch("/api/stats");
    const parts = [];
    if (stats.articles != null) parts.push(`${stats.articles} articles`);
    if (stats.books != null) parts.push(`${stats.books} books`);
    if (stats.highlights != null) parts.push(`${stats.highlights} highlights`);
    if (parts.length > 0) {
      $statsBar.innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
      $statsBar.style.display = "";
    }
  } catch {
    $statsBar.style.display = "none";
  }
}

// ─── Capture current page ────────────────────────────────────────────

function setupCaptureButton() {
  const btn = document.getElementById("captureBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.textContent = "Capturing...";
    btn.classList.add("capturing");
    btn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");

      // Inject content script + readability
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/readability.js", "content-script.js"],
      });

      // Wait for the content script to send the message and service worker to process it
      // Listen for completion via a short poll of the badge or just wait
      btn.textContent = "✓ Captured!";
      btn.classList.remove("capturing");
      btn.classList.add("done");

      // Refresh the recent list after a brief delay
      setTimeout(() => {
        loadMainContent();
        btn.textContent = "⬇️ Capture this page";
        btn.classList.remove("done");
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      console.error("Capture failed:", err);
      btn.textContent = "Failed — try Cmd+Shift+S";
      btn.classList.remove("capturing");
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = "⬇️ Capture this page";
      }, 3000);
    }
  });
}

// ─── Init ────────────────────────────────────────────────────────────

async function init() {
  setupOnboarding();
  setupCopyBox("offlineCmd", "offlineCopied");
  setupCaptureButton();

  $searchInput.addEventListener("input", (e) => doSearch(e.target.value));

  // Check server health
  let online = false;
  try {
    const resp = await fetch(API_BASE + "/health", { signal: AbortSignal.timeout(2000) });
    online = resp.ok;
  } catch {
    online = false;
  }

  $statusDot.classList.toggle("connected", online);
  $statusDot.title = online ? "Server connected" : "Server offline";

  if (!online) {
    $main.style.display = "block";
    $onlineContent.style.display = "none";
    $offlineContent.style.display = "";
    return;
  }

  // Check onboarding
  const { onboardingDone } = await chrome.storage.local.get("onboardingDone");

  if (!onboardingDone) {
    // Check if there are any captures — if so, skip onboarding
    try {
      const stats = await apiFetch("/api/stats");
      const total = (stats.articles || 0) + (stats.books || 0) + (stats.highlights || 0);
      if (total > 0) {
        await chrome.storage.local.set({ onboardingDone: true });
        $main.style.display = "block";
        loadMainContent();
        return;
      }
    } catch {
      // If stats fail, show onboarding anyway
    }
    $onboarding.style.display = "block";
    return;
  }

  $main.style.display = "block";
  loadMainContent();
}

init();
