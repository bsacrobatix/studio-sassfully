/**
 * stage — renderer
 *
 * Produces SVG *markup as a string*, with no DOM. Node uses it for stills
 * (contact sheet, PDF pages, tests); the browser player uses it once to build
 * the tree and then only rewrites the transform attributes it names here.
 *
 * All geometry comes from engine.actorTransforms — this module decides what the
 * markup looks like, never where anything is.
 */

import { actorTransforms, pixelFrameAt, stageStateAt, clamp } from './engine.mjs';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function wrap(text, max) {
  const words = String(text || '').split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) { out.push(line.trim()); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/* ── ids ──────────────────────────────────────────────────────────────────── */
export const ids = (prefix = 'st') => ({
  actor: (id) => `${prefix}-a-${id}`,
  inner: (id) => `${prefix}-i-${id}`,
  part: (id, part) => `${prefix}-p-${id}-${part}`,
  pixel: (id) => `${prefix}-x-${id}`,
  bubble: `${prefix}-bubble`,
  bubbleRect: `${prefix}-brect`,
  bubbleTail: `${prefix}-btail`,
  bubbleText: `${prefix}-btext`,
  caption: `${prefix}-cap`,
  captionRect: `${prefix}-crect`,
  captionText: `${prefix}-ctext`,
  grad: `${prefix}-wall`,
});

/* ── backdrop ─────────────────────────────────────────────────────────────── */
// The single source of truth for valid `stage.backdrop` values. Every other
// declaration site (src/schema.js's description, schemas/decomp-bible.schema.json's
// enum, docs/stage-scenes.md's table) either derives from this array or is
// checked against it by test/stage-backdrops.test.mjs — this repo has shipped
// three separate "value list restated in a second place, then drifted" bugs
// (prop kinds, scene types, and this one), so a new backdrop token belongs
// here first and everywhere else follows.
// PATCH(demo-stage): added 'transparent' — draws nothing at all, so the stage
// can sit as a see-through layer over live page content. Upstream 'none' still
// paints an opaque wall + floor. This is the only modification to this file;
// see ../VENDORED.md.
export const BACKDROPS = ['none', 'office', 'balcony', 'sky-day', 'sky-night', 'room', 'river', 'treeline', 'transparent'];

export function backdropSvg(S, prefix = 'st') {
  if (S.backdrop === 'transparent') return '';   // PATCH(demo-stage)
  const g = S.ground, W = S.units.w, H = S.units.h, gid = ids(prefix).grad;
  const wall =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#1a2133"/><stop offset="1" stop-color="#2a3346"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>` +
    `<rect y="${g}" width="${W}" height="${H - g}" fill="#232b3a"/>` +
    `<rect y="${g}" width="${W}" height="0.5" fill="#3d4a63"/>`;
  if (S.backdrop === 'none' || !S.backdrop) return wall;
  if (S.backdrop === 'balcony') return wall + balconySvg(S, prefix);
  if (S.backdrop === 'office') return wall + officeSvg(S, prefix);
  if (S.backdrop === 'sky-day') return skyDaySvg(S, prefix);
  if (S.backdrop === 'sky-night') return skyNightSvg(S, prefix);
  if (S.backdrop === 'room') return roomSvg(S, prefix);
  if (S.backdrop === 'river') return riverSvg(S, prefix);
  if (S.backdrop === 'treeline') return treelineSvg(S, prefix);
  return wall;
}

/** Windows, a blinking server rack, desks — the MongoDB demo's modern office.
 *  Split out of `backdropSvg()` unchanged so the period-neutral presets added
 *  alongside it (see below) have somewhere to live without this function
 *  growing past readable. */
function officeSvg(S, prefix = 'st') {
  const g = S.ground;
  const windows = [18, 52, 86].map((x) =>
    `<rect x="${x - 9}" y="6" width="18" height="12" rx="0.8" fill="#0e1626" stroke="#3d4a63" stroke-width="0.35"/>` +
    `<rect x="${x - 7.5}" y="7.5" width="15" height="9" fill="#1b3b57" opacity="0.7"/>`).join('');
  const rack =
    `<rect x="70" y="${g - 22}" width="12" height="22" rx="0.8" fill="#141b29" stroke="#3d4a63" stroke-width="0.35"/>` +
    Array.from({ length: 9 }, (_, i) =>
      `<rect x="71.2" y="${g - 20.6 + i * 2.3}" width="9.6" height="1.5" rx="0.3" fill="#1e2738"/>` +
      `<circle cx="79.6" cy="${g - 19.85 + i * 2.3}" r="0.32" fill="${i % 3 ? '#22d3a0' : '#ffb347'}"/>`).join('');
  const desks = [8, 46, 88].map((x) =>
    `<g opacity="0.55"><rect x="${x - 9}" y="${g - 9}" width="18" height="1.5" rx="0.5" fill="#3a4358"/>` +
    `<rect x="${x - 8}" y="${g - 7.5}" width="1.1" height="7.5" fill="#2c3346"/>` +
    `<rect x="${x + 7}" y="${g - 7.5}" width="1.1" height="7.5" fill="#2c3346"/>` +
    `<rect x="${x - 4.5}" y="${g - 14.5}" width="9" height="5.5" rx="0.6" fill="#1c2434" stroke="#3a4358" stroke-width="0.3"/>` +
    `<rect x="${x - 3.9}" y="${g - 13.9}" width="7.8" height="4.3" fill="#22d3a0" opacity="0.25"/></g>`).join('');
  return `<g opacity="0.5">${windows}</g><g opacity="0.75">${rack}</g>${desks}`;
}

/* ── period-neutral / exterior presets ───────────────────────────────────────
 * Added because `office`/`balcony`/`none` left every pre-modern or
 * out-of-doors setting with no correct choice — a real pilot staging 1840s
 * Missouri got an office backdrop (wall monitors, a server rack) because
 * that was the least-wrong preset available. These five are deliberately
 * generic rather than one-preset-per-book: a daylight sky, a night sky, a
 * plain interior room, a river/waterline, and a forest treeline cover most
 * exterior and interior-domestic staging without inventing bespoke presets
 * per story. All are low-contrast and free of any technology or specific
 * furniture — foreground actors and speech bubbles are meant to read as the
 * detail, not the backdrop. */

const NIGHT_STAR_POSITIONS = [
  [0.06, 0.08], [0.16, 0.16], [0.24, 0.06], [0.34, 0.18], [0.41, 0.1],
  [0.5, 0.22], [0.58, 0.07], [0.66, 0.15], [0.74, 0.24], [0.82, 0.09],
  [0.9, 0.19], [0.12, 0.26], [0.3, 0.28], [0.62, 0.28], [0.86, 0.27],
];

/** Scattered stars across the sky band, deterministic and reusable at any
 *  stage width — positions are fractions of `W`/a fixed vertical band. */
function starsSvg(W) {
  return NIGHT_STAR_POSITIONS.map(([fx, fy], i) =>
    `<circle cx="${(fx * W).toFixed(2)}" cy="${(fy * 20).toFixed(2)}" r="${i % 3 ? 0.22 : 0.32}" fill="#eef2ff" opacity="${i % 2 ? 0.5 : 0.8}"/>`).join('');
}

function moonSvg(cx, cy) {
  return `<circle cx="${cx}" cy="${cy}" r="6.5" fill="#eef2ff" opacity="0.08"/>` +
    `<circle cx="${cx}" cy="${cy}" r="4.4" fill="#f4efd8"/>` +
    `<circle cx="${cx + 1.4}" cy="${cy - 1.4}" r="0.8" fill="#e2dcc0" opacity="0.55"/>` +
    `<circle cx="${cx - 1.2}" cy="${cy + 1.3}" r="1.1" fill="#e2dcc0" opacity="0.45"/>`;
}

/** Low, wide, overlapping hill silhouettes sitting on the horizon line — read
 *  as distant terrain rather than a row of bumps because they overlap and
 *  stay well below the sky's contrast. */
function hillsSvg(g, W, color, opacity = 0.55) {
  const hills = [
    { fcx: 0.16, frx: 0.32, ry: 6.5 },
    { fcx: 0.52, frx: 0.4, ry: 4.5 },
    { fcx: 0.86, frx: 0.3, ry: 7.5 },
  ];
  return `<g opacity="${opacity}">` + hills.map((h) =>
    `<ellipse cx="${(h.fcx * W).toFixed(1)}" cy="${g.toFixed(1)}" rx="${(h.frx * W).toFixed(1)}" ry="${h.ry.toFixed(1)}" fill="${color}"/>`).join('') + '</g>';
}

/** A clear daylight sky over gently rolling ground — generic exterior daytime:
 *  a village street, a farmyard, an open field. Pale gradient sky, a soft sun,
 *  two rows of low hills, plain grass-toned ground. No architecture, so it
 *  composes freely with `props` (trees, platforms, walls) for whatever the
 *  scene needs standing in it. */
function skyDaySvg(S, prefix = 'st') {
  const g = S.ground, W = S.units.w, H = S.units.h, gid = `${ids(prefix).grad}-day`;
  const sky =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#bcdcf0"/><stop offset="1" stop-color="#e9f4fa"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>`;
  const sun = `<circle cx="${W * 0.82}" cy="8" r="10" fill="#fff3d6" opacity="0.35"/><circle cx="${W * 0.82}" cy="8" r="4.2" fill="#ffe9ad"/>`;
  const farHills = hillsSvg(g - 3, W, '#a7c9a1', 0.45);
  const nearHills = hillsSvg(g, W, '#8fbb85', 0.65);
  const ground = `<rect y="${g}" width="${W}" height="${H - g}" fill="#9dc491"/><rect y="${g}" width="${W}" height="0.5" fill="#7fa876"/>`;
  return sky + sun + farHills + nearHills + ground;
}

/** A dark, starlit sky over plain ground — generic exterior night, without
 *  the balcony preset's stone architecture: a road at night, a night camp,
 *  a yard. Deliberately spare so it reads as backdrop, not a second scene. */
function skyNightSvg(S, prefix = 'st') {
  const g = S.ground, W = S.units.w, H = S.units.h, gid = `${ids(prefix).grad}-night`;
  const sky =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#0d1220"/><stop offset="1" stop-color="#1c2740"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>`;
  const stars = starsSvg(W);
  const moon = moonSvg(W * 0.85, 9);
  const farHills = hillsSvg(g - 3, W, '#232c3d', 0.6);
  const ground = `<rect y="${g}" width="${W}" height="${H - g}" fill="#1a2130"/><rect y="${g}" width="${W}" height="0.5" fill="#333d54"/>`;
  return sky + `<g>${stars}</g>${moon}${farHills}${ground}`;
}

/** A plain interior room — period-neutral by construction: a flat wall, a
 *  chair-rail line, one plain rectangular window, floor planking. No
 *  furniture, no technology — reads as "a room" whether the story is set in
 *  1840 or 1940. A scene that needs specific furnishing adds its own via
 *  `props` (a `wall` for a hearth breast, a `shape` for a chair). */
function roomSvg(S, prefix = 'st') {
  const g = S.ground, W = S.units.w, H = S.units.h, gid = `${ids(prefix).grad}-room`;
  const wall =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#3a3226"/><stop offset="1" stop-color="#4a4032"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>`;
  const railY = g * 0.62;
  const rail = `<rect y="${railY.toFixed(1)}" width="${W}" height="0.5" fill="#5c503e" opacity="0.6"/>`;
  const window = windowPropSvg(W * 0.5, g * 0.18, 10, g * 0.3, '#e8dcb8');
  const floor = `<rect y="${g}" width="${W}" height="${H - g}" fill="#5a4a36"/><rect y="${g}" width="${W}" height="0.5" fill="#6e5c44"/>`;
  const planks = Array.from({ length: Math.ceil(W / 9) }, (_, i) =>
    `<rect x="${i * 9}" y="${g}" width="0.3" height="${H - g}" fill="#4a3d2c" opacity="0.4"/>`).join('');
  return wall + rail + `<g opacity="0.42">${window}</g>` + floor + planks;
}

/** A riverbank — sky, a receding treeline, a band of water, a near bank —
 *  for a Twain/Huck-Finn-shaped setting or any scene staged at a
 *  water's edge. The water sits just above `ground` so `props`/actors keep
 *  using the normal ground line for footing. */
function riverSvg(S, prefix = 'st') {
  const g = S.ground, W = S.units.w, H = S.units.h, gid = `${ids(prefix).grad}-river`;
  const sky =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#cfe3ee"/><stop offset="1" stop-color="#eef3ee"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>`;
  const farBank = hillsSvg(g - 9, W, '#7fa07a', 0.5);
  const trees = [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92].map((fx, i) =>
    `<g opacity="0.42">${treePropSvg(fx * W, g - 12, 9 + (i % 2) * 2, 11, '#4c7a52')}</g>`).join('');
  const waterTop = g - 5.5;
  const water = `<rect y="${waterTop}" width="${W}" height="${g - waterTop}" fill="#7fa9bd"/>` +
    Array.from({ length: 4 }, (_, i) =>
      `<rect y="${(waterTop + 1.2 + i * 1.2).toFixed(1)}" width="${W}" height="0.3" fill="#a9c9d6" opacity="0.5"/>`).join('');
  const bank = `<rect y="${g}" width="${W}" height="${H - g}" fill="#8a7a55"/><rect y="${g}" width="${W}" height="0.5" fill="#71633f"/>`;
  return sky + farBank + trees + water + bank;
}

/** A forest edge — one hazy, distant-feeling row of trees along the horizon,
 *  drawn with the same `treePropSvg` a scene's own `props` would use (so a
 *  deck that wants closer, denser trees can add its own via `props` without
 *  a visual mismatch), but kept small, low-opacity and desaturated here so
 *  it reads as scenery behind the actors rather than a wall of foliage at
 *  their own eye level. */
function treelineSvg(S, prefix = 'st') {
  const g = S.ground, W = S.units.w, H = S.units.h, gid = `${ids(prefix).grad}-treeline`;
  const sky =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#cde0d6"/><stop offset="1" stop-color="#eef4ec"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>`;
  const farTrees = Array.from({ length: Math.ceil(W / 8) }, (_, i) => (i + 0.5) * 8)
    .map((x, i) => `<g opacity="0.3">${treePropSvg(x, g - (9 + (i % 3)), 8, 9 + (i % 3), '#83a888')}</g>`).join('');
  const ground = `<rect y="${g}" width="${W}" height="${H - g}" fill="#9dc491"/><rect y="${g}" width="${W}" height="0.5" fill="#7fa876"/>`;
  return sky + `<g>${farTrees}</g>` + ground;
}

/** A night orchard with a stone balcony — for the Romeo & Juliet demo, and any
 *  scene where one character stands above another on a wall or ledge. The
 *  ledge sits at `g - 20`, matching the `y: 20` an actor needs to appear to
 *  stand on it. */
function balconySvg(S, prefix = 'st') {
  const g = S.ground, W = S.units.w;
  const ledgeY = g - 20, wallX = W - 46, wallW = 38;

  const stars = [
    [6, 4], [16, 8], [24, 3], [34, 9], [41, 5], [10, 13], [30, 14],
    [46, 11], [4, 18], [20, 17],
  ].map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 0.22 : 0.34}" fill="#eef2ff" opacity="${i % 2 ? 0.55 : 0.85}"/>`).join('');
  const moon =
    `<circle cx="15" cy="10" r="7.5" fill="#eef2ff" opacity="0.08"/>` +
    `<circle cx="15" cy="10" r="5" fill="#f4efd8"/>` +
    `<circle cx="16.6" cy="8.3" r="0.9" fill="#e2dcc0" opacity="0.6"/>` +
    `<circle cx="13.7" cy="11.6" r="1.3" fill="#e2dcc0" opacity="0.5"/>`;

  // Stone coursing along the ground, standing in for a garden wall.
  const courses = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: Math.ceil(W / 6) + 1 }, (_, i) => {
      const x = i * 6 - (row % 2) * 3;
      return `<rect x="${x}" y="${g + row * 2}" width="5.4" height="1.7" rx="0.3" fill="${row % 2 ? '#2a3140' : '#262c3a'}" stroke="#3d4a63" stroke-width="0.15"/>`;
    }).join(''),
  ).join('');

  // The balcony: a stone tower rising to a balustraded ledge, with a lit
  // window recess behind it and ivy climbing the wall Romeo scaled.
  const wallBlock = `<rect x="${wallX}" y="${ledgeY}" width="${wallW}" height="${g - ledgeY}" fill="#343b4f" stroke="#232939" stroke-width="0.4"/>` +
    Array.from({ length: 6 }, (_, i) => `<rect x="${wallX}" y="${ledgeY + 2 + i * 3}" width="${wallW}" height="0.35" fill="#232939" opacity="0.6"/>`).join('');
  const arch = `<path d="M${wallX + 9},${ledgeY} L${wallX + 9},${ledgeY - 9} A5,5 0 0 1 ${wallX + 19},${ledgeY - 9} L${wallX + 19},${ledgeY} Z"` +
    ` fill="#f6cf87" opacity="0.5" stroke="#5a4a2c" stroke-width="0.4"/>`;
  const slab = `<rect x="${wallX - 2}" y="${ledgeY - 2.6}" width="${wallW + 4}" height="2.6" rx="0.4" fill="#4a5068" stroke="#232939" stroke-width="0.4"/>`;
  const rail = `<rect x="${wallX - 1}" y="${ledgeY - 7.4}" width="${wallW + 2}" height="1" rx="0.3" fill="#4a5068"/>` +
    Array.from({ length: Math.floor(wallW / 4) }, (_, i) =>
      `<rect x="${wallX + 2 + i * 4}" y="${ledgeY - 7.2}" width="1.3" height="5.2" rx="0.3" fill="#3a3f52" stroke="#232939" stroke-width="0.2"/>`).join('');
  const ivy = `<path d="M${wallX - 1},${g} C${wallX - 3},${g - 8} ${wallX + 2},${g - 12} ${wallX - 1},${g - 20}" fill="none" stroke="#3f6b3f" stroke-width="0.6" opacity="0.85"/>` +
    Array.from({ length: 6 }, (_, i) =>
      `<circle cx="${wallX - 1.5 + (i % 2 ? 2 : -1.5)}" cy="${g - 3 - i * 3}" r="0.9" fill="#4c8a4c" opacity="0.8"/>`).join('');

  return `<g>${stars}${moon}</g><g>${courses}</g>` +
    `<g>${ivy}${wallBlock}${arch}${slab}${rail}</g>`;
}

