// Ordered demo-script player (POC). Deliberately pure: every side effect
// (waiting, drawing, speaking, acting, delaying) arrives through `deps`, so
// the per-step sequencing — wait for target, spotlight, caption, narrate,
// pulse + act, dwell, first-error stop, clear at the end — is testable in
// plain node with no DOM and no speech.
import { validateDemoScript } from "../story-bridge-policy.mjs";

export const DEFAULT_DWELL_MS = 800;

// Demo actions reuse the existing autonomous story-command machinery; this is
// the exact translation from {kind, selector, value} to a story command.
export function demoActionToStoryCommand(action) {
  if (action.kind === "click") return { action: "click", selector: action.selector };
  if (action.kind === "fill") return { action: "fill", selector: action.selector, text: action.value };
  return { action: "press", key: action.value };
}

export function createDemoRunState() {
  return { cancelled: false, cancel() { this.cancelled = true; } };
}

export async function runDemoScript({ script, deps, state = createDemoRunState() }) {
  const check = validateDemoScript(script);
  if (!check.ok) throw new Error(check.error);
  const results = [];
  try {
    for (let index = 0; index < script.steps.length; index += 1) {
      if (state.cancelled) return { stopped: true, completedSteps: results };
      const step = script.steps[index];
      const label = step.id ?? `step ${index + 1}`;
      try {
        let target = null;
        if (step.spotlight) {
          target = await deps.waitForTarget(step.spotlight);
          if (!target) throw new Error(`spotlight target not found: ${step.spotlight}`);
          deps.spotlight(target);
        }
        if (step.caption) deps.caption(step.caption);
        const dwellMs = step.dwellMs ?? DEFAULT_DWELL_MS;
        const narration = step.narration ? deps.narrate(step.narration, { fallbackMs: dwellMs }) : null;
        if (step.action) {
          const actionTarget = await deps.waitForTarget(step.action.selector ?? step.spotlight ?? "body");
          if (actionTarget) deps.pulse(actionTarget);
          await deps.act(step.action);
        }
        if (narration) await narration;
        if (state.cancelled) return { stopped: true, completedSteps: results };
        await deps.delay(dwellMs);
        results.push({ index, id: step.id ?? null, ok: true });
      } catch (error) {
        throw new Error(`${label}: ${error.message}`);
      }
    }
    return { completed: true, completedSteps: results };
  } finally {
    deps.clear();
  }
}
