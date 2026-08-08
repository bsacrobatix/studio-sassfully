/**
 * stage — validator
 *
 * Two passes over the data, no rendering and no dependencies:
 *
 *   validateCast(cast)          structural checks on a cast library
 *   validateScene(scene, cast)  structural + semantic checks on a stage scene
 *
 * The structural half overlaps the `stage` branch of src/schema.js (which ajv
 * enforces for the deck as a whole) and re-states it here so the runtime can be
 * used on its own — in a browser, a webview, or a bundled file with no ajv. The
 * semantic half is everything a schema cannot say: who is on stage, who is
 * speaking, whether a character has the state a beat asks for, whether two
 * characters end a beat standing in the same place.
 *
 * Findings are `{ level: 'error'|'warn'|'info', path, message }`. Errors mean
 * either the scene will not play correctly, or the cast art is geometrically
 * broken in a way that has shipped before and must gate a build (hair
 * blindfolding a face, a limb swung across it — see the hair/arm checks
 * below); warnings mean it will play but probably looks wrong in some lesser
 * way.
 */

import { resolveCast, rosterOf, narrationKey, beatText, beatVoice } from './engine.mjs';
import { bubbleMetrics, BUBBLE_TARGET_LINES, PROP_DEFAULT_SIZE } from './render.mjs';

const DIRECTIVE_KEYS = new Set(['who', 'at', 'y', 'face', 'state', 'enter', 'exit', 'move', 'jump', 'to']);
const SIDES = new Set(['left', 'right']);
const MAX_ROT = 135;          // a joint past this reads as a broken rig, not a pose
const SAFE_MARGIN = 4;        // units from the frame edge
const MIN_GAP = 9;            // units between two standing characters
const HEIGHT_BAND = 6;        // actors further apart in y than this cannot collide
const PLATFORM_TOLERANCE = 1.5; // units of slack between an actor's y and a platform's top surface
const HAIR_EPS = 0.15;        // ignore a hair fringe that only grazes the eye line

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/* ── tiny SVG-fragment geometry scan ─────────────────────────────────────────
 *
 * Not a real SVG parser — a regex/approximate scan over the shapes the cast
 * format actually uses (M/L/Q/C/A path commands in absolute coordinates,
 * circle, ellipse, rect). Good enough to answer "how far does this reach" and
 * "does this fall inside that circle", which is all the checks below need.
 */

function numAttr(attrs, name) {
  const m = new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(attrs);
  return m ? parseFloat(m[1]) : undefined;
}
function strAttr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

// How many interior points to sample along each Q/C bezier segment, in
// addition to its anchor/control points. A curve's extremum (the lowest point
// of a fringe's arc, say) is frequently *between* those literal coordinates —
// a wide single-segment curve whose control point sits just outside the x-span
// being tested can dip well inside it while never contributing a raw point
// there. Sampling the actual curve is what makes "does this reach into that
// x-span" answer for the curve as drawn, not just for its control cage.
const CURVE_SAMPLES = [0.25, 0.5, 0.75];

/** Absolute-command anchor/control points out of a `<path d="...">` string. */
function pathAbsPoints(d) {
  const pts = [];
  const re = /([MLQCA])([^MLQCAZmlqcaz]*)/g;
  let m;
  let cur = null; // current point, tracked across commands so Q/C can be sampled
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const nums = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number);
    if (cmd === 'A') {
      for (let i = 0; i + 6 < nums.length; i += 7) {
        cur = { x: nums[i + 5], y: nums[i + 6] };
        pts.push(cur);
      }
    } else if (cmd === 'Q') {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const c1 = { x: nums[i], y: nums[i + 1] };
        const end = { x: nums[i + 2], y: nums[i + 3] };
        pts.push(c1, end);
        if (cur) for (const t of CURVE_SAMPLES) {
          const u = 1 - t;
          pts.push({
            x: u * u * cur.x + 2 * u * t * c1.x + t * t * end.x,
            y: u * u * cur.y + 2 * u * t * c1.y + t * t * end.y,
          });
        }
        cur = end;
      }
    } else if (cmd === 'C') {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        const c1 = { x: nums[i], y: nums[i + 1] };
        const c2 = { x: nums[i + 2], y: nums[i + 3] };
        const end = { x: nums[i + 4], y: nums[i + 5] };
        pts.push(c1, c2, end);
        if (cur) for (const t of CURVE_SAMPLES) {
          const u = 1 - t;
          pts.push({
            x: u * u * u * cur.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
            y: u * u * u * cur.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
          });
        }
        cur = end;
      }
    } else {
      // M / L: every pair is an anchor, and each updates the current point.
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cur = { x: nums[i], y: nums[i + 1] };
        pts.push(cur);
      }
    }
  }
  return pts;
}

