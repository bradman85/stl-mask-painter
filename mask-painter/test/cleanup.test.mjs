// Trimming a mask down to what a printer can use, and putting a model that arrived far from the
// origin back onto the grid.
//
//   node test/cleanup.test.mjs
//
// The trim is checked twice: on a synthetic mesh with a known answer (three islands of different
// sizes, so "which ones go" is arithmetic rather than judgement), and on the bundled figure — a
// blob where the mask belongs plus two stray dabs — where it has to release exactly the dabs,
// keep the blob's vertices bit for bit, and land in the undo history as one step.
//
// The window list is checked on the two cases a size threshold cannot reach at all: a mask that
// is one connected region — two panels that touch, which is exactly what Shift-clicking the
// neighbouring panel produces, and what made "Trim islands" look like a dead button — and the
// largest window itself, which the trim is forbidden from releasing and the list has to.
//
// The centring transform is checked as arithmetic on real boxes: the model group moves, and the
// geometry it holds does not, because the mask is per vertex, the panels are per face and every
// export is written in the file's own coordinates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { MaskLayer } from '../js/mask.js';
import { createFeatureList } from '../js/features.js';
import { buildTopology } from '../js/stencil.js';
import { paintedIslands, planIslandTrim, maskWindows } from '../js/cleanup.js';
import { buildParts, partSoupVertices, DEFAULT_SEAM_ANGLE } from '../js/parts.js';
import { centreTranslation } from '../js/viewer.js';
import { parseBinarySTL, paintSpheres, fmt } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- the rule, on a made-up mesh
//
// Three islands on the y = 0 plane: a 4-unit square (the mask proper), a 0.5-unit square (small
// but above any sane threshold) and a 0.05-unit triangle (a speck). Each has a known bounding
// box, so the trimmed set can be named exactly.
function syntheticSoup() {
  const positions = [];
  const put = (x, z, s) => {
    const a = [x, 0, z];
    const b = [x + s, 0, z];
    const c = [x + s, 0, z + s];
    const d = [x, 0, z + s];
    positions.push(...a, ...b, ...c);
    positions.push(...a, ...c, ...d);
  };
  put(0, 0, 4); // main square: 6 file vertices, welded to 4
  put(20, 0, 0.5); // small square: 6 file vertices, welded to 4
  const t = [40, 0, 0];
  positions.push(...t, t[0] + 0.05, t[1], t[2], t[0], t[1], t[2] + 0.05); // speck: 3 file vertices
  return Float32Array.from(positions);
}

