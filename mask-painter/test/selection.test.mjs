// The one selection: the faces every tool writes, and the stencil is built from.
//
//   node test/selection.test.mjs
//
// This is the module the app's central claim rests on — "a panel selected with Part and the
// triangles picked with Select faces are the same selection, and Build stencil uses all of it" —
// so it is checked as arithmetic rather than by reading source: what a plain gesture does to the
// selection, what Shift and Alt do, what happens to corners, and what an undo puts back.
//
// The negative half matters as much as the positive one, and is written as such: a plain gesture
// must *replace* (not toggle each face it covers, which is how a box drag becomes a selection
// nobody can reason about), a gesture that changes nothing must not leave an undo step, and a
// cut must not silently point the history at the wrong triangles.

import * as THREE from '../vendor/three.module.js';
import { SelectionTint } from '../js/mask.js';
import {
  SELECTION_ID,
  SELECTION_COLOR,
  UNPAINTED_ID,
  MAX_FEATURE_ID,
  hexToRgb,
  createSelection,
  countSelected,
  isSelected,
  applyFaces,
  countChanges,
  setAll,
  invertSelection,
  faceOfCorner,
  paintedFromFaces,
  facesFromVertices,
  facesFromPainted,
  remapSelection,
  SelectionHistory,
} from '../js/selection.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const fmt = (n) => Number(n).toLocaleString('en-US');

// ---------------------------------------------------------------- the shape of a selection

{
  const sel = createSelection(10);
  check(
    'a selection is a flag per face, and starts empty',
    sel.faceCount === 10 && sel.faces.length === 10 && sel.faces instanceof Uint8Array && countSelected(sel) === 0,
    `${sel.faceCount} faces, ${sel.faces.constructor.name}`,
  );
  check('faces are the unit, not vertices: a 900-triangle model is a 900-long selection', createSelection(900).faces.length === 900);
  check('a silly face count is clamped rather than believed', createSelection(-5).faces.length === 0 && createSelection(NaN).faces.length === 0);
  check(
    'the one id a selected corner carries is not 0',
    SELECTION_ID === 1 && UNPAINTED_ID === 0 && MAX_FEATURE_ID > SELECTION_ID,
    `id ${SELECTION_ID}, unselected ${UNPAINTED_ID}`,
  );
  check(
    'there is one colour, and it parses',
    /^#[0-9a-f]{6}$/i.test(SELECTION_COLOR) && hexToRgb(SELECTION_COLOR).r > 0.9 && hexToRgb('#123456').b === 0x56 / 255,
    `${SELECTION_COLOR} -> ${JSON.stringify(hexToRgb(SELECTION_COLOR))}`,
  );
  check('a colour that is not a colour does not throw', hexToRgb('amber').r === 0.5 && hexToRgb(null).g === 0.5);
}

// ------------------------------------------------------------------- the three gestures

