// Shadow-DOM capture launcher: floating button, kind picker, prose field, and
// an element picker that yields a bbox. Draft phase only — review runs in a
// dedicated extension tab with real estate for per-item approvals, isolated
// from host CSS/CSP. The shadow root keeps host styles and ours apart.
import { KIND_CONFIG } from "./core/deps.mjs";

const STYLE = `
  .sassfully-fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 44px; height: 44px; border-radius: 50%; border: none; background: #1565c0; color: #fff; font-size: 20px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .sassfully-panel { position: fixed; right: 16px; bottom: 70px; z-index: 2147483646; width: 300px; background: #fff; color: #222; border: 1px solid #ccc; border-radius: 8px; padding: 12px; font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
  .sassfully-panel label { display: block; margin: 8px 0 2px; font-weight: 600; }
  .sassfully-panel select, .sassfully-panel textarea { width: 100%; box-sizing: border-box; }
  .sassfully-panel textarea { min-height: 60px; }
  .sassfully-row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
  .sassfully-row button { flex: 1; padding: 6px; cursor: pointer; }
  .sassfully-hint { color: #666; font-size: 12px; margin-top: 6px; }
  .sassfully-pick { position: fixed; z-index: 2147483647; pointer-events: none; border: 2px solid #1565c0; background: rgba(21,101,192,.15); }
`;

function pickElement(doc) {
  return new Promise((resolve) => {
    const highlight = doc.createElement("div");
    highlight.className = "sassfully-pick";
    doc.documentElement.appendChild(highlight);
    const onMove = (event) => {
      const target = doc.elementFromPoint(event.clientX, event.clientY);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      Object.assign(highlight.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const done = (bbox) => { doc.removeEventListener("mousemove", onMove, true); doc.removeEventListener("click", onClick, true); doc.removeEventListener("keydown", onKey, true); highlight.remove(); resolve(bbox); };
    const onClick = (event) => {
      event.preventDefault(); event.stopPropagation();
      const target = doc.elementFromPoint(event.clientX, event.clientY);
      const rect = target?.getBoundingClientRect();
      done(rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : undefined);
    };
    const onKey = (event) => { if (event.key === "Escape") done(undefined); };
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKey, true);
  });
}

export function mountOverlay({ document: doc, onSubmit }) {
  const host = doc.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = STYLE;
  shadow.appendChild(style);

  const fab = doc.createElement("button");
  fab.className = "sassfully-fab";
  fab.title = "Sassfully feedback";
  fab.textContent = "✎";
  shadow.appendChild(fab);

  let panel = null; let bbox;
  const closePanel = () => { panel?.remove(); panel = null; bbox = undefined; };
  fab.addEventListener("click", () => {
    if (panel) { closePanel(); return; }
    panel = doc.createElement("div");
    panel.className = "sassfully-panel";
    const kinds = Object.entries(KIND_CONFIG).map(([id, config]) => `<option value="${id}">${config.label}</option>`).join("");
    panel.innerHTML = `
      <label>Kind</label><select data-kind>${kinds}</select>
      <label>What happened?</label><textarea data-text placeholder="Describe it — you review everything before it leaves this browser."></textarea>
      <div class="sassfully-row"><button data-pick type="button">Pick element</button><button data-go type="button">Capture &amp; review</button></div>
      <label class="sassfully-hint"><input data-replay type="checkbox" checked> include session replay</label>
      <div class="sassfully-hint" data-status></div>`;
    shadow.appendChild(panel);
    panel.querySelector("[data-pick]").addEventListener("click", async () => {
      panel.style.display = "none";
      bbox = await pickElement(doc);
      panel.style.display = "";
      panel.querySelector("[data-status]").textContent = bbox ? `element pinned at [${bbox.join(", ")}]` : "pick cancelled";
    });
    panel.querySelector("[data-go]").addEventListener("click", async () => {
      panel.querySelector("[data-status]").textContent = "capturing…";
      await onSubmit({
        kind: panel.querySelector("[data-kind]").value,
        userText: panel.querySelector("[data-text]").value,
        bbox,
        includeReplay: panel.querySelector("[data-replay]").checked,
      });
      closePanel();
    });
  });

  doc.documentElement.appendChild(host);
  return { unmount() { closePanel(); host.remove(); } };
}
