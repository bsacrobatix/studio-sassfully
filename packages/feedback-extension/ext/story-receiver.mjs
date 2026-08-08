// A dynamic content-script registration only affects future documents.  A
// paired tab may already exist after an MV3 reload, so prove there is a live
// receiver and inject the existing narrow loader into that already-approved
// tab when necessary.
export async function ensureStoryReceiver({ tabs, scripting, tabId, attempts = 10, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const ping = () => tabs.sendMessage(tabId, { type: "story-ping" });
  try { await ping(); return; } catch { /* inject below */ }
  await scripting.executeScript({ target: { tabId }, files: ["content-loader.js"] });
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try { await ping(); return; } catch (error) { lastError = error; await delay(50); }
  }
  throw new Error(`The approved LinkedIn tab did not start the Story receiver: ${lastError?.message ?? "unknown error"}`);
}
