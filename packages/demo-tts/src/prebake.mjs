/**
 * @sassfully/demo-tts — prebake a demo script's narration to disk.
 *
 * Given a `sassfully/demo-script/v1` object (steps carrying `narration`
 * strings — see packages/feedback-extension/RUNBOOK.md), synthesize every
 * step's narration into an output directory and write `manifest.json`:
 * an array of `{ stepId, file, durationMs, estimated }`, one entry per step
 * that has narration, in step order. This is what recorded/CI demos consume:
 * measured durations mean the player's step timing locks to the voice with
 * no live TTS in the loop.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { synthesize as defaultSynthesize } from './synthesize.mjs';

export const SCRIPT_VERSION = 'sassfully/demo-script/v1';

/** Filesystem-safe clip name derived from a step id. */
function fileFor(stepId, index) {
  const safe = String(stepId ?? `step-${index + 1}`).replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${safe}.mp3`;
}

/**
 * Validate the shape prebake needs. Throws with a pointed message; returns
 * the steps array.
 */
export function validateScript(script) {
  if (!script || typeof script !== 'object') throw new Error('script must be an object');
  if (script.version !== SCRIPT_VERSION) {
    throw new Error(`script.version must be "${SCRIPT_VERSION}" (got ${JSON.stringify(script.version)})`);
  }
  if (!Array.isArray(script.steps) || script.steps.length === 0) {
    throw new Error('script.steps must be a non-empty array');
  }
  return script.steps;
}

/**
 * Synthesize every narrated step into `outDir` + write manifest.json.
 *
 * @param {object} script — parsed sassfully/demo-script/v1 JSON.
 * @param {object} opts
 * @param {string} opts.outDir — required output directory (created).
 * @param {string} [opts.voice] [opts.rate] [opts.pitch] — passed through.
 * @param {Function} [opts.synthesize] — injectable synth (tests mock this).
 * @param {Function} [opts.log] — progress lines, default silent.
 * @returns {Promise<{ manifest: Array<{stepId, file, durationMs, estimated}>,
 *                     manifestPath: string, outDir: string }>}
 */
export async function prebake(script, opts = {}) {
  const { outDir, synthesize = defaultSynthesize, log = () => {}, ...synthOpts } = opts;
  if (!outDir) throw new Error('prebake requires opts.outDir');
  const steps = validateScript(script);
  await mkdir(outDir, { recursive: true });

  const manifest = [];
  for (const [index, step] of steps.entries()) {
    const narration = step?.narration;
    if (typeof narration !== 'string' || !narration.trim()) continue;
    const stepId = step.id ?? `step-${index + 1}`;
    const file = fileFor(step.id, index);
    log(`prebake ${stepId}: "${narration.slice(0, 60)}${narration.length > 60 ? '…' : ''}"`);
    const { mp3, durationMs, estimated } = await synthesize(narration, synthOpts);
    await writeFile(join(outDir, file), mp3);
    manifest.push({ stepId, file, durationMs, estimated });
    log(`prebake ${stepId}: ${file} (${durationMs}ms${estimated ? ', estimated' : ''})`);
  }

  const manifestPath = join(outDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, manifestPath, outDir };
}