{
  const positions = syntheticSoup();
  const vertexCount = positions.length / 3;
  const topo = buildTopology(positions, vertexCount);
  const speck = [12, 13, 14];
  const small = [6, 7, 8, 9, 10, 11];
  const all = new Int16Array(vertexCount).fill(1);

  check('the made-up mesh welds to three islands', topo.wCount === 11, `${topo.wCount} welded vertices`);

  const all3 = paintedIslands(topo, all);
  check(
    'three painted islands, biggest first',
    all3.islands.length === 3 &&
      all3.islands[0].vertices === 4 &&
      all3.islands[1].vertices === 4 &&
      all3.islands[2].vertices === 3,
    all3.islands.map((i) => `${i.vertices}v/${i.diagonal.toFixed(2)}d`).join(' '),
  );
  check(
    'island sizes are the boxes the vertices span',
    Math.abs(all3.islands[0].diagonal - Math.hypot(4, 0, 4)) < 1e-6 &&
      Math.abs(all3.islands[2].diagonal - Math.hypot(0.05, 0, 0.05)) < 1e-6,
    `${all3.islands[0].diagonal.toFixed(3)} and ${all3.islands[2].diagonal.toFixed(3)}`,
  );

  // --- what a threshold releases (island diagonals: 5.66, 0.71, 0.07)
  const one = planIslandTrim({ topology: topo, ids: all, minDiagonal: 0.3 });
  check(
    'a threshold between the speck and the small square releases only the speck',
    one.doomedIslands === 1 && one.released.join(',') === speck.join(','),
    `${one.doomedIslands} island(s), released ${one.released.join(',')} (${fmt(one.doomedVertices)} vertices)`,
  );
  const justOver = planIslandTrim({ topology: topo, ids: all, minDiagonal: 0.72 });
  check(
    'just over the small square, it goes too — one island at the threshold is enough',
    justOver.doomedIslands === 2 && justOver.released.length === small.length + speck.length,
    `${justOver.doomedIslands} island(s), released ${justOver.released.length} vertices`,
  );
  const two = planIslandTrim({ topology: topo, ids: all, minDiagonal: 0.8 });
  check(
    'both small islands go when the threshold passes them',
    two.doomedIslands === 2 && two.released.join(',') === [...small, ...speck].join(','),
    `released ${two.released.length} vertices`,
  );
  const zero = planIslandTrim({ topology: topo, ids: all, minDiagonal: 0 });
  check('a threshold of 0 releases nothing', zero.doomedIslands === 0 && zero.released.length === 0);
  const huge = planIslandTrim({ topology: topo, ids: all, minDiagonal: 100 });
  check(
    'a threshold above every island keeps the biggest one and says so',
    huge.doomedIslands === 2 && huge.sparedLargest && huge.released.join(',') === [...small, ...speck].join(','),
    `${huge.doomedIslands} doomed, spared ${huge.sparedLargest}`,
  );

  // --- the plan is a plan: it reports, it does not paint
  const idsCopy = Int16Array.from(all);
  planIslandTrim({ topology: topo, ids: all, minDiagonal: 0.3 });
  check('planning leaves the mask alone', all.every((v, i) => v === idsCopy[i]));

  // --- welding decides what is one island
  const halfSquare = new Int16Array(vertexCount);
  for (let i = 0; i < 3; i += 1) halfSquare[i] = 1; // one triangle of the main square only
  const half = paintedIslands(topo, halfSquare);
  check(
    'one triangle of a welded square is one island of its three shared corners',
    half.islands.length === 1 && half.islands[0].vertices === 3,
    `${half.islands.length} island(s), ${half.islands.length ? half.islands[0].vertices : 0} vertices`,
  );

  // Two sheets that meet at a single welded vertex are one island — a bowtie, which the stencil
  // builder also treats as connected — so a size test cannot split them.
  const bowPositions = Float32Array.from([
    0, 0, 0, 0.05, 0, 0, 0, 0, 0.05,
    0, 0, 0, 5.05, 0, 0, 5, 0, 0.05, // shares the corner at the origin
  ]);
  const bowTopo = buildTopology(bowPositions, 6);
  const bow = planIslandTrim({ topology: bowTopo, ids: new Int16Array(6).fill(1), minDiagonal: 1 });
  check(
    'two sheets sharing one vertex stay one island, so nothing is trimmed',
    bow.islands === 1 && bow.doomedIslands === 0,
    `${bow.islands} island(s), ${bow.doomedIslands} doomed`,
  );

  // --- the window list: every island with the file vertices behind it
  const windows = maskWindows(topo, all);
  check(
    'the list names every window with the file vertices behind it, largest first',
    windows.length === 3 &&
      windows[0].fileVertices.join(',') === '0,1,2,3,4,5' &&
      windows[1].fileVertices.join(',') === small.join(',') &&
      windows[2].fileVertices.join(',') === speck.join(','),
    windows.map((w) => `${w.vertices}v/${w.diagonal.toFixed(2)}d`).join(' '),
  );
  check(
    'a window carries its size and the box it spans',
    Math.abs(windows[0].diagonal - Math.hypot(4, 0, 4)) < 1e-6 &&
      windows[0].centre.every((n, k) => Math.abs(n - [2, 0, 2][k]) < 1e-6),
    `centre ${windows[0].centre.join(', ')}`,
  );
  check(
    'a window knows which feature painted it',
    windows[0].features.length === 1 && windows[0].features[0].id === 1 && windows[0].features[0].vertices === 6,
    windows[0].features.map((f) => `${f.id}:${f.vertices}`).join(' '),
  );
  const mixed = Int16Array.from(all);
  mixed[0] = 2;
  mixed[1] = 2;
  check(
    'a window painted with two features reports both, biggest group first',
    (() => {
      const w = maskWindows(topo, mixed)[0];
      return w.features.length === 2 && w.features[0].id === 1 && w.features[0].vertices === 4 && w.features[1].id === 2 && w.features[1].vertices === 2;
    })(),
    maskWindows(topo, mixed)[0].features.map((f) => `${f.id}:${f.vertices}`).join(' '),
  );
  check(
    'the list and the trim describe the same islands',
    windows.length === all3.islands.length &&
      windows.map((w) => w.diagonal.toFixed(3)).join() === all3.islands.map((i) => i.diagonal.toFixed(3)).join(),
  );
  // The list is the way to reach the island the trim is forbidden to touch: the largest.
  const removed = new Int16Array(all);
  for (const i of windows[0].fileVertices) removed[i] = 0;
  const afterRemove = paintedIslands(topo, removed);
  check(
    'releasing the largest window\'s vertices takes out that window and nothing else',
    afterRemove.islands.length === 2 &&
      afterRemove.islands.every((isl) => isl.vertices === 4 || isl.vertices === 3) &&
      removed.join(',') !== all.join(','),
    `${afterRemove.islands.length} island(s) left, ${fmt(removed.reduce((n, v) => n + (v ? 1 : 0), 0))} vertices`, );
}