/* ── props ────────────────────────────────────────────────────────────────── */
// Composable set dressing drawn on top of the preset backdrop. Each prop has a
// `kind`, an (x, y) placed with the same units-above-ground convention as an
// actor, and kind-dependent defaults for w/h so `{ kind, x }` alone renders
// sensibly. See docs/stage-scenes.md and the props contract.

export const PROP_DEFAULT_SIZE = {
  platform: { w: 20, h: 3 },
  wall: { w: 20, h: 12 },
  glow: { w: 10, h: 10 },
  window: { w: 8, h: 10 },
  foliage: { w: 6, h: 8 },
  tree: { w: 14, h: 22 },
  shape: { w: 0, h: 0 },
};

/** Deterministic 0..1 pseudo-random from a number seed — cheap, no state, same
 *  input always gives the same output, which is what lets several trees/bushes
 *  vary without breaking the "pure function of time" / reproducible-stills rule. */
function hash01(n) {
  const v = Math.sin(n * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/** A stone slab an actor can stand on — its top surface sits at `topY`. */
function platformPropSvg(x, topY, w, h, color) {
  const fill = color || '#4a5068';
  return `<rect x="${(x - w / 2).toFixed(2)}" y="${topY.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="0.4" fill="${fill}" stroke="#232939" stroke-width="0.35"/>` +
    `<rect x="${(x - w / 2).toFixed(2)}" y="${topY.toFixed(2)}" width="${w.toFixed(2)}" height="${Math.min(0.6, h).toFixed(2)}" fill="#5a6280" opacity="0.5"/>`;
}

/** A flat block with coursing lines, top at `topY`, running down `h` units. */
function wallPropSvg(x, topY, w, h, color) {
  const fill = color || '#343b4f';
  const rows = Math.max(1, Math.round(h / 2.2));
  const lines = Array.from({ length: rows }, (_, i) =>
    `<rect x="${(x - w / 2).toFixed(2)}" y="${(topY + (i + 1) * (h / (rows + 1))).toFixed(2)}" width="${w.toFixed(2)}" height="0.3" fill="#232939" opacity="0.55"/>`).join('');
  return `<rect x="${(x - w / 2).toFixed(2)}" y="${topY.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="#232939" stroke-width="0.4"/>${lines}`;
}

/** A soft radial light — a lantern, or spill from a lit window. */
function glowPropSvg(x, cy, w, color, opacity, gid) {
  const r = w / 2;
  const c = color || '#f6cf87';
  return `<defs><radialGradient id="${gid}"><stop offset="0" stop-color="${c}" stop-opacity="${opacity}"/>` +
    `<stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="${x.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="url(#${gid})"/>`;
}

/** A lit rectangular/arched recess — reads as a light source. Built as an
 *  arch-topped path (straight sides down to an arc spring line, per
 *  `balconySvg()`'s arch): a dark recess frame, a warm lit interior inset
 *  inside it, and a couple of mullion bars so it reads as panes, not a wash
 *  of color. NB the arc's sweep-flag depends on its winding direction — this
 *  path winds top-right → top-left (right-to-left), the mirror of
 *  `balconySvg()`'s left-to-right arch, so it needs sweep-flag 0 where that
 *  one uses 1 to bulge the same way (up, into a dome) rather than down (into
 *  a bowl) — the flag that shipped wrong is what made this render as a bowl. */
function windowPropSvg(x, topY, w, h, color) {
  const glow = color || '#f6cf87';
  const archH = Math.min(w * 0.6, h * 0.45);
  const arch = (inset) => {
    const rx = w / 2 - inset, ry = archH - inset;
    const left = x - w / 2 + inset, right = x + w / 2 - inset;
    const spring = topY + archH + inset * 0.6, bottom = topY + h - inset;
    return `M${left.toFixed(2)},${spring.toFixed(2)} L${left.toFixed(2)},${bottom.toFixed(2)} ` +
      `L${right.toFixed(2)},${bottom.toFixed(2)} L${right.toFixed(2)},${spring.toFixed(2)} ` +
      `A${rx.toFixed(2)},${ry.toFixed(2)} 0 0 0 ${left.toFixed(2)},${spring.toFixed(2)} Z`;
  };
  const frame = `<path d="${arch(0)}" fill="#0e1626" stroke="#3d4a63" stroke-width="0.35"/>`;
  const lit = `<path d="${arch(0.7)}" fill="${glow}" opacity="0.72"/>`;
  const paneY = topY + archH + (h - archH) * 0.55;
  const mullions =
    `<line x1="${x.toFixed(2)}" y1="${(topY + archH * 0.35).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(topY + h - 0.7).toFixed(2)}" stroke="#5a4a2c" stroke-width="0.32" opacity="0.65"/>` +
    `<line x1="${(x - w / 2 + 0.7).toFixed(2)}" y1="${paneY.toFixed(2)}" x2="${(x + w / 2 - 0.7).toFixed(2)}" y2="${paneY.toFixed(2)}" stroke="#5a4a2c" stroke-width="0.3" opacity="0.6"/>`;
  return frame + lit + mullions;
}

/** A bush: a solid clumped mass sitting on the ground line, built from a few
 *  overlapping lobes whose bottom-most reach `topY + h` (the ground/`y`
 *  line) so nothing floats, with an outline for silhouette and a couple of
 *  lighter highlight clumps on top for volume. Colored by `color`. */
function foliagePropSvg(x, topY, w, h, color) {
  const base = color || '#3f6b3f';
  const lit = '#4c8a4c';
  const outline = '#26392a';
  const bottom = topY + h;
  const seed = x * 0.41;
  const j = (i) => hash01(seed + i) - 0.5; // -0.5..0.5, deterministic per (x, i)

  // Base mass: a big central lobe plus two lower side lobes whose bottoms
  // sit at (or a hair into) the ground line — no gap between plant and floor.
  const lobes = [
    { dx: 0, rf: 0.5, sink: 0.82 },
    { dx: -0.62, rf: 0.36, sink: 0.72 },
    { dx: 0.6, rf: 0.36, sink: 0.72 },
  ].map((l, i) => {
    const r = w * (l.rf + j(i) * 0.08);
    const cx = x + l.dx * w * (1 + j(i + 5) * 0.15);
    const cy = bottom - r * l.sink;
    return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${base}" stroke="${outline}" stroke-width="0.22"/>`;
  }).join('');

  // A smaller accent lobe up top gives the mound some height without
  // floating free of the base mass (it overlaps the central lobe).
  const crown = `<circle cx="${(x + j(9) * w * 0.2).toFixed(2)}" cy="${(bottom - h * 0.72).toFixed(2)}" r="${(w * (0.3 + j(10) * 0.06)).toFixed(2)}" fill="${base}" stroke="${outline}" stroke-width="0.22"/>`;

  // Highlight clumps: lighter, no outline, biased upper-left for a
  // consistent light direction, for volume rather than flat color.
  const highlights = [
    { dx: -0.28, dyf: 0.62, rf: 0.2 },
    { dx: 0.08, dyf: 0.82, rf: 0.16 },
  ].map((l, i) => {
    const r = w * (l.rf + j(i + 20) * 0.04);
    const cx = x + l.dx * w + j(i + 25) * w * 0.1;
    const cy = bottom - h * l.dyf;
    return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${lit}" opacity="0.8"/>`;
  }).join('');

  return lobes + crown + highlights;
}

/** A tree: a trunk rising from the ground into an overlapping mass of canopy
 *  lobes above it — same flat-fill, dark-outline house style as
 *  `foliagePropSvg`, just taller and with a trunk. `color` overrides the
 *  canopy green (trunk stays woody regardless). Canopy shape is jittered
 *  deterministically off `x` (see `hash01`) so a row of trees doesn't look
 *  stamped from one die, while staying a pure function of the prop's own
 *  position — same scene, same still, every time. */
function treePropSvg(x, topY, w, h, color) {
  const canopyBase = color || '#3f6b3f';
  const canopyLit = '#4c8a4c';
  const outline = '#26392a';
  const trunkColor = '#5a4330';
  const bottom = topY + h;
  const seed = x * 0.29;
  const j = (i) => hash01(seed + i) - 0.5;

  // The canopy is sized from BOTH w and h. Deriving its radius from `w` alone
  // (as this did originally) makes `h` almost inert: a 15×25 tree drew a ~15
  // unit blob whose lobes hung down over the trunk, so it read as a pile of
  // bushes rather than a tree. `cry` carries the height, and the canopy's
  // lowest lobe is held clear of `trunkClear` so the trunk always shows.
  const trunkW = Math.max(0.7, w * 0.11);
  const trunkH = h * (0.46 + j(0) * 0.04);
  const trunkTop = bottom - trunkH;
  const trunk = `<rect x="${(x - trunkW / 2).toFixed(2)}" y="${trunkTop.toFixed(2)}" width="${trunkW.toFixed(2)}" height="${(trunkH + 0.4).toFixed(2)}" rx="${(trunkW * 0.3).toFixed(2)}" fill="${trunkColor}" stroke="${outline}" stroke-width="0.25"/>`;

  const crx = w * 0.5;                     // canopy half-width, from w
  const cry = h * 0.34;                    // canopy half-height, from h
  const cr = Math.min(crx, cry);           // lobe radius unit — keeps lobes round
  const cx = x, cy = bottom - h * 0.66;    // canopy sits in the upper two-thirds
  const lobes = [
    { dx: 0, dy: 0.1, s: 1.0 },
    { dx: -0.6, dy: 0.3, s: 0.7 },
    { dx: 0.6, dy: 0.28, s: 0.72 },
    { dx: -0.3, dy: -0.35, s: 0.66 },
    { dx: 0.32, dy: -0.38, s: 0.64 },
    { dx: 0.02, dy: -0.62, s: 0.52 },
  ].map((l, i) => {
    const jj = j(i + 1);
    const dx = l.dx + jj * 0.18;
    const dy = l.dy + jj * 0.12;
    const r = cr * l.s * (1 + jj * 0.22);
    return `<circle cx="${(cx + dx * cr).toFixed(2)}" cy="${(cy + dy * cr).toFixed(2)}" r="${r.toFixed(2)}" fill="${canopyBase}" stroke="${outline}" stroke-width="0.24"/>`;
  }).join('');

  const highlights = [
    { dx: -0.32, dy: -0.32, s: 0.42 },
    { dx: 0.08, dy: -0.12, s: 0.36 },
    { dx: -0.05, dy: 0.18, s: 0.3 },
  ].map((l, i) => {
    const jj = j(i + 10);
    const dx = l.dx + jj * 0.15;
    const dy = l.dy + jj * 0.1;
    const r = cr * l.s * (1 + jj * 0.2);
    return `<circle cx="${(cx + dx * cr).toFixed(2)}" cy="${(cy + dy * cr).toFixed(2)}" r="${r.toFixed(2)}" fill="${canopyLit}" opacity="0.78"/>`;
  }).join('');

  return trunk + lobes + highlights;
}

/** One prop, translated so (0,0) is (`x`, `ground - y`). Exported for the atlas
 *  builder's `props` catalogue, which renders one prop in isolation per kind
 *  rather than a whole stage's `props` array. */
export function propSvg(p, idx, S, prefix) {
  const g = S.ground;
  const kind = p.kind;
  const def = PROP_DEFAULT_SIZE[kind] || { w: 0, h: 0 };
  const x = p.x;
  const y = p.y ?? 0;
  const w = p.w ?? def.w;
  const h = p.h ?? def.h;
  const topY = g - y - h; // top edge in SVG space (props whose h extends down to ground/y)
  const opacity = p.opacity ?? 1;
  let body;
  switch (kind) {
    case 'platform': body = platformPropSvg(x, g - y, w, h, p.color); break;
    case 'wall': body = wallPropSvg(x, topY, w, h, p.color); break;
    case 'glow': body = glowPropSvg(x, g - y, w, p.color, opacity, `${prefix}-glow-${idx}`); break;
    case 'window': body = windowPropSvg(x, topY, w, h, p.color); break;
    case 'foliage': body = foliagePropSvg(x, topY, w, h, p.color); break;
    case 'tree': body = treePropSvg(x, topY, w, h, p.color); break;
    case 'shape': body = `<g transform="translate(${x.toFixed(2)},${(g - y).toFixed(2)})">${p.svg || ''}</g>`; break;
    default: body = '';
  }
  // glow bakes opacity into its gradient stops; the wrapping group would double it.
  const wrapOpacity = kind === 'glow' ? 1 : opacity;
  return `<g${p.id ? ` data-prop-id="${esc(p.id)}"` : ''} opacity="${wrapOpacity}">${body}</g>`;
}

/** All props of one layer ("back" | "front"), in array order. */
export function propsSvg(S, layer, prefix = 'st') {
  const props = S.props;
  if (!props || !props.length) return '';
  return props
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (p.layer || 'back') === layer)
    .map(({ p, i }) => propSvg(p, i, S, prefix))
    .join('');
}

/* ── pixel characters ─────────────────────────────────────────────────────── */
export function pixelFrameSvg(c, idx = 0) {
  const rows = c.atlas.frames[idx], pal = c.atlas.palette;
  const cols = rows[0].length, u = c.size.w / cols;
  let out = '';
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const col = pal[ch];
      if (!col || col === 'none') return;
      out += `<rect x="${(x * u - c.size.w / 2).toFixed(3)}" y="${(y * u - c.size.h).toFixed(3)}" ` +
             `width="${(u + 0.02).toFixed(3)}" height="${(u + 0.02).toFixed(3)}" fill="${col}"/>`;
    }));
  return out;
}

