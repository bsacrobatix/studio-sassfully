/**
 * @sassfully/demo-tts — content-addressed disk cache for synthesized clips.
 *
 * Key = sha256 of the JSON of everything that changes the audio
 * (text + voice + rate + pitch), truncated to 32 hex chars — the same scheme
 * slidey's narration preview uses. Each entry is `<key>.mp3` (the bytes) plus
 * `<key>.json` (durationMs / estimated), written via tmp-file + rename so a
 * crashed write never leaves a half-cached clip that later reads as valid.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { synthesize as defaultSynthesize, DEFAULT_VOICE } from './synthesize.mjs';

/** Stable cache key for one (text, voice, rate, pitch) combination. */
export function cacheKeyFor({ text, voice = DEFAULT_VOICE, rate = '+0%', pitch = '+0Hz' }) {
  return createHash('sha256')
    .update(JSON.stringify({ text, voice, rate, pitch }))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Synthesize through the cache.
 *
 * @param {string} text
 * @param {object} opts — voice/rate/pitch (as synthesize) plus:
 * @param {string} opts.cacheDir — required cache directory.
 * @param {Function} [opts.synthesize] — injectable synth (tests mock this).
 * @returns {Promise<{ mp3: Buffer, durationMs: number, estimated: boolean,
 *                     cacheKey: string, cacheHit: boolean }>}
 */
export async function cachedSynthesize(text, opts = {}) {
  const { cacheDir, synthesize = defaultSynthesize, ...synthOpts } = opts;
  if (!cacheDir) throw new Error('cachedSynthesize requires opts.cacheDir');
  await mkdir(cacheDir, { recursive: true });

  const key = cacheKeyFor({
    text, voice: synthOpts.voice, rate: synthOpts.rate, pitch: synthOpts.pitch,
  });
  const mp3Path = join(cacheDir, `${key}.mp3`);
  const metaPath = join(cacheDir, `${key}.json`);

  if (existsSync(mp3Path) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const mp3 = await readFile(mp3Path);
      if (mp3.length && Number.isFinite(meta.durationMs)) {
        return {
          mp3, durationMs: meta.durationMs, estimated: !!meta.estimated,
          cacheKey: key, cacheHit: true,
        };
      }
    } catch {
      // Corrupt entry: fall through and re-synthesize over it.
    }
  }

  const { mp3, durationMs, estimated } = await synthesize(text, synthOpts);

  const stamp = `${process.pid}.${Date.now()}`;
  const mp3Tmp = join(cacheDir, `${key}.${stamp}.mp3.tmp`);
  const metaTmp = join(cacheDir, `${key}.${stamp}.json.tmp`);
  await writeFile(mp3Tmp, mp3);
  await writeFile(metaTmp, JSON.stringify({ durationMs, estimated }));
  await rename(mp3Tmp, mp3Path);
  await rename(metaTmp, metaPath);

  return { mp3, durationMs, estimated, cacheKey: key, cacheHit: false };
}
