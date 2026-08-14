// Local Chromium QA driver.  This is intentionally not a general CDP proxy:
// callers get a short, typed vocabulary and screenshots, never evaluate JS.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_KEYCHAIN_ACCOUNT = "kitsoki-staging";
// An MCP launch environment (e.g. a config-declared stdio server) does not
// reliably carry an operator's shell env vars, so a named bearer env var
// that is absent/empty falls back to resolving the SAME logical secret from
// the macOS Keychain, in-process, held only in memory. Never logs, never
// throws the resolved value in an error, never touches argv. Returns null
// (not a throw) on any failure -- "not found" and "security unavailable on
// this platform" are the same outcome to the caller.
async function defaultResolveKeychainSecret({ service, account }) {
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
    const value = stdout.replace(/\r?\n$/, "");
    return value || null;
  } catch {
    return null;
  }
}

const chrome = process.env.SASSFULLY_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1"];
const isLoopbackHostname = (hostname) => LOOPBACK_HOSTNAMES.includes(hostname);
// A qa_start target is admitted when it is loopback (today's behavior,
// unconditionally) OR its exact origin was explicitly allowlisted by the
// operator via --allow-origin. No allowlist means no non-loopback target is
// ever admitted — this is the whole security boundary for "cannot navigate
// off the owned page".
const isAllowedQAUrl = (value, allowedOrigins) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (isLoopbackHostname(url.hostname)) return true;
    return Boolean(allowedOrigins) && allowedOrigins.has(url.origin);
  } catch { return false; }
};
const selector = (value) => typeof value === "string" && value.length > 0 && value.length <= 500;
const text = (value) => typeof value === "string" && value.length <= 2000;
const js = (value) => JSON.stringify(value);
const QA_AUDIO_ENABLE_SELECTOR = '[data-testid="sassfully-demo-audio"]';
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
const redactHeaderMap = (raw) => {
  if (!raw || typeof raw !== "object") return raw;
  const result = {};
  for (const [name, value] of Object.entries(raw)) result[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "[REDACTED]" : value;
  return result;
};
// Every raw-CDP-event export path (qa_events polling, and the events[] field
// inside evidence.json/HAR export) hands back the live CDP event shape,
// which is NOT the same object the HAR-entry `headers()` helper redacts --
// so without this, a raw Network.requestWillBeSent/responseReceived event's
// header object still carried the live Authorization/Cookie value verbatim
// even when the HAR entry right next to it was already redacted. Same
// header-by-NAME rule, applied uniformly to every export surface.
const redactPolledEvent = ({ method, params }) => {
  if (!params || typeof params !== "object") return { method, params };
  const cloned = { ...params };
  if (cloned.request?.headers) cloned.request = { ...cloned.request, headers: redactHeaderMap(cloned.request.headers) };
  if (cloned.response?.headers) cloned.response = { ...cloned.response, headers: redactHeaderMap(cloned.response.headers) };
  return { method, params: cloned };
};

async function sleep(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function json(url) { const response = await fetch(url); if (!response.ok) throw new Error(`Chrome DevTools returned ${response.status}`); return response.json(); }
async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs),
  ]);
  if (child.exitCode == null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1000)]);
  }
}
async function removeProfile(profile) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 }); return null; } catch (error) { lastError = error; await sleep(100 * (attempt + 1)); }
  }
  return lastError;
}