/* ── lettering ────────────────────────────────────────────────────────────── */

// One declaration for every glyph drawn on the stage, because a bubble and a
// caption sitting in the same frame in two unrelated faces is the first thing
// the eye catches. `system-ui` was the old bubble font: it renders as whatever
// the OS chrome uses, which is a UI font doing a comic's job — tight, cold, and
// wrong at 2.35 units.
//
// No webfonts: a stage scene has to draw identically in a single-file bundle
// with a strict CSP, in a PDF export and in a headless still, so the stack has
// to be system faces. These are humanist book faces with real italics, present
// on macOS/Windows/Linux respectively, ending at the generic `serif`.
export const STAGE_FONT =
  "'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif";

/* ── speech bubble ────────────────────────────────────────────────────────── */

// A long line must grow a *wide, short* bubble, not a narrow tall one: the
// wrap width itself is adaptive. Starting at MIN_CHARS (about where the old
// fixed 26 sat) it widens two characters at a time until the line fits in
// BUBBLE_TARGET_LINES, capping at MAX_CHARS so an extreme line grows in
// height rather than swallowing the stage's width. bubbleMetrics() is the one
// place this geometry lives — the validator imports it so its "this bubble
// will dominate the frame" check can never drift from what actually renders.
const BUBBLE_MIN_CHARS = 24;
const BUBBLE_MAX_CHARS = 58;
export const BUBBLE_TARGET_LINES = 4;
const BUBBLE_MIN_W = 18;
const BUBBLE_MAX_W = 78;         // was 46 — the stage is 100 units wide; this still leaves margin
const BUBBLE_LINE_H = 3.0;
// Vertical padding was 2.4 total, spent almost entirely below the last
// baseline (see bubbleTspans' fixed +2.0 first-line offset) — the top line's
// glyphs sat ~0.2 units under the rect edge, reading as cramped. 4.2 total,
// split via the tspans offset below, gives both edges real clearance.
const BUBBLE_PAD_H = 4.2;
// Horizontal breathing room added on top of the fitted text width — without
// it a bubble sized to exactly the longest line's measured width touches
// that line's glyphs directly to the rect edge.
const BUBBLE_PAD_W = 3.4;
// A character with no resolved plan (a pixel-style cast member) has no known
// height; this is the shipped "human" plan's own height and stands in for it.
const BUBBLE_HEAD_FALLBACK_H = 17;
// Clearance between the bubble and the speaker's head box. Bigger than it
// looks like it needs to be: `size.h` is the plan's body height to the crown
// of the skull, but hair (a per-character overlay, not part of the plan) can
// reach several units above that — this gap is sized to clear a normal fringe
// or updo, not just the bald head circle.
const BUBBLE_HEAD_GAP = 4.5;

