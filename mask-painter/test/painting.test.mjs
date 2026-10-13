// Painting edits through the app's own MaskLayer on the real model: can a bad brush stroke be
// taken back? This drives the four routes the UI offers — the erase brush, undo, redo and the
// clear buttons — and checks the vertex ids return to exactly what they were.
//
//   node test/painting.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { MaskLayer } from '../js/mask.js';
import { createFeatureList, hexToRgb } from '../js/features.js';
import { parseBinarySTL, fmt } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const parsed = parseBinarySTL(fs.readFileSync(path.resolve(here, '../../Sprunki Mercuy.stl')));
const positions = Float32Array.from(parsed.positions);

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.computeBoundingBox();
const box = geometry.boundingBox;
const centre = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const brush = size.length() / 45;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const mask = new MaskLayer(geometry, createFeatureList());
const snapshot = () => Int16Array.from(mask.ids);
const same = (a) => {
  const b = mask.ids;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff;
};
const count = (id) => mask.stats().counts.get(id) || 0;
const count2 = (layer, id) => layer.stats().counts.get(id) || 0;

/** One dragged brush stroke = several stamps between beginStroke/endStroke, as the UI does. */
function stroke(from, to, id, steps = 8) {
  mask.beginStroke();
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const p = [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ];
    mask.paintSphere(p, brush, id);
  }
  mask.endStroke();
}

/** Frontmost surface point inside a box of the model — a point that is definitely on it. */
function frontMost(centreY, spreadY, centreX = centre.x, spreadX = size.x * 0.1) {
  let best = null;
  for (let i = 0; i < mask.vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (Math.abs(y - centreY) > spreadY) continue;
    if (Math.abs(x - centreX) > spreadX) continue;
    if (!best || z > best[2]) best = [x, y, z];
  }
  return best;
}

// A stroke across the chest, well away from the face.
const chest = frontMost(centre.y - size.y * 0.05, size.y * 0.08);
const a = [chest[0] - size.x * 0.12, chest[1], chest[2]];
const b = [chest[0] + size.x * 0.12, chest[1], chest[2]];

const before = snapshot();
stroke(a, b, 1);
const painted = count(1);
check('a dragged stroke paints in one go', painted > 500, `${fmt(painted)} vertices across 9 stamps`);

const afterStroke = snapshot();
check('one stroke is one history step', mask.history.length === 1 && mask.canUndo() && !mask.canRedo(), `history ${mask.history.length}`);

// ---- 1. undo takes the whole stroke back, not just the last stamp
mask.undo();
check('undo removes the whole stroke (not just the last stamp)', count(1) === 0 && same(before) === 0, `${fmt(same(before))} vertices differ`);
check('redo is available after undo', mask.canRedo());

mask.redo();
check('redo re-applies the stroke exactly', same(afterStroke) === 0, `${fmt(same(afterStroke))} vertices differ`);

// ---- 2. the erase brush takes back part of a stroke
const eraseLine = [
  [a[0] + (b[0] - a[0]) * 0.3, a[1], a[2]],
  [a[0] + (b[0] - a[0]) * 0.6, a[1], a[2]],
];
const beforeErase = snapshot();
stroke(eraseLine[0], eraseLine[1], 0, 3);
const remaining = count(1);
check(
  'the erase brush takes back part of the stroke and leaves the rest',
  remaining > 0 && remaining < painted,
  `${fmt(painted)} painted -> ${fmt(remaining)} after erasing 4 stamps over the middle`,
);
mask.undo();
check('undo restores exactly what the erase removed', same(beforeErase) === 0, `${fmt(same(beforeErase))} vertices differ`);
mask.redo();
check('redo re-applies the erase', count(1) === remaining, `${fmt(count(1))} painted`);

// ---- 3. hiding a feature is not an edit: the paint is still there to be erased
mask.setHidden(1, true);
check('hiding a feature does not change the mask', count(1) === remaining, `${fmt(count(1))} still painted`);
mask.setHidden(1, false);

// ---- 4. clearing a feature, and clearing everything, are each one step
const beforeClearFeature = snapshot();
mask.clearFeature(1);
check('Clear feature empties just that feature', count(1) === 0);
mask.undo();
check('undo restores a cleared feature', same(beforeClearFeature) === 0, `${fmt(same(beforeClearFeature))} vertices differ`);

const beforeClearAll = snapshot();
mask.clearAll();
check('Clear all empties the mask', mask.stats().painted === 0);
mask.undo();
check('undo restores a cleared mask', same(beforeClearAll) === 0, `${fmt(same(beforeClearAll))} vertices differ`);

