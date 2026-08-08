import test from "node:test";
import assert from "node:assert/strict";
import { appendStoryAudit, makeStoryAuditEntry, STORY_AUDIT_KEY } from "../ext/story-audit.mjs";

test("paired-tab audit keeps request IDs and bounds stored outcomes", async () => {
  let values = { [STORY_AUDIT_KEY]: Array.from({ length: 100 }, (_, index) => ({ requestId: `old-${index}` })) };
  const storage = { get: async () => values, set: async (next) => { values = { ...values, ...next }; } };
  const entry = makeStoryAuditEntry({ requestId: "req-new", action: "extract", status: "ok", at: "2026-07-30T00:00:00.000Z" });
  await appendStoryAudit(storage, entry);
  assert.equal(values[STORY_AUDIT_KEY].length, 100);
  assert.equal(values[STORY_AUDIT_KEY][0].requestId, "old-1");
  assert.deepEqual(values[STORY_AUDIT_KEY].at(-1), entry);
});