/**
 * Every point worth checking out of a raw SVG fragment: path anchors/controls,
 * plus the bounding-box points of every circle/ellipse/rect (their true
 * extremes, not just centres — a hand's fingertip is what reaches, not its
 * centre).
 */
function svgPrimitivePoints(svg) {
  const pts = [];
  if (!svg) return pts;
  for (const m of svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/gi)) pts.push(...pathAbsPoints(m[1]));
  for (const m of svg.matchAll(/<circle\b([^>]*)\/?>/gi)) {
    const a = m[1];
    const cx = numAttr(a, 'cx') ?? 0, cy = numAttr(a, 'cy') ?? 0, r = numAttr(a, 'r') ?? 0;
    pts.push({ x: cx - r, y: cy }, { x: cx + r, y: cy }, { x: cx, y: cy - r }, { x: cx, y: cy + r });
  }
  for (const m of svg.matchAll(/<ellipse\b([^>]*)\/?>/gi)) {
    const a = m[1];
    const cx = numAttr(a, 'cx') ?? 0, cy = numAttr(a, 'cy') ?? 0, rx = numAttr(a, 'rx') ?? 0, ry = numAttr(a, 'ry') ?? 0;
    pts.push({ x: cx - rx, y: cy }, { x: cx + rx, y: cy }, { x: cx, y: cy - ry }, { x: cx, y: cy + ry });
  }
  for (const m of svg.matchAll(/<rect\b([^>]*)\/?>/gi)) {
    const a = m[1];
    const x = numAttr(a, 'x') ?? 0, y = numAttr(a, 'y') ?? 0, w = numAttr(a, 'width') ?? 0, h = numAttr(a, 'height') ?? 0;
    pts.push({ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h });
  }
  return pts;
}

// The shared "human" plan (mongodb + romeo-juliet casts) draws its head as a
// circle centred (0,-16.6) r=3.15, eyes at y=-17.3, mouth at y=-14.9. These
// constants describe that shipped plan and are only a fallback for a plan
// whose head part is missing or shaped too differently to read eyes from.
const FALLBACK_HEAD = { x: 0, y: -16.6, r: 3.15 };
const FALLBACK_EYE = { y: -17.3, xMin: -2.4, xMax: 2.4 };
const FALLBACK_MOUTH_Y = -14.9;

/** The plan's head circle: its largest `<circle>`, or the fallback above. */
function deriveHeadCircle(plan) {
  const headSvg = plan?.parts?.head?.svg;
  if (!headSvg) return FALLBACK_HEAD;
  let best = null;
  for (const m of headSvg.matchAll(/<circle\b([^>]*)\/?>/gi)) {
    const a = m[1];
    const cx = numAttr(a, 'cx'), cy = numAttr(a, 'cy'), rr = numAttr(a, 'r');
    if (isNum(cx) && isNum(cy) && isNum(rr) && (!best || rr > best.r)) best = { x: cx, y: cy, r: rr };
  }
  return best ?? FALLBACK_HEAD;
}

/**
 * The plan's eye line: the two small ink-filled circles in the head part's
 * own svg (the pupils), or the fallback constants above.
 */
function deriveEyeLine(plan) {
  const headSvg = plan?.parts?.head?.svg;
  if (!headSvg) return FALLBACK_EYE;
  const eyes = [...headSvg.matchAll(/<circle\b([^>]*)\/?>/gi)]
    .map((m) => m[1])
    .map((a) => ({ cx: numAttr(a, 'cx'), cy: numAttr(a, 'cy'), r: numAttr(a, 'r'), fill: strAttr(a, 'fill') }))
    .filter((c) => c.fill === '{{ink}}' && isNum(c.cx) && isNum(c.cy) && isNum(c.r) && c.r > 0 && c.r < 1);
  if (eyes.length < 2) return FALLBACK_EYE;
  eyes.sort((a, b) => a.cx - b.cx);
  const y = eyes.reduce((s, e) => s + e.cy, 0) / eyes.length;
  const xs = eyes.flatMap((e) => [e.cx - e.r, e.cx + e.r]);
  return { y, xMin: Math.min(...xs), xMax: Math.max(...xs) };
}

/**
 * The plan's mouth line: the y-pivot of its `mouth` part (parented to
 * `head`, so this is already in the head's own coordinate space — the same
 * space `deriveEyeLine`'s eye circles live in), or the fallback constant
 * above. Used as the lower boundary of `hairEyeIntrusion`'s eye-covering
 * check — see that function's comment for why.
 */
function deriveMouthLine(plan) {
  const y = plan?.parts?.mouth?.pivot?.[1];
  return isNum(y) ? y : FALLBACK_MOUTH_Y;
}

