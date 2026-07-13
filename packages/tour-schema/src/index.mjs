// The executable format is intentionally small.  TourSpec/story semantics
// belong upstream; this module only freezes the portable v2 browser wire form.
const ROOT = new Set(["version", "id", "origin", "steps"]);
const STEP = new Set(["id", "kind", "target", "title", "body", "advanceOn", "interaction", "viewport", "consent", "action", "route", "data"]);
const TARGET = new Set(["role", "name", "testid", "text", "css", "ancestor", "frame", "waitFor"]);
const KINDS = new Set(["highlight", "gate", "act", "navigate"]);
const CONSENT = new Set(["confirm", "watch", "auto"]);

function object(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`tour v2: ${where} must be an object`);
  return value;
}
function known(value, keys, where) {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`tour v2: ${where}.${key} is not a permitted wire field`);
}
function string(value, where) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`tour v2: ${where} must be a non-empty string`); return value; }
function target(value, where) {
  const result = object(value, where); known(result, TARGET, where);
  if (!Object.keys(result).some((key) => key !== "waitFor" && result[key] != null)) throw new TypeError(`tour v2: ${where} needs an anchor field`);
  for (const key of ["role", "name", "testid", "text", "css", "ancestor", "frame", "waitFor"]) if (result[key] !== undefined && typeof result[key] !== "string") throw new TypeError(`tour v2: ${where}.${key} must be a string`);
  return Object.freeze({ ...result });
}

/** Validate, default, and freeze the established executable tour document. */
export function validateTourManifestV2(input) {
  const root = object(input, "manifest"); known(root, ROOT, "manifest");
  if (root.version !== 2) throw new TypeError("tour v2: version must be 2");
  string(root.id, "manifest.id");
  if (root.origin !== undefined && typeof root.origin !== "string") throw new TypeError("tour v2: manifest.origin must be a string");
  if (!Array.isArray(root.steps) || !root.steps.length) throw new TypeError("tour v2: manifest.steps must be a non-empty array");
  const ids = new Set();
  const steps = root.steps.map((raw, index) => {
    const step = object(raw, `steps[${index}]`); known(step, STEP, `steps[${index}]`);
    string(step.id, `steps[${index}].id`); if (ids.has(step.id)) throw new TypeError(`tour v2: duplicate step id ${step.id}`); ids.add(step.id);
    if (!KINDS.has(step.kind)) throw new TypeError(`tour v2: steps[${index}].kind is invalid`);
    if (step.kind === "navigate") string(step.route, `steps[${index}].route`);
    else if (!step.target) throw new TypeError(`tour v2: steps[${index}].target is required`);
    const normalized = { ...step, ...(step.target ? { target: Array.isArray(step.target) ? step.target.map((x, i) => target(x, `steps[${index}].target[${i}]`)) : [target(step.target, `steps[${index}].target`)] } : {}) };
    if (step.kind === "act") {
      string(step.action, `steps[${index}].action`);
      const consent = step.consent ?? "confirm";
      if (!CONSENT.has(consent)) throw new TypeError(`tour v2: steps[${index}].consent is invalid`);
      normalized.consent = consent;
    } else if (step.consent !== undefined) throw new TypeError(`tour v2: steps[${index}].consent is only valid for act`);
    if (step.advanceOn !== undefined && (!Array.isArray(step.advanceOn) || step.advanceOn.some((x) => typeof x !== "string"))) throw new TypeError(`tour v2: steps[${index}].advanceOn must be a string array`);
    normalized.advanceOn = step.advanceOn ?? [];
    return Object.freeze(normalized);
  });
  return Object.freeze({ version: 2, id: root.id, ...(root.origin ? { origin: root.origin } : {}), steps: Object.freeze(steps) });
}

/** Lossless-enough upgrade for legacy {id, steps:[{target,...}]} tour documents. */
export function convertTourManifestV1(v1) {
  const source = object(v1, "v1 manifest");
  return validateTourManifestV2({ version: 2, id: source.id, origin: source.origin, steps: (source.steps || []).map((step, index) => ({ id: step.id ?? `step-${index + 1}`, kind: step.kind ?? "highlight", ...step })) });
}
export const TourManifestV2 = validateTourManifestV2;
export const TourDocumentV2 = validateTourManifestV2;
