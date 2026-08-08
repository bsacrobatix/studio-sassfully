// Narrated-demo drawing surface (POC). Visual language ported from slidey's
// tour overlays (slidey/src/tour/overlays.js): GitHub-dark palette, spotlight
// cutout + dimming via a huge box-shadow, bottom-center caption banner, and a
// brief click-pulse ring. Everything is pointer-events:none so the overlay can
// never swallow a click meant for the page, and it all lives in a closed
// shadow root (same isolation pattern as overlay.mjs).
//
// Import-safe under node: no window/document access at module top level.

export const DEMO_THEME = {
  bg: "rgba(13,17,23,.94)",
  dim: "rgba(2,6,23,.6)",
  accent: "#58a6ff",
  accent2: "#bc8cff",
  border: "#30363d",
  text: "#e6edf3",
  font: "'JetBrains Mono','Courier New',ui-monospace,monospace",
};

let layer = null; // { host, spot, caption }

function ensureLayer(doc) {
  if (layer && layer.host.isConnected) return layer;
  const host = doc.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = `
    .demo-spot { position: fixed; z-index: 2147483645; pointer-events: none; border-radius: 10px;
      border: 3px solid ${DEMO_THEME.accent};
      box-shadow: 0 0 0 100vmax ${DEMO_THEME.dim}, 0 0 22px 4px rgba(88,166,255,.55);
      opacity: 0; transition: opacity .3s, top .25s, left .25s, width .25s, height .25s; }
    .demo-spot.show { opacity: 1; }
    .demo-caption { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
      z-index: 2147483646; pointer-events: none; background: ${DEMO_THEME.bg}; color: ${DEMO_THEME.text};
      border: 1px solid ${DEMO_THEME.border}; border-left: 4px solid ${DEMO_THEME.accent};
      border-radius: 10px; padding: 14px 22px; max-width: 70%;
      font: 600 20px/1.35 ${DEMO_THEME.font}; box-shadow: 0 12px 38px rgba(0,0,0,.6);
      opacity: 0; transition: opacity .4s; }
    .demo-caption.show { opacity: 1; }
    .demo-pulse { position: fixed; z-index: 2147483646; pointer-events: none; border-radius: 50%;
      border: 3px solid ${DEMO_THEME.accent2}; width: 12px; height: 12px; opacity: .9;
      transform: translate(-50%, -50%); }
  `;
  shadow.appendChild(style);
  const spot = doc.createElement("div");
  spot.className = "demo-spot";
  const caption = doc.createElement("div");
  caption.className = "demo-caption";
  shadow.append(spot, caption);
  doc.documentElement.appendChild(host);
  layer = { host, shadow, spot, caption };
  return layer;
}

export function showSpotlight(doc, element) {
  const { spot } = ensureLayer(doc);
  element.scrollIntoView?.({ block: "center", inline: "nearest" });
  const rect = element.getBoundingClientRect();
  const pad = 8;
  Object.assign(spot.style, {
    top: `${rect.top - pad}px`,
    left: `${rect.left - pad}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`,
  });
  spot.classList.add("show");
}

export function showCaption(doc, text) {
  const { caption } = ensureLayer(doc);
  if (!text) { caption.classList.remove("show"); return; }
  caption.textContent = text;
  caption.classList.add("show");
}

export function clickPulse(doc, element) {
  const { shadow } = ensureLayer(doc);
  const rect = element.getBoundingClientRect();
  const ring = doc.createElement("div");
  ring.className = "demo-pulse";
  ring.style.left = `${rect.left + rect.width / 2}px`;
  ring.style.top = `${rect.top + rect.height / 2}px`;
  shadow.appendChild(ring);
  try {
    ring.animate?.(
      [{ width: "12px", height: "12px", opacity: 0.9 }, { width: "72px", height: "72px", opacity: 0 }],
      { duration: 550, easing: "ease-out" },
    );
  } catch { /* Web Animations unavailable: the ring still flashes */ }
  setTimeout(() => ring.remove(), 600);
}

export function clearDemoOverlay() {
  layer?.host?.remove();
  layer = null;
}

// Spoken narration. Resolves on utterance end, or after max(fallbackMs, 1.5s)
// when speechSynthesis is unavailable or its events never fire (both are
// common: no voices installed, tab muted, headless Chrome).
export function speak(text, { fallbackMs = 0 } = {}) {
  const floorMs = Math.max(fallbackMs, 1500);
  return new Promise((resolve) => {
    const synth = globalThis.speechSynthesis;
    const timer = setTimeout(resolve, Math.max(floorMs, 400 + text.length * 75));
    if (!synth || typeof globalThis.SpeechSynthesisUtterance !== "function") return;
    try {
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      utterance.onend = () => { clearTimeout(timer); resolve(); };
      utterance.onerror = () => { clearTimeout(timer); setTimeout(resolve, floorMs); };
      synth.speak(utterance);
    } catch { /* fallback timer already pending */ }
  });
}

export function cancelSpeech() {
  try { globalThis.speechSynthesis?.cancel(); } catch { /* best effort */ }
}