/**
 * How far below the eye line (within the eyes' own x-span) a hair fragment
 * reaches, or `null` if it stays clear. A bun beside the face is out of the
 * eyes' x-span and does not count, however low it sits.
 *
 * The eyes' x-span is derived from the "human" plan's eye circles and is
 * *asymmetric* (`x: [0.13, 2.42]` for the shared plan) because the head is
 * drawn in right-facing profile, not head-on. A beard is, by construction,
 * centred under the chin and sits inside that same x-band while reaching
 * well below the eye line — with no other signal, this check cannot tell a
 * legitimate chin beard from hair that actually covers the eyes (this
 * shipped as a real false positive: hrothgar and hygelac in
 * corpus/beowulf/decomp/bible.json both had their beards deleted because of
 * it — see the "restores hrothgar/hygelac's beard" regression test).
 *
 * The fix is a second boundary, `mouthY`: geometry more than `HAIR_EPS`
 * below the eye line but at-or-below the mouth line (`y >= mouthY`, i.e.
 * mouth-height or lower — jaw/chin/beard territory) is exempt from this
 * check entirely, on the anatomical grounds that hair whose *only* in-band
 * presence is at-or-below the mouth cannot be covering the eyes — the mouth
 * is itself ~2.4 units below the eye line, so anything at or past it reads
 * as beard/chin, not fringe. This is deliberately a per-point cutoff, not a
 * "the fragment touches beard territory so skip the whole thing" exemption:
 * a fringe that descends from the crown through the eye line and continues
 * on down past the mouth still trips this check on its eye-to-mouth-line
 * portion, which is never exempted. (An alternative considered was
 * requiring flagged geometry to be *contiguous* with hair drawn above the
 * eye line — hair covering the eyes descends from the crown, a beard does
 * not. Rejected in favor of the mouth-line cutoff: this scanner only
 * approximates SVG geometry (see the module comment) and has no reliable
 * notion of path contiguity beyond "same `<path>` element," which would
 * both under- and over-fire on multi-subpath fragments; the mouth-line
 * cutoff needs no such notion and is provably safe by the anatomy alone.)
 */
function hairEyeIntrusion(hairSvg, eye, mouthY) {
  let maxY = -Infinity;
  for (const pt of svgPrimitivePoints(hairSvg)) {
    if (pt.x < eye.xMin || pt.x > eye.xMax) continue;
    if (pt.y >= mouthY) continue; // at/below the mouth: chin/beard territory, not eye-covering
    if (pt.y > maxY) maxY = pt.y;
  }
  if (maxY === -Infinity) return null;
  const depth = maxY - eye.y;
  return depth > HAIR_EPS ? depth : null;
}

/**
 * Local (pivot-relative) "reach" circles a part's own svg draws: a real
 * `<circle>` element (e.g. a hand) keeps its true centre and radius, so it can
 * be tested against the head as circle-vs-circle rather than collapsed to a
 * single edge point. Every other primitive (rect corners, ellipse extremes,
 * path anchors) contributes as a zero-radius point.
 *
 * This replaces an earlier "farthest single point from the pivot" heuristic,
 * which for a hand-tipped limb picked the far edge of the hand circle — a
 * hand-radius *beyond* the hand's own centre, on the side pointing away from
 * the pivot. That point can clear the head circle by inches while the hand
 * itself is genuinely overlapping the face; testing the hand as a circle
 * (centre + its own radius) is what actually answers "does the drawn limb
 * touch the head circle at this pose".
 */
function limbCircles(svg, pivot) {
  const out = [];
  if (!svg) return out;
  for (const m of svg.matchAll(/<circle\b([^>]*)\/?>/gi)) {
    const a = m[1];
    const cx = numAttr(a, 'cx') ?? 0, cy = numAttr(a, 'cy') ?? 0, r = numAttr(a, 'r') ?? 0;
    out.push({ x: cx - pivot[0], y: cy - pivot[1], r });
  }
  const rest = svg.replace(/<circle\b[^>]*\/?>/gi, '');
  for (const pt of svgPrimitivePoints(rest)) out.push({ x: pt.x - pivot[0], y: pt.y - pivot[1], r: 0 });
  return out;
}

/** Rotate a pivot-relative point by `deg` about `pivot` — same matrix as the SVG `rotate()` transform. */
function rotateAbout(pt, pivot, deg) {
  const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  return { x: pivot[0] + pt.x * c - pt.y * s, y: pivot[1] + pt.x * s + pt.y * c };
}

class Report {
  constructor() { this.findings = []; }
  err(path, message) { this.findings.push({ level: 'error', path, message }); }
  warn(path, message) { this.findings.push({ level: 'warn', path, message }); }
  info(path, message) { this.findings.push({ level: 'info', path, message }); }
  get errors() { return this.findings.filter((f) => f.level === 'error'); }
  get warnings() { return this.findings.filter((f) => f.level === 'warn'); }
}

/* ── cast ─────────────────────────────────────────────────────────────────── */