/** Wrap `text` at the narrowest width that keeps it within BUBBLE_TARGET_LINES lines. */
export function wrapLinesFor(text) {
  for (let m = BUBBLE_MIN_CHARS; m < BUBBLE_MAX_CHARS; m += 2) {
    const lines = wrap(text, m);
    if (lines.length <= BUBBLE_TARGET_LINES) return lines;
  }
  return wrap(text, BUBBLE_MAX_CHARS);
}

/** The box a wrapped line needs: width from its longest line, height from its line count. */
// Units of box width per character of the longest line. Calibrated to the font
// and size the bubble actually draws at (STAGE_FONT at 2.5) — a book serif sets
// wider than the system-ui face this was first measured against, and leaving
// the old 1.35 here let long lines run out through the side of the box. Checked
// by measuring rendered text extents against the rect in a browser, not derived.
const BUBBLE_W_PER_CHAR = 1.5;

export function bubbleSize(lines) {
  const w = clamp(BUBBLE_W_PER_CHAR * Math.max(...lines.map((l) => l.length)) + BUBBLE_PAD_W, BUBBLE_MIN_W, BUBBLE_MAX_W);
  const h = lines.length * BUBBLE_LINE_H + BUBBLE_PAD_H;
  return { w, h };
}

/** `{ lines, w, h }` a beat's line would render at — the validator's view into this geometry. */
export function bubbleMetrics(text) {
  const lines = wrapLinesFor(text);
  return { lines, ...bubbleSize(lines) };
}

