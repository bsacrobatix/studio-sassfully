// Runtime mirror of schemas/tour-v2.schema.json.  Keep this deliberately
// dependency-free so validation remains usable in a browser and in CI.
const kinds = new Set(["highlight", "gate", "act", "navigate"]);
const policies = new Set(["watch", "confirm", "auto"]);
const interactions = new Set(["block", "allow"]);
const events = new Set(["click", "input", "route", "submit"]);
const acts = new Set(["click", "fill", "scroll", "press"]);
const sides = new Set(["top", "bottom", "left", "right", "center"]);
const aligns = new Set(["start", "center", "end"]);
const rootKeys = new Set(["version", "id", "origin", "steps"]);
const stepKeys = new Set(["id", "route", "target", "popover", "kind", "advanceOn", "act", "policy", "interaction", "viewport", "data"]);
const targetKeys = new Set(["role", "name", "testid", "text", "css", "ancestor", "frame", "waitFor"]);
const object = (value, where) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`tour v2: ${where} must be an object`); return value; };
const string = (value, where) => { if (typeof value !== "string" || !value) throw new TypeError(`tour v2: ${where} must be a non-empty string`); return value; };
const only = (value, keys, where) => { for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`tour v2: ${where}.${key} is not a permitted wire field`); };
const oneOf = (value, set, where) => { if (!set.has(value)) throw new TypeError(`tour v2: ${where} is invalid`); };
function target(input, where) {
  const value = object(input, where); only(value, targetKeys, where);
  for (const key of ["role", "name", "testid", "text", "css", "ancestor"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new TypeError(`tour v2: ${where}.${key} must be a string`);
  if (value.frame !== undefined && (!Array.isArray(value.frame) || value.frame.some((x) => typeof x !== "string"))) throw new TypeError(`tour v2: ${where}.frame must be a string array`);
  if (value.waitFor !== undefined) { const wait = object(value.waitFor, `${where}.waitFor`); only(wait, new Set(["timeoutMs"]), `${where}.waitFor`); if (wait.timeoutMs !== undefined && (!Number.isInteger(wait.timeoutMs) || wait.timeoutMs < 0)) throw new TypeError(`tour v2: ${where}.waitFor.timeoutMs must be a non-negative integer`); }
  return structuredClone(value);
}
export function validateTourManifestV2(input) {
  const root = object(input, "manifest"); only(root, rootKeys, "manifest");
  if (root.version !== 2) throw new TypeError("tour v2: version must be 2");
  string(root.id, "manifest.id"); if (root.origin !== undefined && typeof root.origin !== "string") throw new TypeError("tour v2: manifest.origin must be a string");
  if (!Array.isArray(root.steps) || root.steps.length === 0) throw new TypeError("tour v2: manifest.steps must be a non-empty array");
  const ids = new Set();
  const steps = root.steps.map((raw, index) => {
    const step = object(raw, `steps[${index}]`); only(step, stepKeys, `steps[${index}]`); string(step.id, `steps[${index}].id`); if (ids.has(step.id)) throw new TypeError(`tour v2: duplicate step id ${step.id}`); ids.add(step.id);
    oneOf(step.kind, kinds, `steps[${index}].kind`); if (step.route !== undefined && typeof step.route !== "string") throw new TypeError(`tour v2: steps[${index}].route must be a string`);
    const normalized = { ...structuredClone(step) }; if (step.target !== undefined) normalized.target = target(step.target, `steps[${index}].target`);
    if (step.popover !== undefined) { const popover = object(step.popover, `steps[${index}].popover`); only(popover, new Set(["title", "body", "side", "align"]), `steps[${index}].popover`); for (const key of ["title", "body"]) if (popover[key] !== undefined && typeof popover[key] !== "string") throw new TypeError(`tour v2: steps[${index}].popover.${key} must be a string`); if (popover.side !== undefined) oneOf(popover.side, sides, `steps[${index}].popover.side`); if (popover.align !== undefined) oneOf(popover.align, aligns, `steps[${index}].popover.align`); }
    if (step.advanceOn !== undefined) { const advance = object(step.advanceOn, `steps[${index}].advanceOn`); only(advance, new Set(["event"]), `steps[${index}].advanceOn`); oneOf(advance.event, events, `steps[${index}].advanceOn.event`); }
    if (step.act !== undefined) { const act = object(step.act, `steps[${index}].act`); only(act, new Set(["kind", "value"]), `steps[${index}].act`); oneOf(act.kind, acts, `steps[${index}].act.kind`); if (act.value !== undefined && typeof act.value !== "string") throw new TypeError(`tour v2: steps[${index}].act.value must be a string`); }
    if (step.policy !== undefined) oneOf(step.policy, policies, `steps[${index}].policy`); if (step.interaction !== undefined) oneOf(step.interaction, interactions, `steps[${index}].interaction`); if (step.viewport !== undefined && typeof step.viewport !== "string") throw new TypeError(`tour v2: steps[${index}].viewport must be a string`);
    if (step.kind === "gate" && !step.advanceOn?.event) throw new TypeError(`tour v2: steps[${index}].gate requires advanceOn.event`);
    if (step.kind === "act" && !step.act?.kind && !step.data?.drive) throw new TypeError(`tour v2: steps[${index}].act requires act.kind or data.drive`);
    if (step.kind === "navigate" && !step.route) throw new TypeError(`tour v2: steps[${index}].navigate requires route`);
    if (step.kind === "act" && !normalized.policy) normalized.policy = "confirm";
    return Object.freeze(normalized);
  });
  return Object.freeze({ version: 2, id: root.id, ...(root.origin !== undefined ? { origin: root.origin } : {}), steps: Object.freeze(steps) });
}
export function convertTourManifestV1(v1) {
  const source = object(v1, "v1 manifest");
  return validateTourManifestV2({ version: 2, id: source.export ?? source.id, origin: source.origin, steps: (source.steps || []).map((step, index) => ({ id: step.id ?? `step-${index + 1}`, route: step.advanceRoute ?? step.route, target: step.target || step.targetText ? { ...(step.target ? { testid: step.target } : {}), ...(step.targetText ? { text: step.targetText } : {}) } : undefined, popover: step.title || step.body || step.placement ? { ...(step.title ? { title: step.title } : {}), ...(step.body ? { body: step.body } : {}), ...(step.placement ? { side: step.placement } : {}) } : undefined, kind: step.drive?.length ? "act" : step.advance === "route-match" ? "navigate" : step.kind === "action" ? "gate" : "highlight", ...(step.drive?.length ? { data: { drive: structuredClone(step.drive) } } : {}), ...(step.kind === "action" ? { advanceOn: { event: "click" } } : {}) })) });
}
export const TourManifestV2 = validateTourManifestV2;
export const TourDocumentV2 = validateTourManifestV2;
