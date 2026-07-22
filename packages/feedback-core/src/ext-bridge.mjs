// ext-bridge.mjs — req-ext-bridge-enrich: the host half of the
// sassfully-ext/bridge/v1 handshake. A page's integrated SDK opts in by
// creating a host bridge; when the sassfully browser extension is present it
// offers its evidence providers (replay, telemetry) and the host's reporter,
// anchors, manifest, review, and sinks own everything downstream. Messages
// stay on the page's own window; a $protocol tag plus a same-window source
// check scope delivery, and each capture request carries a nonce so replies
// can never cross.

export const BRIDGE_PROTOCOL = "sassfully-ext/bridge/v1";

/**
 * @param {{window: Window, producer?: string, artifactId?: string,
 *   accept?: (offered: Array<{id: string}>) => string[],
 *   onProviders: (providers: Array<object>, session: {sessionId: string}) => void,
 *   onBye?: () => void, timeoutMs?: number}} options
 */
export function createHostBridge({ window: win, producer, artifactId, accept, onProviders, onBye, timeoutMs = 5000 } = {}) {
  if (!win) throw new TypeError("ext-bridge: window is required");
  if (typeof onProviders !== "function") throw new TypeError("ext-bridge: onProviders callback is required");
  let counter = 0; let sessionId = null; const pending = new Map();
  const post = (msg) => win.postMessage({ $protocol: BRIDGE_PROTOCOL, ...msg }, "*");
  const hello = () => post({ type: "host-hello", ...(producer === undefined ? {} : { producer }), ...(artifactId === undefined ? {} : { artifactId }) });
  const request = (id) => new Promise((resolve, reject) => {
    const nonce = `h${++counter}`;
    const timer = setTimeout(() => { pending.delete(nonce); reject(new Error(`ext-bridge: capture ${id} timed out`)); }, timeoutMs);
    pending.set(nonce, { resolve, reject, timer });
    post({ type: "capture", sessionId, id, nonce });
  });
  const fail = (reason) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); } pending.clear(); };
  const onMessage = (event) => {
    const msg = event.data;
    if (!msg || msg.$protocol !== BRIDGE_PROTOCOL) return;
    if (event.source && event.source !== win) return;
    if (msg.type === "ext-ping") { hello(); return; }
    if (msg.type === "ext-offer") {
      sessionId = msg.sessionId;
      const offered = Array.isArray(msg.providers) ? msg.providers : [];
      const chosen = accept ? accept(offered) : offered.map((p) => p.id);
      post({ type: "accept", sessionId, providerIds: chosen });
      const providers = offered.filter((p) => chosen.includes(p.id)).map(({ id, label, description, autoApprove }) => ({ id, label: label ?? id, description, ...(autoApprove ? { autoApprove: true } : {}), capture: () => request(id) }));
      onProviders(providers, { sessionId });
      return;
    }
    if (msg.sessionId !== sessionId || sessionId === null) return;
    if (msg.type === "captured" || msg.type === "capture-error") {
      const p = pending.get(msg.nonce);
      if (!p) return;
      pending.delete(msg.nonce); clearTimeout(p.timer);
      if (msg.type === "captured") p.resolve(msg.items); else p.reject(new Error(msg.error));
      return;
    }
    if (msg.type === "ext-bye") { sessionId = null; fail("ext-bridge: extension disconnected"); onBye?.(); }
  };
  win.addEventListener("message", onMessage);
  hello();
  return { stop() { win.removeEventListener("message", onMessage); fail("ext-bridge: host bridge stopped"); } };
}