{
  const sel = createSelection(8);
  const band = new Uint8Array(8);
  band[2] = band[3] = band[4] = 1;

  const first = applyFaces(sel, band);
  check(
    'a plain gesture selects what it covers',
    first === 3 && countSelected(sel) === 3 && isSelected(sel, 3) && !isSelected(sel, 5),
    `${fmt(first)} faces changed`,
  );
  // The behaviour the whole model hangs on: a second plain gesture that overlaps but is not the
  // same set leaves *exactly* the new set behind — face 2 drops out even though it was covered
  // before and is not covered now, and nothing else is toggled.
  const other = new Uint8Array(8);
  other[3] = other[4] = other[5] = other[6] = 1;
  const second = applyFaces(sel, other);
  check(
    'a second plain gesture replaces rather than merging',
    second === 3 && countSelected(sel) === 4 && !isSelected(sel, 2) && isSelected(sel, 5) && isSelected(sel, 6),
    `${fmt(second)} faces changed, ${fmt(countSelected(sel))} selected`,
  );
  const again = applyFaces(sel, other);
  check(
    'and selecting what is already selected changes nothing — so nothing is undone',
    again === 0 && countChanges(sel, other) === 0,
    `${fmt(again)} faces changed`,
  );

  const added = applyFaces(sel, band, { add: true });
  check(
    'Shift adds to the selection and keeps the rest',
    added === 1 && countSelected(sel) === 5 && isSelected(sel, 2) && isSelected(sel, 6),
    `${fmt(added)} faces added`,
  );
  const removed = applyFaces(sel, band, { remove: true });
  check(
    'Alt takes off what it covers and keeps the rest',
    removed === 3 && countSelected(sel) === 2 && !isSelected(sel, 3) && isSelected(sel, 6),
    `${fmt(removed)} faces removed, ${fmt(countSelected(sel))} left`,
  );
  const noop = applyFaces(sel, band, { remove: true });
  check('removing what is not selected is a no-op', noop === 0 && countChanges(sel, band, { remove: true }) === 0);

  const empty = applyFaces(sel, new Uint8Array(8));
  check('a gesture that covers nothing clears the selection', empty === 2 && countSelected(sel) === 0, `${fmt(empty)} faces changed`);

  // A widget shorter than the model: the faces it does not speak for must not be invented.
  const partial = createSelection(20);
  const short = new Uint8Array(4).fill(1);
  applyFaces(partial, short, { add: true });
  check(
    'a widget shorter than the selection stops at its own length',
    countSelected(partial) === 4 && isSelected(partial, 3) && !isSelected(partial, 4),
    `${fmt(countSelected(partial))} faces selected of 20`,
  );
  const tooLong = new Uint8Array(30).fill(1);
  const clamped = createSelection(20);
  applyFaces(clamped, tooLong, { add: true });
  check('and one longer than the selection cannot overrun it', countSelected(clamped) === 20 && clamped.faces.length === 20);
  check('a missing selection is not a crash', applyFaces(null, band) === 0 && countChanges(null, band) === 0 && countSelected(null) === 0 && !isSelected(null, 0));
}

// ------------------------------------------------------------------------------ whole model

{
  const sel = createSelection(6);
  check('select all takes the lot', setAll(sel, true) === 6 && countSelected(sel) === 6);
  check('select none takes it all away', setAll(sel, false) === 0 && countSelected(sel) === 0);
  sel.faces[1] = sel.faces[4] = 1;
  check(
    'invert swaps what is selected for what is not',
    invertSelection(sel) === 4 && !isSelected(sel, 1) && !isSelected(sel, 4) && isSelected(sel, 0) && isSelected(sel, 5),
    `${fmt(countSelected(sel))} selected after inverting`,
  );
  invertSelection(sel);
  check('and inverting twice is where it started', countSelected(sel) === 2 && isSelected(sel, 1) && isSelected(sel, 4));
  check('inverting an empty selection is a crash-free select-all', invertSelection(createSelection(0)) === 0);
}

// ------------------------------------------------------- faces and corners, the one bridge

