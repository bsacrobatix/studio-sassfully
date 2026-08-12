// Page-level demo surface for apps that embed sassfully directly: a
// controller (run/stop/status) plus an installer that exposes
// `window.__sassfullyDemo` and an origin-allowlisted postMessage channel.
// Protocol style modelled on slidey's embed-annotate (typed `{type: ...}`
// messages, injectable window/document, teardown function returned).
//
// Security posture: nothing here installs itself — the host opts in
// explicitly (e.g. mountReporter({demoMode: true})). The postMessage channel
// is OFF unless the host passes a non-empty caller-origin allowlist.
import { cancelSpeech, clearDemoOverlay, clickPulse, showCaption, showSpotlight, speak as defaultSpeak } from "./demo-overlay.mjs";
import { createDemoRunState, runDemoScript } from "./demo-player.mjs";
import { executeDemoAction } from "./actions.mjs";
import { anchorLabel, resolveAnchorOnce, waitForAnchor } from "./anchor-resolve.mjs";
import { resolveDemoPresenterSrc, validateDemoScript } from "./demo-script.mjs";
import { createBrowserEvidenceCapture } from "../../feedback-vue/src/browser-capture.mjs";

function rectPlacement(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect) return { mode: "dock", edge: "bottom-right", size: 0.38 };
  return { mode: "anchor", anchor: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } };
}

// Browser adapter for the loopback @sassfully/demo-tts server. Audio is
// fetched before an element is created so the service can return an accurate
// duration, and every failure falls back to the normal speech implementation.
export function createEdgeNarrator({ window: win, url, fallback = defaultSpeak, onStatus } = {}) {
  if (!url) return async () => {
    const result = { kind: "narration", status: "failed", mode: "edge-audio", error: "edge narration endpoint is not configured" };
    onStatus?.(result); return result;
  };
  return async (text, { fallbackMs, voice } = {}) => {
    try {
      const response = await win.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
      });
      if (!response.ok) throw new Error(`narration service returned ${response.status}`);
      const audio = new win.Audio(URL.createObjectURL(await response.blob()));
      await new Promise((resolve, reject) => {
        audio.addEventListener("ended", resolve, { once: true });
        audio.addEventListener("error", () => reject(new Error("edge narration audio failed")), { once: true });
        const play = audio.play();
        if (play) play.then(() => onStatus?.({ kind: "narration", status: "started", mode: "edge-audio", text, audible: "unobservable" })).catch(reject);
      });
      URL.revokeObjectURL(audio.src);
      return { status: "ended", mode: "edge-audio" };
    } catch (error) {
      const blocked = error?.name === "NotAllowedError" || /gesture|notallowed|play\(\)|suspended/i.test(error?.message ?? "");
      const result = { kind: "narration", status: blocked ? "blocked_user_gesture" : "failed", mode: "edge-audio", error: error?.message ?? "edge narration failed", text, ...(blocked ? { needs_audio_unlock: true } : {}) };
      // Never silently swap a user-gesture block for speechSynthesis: callers
      // must show the explicit unlock control, then rerun/resume the script.
      onStatus?.(result);
      return result;
    }
  };
}

// Must be called directly from a real user gesture. It deliberately unlocks
// media only; it never starts a demo or executes remote content.
export async function unlockDemoAudio(win) {
  const result = { attempted: true, audioContext: "unavailable", silentAudio: "unavailable", unlocked: false };
  try {
    const Context = win.AudioContext ?? win.webkitAudioContext;
    if (Context) { const context = new Context(); await context.resume(); result.audioContext = context.state; }
    if (win.Audio) {
      const audio = new win.Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=");
      audio.muted = true; await audio.play(); audio.pause(); result.silentAudio = "played";
    }
    result.unlocked = result.audioContext === "running" || result.silentAudio === "played";
  } catch (error) { result.error = error?.message ?? "audio unlock failed"; }
  return result;
}

