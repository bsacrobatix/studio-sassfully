/** @sassfully/demo-tts — public surface. */

export {
  synthesize, validateText, estimateDurationMs, measureDurationMs,
  edgeTtsAvailable, ffprobeAvailable,
  DEFAULT_VOICE, MAX_TEXT_LENGTH, ESTIMATE_WPM,
} from './synthesize.mjs';
export { cachedSynthesize, cacheKeyFor } from './cache.mjs';
export { createServer, startServer, LOOPBACK_HOST } from './server.mjs';
export { prebake, validateScript, SCRIPT_VERSION } from './prebake.mjs';
