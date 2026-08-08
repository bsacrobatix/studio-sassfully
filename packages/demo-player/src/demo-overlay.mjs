// Narrated-demo drawing surface. Visual language ported from slidey's
// tour overlays (slidey/src/tour/overlays.js): GitHub-dark palette, spotlight
// cutout + dimming via a huge box-shadow, bottom-center caption banner, and a
// brief click-pulse ring. Everything is pointer-events:none so the overlay can
// never swallow a click meant for the page, and it all lives in a closed
// shadow root (same isolation pattern as the extension's overlay.mjs). Kept
// in lockstep with packages/feedback-extension/ext/content/demo-overlay.mjs
// (this package simply has no chrome.* dependencies to strip).
//
// The spotlight TRACKS its target: rAF-throttled scroll/resize listeners plus
// a ResizeObserver on the element and a lightweight batched MutationObserver
// fallback keep the box glued to the element's live geometry. Step-to-step
// moves animate (eased CSS transition); tracking repositions are instant so
// the box never lags a scroll. If the target leaves the DOM mid-step the
// spotlight fades out instead of hovering over stale coordinates.
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

const CLEAR_FADE_MS = 420;
const CAPTION_SWAP_MS = 180;
const SPOT_PAD = 8;

let layer = null; // { host, shadow, spot, caption, captionTimer }
let tracking = null; // { doc, element, view, onScroll, onResize, ro, mo, rafId, retransitionTimer }