export const DEMO_MESSAGE_RUN = "sassfully:demo:run";
export const DEMO_MESSAGE_STOP = "sassfully:demo:stop";
export const DEMO_MESSAGE_RESULT = "sassfully:demo:result";

// Explicit, demoMode-only bridge binding. It never evaluates caller code: the
// only accepted remote operations are a validated demo-script run and stop.
// `bridge.url` must be a local ws://127.0.0.1 endpoint supplied by the host.
export function bindEmbeddedDemoSession({ window: win, api, bridge, onEvent } = {}) {
  if (!bridge?.url || !win?.WebSocket || !api) return null;
  const url = new URL(bridge.url);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/embedded-demo") {
    throw new Error("embedded demo bridge must be ws://127.0.0.1:<port>/embedded-demo");
  }
  const sessionId = bridge.sessionId ?? win.crypto?.randomUUID?.() ?? `embedded-${Math.random().toString(36).slice(2, 14)}`;
  const maxRetries = bridge.maxRetries ?? 8;
  const retryMs = bridge.retryMs ?? 250;
  let socket = null; let retryTimer = null; let retries = 0; let stopped = false; let live = "connecting";
  const emit = (status, extra = {}) => { live = status; onEvent?.({ type: "embedded-demo-session", sessionId, status, retries, ...extra }); };
  const send = (message) => { if (socket?.readyState === win.WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const scheduleReconnect = (reason) => {
    if (stopped || retryTimer != null) return;
    if (retries >= maxRetries) return emit("failed", { reason });
    retries += 1;
    const delay = Math.min(5000, retryMs * (2 ** (retries - 1)));
    emit("reconnecting", { reason, delay });
    retryTimer = (win.setTimeout ?? setTimeout)(() => { retryTimer = null; connect(); }, delay);
  };
  const connect = () => {
    if (stopped) return;
    emit("connecting");
    socket = new win.WebSocket(url.href);
    socket.addEventListener("open", () => { retries = 0; send({ type: "embedded-demo:hello", sessionId, url: win.location?.href ?? null }); emit("bound"); });
    socket.addEventListener("error", () => scheduleReconnect("socket error"));
    socket.addEventListener("close", () => scheduleReconnect("socket closed"));
    socket.addEventListener("message", async (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "embedded-demo:run") {
      const check = validateDemoScript(message.script);
      if (!check.ok) return send({ type: "result", id: message.id, ok: false, error: check.error });
      try {
        const demo = await api.run(message.script);
        send({ type: "result", id: message.id, ok: true, result: { sessionId, url: win.location?.href ?? null, demo, drift: demo.completedSteps?.flatMap((step) => step.healed ?? []) ?? [] } });
      } catch (error) { send({ type: "result", id: message.id, ok: false, error: error.message }); }
    }
    if (message.type === "embedded-demo:validate") {
      const check = validateDemoScript(message.script);
      if (!check.ok) return send({ type: "result", id: message.id, ok: true, result: { ok: false, errors: [{ error: check.error }], drift: [] } });
      const errors = []; const drift = [];
      for (const step of message.script.steps) {
        for (const [kind, target] of [["spotlight", step.spotlight], ["action", step.action?.selector]]) {
          if (!target || (kind === "action" && step.action?.kind === "press")) continue;
          try {
            const resolved = resolveAnchorOnce(win.document, target);
            if (!resolved) errors.push({ stepId: step.id ?? null, target: kind, error: `not found: ${anchorLabel(target)}` });
            else if (resolved.healed) drift.push({ stepId: step.id ?? null, target: kind, ...resolved.healed });
          } catch (error) { errors.push({ stepId: step.id ?? null, target: kind, error: error.message }); }
        }
      }
      return send({ type: "result", id: message.id, ok: true, result: { ok: errors.length === 0, errors, drift, url: win.location?.href ?? null } });
    }
    if (message.type === "embedded-demo:stop") { api.stop(); send({ type: "result", id: message.id, ok: true, result: { sessionId, stopped: true } }); }
    if (message.type === "embedded-demo:resume") {
      try { return send({ type: "result", id: message.id, ok: true, result: { sessionId, demo: await api.resume() } }); }
      catch (error) { return send({ type: "result", id: message.id, ok: false, error: error.message }); }
    }
    if (message.type === "embedded-demo:evidence") {
      const action = message.action;
      if (!api.evidence?.[action]) return send({ type: "result", id: message.id, ok: false, error: "unsupported evidence action" });
      try { return send({ type: "result", id: message.id, ok: true, result: api.evidence[action]({ permission: message.permission === true }) }); }
      catch (error) { return send({ type: "result", id: message.id, ok: false, error: error.message }); }
    }
    if (message.type === "embedded-demo:qa-narrate") {
      try { return send({ type: "result", id: message.id, ok: true, result: { narration: await api.narrate(message.text) } }); }
      catch (error) { return send({ type: "result", id: message.id, ok: false, error: error.message }); }
    }
    });
  };
  connect();
  return {
    sessionId,
    get socket() { return socket; },
    status: () => ({ sessionId, status: live, retries }),
    close: () => { stopped = true; if (retryTimer != null) (win.clearTimeout ?? clearTimeout)(retryTimer); retryTimer = null; socket?.close(); emit("closed"); },
  };
}

