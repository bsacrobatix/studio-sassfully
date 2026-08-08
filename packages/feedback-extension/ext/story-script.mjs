import { validateStoryCommand } from "./story-bridge-policy.mjs";

// Deliberately small script runner. The background supplies the paired-tab
// executor; this module makes ordering and first-error behavior testable.
export async function runScriptSteps({ steps, execute }) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("run_script needs a non-empty steps array");
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const check = validateStoryCommand(step);
    if (!check.ok || step.action === "run_script") throw new Error(`step ${index + 1}: ${check.error ?? "nested run_script is not supported"}`);
    try { results.push({ index, action: step.action, result: await execute(step) }); }
    catch (error) { throw new Error(`step ${index + 1} (${step.action}): ${error.message}`); }
  }
  return results;
}