class CDP {
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); this.events = []; this.listeners = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", () => reject(new Error("could not connect to Chromium CDP")), { once: true }); });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
      if (message.method) {
        this.events.push(message); if (this.events.length > 500) this.events.shift();
        const key = `${message.method} ${message.sessionId ?? ""}`;
        for (const handler of this.listeners.get(key) ?? []) handler(message.params);
      }
    });
  }
  // Scoped by (method, sessionId) so a listener never observes another
  // flattened session's events -- the same boundary `call`'s sessionId param
  // already enforces for outbound commands.
  on(method, sessionId, handler) {
    const key = `${method} ${sessionId ?? ""}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(handler);
  }
  call(method, params = {}, sessionId = null) { const id = this.next++; this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  close() { this.socket?.close(); }
}

export function validateQARequest(args, { allowedOrigins } = {}) {
  if (!args || typeof args !== "object") return "qa request must be an object";
  if (args.action === "qa_start") {
    if (!isAllowedQAUrl(args.url, allowedOrigins)) {
      // No --allow-origin configured: byte-identical to the pre-allowlist
      // message, so a caller with no allowlist sees exactly today's refusal.
      return allowedOrigins && allowedOrigins.size
        ? "qa_start.url must be an absolute loopback http(s) URL or an explicitly allowlisted origin"
        : "qa_start.url must be an absolute loopback http(s) URL";
    }
    if (args.mode != null && !["headed", "headless"].includes(args.mode)) return "qa_start.mode must be headed or headless";
    return null;
  }
  if (args.action === "qa_action") {
    if (typeof args.qaSessionId !== "string") return "qa_action.qaSessionId is required";
    if (!['snapshot', 'click', 'fill', 'press', 'screenshot'].includes(args.operation)) return "qa_action.operation must be snapshot, click, fill, press, or screenshot";
    if (["click", "fill"].includes(args.operation) && !selector(args.selector)) return `${args.operation} needs selector`;
    if (args.operation === "fill" && !text(args.text)) return "fill needs bounded text";
    if (args.operation === "press" && !text(args.key)) return "press needs bounded key";
    if (args.narration != null && (!text(args.narration) || !args.narration.length)) return "narration must be a bounded non-empty string";
    return null;
  }
  if (args.action === "qa_stop" && typeof args.qaSessionId === "string") return null;
  if (args.action === "qa_cdp") {
    if (typeof args.qaSessionId !== "string" || typeof args.method !== "string" || !args.method.length || args.method.length > 160) return "qa_cdp needs qaSessionId and bounded method";
    if (args.params != null && (typeof args.params !== "object" || Array.isArray(args.params) || JSON.stringify(args.params).length > 131072)) return "qa_cdp.params must be a bounded object";
    return null;
  }
  if (args.action === "qa_test_narrated_replay") {
    if (typeof args.qaSessionId !== "string" || typeof args.sessionId !== "string") return "qa_test_narrated_replay needs qaSessionId and sessionId";
    if (!args.script || typeof args.script !== "object" || Array.isArray(args.script)) return "qa_test_narrated_replay needs a script object";
    if (args.runs !== 2) return "qa_test_narrated_replay runs must be exactly 2";
    return null;
  }
  if (args.action === "qa_events") return typeof args.qaSessionId === "string" ? null : "qa_events.qaSessionId is required";
  if (["qa_capture_start", "qa_capture_export", "qa_har_export"].includes(args.action)) return typeof args.qaSessionId === "string" ? null : `${args.action}.qaSessionId is required`;
  return "unknown QA action";
}

export function createEmbeddedQADriver({ narrate, beforeScreenshot, runtime = {}, allowedOrigins = new Set(), authBearerEnv = null, authBearerKeychainService = null, authBearerKeychainAccount = null } = {}) {
  const driverRuntime = {
    chrome,
    spawn,
    mkdtemp,
    rm,
    writeFile,
    tmpdir,
    json,
    waitForExit,
    removeProfile,
    resolveKeychainSecret: defaultResolveKeychainSecret,
    ...runtime,
  };
  const sessions = new Map();
  // Direct env var wins when present (today's behavior, unchanged). Only
  // when it is absent/empty does this fall back to the Keychain, once, right
  // before the token is needed -- so a loopback qa_start (see `start` below,
  // which never calls this at all) still never touches the Keychain either.
  async function resolveBearerToken(origin) {
    const direct = process.env[authBearerEnv];
    if (direct) return direct;
    const service = authBearerKeychainService ?? authBearerEnv;
    const account = authBearerKeychainAccount ?? DEFAULT_KEYCHAIN_ACCOUNT;
    const fromKeychain = await driverRuntime.resolveKeychainSecret({ service, account }).catch(() => null);
    if (fromKeychain) return fromKeychain;
    throw new Error(`qa_start requires env var ${authBearerEnv} (or a Keychain entry -s ${service} -a ${account}) to be set for allowlisted origin ${origin}`);
  }
  async function start({ url, mode = "headless" }) {
    const qaURL = new URL(url);
    if (!isAllowedQAUrl(qaURL.href, allowedOrigins)) throw new Error("qa_start.url must be loopback or an explicitly allowlisted origin");
    const isRemoteTarget = !isLoopbackHostname(qaURL.hostname);
    // This marker is minted only for the disposable MCP-owned QA page. It is
    // never supplied by a normal demo client and is the page-side admission
    // check for the test-only CDP audio lane.
    qaURL.searchParams.set("__sassfully_qa_audio_test", "1");
    const profile = await driverRuntime.mkdtemp(join(driverRuntime.tmpdir(), "sassfully-qa-"));
    const evidenceDir = await driverRuntime.mkdtemp(join(driverRuntime.tmpdir(), "sassfully-qa-evidence-"));
    const args = ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking"];
    if (mode === "headless") args.push("--headless=new");
    if (isRemoteTarget) {
      // Empirically confirmed (real Chrome 151.0.7922.138, headless, a page
      // on a public https origin, a real ws:// handshake server on
      // 127.0.0.1): with no extra flags, `new WebSocket("ws://127.0.0.1:…")`
      // fails with net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS -- Chrome's
      // Local Network Access policy blocks a public-origin page from reaching
      // loopback at all (headless auto-denies; headed would at best interrupt
      // the tour with a permission prompt, no scriptable grant exists for
      // it). `--disable-features=LocalNetworkAccessChecks` alone reliably
      // (2/2 reruns) restores the connection; two guessed sibling feature
      // names (`LocalNetworkAccessChecksForNavigations`,
      // `LocalNetworkAccessChecksWeb`) do NOT work alone and were dropped.
      // Scoped to a remote-origin session ONLY: a loopback qa_start (the
      // overwhelming majority of traffic, including every existing test)
      // keeps today's exact launch args, byte for byte.
      args.push("--disable-features=LocalNetworkAccessChecks");
    }
    args.push("about:blank");
    const child = driverRuntime.spawn(driverRuntime.chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let endpoint = ""; child.stderr.on("data", (chunk) => { const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(String(chunk)); if (match) endpoint = match[1]; });
    for (let tries = 0; tries < 100 && !endpoint; tries += 1) await sleep(50);
    if (!endpoint) { child.kill(); await driverRuntime.waitForExit(child); await driverRuntime.removeProfile(profile); throw new Error("Chromium did not publish a local DevTools endpoint"); }
    // The credential travels as an env var NAME (with a Keychain fallback
    // when that var is absent/empty -- see resolveBearerToken above) end to
    // end -- never as an argv value and never logged. Resolved once per
    // session, right before it is needed, and never placed on `session` in
    // cleartext form beyond this closure's use in the Fetch interceptor
    // below.
    let bearerToken = null;
    if (isRemoteTarget && authBearerEnv) {
      try { bearerToken = await resolveBearerToken(qaURL.origin); }
      catch (error) { child.kill(); await driverRuntime.waitForExit(child); await driverRuntime.removeProfile(profile); throw error; }
    }
    const version = await driverRuntime.json(endpoint.replace(/^ws:\/\/(.*)\/devtools\/browser\/.*$/, "http://$1/json/version"));
    const cdp = driverRuntime.createCDP ? await driverRuntime.createCDP(version.webSocketDebuggerUrl) : new CDP(version.webSocketDebuggerUrl); await cdp.connect?.();
    let target, attached;
    if (bearerToken) {
      // Attach to a blank page first so Fetch interception is armed before
      // the one navigation this driver performs -- otherwise the initial
      // document request (which needs the bearer most) races ahead of it.
      target = await cdp.call("Target.createTarget", { url: "about:blank" });
      attached = await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const cdpSession = attached.sessionId;
      const targetOrigin = qaURL.origin;
      await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, cdpSession);
      cdp.on("Fetch.requestPaused", cdpSession, (params) => {
        let requestOrigin = null;
        try { requestOrigin = new URL(params.request.url).origin; } catch { /* leave unmatched, forward unmodified */ }
        const headers = Object.entries(params.request.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization").map(([name, value]) => ({ name, value }));
        // The bearer is attached ONLY to requests whose resolved origin is
        // exactly the allowlisted target -- never to third-party subresources
        // (fonts, CDNs, analytics) the page may also load.
        if (requestOrigin === targetOrigin) headers.push({ name: "Authorization", value: `Bearer ${bearerToken}` });
        cdp.call("Fetch.continueRequest", { requestId: params.requestId, headers }, cdpSession).catch(() => {});
      });
      await cdp.call("Page.navigate", { url: qaURL.href }, cdpSession);
    } else {
      target = await cdp.call("Target.createTarget", { url: qaURL.href });
      attached = await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    }
    const session = { id: `qa-${crypto.randomUUID()}`, child, profile, evidenceDir, screenshotCount: 0, cdp, cdpSession: attached.sessionId, mode, url: qaURL.href, captureCursor: null, remoteOrigin: isRemoteTarget ? qaURL.origin : null };
    sessions.set(session.id, session);
    return { qaSessionId: session.id, mode, url: qaURL.href, browser: "local-chromium-cdp", presenter: "suppressed", ...(isRemoteTarget ? { origin: qaURL.origin, authBearer: bearerToken ? "attached" : "not_configured" } : {}) };
  }
  async function command(session, method, params = {}) { return session.cdp.call(method, params, session.cdpSession); }
  async function captureChromeFreeScreenshot(session, params = {}) {
    // The editing toolbar is runtime chrome, not application evidence. Keep the
    // removal scoped to this one capture and always restore the original nodes.
    const key = "__sassfullyQaChromeNodes";
    const remove = `(() => { const key=${js(key)}; if (globalThis[key]) return { removed: 0, alreadySuppressed: true }; const nodes=[...document.querySelectorAll('[data-kitsoki-chrome]')]; globalThis[key]=nodes.map((node) => ({ node, parent: node.parentNode, next: node.nextSibling })); for (const node of nodes) node.remove(); return { removed: nodes.length }; })()`;
    const restore = `(() => { const key=${js(key)}; const saved=globalThis[key] ?? []; for (const { node, parent, next } of saved) if (parent) parent.insertBefore(node, next?.parentNode === parent ? next : null); delete globalThis[key]; return { restored: saved.length }; })()`;
    await command(session, "Runtime.evaluate", { expression: remove, returnByValue: true, awaitPromise: true });
    try { return await command(session, "Page.captureScreenshot", params); }
    finally { await command(session, "Runtime.evaluate", { expression: restore, returnByValue: true, awaitPromise: true }); }
  }
  async function action(args) {
    const session = sessions.get(args.qaSessionId); if (!session) throw new Error("QA session not found");
    if (args.narration) await narrate?.(args.narration, session);
    if (args.operation === "snapshot") {
      const result = await command(session, "Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true, awaitPromise: true });
      return { qaSessionId: session.id, operation: "snapshot", html: result.result.value, narrator: args.narration ? "started" : "not_requested", presenter: "suppressed" };
    }
    if (args.operation === "screenshot") {
      // A persistent tour presenter is an intentional showcase affordance, but
      // is not QA evidence. Clear it through the page's bounded stop API first.
      await beforeScreenshot?.(session);
      const result = await captureChromeFreeScreenshot(session, { format: "png" });
      session.screenshotCount += 1;
      const screenshotPath = join(session.evidenceDir, `screenshot-${String(session.screenshotCount).padStart(3, "0")}.png`);
      const png = Buffer.from(result.data, "base64");
      await driverRuntime.writeFile(screenshotPath, png, { mode: 0o600 });
      return { qaSessionId: session.id, operation: "screenshot", screenshotPath, bytes: png.length, narrator: args.narration ? "started" : "not_requested", presenter: "suppressed", chrome: "suppressed" };
    }
    const expression = args.operation === "click"
      ? `(() => { const e=document.querySelector(${js(args.selector)}); if(!e) throw new Error('selector not found'); e.click(); return true; })()`
      : args.operation === "fill"
        ? `(() => { const e=document.querySelector(${js(args.selector)}); if(!e) throw new Error('selector not found'); e.focus(); e.value=${js(args.text)}; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${js(args.text)}})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`
        : `(() => { const e=document.activeElement; if(!e) throw new Error('no active element'); e.dispatchEvent(new KeyboardEvent('keydown',{key:${js(args.key)},bubbles:true})); e.dispatchEvent(new KeyboardEvent('keyup',{key:${js(args.key)},bubbles:true})); return true; })()`;
    await command(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return { qaSessionId: session.id, operation: args.operation, ok: true, narrator: args.narration ? "started" : "not_requested", presenter: "suppressed" };
  }
  function requireTestAudioMode(id) {
    const session = sessions.get(id); if (!session) throw new Error("QA session not found");
    const url = new URL(session.url);
    if (url.searchParams.get("__sassfully_qa_audio_test") !== "1") throw new Error("qa_test_narrated_replay requires qa_start URL query __sassfully_qa_audio_test=1");
    return { qaSessionId: id, mode: "qa-cdp", url: session.url };
  }
  async function activateTestAudio(id) {
    const session = sessions.get(id); if (!session) throw new Error("QA session not found");
    const receipt = requireTestAudioMode(id);
    // This is not a generic evaluation or caller-selected click: the only
    // permitted selector is the page's visible, user-facing audio control.
    // CDP pointer events give the owned page a genuine activation before its
    // separately gated typed bridge request primes media.
    const bounds = await command(session, "Runtime.evaluate", {
      expression: `(() => { const e=document.querySelector(${js(QA_AUDIO_ENABLE_SELECTOR)}); if(!e) throw new Error('QA audio enable control not found'); const r=e.getBoundingClientRect(); const s=getComputedStyle(e); if(r.width<=0||r.height<=0||s.display==='none'||s.visibility==='hidden'||s.pointerEvents==='none'||e.disabled) throw new Error('QA audio enable control is not clickable'); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()`,
      returnByValue: true, awaitPromise: true,
    });
    const point = bounds.result?.value;
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error("QA audio enable control has no clickable bounds");
    await command(session, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await command(session, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await command(session, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return { ...receipt, activation: { source: "qa-cdp-input", selector: QA_AUDIO_ENABLE_SELECTOR, x: point.x, y: point.y } };
  }
  async function cdp(args) {
    const session = sessions.get(args.qaSessionId); if (!session) throw new Error("QA session not found");
    // Raw CDP is constrained to the exact flattened session this driver
    // created. Target attach/create/close and navigation could escape it.
    if (/^(Target\.|Browser\.|Page\.navigate$|Page\.navigateToHistoryEntry$)/.test(args.method)) throw new Error("qa_cdp cannot attach, create, close, or navigate targets");
    if (args.narration) await narrate?.(args.narration, session);
    const isScreenshot = args.method === "Page.captureScreenshot";
    if (isScreenshot) await beforeScreenshot?.(session);
    const result = isScreenshot ? await captureChromeFreeScreenshot(session, args.params ?? {}) : await command(session, args.method, args.params ?? {});
    return { qaSessionId: session.id, method: args.method, result, narrator: args.narration ? "started" : "not_requested", presenter: isScreenshot ? "suppressed" : undefined, chrome: isScreenshot ? "suppressed" : undefined };
  }
  function events(id, { since = 0 } = {}) { const session = sessions.get(id); if (!session) throw new Error("QA session not found"); const start = Number.isInteger(since) && since >= 0 ? since : 0; const events = session.cdp.events.filter((event) => event.sessionId === session.cdpSession); return { qaSessionId: id, cursor: events.length, events: events.slice(start).map(redactPolledEvent) }; }
  async function captureStart(id) { const session = sessions.get(id); if (!session) throw new Error("QA session not found"); await command(session, "Network.enable"); await command(session, "Runtime.enable"); await command(session, "Log.enable"); session.captureCursor = session.cdp.events.length; return { qaSessionId: id, active: true, limits: { responses: 16, bodyChars: 65536 }, presenter: "suppressed" }; }
  const redact = (body) => body.replace(/(authorization|cookie|token|secret|password)\s*[:=]\s*[^\s",&]+/gi, "$1=[REDACTED]");
  async function captureExport(id) {
    const session = sessions.get(id); if (!session) throw new Error("QA session not found"); if (session.captureCursor == null) throw new Error("QA capture has not been started");
    const all = session.cdp.events.slice(session.captureCursor).filter((event) => event.sessionId === session.cdpSession);
    const byRequest = new Map();
    for (const event of all) { const requestId = event.params?.requestId; if (!requestId) continue; const item = byRequest.get(requestId) ?? {}; if (event.method === "Network.requestWillBeSent") item.request = event.params; if (event.method === "Network.responseReceived") item.response = event.params; if (event.method === "Network.loadingFinished") item.finished = event.params; byRequest.set(requestId, item); }
    // `redact` pattern-matches a "keyword: value" shape inside one string --
    // exactly what a response BODY looks like, but a header value never
    // repeats its own name ("Bearer xyz" contains no literal "authorization"),
    // so applying it to a header's value alone silently redacted nothing.
    // Sensitive headers are stripped by NAME instead, unconditionally.
    const headers = (raw = {}) => Object.entries(raw).map(([name, value]) => ({ name, value: SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "[REDACTED]" : redact(String(value)) }));
    const network = []; const harEntries = []; let remaining = 65536;
    for (const [requestId, item] of [...byRequest].filter(([, item]) => item.finished && item.response).slice(0, 16)) {
      const req = item.request?.request ?? {}; const res = item.response.response ?? {}; let body = "[response body unavailable]"; let encoded = false; let truncated = true;
      try { const captured = await command(session, "Network.getResponseBody", { requestId }); encoded = captured.base64Encoded === true; if (encoded) body = "[base64 response omitted]"; else { const original = String(captured.body ?? ""); body = redact(original).slice(0, remaining); remaining -= body.length; truncated = original.length > body.length; } } catch { /* Chrome evicted this response */ }
      const record = { requestId, base64Encoded: encoded, body, truncated }; network.push(record);
      harEntries.push({ startedDateTime: new Date().toISOString(), time: 0, request: { method: req.method ?? "GET", url: req.url ?? res.url ?? session.url, httpVersion: "HTTP/1.1", headers: headers(req.headers), queryString: [], cookies: [], headersSize: -1, bodySize: -1 }, response: { status: res.status ?? 0, statusText: res.statusText ?? "", httpVersion: "HTTP/1.1", headers: headers(res.headers), cookies: [], content: { size: res.encodedDataLength ?? -1, mimeType: res.mimeType ?? "", text: body, ...(encoded ? { encoding: "base64-omitted" } : {}) }, redirectURL: res.headers?.location ?? "", headersSize: -1, bodySize: -1, _sassfully: { truncated, omission: encoded ? "base64 response omitted" : (body === "[response body unavailable]" ? "response unavailable" : null) } }, cache: {}, timings: { send: 0, wait: 0, receive: 0 } });
      if (!remaining) break;
    }
    const console = all.filter((event) => ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"].includes(event.method)).map(({ method, params }) => ({ method, params })).slice(0, 100);
    const har = { log: { version: "1.2", creator: { name: "sassfully embedded QA", version: "1" }, pages: [{ startedDateTime: new Date().toISOString(), id: id, title: session.url, pageTimings: {} }], entries: harEntries } };
    const evidence = { format: "sassfully/qa-evidence/v1", qaSessionId: id, limits: { responses: 16, bodyChars: 65536, console: 100 }, network, har, console, events: all.map(redactPolledEvent).slice(0, 500), presenter: "suppressed" };
    const evidencePath = join(session.evidenceDir, "evidence.json");
    await driverRuntime.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return { ...evidence, evidencePath, screenshotPaths: Array.from({ length: session.screenshotCount }, (_, index) => join(session.evidenceDir, `screenshot-${String(index + 1).padStart(3, "0")}.png`)) };
  }
  async function harExport(id) {
    const evidence = await captureExport(id);
    const harPath = join(sessions.get(id).evidenceDir, "network.har.json");
    await driverRuntime.writeFile(harPath, `${JSON.stringify(evidence.har, null, 2)}\n`, { mode: 0o600 });
    return { ...evidence.har, qaSessionId: id, harPath };
  }
  async function stop(id) {
    const session = sessions.get(id); if (!session) throw new Error("QA session not found");
    sessions.delete(id); session.cdp.close(); session.child.kill(); await driverRuntime.waitForExit(session.child);
    const cleanupError = await driverRuntime.removeProfile(session.profile);
    if (cleanupError) throw new Error(`QA browser stopped but its temporary profile could not be removed: ${cleanupError.message}`);
    return { qaSessionId: id, stopped: true, evidenceDir: session.evidenceDir };
  }
  return { start, action, cdp, requireTestAudioMode, activateTestAudio, events, captureStart, captureExport, harExport, stop };
}