// createDemoController wires the pure player to a real document, with the
// side-effecting seams injectable ({document, executeAction, speak,
// onStepEvent}) so sequencing is testable in plain node. One demo at a time:
// run() cancels any prior run; stop() also clears the overlay and narration.
export function createDemoController({ document, executeAction, speak, narrationUrl, mountStageLayer, assetBase, onStepEvent } = {}) {
  if (!document) throw new Error("demo controller: a DOM document is required");
  const media = { narration: [], stage: [], audioUnlock: null };
  let evidenceCapture = null; let evidenceActive = false; let evidenceStopped = null;
  const demoStamps = [];
  const safeStamp = (event) => ({
    type: event.type, index: event.index ?? null, id: event.id ?? null, phase: event.phase ?? null,
    ok: event.ok ?? null, anchor: event.anchor ?? null, healed: event.healed ?? null,
    status: event.status ?? null, kind: event.kind ?? null, mode: event.mode ?? null,
    action: event.action?.kind ?? null, error: event.error ? String(event.error).slice(0, 240) : null,
  });
  const emit = (event) => { if (evidenceActive) { demoStamps.push({ at: new Date().toISOString(), ...safeStamp(event) }); if (demoStamps.length > 200) demoStamps.splice(0, demoStamps.length - 200); } try { onStepEvent?.(event); } catch { /* observer errors never break the run */ } };
  const reportMedia = (event) => { media.narration.push(event); emit(event); };
  const doSpeak = speak ?? createEdgeNarrator({ window: document.defaultView, url: narrationUrl, onStatus: reportMedia });
  const doAct = executeAction ?? ((action, element) => executeDemoAction({ document, action, element }));
  let active = null;
  let lastResult = null;
  let lastScript = null;
  let stageLayer = null;

  function stop() {
    active?.cancel();
    active = null;
    cancelSpeech();
    clearDemoOverlay();
    stageLayer?.stop();
  }

  async function run(script) {
    const check = validateDemoScript(script);
    if (!check.ok) throw new Error(check.error);
    stop();
    lastScript = script;
    const state = createDemoRunState();
    active = state;
    const deps = {
      // Targets are CSS strings or structured anchors; waitForAnchor handles
      // both (ranked role -> testid -> text -> css, ambiguity hard-fails).
      waitForTarget: (target) => waitForAnchor(document, target),
      spotlight: (element, options) => { emit({ type: "spotlight", ...options }); showSpotlight(document, element, options); },
      caption: (text) => { emit({ type: "caption", text }); showCaption(document, text); },
      pulse: (element) => clickPulse(document, element),
      narrate: async (text, { fallbackMs, voice }) => { emit({ type: "narrate", text }); const result = await doSpeak(text, { fallbackMs, voice }); return result; },
      stage: async (stage, target) => {
        try {
          if (!mountStageLayer) return { status: "unavailable" };
          stageLayer ??= await mountStageLayer(document);
          const placement = stage.anchor === "target" ? rectPlacement(target) : (stage.anchor ?? { mode: "dock", edge: "bottom-right", size: 0.38 });
          const mounted = { kind: "stage", status: "mounted", placement, presenter: stage.presenter?.id ?? null };
          media.stage.push(mounted); emit(mounted);
          // The script only ever names a package-relative presenter path
          // (DEMO_PRESENTER_SRC in demo-script.mjs); assetBase is a
          // host-supplied, separately-validated rewrite of where that tree
          // is actually served from — with no assetBase this is a no-op.
          const presenter = stage.presenter
            ? { ...stage.presenter, src: resolveDemoPresenterSrc(stage.presenter.src, assetBase) }
            : stage.presenter;
          const playing = stageLayer.playScene({ scene: stage.scene, chars: stage.chars, roster: stage.roster, placement, presenter });
          if (stage.persistent) {
            // Keep the presenter alive, but surface an eventual render/runtime
            // failure rather than leaving a rejected fire-and-forget promise.
            playing.catch((error) => {
              const failed = { kind: "stage", status: "failed", error: error?.message ?? "stage failed" };
              media.stage.push(failed); emit(failed);
            });
            return mounted;
          }
          await playing;
          return { status: "ended" };
        } catch (error) {
          const failed = { kind: "stage", status: "failed", error: error?.message ?? "stage failed" };
          media.stage.push(failed); emit(failed);
          return failed;
        }
      },
      act: (action, element) => { emit({ type: "act", action }); return doAct(action, element); },
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      clear: () => { cancelSpeech(); clearDemoOverlay(); stageLayer?.stop(); },
      // Step lifecycle breadcrumbs (the embedded-host analogue of the
      // extension's rrweb stamps): start/end per step with the step id/index
      // and, on end, the matched anchor strategy + healed notes, so hosts
      // can record/QA runs identically to extension replays.
      stepStamp: (stamp) => emit({ type: "step", ...stamp }),
    };
    try {
      media.narration = []; media.stage = [];
      const raw = await runDemoScript({ script, deps, state });
      const demo = { ...raw, media: { narration: media.narration, stage: media.stage, audioUnlock: media.audioUnlock } };
      lastResult = demo;
      emit({ type: "done", demo });
      return demo;
    } catch (error) {
      lastResult = { failed: true, error: error.message };
      emit({ type: "error", error: error.message });
      throw error;
    } finally {
      if (active === state) active = null;
    }
  }

  const status = () => ({ running: active != null, lastResult, media: { narration: media.narration, stage: media.stage, audioUnlock: media.audioUnlock } });
  const unlockAudio = async () => {
    media.audioUnlock = await unlockDemoAudio(document.defaultView);
    emit({ type: "audio-unlock", ...media.audioUnlock });
    return media.audioUnlock;
  };
  const evidence = {
    start: ({ permission = false } = {}) => {
      if (permission !== true) throw new Error("embedded evidence capture requires explicit permission: true");
      evidenceCapture?.dispose(); evidenceCapture = createBrowserEvidenceCapture({ window: document.defaultView, maxEntries: 50 });
      evidenceActive = true; evidenceStopped = null; demoStamps.length = 0; emit({ type: "evidence", status: "started" });
      return { active: true, capability: "redacted in-page network/console/error providers; full Chrome HAR remains extension/CDP-only" };
    },
    stop: () => { evidenceActive = false; evidenceStopped = new Date().toISOString(); evidenceCapture?.dispose(); return { active: false, stoppedAt: evidenceStopped, stampCount: demoStamps.length }; },
    export: () => {
      if (!evidenceCapture) throw new Error("embedded evidence capture has not been started");
      const items = evidenceCapture.providers.map((provider) => provider.capture());
      items.push({ kind: "demo-execution", label: "Demo execution stamps", snippet: `${demoStamps.length} redacted demo execution stamps`, contentType: "application/json", transport: "sidecar-json", payload: { entries: demoStamps.slice() } });
      return { format: "sassfully/feedback-evidence-export/v1", capability: "redacted in-page evidence; full Chrome HAR remains extension/CDP-only", stoppedAt: evidenceStopped, items };
    },
  };
  const resume = () => {
    if (!lastScript) throw new Error("demo controller: no prior script to resume");
    return run(lastScript);
  };
  const narrate = async (text) => {
    if (typeof text !== "string" || !text.length || text.length > 2000) throw new Error("QA narration must be a non-empty string (max 2000 chars)");
    return doSpeak(text, { fallbackMs: 0 });
  };
  return { run, stop, status, unlockAudio, resume, evidence, narrate, destroy() { stop(); evidenceCapture?.dispose(); stageLayer?.destroy(); stageLayer = null; } };
}