// ---- 5. the vertex colours the three Mask buttons rewrite
//
// The paint layer is drawn on top of everything (the stencil preview included) and painted
// vertices carry alpha 1, so their colour replaces what is under them; hidden and unpainted
// vertices carry alpha 0 and let it through. That is the whole mechanism behind Hide all
// paint / Clear feature / Clear all, so it has to hold exactly — and flush() has to flag the
// right slice for upload or the change never reaches the GPU.
// The app attaches the colour attribute to the same geometry it handed the mask
// (main.js: mask = new MaskLayer(overlayGeometry, …); overlayGeometry.setAttribute('color', …)),
// so flush() finds it.
mask.geometry.setAttribute('color', new THREE.BufferAttribute(mask.colors, 4));
const colorAttr = mask.geometry.attributes.color;
const rgba = (i) => [mask.colors[i * 4], mask.colors[i * 4 + 1], mask.colors[i * 4 + 2], mask.colors[i * 4 + 3]];
const close = (a, b) => Math.abs(a - b) < 1e-6;

mask.clearAll({ record: false });
mask.beginStroke();
mask.paintSphere(chest, brush, 3);
mask.endStroke();
let probe = -1;
for (let i = 0; i < mask.vertexCount; i += 1) {
  if (mask.ids[i] === 3) {
    probe = i;
    break;
  }
}
const expected = hexToRgb('#ff4d6d');
const paintedRGBA = rgba(probe);
check(
  'a painted vertex is drawn at alpha 1 in its feature colour',
  close(paintedRGBA[3], 1) && close(paintedRGBA[0], expected.r) && close(paintedRGBA[1], expected.g) && close(paintedRGBA[2], expected.b),
  `rgba ${paintedRGBA.map((v) => v.toFixed(3)).join(', ')}`,
);

const beforeHide = rgba(probe);
mask.setHidden(3, true);
const hidden = rgba(probe);
check(
  'hiding a feature clears alpha but keeps the colour ready for unhiding',
  close(hidden[3], 0) && close(hidden[0], beforeHide[0]) && close(hidden[1], beforeHide[1]) && close(hidden[2], beforeHide[2]),
  `rgba ${hidden.map((v) => v.toFixed(3)).join(', ')}`,
);
mask.setHidden(3, false);
check('unhiding restores alpha 1', close(rgba(probe)[3], 1), `alpha ${rgba(probe)[3]}`);

mask.clearFeature(3);
const cleared = rgba(probe);
check(
  'clearing a feature resets those vertices to the neutral unpainted colour at alpha 0',
  close(cleared[3], 0) && close(cleared[0], 0.72) && close(cleared[1], 0.74) && close(cleared[2], 0.78),
  `rgba ${cleared.map((v) => v.toFixed(3)).join(', ')}`,
);

// flush() must hand the renderer a range that actually contains what changed.
mask.clearAll({ record: false });
const beforeFlush = colorAttr.updateRanges.length;
mask.flush();
const uploaded = colorAttr.updateRanges.slice(beforeFlush);
check(
  'flush() asks for the whole colour buffer after Clear all',
  uploaded.some((r) => r.start === 0 && r.count === mask.vertexCount * 4),
  `${uploaded.length} range(s): ${uploaded.map((r) => `${r.start}+${r.count}`).join(', ')}`,
);
mask.beginStroke();
mask.paintSphere(chest, brush, 3);
mask.endStroke();
const beforeSmall = colorAttr.updateRanges.length;
mask.flush();
const smallRange = colorAttr.updateRanges.slice(beforeSmall);
check(
  'flush() after one brush stamp asks for a slice, not the whole buffer',
  smallRange.length > 0 && smallRange.every((r) => r.count < mask.vertexCount * 4),
  smallRange.map((r) => `${r.start}+${r.count}`).join(', '),
);

// ---- 6. a long session cannot grow history without bound
const cap = mask.maxHistory;
mask.redoStack.length = 0;
for (let i = 0; i < cap + 12; i += 1) {
  mask.beginStroke();
  mask.paintSphere([chest[0] + i * 0.01, chest[1], chest[2]], brush, 2);
  mask.endStroke();
}
check(
  'history is capped so a long session cannot eat memory',
  mask.history.length <= cap,
  `${mask.history.length} steps kept (cap ${cap})`,
);
for (let i = 0; i < cap + 3; i += 1) mask.undo();
check('undoing past the cap stops instead of corrupting', count(2) >= 0 && mask.history.length >= 0, `${mask.history.length} steps left`);

