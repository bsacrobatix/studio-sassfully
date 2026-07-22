// Dedicated review tab. The content script stashed the raw draft via the
// background worker; this page reconstructs it with the core machine and
// walks review -> approve -> submit -> sidecars against the local store of
// record. Pushing to a configured intake is a separate explicit action.
import { createDraft, attachEvidence, setUserText, setEvidenceUpload, beginReview, approveReview, submit, uploadEvidence, createRouter, httpSink } from "../content/core/deps.mjs";
import { extensionAnchor, extensionPrivacyManifest } from "../content/core/standalone.mjs";
import { createBundleStore, extensionLocalSink, syncToIntake } from "../content/core/storage.mjs";
import { idbBackend } from "../lib/idb-backend.mjs";

const app = document.getElementById("app");
const draftId = location.hash.slice(1);
const { draft: stashed } = await chrome.runtime.sendMessage({ type: "load-draft", id: draftId });

if (!stashed) {
  app.textContent = "This draft is gone — it may already have been submitted or discarded.";
} else {
  const manifest = extensionPrivacyManifest();
  const store = createBundleStore(idbBackend({ store: "records" }));
  const router = createRouter({ sinks: [extensionLocalSink(store)] });
  const draft = createDraft(stashed.kind, extensionAnchor({ url: stashed.url, bbox: stashed.bbox }), { context: { mode: "extension-standalone", ...(stashed.extensionVersion ? { extensionVersion: stashed.extensionVersion } : {}) } });
  setUserText(draft, stashed.userText ?? "");
  for (const item of stashed.evidence ?? []) attachEvidence(draft, item);

  const render = () => {
    const { payload, verdict } = beginReview(draft, manifest);
    app.innerHTML = `
      <h2>Bundle</h2>
      <pre>${JSON.stringify(payload, null, 2).replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"))}</pre>
      <h2>Raw evidence — approve uploads individually</h2>
      <div id="evidence"></div>
      ${verdict.ok ? "" : `<p class="violations">Privacy fails closed: ${verdict.violations.map((v) => `${v.path} (${v.reason})`).join("; ")}</p>`}
      <p><button id="submit" ${verdict.ok ? "" : "disabled"}>Submit locally</button><button id="discard">Discard</button></p>
      <div id="result"></div>`;
    const evidenceBox = app.querySelector("#evidence");
    for (const item of draft.evidence) {
      const row = document.createElement("div");
      row.className = "evidence";
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.uploadApproved;
      checkbox.addEventListener("change", () => setEvidenceUpload(draft, item.digest, checkbox.checked));
      label.append(checkbox, `${item.label} — ${item.snippet ?? item.kind} (${item.size} bytes, digest ${item.digest})`);
      row.appendChild(label);
      evidenceBox.appendChild(row);
    }
    app.querySelector("#discard").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "drop-draft", id: draftId });
      app.textContent = "Draft discarded. Nothing was stored or sent.";
    });
    app.querySelector("#submit")?.addEventListener("click", async () => {
      const result = app.querySelector("#result");
      try {
        approveReview(draft, manifest);
        const receipt = await submit(draft, router);
        const evidenceResults = await uploadEvidence(draft, router);
        await chrome.runtime.sendMessage({ type: "drop-draft", id: draftId });
        const { intake } = await chrome.storage.local.get("intake");
        result.innerHTML = `<p class="receipt">Stored locally as ${receipt.ref} (${evidenceResults.length} sidecar${evidenceResults.length === 1 ? "" : "s"}).</p>` +
          (intake?.url ? `<p><button id="push">Push to ${intake.url} now</button></p>` : `<p class="muted">No intake configured — export from the popup, or set an intake URL in options.</p>`);
        result.querySelector("#push")?.addEventListener("click", async () => {
          const outcomes = await syncToIntake(store, httpSink({ url: intake.url, evidenceUrl: intake.evidenceUrl }));
          result.insertAdjacentHTML("beforeend", `<pre>${JSON.stringify(outcomes, null, 2)}</pre>`);
        });
      } catch (error) { result.innerHTML = `<p class="violations">${String(error?.message ?? error)}</p>`; }
    });
  };
  render();
}
