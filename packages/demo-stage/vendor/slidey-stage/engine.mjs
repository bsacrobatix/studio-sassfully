/**
 * stage — engine
 *
 * Pure functions only. No DOM, no fs, no network, no module-level state. Every
 * export takes the data it needs and returns a value; time is always an input.
 * That is what makes scrubbing exact, the contact sheet trivial, a PDF page a
 * sample at `beat.start`, and the whole thing testable in a bare `vm`.
 */

export const TAIL = 0.35;               // silence after a line lands
const ENTER_OFFSTAGE = 14;              // units beyond the frame edge

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, p) => a + (b - a) * p;
export const easeIO = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const fillTokens = (tpl, pal) => String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => pal[k] ?? 'none');

/* ── cast resolution ──────────────────────────────────────────────────────── */

/** Expand one character definition against its body plan. */
export function resolveCharacter(def, plans) {
  if (def.style === 'pixel') return { ...def, style: 'pixel' };
  const plan = plans?.[def.plan];
  if (!plan) throw new Error(`unknown plan "${def.plan}" for character "${def.id}"`);
  const pal = { ...def.palette, hair: fillTokens(def.hair || '', def.palette) };
  const parts = {};
  for (const [name, p] of Object.entries(plan.parts)) parts[name] = { ...p, html: fillTokens(p.svg, pal) };
  return { ...def, style: 'vector', size: plan.size, order: plan.order, parts, states: plan.states };
}

/** Cast library → `{ id: resolvedCharacter }`. */
export function resolveCast(cast) {
  const out = {};
  for (const def of cast?.characters ?? []) out[def.id] = resolveCharacter(def, cast.plans);
  return out;
}

/** Character ids this scene puts on stage (defaults to the whole library). */
export function rosterOf(scene, cast) {
  if (Array.isArray(scene.roster) && scene.roster.length) return scene.roster;
  return (cast?.characters ?? []).map((c) => c.id);
}

/* ── narration timing ─────────────────────────────────────────────────────── */

/**
 * Content hash of (text, voice) — must stay byte-identical to the one in
 * src/narration.mjs. Keying on content rather than beat index means an edited
 * line degrades to the word-count estimate instead of silently playing the
 * previous take.
 */
