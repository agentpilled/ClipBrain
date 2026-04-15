// ClipBrain — Kindle Notebook Content Script
// Activates on read.amazon.com/notebook* to import Kindle highlights.
// Clicks through each book in the sidebar, extracts highlights, sends to ClipBrain.

(function () {
  if (window.__gbrainKindleReady) return;
  window.__gbrainKindleReady = true;

  // ─── Button creation ────────────────────────────────────────────────
  const btn = document.createElement("button");
  btn.id = "gbrain-kindle-import";
  btn.textContent = "Import to ClipBrain";

  Object.assign(btn.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "2147483647",
    padding: "12px 20px",
    borderRadius: "8px",
    fontSize: "14px",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontWeight: "500",
    color: "#fff",
    background: "#1a1a2e",
    border: "none",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
    transition: "opacity 0.2s ease, transform 0.2s ease",
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.background = "#16213e";
  });
  btn.addEventListener("mouseleave", () => {
    if (!btn.dataset.done) btn.style.background = "#1a1a2e";
  });

  document.body.appendChild(btn);

  // ─── Sidebar book discovery ────────────────────────────────────────
  // The Amazon Notebook sidebar lists books. Each book is a clickable element
  // with a cover image, title, and "By: Author" text.

  async function findSidebarBooks() {
    // Wait for books to load in the DOM (Amazon loads them async)
    for (let attempt = 0; attempt < 10; attempt++) {
      const books = document.querySelectorAll(".kp-notebook-library-each-book");
      if (books.length > 0) {
        console.log("ClipBrain Kindle: found", books.length, "books via .kp-notebook-library-each-book (attempt", attempt + 1, ")");
        return Array.from(books);
      }
      console.log("ClipBrain Kindle: waiting for books to load... (attempt", attempt + 1, ")");
      await delay(1000);
    }

    console.log("ClipBrain Kindle: no books found after 10 attempts");
    return [];
  }

  function getBookInfoFromSidebar(bookEl) {
    // bookEl might be an <img> (book cover) — walk up to find title/author
    const container = bookEl.closest ?
      (bookEl.closest('[class*="book"]') || bookEl.parentElement?.parentElement?.parentElement) :
      bookEl;

    const searchArea = container || bookEl.parentElement || bookEl;

    let title = null;
    const headings = searchArea.querySelectorAll("h2, h3, h4, b, strong, [class*='title'], span, div");
    for (const h of headings) {
      const t = h.textContent.trim();
      if (t && t.length > 2 && t.length < 200 && !t.startsWith("By") && !t.includes("ANNOTATED")) {
        // Skip if this element has many children (it's a container, not a title)
        if (h.children.length <= 2) {
          title = t;
          break;
        }
      }
    }

    let author = null;
    const allText = searchArea.querySelectorAll("span, p, div, small");
    for (const el of allText) {
      const t = el.textContent.trim();
      if (/^By[:\s]/i.test(t) && t.length < 200) {
        author = t.replace(/^By[:\s]+/i, "").trim();
        break;
      }
    }

    return { title, author };
  }

  // ─── Main content area parsing ─────────────────────────────────────
  // After clicking a book in the sidebar, highlights load in the main area.
  // Format: "Yellow highlight | Page: N" followed by highlight text, optional "Note:" text.

  function extractBookInfoFromHeader() {
    let title = null;
    let author = null;

    // The Amazon Notebook header structure:
    // "YOUR KINDLE NOTES FOR:" (small text)
    // "Book Title" (large heading)
    // "Author Name" (below title)
    // "Last accessed on ..."

    // Find title: look for the heading after "YOUR KINDLE NOTES FOR"
    const allH3 = document.querySelectorAll("h3");
    for (const h of allH3) {
      const t = h.textContent.trim();
      if (t && t.length > 3 && !t.includes("ANNOTATED") && !t.includes("Notes and Highlights")) {
        title = t;
        break;
      }
    }

    // Find author: text immediately after title that contains the author name
    // From screenshot: "Anthony de Mello, SJ and J. Francis Stroud"
    // Usually in a span/p right after the title, often starting without "By:"
    // Exclude known non-author text
    const skipTexts = [
      "settings", "options", "your kindle", "notes and highlights",
      "annotated", "highlight", "page:", "location", "last accessed",
      "search", "note", "most recently", "january", "february", "march",
      "april", "may", "june", "july", "august", "september", "october",
      "november", "december", "monday", "tuesday", "wednesday", "thursday",
      "friday", "saturday", "sunday"
    ];

    if (title) {
      // From the screenshot, author is right below the title in the header area.
      // It's a standalone text like "Anthony de Mello, SJ and J. Francis Stroud"
      // Strategy: find the H3 with the title, then look at its next siblings
      const allH3 = document.querySelectorAll("h3");
      for (const h of allH3) {
        if (h.textContent.trim() === title) {
          // Walk next siblings of the h3's parent to find author
          let sibling = h.nextElementSibling;
          let checked = 0;
          while (sibling && checked < 5) {
            const t = sibling.textContent.trim();
            const lower = t.toLowerCase();

            // Skip empty, skip known non-author patterns
            if (!t || t.length < 3 || t.length > 200) { sibling = sibling.nextElementSibling; checked++; continue; }
            if (skipTexts.some(s => lower.includes(s))) { sibling = sibling.nextElementSibling; checked++; continue; }
            if (/^\d/.test(t)) { sibling = sibling.nextElementSibling; checked++; continue; }
            if (/Highlights?\s*\|/i.test(t)) { sibling = sibling.nextElementSibling; checked++; continue; }
            if (/^(Yellow|Blue|Pink|Orange)/i.test(t)) break; // Hit highlights, stop

            // This is likely the author
            author = t.replace(/^By[:\s]+/i, "").trim();
            break;
          }
          break;
        }
      }
    }

    return { title, author };
  }

  function extractHighlightsFromMainContent() {
    const highlights = [];
    const notes = [];

    // Strategy: get the full text content of the main area and parse it structurally.
    // The page has a repeating pattern:
    //   "Yellow highlight | Page: N"  "Options"
    //   <highlight text>
    //   (optionally) "Note:" <note text>
    //
    // Instead of walking DOM siblings (fragile), we grab ALL text nodes from the
    // main content area and parse them as a stream.

    // First, try to find all elements with id="highlight" or id="note" (Amazon uses these)
    const highlightEls = document.querySelectorAll('#highlight, [id="highlight"]');
    const noteEls = document.querySelectorAll('#note, [id="note"]');

    if (highlightEls.length > 0) {
      // Amazon uses id="highlight" and id="note" (non-unique IDs, but querySelectorAll gets all)
      // We need to pair each highlight with its page number and optional note

      // Collect all metadata headers to get page numbers
      const metaHeaders = [];
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        if (el.children.length <= 3) {
          const t = el.textContent.trim();
          if (/^(Yellow|Blue|Pink|Orange)\s+highlight\s*\|\s*Page/i.test(t) && t.length < 80) {
            const pageMatch = t.match(/Page[:\s]+(\d+)/i);
            const colorMatch = t.match(/^(\w+)\s+highlight/i);
            metaHeaders.push({
              el,
              page: pageMatch ? pageMatch[1] : null,
              color: colorMatch ? colorMatch[1].toLowerCase() : null,
            });
          }
        }
      }

      // Similarly collect "Note:" metadata headers
      const noteHeaders = [];
      for (const el of allEls) {
        if (el.children.length <= 3) {
          const t = el.textContent.trim();
          if (/^Note\s*\|\s*Page/i.test(t) && t.length < 80) {
            const pageMatch = t.match(/Page[:\s]+(\d+)/i);
            noteHeaders.push({
              el,
              page: pageMatch ? pageMatch[1] : null,
            });
          }
        }
      }

      // Now match highlight elements with their metadata by DOM order
      for (let i = 0; i < highlightEls.length; i++) {
        const text = highlightEls[i].textContent.trim();
        if (text && text.length > 3) {
          const meta = metaHeaders[i] || {};
          highlights.push({
            text,
            page: meta.page || null,
            color: meta.color || null,
          });
        }
      }

      for (let i = 0; i < noteEls.length; i++) {
        const text = noteEls[i].textContent.trim();
        if (text && text.length > 1) {
          const meta = noteHeaders[i] || {};
          notes.push({
            text,
            page: meta.page || null,
          });
        }
      }

      console.log(`ClipBrain Kindle: found ${highlights.length} highlights, ${notes.length} notes via id selectors`);
      return { highlights, notes };
    }

    // Fallback: text-stream parsing approach
    // Get all leaf text elements in the main content area (right of sidebar)
    const mainArea = document.querySelector('[class*="annotation-scroller"], [class*="notebook-content"], main') || document.body;
    const walker = document.createTreeWalker(mainArea, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const rect = node.parentElement?.getBoundingClientRect();
        if (rect && rect.left > 150) return NodeFilter.FILTER_ACCEPT; // Skip sidebar
        return NodeFilter.FILTER_REJECT;
      }
    });

    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      const t = node.textContent.trim();
      if (t && t.length > 1) textNodes.push(t);
    }

    // Parse the text stream
    let currentPage = null;
    let currentColor = null;

    for (let i = 0; i < textNodes.length; i++) {
      const t = textNodes[i];

      // Is this a highlight metadata line?
      const hlMatch = t.match(/^(Yellow|Blue|Pink|Orange)\s+highlight\s*\|\s*Page[:\s]+(\d+)/i);
      if (hlMatch) {
        currentColor = hlMatch[1].toLowerCase();
        currentPage = hlMatch[2];
        continue;
      }

      // Is this a note metadata line?
      const noteMatch = t.match(/^Note\s*\|\s*Page[:\s]+(\d+)/i);
      if (noteMatch) {
        currentPage = noteMatch[1];
        // Next non-metadata text is the note content
        continue;
      }

      // Skip UI elements
      if (t === "Options" || t === "Search" || t === "Settings" || /^ANNOTATED/i.test(t)) continue;
      if (/^(Yellow|Blue|Pink|Orange)\s+highlight/i.test(t)) continue;
      if (/^\d+\s+Highlights?\s*\|/i.test(t)) continue;
      if (/^YOUR KINDLE/i.test(t)) continue;
      if (/^Last accessed/i.test(t)) continue;
      if (/^Note\s*\|/i.test(t)) continue;

      // Is this a "Note:" prefixed inline note?
      if (/^Note:/i.test(t)) {
        notes.push({ text: t.replace(/^Note:\s*/i, "").trim(), page: currentPage });
        continue;
      }

      // Otherwise this is highlight text (if we have a current page context)
      if (t.length > 5 && currentPage) {
        highlights.push({ text: t, page: currentPage, color: currentColor });
      }
    }

    console.log(`ClipBrain Kindle: found ${highlights.length} highlights, ${notes.length} notes via text-stream parsing`);
    return { highlights, notes };
  }

  // ─── Markdown formatting ───────────────────────────────────────────

  function formatBookMarkdown(title, author, highlights, notes) {
    const lines = [];

    if (highlights.length > 0) {
      lines.push("## Highlights", "");
      for (const h of highlights) {
        const loc = h.page ? ` (Page ${h.page})` : "";
        const colorTag = h.color && h.color !== "yellow" ? ` [${h.color}]` : "";
        // Escape any markdown chars in highlight text
        const text = h.text.replace(/^[>#-]/gm, "\\$&");
        lines.push(`> ${text}${loc}${colorTag}`, "");
      }
    }

    if (notes.length > 0) {
      lines.push("## Notes", "");
      for (const n of notes) {
        const loc = n.page ? ` (Page ${n.page})` : "";
        lines.push(`- ${n.text}${loc}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Choice menu ────────────────────────────────────────────────────

  let menu = null;

  async function showImportMenu() {
    if (menu) { menu.remove(); menu = null; return; }

    btn.textContent = "Scanning...";
    btn.disabled = true;
    const sidebarBooks = await findSidebarBooks();
    btn.textContent = "Import to ClipBrain";
    btn.disabled = false;
    const { title: currentTitle } = extractBookInfoFromHeader();

    menu = document.createElement("div");
    Object.assign(menu.style, {
      position: "fixed",
      bottom: "68px",
      right: "24px",
      zIndex: "2147483647",
      background: "#1a1a2e",
      borderRadius: "10px",
      padding: "8px 0",
      boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontSize: "14px",
      minWidth: "220px",
      overflow: "hidden",
    });

    function addOption(label, sublabel, onclick) {
      const opt = document.createElement("div");
      opt.innerHTML = `<div style="font-weight:500;color:#fff">${label}</div>` +
        (sublabel ? `<div style="font-size:11px;color:#999;margin-top:2px">${sublabel}</div>` : "");
      Object.assign(opt.style, {
        padding: "10px 16px",
        cursor: "pointer",
        transition: "background 0.15s",
      });
      opt.addEventListener("mouseenter", () => opt.style.background = "#16213e");
      opt.addEventListener("mouseleave", () => opt.style.background = "transparent");
      opt.addEventListener("click", () => { menu.remove(); menu = null; onclick(); });
      menu.appendChild(opt);
    }

    // Option 1: Current book
    if (currentTitle) {
      const shortTitle = currentTitle.length > 35 ? currentTitle.slice(0, 35) + "..." : currentTitle;
      addOption(
        `📖 This book`,
        shortTitle,
        () => importCurrentBookOnly()
      );
    }

    // Divider
    if (currentTitle && sidebarBooks.length > 0) {
      const hr = document.createElement("div");
      hr.style.cssText = "height:1px;background:#333;margin:4px 0";
      menu.appendChild(hr);
    }

    // Option 2: All books
    if (sidebarBooks.length > 0) {
      addOption(
        `📚 All books (${sidebarBooks.length})`,
        "Clicks through each book automatically",
        () => importAllBooks(sidebarBooks)
      );
    }

    // If neither option is available
    if (!currentTitle && sidebarBooks.length === 0) {
      addOption("No books found", "Try refreshing the page", () => {});
    }

    document.body.appendChild(menu);

    // Close menu when clicking outside
    const closeHandler = (e) => {
      if (menu && !menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        menu = null;
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 50);
  }

  // ─── Import logic ──────────────────────────────────────────────────

  async function importCurrentBookOnly() {
    btn.disabled = true;
    btn.style.cursor = "wait";
    btn.textContent = "Importing...";

    const result = await importCurrentBook();

    if (result.success) {
      showSummaryPanel([result]);
    } else if (result.empty) {
      updateButton("No highlights found", "#b08800");
      shrinkAfterDelay();
    } else {
      updateButton("Import failed — check console", "#cc0000");
      shrinkAfterDelay();
    }
  }

  async function importAllBooks(sidebarBooks) {
    btn.disabled = true;
    btn.style.cursor = "wait";

    const results = [];
    const total = sidebarBooks.length;

    for (let i = 0; i < total; i++) {
      const bookEl = sidebarBooks[i];
      const info = getBookInfoFromSidebar(bookEl);
      const displayName = info.title || `Book ${i + 1}`;
      const shortName = displayName.length > 25 ? displayName.slice(0, 25) + "..." : displayName;

      btn.textContent = `${shortName} (${i + 1}/${total})`;

      try {
        console.log(`ClipBrain Kindle: clicking book ${i + 1}/${total}:`, bookEl.textContent.trim().slice(0, 80));
        // Amazon's click handler is on a child element, not the row itself
        const clickTarget = bookEl.querySelector("img, a, span, div") || bookEl;
        clickTarget.click();
        await delay(2500);

        // Verify the page changed
        const { title: currentTitle } = extractBookInfoFromHeader();
        console.log(`ClipBrain Kindle: after click, current book title: "${currentTitle}"`);

        const result = await importCurrentBook();
        if (result.success || result.failed) {
          results.push(result);
        }
      } catch (err) {
        console.error(`ClipBrain Kindle: failed to import "${displayName}":`, err);
        results.push({ success: false, failed: true, title: displayName, highlights: 0 });
      }
    }

    if (results.length === 0) {
      updateButton("No highlights in any book", "#b08800");
      shrinkAfterDelay();
    } else {
      showSummaryPanel(results);
    }
  }

  async function importCurrentBook() {
    const { title, author } = extractBookInfoFromHeader();

    if (!title) {
      console.warn("ClipBrain Kindle: could not find book title on current page");
      return { success: false, empty: true, highlights: 0, title: "Unknown" };
    }

    const { highlights, notes } = extractHighlightsFromMainContent();

    if (highlights.length === 0 && notes.length === 0) {
      return { success: false, empty: true, highlights: 0, title };
    }

    const content = formatBookMarkdown(title, author, highlights, notes);
    const titleWithAuthor = author ? `${title} by ${author}` : title;

    console.log(`ClipBrain Kindle: importing "${titleWithAuthor}" (${highlights.length} highlights, ${notes.length} notes)`);

    try {
      await sendToGBrain(titleWithAuthor, content);
      return { success: true, highlights: highlights.length, notes: notes.length, title };
    } catch (err) {
      console.error(`ClipBrain Kindle: failed to send "${titleWithAuthor}":`, err);
      return { success: false, failed: true, highlights: 0, title };
    }
  }

  function sendToGBrain(titleWithAuthor, content) {
    const titleSlug = slugify(titleWithAuthor);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "kindle-import",
          url: `kindle://book/${titleSlug}`,
          title: titleWithAuthor,
          content: content,
          selection: null,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  // ─── Summary panel ──────────────────────────────────────────────────

  function showSummaryPanel(results) {
    // Hide the main button
    btn.style.display = "none";

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => r.failed);
    const totalHL = successful.reduce((sum, r) => sum + r.highlights, 0);

    // Pick a book name for the sample prompt
    const sampleBook = successful.length > 0 ? successful[0].title : "your book";
    const shortSample = sampleBook.length > 25 ? sampleBook.slice(0, 25) + "..." : sampleBook;
    const samplePrompt = `What did I highlight in ${shortSample}?`;

    const panel = document.createElement("div");
    panel.id = "gbrain-kindle-summary";
    Object.assign(panel.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      background: "#1a1a2e",
      borderRadius: "12px",
      padding: "20px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      color: "#fff",
      maxWidth: "340px",
      minWidth: "280px",
      lineHeight: "1.5",
    });

    // Header
    const header = document.createElement("div");
    header.style.cssText = "font-size:16px;font-weight:600;margin-bottom:14px;color:#4ade80";
    header.textContent = `✓ Imported to ClipBrain`;
    panel.appendChild(header);

    // Book list
    const bookList = document.createElement("div");
    bookList.style.cssText = "margin-bottom:16px;max-height:180px;overflow-y:auto";

    for (const r of successful) {
      const row = document.createElement("div");
      row.style.cssText = "padding:4px 0;font-size:13px;color:#ccc;display:flex;justify-content:space-between";
      const shortTitle = r.title.length > 30 ? r.title.slice(0, 30) + "..." : r.title;
      row.innerHTML = `<span>📖 ${shortTitle}</span><span style="color:#999;font-size:12px">${r.highlights} hl</span>`;
      bookList.appendChild(row);
    }

    for (const r of failed) {
      const row = document.createElement("div");
      row.style.cssText = "padding:4px 0;font-size:13px;color:#f87171";
      const shortTitle = r.title.length > 30 ? r.title.slice(0, 30) + "..." : r.title;
      row.textContent = `✗ ${shortTitle} — failed`;
      bookList.appendChild(row);
    }

    panel.appendChild(bookList);

    // Total
    const total = document.createElement("div");
    total.style.cssText = "font-size:12px;color:#999;margin-bottom:16px;padding-top:8px;border-top:1px solid #333";
    total.textContent = `${successful.length} book${successful.length !== 1 ? "s" : ""} · ${totalHL} highlights`;
    if (failed.length > 0) total.textContent += ` · ${failed.length} failed`;
    panel.appendChild(total);

    // Try it section
    const tryIt = document.createElement("div");
    tryIt.style.cssText = "margin-bottom:16px";

    const tryLabel = document.createElement("div");
    tryLabel.style.cssText = "font-size:11px;color:#999;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px";
    tryLabel.textContent = "Then ask your AI";
    tryIt.appendChild(tryLabel);

    const promptBox = document.createElement("div");
    Object.assign(promptBox.style, {
      background: "#0f0f23",
      borderRadius: "8px",
      padding: "10px 12px",
      fontSize: "13px",
      color: "#a5b4fc",
      cursor: "pointer",
      border: "1px solid #333",
      transition: "border-color 0.15s",
    });
    promptBox.textContent = `"${samplePrompt}"`;
    promptBox.title = "Click to copy";
    promptBox.addEventListener("mouseenter", () => promptBox.style.borderColor = "#4ade80");
    promptBox.addEventListener("mouseleave", () => promptBox.style.borderColor = "#333");
    promptBox.addEventListener("click", () => {
      navigator.clipboard.writeText(samplePrompt).then(() => {
        promptBox.textContent = "Copied!";
        promptBox.style.color = "#4ade80";
        setTimeout(() => {
          promptBox.textContent = `"${samplePrompt}"`;
          promptBox.style.color = "#a5b4fc";
        }, 1500);
      });
    });
    tryIt.appendChild(promptBox);
    panel.appendChild(tryIt);

    // Next step — connect AI
    const nextStep = document.createElement("div");
    nextStep.style.cssText = "margin-bottom:16px";

    const nextLabel = document.createElement("div");
    nextLabel.style.cssText = "font-size:11px;color:#999;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px";
    nextLabel.textContent = "Next step — Connect your AI";
    nextStep.appendChild(nextLabel);

    const setupCmd = "cd ~/Desktop/gbrain-capture && ./setup-mcp.sh";
    const cmdBox = document.createElement("div");
    Object.assign(cmdBox.style, {
      background: "#0f0f23",
      borderRadius: "8px",
      padding: "10px 12px",
      fontSize: "13px",
      color: "#a5b4fc",
      cursor: "pointer",
      border: "1px solid #333",
      transition: "border-color 0.15s",
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    });
    cmdBox.textContent = "$ " + setupCmd;
    cmdBox.title = "Click to copy";
    cmdBox.addEventListener("mouseenter", () => cmdBox.style.borderColor = "#4ade80");
    cmdBox.addEventListener("mouseleave", () => cmdBox.style.borderColor = "#333");
    cmdBox.addEventListener("click", () => {
      navigator.clipboard.writeText(setupCmd).then(() => {
        cmdBox.textContent = "Copied!";
        cmdBox.style.color = "#4ade80";
        setTimeout(() => {
          cmdBox.textContent = "$ " + setupCmd;
          cmdBox.style.color = "#a5b4fc";
        }, 1500);
      });
    });
    nextStep.appendChild(cmdBox);
    panel.appendChild(nextStep);

    // Bottom buttons
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

    const reimportBtn = document.createElement("button");
    reimportBtn.textContent = "Re-import";
    Object.assign(reimportBtn.style, {
      background: "transparent",
      border: "1px solid #444",
      color: "#ccc",
      padding: "6px 14px",
      borderRadius: "6px",
      fontSize: "12px",
      cursor: "pointer",
    });
    reimportBtn.addEventListener("click", () => {
      panel.remove();
      btn.style.display = "";
      btn.disabled = false;
      btn.style.cursor = "pointer";
      btn.textContent = "Import to ClipBrain";
      btn.style.background = "#1a1a2e";
      btn.style.padding = "12px 20px";
      btn.style.fontSize = "14px";
      btn.dataset.done = "";
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close ✕";
    Object.assign(closeBtn.style, {
      background: "#22863a",
      border: "none",
      color: "#fff",
      padding: "6px 14px",
      borderRadius: "6px",
      fontSize: "12px",
      cursor: "pointer",
    });
    closeBtn.addEventListener("click", () => {
      panel.remove();
      btn.style.display = "";
      btn.style.transition = "all 0.3s ease";
      btn.style.padding = "8px 14px";
      btn.style.fontSize = "12px";
      btn.textContent = "Re-import";
      btn.style.background = "#1a1a2e";
      btn.dataset.done = "";
      btn.disabled = false;
      btn.style.cursor = "pointer";
    });

    buttons.appendChild(reimportBtn);
    buttons.appendChild(closeBtn);
    panel.appendChild(buttons);

    document.body.appendChild(panel);
  }

  // ─── UI helpers ─────────────────────────────────────────────────────

  function updateButton(text, bgColor) {
    btn.textContent = text;
    btn.style.background = bgColor;
    btn.disabled = false;
    btn.style.cursor = "pointer";
    btn.dataset.done = "true";
  }

  function shrinkAfterDelay() {
    setTimeout(() => {
      btn.style.transition = "all 0.3s ease";
      btn.style.padding = "8px 14px";
      btn.style.fontSize = "12px";
      btn.textContent = "Re-import";
      btn.style.background = "#1a1a2e";
      btn.dataset.done = "";
    }, 5000);
  }

  // ─── Attach click handler ──────────────────────────────────────────
  btn.addEventListener("click", () => {
    if (!btn.disabled) showImportMenu();
  });
})();