const BUBBLE_EDGE = 1.5;         // units of stage margin a bubble keeps on every side
const BUBBLE_SIDE_GAP = 3.5;     // clearance between a side-placed bubble and the speaker

const box = (lines, w, h, cx, cy, tail) => ({ lines, w, h, cx, cy, x: cx - w / 2, y: cy - h / 2, tail });

/**
 * Bubble geometry for the live beat, or null when nobody is speaking.
 *
 * Placement is a search, not a formula. Above the speaker is preferred — it
 * reads as a comic panel and leaves the staging legible. But an *elevated*
 * speaker (a balcony) is already near the top of the frame by construction, so
 * "above, clamped onto the stage" resolves to "directly over their own head":
 * Juliet at y=20 wants a centre at -4.2 and gets clamped to 8.7, which is
 * exactly where her head is. When there is no headroom, the bubble goes beside
 * her instead and the tail points sideways.
 */
export function bubbleAt(scene, state, chars) {
  const b = state.beat;
  if (!b?.speaker) return null;
  const a = state.actors[b.speaker];
  if (!a?.visible) return null;
  const S = scene.stage;
  const { lines, w, h } = bubbleMetrics(b.line);
  const char = chars?.[b.speaker];
  const charH = (char?.size?.h ?? BUBBLE_HEAD_FALLBACK_H) * (char?.scale ?? 1);
  const headTop = S.ground - a.y - charH;
  const cx = clamp(a.x, w / 2 + BUBBLE_EDGE, S.units.w - w / 2 - BUBBLE_EDGE);

  // 1. Above the speaker, tail pointing down — the preferred reading.
  const above = headTop - BUBBLE_HEAD_GAP - h / 2;
  if (above - h / 2 >= BUBBLE_EDGE) {
    return box(lines, w, h, cx, above,
      `M${(a.x - 1.6).toFixed(2)},${(above + h / 2 - 0.2).toFixed(2)} ` +
      `L${(a.x + 1.4).toFixed(2)},${(above + h / 2 - 0.2).toFixed(2)} ` +
      `L${(a.x + 0.4).toFixed(2)},${(above + h / 2 + 3.2).toFixed(2)} Z`);
  }

  // 2. Beside the speaker, level with their head. Prefer the side with more
  //    room, so a balcony on the right throws its bubble out over the orchard.
  const sideCy = clamp(headTop + h / 2 - 1, h / 2 + BUBBLE_EDGE, S.ground - h / 2 - 2);
  const fitsLeft = a.x - BUBBLE_SIDE_GAP - w >= BUBBLE_EDGE;
  const fitsRight = a.x + BUBBLE_SIDE_GAP + w <= S.units.w - BUBBLE_EDGE;
  const side = fitsLeft && (!fitsRight || a.x > S.units.w / 2) ? 'left' : fitsRight ? 'right' : null;
  if (side) {
    const sx = side === 'left' ? a.x - BUBBLE_SIDE_GAP - w / 2 : a.x + BUBBLE_SIDE_GAP + w / 2;
    const edge = side === 'left' ? sx + w / 2 - 0.2 : sx - w / 2 + 0.2;
    const tip = side === 'left' ? a.x - 2.6 : a.x + 2.6;
    return box(lines, w, h, sx, sideCy,
      `M${edge.toFixed(2)},${(sideCy - 1.6).toFixed(2)} ` +
      `L${edge.toFixed(2)},${(sideCy + 1.4).toFixed(2)} ` +
      `L${tip.toFixed(2)},${(headTop + 2.2).toFixed(2)} Z`);
  }

  // 3. Nothing fits beside either — a bubble that wide has no good home, so
  //    fall back to the old clamped-above behaviour rather than off-stage.
  const cy = clamp(above, h / 2 + BUBBLE_EDGE, S.ground - 2);
  return box(lines, w, h, cx, cy,
    `M${(a.x - 1.6).toFixed(2)},${(cy + h / 2 - 0.2).toFixed(2)} ` +
    `L${(a.x + 1.4).toFixed(2)},${(cy + h / 2 - 0.2).toFixed(2)} ` +
    `L${(a.x + 0.4).toFixed(2)},${(cy + h / 2 + 3.2).toFixed(2)} Z`);
}