export function validateCast(cast, r = new Report()) {
  if (!cast || typeof cast !== 'object') { r.err('cast', 'not an object'); return r; }
  if (!Array.isArray(cast.characters) || !cast.characters.length) {
    r.err('cast.characters', 'must be a non-empty array');
    return r;
  }

  for (const [name, plan] of Object.entries(cast.plans ?? {})) {
    const at = `cast.plans.${name}`;
    if (!isNum(plan?.size?.w) || !isNum(plan?.size?.h)) r.err(`${at}.size`, 'needs numeric w and h');
    const parts = plan?.parts ?? {};
    if (!Object.keys(parts).length) r.err(`${at}.parts`, 'no parts');
    for (const [pn, p] of Object.entries(parts)) {
      if (!Array.isArray(p.pivot) || p.pivot.length !== 2 || !p.pivot.every(isNum))
        r.err(`${at}.parts.${pn}.pivot`, 'must be [x, y]');
      if (!isStr(p.svg)) r.err(`${at}.parts.${pn}.svg`, 'missing SVG fragment');
      if (p.parent != null) {
        if (!(p.parent in parts)) r.err(`${at}.parts.${pn}.parent`, `unknown part "${p.parent}"`);
        else if (parts[p.parent].parent != null)
          r.err(`${at}.parts.${pn}.parent`, 'only one level of nesting is supported');
      }
    }
    for (const n of plan?.order ?? []) if (!(n in parts)) r.err(`${at}.order`, `unknown part "${n}"`);
    const rooted = Object.entries(parts).filter(([, p]) => p.parent == null).map(([n]) => n);
    for (const n of rooted) if (!(plan.order ?? []).includes(n)) r.warn(`${at}.order`, `part "${n}" is never drawn`);

    // Geometry for the checks below: the head circle a limb must not swing
    // into, and each arm-like part's own reach circles relative to its pivot.
    const headCircle = deriveHeadCircle(plan);
    const armReach = {};
    for (const [pn, pdef] of Object.entries(parts))
      if (/arm/i.test(pn) && Array.isArray(pdef.pivot) && pdef.pivot.length === 2 && isStr(pdef.svg))
        armReach[pn] = limbCircles(pdef.svg, pdef.pivot);

    const posedAnywhere = new Set();
    for (const [sn, st] of Object.entries(plan?.states ?? {})) {
      const sat = `${at}.states.${sn}`;
      if (!Array.isArray(st.poses) || !st.poses.length) { r.err(`${sat}.poses`, 'must be a non-empty array'); continue; }
      if (st.loop != null && !(isNum(st.loop) && st.loop > 0)) r.err(`${sat}.loop`, 'must be a positive number of seconds');
      st.poses.forEach((pose, i) => {
        for (const [pn, v] of Object.entries(pose)) {
          posedAnywhere.add(pn);
          if (!(pn in parts)) { r.err(`${sat}.poses[${i}]`, `unknown part "${pn}"`); continue; }
          // Joint limits: an implausible pose is not a discontinuity, so nothing
          // else catches it — but it renders as a snapped limb.
          if (v.rot != null && Math.abs(v.rot) > MAX_ROT)
            r.warn(`${sat}.poses[${i}].${pn}.rot`, `${v.rot}° exceeds the ±${MAX_ROT}° joint limit`);
          for (const k of ['sx', 'sy'])
            if (v[k] != null && !(v[k] > 0.05 && v[k] <= 2))
              r.warn(`${sat}.poses[${i}].${pn}.${k}`, `scale ${v[k]} is outside (0.05, 2]`);
          // A hand/forearm swung across the character's own face: rotate each
          // of the part's reach circles about its pivot and see if any of
          // them overlaps the head circle (centre-to-centre distance closer
          // than the sum of the two radii).
          // This is an error, not a warning: it exists specifically to catch
          // a defect class that has already shipped once (Romeo's forearm
          // across his own chin), it is exercised by adversarial tests
          // confirming no false positives on the shared plan's real gesture
          // poses, and a check nothing ever gates on is a check nobody turns
          // on.
          if (armReach[pn]?.length && v.rot != null) {
            const overlaps = armReach[pn].some((c) => {
              const p = rotateAbout(c, parts[pn].pivot, v.rot);
              const dist = Math.hypot(p.x - headCircle.x, p.y - headCircle.y);
              return dist < headCircle.r + c.r;
            });
            if (overlaps)
              r.err(`${sat}.poses[${i}].${pn}`, `"${pn}" swings across the face in "${sn}" pose ${i}`);
          }
        }
      });
    }

    // An unposed mouth renders at the identity pose (full open) — worth
    // knowing about even though the engine now defaults it to closed when a
    // beat is not speaking, because it means no state gives this plan an
    // authored expression at all.
    if ('mouth' in parts && !posedAnywhere.has('mouth'))
      r.info(`${at}.parts.mouth`, `plan "${name}" never poses "mouth" in any state — non-speaking characters render the engine default rather than an authored expression`);
  }

  const seen = new Set();
  cast.characters.forEach((c, i) => {
    const at = `cast.characters[${i}]`;
    if (!isStr(c.id)) { r.err(`${at}.id`, 'missing id'); return; }
    if (seen.has(c.id)) r.err(`${at}.id`, `duplicate character id "${c.id}"`);
    seen.add(c.id);
    if (c.floats != null && typeof c.floats !== 'boolean') r.err(`${at}.floats`, 'must be a boolean');
    if (c.voice) {
      if (!isStr(c.voice.edge)) r.err(`${at}.voice.edge`, 'missing Edge TTS voice name');
      for (const [k, re] of [['rate', /^[+-]\d+%$/], ['pitch', /^[+-]\d+Hz$/]])
        if (c.voice[k] != null && !re.test(c.voice[k]))
          r.err(`${at}.voice.${k}`, `"${c.voice[k]}" is not a valid edge-tts ${k} (e.g. ${k === 'rate' ? '"-6%"' : '"+10Hz"'})`);
    }

    if (c.style === 'pixel') {
      const a = c.atlas;
      if (!a) { r.err(`${at}.atlas`, 'pixel character needs an atlas'); return; }
      if (!Array.isArray(a.frames) || !a.frames.length) { r.err(`${at}.atlas.frames`, 'no frames'); return; }
      const w = a.frames[0][0]?.length, h = a.frames[0].length;
      a.frames.forEach((fr, fi) => {
        if (fr.length !== h || fr.some((row) => row.length !== w))
          r.err(`${at}.atlas.frames[${fi}]`, `not ${w}×${h} — every frame must be the same grid`);
        for (const row of fr) for (const ch of row)
          if (!(ch in a.palette)) r.err(`${at}.atlas.palette`, `frame ${fi} uses "${ch}", which is not in the palette`);
      });
      for (const [ti, tag] of (a.frameTags ?? []).entries()) {
        if (!isStr(tag.name)) r.err(`${at}.atlas.frameTags[${ti}].name`, 'missing');
        if (!(isNum(tag.from) && isNum(tag.to) && tag.from >= 0 && tag.to < a.frames.length && tag.from <= tag.to))
          r.err(`${at}.atlas.frameTags[${ti}]`, `range ${tag.from}–${tag.to} is outside 0–${a.frames.length - 1}`);
        if (!(isNum(tag.duration) && tag.duration > 0)) r.err(`${at}.atlas.frameTags[${ti}].duration`, 'must be > 0');
      }
      const tagNames = new Set((a.frameTags ?? []).map((t) => t.name));
      for (const [sn, tn] of Object.entries(c.states ?? {}))
        if (!tagNames.has(tn)) r.err(`${at}.states.${sn}`, `maps to frameTag "${tn}", which does not exist`);
      if (!c.states?.idle) r.warn(`${at}.states`, 'no "idle" state — it is the fallback for every unmapped state');
    } else {
      const plan = cast.plans?.[c.plan];
      if (!isStr(c.plan)) r.err(`${at}.plan`, 'missing body plan');
      else if (!plan) r.err(`${at}.plan`, `unknown plan "${c.plan}"`);
      if (!c.palette || typeof c.palette !== 'object') r.err(`${at}.palette`, 'missing palette');
      else {
        const tokens = new Set();
        for (const p of Object.values(plan?.parts ?? {}))
          for (const m of String(p.svg).matchAll(/\{\{(\w+)\}\}/g)) tokens.add(m[1]);
        for (const m of String(c.hair ?? '').matchAll(/\{\{(\w+)\}\}/g)) tokens.add(m[1]);
        tokens.delete('hair');
        for (const tk of tokens)
          if (!(tk in c.palette)) r.err(`${at}.palette`, `plan "${c.plan}" uses {{${tk}}}, which this palette does not define`);
      }
      // A hand-authored hair fragment that dips into the eyes' own x-span,
      // below the eye line — the character reads as blindfolded.
      //
      // This is an error, not a warning: it exists specifically to catch a
      // defect class that has already shipped twice (dana and juliet both
      // shipped genuinely blindfolded), it is exercised by adversarial tests
      // confirming no false positives on hair that merely grazes or sits
      // beside the face, and a check nothing ever gates on is a check nobody
      // turns on.
      if (isStr(c.hair) && plan) {
        const eye = deriveEyeLine(plan);
        const mouthY = deriveMouthLine(plan);
        const depth = hairEyeIntrusion(c.hair, eye, mouthY);
        if (depth != null)
          r.err(`${at}.hair`, `"${c.id}"'s hair covers the eyes (reaches ${depth.toFixed(1)} units below the eye line)`);
      }
    }
  });
  return r;
}

