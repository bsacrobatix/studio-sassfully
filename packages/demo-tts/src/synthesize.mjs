/**
 * @sassfully/demo-tts — edge-tts synthesis with measured duration.
 *
 * One clip in, `{ mp3: Buffer, durationMs, estimated }` out. Invokes the
 * `edge-tts` Python CLI (pipx install edge-tts) with temp files under
 * os.tmpdir(), then measures the real duration with ffprobe. When ffprobe is
 * unavailable the duration is estimated from word count at ~155 wpm and the
 * result is flagged `estimated: true` so callers can tell measured timing from
 * a guess.
 *
 * CLI invocation follows slidey's edge backend (src/tts/backends/edge.cjs):
 * `--rate=`/`--pitch=` are `=`-joined, NOT space-separated — Python's argparse
 * reads a leading "-" in the next argv entry as a new flag, so a negative rate
 * or pitch dies with `argument --rate: expected one argument`. The `=` form is
 * unambiguous and identical for positive values.
 */

import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

/** slidey's default voice — keeps demo narration consistent with decks. */
export const DEFAULT_VOICE = 'en-AU-NatashaNeural';

/** Matches the demo-script policy cap on `narration` strings. */
export const MAX_TEXT_LENGTH = 2000;

/** Reading speed used when ffprobe cannot measure the clip. */
export const ESTIMATE_WPM = 155;

/**
 * Validate narration text against the demo-script policy. Throws on
 * non-string, empty/whitespace-only, or over-cap input. Returns the text.
 */
export function validateText(text) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  if (!text.trim()) throw new Error('text must be non-empty');
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text exceeds ${MAX_TEXT_LENGTH} chars (got ${text.length})`);
  }
  return text;
}

/** Word-count fallback: ~155 wpm, floor 300ms so a one-word clip isn't 0. */
export function estimateDurationMs(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(300, Math.round((words / ESTIMATE_WPM) * 60_000));
}

/** Is the edge-tts CLI runnable? `{ ok, detail }`, never throws. */
export function edgeTtsAvailable(bin = 'edge-tts') {
  try {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    // Non-zero status for an odd flag is fine; a spawn error means no binary.
    if (r.error) return { ok: false, detail: `${bin} not found on PATH — install: pipx install edge-tts` };
    return { ok: true, detail: `${bin} on PATH` };
  } catch (err) {
    return { ok: false, detail: `${bin} probe failed: ${err.message}` };
  }
}

/** Is ffprobe runnable? `{ ok, detail }`, never throws. */
export function ffprobeAvailable(bin = 'ffprobe') {
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    if (r.error) return { ok: false, detail: `${bin} not found on PATH — install: brew install ffmpeg` };
    return { ok: true, detail: `${bin} on PATH` };
  } catch (err) {
    return { ok: false, detail: `${bin} probe failed: ${err.message}` };
  }
}

/** Measure a media file's duration in ms with ffprobe. Throws if unmeasurable. */
export async function measureDurationMs(file, { ffprobeBin = 'ffprobe' } = {}) {
  const { stdout } = await execFile(ffprobeBin, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  const seconds = parseFloat(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned "${String(stdout).trim()}" for ${file}`);
  }
  return Math.round(seconds * 1000);
}

function commandFailureDetail(err, command) {
  if (err && err.code === 'ENOENT') return `${command} not found on PATH`;
  const stderr = err && err.stderr ? err.stderr.toString().trim() : '';
  const stdout = err && err.stdout ? err.stdout.toString().trim() : '';
  return [stderr, stdout].filter(Boolean).join('\n')
    || (err && err.message ? err.message : String(err));
}

/**
 * Synthesize one narration clip.
 *
 * @param {string} text — narration text (≤ MAX_TEXT_LENGTH chars).
 * @param {object} [opts]
 * @param {string} [opts.voice]  edge voice name, default en-AU-NatashaNeural.
 * @param {string} [opts.rate]   e.g. '+0%', '-6%'.
 * @param {string} [opts.pitch]  e.g. '+0Hz', '-4Hz'.
 * @param {string} [opts.edgeTtsBin]  override the edge-tts binary.
 * @param {string} [opts.ffprobeBin]  override the ffprobe binary.
 * @returns {Promise<{ mp3: Buffer, durationMs: number, estimated: boolean }>}
 */
export async function synthesize(text, opts = {}) {
  validateText(text);
  const {
    voice = DEFAULT_VOICE,
    rate = '+0%',
    pitch = '+0Hz',
    edgeTtsBin = 'edge-tts',
    ffprobeBin = 'ffprobe',
  } = opts;

  const dir = await mkdtemp(join(tmpdir(), 'demo-tts-'));
  const outPath = join(dir, 'clip.mp3');
  try {
    try {
      await execFile(edgeTtsBin, [
        '--text', text,
        '--voice', voice,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        '--write-media', outPath,
      ]);
    } catch (err) {
      throw new Error(
        `edge-tts failed for voice ${voice}: ${commandFailureDetail(err, edgeTtsBin)}\n` +
        'Install: pipx install edge-tts  # or: python3 -m pip install --user edge-tts'
      );
    }

    const mp3 = await readFile(outPath);
    if (!mp3.length) throw new Error(`edge-tts produced an empty file for voice ${voice}`);

    let durationMs;
    let estimated = false;
    try {
      durationMs = await measureDurationMs(outPath, { ffprobeBin });
    } catch {
      durationMs = estimateDurationMs(text);
      estimated = true;
    }

    return { mp3, durationMs, estimated };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