export function bubbleTspans(bub) {
  // First baseline sits BUBBLE_PAD_H/2 + a font-size-scaled cap-height below
  // the rect's top edge, so the top line's glyphs clear the border by the
  // same margin the bottom line clears it below (the line-height cadence
  // after that, BUBBLE_LINE_H, is unaffected).
  const topOffset = BUBBLE_PAD_H / 2 + 1.9;
  return bub.lines
    .map((l, i) => `<tspan x="${bub.cx.toFixed(2)}" y="${(bub.y + topOffset + i * 3.0).toFixed(2)}">${esc(l)}</tspan>`)
    .join('');
}

/* ── narrator caption ─────────────────────────────────────────────────────── */

// A beat with a `speaker` draws a bubble. A beat without one — the narrator
// voice — used to draw NOTHING, so 452 of Beowulf's 728 beats (and all of
// chapters 1-3) played as silent-movie mime with no text anywhere on screen.
// That is what "the speech bubbles are gone" looks like from the audience side.
// The narrator gets the cartoon's own furniture instead: a caption card along
// the foot of the frame, the way a storybook adaptation captions its plates.
//
// It lives here rather than in the player so the live frame, the contact sheet
// and the PDF page all draw it from one definition — the same rule bubbleAt
// already follows.
const CAP_WRAP = 74;             // characters per caption line
const CAP_FONT = 2.5;
const CAP_LINE_H = 3.1;
const CAP_PAD_V = 2.0;
const CAP_EDGE = 1.6;            // margin from the frame's bottom
const CAP_FADE = 5;              // units the scrim dissolves upward over