/* ── props ────────────────────────────────────────────────────────────────── */

// Derived from render.mjs's PROP_DEFAULT_SIZE (the renderer's own default-size
// table) rather than restated here, so a new prop kind only has to be taught
// to the renderer and the schema enum in src/schema.js — not a third place.
// "shape" is excluded from the width table below: its {w:0,h:0} default means
// "no default, an explicit svg is required," not an actual size.
const PROP_KINDS = new Set(Object.keys(PROP_DEFAULT_SIZE));
const PROP_DEFAULT_W = Object.fromEntries(
  Object.entries(PROP_DEFAULT_SIZE).filter(([k]) => k !== 'shape').map(([k, sz]) => [k, sz.w])
);

/**
 * Structural checks on `scene.stage.props`, plus the x-spans the beat-level
 * checks in `validateBeats` need: standable `platform` tops (including the
 * implicit balcony-preset ledge) and `layer:"front"` occluders.
 */
function validateProps(S, r) {
  const platforms = [];
  const fronts = [];
  if (S.backdrop === 'balcony' && S.units)
    platforms.push({ xMin: S.units.w - 48, xMax: S.units.w - 4, y: 20, id: '(balcony ledge)' });

  const props = S.props;
  if (props == null) return { platforms, fronts };
  if (!Array.isArray(props)) { r.err('scene.stage.props', 'must be an array'); return { platforms, fronts }; }

  const ids = new Set();
  props.forEach((p, i) => {
    const at = `scene.stage.props[${i}]`;
    if (!isStr(p.kind) || !PROP_KINDS.has(p.kind))
      r.err(`${at}.kind`, `${JSON.stringify(p.kind)} is not one of ${[...PROP_KINDS].join(', ')}`);
    if (!isNum(p.x)) r.err(`${at}.x`, 'must be a number');
    for (const k of ['w', 'h', 'y', 'opacity'])
      if (p[k] != null && !isNum(p[k])) r.err(`${at}.${k}`, 'must be a number');
    if (p.kind === 'shape' && !isStr(p.svg)) r.err(`${at}.svg`, 'kind "shape" needs an svg fragment');
    if (p.id != null) {
      if (ids.has(p.id)) r.err(`${at}.id`, `duplicate prop id "${p.id}"`);
      ids.add(p.id);
    }
    if (p.layer != null && p.layer !== 'back' && p.layer !== 'front')
      r.err(`${at}.layer`, `"${p.layer}" must be "back" or "front"`);

    if (!isNum(p.x)) return;
    const w = isNum(p.w) ? p.w : PROP_DEFAULT_W[p.kind];
    const y = isNum(p.y) ? p.y : 0;
    const label = p.id ?? `props[${i}]`;
    if (w != null && S.units) {
      const xMin = p.x - w / 2, xMax = p.x + w / 2;
      if (xMax < 0 || xMin > S.units.w) r.warn(at, `prop "${label}" lies entirely outside the stage box`);
    }
    if (p.kind === 'platform' && w != null) platforms.push({ xMin: p.x - w / 2, xMax: p.x + w / 2, y, id: label });
    if (p.layer === 'front' && w != null) fronts.push({ xMin: p.x - w / 2, xMax: p.x + w / 2, y, id: label });
  });

  return { platforms, fronts };
}

