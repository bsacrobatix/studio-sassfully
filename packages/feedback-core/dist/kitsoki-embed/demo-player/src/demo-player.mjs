// Ordered demo-script player. Deliberately pure: every side effect
// (waiting, drawing, speaking, acting, delaying, stamping) arrives through
// `deps`, so the per-step sequencing — wait for target, spotlight, caption,
// narrate, pulse + act, dwell, first-error stop, clear at the end — is
// testable in plain node with no DOM and no speech.
//
// Step targets (spotlight / action.selector) are either raw CSS selector
// strings (the original POC shape) or structured anchors resolved by
// ./anchor-resolve.mjs. `deps.waitForTarget(target)` returns a
// resolution `{ element, strategy, healed }` (or null); when a lower-ranked
// anchor matched, the step result carries a `healed` note so the caller
// learns their selector drifted.
//
// Kept in lockstep with packages/feedback-extension/ext/content/demo-player.mjs;
// only the validateDemoScript import path differs from the extension copy.
import { validateDemoScript } from "./demo-script.mjs";
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
          deps.spotlight(spotlightResolution.element, { dim: step.dim !== false });
        }
        if (step.caption) deps.caption(step.caption);
        const dwellMs = step.dwellMs ?? DEFAULT_DWELL_MS;
        // Stage playback is deliberately another injected side effect. The
        // shared player stays browser/extension-neutral; embedded hosts pass
        // a stage adapter, while the extension simply has no `stage` dep.
        const stage = step.stage && deps.stage
          ? deps.stage(step.stage, spotlightResolution?.element ?? null)
          : null;
        const narration = step.narration
          ? deps.narrate(step.narration, { fallbackMs: dwellMs, voice: step.voice ?? script.voice ?? null })
          : null;
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
        // A persistent presenter starts once and remains visible across the
        // following steps. Controller cleanup stops it at the end of the run.
        if (stage && !step.stage.persistent) await stage;
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