export function captionMetrics(text) {
  const lines = wrap(text, CAP_WRAP);
  return { lines, h: lines.length * CAP_LINE_H + CAP_PAD_V };
}

/**
 * Caption geometry for the live beat, or null when the beat is dialogue (or
 * silent). Anchored to the bottom of the frame, full width less a margin, so
 * it never collides with a speech bubble — bubbles are placed above or beside
 * a speaker's head, never in the floor strip.
 */
export function captionAt(scene, state) {
  const b = state.beat;
  if (!b || b.speaker || !b.narration) return null;
  const text = String(b.narration).trim();
  if (!text) return null;
  const S = scene.stage;
  const { lines, h } = captionMetrics(text);
  const ty = S.units.h - CAP_EDGE - h;          // top of the text block
  // The scrim runs edge to edge and all the way to the bottom of the frame,
  // starting CAP_FADE above the text so it dissolves into the picture rather
  // than ending on a visible seam.
  const y = Math.max(0, ty - CAP_FADE);
  return { lines, ty, x: 0, y, w: S.units.w, h: S.units.h - y, cx: S.units.w / 2 };
}

export function captionTspans(cap) {
  return cap.lines
    .map((l, i) => `<tspan x="${cap.cx.toFixed(2)}" y="${(cap.ty + CAP_PAD_V / 2 + 1.15 + i * CAP_LINE_H).toFixed(2)}">${esc(l)}</tspan>`)
    .join('');
}