/* ── scene ────────────────────────────────────────────────────────────────── */

function validateBeats(scene, chars, roster, r, propGeom) {
  const known = new Set(roster);
  const onstage = new Set();
  const pos = {};
  const overlaps = new Map();
  const placed = new Set();
  const elevated = new Map();  // id -> { y, beats } — ends a beat above y=0 with nothing under them
  const hidden = new Map();    // "id|propId" -> { id, prop, beats } — ends a beat behind a front prop
  const platforms = propGeom?.platforms ?? [];
  const fronts = propGeom?.fronts ?? [];

  (scene.beats ?? []).forEach((b, i) => {
    const at = `beats[${i}]`;
    if (b.speaker != null && !isStr(b.speaker)) r.err(`${at}.speaker`, 'must be a character id');
    if (b.speaker && !isStr(b.line)) r.err(`${at}.line`, 'a beat with a speaker needs a line');
    if (b.line && !b.speaker) r.err(`${at}.speaker`, 'a beat with a line needs a speaker');
    if (b.narration != null && !isStr(b.narration)) r.err(`${at}.narration`, 'must be a string');
    if (b.line && b.narration) r.err(at, 'a beat is either dialogue or narration, not both');
    // A line long enough to blow past the bubble's target line count wraps
    // into a bubble tall enough to swallow the frame it's meant to share with
    // the cast — the exact shape of the bug that motivated this check.
    if (isStr(b.line)) {
      const { lines, h } = bubbleMetrics(b.line);
      if (lines.length > BUBBLE_TARGET_LINES)
        r.warn(`${at}.line`, `this line wraps to ${lines.length} lines (~${h.toFixed(0)} units tall) — the bubble will dominate the frame; split it across two beats`);
    }
    if (b.dur != null && !(isNum(b.dur) && b.dur > 0)) r.err(`${at}.dur`, 'must be a positive number of seconds');
    if (!b.line && !b.narration && b.dur == null) r.warn(at, 'no line and no narration — needs an explicit "dur"');

    if (b.speaker && !known.has(b.speaker)) r.err(`${at}.speaker`, `"${b.speaker}" is not in the roster`);
    if (b.speaker && known.has(b.speaker) && !onstage.has(b.speaker) &&
        !(b.act ?? []).some((d) => d.who === b.speaker && (d.at != null || d.enter)))
      r.err(`${at}.speaker`, `"${b.speaker}" speaks but is not on stage`);

    if (b.act != null && !Array.isArray(b.act)) { r.err(`${at}.act`, 'must be an array of directives'); return; }
    (b.act ?? []).forEach((d, j) => {
      const dat = `${at}.act[${j}]`;
      for (const k of Object.keys(d)) if (!DIRECTIVE_KEYS.has(k)) r.warn(`${dat}.${k}`, 'unknown directive key — ignored');
      if (!isStr(d.who)) { r.err(`${dat}.who`, 'missing'); return; }
      if (!known.has(d.who)) { r.err(`${dat}.who`, `"${d.who}" is not in the roster`); return; }

      const c = chars[d.who];
      if (d.state != null) {
        if (!isStr(d.state)) r.err(`${dat}.state`, 'must be a string');
        else if (c && !(c.states && d.state in c.states)) r.err(`${dat}.state`, `"${d.who}" has no state "${d.state}"`);
      }
      if (d.face != null && !SIDES.has(d.face)) r.err(`${dat}.face`, 'must be "left" or "right"');
      if (d.at != null && !isNum(d.at)) r.err(`${dat}.at`, 'must be a number in stage units');
      if (d.y != null && !isNum(d.y)) r.err(`${dat}.y`, 'must be a number in stage units');
      if (d.enter != null) {
        if (!SIDES.has(d.enter)) r.err(`${dat}.enter`, 'must be "left" or "right"');
        if (!isNum(d.to)) r.err(`${dat}.to`, 'an "enter" needs a numeric "to" mark');
      }
      if (d.exit != null && !SIDES.has(d.exit)) r.err(`${dat}.exit`, 'must be "left" or "right"');
      if (d.move != null && !isNum(d.move?.to)) r.err(`${dat}.move.to`, 'must be a number');
      if (d.jump != null) {
        if (!isNum(d.jump.to)) r.err(`${dat}.jump.to`, 'must be a number');
        if (d.jump.height != null && !(isNum(d.jump.height) && d.jump.height > 0))
          r.err(`${dat}.jump.height`, 'must be a positive number');
      }
      if (d.to != null && d.enter == null) r.warn(`${dat}.to`, '"to" only applies to "enter" — use move:{to} or at');

      if (d.at != null || d.enter) { onstage.add(d.who); placed.add(d.who); }
      if (d.exit) onstage.delete(d.who);
      if (d.at != null) pos[d.who] = { x: d.at, y: d.y ?? 0 };
      if (d.enter && isNum(d.to)) pos[d.who] = { x: d.to, y: d.y ?? 0 };
      if (d.move && isNum(d.move.to)) pos[d.who] = { x: d.move.to, y: d.y ?? 0 };
      if (d.jump && isNum(d.jump.to)) pos[d.who] = { x: d.jump.to, y: 0 };
      const p = pos[d.who];
      if (p && !d.exit && (p.x < SAFE_MARGIN || p.x > scene.stage.units.w - SAFE_MARGIN))
        r.warn(dat, `"${d.who}" ends at x=${p.x}, outside the safe stage area`);
    });

    // Collision at beat end. The same pair across consecutive beats is one
    // finding, not one per beat, and different heights are not a collision.
    const here = Object.entries(pos).filter(([id]) => onstage.has(id));
    for (let a = 0; a < here.length; a++) for (let b2 = a + 1; b2 < here.length; b2++) {
      const [idA, pA] = here[a], [idB, pB] = here[b2];
      if (Math.abs(pA.y - pB.y) > HEIGHT_BAND) continue;
      const gap = Math.abs(pA.x - pB.x);
      if (gap >= MIN_GAP) continue;
      const key = `${idA}|${idB}`;
      if (!overlaps.has(key)) overlaps.set(key, { a: idA, b: idB, gap, beats: [] });
      overlaps.get(key).beats.push(i);
    }

    // Elevated staging: an actor above y=0 needs a platform (declared, or the
    // implicit balcony-preset ledge) whose top surface is close enough in y
    // and whose x-span contains them — otherwise they are standing on air.
    for (const [id, p] of here) {
      if (p.y > 0 && !chars[id]?.floats) {
        const supported = platforms.some((pl) => Math.abs(pl.y - p.y) <= PLATFORM_TOLERANCE && p.x >= pl.xMin && p.x <= pl.xMax);
        if (!supported) {
          if (!elevated.has(id)) elevated.set(id, { y: p.y, beats: [] });
          elevated.get(id).beats.push(i);
        }
      }
      for (const f of fronts) {
        if (p.x < f.xMin || p.x > f.xMax || Math.abs(p.y - f.y) > HEIGHT_BAND) continue;
        const key = `${id}|${f.id}`;
        if (!hidden.has(key)) hidden.set(key, { id, prop: f.id, beats: [] });
        hidden.get(key).beats.push(i);
      }
    }
  });

  for (const o of overlaps.values()) {
    const span = o.beats.length > 1 ? `beats[${o.beats[0]}..${o.beats[o.beats.length - 1]}]` : `beats[${o.beats[0]}]`;
    r.warn(span, `"${o.a}" and "${o.b}" overlap (${o.gap.toFixed(0)} units apart)`);
  }
  for (const [id, info] of elevated) {
    const span = info.beats.length > 1 ? `beats[${info.beats[0]}..${info.beats[info.beats.length - 1]}]` : `beats[${info.beats[0]}]`;
    r.warn(span, `"${id}" stands at y=${info.y} with nothing under them`);
  }
  for (const info of hidden.values()) {
    const span = info.beats.length > 1 ? `beats[${info.beats[0]}..${info.beats[info.beats.length - 1]}]` : `beats[${info.beats[0]}]`;
    r.warn(span, `"${info.id}" ends up hidden behind prop "${info.prop}" (layer: front)`);
  }
  for (const id of roster) if (!placed.has(id)) r.warn(`roster`, `"${id}" is never placed with "at" or "enter"`);
}

