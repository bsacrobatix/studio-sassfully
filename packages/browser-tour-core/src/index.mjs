import { validateTourManifestV2 } from "@sassfully/tour-schema";
import { playTour } from "@sassfully/tour-player";

function paths(value, prefix = "") {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}
/** Capture is opt-in. Every exported field must have a declared classification. */
export async function captureBrowserEvidence(driver, { optIn = false, classifications = {} } = {}) {
  if (!optIn) return Object.freeze({ captured: false, fields: Object.freeze({}) });
  if (!driver?.capture) throw new TypeError("browser-tour-core: capture-capable driver is required");
  const fields = await driver.capture();
  for (const path of paths(fields)) if (!classifications[path]) throw new Error(`browser-tour-core: unclassified captured field ${path}`);
  return Object.freeze({ captured: true, fields: Object.freeze(structuredClone(fields)), classifications: Object.freeze({ ...classifications }) });
}
/**
 * Deterministic snapshot boundary. Drivers supply DOM-shaped data; this core
 * enforces a byte cap and an explicit classification for every leaf before a
 * caller can expose it to a grounding provider or an exporter.
 */
export async function snapshotForGrounding(driver, options = {}) {
  const evidence = await captureBrowserEvidence(driver, { ...options, optIn: true });
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const encoded = JSON.stringify(evidence.fields);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error(`browser-tour-core: snapshot exceeds ${maxBytes} byte cap`);
  return evidence;
}
/** Optional provider seam: deterministic paths never call this function. */
export async function groundTour(provider, snapshot) {
  if (!provider?.proposeActions) throw new TypeError("browser-tour-core: injected grounding provider is required");
  return structuredClone(await provider.proposeActions(snapshot));
}
/** Deterministic authoring only accepts literal v2 operations; no provider seam exists here. */
export function authorTour(document) { return validateTourManifestV2(document); }
export function exportTour(manifest) { return JSON.stringify(validateTourManifestV2(manifest)); }
export async function replayTour(manifest, options) { return playTour(manifest, options); }
