// ClipBrain — Toast notification (injected into the page)

(function () {
  // Only set up the listener once
  if (window.__gbrainToastReady) return;
  window.__gbrainToastReady = true;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "showToast") return;
    showToast(msg.success);
  });

  function showToast(success) {
    // Remove any existing toast
    const existing = document.getElementById("gbrain-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "gbrain-toast";
    toast.textContent = success
      ? "Saved to ClipBrain \u2713"
      : "ClipBrain offline, queued";

    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      padding: "12px 20px",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontWeight: "500",
      color: "#fff",
      background: success ? "#22863a" : "#b08800",
      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      opacity: "0",
      transform: "translateY(8px)",
      transition: "opacity 0.2s ease, transform 0.2s ease",
      pointerEvents: "none",
    });

    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    // Auto-dismiss after 2 seconds
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }
})();
