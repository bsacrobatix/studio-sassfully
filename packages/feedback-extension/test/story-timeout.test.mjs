import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../ext/story-timeout.mjs";

test("atomic stage timeout converts a no-response Chrome operation into a labeled error", async () => {
  let callback;
  const promise = withTimeout(new Promise(() => {}), { ms: 1, stage: "remote_selection", setTimer: (fn) => { callback = fn; return 1; }, clearTimer: () => {} });
  callback();
  await assert.rejects(promise, /remote_selection timed out after 1 seconds/);
});

test("atomic stage timeout preserves normal operation completion", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), { ms: 1000, stage: "navigate" }), "ok");
});
