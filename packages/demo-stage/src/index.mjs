/**
 * @sassfully/demo-stage — animated cartoon cast over live page content.
 *
 * The adapter (this package's own code) plus the pieces of the vendored
 * slidey stage runtime a host is expected to reach for. Everything else in
 * vendor/slidey-stage/ is importable directly when needed.
 */

export { mountStageLayer, computeStageBox, STAGE_LAYER_Z } from './stage-layer.mjs';

export {
  resolveCast, rosterOf, buildTimeline, stageStateAt, estimateSpeech,
} from '../vendor/slidey-stage/engine.mjs';
export { mountStagePlayer } from '../vendor/slidey-stage/player.mjs';
export { validateScene, formatFindings } from '../vendor/slidey-stage/validate.mjs';
export { resolveSceneRefs, mergeCast, stageScenes } from '../vendor/slidey-stage/refs.mjs';
