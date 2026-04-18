// ClipBrain — Gmail Content Script
// Auto-injected on mail.google.com to capture emails and newsletters.
// Extracts subject, sender, date, and clean body text from the open email.

(function () {
  if (window.__clipbrainGmailReady) return;
  window.__clipbrainGmailReady = true;

  // ─── Gmail DOM selectors ─────────────────────────────────────────────
  // Gmail's DOM is complex but these selectors have been stable for years.
  // We use multiple fallbacks for each field.

  const SELECTORS = {
    // Email body — the main content area of an open email
    body: [
      '.a3s.aiL',           // Standard email body container
      '.a3s',               // Fallback without aiL
      '.ii.gt',             // Alternative body container
      'div[data-message-id] .a3s',
    ],
    // Subject line
    subject: [
      'h2.hP',             // Conversation subject heading
      'h2[data-thread-perm-id]',
      '.ha h2',            // Subject within header area
    ],
    // Sender name + email
    sender: [
      '.gD',               // Sender element with email attribute
      'span[email]',       // Any span with email attr
      '.go',               // Sender name in compact view
    ],
    // Date/timestamp
    date: [
      '.g3',               // Date string element
      'span.g3',
      '.gH .gK span[title]', // Date with full timestamp in title attr
    ],
    // Detect if an email is open (conversation view)
    emailOpen: [
      '.h7',               // Conversation view container
      '.adn.ads',          // Message pane
      'div[role="list"]',  // Message list in conversation
    ],
  };

  function q(selectorList) {
    for (const sel of selectorList) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function qAll(selectorList) {
    for (const sel of selectorList) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return Array.from(els);
    }
    return [];
  }

  // ─── Extraction ──────────────────────────────────────────────────────

  function extractEmail() {
    // Subject
    const subjectEl = q(SELECTORS.subject);
    const subject = subjectEl?.textContent?.trim() || '';

    if (!subject) {
      return null; // No email open
    }

    // Sender — get from the most recent (last) message in the thread
    const senderEls = qAll(SELECTORS.sender);
    let from = '';
    let fromEmail = '';
    if (senderEls.length > 0) {
      // Last sender in thread = most recent message
      const lastSender = senderEls[senderEls.length - 1];
      from = lastSender.getAttribute('name') || lastSender.textContent?.trim() || '';
      fromEmail = lastSender.getAttribute('email') || '';
    }

    // Date — get from the most recent message
    let date = '';
    const dateEls = qAll(SELECTORS.date);
    if (dateEls.length > 0) {
      const lastDate = dateEls[dateEls.length - 1];
      // title attr has the full datetime, textContent has relative like "10:30 AM"
      date = lastDate.getAttribute('title') || lastDate.textContent?.trim() || '';
    }

    // Body — extract clean text from all messages in the thread
    const bodyEls = qAll(SELECTORS.body);
    let bodyText = '';

    if (bodyEls.length > 0) {
      // For threads, join all message bodies
      const parts = [];
      for (const el of bodyEls) {
        const text = extractCleanText(el);
        if (text) parts.push(text);
      }
      bodyText = parts.join('\n\n---\n\n');
    }

    if (!bodyText) {
      return null; // No content to capture
    }

    return { subject, from, fromEmail, date, body: bodyText };
  }

  function extractCleanText(el) {
    // Clone to avoid modifying the live DOM
    const clone = el.cloneNode(true);

    // Remove Gmail UI elements that leak into the body
    const junk = clone.querySelectorAll(
      '.gmail_signature, .gmail_extra, .gmail_quote_attribution, ' +
      'style, script, .adL, .adM, ' +
      'img[src*="ci6.googleusercontent.com"], ' + // tracking pixels
      'img[width="1"][height="1"], ' +             // 1x1 tracking pixels
      'img[style*="display:none"], ' +
      'div[style*="display:none"]'
    );
    for (const j of junk) j.remove();

    // Get text, preserving some structure
    let text = '';
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim();
        if (t) text += t + ' ';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === 'BR' || tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'H1' || tag === 'H2' || tag === 'H3') {
          text += '\n';
        }
        if (tag === 'A' && node.href && !node.href.startsWith('mailto:')) {
          // Preserve links inline
          const linkText = node.textContent?.trim();
          if (linkText && linkText !== node.href) {
            text += `[${linkText}](${node.href}) `;
            // Skip children since we already captured the text
            walker.nextSibling();
            continue;
          }
        }
      }
    }

    // Clean up whitespace
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ─── Quoted/forwarded content detection ──────────────────────────────

  function extractWithQuotedSections(el) {
    const clone = el.cloneNode(true);

    // Find quoted content (Gmail wraps it in .gmail_quote)
    const quotes = clone.querySelectorAll('.gmail_quote');
    let quotedText = '';
    for (const quote of quotes) {
      quotedText += '\n\n> ' + extractCleanText(quote).replace(/\n/g, '\n> ');
      quote.remove();
    }

    const mainText = extractCleanText(clone);
    return mainText + (quotedText ? '\n\n---\n**Quoted:**\n' + quotedText : '');
  }

  // ─── Capture flow ────────────────────────────────────────────────────

  function captureCurrentEmail() {
    const data = extractEmail();
    if (!data) {
      chrome.runtime.sendMessage({
        type: 'content-script-error',
        error: 'No email is open. Open an email and try again.',
      });
      return;
    }

    const fromDisplay = data.fromEmail
      ? `${data.from} <${data.fromEmail}>`
      : data.from;

    // Build a clean title: "Subject — From"
    const title = data.from
      ? `${data.subject} — ${data.from}`
      : data.subject;

    chrome.runtime.sendMessage({
      type: 'gmail-capture',
      subject: data.subject,
      from: fromDisplay,
      fromSlug: data.from || data.fromEmail || 'unknown',
      date: data.date,
      body: data.body,
      title: title,
      url: location.href,
    });
  }

  // ─── Listen for capture trigger from service worker ──────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'trigger-gmail-capture') {
      captureCurrentEmail();
    }
  });

  // ─── Floating "Clip" button ──────────────────────────────────────────

  let clipBtn = null;
  let lastEmailSubject = '';

  function createClipButton() {
    if (clipBtn) return;

    clipBtn = document.createElement('button');
    clipBtn.id = 'clipbrain-gmail-clip';
    clipBtn.textContent = 'Clip to ClipBrain';

    Object.assign(clipBtn.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '2147483647',
      padding: '10px 18px',
      borderRadius: '8px',
      fontSize: '13px',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontWeight: '500',
      color: '#fff',
      background: '#1a1a2e',
      border: 'none',
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      transition: 'all 0.2s ease',
      opacity: '0',
      transform: 'translateY(8px)',
    });

    clipBtn.addEventListener('mouseenter', () => {
      clipBtn.style.background = '#16213e';
    });
    clipBtn.addEventListener('mouseleave', () => {
      clipBtn.style.background = '#1a1a2e';
    });

    clipBtn.addEventListener('click', () => {
      clipBtn.disabled = true;
      clipBtn.textContent = 'Clipping...';
      clipBtn.style.cursor = 'wait';
      captureCurrentEmail();

      // The toast will handle success/failure UI,
      // but reset button state after a delay
      setTimeout(() => {
        clipBtn.disabled = false;
        clipBtn.textContent = 'Clip to ClipBrain';
        clipBtn.style.cursor = 'pointer';
      }, 2000);
    });

    document.body.appendChild(clipBtn);

    // Animate in
    requestAnimationFrame(() => {
      clipBtn.style.opacity = '1';
      clipBtn.style.transform = 'translateY(0)';
    });
  }

  function removeClipButton() {
    if (clipBtn) {
      clipBtn.style.opacity = '0';
      clipBtn.style.transform = 'translateY(8px)';
      setTimeout(() => {
        clipBtn?.remove();
        clipBtn = null;
      }, 200);
    }
  }

  // ─── Watch for email open/close ──────────────────────────────────────
  // Gmail is an SPA — we poll for state changes.

  function checkEmailState() {
    const subjectEl = q(SELECTORS.subject);
    const subject = subjectEl?.textContent?.trim() || '';

    if (subject && subject !== lastEmailSubject) {
      // New email opened
      lastEmailSubject = subject;
      createClipButton();
    } else if (!subject && lastEmailSubject) {
      // Email closed (back to inbox)
      lastEmailSubject = '';
      removeClipButton();
    }
  }

  // Poll every 1s for email state changes
  setInterval(checkEmailState, 1000);

  // Also observe DOM mutations for faster detection
  const observer = new MutationObserver(() => {
    checkEmailState();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });

  // Initial check
  checkEmailState();

  console.log('ClipBrain Gmail: content script loaded');
})();