export function narrationKey(text, v) {
  let h = 2166136261;
  for (const ch of `${text}|${v.edge}|${v.rate}|${v.pitch}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Fallback for a beat whose audio has not been built yet. */
export function estimateSpeech(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.35, 0.5 + words / 2.75);
}

export const beatText = (b) => b.line || b.narration || '';
export const beatVoice = (b, chars, narrator) => (b.speaker ? chars[b.speaker]?.voice : narrator);

/**
 * Beats → an absolute timeline. A beat lasts exactly as long as its own audio
 * plus TAIL; an explicit `dur` may only *extend* it (to hold on a walk-off),
 * never truncate a line. So a storyboard contains no timing numbers at all.
 */
export function buildTimeline(scene, chars, audio) {
  const clips = audio?.clips ?? audio ?? {};
  const tail = audio?.tail ?? TAIL;
  let t = 0;
  const beats = (scene.beats ?? []).map((b, i) => {
    const voice = beatVoice(b, chars, scene.narrator);
    const text = beatText(b);
    const key = voice && text ? narrationKey(text, voice) : null;
    const rec = key ? clips[key] : null;
    const dur = rec ? Math.max(rec.d + tail, b.dur ?? 0) : (b.dur ?? estimateSpeech(text));
    const entry = { ...b, index: i, start: t, dur, key, measured: !!rec, text, voice: voice ?? null };
    t += dur;
    return entry;
  });
  return { beats, total: t, measured: beats.filter((b) => b.measured).length, tail };
}

/** The beat live at `t` (the last one, once past the end). */
export function beatAt(timeline, t) {
  const { beats } = timeline;
  if (!beats.length) return null;
  for (const b of beats) if (t >= b.start && t < b.start + b.dur) return b;
  return t < 0 ? null : beats[beats.length - 1];
}

/* ── the pure function: full stage state at time t ────────────────────────── */

export function stageStateAt(scene, timeline, t, roster) {
  const ids = roster ?? rosterOf(scene, scene.cast);
  const actors = {};
  for (const id of ids) {
    actors[id] = { id, x: 50, y: 0, face: 'right', state: 'idle', visible: false, speaking: false };
  }
  let current = null;

  for (const b of timeline.beats) {
    if (t < b.start) break;
    const raw = (t - b.start) / b.dur;
    const p = clamp(raw, 0, 1);
    const live = raw < 1;
    if (live) current = b;

    for (const d of b.act ?? []) {
      const a = actors[d.who];
      if (!a) continue;                                  // reported by the validator
      if (d.face) a.face = d.face;
      if (d.state) a.state = d.state;
      if (d.y != null) a.y = d.y;

      if (d.at != null) { a.x = d.at; a.visible = true; }
      if (d.enter) {
        const from = d.enter === 'left' ? -ENTER_OFFSTAGE : (scene.stage.units.w + ENTER_OFFSTAGE);
        a.visible = true;
        a.x = lerp(from, d.to, easeIO(p));
      }
      if (d.move) a.x = lerp(a.x, d.move.to, easeIO(p));
      if (d.exit) {
        const to = d.exit === 'left' ? -ENTER_OFFSTAGE : (scene.stage.units.w + ENTER_OFFSTAGE);
        a.x = lerp(a.x, to, easeIO(p));
        if (!live) a.visible = false;
      }
      if (d.jump) {
        a.x = lerp(a.x, d.jump.to, p);
        a.y = Math.sin(Math.PI * p) * (d.jump.height ?? 10);
      }
    }
    if (!live && b.act) for (const d of b.act) if (d.jump && actors[d.who]) actors[d.who].y = 0;
  }

  if (current?.speaker && actors[current.speaker]) actors[current.speaker].speaking = true;
  return { actors, beat: current, t };
}

/* ── pose interpolation ───────────────────────────────────────────────────── */

export const ZERO = { rot: 0, x: 0, y: 0, sx: 1, sy: 1 };

/**
 * The mouth's rest pose when a state's poses don't mention `mouth` at all.
 * ZERO's `sy: 1` is the mouth part's full drawn height — a wide-open "O" —
 * because that shape is meant to be reached deliberately (mouthFlap's speech
 * override, or a state like `idle`/`deadpan` that poses a closed/relaxed
 * value on purpose). States that have nothing to say about the mouth (walk,
 * gesture, point, shrug, arms) aren't opting into an open mouth; they just
 * never thought about it. Falling back to ZERO there leaves every silent
 * character gaping, so the fallback is a closed mouth instead.
 */
export const MOUTH_REST = { ...ZERO, sy: 0.18 };

export function poseAt(state, t) {
  if (!state) return {};
  const n = state.poses.length;
  if (!state.loop || n === 1) return state.poses[0];
  const phase = (((t / state.loop) % 1) + 1) % 1;
  const f = phase * n, i = Math.floor(f), k = f - i;
  const A = state.poses[i % n], B = state.poses[(i + 1) % n];
  const out = {};
  for (const part of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = { ...ZERO, ...(A[part] || {}) }, b = { ...ZERO, ...(B[part] || {}) };
    out[part] = {
      rot: lerp(a.rot, b.rot, k), x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k),
      sx: lerp(a.sx, b.sx, k), sy: lerp(a.sy, b.sy, k),
    };
  }
  return out;
}

/**
 * Speaking overrides the mouth regardless of the state's own pose, so a state
 * never has to know whether the character has a line in this beat.
 */
export function mouthFlap(t) {
  const s = Math.abs(Math.sin(t * 11.5)) * 0.72 + Math.abs(Math.sin(t * 7.1)) * 0.5;
  return { rot: 0, x: 0, y: 0, sx: 1, sy: clamp(0.25 + s, 0.25, 1.7) };
}

/** Which atlas frame a pixel character shows at `t`. */
export function pixelFrameAt(char, stateName, t) {
  const tags = char.atlas.frameTags;
  const tag = tags.find((x) => x.name === (char.states?.[stateName] || 'idle')) || tags[0];
  const span = tag.to - tag.from + 1;
  return tag.from + (Math.floor(t / tag.duration) % span);
}

/* ── geometry: the single source of truth for both renderers ──────────────── */

const f3 = (n) => Number(n ?? 0).toFixed(3);

/**
 * Every transform string for one actor at time `t`. The string renderer writes
 * these into markup; the browser player writes them onto live nodes. Neither
 * computes geometry itself, so a still and a frame can never disagree.
 */
export function actorTransforms(char, actor, t, ground) {
  const sc = char.scale ?? 1;
  const out = {
    root: `translate(${f3(actor.x)} ${f3(ground - actor.y)})`,
    inner: `scale(${f3(actor.face === 'left' ? -sc : sc)} ${f3(sc)})`,
    parts: {},
  };
  if (char.style === 'pixel') return out;

  const pose = poseAt(char.states[actor.state] || char.states.idle, t);
  for (const [name, def] of Object.entries(char.parts)) {
    let p = pose[name] || (name === 'mouth' ? MOUTH_REST : ZERO);
    if (name === 'mouth' && actor.speaking) p = mouthFlap(t);
    const [px, py] = def.pivot;
    out.parts[name] =
      `translate(${f3(p.x)} ${f3(p.y)}) ` +
      `rotate(${Number(p.rot ?? 0).toFixed(2)} ${px} ${py}) ` +
      `translate(${px} ${py}) scale(${f3(p.sx ?? 1)} ${f3(p.sy ?? 1)}) translate(${-px} ${-py})`;
  }
  return out;
}
