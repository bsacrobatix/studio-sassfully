// Narrated-demo script contract (sassfully/demo-script/v1). Bounded on both
// step count and string sizes so a malformed or hostile script cannot balloon
// the page. Extracted verbatim from the extension's story-bridge-policy.mjs
// (which keeps its own copy so the extension and stdio server validate
// identically); a later integration points the extension at this module.
export const DEMO_SCRIPT_VERSION = "sassfully/demo-script/v1";
export const DEMO_SCRIPT_MAX_STEPS = 50;
const DEMO_ACTION_KINDS = ["click", "fill", "press"];
const boundedString = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

export function validateDemoScript(script) {
  if (!script || typeof script !== "object") return { ok: false, error: "demo script must be an object" };
  if (script.version != null && script.version !== DEMO_SCRIPT_VERSION) return { ok: false, error: `demo script version must be ${DEMO_SCRIPT_VERSION}` };
  if (!Array.isArray(script.steps) || !script.steps.length) return { ok: false, error: "demo script needs a non-empty steps array" };
  if (script.steps.length > DEMO_SCRIPT_MAX_STEPS) return { ok: false, error: `demo script is capped at ${DEMO_SCRIPT_MAX_STEPS} steps` };
  for (let index = 0; index < script.steps.length; index += 1) {
    const step = script.steps[index];
    const at = `step ${index + 1}`;
    if (!step || typeof step !== "object") return { ok: false, error: `${at} must be an object` };
    if (step.id != null && !boundedString(step.id, 100)) return { ok: false, error: `${at}: id must be a short string` };
    if (step.spotlight != null && !boundedString(step.spotlight, 500)) return { ok: false, error: `${at}: spotlight must be a selector string (max 500 chars)` };
    if (step.caption != null && !boundedString(step.caption, 500)) return { ok: false, error: `${at}: caption must be a string (max 500 chars)` };
    if (step.narration != null && !boundedString(step.narration, 2000)) return { ok: false, error: `${at}: narration must be a string (max 2000 chars)` };
    if (step.dwellMs != null && !(Number.isFinite(step.dwellMs) && step.dwellMs >= 0 && step.dwellMs <= 60000)) return { ok: false, error: `${at}: dwellMs must be 0-60000` };
    if (step.action != null) {
      const action = step.action;
      if (!action || typeof action !== "object") return { ok: false, error: `${at}: action must be an object` };
      if (!DEMO_ACTION_KINDS.includes(action.kind)) return { ok: false, error: `${at}: action.kind must be click, fill, or press` };
      if ((action.kind === "click" || action.kind === "fill") && !boundedString(action.selector, 500)) return { ok: false, error: `${at}: ${action.kind} needs action.selector (max 500 chars)` };
      if ((action.kind === "fill" || action.kind === "press") && !boundedString(action.value, 2000)) return { ok: false, error: `${at}: ${action.kind} needs action.value` };
    }
    if (!step.spotlight && !step.caption && !step.narration && !step.action) return { ok: false, error: `${at} does nothing (needs spotlight, caption, narration, or action)` };
  }
  return { ok: true };
}
