// Classic MAIN-world script, declared after vendor/rrweb-record.iife.js so
// the rrwebRecord global exists. Recording starts only when the isolated
// world asks (per-origin enablement and mode live there); masking is applied
// at record time, before any event crosses worlds (capture-time masking per
// rich-evidence-sidecars). Telemetry reuses the ESM relay module via dynamic
// import — a strict page CSP can block that import, in which case replay
// still works and telemetry reports unavailable.
(() => {
  const CHANNEL = "sassfully-ext/rrweb/v1";
  let stopRecording = null;
  function start() {
    if (stopRecording || typeof rrwebRecord !== "function") return;
    stopRecording = rrwebRecord({
      emit(event) { window.postMessage({ $channel: CHANNEL, type: "rrweb-event", event }, "*"); },
      checkoutEveryNms: 10000,
      maskAllInputs: true,
      maskInputOptions: { password: true },
      blockClass: "sassfully-block",
      maskTextClass: "sassfully-mask",
      slimDOMOptions: "all",
      sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
    });
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.$channel !== CHANNEL || event.source !== window) return;
    if (msg.type === "rrweb-start") start();
    else if (msg.type === "rrweb-stop" && stopRecording) { stopRecording(); stopRecording = null; }
    else if (msg.type === "demo-step-stamp" && msg.stamp) {
      // Narrated-demo QA breadcrumb: stamp each demo step start/end (step id,
      // index, anchor used, healed flag) into the rrweb timeline so demo runs
      // are auditable in replays. No-op when recording is off.
      try { if (stopRecording && typeof rrwebRecord.addCustomEvent === "function") rrwebRecord.addCustomEvent("sassfully-demo-step", msg.stamp); } catch { /* best-effort */ }
    }
    else if (msg.type === "telemetry-boot" && msg.moduleUrl) {
      import(msg.moduleUrl)
        .then((mod) => mod.startMainTelemetry({ window }))
        .catch(() => window.postMessage({ $channel: CHANNEL, type: "telemetry-unavailable" }, "*"));
    }
  });
  window.postMessage({ $channel: CHANNEL, type: "rrweb-ready" }, "*");
})();