// installDemoEmbed is the opt-in surface a host SDK calls when demo mode is
// enabled. It exposes `window.__sassfullyDemo = {run, stop, status}` for
// console / same-page automation, and — only when `allowedOrigins` is
// non-empty — listens for postMessage demo commands from exactly those
// origins, replying to the sender with a `sassfully:demo:result` message.
// Returns {api, controller, uninstall}.
export function installDemoEmbed({ window: win, document: doc, allowedOrigins = [], executeAction, speak, narrationUrl, mountStageLayer, assetBase, embeddedBridge, onStepEvent } = {}) {
  win = win ?? (typeof window !== "undefined" ? window : undefined);
  doc = doc ?? win?.document;
  if (!win || !doc) throw new Error("demo embed: a window and document are required");
  const stageMount = mountStageLayer ?? (async () => {
    const mod = await import("../../demo-stage/src/stage-layer.mjs");
    return mod.mountStageLayer(doc);
  });
  const controller = createDemoController({ document: doc, executeAction, speak, narrationUrl, mountStageLayer: stageMount, assetBase, onStepEvent });
  const api = {
    run: (script) => controller.run(script),
    stop: () => controller.stop(),
    status: () => controller.status(),
    unlockAudio: () => controller.unlockAudio(),
    resume: () => controller.resume(),
    evidence: controller.evidence,
    narrate: (text) => controller.narrate(text),
  };
  win.__sassfullyDemo = api;
  const session = bindEmbeddedDemoSession({ window: win, api, bridge: embeddedBridge, onEvent: onStepEvent });

  let listener = null;
  if (Array.isArray(allowedOrigins) && allowedOrigins.length) {
    listener = async (event) => {
      if (!allowedOrigins.includes(event.origin)) return; // silent: no oracle for probing origins
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== DEMO_MESSAGE_RUN && data.type !== DEMO_MESSAGE_STOP) return;
      const reply = (payload) => {
        try { event.source?.postMessage({ type: DEMO_MESSAGE_RESULT, requestId: data.requestId ?? null, ...payload }, event.origin); }
        catch { /* sender window may be gone */ }
      };
      if (data.type === DEMO_MESSAGE_STOP) { controller.stop(); reply({ ok: true, stopped: true }); return; }
      try { reply({ ok: true, demo: await controller.run(data.script) }); }
      catch (error) { reply({ ok: false, error: error.message }); }
    };
    win.addEventListener("message", listener);
  }

  return {
    api,
    controller,
    session,
    uninstall() {
      if (listener) win.removeEventListener("message", listener);
      if (win.__sassfullyDemo === api) delete win.__sassfullyDemo;
      controller.destroy();
      session?.close();
    },
  };
}
