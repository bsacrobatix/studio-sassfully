// Bounded local audit trail: request correlation and outcome only.  It never
// stores collected card text, URLs, or replay payloads in extension storage.
export const STORY_AUDIT_KEY = "storyBridgeAudit";
export function makeStoryAuditEntry({ requestId, action, status, detail = null, at = new Date().toISOString() }) {
  return { requestId, action, status, detail, at };
}
export async function appendStoryAudit(storage, entry) {
  const current = (await storage.get(STORY_AUDIT_KEY))[STORY_AUDIT_KEY] ?? [];
  const next = [...current, entry].slice(-100);
  await storage.set({ [STORY_AUDIT_KEY]: next });
  return entry;
}
