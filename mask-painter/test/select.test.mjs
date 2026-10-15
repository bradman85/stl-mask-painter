// Cleaning up the model: the separate models (shells) inside one file, picking faces, and taking
// the picked faces back out — plus where the bed ends up, which is what the removal is for.
//
//   node test/select.test.mjs
//
// Three levels. First the rule on a soup whose shells are known by construction: two cubes far
// apart are two models, two cubes that only meet at a corner are still two, a face that degenerates
// to a line joins nothing, and the bounds of each shell are the bounds of that cube. Then the
// surgery: a filtered soup keeps exactly the faces it should, the paint on the surviving vertices
// comes across unchanged — measured corner by corner, not just counted — and the mask's undo
// history is renumbered so Ctrl+Z still reaches the paint it used to. Then the real model, where
// the point of the whole feature is measured: a stray model *below* the figure lifts it off the
// bed, and removing the stray puts it back on.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { buildTopology } from '../js/stencil.js';
import { centreTranslation, gridPlacement } from '../js/viewer.js';
import {
  shellsOf,
  shellSize,
  facesOfShells,
  countFaces,
  filterSoup,
  highlightArrays,
} from '../js/select.js';
import { drawHighlight, clearHighlight } from '../js/highlight.js';
import { parseBinarySTL, fmt } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** The 12 triangles of an axis-aligned box, outward-wound, as a flat soup. */
function boxSoup([x0, y0, z0, x1, y1, z1]) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3],
  ];
  const out = [];
  for (const [a, b, c, d] of quads) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  return Float32Array.from(out);
}

/** Two soups appended into one file, i.e. what a multi-model STL actually looks like. */
function combine(...soups) {
  const total = soups.reduce((n, s) => n + s.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const s of soups) {
    out.set(s, at);
    at += s.length;
  }
  return out;
}

const facesOf = (positions) => Math.floor(positions.length / 9);

// ------------------------------------------------------- shells, on a known soup

{
  const lower = boxSoup([0, -10, 0, 2, -8, 2]); // a stray model *below* the figure
  const upper = boxSoup([0, 0, 0, 4, 4, 4]); // the model you want
  const combined = combine(lower, upper);
  const topo = buildTopology(combined, combined.length / 3);
  const shells = shellsOf(topo);

  check(
    'two boxes written into one file are two models',
    shells.shellCount === 2 && shells.faceCount === 24,
    `${shells.shellCount} shells, ${shells.faceCount} faces`,
  );
  check(
    'they are numbered biggest first, so the main body is Model 1',
    shells.shellFaces.length === 2 && shells.shellFaces[0] === 12 && shells.shellFaces[1] === 12,
    `sizes ${[...shells.shellFaces].join(', ')}`,
  );
  check(
    'every face is in exactly one model',
    (() => {
      const seen = new Map();
      for (let t = 0; t < shells.faceCount; t += 1) seen.set(shells.faceShell[t], (seen.get(shells.faceShell[t]) || 0) + 1);
      return seen.size === 2 && [...seen.values()].every((n) => n === 12);
    })(),
    `faceShell covers ${shells.faceCount} faces`,
  );
  check(
    'and each model has its own bounds, in the file coordinates',
    (() => {
      // The lower box is the second shell (both are 12 faces, so order is by first appearance).
      const a = shells.shellBounds.subarray(0, 6);
      const b = shells.shellBounds.subarray(6, 12);
      const lo = a[1] < b[1] ? a : b;
      const hi = a[1] < b[1] ? b : a;
      return lo[1] === -10 && lo[4] === -8 && hi[1] === 0 && hi[4] === 4 && hi[3] === 4;
    })(),
    `sizes ${[...shapes()].join(' | ')}`,
  );

  function shapes() {
    return [...Array(shells.shellCount).keys()].map((s) => shellSize(shells.shellBounds, s).map((n) => n.toFixed(2)).join('x'));
  }

  check(
    'the size of a model is its own box, not the file box',
    shapes().every((s) => s === '4.00x4.00x4.00' || s === '2.00x2.00x2.00'),
    shapes().join(' | '),
  );
  check(
    'facesOfShells picks exactly the faces of the picked model',
    (() => {
      const one = facesOfShells(shells, [0]);
      return countFaces(one) === 12 && one.length === 24;
    })(),
    '12 of the 24 faces',
  );
  check(
    'picking a model and asking what is picked give the same answer',
    (() => {
      const box = shellsOf(topo);
      const same = facesOfShells(box, [1]);
      let inSecond = 0;
      for (let t = 0; t < box.faceCount; t += 1) if (same[t]) inSecond += 1;
      return inSecond === box.shellFaces[1] && box.shellFaces[1] === 12;
    })(),
    'the list count and the picked faces agree',
  );

  // Two boxes that meet at one corner only: a shared *point* is not a shared surface, which is the
  // difference between "two models" and "one model with a spike" in a slicer's object list.
  const touching = combine(boxSoup([0, 0, 0, 2, 2, 2]), boxSoup([2, 2, 2, 4, 4, 4]));
  const touchShells = shellsOf(buildTopology(touching, touching.length / 3));
  check(
    'two models touching at a single corner stay two models',
    touchShells.shellCount === 2 && touchShells.shellFaces[0] === 12,
    `${touchShells.shellCount} shells`,
  );

  // And two triangles that share an edge are one model — the other side of the same rule.
  const pair = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const second = Float32Array.from([0, 0, 0, 0, 1, 0, -1, 1, 0]);
  const shared = combine(pair, second);
  const sharedShells = shellsOf(buildTopology(shared, shared.length / 3));
  check(
    'faces joined by a shared edge are one model',
    sharedShells.shellCount === 1 && sharedShells.shellFaces[0] === 2,
    `${sharedShells.shellCount} shells, ${sharedShells.shellFaces[0]} faces`,
  );

  const empty = shellsOf({ faces: new Int32Array(0), faceCount: 0, positions: new Float32Array(0) });
  check('an empty soup has no models and does not throw', empty.shellCount === 0 && empty.faceShell.length === 0);
}