// ---------------------------------------------------------------- the bundled model
const parsed = parseBinarySTL(fs.readFileSync(path.resolve(here, '../../Sprunki Mercuy.stl')));
const positions = Float32Array.from(parsed.positions);
const vertexCount = positions.length / 3;
const topo = buildTopology(positions, vertexCount);

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.computeBoundingBox();
const box = geometry.boundingBox;
const centre = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());

/** Frontmost surface point inside a band, so a stamp is guaranteed to land on the model. */
function frontMost(centreY, spreadY) {
  let best = null;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (Math.abs(y - centreY) > spreadY) continue;
    if (!best || z > best[2]) best = [x, y, z];
  }
  return best;
}

{
  const mask = new MaskLayer(geometry, createFeatureList());
  const blob = frontMost(centre.y + size.y * 0.05, size.y * 0.12);
  const dabA = frontMost(centre.y - size.y * 0.36, size.y * 0.03);
  const dabB = frontMost(centre.y + size.y * 0.42, size.y * 0.03);
  const where = (p) => (p ? p.map((n) => n.toFixed(1)).join(', ') : 'none');
  check(
    'three stamps land on the model',
    !!(blob && dabA && dabB),
    `blob at ${where(blob)}, dabs at ${where(dabA)} and ${where(dabB)}`,
  );

  const blobRadius = topo.diagonal * 0.075;
  const dabRadius = topo.diagonal * 0.006; // about 0.8 units on this model
  mask.beginStroke();
  mask.paintSphere(blob, blobRadius, 1);
  mask.endStroke();
  mask.beginStroke();
  mask.paintSphere(dabA, dabRadius, 2);
  mask.paintSphere(dabB, dabRadius, 2);
  mask.endStroke();
  const painted = mask.stats().painted;
  check('the mask has a blob and two dabs', painted > 0, `${fmt(painted)} vertices painted`);
  check(
    'both dabs are painted as their own feature',
    (mask.stats().counts.get(2) || 0) > 0,
    `${fmt(mask.stats().counts.get(2) || 0)} vertices with the dab feature`,
  );

  // Independent expectation of the dab regions, from the sphere test rather than from the mask.
  const dabs = paintSpheres(positions, [
    [...dabA, dabRadius],
    [...dabB, dabRadius],
  ]);
  const before = Int16Array.from(mask.ids);
  const t0 = performance.now();
  const plan = planIslandTrim({
    topology: topo,
    ids: mask.ids,
    minDiagonal: topo.diagonal * 0.02, // the panel's default: 2% of the model's size
  });
  const planMs = performance.now() - t0;
  console.log(
    `      ${fmt(plan.islands)} islands on the bundled figure, ${fmt(painted)} vertices painted, ` +
      `threshold ${plan.threshold.toFixed(2)} units, plan in ${planMs.toFixed(0)} ms`,
  );

  check(
    'the blob and the two dabs come back as three islands',
    plan.islands === 3,
    `${plan.islands} islands: ${plan.details.map((d) => `${fmt(d.vertices)}v/${d.diagonal.toFixed(2)}d`).join(' ')}`,
  );
  check(
    'the plan releases exactly the two dabs',
    plan.doomedIslands === 2 && plan.released.length === dabs.count,
    `${plan.doomedIslands} island(s), released ${fmt(plan.released.length)} vs ${fmt(dabs.count)} dab vertices`,
  );
  let mismatched = 0;
  for (const i of plan.released) if (!dabs.painted[i]) mismatched += 1;
  check('and nothing else', mismatched === 0 && plan.doomedVertices === dabs.count, `${mismatched} released outside the dabs`);
  check(
    'the mask proper is untouched by the plan',
    before.every((v, i) => v === mask.ids[i]) && plan.doomedVertices < painted,
    `${fmt(painted - plan.doomedVertices)} of ${fmt(painted)} vertices kept`,
  );
  check('a plan is fast enough to sit behind a button', planMs < 1500, `${planMs.toFixed(0)} ms`);

  // --- the edit the app makes: one stroke, one undo step, exact
  const historyBefore = mask.history.length;
  mask.beginStroke();
  const changed = mask.paintIndices(plan.released, 0);
  const recorded = mask.endStroke();
  mask.flush();
  check(
    'the trim lands as one undo step that releases exactly the plan',
    recorded && mask.history.length === historyBefore + 1 && changed === plan.released.length,
    `${changed} vertices, history ${historyBefore} -> ${mask.history.length}`,
  );
  check(
    'the blob keeps its own feature count after the trim',
    (mask.stats().counts.get(1) || 0) === (Int16Array.from(before).reduce((n, v) => n + (v === 1 ? 1 : 0), 0)),
    `${fmt(mask.stats().counts.get(1) || 0)} vertices still painted with the blob feature`,
  );
  check(
    'the mask is smaller by the dabs and nothing else',
    mask.stats().painted === painted - plan.doomedVertices,
    `${fmt(mask.stats().painted)} vs ${fmt(painted - plan.doomedVertices)}`,
  );
  const after = planIslandTrim({ topology: topo, ids: mask.ids, minDiagonal: plan.threshold });
  check('trimming again finds nothing to trim', after.doomedIslands === 0, `${after.islands} island(s)`);

  mask.undo();
  let diff = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== mask.ids[i]) diff += 1;
  check('undo puts every dab vertex back, exactly', diff === 0, `${fmt(diff)} vertices differ`);
  mask.redo();
  check('and redo trims again', mask.stats().painted === painted - plan.doomedVertices, `${fmt(mask.stats().painted)} painted`);
  mask.undo();
}

