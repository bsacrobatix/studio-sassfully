// Narrated-demo script contract (sassfully/demo-script/v1). Bounded on both
// step count and string sizes so a malformed or hostile script cannot balloon
// the page. Extracted verbatim from the extension's story-bridge-policy.mjs
// (which keeps its own copy so the extension and stdio server validate
// identically); a later integration points the extension at this module.
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

// Optional narration voice (script-level default, per-step override): an
// edge-tts voice name passed through to the narration server. Bounded like
// every other script string; players without a TTS engine simply ignore it.
const DEMO_VOICE_MAX = 100;

// Optional per-step cartoon stage overlay, played by embedded hosts via
// @sassfully/demo-stage (the extension path validates the field but skips
// playback). The scene's internals are linted by demo-stage's validateScene
// at play time; the contract here is shape plus hard bounds so a hostile
// script cannot balloon the page.
const DEMO_STAGE_KEYS = ["scene", "chars", "roster", "anchor", "persistent", "presenter"];
const DEMO_STAGE_MAX_JSON_CHARS = 65536;
const DEMO_STAGE_PLACEMENT_MODES = ["full", "dock", "anchor"];
const plainObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);

// A static presenter is deliberately a project-served image, never a remote
// URL or data URI supplied by an MCP caller. This keeps a demo script from
// becoming a cross-origin fetch surface while allowing hosts to ship named
// cutouts alongside demo-stage. `id` is telemetry/display metadata only.
const DEMO_PRESENTER_SRC = /^\/packages\/demo-stage\/assets\/[a-z0-9][a-z0-9._/-]*\.(?:png|webp)$/i;
export function validDemoStagePresenter(presenter) {
  if (!plainObject(presenter)) return false;
  const keys = Object.keys(presenter);
  if (!keys.length || keys.some((key) => !["id", "src", "alt"].includes(key))) return false;
  return boundedString(presenter.src, 300)
    && DEMO_PRESENTER_SRC.test(presenter.src)
    && (presenter.id == null || boundedString(presenter.id, 80))
    && (presenter.alt == null || boundedString(presenter.alt, 160));
}

// stage.anchor is either the string "target" (stand beside the step's
// resolved spotlight element) or an explicit demo-stage placement object.
export function validDemoStageAnchor(anchor) {
  if (anchor === "target") return true;
  if (!plainObject(anchor)) return false;
  if (!DEMO_STAGE_PLACEMENT_MODES.includes(anchor.mode)) return false;
  if (anchor.edge != null && !boundedString(anchor.edge, 20)) return false;
  if (anchor.size != null && !(Number.isFinite(anchor.size) && anchor.size > 0 && anchor.size <= 1)) return false;
  if (anchor.mode === "anchor") {
    const box = anchor.anchor;
    if (!plainObject(box) || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return false;
  }
  return true;
}

// Returns an error string, or null when the stage field is acceptable.
export function demoStageError(stage) {
  if (!plainObject(stage)) return "stage must be an object";
  for (const key of Object.keys(stage)) {
    if (!DEMO_STAGE_KEYS.includes(key)) return `stage has unknown key "${key}"`;
  }
  if (stage.scene != null && !plainObject(stage.scene)) return "stage.scene must be a scene object";
  if (!stage.scene && !stage.presenter) return "stage needs stage.scene or stage.presenter";
  if (stage.chars != null && !plainObject(stage.chars)) return "stage.chars must be an object";
  if (stage.roster != null && !Array.isArray(stage.roster)) return "stage.roster must be an array";
  if (stage.anchor != null && !validDemoStageAnchor(stage.anchor)) return 'stage.anchor must be "target" or a placement object (mode full/dock/anchor)';
  if (stage.persistent != null && typeof stage.persistent !== "boolean") return "stage.persistent must be a boolean";
  if (stage.presenter != null && !validDemoStagePresenter(stage.presenter)) return "stage.presenter must be a local /packages/demo-stage/assets PNG or WebP object";
  try {
    if (JSON.stringify(stage).length > DEMO_STAGE_MAX_JSON_CHARS) return `stage payload is capped at ${DEMO_STAGE_MAX_JSON_CHARS} JSON chars`;
  } catch {
    return "stage must be plain JSON data";
  }
  return null;
}

export function validateDemoScript(script) {
  if (!script || typeof script !== "object") return { ok: false, error: "demo script must be an object" };
  if (script.version != null && script.version !== DEMO_SCRIPT_VERSION) return { ok: false, error: `demo script version must be ${DEMO_SCRIPT_VERSION}` };
  if (script.voice != null && !boundedString(script.voice, DEMO_VOICE_MAX)) return { ok: false, error: "demo script voice must be a short string" };
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
    if (step.voice != null && !boundedString(step.voice, DEMO_VOICE_MAX)) return { ok: false, error: `${at}: voice must be a short string` };
    if (step.dim != null && typeof step.dim !== "boolean") return { ok: false, error: `${at}: dim must be a boolean` };
    if (step.stage != null) {
      const stageError = demoStageError(step.stage);
      if (stageError) return { ok: false, error: `${at}: ${stageError}` };
    }
    if (step.dwellMs != null && !(Number.isFinite(step.dwellMs) && step.dwellMs >= 0 && step.dwellMs <= 60000)) return { ok: false, error: `${at}: dwellMs must be 0-60000` };
    if (step.action != null) {
      const action = step.action;
      if (!action || typeof action !== "object") return { ok: false, error: `${at}: action must be an object` };
      if (!DEMO_ACTION_KINDS.includes(action.kind)) return { ok: false, error: `${at}: action.kind must be click, fill, or press` };
      if ((action.kind === "click" || action.kind === "fill") && !validDemoTarget(action.selector)) return { ok: false, error: `${at}: ${action.kind} needs action.selector (${DEMO_TARGET_HINT})` };
      if ((action.kind === "fill" || action.kind === "press") && !boundedString(action.value, 2000)) return { ok: false, error: `${at}: ${action.kind} needs action.value` };
    }
    if (!step.spotlight && !step.caption && !step.narration && !step.action && !step.stage) return { ok: false, error: `${at} does nothing (needs spotlight, caption, narration, action, or stage)` };
  }
  return { ok: true };
}