{
  check(
    'corner 7 belongs to face 2, because a soup repeats every vertex per triangle',
    faceOfCorner(0) === 0 && faceOfCorner(2) === 0 && faceOfCorner(3) === 1 && faceOfCorner(7) === 2,
    `corners 0-2 -> face 0, 3-5 -> face 1`,
  );
  const sel = createSelection(4);
  sel.faces[0] = 1;
  sel.faces[3] = 1;
  const painted = paintedFromFaces(sel);
  check(
    'a selected face marks all three of its corners, and nothing else',
    painted.length === 12 && painted.join('') === '111000000111' && painted[0] === 1 && painted[2] === 1 && painted[3] === 0,
    painted.join(''),
  );
  check('and the corner count is three per face', painted.reduce((n, v) => n + v, 0) === countSelected(sel) * 3);
  const reused = paintedFromFaces(sel, painted);
  check('a scratch array of the right size is reused rather than reallocated', reused === painted);
  check('one of the wrong size is not written into', paintedFromFaces(sel, new Uint8Array(5)) !== null && paintedFromFaces(sel, new Uint8Array(5)).length === 12);
  check('an empty selection paints nothing', paintedFromFaces(createSelection(4)).every((v) => v === 0));
  check('and a missing one does not throw', paintedFromFaces(null).length === 0);

  // A seam panel arrives as soup vertices and becomes faces — the join Part uses.
  const indices = [3, 4, 5, 9, 10, 11, 1000];
  const faces = facesFromVertices(indices, 6);
  check(
    'a panel of soup vertices becomes the faces those corners belong to',
    faces.length === 6 && faces[1] === 1 && faces[3] === 1 && faces.join('') === '010100' && facesFromVertices(indices, 6).reduce((n, v) => n + v, 0) === 2,
    `faces ${[...faces.keys()].filter((t) => faces[t]).join(', ')}`,
  );
  check(
    'and an index past the end of the mesh is ignored rather than wrapping',
    facesFromVertices([1000], 6).every((v) => v === 0) && facesFromVertices([-1], 6).every((v) => v === 0),
  );

  // A saved mask is per vertex, from an STL with no shared vertices; a selection is per face. The
  // reading that keeps a saved window whole is "any corner painted", and this is why.
  const saved = new Uint8Array(12);
  saved[0] = 1;
  saved[7] = 1;
  const reopened = facesFromPainted(saved, 4);
  check(
    'a saved mask comes back as every face it touches, not only the fully painted ones',
    reopened[0] === 1 && reopened[2] === 1 && reopened.join('') === '1010',
    reopened.join(''),
  );
  check('a shortened saved mask stops where it stops', facesFromPainted(new Uint8Array(3), 4).every((v) => v === 0));
  check('and a saved mask longer than the model cannot invent faces', facesFromPainted(new Uint8Array(30).fill(1), 4).every((v) => v === 1));
}

// --------------------------------------------------------------------------- a cut soup

{
  const sel = createSelection(4);
  sel.faces[1] = 1;
  sel.faces[3] = 1;
  // Faces 1 and 3 gone, and the soup renumbered: new 0 was old 0, new 1 was old 2, new 2 was old 4,
  // which was not selected. The old selection was {1, 3}; only old 2 survives the cut.
  const remapped = remapSelection(sel, Int32Array.from([0, 2, 4]), 3);
  check(
    'a cut renumbers the selection instead of dropping or shifting it',
    remapped.faces.length === 3 && remapped.join === undefined && remapped.faces[0] === 0 && remapped.faces[1] === 0 && remapped.faces[2] === 0,
    `kept ${[...remapped.faces].join('')}`,
  );
  sel.faces[0] = 1;
  const kept = remapSelection(sel, Int32Array.from([0, 2, 4]), 3);
  check(
    'and a face that survived the cut stays selected',
    kept.faces.join('') === '100' && countSelected(kept) === 1,
    kept.faces.join(''),
  );
  // `sel` is {0, 1, 3}, and the map names old faces 0-4, so the three old selected ones all exist:
  // a map longer than the new mesh is read only as far as the new mesh goes.
  const grown = remapSelection(sel, Int32Array.from([0, 1, 2, 3, 4]), 5);
  check(
    'a face map longer than the new mesh is read only as far as the new mesh goes',
    grown.faces.length === 5 && countSelected(grown) === 3 && grown.faces.join('') === '11010',
    grown.faces.join(''),
  );
  check('a missing selection remaps to an empty one', countSelected(remapSelection(null, Int32Array.from([0]), 1)) === 0);
}

// ------------------------------------------------------------- undo, redo, and their rules