export function validateScene(scene, cast, audio, r = new Report()) {
  if (!scene || typeof scene !== 'object') { r.err('scene', 'not an object'); return r; }
  if (scene.type !== 'stage') r.err('scene.type', `expected "stage", got ${JSON.stringify(scene.type)}`);

  const S = scene.stage;
  if (!S) r.err('scene.stage', 'missing');
  else {
    if (!(isNum(S.units?.w) && S.units.w > 0) || !(isNum(S.units?.h) && S.units.h > 0))
      r.err('scene.stage.units', 'needs positive numeric w and h');
    if (!isNum(S.ground)) r.err('scene.stage.ground', 'must be a number');
    else if (S.units && (S.ground <= 0 || S.ground >= S.units.h))
      r.err('scene.stage.ground', `${S.ground} is outside the stage height (0..${S.units?.h})`);
  }
  if (!Array.isArray(scene.beats) || !scene.beats.length) r.err('scene.beats', 'must be a non-empty array');

  const castOk = validateCast(cast, r).errors.length === 0;
  if (!castOk || !S || !Array.isArray(scene.beats)) return r;

  const chars = resolveCast(cast);
  const roster = rosterOf(scene, cast);
  for (const id of roster) if (!chars[id]) r.err('scene.roster', `no character "${id}" in the cast library`);
  if (r.errors.length) return r;

  const propGeom = validateProps(S, r);
  validateBeats(scene, chars, roster, r, propGeom);

  // Voices: distinct speakers with one voice is the single fastest way to make
  // four characters sound like one person.
  const speakers = new Set(scene.beats.map((b) => b.speaker).filter(Boolean));
  const voices = new Set([...speakers].map((id) => chars[id]?.voice?.edge).filter(Boolean));
  for (const id of speakers) if (!chars[id]?.voice) r.err(`cast.characters`, `"${id}" speaks but has no voice`);
  if (voices.size && voices.size < speakers.size)
    r.warn('cast', `${speakers.size} speaking characters share only ${voices.size} distinct voices`);
  if (scene.beats.some((b) => b.narration) && !scene.narrator) r.err('scene.narrator', 'narration beats need a narrator voice');

  // Audio coverage — informational: a missing clip degrades to the estimate.
  if (audio) {
    const clips = audio.clips ?? audio;
    const want = new Set(), missing = [];
    for (const b of scene.beats) {
      const v = beatVoice(b, chars, scene.narrator), text = beatText(b);
      if (!v || !text) continue;
      const k = narrationKey(text, v);
      want.add(k);
      if (!clips[k]) missing.push(b);
    }
    if (missing.length) r.warn('audio', `${missing.length}/${want.size} beats have no clip — run \`stage build-audio\``);
    else r.info('audio', `${want.size} beats timed from measured audio`);
    const orphans = Object.keys(clips).filter((k) => !want.has(k));
    if (orphans.length) r.info('audio', `${orphans.length} unused clip(s) — dropped by the next \`stage build-audio\` unless --keep-unused`);
  }
  return r;
}

export function formatFindings(findings) {
  const icon = { error: '✖', warn: '▲', info: '·' };
  if (!findings.length) return '✔ no issues found';
  return findings.map((f) => `${icon[f.level]} ${f.path}: ${f.message}`).join('\n');
}

export { Report };