/* ── one actor ────────────────────────────────────────────────────────────── */
// Exported so the atlas builder can render one character in isolation (a face
// crop, a full-body cast portrait, a pose strip) without assembling a whole
// stage — same geometry function the live stage uses, so an atlas cell can
// never drift from what a real beat would draw.
export function actorSvg(char, I, opts) {
  const { actor, t, ground, prefix } = opts;
  const tf = actor ? actorTransforms(char, actor, t, ground) : null;
  const hidden = actor && !actor.visible ? ' style="display:none"' : '';
  const rootT = tf ? ` transform="${tf.root}"` : '';
  const innerT = tf ? ` transform="${tf.inner}"` : '';

  let inner;
  if (char.style === 'pixel') {
    const idx = actor ? pixelFrameAt(char, actor.state, t) : 0;
    inner = `<g id="${I.pixel(char.id)}" shape-rendering="crispEdges">${pixelFrameSvg(char, idx)}</g>`;
  } else {
    // One level of nesting: a part with `parent` is drawn inside that part's
    // group, which is how the mouth and hair ride along with the head.
    const build = (name) => {
      const kids = Object.entries(char.parts).filter(([, p]) => p.parent === name).map(([cn]) => build(cn)).join('');
      const pt = tf ? ` transform="${tf.parts[name]}"` : '';
      return `<g id="${I.part(char.id, name)}"${pt}>${char.parts[name].html}${kids}</g>`;
    };
    inner = char.order.map(build).join('');
  }
  return `<g id="${I.actor(char.id)}"${rootT}${hidden}><g id="${I.inner(char.id)}"${innerT}>${inner}</g></g>`;
}

/* ── the whole stage ──────────────────────────────────────────────────────── */

/**
 * Markup for the stage. With `state` it is a finished still; without one it is
 * the skeleton the browser player mounts and then drives by attribute.
 */
export function stageMarkup(scene, chars, roster, { state = null, t = 0, prefix = 'st' } = {}) {
  const I = ids(prefix);
  const ground = scene.stage.ground;
  const actors = roster
    .map((id) => chars[id])
    .filter(Boolean)
    .map((c) => actorSvg(c, I, { actor: state?.actors[c.id] ?? null, t, ground, prefix }))
    .join('');

  const bub = state ? bubbleAt(scene, state, chars) : null;
  // A white bubble in a book serif is right for a folk epic and wrong for
  // anything else — dropped into a flat-vector deck with its own palette it
  // reads as a sticker from a different cartoon. `stage.bubble` lets a scene
  // restyle it; every key is optional and the defaults are the originals, so
  // a scene that says nothing draws byte-identically to before.
  const bs = scene?.stage?.bubble ?? {};
  const bFill = bs.fill ?? '#fbfbfe';
  const bInk = bs.ink ?? '#14161d';
  const bText = bs.text ?? bInk;
  const bFont = bs.font ?? STAGE_FONT;
  const bubble =
    `<g id="${I.bubble}"${bub ? '' : ' style="display:none"'}>` +
    `<path id="${I.bubbleTail}" d="${bub ? bub.tail : ''}" fill="${bFill}" stroke="${bInk}" stroke-width="0.3"/>` +
    `<rect id="${I.bubbleRect}" rx="${bs.radius ?? 1.6}" fill="${bFill}" stroke="${bInk}" stroke-width="0.35"` +
    (bub ? ` x="${bub.x.toFixed(2)}" y="${bub.y.toFixed(2)}" width="${bub.w.toFixed(2)}" height="${bub.h.toFixed(2)}"` : '') +
    `/><text id="${I.bubbleText}" font-family="${bFont}" font-size="2.5" fill="${bText}"` +
    ` text-anchor="middle" dominant-baseline="middle">${bub ? bubbleTspans(bub) : ''}</text></g>`;

  // A subtitle, not a panel. The first cut drew an opaque bordered card, which
  // read as a second picture stacked on the first and hid the actors from the
  // knees down. What a cartoon actually does is lay the narrator's line over
  // the bottom of the frame with just enough scrim to stay legible — so this
  // is a gradient that fades up into the picture, plus an ink outline on the
  // glyphs themselves (paint-order:stroke) so the words survive a light
  // backdrop with no box at all.
  const cap = state ? captionAt(scene, state) : null;
  const cgid = `${prefix}-capgrad`;
  const caption =
    `<g id="${I.caption}"${cap ? '' : ' style="display:none"'}>` +
    `<defs><linearGradient id="${cgid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#07080c" stop-opacity="0"/>` +
    `<stop offset="0.45" stop-color="#07080c" stop-opacity="0.72"/>` +
    `<stop offset="1" stop-color="#07080c" stop-opacity="0.88"/></linearGradient></defs>` +
    `<rect id="${I.captionRect}" fill="url(#${cgid})"` +
    (cap ? ` x="${cap.x.toFixed(2)}" y="${cap.y.toFixed(2)}" width="${cap.w.toFixed(2)}" height="${cap.h.toFixed(2)}"` : '') +
    `/><text id="${I.captionText}" font-family="${STAGE_FONT}" font-size="${CAP_FONT}"` +
    ` font-style="italic" fill="#f4ecda" stroke="#07080c" stroke-width="0.5"` +
    ` paint-order="stroke" stroke-linejoin="round"` +
    ` text-anchor="middle" dominant-baseline="middle">` +
    `${cap ? captionTspans(cap) : ''}</text></g>`;

  const backProps = propsSvg(scene.stage, 'back', prefix);
  const frontProps = propsSvg(scene.stage, 'front', prefix);
  const backPropsMarkup = backProps ? `<g class="stage-props-back">${backProps}</g>` : '';
  const frontPropsMarkup = frontProps ? `<g class="stage-props-front">${frontProps}</g>` : '';

  return `${backdropSvg(scene.stage, prefix)}${backPropsMarkup}<g class="stage-actors">${actors}</g>${frontPropsMarkup}${bubble}${caption}`;
}

/** A standalone `<svg>` document for one instant — the still / PDF page. */
export function stageSvg(scene, chars, timeline, t, roster, { prefix = 'st' } = {}) {
  const state = stageStateAt(scene, timeline, t, roster);
  const S = scene.stage;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S.units.w} ${S.units.h}" ` +
    `width="${S.units.w * 12}" height="${S.units.h * 12}">` +
    stageMarkup(scene, chars, roster, { state, t, prefix }) + '</svg>';
}

/** One still per beat — the review artifact, and incidentally the comic. */
export function contactSheet(scene, chars, timeline, roster, { at = 0.45 } = {}) {
  return timeline.beats.map((b) => ({
    index: b.index,
    t: b.start + b.dur * at,
    speaker: b.speaker ?? null,
    text: b.text,
    svg: stageSvg(scene, chars, timeline, b.start + b.dur * at, roster, { prefix: `sheet${b.index}` }),
  }));
}