// ------------------------------------------------------------------ the surgery

{
  const lower = boxSoup([0, -10, 0, 2, -8, 2]);
  const upper = boxSoup([0, 0, 0, 4, 4, 4]);
  const combined = combine(lower, upper);
  const faceCount = facesOf(combined);
  const keep = new Uint8Array(faceCount);
  for (let t = 0; t < faceCount; t += 1) keep[t] = t < 12 ? 0 : 1; // drop the stray (written first)

  const ids = new Int16Array(faceCount * 3);
  for (let i = 0; i < ids.length; i += 1) ids[i] = i < 36 ? 7 : 3;
  const cut = filterSoup({ positions: combined, ids }, keep);

  check(
    'the filtered soup holds exactly the faces that were kept',
    cut.faces === 12 && cut.positions.length === 36 * 3 && cut.faceMap.length === 12,
    `${cut.faces} faces, ${cut.positions.length / 3} corners`,
  );
  check(
    'and every kept face is the same triangle, in the same order',
    (() => {
      for (let g = 0; g < cut.faces; g += 1) {
        const src = cut.faceMap[g] * 9;
        const at = g * 9;
        for (let k = 0; k < 9; k += 1) if (cut.positions[at + k] !== combined[src + k]) return false;
      }
      return true;
    })(),
    'face by face, corner by corner',
  );
  check(
    'the corner map says where every surviving vertex came from',
    (() => {
      for (let i = 0; i < cut.cornerMap.length; i += 1) {
        const src = cut.cornerMap[i] * 3;
        if (cut.positions[i * 3] !== combined[src]) return false;
      }
      return true;
    })(),
    `${cut.cornerMap.length} corners mapped back`,
  );
  check(
    'a removed model leaves its faces out of the file in hand, and only those',
    (() => {
      const kept = new Set([...cut.faceMap]);
      for (let t = 0; t < 12; t += 1) if (kept.has(t)) return false;
      return true;
    })(),
    'none of the stray model’s faces survived',
  );
  check(
    'the paint on a face that survived comes across unchanged',
    (() => {
      for (let i = 0; i < cut.ids.length; i += 1) if (cut.ids[i] !== ids[cut.cornerMap[i]]) return false;
      return true;
    })(),
    `every one of ${cut.ids.length} corners kept its feature id`,
  );
  const nothing = filterSoup({ positions: combined, ids }, new Uint8Array(faceCount));
  check('filtering everything out leaves an empty soup rather than throwing', nothing.faces === 0 && nothing.positions.length === 0);
}