function ensureLayer(doc) {
  if (layer && layer.host.isConnected) return layer;
  const host = doc.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = `
    .demo-spot { position: fixed; z-index: 2147483645; pointer-events: none; border-radius: 10px;
      border: 3px solid ${DEMO_THEME.accent};
      box-shadow: 0 0 0 100vmax ${DEMO_THEME.dim}, 0 0 22px 4px rgba(88,166,255,.55);
      opacity: 0;
      transition: opacity .35s ease,
        top .45s cubic-bezier(.22,1,.36,1), left .45s cubic-bezier(.22,1,.36,1),
        width .45s cubic-bezier(.22,1,.36,1), height .45s cubic-bezier(.22,1,.36,1); }
    .demo-spot.instant { transition: opacity .35s ease; }
    .demo-spot.show { opacity: 1; }
    .demo-caption { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%) translateY(6px);
      z-index: 2147483646; pointer-events: none; background: ${DEMO_THEME.bg}; color: ${DEMO_THEME.text};
      border: 1px solid ${DEMO_THEME.border}; border-left: 4px solid ${DEMO_THEME.accent};
      border-radius: 10px; padding: 14px 22px; max-width: 70%;
      font: 600 20px/1.35 ${DEMO_THEME.font}; box-shadow: 0 12px 38px rgba(0,0,0,.6);
      opacity: 0; transition: opacity .25s ease, transform .25s ease; }
    .demo-caption.show { opacity: 1; transform: translateX(-50%) translateY(0); }
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
  layer = { host, shadow, spot, caption, captionTimer: null };
  return layer;
}

function positionSpot(spot, element) {
  const rect = element.getBoundingClientRect();
  Object.assign(spot.style, {
    top: `${rect.top - SPOT_PAD}px`,
    left: `${rect.left - SPOT_PAD}px`,
    width: `${rect.width + SPOT_PAD * 2}px`,
    height: `${rect.height + SPOT_PAD * 2}px`,
  });
}

function stopTracking() {
  if (!tracking) return;
  const { view, onScroll, onResize, ro, mo, rafId, retransitionTimer } = tracking;
  try { view?.removeEventListener("scroll", onScroll, true); } catch { /* view gone */ }
  try { view?.removeEventListener("resize", onResize); } catch { /* view gone */ }
  ro?.disconnect();
  mo?.disconnect();
  if (rafId != null) try { view?.cancelAnimationFrame?.(rafId); } catch { /* view gone */ }
  if (retransitionTimer != null) clearTimeout(retransitionTimer);
  tracking = null;
}

// Keep the spotlight glued to `element`. Repositions are batched through one
// rAF per burst; tracking moves suppress the position transition (class
// `instant`) and restore it shortly after the burst settles so the next
// step-to-step move still animates.
function startTracking(doc, element) {
  stopTracking();
  const view = doc.defaultView;
  const raf = view?.requestAnimationFrame?.bind(view) ?? ((fn) => setTimeout(fn, 16));
  const state = { doc, element, view, ro: null, mo: null, rafId: null, retransitionTimer: null, onScroll: null, onResize: null };

  const reposition = () => {
    state.rafId = null;
    if (tracking !== state || !layer) return;
    const { spot } = layer;
    if (!element.isConnected || !element.getClientRects?.().length) {
      // Target vanished mid-step: fade out rather than hover over nothing.
      spot.classList.remove("show");
      stopTracking();
      return;
    }
    spot.classList.add("instant");
    positionSpot(spot, element);
    if (state.retransitionTimer != null) clearTimeout(state.retransitionTimer);
    state.retransitionTimer = setTimeout(() => {
      state.retransitionTimer = null;
      if (tracking === state && layer) layer.spot.classList.remove("instant");
    }, 150);
  };
  const schedule = () => { if (tracking === state && state.rafId == null) state.rafId = raf(reposition); };

  state.onScroll = schedule;
  state.onResize = schedule;
  view?.addEventListener("scroll", schedule, { capture: true, passive: true });
  view?.addEventListener("resize", schedule, { passive: true });
  const RO = view?.ResizeObserver ?? globalThis.ResizeObserver;
  if (typeof RO === "function") {
    try { state.ro = new RO(schedule); state.ro.observe(element); } catch { /* geometry still tracked via scroll/resize/mutations */ }
  }
  const MO = view?.MutationObserver ?? globalThis.MutationObserver;
  if (typeof MO === "function") {
    try {
      // Batched fallback re-measure: any DOM churn simply schedules one rAF
      // re-read of the target's bbox (and catches the target being removed).
      state.mo = new MO(schedule);
      state.mo.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
    } catch { /* geometry still tracked via scroll/resize */ }
  }
  tracking = state;
}

export function showSpotlight(doc, element) {
  const { spot } = ensureLayer(doc);
  element.scrollIntoView?.({ block: "center", inline: "nearest" });
  // A fresh step move should animate even if a tracking burst just ended.
  spot.classList.remove("instant");
  positionSpot(spot, element);
  spot.classList.add("show");
  startTracking(doc, element);
}

export function showCaption(doc, text) {
  const { caption } = ensureLayer(doc);
  if (layer.captionTimer != null) { clearTimeout(layer.captionTimer); layer.captionTimer = null; }
  if (!text) { caption.classList.remove("show"); return; }
  if (caption.classList.contains("show") && caption.textContent !== text) {
    // Cross-fade between texts: out, swap, back in.
    caption.classList.remove("show");
    layer.captionTimer = setTimeout(() => {
      layer.captionTimer = null;
      caption.textContent = text;
      caption.classList.add("show");
    }, CAPTION_SWAP_MS);
    return;
  }
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

// Eases the dim/spotlight/caption out (the dim rides the spotlight's
// box-shadow, so fading the spotlight fades the dim) and removes the layer
// after the fade. Observers and listeners are torn down immediately; the
// detached fading host owns its own removal so a new demo can start a fresh
// layer during the fade.
export function clearDemoOverlay() {
  stopTracking();
  if (!layer) return;
  const { host, spot, caption, captionTimer } = layer;
  if (captionTimer != null) clearTimeout(captionTimer);
  layer = null;
  spot.classList.remove("show");
  caption.classList.remove("show");
  setTimeout(() => host.remove(), CLEAR_FADE_MS);
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
