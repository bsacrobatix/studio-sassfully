// The single seam between this package and its sibling sources. In the repo
// these are relative imports (the feedback-vue modules re-used here are
// framework-free); the dist build rewrites ONLY this file to point at the
// vendored copies, so no other source ever changes between repo and dist.
export {
  KINDS, KIND_CONFIG, isKind,
  createAnchor, anchorDisplayFields,
  createPrivacyManifest, privacyVerdict, fieldPaths,
  idempotencyKey, contentDigest,
  createDraft, attachEvidence, setEvidenceUpload, setUserText, reviewedPayload, beginReview, approveReview, submit, sidecarItems, uploadEvidence,
  localJsonlSink, bundleSink, dryRunSink, httpSink, createRouter,
  BRIDGE_PROTOCOL, createHostBridge,
} from "../../feedback-core/src/index.mjs";
export { createFeedbackReporter } from "../../feedback-vue/src/controller.mjs";
export { createBrowserEvidenceCapture } from "../../feedback-vue/src/browser-capture.mjs";
