import test from "node:test";
import assert from "node:assert/strict";
import { createEmbeddedDemoDrafts } from "../story-bridge/embedded-demo-drafts.mjs";

const valid = (script) => script?.steps?.length ? { ok: true } : { ok: false, error: "steps required" };
test("embedded drafts use CAS revisions and require fresh session validation before push", () => {
  const drafts = createEmbeddedDemoDrafts({ validateScript: valid });
  const one = drafts.propose({ steps: [{ caption: "one" }] });
  assert.equal(one.revision, 1);
  assert.throws(() => drafts.pushable({ draftId: one.draftId, revision: 1, sessionId: "page" }), /has not passed/);
  drafts.recordValidation({ draftId: one.draftId, revision: 1, sessionId: "page", result: { ok: true, drift: [] } });
  assert.equal(drafts.pushable({ draftId: one.draftId, revision: 1, sessionId: "page" }).script.steps[0].caption, "one");
  const two = drafts.update({ draftId: one.draftId, revision: 1, script: { steps: [{ caption: "two" }] } });
  assert.equal(two.revision, 2);
  assert.throws(() => drafts.update({ draftId: one.draftId, revision: 1, script: { steps: [{ caption: "stale" }] } }), /revision conflict/);
  assert.throws(() => drafts.pushable({ draftId: one.draftId, revision: 2, sessionId: "page" }), /has not passed/);
});
