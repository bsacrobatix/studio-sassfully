// The local Story bridge deliberately exposes a much smaller surface than a
// general browser automation protocol.  Keep this module browser-free so the
// extension and the stdio server use the same validation contract.
export const LINKEDIN_ORIGIN = "https://www.linkedin.com";
export const SEARCH_RESULTS_PATH = "/jobs/search-results";
export const DEFAULT_GEO_ID = "103644278";
export const AUTONOMOUS_JOBS_SESSION = "autonomous_paired_tab_v1";

export function isLinkedInOriginUrl(value) {
  try { return new URL(value).origin === LINKEDIN_ORIGIN; } catch { return false; }
}

// Narrated-demo POC: the loopback example host page (examples/host-page,
// served on 127.0.0.1) is a pairable demo target alongside LinkedIn. This is
// not a host-permission change — http://127.0.0.1/* is already granted.
export function isLoopbackDemoOrigin(origin) {
  return /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin ?? "");
}

export function isStoryPairableUrl(value) {
  try { const origin = new URL(value).origin; return origin === LINKEDIN_ORIGIN || isLoopbackDemoOrigin(origin); } catch { return false; }
}

// This is the post-navigation state contract. LinkedIn owns canonical query
// rewriting; only the exact same-origin Jobs results route matters here.
export function isLinkedInUsResultsUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== LINKEDIN_ORIGIN) return false;
    const path = url.pathname.replace(/\/$/, "");
    if (path !== SEARCH_RESULTS_PATH) return false;
    return true;
  } catch { return false; }
}

export function isLinkedInSearchUrl(value) {
  return isLinkedInUsResultsUrl(value);
}

export function buildJobsSearchUrl({ keywords, geoId = DEFAULT_GEO_ID }) {
  const url = new URL(`${LINKEDIN_ORIGIN}${SEARCH_RESULTS_PATH}/`);
  url.searchParams.set("keywords", keywords);
  url.searchParams.set("geoId", geoId);
  url.searchParams.set("f_WT", "2");
  return url.href;
}

// Narrated-demo script contract (sassfully/demo-script/v1). Bounded on both
// step count and string sizes so a malformed or hostile script cannot balloon
// the paired tab. Kept here so extension and stdio server validate identically.
export const DEMO_SCRIPT_VERSION = "sassfully/demo-script/v1";
export const DEMO_SCRIPT_MAX_STEPS = 50;
const DEMO_ACTION_KINDS = ["click", "fill", "press"];
const boundedString = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

// A demo step target is either a raw CSS selector string (POC shape, still
// valid) or a structured anchor object resolved by ranked strategy
// (role -> testid -> text -> css; `name` refines `role`). Every field is
// bounded; unknown keys are rejected; `name` alone cannot locate anything.
const DEMO_ANCHOR_FIELD_MAX = { role: 100, name: 300, testid: 300, text: 500, css: 500 };
export function validDemoTarget(value) {
  if (typeof value === "string") return boundedString(value, 500);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  for (const key of keys) {
    const max = DEMO_ANCHOR_FIELD_MAX[key];
    if (!max || !boundedString(value[key], max)) return false;
  }
  return keys.some((key) => key !== "name");
}
const DEMO_TARGET_HINT = "a CSS selector string (max 500 chars) or an anchor object with bounded role/name/testid/text/css fields";

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
    if (step.spotlight != null && !validDemoTarget(step.spotlight)) return { ok: false, error: `${at}: spotlight must be ${DEMO_TARGET_HINT}` };
    if (step.caption != null && !boundedString(step.caption, 500)) return { ok: false, error: `${at}: caption must be a string (max 500 chars)` };
    if (step.narration != null && !boundedString(step.narration, 2000)) return { ok: false, error: `${at}: narration must be a string (max 2000 chars)` };
    if (step.dwellMs != null && !(Number.isFinite(step.dwellMs) && step.dwellMs >= 0 && step.dwellMs <= 60000)) return { ok: false, error: `${at}: dwellMs must be 0-60000` };
    if (step.action != null) {
      const action = step.action;
      if (!action || typeof action !== "object") return { ok: false, error: `${at}: action must be an object` };
      if (!DEMO_ACTION_KINDS.includes(action.kind)) return { ok: false, error: `${at}: action.kind must be click, fill, or press` };
      if ((action.kind === "click" || action.kind === "fill") && !validDemoTarget(action.selector)) return { ok: false, error: `${at}: ${action.kind} needs action.selector (${DEMO_TARGET_HINT})` };
      if ((action.kind === "fill" || action.kind === "press") && !boundedString(action.value, 2000)) return { ok: false, error: `${at}: ${action.kind} needs action.value` };
    }
    if (!step.spotlight && !step.caption && !step.narration && !step.action) return { ok: false, error: `${at} does nothing (needs spotlight, caption, narration, or action)` };
  }
  return { ok: true };
}

export function validateStoryCommand(command) {
  if (!command || typeof command !== "object") return { ok: false, error: "command must be an object" };
  if (!["navigate", "snapshot", "click", "fill", "press", "extract", "run_script", "demo_run", "demo_stop"].includes(command.action)) return { ok: false, error: "action is not supported" };
  if (command.action === "demo_run") return validateDemoScript(command.script);
  if (command.action === "demo_stop") return { ok: true };
  // MCP callers commonly attach trace/capture options. Commands are decoded
  // permissively: unknown optional fields are ignored, while each action's
  // essential input remains required and type-checked below.
  if (command.action === "run_script") return Array.isArray(command.steps) && command.steps.length ? { ok: true } : { ok: false, error: "run_script needs a non-empty steps array" };
  if (command.action === "navigate" && typeof command.url !== "string") return { ok: false, error: "navigate url must be a string" };
  if (command.action === "click" && typeof (command.selector ?? command.target) !== "string") return { ok: false, error: "click needs selector or target" };
  if (command.action === "fill" && (typeof command.selector !== "string" || typeof command.text !== "string")) return { ok: false, error: "fill needs selector and text" };
  if (command.action === "press" && typeof command.key !== "string") return { ok: false, error: "press key must be a string" };
  if (command.action === "extract" && command.selector != null && typeof command.selector !== "string") return { ok: false, error: "extract selector must be a string" };
  if (command.action === "extract" && command.captureEvidence != null && typeof command.captureEvidence !== "boolean") return { ok: false, error: "extract captureEvidence must be boolean" };
  return { ok: true };
}
