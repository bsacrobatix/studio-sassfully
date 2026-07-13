import { validateTourManifestV2 } from "@sassfully/tour-schema";

/**
 * Play a v2 document through an injected driver. The driver is deliberately
 * tiny: origin(), find(anchor)->matches, highlight(match), navigate(route),
 * act(action, match). Telemetry is callback-only; no analytics is imported.
 */
export async function playTour(manifestInput, { driver, onTelemetry = () => {}, consent = async () => false } = {}) {
  if (!driver) throw new TypeError("tour-player: driver is required");
  const manifest = validateTourManifestV2(manifestInput);
  if (manifest.origin && driver.origin?.() !== manifest.origin) throw new Error("tour-player: origin binding mismatch");
  const events = [];
  const emit = (event) => { const frozen = Object.freeze(event); events.push(frozen); onTelemetry(frozen); };
  for (const step of manifest.steps) {
    if (step.kind === "navigate") { await driver.navigate(step.route); emit({ type: "navigate", stepId: step.id, route: step.route }); continue; }
    let selected = null; let selectedRank = -1;
    for (let rank = 0; rank < step.target.length; rank += 1) {
      const matches = await driver.find(step.target[rank]);
      if (matches.length > 1) throw new Error(`tour-player: ambiguous anchor at ${step.id} rank ${rank}`);
      if (matches.length === 1) { selected = matches[0]; selectedRank = rank; break; }
    }
    if (!selected) throw new Error(`tour-player: missing anchor at ${step.id}`);
    if (selectedRank > 0) emit({ type: "heal", stepId: step.id, fromRank: 0, toRank: selectedRank, audited: true });
    await driver.highlight?.(selected, step);
    if (step.kind === "act") {
      if (step.consent === "confirm" && !(await consent(step))) { emit({ type: "act-denied", stepId: step.id }); throw new Error(`tour-player: consent denied for ${step.id}`); }
      await driver.act(step.action, selected, step); emit({ type: "act", stepId: step.id, consent: step.consent });
    } else emit({ type: "highlight", stepId: step.id });
  }
  return Object.freeze({ manifestId: manifest.id, events: Object.freeze(events) });
}
