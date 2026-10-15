// Trimming a mask down to what a printer can use, and putting a model that arrived far from the
// origin back onto the grid.
//
//   node test/cleanup.test.mjs
//
// The trim is checked twice: on a synthetic mesh with a known answer (three islands of different
// sizes, so "which ones go" is arithmetic rather than judgement), and on the bundled figure — a
// blob where the mask belongs plus a stray dab — where it has to release exactly the dab, keep the
// blob's corners bit for bit, and land in the undo history as one step.
//
// The window list is checked on the two cases a size threshold cannot reach at all: a selection
// that is one connected region — two panels that touch, which is exactly what Shift-clicking the
// neighbouring panel with the Part tool produces, and what made "Trim islands" look like a dead
// button — and the largest window itself, which the trim is forbidden from releasing and the list
// has to.
//
// The selection is written the way the app writes it throughout: a set of faces, through
// `paintedFromFaces` into the mask layer the analysis reads. Nothing here paints.
//
// The centring transform is checked as arithmetic on real boxes: the model group moves, and the
// geometry it holds does not, because the mask is per vertex, the panels are per face and every
// export is written in the file's own coordinates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { SelectionTint } from '../js/mask.js';
import {
  createSelection,
  countSelected,
  applyFaces,
  paintedFromFaces,
  facesFromVertices,
  facesFromPainted,
  SelectionHistory,
} from '../js/selection.js';
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
  // A window is a window: the analysis is about which corners are selected, not about why. A mask
  // that carries two different ids in one connected region is still one window — which is the
  // shape the old palette could produce and the analysis has to keep reading.
  const mixed = Int16Array.from(all);
  mixed[0] = 2;
  mixed[1] = 2;
  const mixedWindows = maskWindows(topo, mixed);
  check(
    'two ids in one connected region are one window: the analysis is about the selection',
    mixedWindows.length === 3 && mixedWindows[0].vertices === 6,
    `${mixedWindows.length} window(s), largest ${fmt(mixedWindows[0].vertices)} corners`,
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

// ------------------------------------------------------------- the trim on the bundled figure
//
// Selected the way the app selects: two regions of the surface taken as sets of triangles — the
// blob the window is about, and one stray dab far from it — written into the selection and shown
// through the mask layer. The expectation for the dab is independent of the mask (a sphere test on
// the model's own coordinates), so "the plan releases the dab" is a comparison rather than a
// restatement of the code under test.
{
  const faces = vertexCount / 3;
  const tint = new SelectionTint(geometry);
  const selection = createSelection(faces);
  const history = new SelectionHistory();
  const show = () => tint.setSelection(paintedFromFaces(selection));

  const blobAt = frontMost(centre.y + size.y * 0.05, size.y * 0.12);
  const dabAt = frontMost(centre.y - size.y * 0.36, size.y * 0.03);
  const where = (p) => (p ? p.map((n) => n.toFixed(1)).join(', ') : 'none');
  check(
    'the blob and the dab land on the model',
    !!(blobAt && dabAt),
    `blob at ${where(blobAt)}, dab at ${where(dabAt)}`,
  );

  const blobRadius = topo.diagonal * 0.075;
  const dabRadius = topo.diagonal * 0.006; // about 0.8 units on this model
  const blobFlags = paintSpheres(positions, [[...blobAt, blobRadius]]);
  const dabFlags = paintSpheres(positions, [[...dabAt, dabRadius]]);
  // The two steps the app takes: the faces a region covers, then the mask those faces mean.
  applyFaces(selection, facesFromPainted(blobFlags.painted, faces));
  applyFaces(selection, facesFromPainted(dabFlags.painted, faces), { add: true });
  show();
  const painted = tint.stats().painted;
  check(
    'the selection reaches the mask as corners, and the dab is part of it',
    painted > 0 && dabFlags.count > 0 && painted === countSelected(selection) * 3,
    `${fmt(painted)} corners for ${fmt(countSelected(selection))} faces, dab ${fmt(dabFlags.count)} vertices`,
  );

  const beforeIds = Int16Array.from(tint.ids);
  const t0 = performance.now();
  const plan = planIslandTrim({
    topology: topo,
    ids: tint.ids,
    // 5% of the model's size: the dab is a couple of triangles wide, and a selection made of
    // whole triangles is a little larger than the sphere it was built around.
    minDiagonal: topo.diagonal * 0.05,
  });
  const planMs = performance.now() - t0;
  console.log(
    `      ${fmt(plan.islands)} islands on the bundled figure, ${fmt(painted)} corners selected, ` +
      `threshold ${plan.threshold.toFixed(2)} units, plan in ${planMs.toFixed(0)} ms`,
  );

  check(
    'the blob and the dab come back as two islands',
    plan.islands === 2,
    `${plan.islands} islands: ${plan.details.map((d) => `${fmt(d.vertices)}v/${d.diagonal.toFixed(2)}d`).join(' ')}`,
  );
  check('the plan releases the dab', plan.doomedIslands === 1, `${plan.doomedIslands} island(s)`);

  // Independent expectation: every corner the plan releases is on the dab — or within one mesh
  // edge of it, which is how far a triangle selected because *one* of its corners is on the dab
  // reaches past it. Nothing from the blob may appear.
  const reach = dabRadius + topo.meanEdgeLength;
  const near = (point, c) =>
    Math.hypot(positions[c * 3] - point[0], positions[c * 3 + 1] - point[1], positions[c * 3 + 2] - point[2]) <= reach;
  let stray = 0;
  for (const c of plan.released) if (!near(dabAt, c)) stray += 1;
  check(
    'and nothing else — not one corner of the blob',
    stray === 0 && plan.doomedVertices < painted,
    `${stray} released corners outside the dab, ${fmt(painted - plan.doomedVertices)} of ${fmt(painted)} kept`,
  );
  check(
    'the plan is a plan: the selection and the mask are untouched',
    beforeIds.every((v, i) => v === tint.ids[i]) && countSelected(selection) > 0,
    `${fmt(countSelected(selection))} faces still selected`,
  );
  check('a plan is fast enough to sit behind a button', planMs < 1500, `${planMs.toFixed(0)} ms`);

  // --- the edit the app makes: one history entry, exact
  const wanted = new Uint8Array(faces);
  for (const c of plan.released) wanted[Math.floor(c / 3)] = 1;
  history.remember(selection);
  const changed = applyFaces(selection, wanted, { remove: true });
  show();
  check(
    'the trim lands as one undo step that releases exactly the plan',
    history.undoStack.length === 1 && changed > 0 && tint.stats().painted === painted - changed * 3,
    `${fmt(changed)} faces unselected, mask ${fmt(painted)} -> ${fmt(tint.stats().painted)} corners`,
  );
  check(
    'the blob keeps every corner it had after the trim',
    (() => {
      let kept = 0;
      for (let c = 0; c < tint.ids.length; c += 1) if (beforeIds[c] && tint.ids[c]) kept += 1;
      let lost = 0;
      for (let c = 0; c < tint.ids.length; c += 1) if (beforeIds[c] && !tint.ids[c] && !plan.released.includes(c)) lost += 1;
      return lost === 0 && kept === tint.stats().painted;
    })(),
    `${fmt(tint.stats().painted)} corners left, all of them already selected`,
  );
  const again = planIslandTrim({ topology: topo, ids: tint.ids, minDiagonal: plan.threshold });
  check('trimming again finds nothing to trim', again.doomedIslands === 0, `${again.islands} island(s)`);

  history.undo(selection);
  show();
  let diff = 0;
  for (let i = 0; i < beforeIds.length; i += 1) if (beforeIds[i] !== tint.ids[i]) diff += 1;
  check('undo puts every dab corner back, exactly', diff === 0 && tint.stats().painted === painted, `${fmt(diff)} corners differ`);
  history.redo(selection);
  show();
  check('and redo trims again', tint.stats().painted === painted - changed * 3, `${fmt(tint.stats().painted)} corners`);
  history.undo(selection);
  show();
}

// ------------------------------------------------- the window list on the bundled figure
//
// Two shapes of selection, both of which a size threshold fails on — the report that started this:
//
//   a) two panels that touch (a Shift-click on the panel next to the one selected) weld into a
//      single window, so "Trim islands", at 2%, 50% or 99%, releases nothing at all and the button
//      reads as dead. It is not: there is one window, and the only way to be rid of part of it is
//      to name it.
//   b) the largest window, which the trim is deliberately never allowed to release — "the mask is
//      right except for the big lump" is exactly the case it refuses.
{
  const faces = vertexCount / 3;
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

  const tint = new SelectionTint(geometry);
  const selection = createSelection(faces);
  const history = new SelectionHistory();
  const show = () => tint.setSelection(paintedFromFaces(selection));
  /** What the Part tool does to the selection: a panel, as the faces its own corners belong to. */
  const addPanel = (which) => {
    const wanted = facesFromVertices(partSoupVertices(parts, which, []), faces);
    const changed = applyFaces(selection, wanted, { add: true });
    show();
    return changed;
  };
  const windowFaceCount = (w) => new Set(w.fileVertices.map((c) => Math.floor(c / 3))).size;
  /** What a window row's Remove does: release the faces that window covers. */
  const releaseWindow = (w) => {
    const wanted = new Uint8Array(faces);
    for (const c of w.fileVertices) wanted[Math.floor(c / 3)] = 1;
    history.remember(selection);
    const changed = applyFaces(selection, wanted, { remove: true });
    show();
    return changed;
  };

  // --- a) two panels that touch are one window
  addPanel(panel);
  addPanel(neighbour);
  const paintedTouching = tint.stats().painted;
  const touchingWindows = maskWindows(topo, tint.ids);
  console.log(
    `      panels ${panel + 1} (${fmt(parts.partSizes[panel])} faces) + ${neighbour + 1} ` +
      `(${fmt(parts.partSizes[neighbour])}): ${fmt(paintedTouching)} corners, ` +
      `${touchingWindows.length} window(s) ${touchingWindows[0].diagonal.toFixed(1)} units across`,
  );
  check(
    'two panels that touch are one window, not two',
    touchingWindows.length === 1,
    `${touchingWindows.length} window(s)`,
  );
  check(
    'so no threshold releases anything here — 2%, 50% and 99% included',
    [0, 2, 50, 99, 100].every(
      (pct) =>
        planIslandTrim({ topology: topo, ids: tint.ids, minDiagonal: (pct / 100) * topo.diagonal }).doomedIslands === 0,
    ),
    `island diagonals: ${touchingWindows.map((w) => w.diagonal.toFixed(1)).join(', ')}`,
  );
  check(
    'and the window carries both panels, so it can be acted on',
    touchingWindows[0].fileVertices.length === paintedTouching &&
      windowFaceCount(touchingWindows[0]) === countSelected(selection) &&
      [...touch.get(panel)].includes(neighbour),
    `${fmt(windowFaceCount(touchingWindows[0]))} faces in one window`,
  );

  // Remove: the faces the row carries, released in one undo step, exactly.
  const touchingBefore = Uint8Array.from(selection.faces);
  const removedTouching = releaseWindow(touchingWindows[0]);
  check(
    'Remove releases exactly that window — the one the trim could never touch',
    removedTouching === touchingBefore.reduce((n, v) => n + v, 0) && tint.stats().painted === 0 &&
      history.undoStack.length === 1,
    `${fmt(removedTouching)} faces unselected, ${fmt(tint.stats().painted)} corners left`,
  );
  history.undo(selection);
  show();
  let touchingDiff = 0;
  for (let t = 0; t < touchingBefore.length; t += 1) if (touchingBefore[t] !== selection.faces[t]) touchingDiff += 1;
  check('and one undo puts every face back', tint.stats().painted === paintedTouching && touchingDiff === 0, `${touchingDiff} differ`);

  // --- b) blob + one dab: the window list reaches the largest window too
  applyFaces(selection, new Uint8Array(faces)); // a plain gesture replaces: start from nothing
  const blobAt = frontMost(centre.y + size.y * 0.05, size.y * 0.12);
  const dabAt = frontMost(centre.y - size.y * 0.36, size.y * 0.03);
  const blobFlags = paintSpheres(positions, [[...blobAt, topo.diagonal * 0.075]]);
  const dabFlags = paintSpheres(positions, [[...dabAt, topo.diagonal * 0.006]]);
  applyFaces(selection, facesFromPainted(blobFlags.painted, faces));
  applyFaces(selection, facesFromPainted(dabFlags.painted, faces), { add: true });
  show();
  const painted = tint.stats().painted;
  const windows = maskWindows(topo, tint.ids);
  check(
    'the list comes back largest first, with the dab after the blob',
    windows.length === 2 && windows[0].vertices > windows[1].vertices && windows[0].diagonal > windows[1].diagonal,
    windows.map((w) => `${fmt(w.vertices)}v/${w.diagonal.toFixed(2)}d`).join(' '),
  );
  check(
    'every selected corner of the mask is in exactly one window',
    windows.reduce((n, w) => n + w.vertices, 0) === painted &&
      new Set(windows.flatMap((w) => w.fileVertices)).size === painted,
    `${fmt(painted)} selected, ${fmt(windows.reduce((n, w) => n + w.vertices, 0))} across ${windows.length} window(s)`,
  );
  // The largest window goes, and the dab stays: the trim's rule forbids exactly this.
  const keptDabIds = Int16Array.from(tint.ids);
  const removedBlob = releaseWindow(windows[0]);
  const left = maskWindows(topo, tint.ids);
  check(
    'Remove takes out the largest window and keeps the rest',
    removedBlob === windowFaceCount(windows[0]) && left.length === 1 &&
      left[0].diagonal.toFixed(3) === windows[1].diagonal.toFixed(3),
    `released ${fmt(removedBlob)} faces, ${left.length} window(s) left`,
  );
  const widest = planIslandTrim({ topology: topo, ids: keptDabIds, minDiagonal: topo.diagonal });
  check(
    'a threshold at every setting could not have done that — it spares the largest by rule',
    widest.sparedLargest && widest.doomedIslands === 1 &&
      widest.released.length === windows[1].vertices &&
      !widest.released.includes(windows[0].fileVertices[0]),
    `${fmt(widest.doomedVertices)} corners released, largest spared`,
  );
  // Keep only: every other window released, leaving exactly this one.
  history.undo(selection);
  show();
  const all = maskWindows(topo, tint.ids);
  const keepIndex = all.length - 1;
  const wantedOthers = new Uint8Array(faces);
  for (const w of all.filter((w) => w !== all[keepIndex])) {
    for (const c of w.fileVertices) wantedOthers[Math.floor(c / 3)] = 1;
  }
  history.remember(selection);
  const removedOthers = applyFaces(selection, wantedOthers, { remove: true });
  show();
  const kept = maskWindows(topo, tint.ids);
  check(
    'Keep only leaves exactly the window it names',
    kept.length === 1 && removedOthers > 0 && tint.stats().painted === kept[0].vertices &&
      kept[0].diagonal.toFixed(3) === all[keepIndex].diagonal.toFixed(3),
    `${fmt(removedOthers)} faces released, ${fmt(kept[0].vertices)} corners kept (mask had ${fmt(tint.stats().painted)})`,
  );
  check(
    'and the mask it leaves is the dab, not the blob',
    kept[0].diagonal.toFixed(3) === windows[1].diagonal.toFixed(3),
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
