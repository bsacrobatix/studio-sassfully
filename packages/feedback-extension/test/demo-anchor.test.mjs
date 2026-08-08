import test from "node:test";
import assert from "node:assert/strict";
import { anchorLabel, findByStrategy, resolveAnchorOnce, waitForAnchor } from "../ext/content/anchor-resolve.mjs";

// Minimal fake DOM: elements expose only what anchor-resolve uses
// (getAttribute, textContent, contains, getClientRects); the document maps
// selector strings to element lists, with "*" returning every element.
function makeElement({ attrs = {}, text = "", children = [], hidden = false } = {}) {
  return {
    attrs,
    children,
    getAttribute(key) { return this.attrs[key] ?? null; },
    get textContent() { return [text, ...children.map((child) => child.textContent)].join(" "); },
    contains(other) { return this.children.some((child) => child === other || child.contains(other)); },
    getClientRects() { return hidden ? [] : [{}]; },
  };
}
const makeDoc = (map, all = []) => ({ querySelectorAll: (selector) => (selector === "*" ? all : (map[selector] ?? [])) });

test("a plain string target resolves as a CSS-only anchor with no healing", () => {
  const button = makeElement();
  const doc = makeDoc({ "#go": [button] });
  assert.deepEqual(resolveAnchorOnce(doc, "#go"), { element: button, strategy: "css", rank: 0, healed: null });
});

test("role anchors match explicit [role] and implicit tags, refined by accessible name", () => {
  const generate = makeElement({ text: "Generate greeting" });
  const reset = makeElement({ attrs: { "aria-label": "Reset form" } });
  const doc = makeDoc({ button: [generate, reset] });
  const resolved = resolveAnchorOnce(doc, { role: "button", name: "Generate greeting" });
  assert.equal(resolved.element, generate);
  assert.deepEqual([resolved.strategy, resolved.rank, resolved.healed], ["role", 0, null]);
  const byLabel = resolveAnchorOnce(doc, { role: "button", name: "reset form" });
  assert.equal(byLabel.element, reset, "aria-label wins and matching is case-insensitive");
  const explicit = makeElement({ text: "Go" });
  assert.equal(resolveAnchorOnce(makeDoc({ '[role="button"]': [explicit] }), { role: "button", name: "Go" }).element, explicit);
});

test("a lower-ranked match reports healing so the caller learns the anchor drifted", () => {
  const target = makeElement();
  const doc = makeDoc({ "#fallback": [target] }); // no [data-testid="gone"] entry
  const resolved = resolveAnchorOnce(doc, { testid: "gone", css: "#fallback" });
  assert.equal(resolved.element, target);
  assert.equal(resolved.strategy, "css");
  assert.deepEqual(resolved.healed, { requested: "testid", matched: "css" });
});

test("ambiguity at a higher rank hard-fails instead of falling through", () => {
  const one = makeElement({ attrs: { "data-testid": "unique" } });
  const two = makeElement();
  const doc = makeDoc({ button: [one, two], '[data-testid="unique"]': [one] });
  assert.throws(
    () => resolveAnchorOnce(doc, { role: "button", testid: "unique" }),
    (error) => error.code === "ambiguous-anchor" && /ambiguous anchor \(2 matches via role\)/.test(error.message),
  );
});

test("text anchors keep only the deepest matching element", () => {
  const child = makeElement({ text: "Hello world" });
  const parent = makeElement({ children: [child] });
  const doc = makeDoc({}, [parent, child]);
  const matches = findByStrategy(doc, { text: " hello  WORLD " }, "text");
  assert.deepEqual(matches, [child]);
});

test("hidden elements (no client rects) are never anchor matches", () => {
  const hidden = makeElement({ hidden: true });
  const shown = makeElement();
  const doc = makeDoc({ ".row": [hidden, shown] });
  assert.equal(resolveAnchorOnce(doc, { css: ".row" }).element, shown);
});

test("an unmatched anchor resolves to null and an empty anchor throws", () => {
  const doc = makeDoc({});
  assert.equal(resolveAnchorOnce(doc, { css: ".missing" }), null);
  assert.throws(() => resolveAnchorOnce(doc, { name: "only a name" }), /no resolvable strategy/);
  assert.throws(() => resolveAnchorOnce(doc, {}), /no resolvable strategy/);
});

test("waitForAnchor retries not-found, returns null after attempts, and rethrows ambiguity immediately", async () => {
  let polls = 0;
  const target = makeElement();
  const lateDoc = { querySelectorAll: (selector) => { if (selector === "#late") { polls += 1; return polls >= 3 ? [target] : []; } return []; } };
  const resolved = await waitForAnchor(lateDoc, "#late", { attempts: 5, delay: async () => {} });
  assert.equal(resolved.element, target);
  assert.equal(polls, 3);
  assert.equal(await waitForAnchor(makeDoc({}), "#never", { attempts: 2, delay: async () => {} }), null);
  const dupes = makeDoc({ "#dup": [makeElement(), makeElement()] });
  let delays = 0;
  await assert.rejects(
    () => waitForAnchor(dupes, "#dup", { attempts: 5, delay: async () => { delays += 1; } }),
    /ambiguous anchor/,
  );
  assert.equal(delays, 0, "ambiguity does not retry");
});

test("anchorLabel names anchors readably for error messages", () => {
  assert.equal(anchorLabel("#go"), "#go");
  assert.equal(anchorLabel({ role: "button", name: "Generate greeting" }), 'role="button" name="Generate greeting"');
  assert.equal(anchorLabel({}), "(empty anchor)");
});
