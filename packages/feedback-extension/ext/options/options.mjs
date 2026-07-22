const url = document.getElementById("url");
const evidenceUrl = document.getElementById("evidenceUrl");
const status = document.getElementById("status");

const { intake } = await chrome.storage.local.get("intake");
if (intake) { url.value = intake.url ?? ""; evidenceUrl.value = intake.evidenceUrl ?? ""; }

document.getElementById("save").addEventListener("click", async () => {
  const value = url.value.trim() ? { url: url.value.trim(), ...(evidenceUrl.value.trim() ? { evidenceUrl: evidenceUrl.value.trim() } : {}) } : null;
  await chrome.storage.local.set({ intake: value });
  status.textContent = value ? "Saved." : "Cleared — local-only.";
  status.className = "saved";
});
