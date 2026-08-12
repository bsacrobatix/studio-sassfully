// Local Chromium QA driver.  This is intentionally not a general CDP proxy:
// callers get a short, typed vocabulary and screenshots, never evaluate JS.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.SASSFULLY_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const loopback = (value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; }
};
const selector = (value) => typeof value === "string" && value.length > 0 && value.length <= 500;
const text = (value) => typeof value === "string" && value.length <= 2000;
const js = (value) => JSON.stringify(value);

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
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); this.events = []; }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", () => reject(new Error("could not connect to Chromium CDP")), { once: true }); });
    this.socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } if (message.method) { this.events.push(message); if (this.events.length > 500) this.events.shift(); } });
  }
  call(method, params = {}, sessionId = null) { const id = this.next++; this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  close() { this.socket?.close(); }
}

export function validateQARequest(args) {
  if (!args || typeof args !== "object") return "qa request must be an object";
  if (args.action === "qa_start") {
    if (!loopback(args.url)) return "qa_start.url must be an absolute loopback http(s) URL";
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
  if (args.action === "qa_events") return typeof args.qaSessionId === "string" ? null : "qa_events.qaSessionId is required";
  if (["qa_capture_start", "qa_capture_export", "qa_har_export"].includes(args.action)) return typeof args.qaSessionId === "string" ? null : `${args.action}.qaSessionId is required`;
  return "unknown QA action";
}

export function createEmbeddedQADriver({ narrate, beforeScreenshot } = {}) {
  const sessions = new Map();
  async function start({ url, mode = "headless" }) {
    const profile = await mkdtemp(join(tmpdir(), "sassfully-qa-"));
    const evidenceDir = await mkdtemp(join(tmpdir(), "sassfully-qa-evidence-"));
    const args = ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking"];
    if (mode === "headless") args.push("--headless=new");
    args.push("about:blank");
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let endpoint = ""; child.stderr.on("data", (chunk) => { const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(String(chunk)); if (match) endpoint = match[1]; });
    for (let tries = 0; tries < 100 && !endpoint; tries += 1) await sleep(50);
    if (!endpoint) { child.kill(); await waitForExit(child); await removeProfile(profile); throw new Error("Chromium did not publish a local DevTools endpoint"); }
    const version = await json(endpoint.replace(/^ws:\/\/(.*)\/devtools\/browser\/.*$/, "http://$1/json/version"));
    const cdp = new CDP(version.webSocketDebuggerUrl); await cdp.connect();
    const target = await cdp.call("Target.createTarget", { url });
    const attached = await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const session = { id: `qa-${crypto.randomUUID()}`, child, profile, evidenceDir, screenshotCount: 0, cdp, cdpSession: attached.sessionId, mode, url, captureCursor: null };
    sessions.set(session.id, session);
    return { qaSessionId: session.id, mode, url, browser: "local-chromium-cdp", presenter: "suppressed" };
  }
  async function command(session, method, params = {}) { return session.cdp.call(method, params, session.cdpSession); }
  async function action(args) {
    const session = sessions.get(args.qaSessionId); if (!session) throw new Error("QA session not found");
    if (args.narration) await narrate?.(args.narration);
    if (args.operation === "snapshot") {
      const result = await command(session, "Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true, awaitPromise: true });
      return { qaSessionId: session.id, operation: "snapshot", html: result.result.value, narrator: args.narration ? "started" : "not_requested", presenter: "suppressed" };
    }
    if (args.operation === "screenshot") {
      // A persistent tour presenter is an intentional showcase affordance, but
      // is not QA evidence. Clear it through the page's bounded stop API first.
      await beforeScreenshot?.();
      const result = await command(session, "Page.captureScreenshot", { format: "png" });
      session.screenshotCount += 1;
      const screenshotPath = join(session.evidenceDir, `screenshot-${String(session.screenshotCount).padStart(3, "0")}.png`);
      const png = Buffer.from(result.data, "base64");
      await writeFile(screenshotPath, png, { mode: 0o600 });
      return { qaSessionId: session.id, operation: "screenshot", screenshotPath, bytes: png.length, narrator: args.narration ? "started" : "not_requested", presenter: "suppressed" };
    }
    const expression = args.operation === "click"
      ? `(() => { const e=document.querySelector(${js(args.selector)}); if(!e) throw new Error('selector not found'); e.click(); return true; })()`
      : args.operation === "fill"
        ? `(() => { const e=document.querySelector(${js(args.selector)}); if(!e) throw new Error('selector not found'); e.focus(); e.value=${js(args.text)}; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${js(args.text)}})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`
        : `(() => { const e=document.activeElement; if(!e) throw new Error('no active element'); e.dispatchEvent(new KeyboardEvent('keydown',{key:${js(args.key)},bubbles:true})); e.dispatchEvent(new KeyboardEvent('keyup',{key:${js(args.key)},bubbles:true})); return true; })()`;
    await command(session, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return { qaSessionId: session.id, operation: args.operation, ok: true, narrator: args.narration ? "started" : "not_requested", presenter: "suppressed" };
  }
  async function cdp(args) {
    const session = sessions.get(args.qaSessionId); if (!session) throw new Error("QA session not found");
    // Raw CDP is constrained to the exact flattened session this driver
    // created. Target attach/create/close and navigation could escape it.
    if (/^(Target\.|Browser\.|Page\.navigate$|Page\.navigateToHistoryEntry$)/.test(args.method)) throw new Error("qa_cdp cannot attach, create, close, or navigate targets");
    if (args.narration) await narrate?.(args.narration);
    if (args.method === "Page.captureScreenshot") await beforeScreenshot?.();
    const result = await command(session, args.method, args.params ?? {});
    return { qaSessionId: session.id, method: args.method, result, narrator: args.narration ? "started" : "not_requested", presenter: args.method === "Page.captureScreenshot" ? "suppressed" : undefined };
  }
  function events(id, { since = 0 } = {}) { const session = sessions.get(id); if (!session) throw new Error("QA session not found"); const start = Number.isInteger(since) && since >= 0 ? since : 0; const events = session.cdp.events.filter((event) => event.sessionId === session.cdpSession); return { qaSessionId: id, cursor: events.length, events: events.slice(start).map(({ method, params }) => ({ method, params })) }; }
  async function captureStart(id) { const session = sessions.get(id); if (!session) throw new Error("QA session not found"); await command(session, "Network.enable"); await command(session, "Runtime.enable"); await command(session, "Log.enable"); session.captureCursor = session.cdp.events.length; return { qaSessionId: id, active: true, limits: { responses: 16, bodyChars: 65536 }, presenter: "suppressed" }; }
  const redact = (body) => body.replace(/(authorization|cookie|token|secret|password)\s*[:=]\s*[^\s",&]+/gi, "$1=[REDACTED]");
  async function captureExport(id) {
    const session = sessions.get(id); if (!session) throw new Error("QA session not found"); if (session.captureCursor == null) throw new Error("QA capture has not been started");
    const all = session.cdp.events.slice(session.captureCursor).filter((event) => event.sessionId === session.cdpSession);
    const byRequest = new Map();
    for (const event of all) { const requestId = event.params?.requestId; if (!requestId) continue; const item = byRequest.get(requestId) ?? {}; if (event.method === "Network.requestWillBeSent") item.request = event.params; if (event.method === "Network.responseReceived") item.response = event.params; if (event.method === "Network.loadingFinished") item.finished = event.params; byRequest.set(requestId, item); }
    const headers = (raw = {}) => Object.entries(raw).map(([name, value]) => ({ name, value: redact(String(value)) }));
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
    const evidence = { format: "sassfully/qa-evidence/v1", qaSessionId: id, limits: { responses: 16, bodyChars: 65536, console: 100 }, network, har, console, events: all.map(({ method, params }) => ({ method, params })).slice(0, 500), presenter: "suppressed" };
    const evidencePath = join(session.evidenceDir, "evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return { ...evidence, evidencePath, screenshotPaths: Array.from({ length: session.screenshotCount }, (_, index) => join(session.evidenceDir, `screenshot-${String(index + 1).padStart(3, "0")}.png`)) };
  }
  async function harExport(id) {
    const evidence = await captureExport(id);
    const harPath = join(sessions.get(id).evidenceDir, "network.har.json");
    await writeFile(harPath, `${JSON.stringify(evidence.har, null, 2)}\n`, { mode: 0o600 });
    return { ...evidence.har, qaSessionId: id, harPath };
  }
  async function stop(id) {
    const session = sessions.get(id); if (!session) throw new Error("QA session not found");
    sessions.delete(id); session.cdp.close(); session.child.kill(); await waitForExit(session.child);
    const cleanupError = await removeProfile(session.profile);
    if (cleanupError) throw new Error(`QA browser stopped but its temporary profile could not be removed: ${cleanupError.message}`);
    return { qaSessionId: id, stopped: true, evidenceDir: session.evidenceDir };
  }
  return { start, action, cdp, events, captureStart, captureExport, harExport, stop };
}
