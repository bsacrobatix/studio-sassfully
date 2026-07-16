// Opt-in, bounded browser evidence providers. This module deliberately never
// captures request/response bodies: a host may add a reviewed provider with
// stronger, product-specific redaction when that evidence is justified.

const SENSITIVE = /authorization|cookie|token|secret|password|api[-_]?key/i;

function redact(value, key = "") {
  if (SENSITIVE.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

function headers(headers) {
  const out = [];
  headers?.forEach?.((value, name) => out.push({ name, value: SENSITIVE.test(name) ? "[redacted]" : value }));
  return out;
}

function safeUrl(raw, base) {
  try { const url = new URL(raw, base); for (const key of [...url.searchParams.keys()]) if (SENSITIVE.test(key)) url.searchParams.set(key, "[redacted]"); return url.toString(); } catch { return String(raw); }
}

/**
 * Creates generic providers for browser-visible network, console, and error
 * summaries. Screenshot and replay are accepted as host callbacks because
 * their pixels/events require host-specific masking before they are safe.
 */
export function createBrowserEvidenceCapture({ window: win = globalThis.window, maxEntries = 50, screenshot, replay } = {}) {
  if (!win) throw new Error("browser capture requires a window");
  const network = [], consoleEntries = [], errors = [];
  const push = (list, value) => { list.push(value); if (list.length > maxEntries) list.splice(0, list.length - maxEntries); };
  const originalFetch = win.fetch;
  const nativeFetch = originalFetch?.bind(win);
  if (nativeFetch) win.fetch = async (input, init = {}) => {
    const started = Date.now(); const request = input instanceof Request ? input : null;
    const url = safeUrl(request?.url ?? input, win.location?.href);
    const method = init.method ?? request?.method ?? "GET";
    const reqHeaders = new Headers(init.headers ?? request?.headers ?? undefined);
    const entry = { startedDateTime: new Date(started).toISOString(), time: 0, request: { method: String(method).toUpperCase(), url, headers: headers(reqHeaders) }, response: { status: 0, headers: [] } };
    push(network, entry);
    try { const response = await nativeFetch(input, init); entry.time = Date.now() - started; entry.response = { status: response.status, headers: headers(response.headers) }; return response; }
    catch (error) { entry.time = Date.now() - started; entry.error = redact(error instanceof Error ? error.message : String(error)); throw error; }
  };
  const originalConsole = {};
  for (const level of ["error", "warn"]) if (typeof win.console?.[level] === "function") { originalConsole[level] = win.console[level]; win.console[level] = (...args) => { push(consoleEntries, { level, at: new Date().toISOString(), text: redact(args.map((arg) => typeof arg === "string" ? arg : "[non-string console value]").join(" ")) }); return originalConsole[level](...args); }; }
  const onError = (event) => push(errors, { at: new Date().toISOString(), message: redact(event.message ?? "Unknown error"), source: safeUrl(event.filename ?? "", win.location?.href), line: event.lineno ?? null });
  const onUnhandledRejection = (event) => push(errors, { at: new Date().toISOString(), message: redact(event.reason instanceof Error ? event.reason.message : String(event.reason ?? "Unhandled rejection")) });
  win.addEventListener?.("error", onError);
  win.addEventListener?.("unhandledrejection", onUnhandledRejection);
  const provider = (id, label, payload) => ({ id, label, capture: () => ({ kind: id, label, snippet: `${payload().length} captured ${label.toLowerCase()} entries`, contentType: "application/json", transport: "sidecar-json", payload: { entries: payload() } }) });
  const providers = [
    provider("network", "Network summary", () => network.map((entry) => structuredClone(entry))),
    provider("console", "Console warnings and errors", () => consoleEntries.map((entry) => ({ ...entry }))),
    provider("error", "Browser errors", () => errors.map((entry) => ({ ...entry }))),
  ];
  if (typeof screenshot === "function") providers.push({ id: "screenshot", label: "Screenshot", description: "Captured and masked by the host", capture: screenshot });
  if (typeof replay === "function") providers.push({ id: "replay", label: "Replay", description: "Captured and masked by the host", capture: replay });
  return { providers, dispose() { if (originalFetch) win.fetch = originalFetch; for (const [level, fn] of Object.entries(originalConsole)) win.console[level] = fn; win.removeEventListener?.("error", onError); win.removeEventListener?.("unhandledrejection", onUnhandledRejection); } };
}
