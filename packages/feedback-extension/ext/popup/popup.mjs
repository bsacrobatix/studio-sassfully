// Popup: per-origin enablement (host permission requested at enable time, so
// nothing is observable before the user says so), recording mode + state in
// words (req-recording-visibility), on-demand start/stop, and export of the
// local store as files.
import { createBundleStore } from "../content/core/storage.mjs";
import { createReplayFixtureEnvelope, exportStore } from "../content/core/export.mjs";
import { idbBackend } from "../lib/idb-backend.mjs";
import { storyBridgeSection } from "./story-bridge-view.mjs";

const app = document.getElementById("app");
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let origin = null;
try { origin = new URL(tab?.url ?? "").origin; } catch { /* chrome:// pages etc. */ }

async function render() {
  if (!origin || !origin.startsWith("http")) { app.innerHTML = `<div class="state off">Sassfully can't run on this page.</div>${exportSection()}`; wireExport(); return; }
  const { config } = await chrome.runtime.sendMessage({ type: "get-state", origin });
  const { bridge, live } = await chrome.runtime.sendMessage({ type: "story-bridge-state" });
  let live = null;
  if (config.enabled && tab?.id != null) { try { live = await chrome.tabs.sendMessage(tab.id, { type: "ring-stats" }); } catch { /* page not yet reloaded since enable */ } }
  const stateLine = !config.enabled
    ? `<div class="state off">Not enabled for ${origin}</div>`
    : live?.bridged ? `<div class="state sdk">This site runs the Sassfully SDK — the extension enriches it.</div>`
    : live?.state === "rec" ? `<div class="state rec">Recording on demand (REC) on this site.</div>`
    : live?.state === "ring" ? `<div class="state on">Rolling buffer is ON for this site${live?.stats ? ` — ${live.stats.events} events buffered` : ""}.</div>`
    : `<div class="state off">Capture is OFF on this tab${config.enabled ? " (reload the page to start)" : ""}.</div>`;
  app.innerHTML = `
    ${stateLine}
    ${config.enabled ? `
      <label><input type="radio" name="mode" value="ring" ${config.mode !== "manual" ? "checked" : ""}> Rolling buffer (trailing window)</label>
      <label><input type="radio" name="mode" value="manual" ${config.mode === "manual" ? "checked" : ""}> Record on demand only</label>
      ${config.mode === "manual" ? `<button id="rec">${live?.state === "rec" ? "■ Stop recording" : "● Start recording"}</button>` : ""}
      <button id="disable">Disable on this site</button>
    ` : `<button id="enable">Enable on ${origin}</button>`}
    ${storyBridgeSection({ origin, url: tab?.url ?? "", config, bridge, live, tabId: tab?.id })}
    ${exportSection()}`;
  app.querySelector("#enable")?.addEventListener("click", async () => {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return;
    await chrome.runtime.sendMessage({ type: "set-origin", origin, config: { enabled: true } });
    if (tab?.id != null) chrome.tabs.reload(tab.id);
    render();
  });
  app.querySelector("#disable")?.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "set-origin", origin, config: { enabled: false } });
    await chrome.runtime.sendMessage({ type: "badge", state: "off", tabId: tab?.id });
    if (tab?.id != null) chrome.tabs.reload(tab.id);
    render();
  });
  for (const radio of app.querySelectorAll("input[name=mode]")) radio.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({ type: "set-origin", origin, config: { mode: radio.value } });
    if (tab?.id != null) chrome.tabs.reload(tab.id);
    render();
  });
  app.querySelector("#rec")?.addEventListener("click", async () => {
    if (tab?.id != null) await chrome.tabs.sendMessage(tab.id, { type: "recording", on: live?.state !== "rec" });
    render();
  });
  app.querySelector("#pair-story")?.addEventListener("click", async () => {
    const token = app.querySelector("#story-token").value.trim();
    const out = await chrome.runtime.sendMessage({ type: "pair-story-bridge", tabId: tab.id, token });
    const note = app.querySelector("#story-note");
    note.textContent = out.ok ? "Paired to the local bridge." : out.error;
    if (out.ok) render();
  });
  app.querySelector("#unpair-story")?.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "unpair-story-bridge" }); render(); });
  wireExport();
}

function exportSection() { return `<button id="export">Export stored feedback</button><button id="export-replay-fixture">Export replay fixture</button><div class="muted" id="export-note"></div>`; }
function wireExport() {
  app.querySelector("#export")?.addEventListener("click", async () => {
    const out = await exportStore(createBundleStore(idbBackend({ store: "records" })));
    const note = app.querySelector("#export-note");
    if (!out.jsonl) { note.textContent = "Nothing stored yet."; return; }
    const save = (name, body) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
      link.download = name.replaceAll("/", "__");
      link.click();
      URL.revokeObjectURL(link.href);
    };
    save("feedback.jsonl", out.jsonl);
    for (const file of out.sidecarFiles) save(file.name, file.body);
    note.textContent = `Exported ${out.jsonl.trim().split("\n").length} bundle(s), ${out.sidecarFiles.length} sidecar file(s).`;
  });
  app.querySelector("#export-replay-fixture")?.addEventListener("click", async () => {
    const records = await createBundleStore(idbBackend({ store: "records" })).list();
    const note = app.querySelector("#export-note");
    try {
      const fixture = createReplayFixtureEnvelope(records);
      if (!fixture.entries.length) { note.textContent = "No reviewed replay sidecars stored yet."; return; }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(fixture)], { type: "application/json" }));
      link.download = "sassfully-replay-fixture.json"; link.click(); URL.revokeObjectURL(link.href);
      note.textContent = `Exported one replay fixture envelope with ${fixture.entries.length} reviewed session(s).`;
    } catch (error) { note.textContent = error.message; }
  });
}

render();
