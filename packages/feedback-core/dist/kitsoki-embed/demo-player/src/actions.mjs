// Real DOM interactions for demo steps, environment-neutral. The event
// patterns mirror the extension's paired-tab executor
// (packages/feedback-extension/ext/content/story-confirm.mjs) — click via
// element.click(), fill via focus + value + bubbling input/change events,
// press via keydown/keyup on the active element — reimplemented here without
// any chrome.* or bare browser globals: Event/KeyboardEvent constructors come
// from the document's own window so this runs under node with a fake document.

const visible = (element) => Boolean(element && (element.getClientRects?.().length ?? true));

// Bounded wait for a visible element (same shape as the extension's
// waitForVisibleSemanticElement): up to `attempts` polls, 100ms apart.
export async function waitForVisibleElement({ document, selectors, attempts = 100, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (let index = 0; index < attempts; index += 1) {
    const element = selectors.map((selector) => document.querySelector(selector)).find(visible);
    if (element) return element;
    await delay(100);
  }
  return null;
}

// Execute one demo action ({kind, selector?, value?}, already validated by
// validateDemoScript) against the document. Throws when the target is absent.
// Structured-anchor actions (selector is an anchor object) act directly on
// the pre-resolved `element` — there is no CSS selector to re-query — exactly
// like the extension's paired-tab executor; string selectors keep the
// original querySelector path.
export async function executeDemoAction({ document, action, element = null }) {
  const win = document.defaultView ?? globalThis;
  const resolveTarget = (verb) => {
    if (action.selector != null && typeof action.selector === "object") {
      if (!element) throw new Error(`${verb} target was not found on the page`);
      return element;
    }
    const found = document.querySelector(action.selector);
    if (!found) throw new Error(`${verb} target was not found on the page`);
    return found;
  };
  if (action.kind === "click") {
    resolveTarget("click").click();
    return { clicked: true };
  }
  if (action.kind === "fill") {
    const target = resolveTarget("fill");
    target.focus?.();
    target.value = action.value;
    target.dispatchEvent(new win.Event("input", { bubbles: true }));
    target.dispatchEvent(new win.Event("change", { bubbles: true }));
    return { filled: true };
  }
  if (action.kind === "press") {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key: action.value, code: action.value, bubbles: true, cancelable: true }));
    target.dispatchEvent(new win.KeyboardEvent("keyup", { key: action.value, code: action.value, bubbles: true, cancelable: true }));
    return { pressed: action.value };
  }
  throw new Error(`unsupported demo action kind: ${action.kind}`);
}
