import test from "node:test";
import assert from "node:assert/strict";
import { ensureStoryReceiver } from "../ext/story-receiver.mjs";

test("Story receiver does not inject when the approved tab already responds", async () => {
  let injected = false;
  await ensureStoryReceiver({ tabId: 7, tabs: { sendMessage: async () => ({ ok: true }) }, scripting: { executeScript: async () => { injected = true; } } });
  assert.equal(injected, false);
});

test("Story receiver injects only the existing loader then waits for its receiver", async () => {
  let calls = 0; let target;
  await ensureStoryReceiver({
    tabId: 7,
    tabs: { sendMessage: async () => { calls += 1; if (calls < 3) throw new Error("Receiving end does not exist"); return { ok: true }; } },
    scripting: { executeScript: async (request) => { target = request; } },
    delay: async () => {},
  });
  assert.deepEqual(target, { target: { tabId: 7 }, files: ["content-loader.js"] });
  assert.equal(calls, 3);
});
