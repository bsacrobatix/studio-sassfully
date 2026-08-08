// Semantic step anchors for the narrated demo (sassfully/demo-script/v1).
//
// A step target may be a plain CSS selector string (the original POC shape,
// still fully supported) or a structured anchor object:
//
//   { "role": "button", "name": "Generate greeting",
//     "testid": "...", "text": "...", "css": "..." }
//
// Resolution follows the same ranking contract as the repo's tour player
// (packages/tour-player/src/index.mjs): strategies are tried in fixed rank
// order role -> testid -> text -> css, restricted to the strategies the
// anchor actually provides. More than one match at any rank is a hard
// ambiguity failure (no silent fall-through past an ambiguous anchor);
// exactly one match selects. When a lower-ranked strategy matched (rank > 0)
// the resolution is reported as "healed" so the caller learns the
// higher-ranked anchor drifted. tour-player delegates matching to an injected
// driver, so the DOM matching itself is implemented here against the same
// contract rather than imported.
//
// Import-safe under node: no window/document access at module top level; the
// document arrives as an argument and only querySelectorAll + element basics
// (getAttribute, textContent, contains, getClientRects) are used, so tests
// can drive this with a tiny fake document.
//
// Kept in lockstep with packages/feedback-extension/ext/content/anchor-resolve.mjs.

export const ANCHOR_STRATEGIES = ["role", "testid", "text", "css"];

// Common implicit ARIA roles, so `role: "button"` finds <button> as well as
// [role="button"]. Deliberately a small, high-value subset.
const IMPLICIT_ROLE_SELECTORS = {
  button: ["button", 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', "summary"],
  link: ["a[href]"],
  textbox: ["textarea", "input:not([type])", 'input[type="text"]', 'input[type="search"]', 'input[type="email"]', 'input[type="url"]', 'input[type="tel"]'],
  checkbox: ['input[type="checkbox"]'],
  radio: ['input[type="radio"]'],
  combobox: ["select"],
  heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
  img: ["img"],
  navigation: ["nav"],
  main: ["main"],
  banner: ["header"],
  contentinfo: ["footer"],
  list: ["ul", "ol"],
  listitem: ["li"],
};

const escapeAttr = (value) => String(value).replace(/(["\\])/g, "\\$1");
const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
const visible = (element) => Boolean(element && (element.getClientRects?.().length ?? true));

export function normalizeAnchor(target) {
  if (typeof target === "string") return { css: target };
  return target ?? {};
}

export function anchorLabel(target) {
  if (typeof target === "string") return target;
  return ANCHOR_STRATEGIES.concat("name")
    .filter((key) => target?.[key] != null)
    .map((key) => `${key}=${JSON.stringify(target[key])}`)
    .join(" ") || "(empty anchor)";
}

// Best-effort accessible name, in the spirit of (not a full implementation
// of) accname: aria-label, then alt/value/placeholder/title for empty-text
// elements, then normalized text content.
function accessibleName(element) {
  const label = element.getAttribute?.("aria-label");
  if (label) return normalize(label);
  const textName = normalize(element.textContent);
  if (textName) return textName;
  for (const attribute of ["alt", "value", "placeholder", "title"]) {
    const value = element.getAttribute?.(attribute);
    if (value) return normalize(value);
  }
  return "";
}

function queryAll(doc, selectors) {
  const seen = new Set();
  const out = [];
  for (const selector of selectors) {
    let matches = [];
    try { matches = [...doc.querySelectorAll(selector)]; } catch { /* invalid selector for this strategy: no matches */ }
    for (const element of matches) {
      if (!seen.has(element)) { seen.add(element); out.push(element); }
    }
  }
  return out;
}

export function findByStrategy(doc, anchor, strategy) {
  if (strategy === "role") {
    const role = anchor.role;
    const selectors = [`[role="${escapeAttr(role)}"]`, ...(IMPLICIT_ROLE_SELECTORS[role] ?? [])];
    let matches = queryAll(doc, selectors).filter(visible);
    if (anchor.name != null) {
      const wanted = normalize(anchor.name).toLowerCase();
      matches = matches.filter((element) => accessibleName(element).toLowerCase() === wanted);
    }
    return matches;
  }
  if (strategy === "testid") return queryAll(doc, [`[data-testid="${escapeAttr(anchor.testid)}"]`]).filter(visible);
  if (strategy === "text") {
    const wanted = normalize(anchor.text).toLowerCase();
    const matches = queryAll(doc, ["*"]).filter((element) => visible(element) && normalize(element.textContent).toLowerCase() === wanted);
    // Text bubbles up through ancestors; keep only the deepest matches.
    return matches.filter((element) => !matches.some((other) => other !== element && element.contains?.(other)));
  }
  if (strategy === "css") return queryAll(doc, [anchor.css]).filter(visible);
  return [];
}

// One resolution pass. Returns { element, strategy, rank, healed } for a
// unique match, null when nothing matched, and throws on ambiguity —
// mirroring tour-player: an ambiguous higher-ranked anchor is a hard failure,
// never silently skipped.
export function resolveAnchorOnce(doc, target) {
  const anchor = normalizeAnchor(target);
  const strategies = ANCHOR_STRATEGIES.filter((strategy) => anchor[strategy] !== undefined);
  if (!strategies.length) throw new Error(`anchor has no resolvable strategy: ${anchorLabel(target)}`);
  for (let rank = 0; rank < strategies.length; rank += 1) {
    const strategy = strategies[rank];
    const matches = findByStrategy(doc, anchor, strategy);
    if (matches.length > 1) {
      const error = new Error(`ambiguous anchor (${matches.length} matches via ${strategy}): ${anchorLabel(target)}`);
      error.code = "ambiguous-anchor";
      throw error;
    }
    if (matches.length === 1) {
      return {
        element: matches[0],
        strategy,
        rank,
        healed: rank > 0 ? { requested: strategies[0], matched: strategy } : null,
      };
    }
  }
  return null;
}

// Bounded retry wrapper (the demo page may still be hydrating). Ambiguity
// still fails immediately; only "not found yet" retries.
export async function waitForAnchor(doc, target, { attempts = 100, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const resolved = resolveAnchorOnce(doc, target);
    if (resolved) return resolved;
    await delay(100);
  }
  return null;
}
