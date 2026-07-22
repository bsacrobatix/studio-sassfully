// bridge.mjs — comp-ext-bridge, extension endpoint (req-ext-bridge-enrich).
// The extension pings on start (covering a host SDK that mounted first or
// mounts later), offers provider metadata on host-hello, and serves capture
// requests only for providers the host accepted. A successful accept is the
// signal that suppresses the standalone UI on this page; the host owns
// anchors, manifest, review, and sinks from then on.
import { BRIDGE_PROTOCOL } from "./deps.mjs";

export function createExtensionBridge({ window: win, providers = [], sessionId, onAccepted, onBye } = {}) {
  if (!win) throw new TypeError("bridge: window is required");
  for (const provider of providers) if (!provider?.id || typeof provider.capture !== "function") throw new TypeError("bridge: each provider needs an id and capture function");
  const session = sessionId ?? `ext-${Math.random().toString(36).slice(2, 10)}`;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  let accepted = null; let hostInfo = null;
  const post = (msg) => win.postMessage({ $protocol: BRIDGE_PROTOCOL, sessionId: session, ...msg }, "*");
  const onMessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.$protocol !== BRIDGE_PROTOCOL) return;
    if (event.source && event.source !== win) return;
    if (msg.type === "host-hello") {
      hostInfo = { ...(msg.producer === undefined ? {} : { producer: msg.producer }), ...(msg.artifactId === undefined ? {} : { artifactId: msg.artifactId }) };
      post({ type: "ext-offer", providers: [...byId.values()].map(({ id, label, description, autoApprove }) => ({ id, label: label ?? id, description, ...(autoApprove ? { autoApprove: true } : {}) })) });
      return;
    }
    if (msg.sessionId !== session) return;
    if (msg.type === "accept") { accepted = Array.isArray(msg.providerIds) ? msg.providerIds : []; onAccepted?.(accepted, hostInfo); return; }
    if (msg.type === "capture") {
      const provider = byId.get(msg.id);
      if (!provider || !accepted?.includes(msg.id)) { post({ type: "capture-error", nonce: msg.nonce, error: `unknown or unaccepted provider ${msg.id}` }); return; }
      try {
        const captured = await provider.capture();
        post({ type: "captured", nonce: msg.nonce, items: (Array.isArray(captured) ? captured : [captured]).filter(Boolean) });
      } catch (error) { post({ type: "capture-error", nonce: msg.nonce, error: error?.message ?? String(error) }); }
    }
  };
  win.addEventListener("message", onMessage);
  post({ type: "ext-ping" });
  return {
    sessionId: session,
    get bridged() { return accepted !== null; },
    get accepted() { return accepted; },
    get hostInfo() { return hostInfo; },
    stop() { post({ type: "ext-bye" }); win.removeEventListener("message", onMessage); onBye?.(); },
  };
}
