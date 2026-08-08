// Ordered demo-script player. Deliberately pure: every side effect
// (waiting, drawing, speaking, acting, delaying, stamping) arrives through
// `deps`, so the per-step sequencing — wait for target, spotlight, caption,
// narrate, pulse + act, dwell, first-error stop, clear at the end — is
// testable in plain node with no DOM and no speech.
//
// Step targets (spotlight / action.selector) are either raw CSS selector
// strings (the original POC shape) or structured anchors resolved by
// ext/content/anchor-resolve.mjs. `deps.waitForTarget(target)` returns a
// resolution `{ element, strategy, healed }` (or null); when a lower-ranked
// anchor matched, the step result carries a `healed` note so the caller
// learns their selector drifted.
import { validateDemoScript } from "../story-bridge-policy.mjs";
import { anchorLabel } from "./anchor-resolve.mjs";

export const DEFAULT_DWELL_MS = 800;

// Demo actions with plain string selectors reuse the existing autonomous
// story-command machinery; this is the exact translation from
// {kind, selector, value} to a story command. Structured-anchor actions are
// performed directly on the resolved element by the deps.act implementation.
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
      const stamp = (payload) => { try { deps.stepStamp?.({ index, id: step.id ?? null, ...payload }); } catch { /* stamps are best-effort QA breadcrumbs */ } };
      try {
        stamp({ phase: "start" });
        const healedNotes = [];
        const noteHealed = (kind, resolution) => { if (resolution?.healed) healedNotes.push({ target: kind, ...resolution.healed }); };
        let spotlightResolution = null;
        if (step.spotlight) {
          spotlightResolution = await deps.waitForTarget(step.spotlight);
          if (!spotlightResolution) throw new Error(`spotlight target not found: ${anchorLabel(step.spotlight)}`);
          noteHealed("spotlight", spotlightResolution);
          deps.spotlight(spotlightResolution.element);
        }
        if (step.caption) deps.caption(step.caption);
        const dwellMs = step.dwellMs ?? DEFAULT_DWELL_MS;
        const narration = step.narration ? deps.narrate(step.narration, { fallbackMs: dwellMs }) : null;
        if (step.action) {
          const actionAnchor = step.action.selector ?? step.spotlight ?? "body";
          const actionResolution = await deps.waitForTarget(actionAnchor);
          if (actionResolution) {
            if (step.action.selector != null) noteHealed("action", actionResolution);
            deps.pulse(actionResolution.element);
          }
          await deps.act(step.action, actionResolution?.element ?? null);
        }
        if (narration) await narration;
        if (state.cancelled) return { stopped: true, completedSteps: results };
        await deps.delay(dwellMs);
        const result = {
          index,
          id: step.id ?? null,
          ok: true,
          anchor: spotlightResolution?.strategy ?? null,
          healed: healedNotes.length ? healedNotes : null,
        };
        results.push(result);
        stamp({ phase: "end", ok: true, anchor: result.anchor, healed: result.healed });
      } catch (error) {
        stamp({ phase: "end", ok: false, error: error.message });
        throw new Error(`${label}: ${error.message}`);
      }
    }
    return { completed: true, completedSteps: results };
  } finally {
    deps.clear();
  }
}