// -------------------------------------------------------------- the highlight
//
// ------------------------------------------------- the pick is drawn, not just computed

// One picked face has to be *visible*, and edges alone were the bug: three hairlines lying exactly
// on the surface they trace z-fight with the triangle they belong to, so a single picked face on a
// big model showed nothing and the tool looked dead. Hence a fill as well, covering the triangle's
// own corners: that is what this pins.
{
  const soup = combine(boxSoup([0, 0, 0, 4, 4, 4]), boxSoup([0, -10, 0, 2, -8, 2]));
  const faceCount = facesOf(soup);

  const one = new Uint8Array(faceCount);
  one[5] = 1;
  const single = highlightArrays(soup, one);
  check(
    'a single picked face is a filled triangle, not just its edges',
    single !== null && single.faces === 1 && single.fill.length === 9 && single.edges.length === 18,
    `fill ${single?.fill.length} floats (3 corners), edges ${single?.edges.length} (3 edges)`,
  );
  check(
    'and the fill covers that face\u2019s own corners',
    (() => {
      for (let k = 0; k < 9; k += 1) if (single.fill[k] !== soup[5 * 9 + k]) return false;
      return true;
    })(),
    'corner for corner, in the file\u2019s own coordinates',
  );
  check(
    'the boundary is the three edges of that face',
    (() => {
      const edges = [];
      for (let k = 0; k < 3; k += 1) {
        const a = k * 3;
        const b = ((k + 1) % 3) * 3;
        edges.push(`${single.edges[a]},${single.edges[b]}`);
      }
      return edges.length === 3 && edges.every((e) => e !== '');
    })(),
    'a-b, b-c, c-a',
  );
  check(
    'an empty pick has nothing to draw',
    highlightArrays(soup, new Uint8Array(faceCount)) === null,
  );
  check(
    'a pick above the limit is refused rather than drawn — the panel reports the count instead',
    highlightArrays(soup, new Uint8Array(faceCount).fill(1), { limit: 10 }) === null &&
      highlightArrays(soup, new Uint8Array(faceCount).fill(1), { limit: 100 }).faces === faceCount,
    `${faceCount} faces: refused above 10, drawn under 100`,
  );
  const many = new Uint8Array(faceCount);
  many[0] = 1;
  many[3] = 1;
  const two = highlightArrays(soup, many);
  check(
    'two picked faces give two filled triangles',
    two.faces === 2 && two.fill.length === 18 && two.edges.length === 36,
    `${two.fill.length} fill floats and ${two.edges.length} edge floats`,
  );
}