{
  const sel = createSelection(4);
  const history = new SelectionHistory({ limit: 3 });
  check('a fresh history has nothing to undo and nothing to redo', !history.canUndo && !history.canRedo);

  history.remember(sel); // an edit is about to happen; the selection is empty
  sel.faces[0] = 1;
  history.remember(sel);
  sel.faces[1] = 1;
  check('remembering before each edit gives one undo step per edit', history.canUndo && history.undoStack.length === 2);

  history.undo(sel);
  check('undo puts the previous selection back', sel.faces.join('') === '1000' && history.canRedo, sel.faces.join(''));
  history.undo(sel);
  check('undo again reaches the empty selection', countSelected(sel) === 0 && history.canUndo === false);
  check('and there is nothing more to undo', history.undo(sel) === false && countSelected(sel) === 0);
  history.redo(sel);
  check('redo goes forward again', sel.faces.join('') === '1000', sel.faces.join(''));
  history.redo(sel);
  check('and redo reaches the last edit', sel.faces.join('') === '1100' && history.canRedo === false);
  check('nothing more to redo either', history.redo(sel) === false);

  // A new edit after an undo is a new branch: what was undone is not what redo puts back.
  history.undo(sel);
  history.remember(sel);
  sel.faces[1] = 1;
  sel.faces[2] = 1;
  check(
    'a new edit after an undo is a new branch, not a redo',
    history.canRedo === false && history.undoStack.length === 2,
    `${history.undoStack.length} undo step(s), redo ${history.redoStack.length}`,
  );

  // The limit is what keeps a long session's history from growing without bound.
  for (let k = 0; k < 6; k += 1) {
    history.remember(sel);
    sel.faces[k % 4] = sel.faces[k % 4] ? 0 : 1;
  }
  check(
    'the history is bounded, oldest first',
    history.undoStack.length === 3 && history.undoStack[history.undoStack.length - 1].length === 4,
    `${history.undoStack.length} of 3 kept`,
  );

  // A cut renumbers the history too: an undo that remembered old indices would restore a
  // selection that never existed.
  const cutHistory = new SelectionHistory();
  const before = createSelection(4);
  before.faces[3] = 1;
  cutHistory.remember(before);
  const faceMap = Int32Array.from([3, 0, 1, 2]);
  cutHistory.remap(faceMap, 4);
  const after = createSelection(4);
  after.faces[0] = 1;
  cutHistory.undo(after);
  check(
    'the history is renumbered with the soup, so an undo restores the right faces',
    after.faces.join('') === '1000',
    after.faces.join(''),
  );
  const stray = new SelectionHistory();
  const tiny = createSelection(1);
  tiny.faces[0] = 1;
  stray.remember(tiny);
  stray.remap(Int32Array.from([7, -1]), 2); // old face 7 does not exist in a one-face selection
  const into = createSelection(2);
  stray.undo(into);
  check(
    'and a map naming a face that does not exist restores nothing rather than the wrong thing',
    into.faces.join('') === '00',
    into.faces.join(''),
  );
}

// ------------------------------------- the selection is the mask the stencil is built from

