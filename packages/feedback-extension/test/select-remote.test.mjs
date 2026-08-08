import test from "node:test";
import assert from "node:assert/strict";
import { extractVisibleText, remoteReadiness, selectVisibleRemoteFilter } from "../ext/content/story-confirm.mjs";

test("select_remote touches only the visible semantic Remote filter and option", async () => {
  const clicks = [];
  const button = { getClientRects: () => [1], click: () => clicks.push("filter") };
  const option = { getClientRects: () => [1], getAttribute: () => "false", click: () => clicks.push("remote") };
  const document = { querySelector: (selector) => selector === 'button[aria-label="Remote"]' ? button : selector.includes('[role="checkbox"][aria-label="Remote"]') ? option : null };
  const result = await selectVisibleRemoteFilter(document, async () => {});
  assert.deepEqual(result, { remoteSelected: true, alreadySelected: false });
  assert.deepEqual(clicks, ["filter", "remote"]);
});

test("select_remote reports an already-selected semantic Remote option without a second selection click", async () => {
  const clicks = [];
  const button = { getClientRects: () => [1], click: () => clicks.push("filter") };
  const option = { getClientRects: () => [1], getAttribute: () => "true", click: () => clicks.push("remote") };
  const document = { querySelector: (selector) => selector === 'button[aria-label="Remote"]' ? button : selector.includes('[role="checkbox"][aria-label="Remote"]') ? option : null };
  assert.deepEqual(await selectVisibleRemoteFilter(document, async () => {}), { remoteSelected: true, alreadySelected: true });
  assert.deepEqual(clicks, ["filter"]);
});

test("select_remote waits for the delayed visible Remote header control", async () => {
  const clicks = []; let buttonReads = 0;
  const button = { getClientRects: () => [1], click: () => clicks.push("filter") };
  const option = { getClientRects: () => [1], getAttribute: () => "false", click: () => clicks.push("remote") };
  const document = { querySelector: (selector) => {
    if (selector === 'button[aria-label="Remote"]') return ++buttonReads >= 3 ? button : null;
    return selector.includes('[role="checkbox"][aria-label="Remote"]') ? option : null;
  } };
  await selectVisibleRemoteFilter(document, async () => {});
  assert.equal(buttonReads, 3);
  assert.deepEqual(clicks, ["filter", "remote"]);
});

test("select_remote fails boundedly when the semantic Remote control never appears", async () => {
  await assert.rejects(() => selectVisibleRemoteFilter({ querySelector: () => null }, async () => {}), /did not appear within 10 seconds/);
});

test("doctor readiness reports only semantic Remote-control presence", () => {
  const button = { getClientRects: () => [1] };
  const document = { querySelector: (selector) => selector === 'button[aria-label="Remote"]' ? button : null };
  assert.deepEqual(remoteReadiness(document), { remoteFilterReady: true, remoteChoiceReady: false });
});

test("autonomous extraction has no confirmation UI dependency", () => {
  const visibleCard = { getClientRects: () => [1], textContent: "  visible card  " };
  const hiddenCard = { getClientRects: () => [], textContent: "hidden" };
  const document = { querySelectorAll: () => [visibleCard, hiddenCard] };
  assert.deepEqual(extractVisibleText(document, ".card"), ["visible card"]);
});
