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
import { waitForAnchor } from "./anchor-resolve.mjs";
import { validateDemoScript } from "./demo-script.mjs";

export const DEMO_MESSAGE_RUN = "sassfully:demo:run";
export const DEMO_MESSAGE_STOP = "sassfully:demo:stop";
export const DEMO_MESSAGE_RESULT = "sassfully:demo:result";

// createDemoController wires the pure player to a real document, with the
// side-effecting seams injectable ({document, executeAction, speak,
// onStepEvent}) so sequencing is testable in plain node. One demo at a time:
// run() cancels any prior run; stop() also clears the overlay and narration.
export function createDemoController({ document, executeAction, speak, onStepEvent } = {}) {
  if (!document) throw new Error("demo controller: a DOM document is required");
  const doSpeak = speak ?? defaultSpeak;
  const doAct = executeAction ?? ((action, element) => executeDemoAction({ document, action, element }));
  const emit = (event) => { try { onStepEvent?.(event); } catch { /* observer errors never break the run */ } };
  let active = null;
  let lastResult = null;

  function stop() {
    active?.cancel();
    active = null;
    cancelSpeech();
    clearDemoOverlay();
  }

  async function run(script) {
    const check = validateDemoScript(script);
    if (!check.ok) throw new Error(check.error);
    stop();
    const state = createDemoRunState();
    active = state;
    const deps = {
      // Targets are CSS strings or structured anchors; waitForAnchor handles
      // both (ranked role -> testid -> text -> css, ambiguity hard-fails).
      waitForTarget: (target) => waitForAnchor(document, target),
      spotlight: (element) => { emit({ type: "spotlight" }); showSpotlight(document, element); },
      caption: (text) => { emit({ type: "caption", text }); showCaption(document, text); },
      pulse: (element) => clickPulse(document, element),
      narrate: (text, { fallbackMs }) => { emit({ type: "narrate", text }); return doSpeak(text, { fallbackMs }); },
      act: (action, element) => { emit({ type: "act", action }); return doAct(action, element); },
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      clear: () => { cancelSpeech(); clearDemoOverlay(); },
      // Step lifecycle breadcrumbs (the embedded-host analogue of the
      // extension's rrweb stamps): start/end per step with the step id/index
      // and, on end, the matched anchor strategy + healed notes, so hosts
      // can record/QA runs identically to extension replays.
      stepStamp: (stamp) => emit({ type: "step", ...stamp }),
    };
    try {
      const demo = await runDemoScript({ script, deps, state });
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

  const status = () => ({ running: active != null, lastResult });
  return { run, stop, status };
}

// installDemoEmbed is the opt-in surface a host SDK calls when demo mode is
// enabled. It exposes `window.__sassfullyDemo = {run, stop, status}` for
// console / same-page automation, and — only when `allowedOrigins` is
// non-empty — listens for postMessage demo commands from exactly those
// origins, replying to the sender with a `sassfully:demo:result` message.
// Returns {api, controller, uninstall}.
export function installDemoEmbed({ window: win, document: doc, allowedOrigins = [], executeAction, speak, onStepEvent } = {}) {
  win = win ?? (typeof window !== "undefined" ? window : undefined);
  doc = doc ?? win?.document;
  if (!win || !doc) throw new Error("demo embed: a window and document are required");
  const controller = createDemoController({ document: doc, executeAction, speak, onStepEvent });
  const api = {
    run: (script) => controller.run(script),
    stop: () => controller.stop(),
    status: () => controller.status(),
  };
  win.__sassfullyDemo = api;

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
    uninstall() {
      if (listener) win.removeEventListener("message", listener);
      if (win.__sassfullyDemo === api) delete win.__sassfullyDemo;
      controller.stop();
    },
  };
}
