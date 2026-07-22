// standalone.mjs — extension mode as an ordinary producer
// (req-producer-owned-anchors): generic anchors stamped from the page URL
// (query and fragment stripped by construction), the extension's own
// fail-closed privacy manifest covering exactly the field paths its bundles
// produce, and a reporter assembled from the ring + telemetry providers.
import { createAnchor, createPrivacyManifest, createFeedbackReporter } from "./deps.mjs";
import { replayEvidenceItems } from "./ring.mjs";
import { telemetryProviders } from "./telemetry-main.mjs";

export const EXTENSION_PRODUCER = "sassfully-ext";

export function extensionAnchor({ url, bbox, mediaTimeMs, label } = {}) {
  const parsed = new URL(url);
  const artifactId = `${parsed.origin}${parsed.pathname}`;
  return createAnchor({
    producer: EXTENSION_PRODUCER,
    artifactId,
    url: artifactId,
    ...(bbox === undefined ? {} : { bbox }),
    ...(mediaTimeMs === undefined ? {} : { mediaTimeMs }),
    ...(label === undefined ? {} : { label }),
  });
}

// anchor.url is high with an explicit allow policy: the user enabled this
// origin by hand, and the review screen still shows the value before submit.
export function extensionPrivacyManifest() {
  return createPrivacyManifest({
    fields: {
      kind: "public",
      userText: "user_provided",
      "anchor.producer": "public",
      "anchor.artifactId": "low",
      "anchor.label": "low",
      "anchor.url": "high",
      "anchor.bbox": "low",
      "anchor.mediaTimeMs": "low",
      "evidence.kind": "low",
      "evidence.label": "low",
      "evidence.digest": "low",
      "evidence.snippet": "low",
      "evidence.contentType": "low",
      "evidence.size": "low",
      "evidence.transport": "low",
      "evidence.uploadApproved": "low",
      "context.mode": "low",
      "context.extensionVersion": "low",
    },
    hostPolicies: { "anchor.url": "allow" },
  });
}

/**
 * The standalone reporter: replay from the ring (freeze-on-capture, chunked
 * per req-sidecar-chunking) plus auto-captured telemetry. Raw payloads stay
 * local until per-item approval, unchanged from the core machine.
 */
export function createStandaloneReporter({ ring, telemetryClient, router, url, extensionVersion, replayWindowMs = 120_000, clipId } = {}) {
  if (!url) throw new TypeError("standalone: url is required");
  if (!router) throw new TypeError("standalone: router is required");
  const providers = [];
  if (ring) providers.push({
    id: "ext-replay",
    label: "Session replay",
    description: "Trailing replay window from the local recording ring",
    capture() {
      const snapshot = ring.snapshot({ lastMs: replayWindowMs });
      return replayEvidenceItems(snapshot, { clipId: clipId ?? `clip-${snapshot.endTs ?? "empty"}` });
    },
  });
  if (telemetryClient) providers.push(...telemetryProviders(telemetryClient));
  return createFeedbackReporter({
    anchorFor: () => extensionAnchor({ url }),
    manifest: extensionPrivacyManifest(),
    router,
    context: { mode: "extension-standalone", ...(extensionVersion === undefined ? {} : { extensionVersion }) },
    captureProviders: providers,
    autoCapture: ["ext-network", "ext-console", "ext-error"],
  });
}
