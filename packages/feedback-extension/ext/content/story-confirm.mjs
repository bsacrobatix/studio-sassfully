import { validateStoryCommand } from "../story-bridge-policy.mjs";

export const FIELD_SELECTORS = {
  keywords: 'input[aria-label*="Search by title"], input[placeholder*="Search by title"], input[aria-label*="skill, or company"]',
  // LinkedIn's current Jobs header uses "City, state, or zip code" rather
  // than its older "Search by location" label. Both remain field-specific.
  location: 'input[aria-label*="Search by location"], input[placeholder*="Search by location"], input[aria-label*="City, state, or zip code"], input[placeholder*="City, state, or zip code"]',
};

export function findSearchField(document, field) {
  return document.querySelector(FIELD_SELECTORS[field]);
}

const REMOTE_FILTER_BUTTONS = [
  'button[aria-label="Remote"]',
  'button[aria-label^="Remote"]',
];
const REMOTE_OPTIONS = [
  '[role="menu"] [role="checkbox"][aria-label="Remote"]',
  '[role="listbox"] [role="option"][aria-label="Remote"]',
  'input[type="checkbox"][aria-label="Remote"]',
];
const visible = (element) => Boolean(element && (element.getClientRects?.().length ?? true));

export function remoteReadiness(document) {
  return {
    remoteFilterReady: REMOTE_FILTER_BUTTONS.map((selector) => document.querySelector(selector)).some(visible),
    remoteChoiceReady: REMOTE_OPTIONS.map((selector) => document.querySelector(selector)).some(visible),
  };
}

export async function waitForVisibleSemanticElement({ document, selectors, attempts = 100, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (let index = 0; index < attempts; index += 1) {
    const element = selectors.map((selector) => document.querySelector(selector)).find(visible);
    if (element) return element;
    await delay(100);
  }
  return null;
}

export async function selectVisibleRemoteFilter(document, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  // The Jobs header can hydrate after the URL has changed. This bounded wait
  // looks only for the exact semantic Remote anchors, never generic text.
  const button = await waitForVisibleSemanticElement({ document, selectors: REMOTE_FILTER_BUTTONS, delay });
  if (!button) throw new Error("The visible LinkedIn Remote filter did not appear within 10 seconds");
  button.click();
  const option = await waitForVisibleSemanticElement({ document, selectors: REMOTE_OPTIONS, attempts: 50, delay });
  if (!option) throw new Error("The visible LinkedIn Remote choice did not appear within 5 seconds");
  if (option.getAttribute?.("aria-checked") === "true" || option.checked === true) return { remoteSelected: true, alreadySelected: true };
  option.click();
  return { remoteSelected: true, alreadySelected: false };
}

const text = (element) => element?.textContent?.replace(/\s+/g, " ").trim() || null;

export function extractVisibleText(document, selector = "body") {
  return [...document.querySelectorAll(selector)].filter(visible).map((element) => text(element)).filter(Boolean);
}

// Pairing opts into this explicit autonomous, Jobs-only session. There is no
// modal and no generic command path: the background still validates action,
// route, session mode, request ID, and audit outcome.
export async function runAutonomousStoryCommand({ document, location, command, requestId = "unknown" }) {
  const check = validateStoryCommand(command);
  if (!check.ok) throw new Error(check.error);
  if (command.action === "snapshot") return { requestId, url: location.href, title: document.title, visibleText: extractVisibleText(document).join(" ") };
  if (command.action === "navigate") { location.assign(command.url); return { requestId, navigating: true }; }
  if (command.action === "click") {
    const element = document.querySelector(command.selector ?? `[aria-label="${CSS.escape(command.target)}"]`);
    if (!element) throw new Error("target was not found in the paired tab");
    element.click(); return { requestId, clicked: true };
  }
  if (command.action === "fill") {
    const element = document.querySelector(command.selector);
    if (!element) throw new Error("target was not found in the paired tab");
    element.focus(); element.value = command.text;
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
    return { requestId, filled: true };
  }
  if (command.action === "press") {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: command.key, code: command.key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: command.key, code: command.key, bubbles: true, cancelable: true }));
    return { requestId, pressed: command.key };
  }
  const textValues = extractVisibleText(document, command.selector ?? "body");
  return { requestId, text: textValues, ...(command.captureEvidence ? { evidence: { capturedAt: new Date().toISOString(), source: "paired-tab-visible-dom" } } : {}) };
}
