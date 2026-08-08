import { isLoopbackDemoOrigin, LINKEDIN_ORIGIN } from "../story-bridge-policy.mjs";

// Keep the bridge state visible on LinkedIn (and the loopback demo host).
// A silent empty section made an address-bar mismatch look like the feature
// was absent; only pairing itself remains gated by the exact safe URL
// contract in background.mjs.
export function storyBridgeSection({ origin, url, config, bridge, tabId }) {
  if (origin !== LINKEDIN_ORIGIN && !isLoopbackDemoOrigin(origin)) return "";
  if (!config.enabled) return `<section class="story-bridge"><strong>Local Kitsoki Story bridge</strong><p class="muted">Enable this origin before pairing.</p></section>`;
  if (bridge?.enabled && bridge.tabId === tabId) return `<section class="story-bridge"><div class="state sdk">Local Story bridge paired to this tab for autonomous MCP control.</div><button id="unpair-story">Unpair local Story bridge</button></section>`;
  return `<section class="story-bridge"><hr><strong>Local Kitsoki Story bridge</strong><p class="muted">Only 127.0.0.1 can connect. Paste the one-time code printed by the bridge.</p><label>Pairing code <input id="story-code" autocomplete="off"></label><label>Loopback port <input id="story-port" type="number" value="8765" min="1024" max="65535"></label><button id="pair-story">Pair this LinkedIn Jobs tab</button><div class="muted" id="story-note"></div></section>`;
}