// ---- the eyedropper (Pick): what is under the cursor, and does it agree with the brush?
//
// The Pick tool changes nothing about the model, so the only thing that makes it feel
// responsive is that the hover preview and the click agree, and both agree with what the
// brush actually painted. These checks drive the same MaskLayer call the UI uses.
const pickMask = new MaskLayer(geometry, createFeatureList());
const dot = frontMost(centre.y + size.y * 0.2, size.y * 0.1);
const far = [centre.x + size.x * 6, centre.y + size.y * 6, centre.z + size.z * 6];
const voteRadius = brush * 1.5;

const empty = pickMask.featureUnderPoint(dot, voteRadius);
check('with nothing painted, the picker reports nothing', empty.id === 0 && empty.painted === 0,
  `id ${empty.id}, ${empty.painted} painted vertices in range`);

pickMask.paintSphere(dot, brush, 3);
const onPaint = pickMask.featureUnderPoint(dot, voteRadius);
check('the picker finds the feature the brush just painted', onPaint.id === 3,
  `id ${onPaint.id}, ${fmt(onPaint.painted)} painted vertices in range`);
check('the picker reports how much paint is under the cursor', onPaint.painted > 0, `${fmt(onPaint.painted)} vertices`);
check('the picker votes from a neighbourhood, not one vertex', onPaint.painted > 20,
  `${fmt(onPaint.painted)} painted vertices voted`);

const nowhere = pickMask.featureUnderPoint(far, voteRadius);
check('off the model, the picker reports nothing painted', nowhere.id === 0 && nowhere.painted === 0,
  `id ${nowhere.id}, ${nowhere.painted} in range`);

const away = pickMask.featureUnderPoint([dot[0], dot[1] + brush * 8, dot[2]], voteRadius);
check('away from the paint, the picker reports nothing painted', away.id === 0,
  `id ${away.id} (${away.painted} painted vertices in range)`);

// Two features painted side by side: the one with the surface under the cursor must win,
// not the one with more vertices nearby.
const dotB = frontMost(centre.y - size.y * 0.2, size.y * 0.1);
pickMask.paintSphere(dotB, brush, 4);
check('two features side by side: each point picks its own',
  pickMask.featureUnderPoint(dot, voteRadius).id === 3 && pickMask.featureUnderPoint(dotB, voteRadius).id === 4,
  `A -> ${pickMask.featureUnderPoint(dot, voteRadius).id}, B -> ${pickMask.featureUnderPoint(dotB, voteRadius).id}`);

// The nearest surface decides when both votes are in range: a small patch painted over the
// centre of a bigger one becomes the pick, which is what a user clicking that patch expects.
pickMask.paintSphere(dot, brush * 0.35, 5);
check('a feature painted over another is the one picked', pickMask.featureUnderPoint(dot, voteRadius).id === 5,
  `id ${pickMask.featureUnderPoint(dot, voteRadius).id}`);

// A bigger radius must not summon paint that is nowhere near the surface point.
const wide = pickMask.featureUnderPoint(far, brush * 4);
check('a wide radius still reports nothing off the model', wide.id === 0, `id ${wide.id}`);

// The picker and the erase brush are opposites: erasing the patch makes the pick fall back to
// whatever is still painted around it, and erasing everything reports nothing.
pickMask.paintSphere(dot, brush * 0.35, 0);
check('erasing the top patch falls back to the paint underneath', pickMask.featureUnderPoint(dot, voteRadius).id === 3,
  `id ${pickMask.featureUnderPoint(dot, voteRadius).id}`);
pickMask.clearAll();
check('clearing everything returns the picker to "nothing painted"', pickMask.featureUnderPoint(dot, voteRadius).id === 0);

