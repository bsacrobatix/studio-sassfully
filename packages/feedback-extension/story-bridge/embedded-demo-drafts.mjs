// Small, in-memory CAS draft store for local embedded-demo control. Drafts
// never reach a page until `push` after a successful current-tab preflight.
import crypto from "node:crypto";

export function createEmbeddedDemoDrafts({ validateScript }) {
  const drafts = new Map();
  const summary = (draft) => ({ draftId: draft.draftId, revision: draft.revision, validation: draft.validation });
  function propose(script) {
    const check = validateScript(script);
    if (!check.ok) throw new Error(check.error);
    const draft = { draftId: `demo-${crypto.randomUUID()}`, revision: 1, script, validation: { ok: false, state: "unvalidated" } };
    drafts.set(draft.draftId, draft);
    return summary(draft);
  }
  function update({ draftId, revision, script }) {
    const draft = drafts.get(draftId);
    if (!draft) throw new Error("draft not found");
    if (revision !== draft.revision) throw new Error(`revision conflict: current revision is ${draft.revision}`);
    const check = validateScript(script);
    if (!check.ok) throw new Error(check.error);
    draft.script = script; draft.revision += 1; draft.validation = { ok: false, state: "unvalidated" };
    return summary(draft);
  }
  function get({ draftId, revision }) {
    const draft = drafts.get(draftId);
    if (!draft) throw new Error("draft not found");
    if (revision != null && revision !== draft.revision) throw new Error(`revision conflict: current revision is ${draft.revision}`);
    return draft;
  }
  function recordValidation({ draftId, revision, sessionId, result }) {
    const draft = get({ draftId, revision });
    draft.validation = { state: "validated", sessionId, revision, ...result };
    return summary(draft);
  }
  function pushable({ draftId, revision, sessionId }) {
    const draft = get({ draftId, revision });
    if (!draft.validation.ok || draft.validation.sessionId !== sessionId || draft.validation.revision !== draft.revision) throw new Error("draft revision has not passed validation against this session");
    return draft;
  }
  return { propose, update, get, recordValidation, pushable };
}