{
  // Three faces of a two-triangle quad, in the soup the loader hands over.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0,
    0, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 0, 0, 1,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(27), 4));
  const tint = new SelectionTint(geometry);

  check('the mask layer counts the model’s corners, not its faces', tint.vertexCount === 9 && tint.ids.length === 9);
  check('and starts with nothing selected anywhere', tint.stats().painted === 0 && tint.ids.every((v) => v === 0));

  const sel = createSelection(3);
  sel.faces[2] = 1;
  const painted = paintedFromFaces(sel);
  const corners = tint.setSelection(painted);
  check(
    'writing the selection into the mask sets exactly the corners of the selected faces',
    corners === 3 && tint.stats().painted === 3 && tint.ids.join('') === '000000111',
    `${fmt(corners)} corners`,
  );
  check(
    'and every corner it set carries the one selection id',
    tint.ids[6] === SELECTION_ID && tint.ids[7] === SELECTION_ID && tint.ids[8] === SELECTION_ID && tint.ids[5] === UNPAINTED_ID,
  );
  // The colour buffer is what makes the selection visible; a face selected but not tinted is a
  // selection nobody can see, which is the failure mode this whole module exists to avoid.
  const rgb = hexToRgb(SELECTION_COLOR);
  check(
    'the selected corners are tinted with the selection colour at full alpha',
    Math.abs(tint.colors[6 * 4] - rgb.r) < 1e-6 && Math.abs(tint.colors[6 * 4 + 1] - rgb.g) < 1e-6 &&
      tint.colors[6 * 4 + 3] === 1,
    `rgba ${[...tint.colors.slice(24, 28)].map((n) => n.toFixed(2)).join(', ')}`,
  );
  check(
    'and the rest of the model is left at alpha 0, so the tint is only where the selection is',
    tint.colors[0 * 4 + 3] === 0 && tint.colors[5 * 4 + 3] === 0,
  );

  // Deselecting has to take the tint back off, not just the flag.
  sel.faces[2] = 0;
  sel.faces[0] = 1;
  const redrawn = tint.setSelection(paintedFromFaces(sel));
  check(
    'moving the selection takes the tint off the corners it left',
    redrawn === 3 && tint.ids.join('') === '111000000' && tint.colors[6 * 4 + 3] === 0 && tint.colors[0 * 4 + 3] === 1,
    tint.ids.join(''),
  );
  // A mask asset that shrank: the tail must be cleared rather than left stale.
  tint.setSelection(new Uint8Array(6));
  check('corners past the end of a short selection are cleared, not left selected', tint.ids.every((v) => v === 0) && tint.stats().painted === 0);
  tint.setSelection(paintedFromFaces(sel));
  tint.clear();
  check('clearing the mask takes all of it out', tint.stats().painted === 0 && tint.ids.every((v) => v === 0));

  // The one thing every panel quotes.
  tint.setSelection(paintedFromFaces(sel));
  const stats = tint.stats();
  check(
    'the panel’s corner count is the same number the build is handed',
    stats.painted === paintedFromFaces(sel).reduce((n, v) => n + v, 0) && stats.total === tint.vertexCount,
    `${fmt(stats.painted)} of ${fmt(stats.total)} corners`,
  );
  const pairs = tint.paintedPairs();
  check(
    'the saved mask is corner/id pairs, one per selected corner',
    pairs.length === 6 && pairs.every((v, i) => (i % 2 ? v === SELECTION_ID : v % 3 === 0 + v % 3)) && pairs[0] === 0,
    `[${pairs.join(', ')}]`,
  );
}

// ------------------------------------------------------------------------- the load path

{
  // A mask saved by the previous, painting version of the app: several ids, brushed per vertex.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(36), 3)); // 12 corners
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(48), 4));
  const tint = new SelectionTint(geometry);
  const pairs = [0, 1, 1, 3, 2, 1, 5, 7, 8, 0];
  tint.loadPairs(pairs);
  const expected = [0, 1, 2, 5];
  const loaded = expected.filter((i) => tint.ids[i] === SELECTION_ID);
  check(
    'a mask from the painting version loads as one selection over the same corners',
    loaded.length === 4 && tint.ids[8] === 0 && tint.ids[0] === SELECTION_ID,
    `corners ${loaded.join(', ')} of the saved mask`,
  );
  check(
    'and the counts the panel shows are the loaded corners',
    tint.stats().painted === 4,
    `${fmt(tint.stats().painted)} corners, ${fmt(pairs.length / 2)} pairs in the file`,
  );
  // Corners 0, 1, 2 are the whole of face 0 and corner 5 is part of face 1: two faces, because a
  // selection is per face and a saved window is per vertex.
  const faces = facesFromPainted(paintedOf(tint), 6);
  check(
    'the reopened mask is a selection over the faces it touched',
    countSelected({ faceCount: 6, faces }) === 2 && isSelected({ faceCount: 6, faces }, 0) && isSelected({ faceCount: 6, faces }, 1),
    `${fmt(countSelected({ faceCount: 6, faces }))} faces`,
  );
  tint.loadPairs([999, 1, -1, 1, 3, 0]);
  check(
    'a saved corner outside the model, and an id of 0, are both ignored',
    tint.stats().painted === 0,
    `${fmt(tint.stats().painted)} corners`,
  );
}

/** The corner flags a loaded mask means, as a `0/1` array. */
function paintedOf(tint) {
  const out = new Uint8Array(tint.ids.length);
  for (let i = 0; i < out.length; i += 1) if (tint.ids[i] !== 0) out[i] = 1;
  return out;
}

console.log(`\n${failures === 0 ? 'all selection checks passed' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
