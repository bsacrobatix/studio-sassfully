import test from "node:test";
import assert from "node:assert/strict";
import { executeDemoAction, waitForVisibleElement } from "../src/actions.mjs";

class FakeEvent {
  constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); }
}

function makeElement() {
  return {
    events: [],
    value: null,
    focused: false,
    clicked: false,
    getClientRects: () => [{}],
    click() { this.clicked = true; },
    focus() { this.focused = true; },
    dispatchEvent(event) { this.events.push(event); },
  };
}

function makeDocument(elements = {}) {
  return {
    defaultView: { Event: FakeEvent, KeyboardEvent: FakeEvent },
    activeElement: null,
    body: makeElement(),
    querySelector: (selector) => elements[selector] ?? null,
  };
}

test("click clicks the real element and fails loudly when it is missing", async () => {
  const el = makeElement();
  const document = makeDocument({ "#go": el });
  assert.deepEqual(await executeDemoAction({ document, action: { kind: "click", selector: "#go" } }), { clicked: true });
  assert.equal(el.clicked, true);
  await assert.rejects(() => executeDemoAction({ document, action: { kind: "click", selector: "#gone" } }), /not found/);
});

test("fill focuses, sets the value, and dispatches bubbling input+change (same pattern as the extension)", async () => {
  const el = makeElement();
  const document = makeDocument({ "#name": el });
  assert.deepEqual(await executeDemoAction({ document, action: { kind: "fill", selector: "#name", value: "Ada" } }), { filled: true });
  assert.equal(el.focused, true);
  assert.equal(el.value, "Ada");
  assert.deepEqual(el.events.map((e) => [e.type, e.bubbles]), [["input", true], ["change", true]]);
});

test("press dispatches keydown+keyup on the active element, falling back to body", async () => {
  const document = makeDocument();
  const active = makeElement();
  document.activeElement = active;
  assert.deepEqual(await executeDemoAction({ document, action: { kind: "press", value: "Enter" } }), { pressed: "Enter" });
  assert.deepEqual(active.events.map((e) => [e.type, e.key, e.bubbles, e.cancelable]), [
    ["keydown", "Enter", true, true], ["keyup", "Enter", true, true],
  ]);
  document.activeElement = null;
  await executeDemoAction({ document, action: { kind: "press", value: "Escape" } });
  assert.deepEqual(document.body.events.map((e) => e.type), ["keydown", "keyup"]);
});

test("waitForVisibleElement polls until a visible match appears, and gives up as null", async () => {
  const el = makeElement();
  let present = false;
  const document = { querySelector: () => (present ? el : null) };
  const delay = async () => { present = true; };
  assert.equal(await waitForVisibleElement({ document, selectors: ["#late"], delay }), el);
  assert.equal(await waitForVisibleElement({ document: { querySelector: () => null }, selectors: ["#never"], attempts: 3, delay: async () => {} }), null);
});