// ------------------------------------------------- the window list on the bundled figure
//
// Two shapes of mask, both of which a size threshold fails on — the report that started this:
//
//   a) two panels that touch (a Shift-click on the panel next to the one selected) weld into a
//      single painted region, so "Trim islands", at 2%, 50% or 99%, releases nothing at all and
//      the button reads as dead. It is not: there is one window, and the only way to be rid of
//      part of it is to name it.
//   b) the largest window, which the trim is deliberately never allowed to release — "the mask
//      is right except for the big lump" is exactly the case it refuses.
{
  const parts = buildParts(topo, { seamAngleDeg: DEFAULT_SEAM_ANGLE });
  // Panels that touch: two panels are neighbours when their faces share a welded vertex. (In an
  // STL soup adjacent triangles share no vertex index, which is why this has to go through the
  // weld — the same reason the islands do.)
  const owner = new Map();
  const touch = new Map();
  for (let f = 0; f < parts.facePart.length; f += 1) {
    const p = parts.facePart[f];
    for (let k = 0; k < 3; k += 1) {
      const w = topo.faces[f * 3 + k];
      const seen = owner.get(w);
      if (seen === undefined) {
        owner.set(w, p);
        continue;
      }
      if (seen === p) continue;
      if (!touch.has(p)) touch.set(p, new Set());
      if (!touch.has(seen)) touch.set(seen, new Set());
      touch.get(p).add(seen);
      touch.get(seen).add(p);
    }
  }
  const order = parts.partSizes.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]);
  const pick = order.find(([n, i]) => n > 1500 && n < 6000 && touch.get(i) && touch.get(i).size > 0);
  check('the figure has a mid-size panel with a neighbour to Shift-click', !!pick, pick ? `${fmt(pick[0])} faces` : 'none found');
  const panel = pick[1];
  const neighbour = [...touch.get(panel)].sort((a, b) => parts.partSizes[b] - parts.partSizes[a])[0];
  const paintPanel = (m, id, which) => {
    m.beginStroke();
    m.paintIndices(partSoupVertices(parts, which, []), id);
    m.endStroke();
  };

  // --- a) two panels that touch are one window
  const touching = new MaskLayer(geometry, createFeatureList());
  paintPanel(touching, 1, panel);
  paintPanel(touching, 2, neighbour);
  const paintedTouching = touching.stats().painted;
  const touchingWindows = maskWindows(topo, touching.ids);
  console.log(
    `      panels ${panel + 1} (${fmt(parts.partSizes[panel])} faces) + ${neighbour + 1} ` +
      `(${fmt(parts.partSizes[neighbour])}): ${fmt(paintedTouching)} vertices, ` +
      `${touchingWindows.length} window(s) ${touchingWindows[0].diagonal.toFixed(1)} units across`,
  );
  check(
    'two panels that touch are one painted window, not two',
    touchingWindows.length === 1,
    `${touchingWindows.length} window(s)`,
  );
  check(
    'so no threshold releases anything here — 2%, 50% and 99% included',
    [0, 2, 50, 99, 100].every(
      (pct) =>
        planIslandTrim({ topology: topo, ids: touching.ids, minDiagonal: (pct / 100) * topo.diagonal }).doomedIslands === 0,
    ),
    `island diagonals: ${touchingWindows.map((w) => w.diagonal.toFixed(1)).join(', ')}`,
  );
  check(
    'and the window names both panels and both features, so it can be acted on',
    touchingWindows[0].features.length === 2 &&
      touchingWindows[0].fileVertices.length === paintedTouching &&
      [...touch.get(panel)].includes(neighbour),
    touchingWindows[0].features.map((f) => `${f.id}:${fmt(f.vertices)}`).join(' + '),
  );
  // Remove: the vertices the row carries, released in one undo step, exactly.
  const touchingBefore = Int16Array.from(touching.ids);
  touching.beginStroke();
  const removedTouching = touching.paintIndices(touchingWindows[0].fileVertices, 0);
  const recordedTouching = touching.endStroke();
  touching.flush();
  check(
    'Remove releases exactly that window — the one the trim could never touch',
    recordedTouching && removedTouching === paintedTouching && touching.stats().painted === 0,
    `${fmt(removedTouching)} of ${fmt(paintedTouching)} vertices, ${touching.history.length} undo step(s)`,
  );
  touching.undo();
  let touchingDiff = 0;
  for (let i = 0; i < touchingBefore.length; i += 1) if (touchingBefore[i] !== touching.ids[i]) touchingDiff += 1;
  check('and one undo puts every vertex back', touching.stats().painted === paintedTouching && touchingDiff === 0, `${touchingDiff} differ`);

  // --- b) blob + two dabs: the window list reaches the largest window too
  const mask = new MaskLayer(geometry, createFeatureList());
  const blob = frontMost(centre.y + size.y * 0.05, size.y * 0.12);
  const dabA = frontMost(centre.y - size.y * 0.36, size.y * 0.03);
  mask.beginStroke();
  mask.paintSphere(blob, topo.diagonal * 0.075, 1);
  mask.endStroke();
  mask.beginStroke();
  mask.paintSphere(dabA, topo.diagonal * 0.006, 2);
  mask.endStroke();
  const painted = mask.stats().painted;
  const windows = maskWindows(topo, mask.ids);
  check(
    'the list comes back largest first, with the dabs after the blob',
    windows.length === 2 && windows[0].features[0].id === 1 && windows[1].features[0].id === 2,
    windows.map((w) => `${fmt(w.vertices)}v/${w.diagonal.toFixed(2)}d/${w.features[0].id}`).join(' '),
  );
  check(
    'every file vertex of the mask is in exactly one window',
    windows.reduce((n, w) => n + w.vertices, 0) === painted &&
      new Set(windows.flatMap((w) => w.fileVertices)).size === painted,
    `${fmt(painted)} painted, ${fmt(windows.reduce((n, w) => n + w.vertices, 0))} across ${windows.length} window(s)`,
  );
  // The largest window goes, and the dabs stay: the trim's rule forbids exactly this.
  const keptDab = Int16Array.from(mask.ids);
  mask.beginStroke();
  const removedBlob = mask.paintIndices(windows[0].fileVertices, 0);
  mask.endStroke();
  mask.flush();
  const left = maskWindows(topo, mask.ids);
  check(
    'Remove takes out the largest window and keeps the rest',
    removedBlob === windows[0].vertices && left.length === 1 && left[0].features[0].id === 2 &&
      left[0].diagonal.toFixed(3) === windows[1].diagonal.toFixed(3),
    `removed ${fmt(removedBlob)} vertices, ${left.length} window(s) left`,
  );
  const widest = planIslandTrim({ topology: topo, ids: keptDab, minDiagonal: topo.diagonal });
  check(
    'a threshold at every setting could not have done that — it spares the largest by rule',
    widest.sparedLargest && widest.doomedIslands === 1 &&
      widest.released.length === windows[1].vertices &&
      !widest.released.includes(windows[0].fileVertices[0]),
    `${fmt(widest.doomedVertices)} vertices released, largest spared`,
  );
  // Keep only: every other window released, leaving exactly this one.
  const keepOnly = Int16Array.from(keptDab);
  mask.undo();
  mask.beginStroke();
  const others = maskWindows(topo, mask.ids).filter((w) => w.features[0].id !== 2);
  const removedOthers = mask.paintIndices(others.flatMap((w) => w.fileVertices), 0);
  mask.endStroke();
  mask.flush();
  const kept = maskWindows(topo, mask.ids);
  check(
    'Keep only leaves exactly the window it names',
    kept.length === 1 && kept[0].features[0].id === 2 && removedOthers === painted - kept[0].vertices,
    `${fmt(removedOthers)} released, ${fmt(kept[0].vertices)} kept (mask had ${fmt(painted)})`,
  );
  check(
    'and the mask it leaves is the dab, not the blob',
    kept[0].diagonal.toFixed(3) === maskWindows(topo, keepOnly)[1].diagonal.toFixed(3),
    `${kept[0].diagonal.toFixed(2)} units across`,
  );
}