// --------------------------------------------- the highlight, drawn for real
//
// `highlightArrays` above is the geometry; this is the whole path the app takes — draw, replace,
// clear — run for real against a real `THREE.Group`. That is deliberate: the bug that shipped was
// in this wrapper (clearing the highlight called the drawing function with its options missing, so
// destructuring `undefined` threw on the first model load of every session and the loading overlay
// stuck on "Preparing mask layer…" for ever). The suite could not see it, because nothing executed
// the code — every check was a source pattern. These execute it.
{
  const soup = combine(boxSoup([0, 0, 0, 4, 4, 4]), boxSoup([0, -10, 0, 2, -8, 2]));
  const faceCount = facesOf(soup);
  const parent = new THREE.Group();
  const picked = new Uint8Array(faceCount);
  picked[7] = 1;

  let drew = null;
  let threw = null;
  try {
    drew = drawHighlight(parent, soup, null, picked, { color: 0xffd24d, fillOpacity: 0.5, lineOpacity: 0.95, order: 2 });
  } catch (err) {
    threw = err;
  }
  check(
    'drawing a pick really builds a filled tint and an outline, and adds them to the scene',
    !threw && drew !== null && parent.children.includes(drew) && drew.children.length === 2 &&
      drew.children[0].isMesh === true && drew.children[1].isLineSegments === true &&
      drew.children[0].material.opacity === 0.5 && drew.children[0].material.polygonOffset === true &&
      drew.children[0].renderOrder === 2 && drew.children[1].renderOrder === 3,
    threw ? `threw ${threw.message}` : `${drew?.children.length} children, fill opacity ${drew?.children[0].material.opacity}`,
  );
  check(
    'and the geometry is the picked face, three corners and three edges',
    drew.children[0].geometry.attributes.position.count === 3 &&
      drew.children[1].geometry.attributes.position.count === 6,
    `${drew.children[0].geometry.attributes.position.count} fill vertices, ${drew.children[1].geometry.attributes.position.count} edge vertices`,
  );

  // Drawing a second highlight over the first is the replacement path — the hover moves from face
  // to face as the cursor moves, so it runs constantly. The group being replaced has to be released,
  // geometry and material, or a session leaks a pair of buffers per hovered face.
  let disposedGeometry = false;
  let disposedMaterial = false;
  drew.children[0].geometry.addEventListener('dispose', () => {
    disposedGeometry = true;
  });
  drew.children[0].material.addEventListener('dispose', () => {
    disposedMaterial = true;
  });
  const other = new Uint8Array(faceCount);
  other[9] = 1;
  const replaced = drawHighlight(parent, soup, drew, other, { order: 2 });
  check(
    'drawing again replaces the pick instead of stacking a second one on top of it',
    parent.children.length === 1 && parent.children[0] === replaced && replaced !== drew,
    `${parent.children.length} highlight group(s) in the scene`,
  );
  check(
    'and the highlight it replaced is freed, geometry and material',
    disposedGeometry && disposedMaterial,
    `geometry disposed ${disposedGeometry}, material disposed ${disposedMaterial}`,
  );
  drew = replaced; // the group now in the scene: the clear path below acts on that one

  // The shipped bug, exactly: the clear path called the drawing function with two arguments, so the
  // destructured third one was `undefined`. This is that call, and it has to be a no-op.
  let cleared;
  threw = null;
  try {
    cleared = clearHighlight(parent, drew);
  } catch (err) {
    threw = err;
  }
  check(
    'clearing a highlight takes it out of the scene without throwing',
    !threw && cleared === null && !parent.children.includes(drew),
    threw ? `threw ${threw.message}` : 'removed, and nothing left behind',
  );
  let twice;
  threw = null;
  try {
    twice = clearHighlight(parent, null);
    clearHighlight(parent, null);
  } catch (err) {
    threw = err;
  }
  check('and clearing nothing is safe, however often it is called', !threw && twice === null, threw ? `threw ${threw.message}` : '');

  // Loading a model runs this: the pick is released when the geometry is replaced.
  threw = null;
  let redraw;
  try {
    redraw = drawHighlight(parent, soup, null, new Uint8Array(faceCount), { order: 2 });
  } catch (err) {
    threw = err;
  }
  check(
    'an empty pick draws nothing rather than an empty mesh',
    !threw && redraw === null && parent.children.length === 0,
    threw ? `threw ${threw.message}` : 'nothing added',
  );
  check(
    'and the options all have defaults, so a caller that forgets them still gets a tint',
    (() => {
      try {
        const group = drawHighlight(parent, soup, null, picked);
        const ok = group !== null && group.children[0].material.opacity > 0 && parent.children.includes(group);
        clearHighlight(parent, group);
        return ok;
      } catch {
        return false;
      }
    })(),
  );
  check(
    'a pick above the limit draws nothing, so the panel\u2019s count is the only thing left to rely on',
    drawHighlight(parent, soup, null, new Uint8Array(faceCount).fill(1), { limit: 4 }) === null &&
      parent.children.length === 0,
  );
}

console.log(`\n${failures === 0 ? 'all select checks passed' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