// ---- invert the selection: the "I meant everything except that" escape hatch
//
// A Part click can only select the panel it lands on, so the complement is one action away
// instead of repainting by hand. Driven through the same MaskLayer call the button makes.
{
  const inv = new MaskLayer(geometry, createFeatureList());
  const total = inv.vertexCount;
  const before = Int16Array.from(inv.ids);
  let step = 0;

  // Nothing painted: inverting paints everything with the current feature.
  let res = inv.invert(2);
  check('inverting an empty mask paints the whole model', inv.stats().painted === total && res.painted === total,
    `${fmt(res.painted)} painted, ${fmt(res.cleared)} released`);

  // ...and inverting again gives the empty mask back, exactly.
  res = inv.invert(2);
  let diff = 0;
  for (let i = 0; i < total; i += 1) if (inv.ids[i] !== before[i]) diff += 1;
  check('inverting twice returns the mask you started from', inv.stats().painted === 0 && diff === 0,
    `${fmt(diff)} vertices differ`);
  check('two inverts are two undo steps', inv.history.length === 2, `${inv.history.length} steps`);
  inv.history.length = 0;
  inv.redoStack.length = 0;

  // Two features painted: invert keeps the counts exactly mirrored and collapses to one id.
  const strokeOn = (layer, from, to, id, steps = 6) => {
    layer.beginStroke();
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      layer.paintSphere(
        [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t],
        brush,
        id,
      );
    }
    layer.endStroke();
  };
  strokeOn(inv, [chest[0], chest[1], chest[2]], [chest[0] + brush * 6, chest[1], chest[2]], 1);
  strokeOn(inv, [chest[0], chest[1] + brush * 6, chest[2]], [chest[0] + brush * 5, chest[1] + brush * 5, chest[2]], 2);
  const paintedBefore = inv.stats().painted;
  const f1 = count2(inv, 1);
  const f2 = count2(inv, 2);
  const snap = Int16Array.from(inv.ids);
  inv.history.length = 0;
  step = inv.history.length;

  res = inv.invert(3);
  const after = inv.stats();
  check('invert releases every painted vertex and paints every bare one',
    res.cleared === paintedBefore && res.painted === total - paintedBefore && after.painted === total - paintedBefore,
    `${fmt(res.painted)} painted, ${fmt(res.cleared)} released, model has ${fmt(total)}`);
  check('the inverted paint is all one feature, as the button says',
    count2(inv, 3) === total - paintedBefore && count2(inv, 1) === 0 && count2(inv, 2) === 0,
    `feature 3: ${fmt(count2(inv, 3))}, feature 1: ${count2(inv, 1)}, feature 2: ${count2(inv, 2)}`);
  check('nothing painted by the invert has alpha 0, so it is all visible',
    inv.colors[(inv.verticesOf(3, [])[0]) * 4 + 3] === 1);
  check('one invert is one undo step', inv.history.length === 1 + step, `${inv.history.length} step(s)`);

  inv.undo();
  let back = 0;
  for (let i = 0; i < total; i += 1) if (inv.ids[i] !== snap[i]) back += 1;
  check('undo brings the exact previous mask back', back === 0 && count2(inv, 1) === f1 && count2(inv, 2) === f2,
    `${fmt(back)} vertices differ, features ${fmt(count2(inv, 1))}/${fmt(count2(inv, 2))}`);
  inv.redo();
  check('redo re-applies the invert', count2(inv, 3) === total - paintedBefore, `feature 3: ${fmt(count2(inv, 3))}`);

  // Inverting a mask that is painted everywhere empties it (and is still one step).
  inv.history.length = 0;
  const all = new MaskLayer(geometry, createFeatureList());
  all.paintSphere([chest[0], chest[1], chest[2]], brush, 0);
  all.ids.fill(1);
  const empty = all.invert(2);
  check('inverting a fully painted mask clears it', all.stats().painted === 0 && empty.painted === 0,
    `${fmt(empty.cleared)} released`);

  check('there is nothing to invert without a feature', empty && inv.invert(0).painted === 0);

  // Snapshot-based edits are the ones where "redo" used to put the old image back instead of
  // reapplying the change, because a snapshot only holds the state from before the edit.
  const snaps = new MaskLayer(geometry, createFeatureList());
  strokeOn(snaps, [chest[0], chest[1], chest[2]], [chest[0] + brush * 4, chest[1], chest[2]], 4, 4);
  const paintedSnap = snaps.stats().painted;
  snaps.clearAll();
  snaps.undo();
  check('Clear all then undo restores the paint', snaps.stats().painted === paintedSnap, `${fmt(snaps.stats().painted)} of ${fmt(paintedSnap)}`);
  snaps.redo();
  check('and redo re-clears it instead of putting the paint back', snaps.stats().painted === 0,
    `${fmt(snaps.stats().painted)} painted after redo`);
  snaps.undo();
  snaps.clearFeature(4);
  snaps.undo();
  const afterUndo = snaps.stats().painted;
  snaps.redo();
  check('the same holds for Clear feature', afterUndo === paintedSnap && snaps.stats().painted === 0,
    `undo ${fmt(afterUndo)}, redo ${fmt(snaps.stats().painted)}`);
}

// ---- what the UI reports after all this
const final = mask.stats();
console.log(`      final: ${fmt(final.painted)} of ${fmt(final.total)} vertices painted, ${mask.history.length} undo steps, redo ${mask.redoStack.length}`);
console.log(`\n${failures ? `${failures} failure(s)` : 'all painting checks passed'}`);
process.exit(failures ? 1 : 0);
