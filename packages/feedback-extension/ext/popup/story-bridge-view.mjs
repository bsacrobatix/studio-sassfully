import { isLoopbackDemoOrigin, LINKEDIN_ORIGIN } from "../story-bridge-policy.mjs";

// Keep the bridge state visible on LinkedIn (and the loopback demo host).
// A silent empty section made an address-bar mismatch look like the feature
// was absent; only pairing itself remains gated by the exact safe URL
// contract in background.mjs.
export function storyBridgeSection({ origin, url, config, bridge, live, tabId }) {
  if (origin !== LINKEDIN_ORIGIN && !isLoopbackDemoOrigin(origin)) return "";
  if (!config.enabled) return `<section class="story-bridge"><strong>Local Kitsoki Story bridge</strong><p class="muted">Enable this origin before pairing.</p></section>`;
  if (bridge?.enabled && bridge.tabId === tabId) {
    // Stored pairing is only a claim; the live socket state is the truth.
    // Never render "paired" as if it meant "connected".
    const statusLine = live?.status === "open"
      ? `<div class="state sdk">Paired · connected — the local bridge has autonomous MCP control of this tab.</div>`
      : `<div class="state rec">Paired · NOT connected (retrying…)${live?.lastError ? ` — ${live.lastError}` : ""}</div>`;
    return `<section class="story-bridge">${statusLine}<button id="unpair-story">Unpair local Story bridge</button></section>`;
  }
  return `<section class="story-bridge"><hr><strong>Local Kitsoki Story bridge</strong><p class="muted">Only 127.0.0.1 can connect. Paste the one-line pairing token printed by the bridge (it carries port and code).</p><label>Pairing token <input id="story-token" autocomplete="off" placeholder="8931.…"></label><button id="pair-story">Pair this LinkedIn Jobs tab</button><div class="muted" id="story-note"></div></section>`;
}