// ---------------------------------------------------------------- centring on the grid
//
// The transform is a pure offset for a bounding box, so it can be checked as arithmetic — and
// because it is applied to the model group, the file's own coordinates (and therefore the mask,
// the panels and every export) never move. `test/ui-wiring.test.mjs` pins that second half by
// source: the centring code may only write `group.position`.
{
  const offOrigin = new THREE.Box3(new THREE.Vector3(100, 0, -80), new THREE.Vector3(160, 103.4, -27));
  const offset = centreTranslation(offOrigin);
  check(
    'a model 130 units from the origin is moved back onto the grid centre',
    Math.abs(offset.x + 130) < 1e-9 && Math.abs(offset.y) < 1e-9 && Math.abs(offset.z - 53.5) < 1e-9,
    `offset ${offset.toArray().map((n) => n.toFixed(2)).join(', ')}`,
  );
  const moved = offOrigin.clone().translate(offset);
  const movedCentre = moved.getCenter(new THREE.Vector3());
  check(
    'after the offset the footprint centre is on the origin and the lowest point is on the grid',
    Math.abs(movedCentre.x) < 1e-9 && Math.abs(movedCentre.z) < 1e-9 && Math.abs(moved.min.y) < 1e-9,
    `centre ${movedCentre.toArray().map((n) => n.toFixed(2)).join(', ')}, min y ${moved.min.y.toFixed(2)}`,
  );

  const centredAlready = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10));
  const noMove = centreTranslation(centredAlready);
  check(
    'a model that is already centred and sitting on the grid is not moved',
    noMove.length() < 1e-9,
    `offset ${noMove.toArray().map((n) => n.toFixed(3)).join(', ')}`,
  );

  // The bundled model: its own box, and the promise that measuring it changes nothing.
  const first = [positions[0], positions[1], positions[2]];
  const real = centreTranslation(new THREE.Box3().setFromBufferAttribute(geometry.attributes.position));
  const realMoved = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position).clone().translate(real);
  const realCentre = realMoved.getCenter(new THREE.Vector3());
  check(
    'the bundled model lands centred with its feet on the grid',
    Math.abs(realCentre.x) < 1e-6 && Math.abs(realCentre.z) < 1e-6 && Math.abs(realMoved.min.y) < 1e-6,
    `offset ${real.toArray().map((n) => n.toFixed(1)).join(', ')}`,
  );
  check(
    'and the model coordinates the mask and the exports use are untouched',
    positions[0] === first[0] && positions[1] === first[1] && positions[2] === first[2],
    `${positions[0].toFixed(3)}, ${positions[1].toFixed(3)}, ${positions[2].toFixed(3)}`,
  );
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all cleanup checks passed'}`);
process.exit(failures ? 1 : 0);
