/**
 * SLIDEY — stage scene player (browser)
 *
 * Mounts a stage scene into a host element and drives it. The player owns three
 * things and nothing else: a clock, a set of <audio> elements, and the DOM
 * nodes it built from render.stageMarkup(). Everything about *what the frame
 * looks like* comes from the engine, which never touches the DOM.
 *
 * Because engine.stageStateAt() replays from beat 0 on every call, seeking is
 * exact and pause/resume cannot drift — the player never accumulates state it
 * would have to unwind.
 *
 *   const p = mountStagePlayer(el, { scene, chars, roster, timeline });
 *   p.play(); p.seek(12.5); p.stepBeat(+1); p.destroy();
 */

import { stageStateAt, actorTransforms, pixelFrameAt, clamp } from './engine.mjs';
import {
  stageMarkup, bubbleAt, bubbleTspans, captionAt, captionTspans, pixelFrameSvg, ids,
} from './render.mjs';

const SVGNS = 'http://www.w3.org/2000/svg';

export function mountStagePlayer(host, opts) {
  const {
    scene, chars, roster, timeline, prefix = 'st', autoplay = false,
    onFrame = null, onBeat = null, onEnd = null,
  } = opts;
  const audio = opts.audio ?? scene.audio ?? null;
  const clips = audio?.clips ?? audio ?? {};
  const I = ids(prefix);

  /* ── DOM: built once, then only attributes change ───────────────────────── */
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${scene.stage.units.w} ${scene.stage.units.h}`);
  svg.setAttribute('class', 'slidey-stage');
  svg.innerHTML = stageMarkup(scene, chars, roster, { prefix });
  host.appendChild(svg);

  const nodes = {};
  for (const id of roster) {
    const c = chars[id];
    if (!c) continue;
    const g = svg.querySelector(`#${CSS.escape(I.actor(id))}`);
    if (!g) continue;
    const parts = {};
    if (c.style === 'vector')
      for (const name of Object.keys(c.parts)) parts[name] = svg.querySelector(`#${CSS.escape(I.part(id, name))}`);
    nodes[id] = {
      char: c, g,
      inner: svg.querySelector(`#${CSS.escape(I.inner(id))}`),
      pixel: c.style === 'pixel' ? svg.querySelector(`#${CSS.escape(I.pixel(id))}`) : null,
      parts, frame: -1,
    };
  }
  const bubble = svg.querySelector(`#${CSS.escape(I.bubble)}`);
  const brect = svg.querySelector(`#${CSS.escape(I.bubbleRect)}`);
  const btail = svg.querySelector(`#${CSS.escape(I.bubbleTail)}`);
  const btext = svg.querySelector(`#${CSS.escape(I.bubbleText)}`);
  const capg = svg.querySelector(`#${CSS.escape(I.caption)}`);
  const caprect = svg.querySelector(`#${CSS.escape(I.captionRect)}`);
  const captext = svg.querySelector(`#${CSS.escape(I.captionText)}`);

  /* ── audio: one element per distinct clip, preloaded ────────────────────── */
  // Clips are content-addressed, so two beats with the same line and voice
  // share one element — and an edited line simply has no clip rather than
  // playing the previous take.
  const els = {};
  for (const [key, rec] of Object.entries(clips)) {
    const el = new Audio(rec.a);
    el.preload = 'auto';
    els[key] = el;
  }
  let sounding = null;

  function silence() {
    if (!sounding) return;
    sounding.pause();
    sounding = null;
  }
  /** Start (or re-sync) the clip for the beat live at `t`. */
  function sound(beat, t, { seeking = false } = {}) {
    const el = beat?.key ? els[beat.key] : null;
    if (!el) { silence(); return; }
    const offset = clamp(t - beat.start, 0, Math.max(0, (beat.dur - timeline.tail) - 0.01));
    if (sounding !== el) { silence(); sounding = el; el.currentTime = offset; }
    else if (seeking || Math.abs(el.currentTime - offset) > 0.25) el.currentTime = offset;
    if (el.paused) el.play().catch(() => {});   // autoplay refusal until a gesture
  }

  /* ── the frame ──────────────────────────────────────────────────────────── */
  let t = 0, playing = false, raf = 0, wall = 0, lastBeat = null, until = Infinity;

  function draw(now) {
    const st = stageStateAt(scene, timeline, now, roster);
    for (const [id, n] of Object.entries(nodes)) {
      const a = st.actors[id];
      n.g.style.display = a.visible ? '' : 'none';
      if (!a.visible) continue;
      const tf = actorTransforms(n.char, a, now, scene.stage.ground);
      n.g.setAttribute('transform', tf.root);
      n.inner.setAttribute('transform', tf.inner);
      if (n.char.style === 'pixel') {
        const idx = pixelFrameAt(n.char, a.state, now);
        if (idx !== n.frame) { n.frame = idx; n.pixel.innerHTML = pixelFrameSvg(n.char, idx); }
        continue;
      }
      for (const [name, el] of Object.entries(n.parts)) el.setAttribute('transform', tf.parts[name]);
    }

    const bub = bubbleAt(scene, st, chars);
    if (bub) {
      brect.setAttribute('x', bub.x.toFixed(2));
      brect.setAttribute('y', bub.y.toFixed(2));
      brect.setAttribute('width', bub.w.toFixed(2));
      brect.setAttribute('height', bub.h.toFixed(2));
      btail.setAttribute('d', bub.tail);
      // The box tracks the actor every frame (they may be mid-`move`), so the
      // text must too — caching it per-beat left it stranded at the beat's
      // first-frame position while the box moved on.
      btext.innerHTML = bubbleTspans(bub);
      bubble.style.display = '';
    } else bubble.style.display = 'none';

    // Narrator caption. Geometry only changes when the text does (it is pinned
    // to the frame, not to an actor), but rewriting it costs nothing and keeps
    // this in the same shape as the bubble above.
    const cap = captionAt(scene, st);
    if (cap) {
      caprect.setAttribute('x', cap.x.toFixed(2));
      caprect.setAttribute('y', cap.y.toFixed(2));
      caprect.setAttribute('width', cap.w.toFixed(2));
      caprect.setAttribute('height', cap.h.toFixed(2));
      captext.innerHTML = captionTspans(cap);
      capg.style.display = '';
    } else capg.style.display = 'none';

    // The beat the frame just drew, reported once per transition. This is what
    // lets a host (the deck viewer) keep a step counter in step with a scene
    // that is running on its own clock, without polling.
    const bi = st.beat?.index ?? null;
    if (bi !== lastBeat) { lastBeat = bi; if (bi != null) onBeat?.(bi, st); }

    onFrame?.(st, now);
    return st;
  }

  function tick(ms) {
    if (!playing) return;
    const dt = wall ? (ms - wall) / 1000 : 0;
    wall = ms;
    t += dt;
    // `until` is how a host asks for one beat and no more (deck navigation
    // landing on a step). Without it the player ran on into the following
    // beats while the deck still believed it was parked on this one.
    const stop = Math.min(until, timeline.total);
    if (t >= stop) {
      t = stop;
      pause();
      draw(t);
      if (t >= timeline.total) onEnd?.();
      return;
    }
    const st = draw(t);
    if (st.beat) sound(st.beat, t);
    raf = requestAnimationFrame(tick);
  }

  function play(opts = {}) {
    // Cancel any rAF already in flight FIRST. Without this, a second play()
    // (the deck viewer issues one per navigation) starts a second tick loop on
    // the same `t`, so time runs at 2×, 3×, 4×… real speed — every extra loop
    // adds its own dt. The audible symptom is narration clips cut off and
    // stacking on each other as the player races through beats.
    cancelAnimationFrame(raf);
    if (t >= timeline.total) seek(0);
    until = Number.isFinite(opts.until) ? opts.until : Infinity;
    playing = true;
    wall = 0;
    const st = draw(t);
    if (st.beat) sound(st.beat, t, { seeking: true });
    raf = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    silence();
  }
  function seek(to) {
    t = clamp(to, 0, timeline.total);
    wall = 0;
    const st = draw(t);
    if (playing && st.beat) sound(st.beat, t, { seeking: true });
    else silence();
    return t;
  }
  function stepBeat(delta) {
    const cur = stageStateAt(scene, timeline, t, roster).beat?.index ?? 0;
    const next = clamp(cur + delta, 0, timeline.beats.length - 1);
    return seek(timeline.beats[next].start);
  }
  function destroy() {
    pause();
    for (const el of Object.values(els)) { el.pause(); el.src = ''; }
    svg.remove();
  }

  draw(0);
  if (autoplay) play();

  return {
    svg, play, pause, seek, stepBeat, draw, destroy,
    get time() { return t; },
    get playing() { return playing; },
    get duration() { return timeline.total; },
    get beat() { return stageStateAt(scene, timeline, t, roster).beat; },
  };
}
