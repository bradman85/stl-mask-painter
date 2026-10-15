// Drives the export path the way the app does it: the real selection is made on the real model,
// it becomes the stencil window, the panel's own default numbers are used, and
// the result is written with the real STL writer and read back.
//
//   node test/app-path.test.mjs
//
// stencil.test.mjs checks the generator; this checks the wiring between the classes the UI
// calls, with the values the panel ships with.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { SelectionTint } from '../js/mask.js';
import {
  createSelection,
  applyFaces,
  countSelected,
  paintedFromFaces,
  facesFromVertices,
  facesFromPainted,
  SelectionHistory,
} from '../js/selection.js';
import { buildTopology, buildStencil, validateSolid, stencilDefaultsForDiagonal, geodesicField } from '../js/stencil.js';
import { buildBinarySTL, buildMaskJSON, parseMaskJSON, setOnBed, lowestZ } from '../js/io.js';
import { maskWindows } from '../js/cleanup.js';
import { parseBinarySTL, fmt, InsideTester, TriGrid } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.resolve(here, '../../Sprunki Mercuy.stl'));
// STLLoader hands the app a non-indexed position attribute in file order.
const parsed = parseBinarySTL(raw);
const positions = Float32Array.from(parsed.positions);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * The separate shells of an indexed solid, as the Z band each one occupies.
 *
 * Written here rather than imported from the app: the point of the bed checks below is what the
 * *file* contains, so the pieces in the file are found independently of io.js — triangles that
 * share an edge are one shell, which is the rule the result panel counts pieces with too.
 */
function pieceBands(weldedPositions, indices) {
  const tri = indices.length / 3;
  const parent = new Int32Array(tri);
  for (let t = 0; t < tri; t += 1) parent[t] = t;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const owner = new Map();
  for (let t = 0; t < tri; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t * 3 + k];
      const b = indices[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? a * 8388608 + b : b * 8388608 + a;
      const prev = owner.get(key);
      if (prev === undefined) owner.set(key, t);
      else {
        const ra = find(prev);
        const rb = find(t);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const groups = new Map();
  for (let t = 0; t < tri; t += 1) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) {
      g = { tris: 0, minZ: Infinity, maxZ: -Infinity, minX: Infinity, minY: Infinity };
      groups.set(r, g);
    }
    g.tris += 1;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k] * 3;
      const z = weldedPositions[v + 2];
      if (z < g.minZ) g.minZ = z;
      if (z > g.maxZ) g.maxZ = z;
      if (weldedPositions[v] < g.minX) g.minX = weldedPositions[v];
      if (weldedPositions[v + 1] < g.minY) g.minY = weldedPositions[v + 1];
    }
  }
  return [...groups.values()].sort((a, b) => a.minZ - b.minZ);
}

/** The piece bands of a binary STL file, on its welded vertices. */
function filePieceBands(bytes) {
  const file = parseBinarySTL(bytes);
  const topo = buildTopology(file.positions, file.positions.length / 3);
  const idx = new Int32Array(file.triCount * 3);
  for (let i = 0; i < idx.length; i += 1) idx[i] = topo.weldOf[i];
  return { file, bands: pieceBands(topo.positions, idx) };
}

/** The frontmost vertex of the model inside a Z band — a point that is definitely on it. */
function frontOf(zLo, zHi) {
  let best = null;
  for (let i = 0; i < positions.length / 3; i += 1) {
    const z = positions[i * 3 + 2];
    if (z < zLo || z > zHi) continue;
    if (!best || positions[i * 3 + 1] > positions[best * 3 + 1]) best = i;
  }
  return best;
}

// ------------------------------------------------------------ the app's selection
//
// The app selects *faces*; there is no brush any more. This is the same path the two tools take:
// a selection over the file's faces, and `paintedFromFaces` — the one bridge to the vertex-shaped
// data the stencil engine eats. A stamp is modelled here as "every face with a corner within r of
// a point", which is what a click on a panel amounts to, and the assertions are about the same
// things the old ones were: two separate windows, a stencil that stays watertight, and a file that
// comes back the way it went out.

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const faceCount = positions.length / 9;
const tint = new SelectionTint(geometry);
const selection = createSelection(faceCount);
const history = new SelectionHistory();
let tintScratch = null;

function syncTint() {
  tintScratch = paintedFromFaces(selection, tintScratch);
  return tint.setSelection(tintScratch);
}

/** Every face with a corner within `radius` of `p` — what a click on a part selects. */
function facesNear(p, radius) {
  const wanted = new Uint8Array(faceCount);
  const r2 = radius * radius;
  for (let t = 0; t < faceCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const i = t * 3 + k;
      const dx = positions[i * 3] - p[0];
      const dy = positions[i * 3 + 1] - p[1];
      const dz = positions[i * 3 + 2] - p[2];
      if (dx * dx + dy * dy + dz * dz <= r2) {
        wanted[t] = 1;
        break;
      }
    }
  }
  return wanted;
}

/** Adds those faces to the selection, as one undo step. Returns how many joined. */
function selectNear(p, radius) {
  history.remember(selection);
  const changed = applyFaces(selection, facesNear(p, radius), { add: true });
  syncTint();
  return changed;
}

check('SelectionTint wraps the loaded geometry', tint.vertexCount === positions.length / 3);
check('the selection starts empty', countSelected(selection) === 0 && tint.stats().painted === 0);

const bbox = geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox);
const centre = bbox.getCenter(new THREE.Vector3());
const size = bbox.getSize(new THREE.Vector3());
const diagonal = size.length();
const brush = Math.max(0.5, diagonal / 45);

let eyeLeft = null;
let eyeRight = null;
for (let i = 0; i < tint.vertexCount; i += 1) {
  const x = positions[i * 3];
  const y = positions[i * 3 + 1];
  const z = positions[i * 3 + 2];
  if (y < centre.y + size.y * 0.18 || y > centre.y + size.y * 0.34) continue;
  const p = new THREE.Vector3(x, y, z);
  if (x < centre.x && (!eyeLeft || z > eyeLeft.z)) eyeLeft = p;
  if (x > centre.x && (!eyeRight || z > eyeRight.z)) eyeRight = p;
}
const selectedLeft = selectNear(eyeLeft.toArray(), brush);
const selectedRight = selectNear(eyeRight.toArray(), brush);
check(
  'selecting two eye panels marks faces and tinted corners',
  selectedLeft > 0 && selectedRight > 0 && tint.stats().painted > 0,
  `${fmt(selectedLeft)} + ${fmt(selectedRight)} faces, ${fmt(tint.stats().painted)} corners`,
);

const stats = tint.stats();
check(
  'the tint counts exactly the corners of the selected faces',
  stats.painted === countSelected(selection) * 3,
  `${fmt(stats.painted)} painted corners for ${fmt(countSelected(selection))} faces`,
);

// ---------------------------------------------------------------- the app's build path

const painted = tintScratch;

// Exactly the derivation the panel does (stencilParamsFromInputs / stencilDefaultsForModel).
const defaults = stencilDefaultsForDiagonal(diagonal);
const params = { ...defaults };
params.edgeLip = Math.min(params.wall * 0.5, defaults.edgeLip);
params.edgeFade = Math.max(params.edgeFade, params.wall * 2);
params.maxCoverRadius = Math.max(defaults.maxCoverRadius || defaults.coverRadius * 3, params.coverRadius * 2);

const tTopo = Date.now();
const topology = buildTopology(positions, tint.vertexCount);
const topoMs = Date.now() - tTopo;
const tBuild = Date.now();
const res = buildStencil({ topology, painted, params });
const buildMs = Date.now() - tBuild;
console.log(
  `      defaults: reach ${params.coverRadius} wall ${params.wall} lip ${params.edgeLip.toFixed(2)} ` +
    `standoff ${params.standoff} overhang ${params.overhang} maxReach ${params.maxCoverRadius}`,
);
console.log(`      topology ${fmt(topoMs)} ms, build ${fmt(buildMs)} ms (one-off; the app caches the topology)`);
check('the app path builds a stencil', res.ok === true, res.ok ? '' : res.warnings.join(' '));
if (!res.ok) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}

const s = res.stats;
console.log(
  `      ${fmt(s.solidTriangles)} triangles · ${s.components} piece(s) · ${s.windowLoops} window(s) · ` +
    `wall ${s.thicknessMin.toFixed(2)}–${s.thicknessMax.toFixed(2)} · standoff ${s.standoff}`,
);
for (const w of res.warnings) console.log(`      warning: ${w}`);

check('defaults give one piece', s.components === 1, `${s.components} pieces, reach widened to ${fmt(s.coverRadius)}`);
check('the window opened', s.windowOpen === true && s.windowLoops >= 1, `${s.windowLoops} loops`);
check('two painted features stay one mask', s.windowLoops === 2, `${s.windowLoops} window loops`);
check('wall thickness is the expected band', s.thicknessMin >= params.edgeLip - 1e-4 && s.thicknessMax <= params.rim + 1e-3, `${s.thicknessMin.toFixed(2)}–${s.thicknessMax.toFixed(2)}`);

const v = validateSolid(res);
check('the app path produces a watertight solid', v.watertight === true && v.outward === true, `edges ${JSON.stringify(v.edgeHistogram)}, volume ${fmt(v.volume, 0)}`);

// ------------------------------------------------- towards the file the user downloads

const stl = buildBinarySTL(res.positions, res.indices);
const blob = new Blob([stl.buffer], { type: 'model/stl' });
check('the download blob is non-empty and the right size', blob.size === 84 + stl.triangles * 50, `${(blob.size / 1048576).toFixed(1)} MB`);

const reRead = parseBinarySTL(new Uint8Array(await blob.arrayBuffer()));
check('the downloaded file re-reads', reRead.triCount === stl.triangles, `${fmt(reRead.triCount)} triangles`);

const topo2 = buildTopology(reRead.positions, reRead.positions.length / 3);
const idx2 = new Int32Array(reRead.triCount * 3);
for (let t = 0; t < reRead.triCount * 3; t += 1) idx2[t] = topo2.weldOf[t];
const v2 = validateSolid({ positions: topo2.positions, indices: idx2 });
check(
  'the downloaded file is still watertight',
  v2.watertight === true && v2.components === 1 && Math.abs(v2.volume - v.volume) < 1e-3 * Math.max(1, v.volume),
  `${v2.components} piece(s), volume ${fmt(v2.volume, 1)} vs ${fmt(v.volume, 1)}`,
);

// ------------------------------------------------- sitting the part on the print bed
//
// The report this answers: the exported stencil floats in the slicer, because an STL keeps the
// coordinates its exporter used and the slicer reads Z = 0 as the plate. The viewport cannot
// show that — centring the model on the grid moves the view, not the mesh — so the file is the
// only place it can be put right. Two halves: the transform itself as arithmetic on a known
// solid, and the real exported file re-read with its lowest Z measured off the vertices.
{
  const pushed = Float32Array.from([3, 4, 5, 3, 5, 7, 4, 4, 9]);
  const placed = setOnBed(pushed);
  check(
    'setOnBed moves the lowest Z to 0 and reports how far it moved',
    placed.drop === 5 && placed.positions[2] === 0 && placed.positions[5] === 2 && placed.positions[8] === 4,
    `drop ${placed.drop}, Z now ${placed.positions[2]}, ${placed.positions[5]}, ${placed.positions[8]}`,
  );
  check(
    'it moves Z only — X and Y keep the model’s own coordinates',
    placed.positions[0] === 3 && placed.positions[1] === 4 && placed.positions[3] === 3 && placed.positions[4] === 5 && placed.positions[6] === 4 && placed.positions[7] === 4,
    `X/Y ${placed.positions.filter((_, i) => i % 3 !== 2).join(', ')}`,
  );
  check(
    'and it never edits the solid it was given (the preview and the panel share it)',
    pushed[2] === 5 && pushed[5] === 7 && lowestZ(pushed) === 5,
    `the original still starts at Z ${pushed[2]}`,
  );
  const sunk = setOnBed(Float32Array.from([0, 0, -3, 1, 0, 1]));
  check(
    'a part sunk below the plate is lifted onto it',
    sunk.drop === -3 && sunk.positions[2] === 0 && sunk.positions[5] === 4,
    `drop ${sunk.drop}, Z now ${sunk.positions[2]} and ${sunk.positions[5]}`,
  );
  const onBed = Float32Array.from([0, 0, 0, 1, 0, 2]);
  const untouched = setOnBed(onBed);
  check(
    'a part already sitting on Z 0 is handed back as it is, with nothing copied',
    untouched.drop === 0 && untouched.positions === onBed,
    `drop ${untouched.drop}, same array: ${untouched.positions === onBed}`,
  );
  check(
    'a solid with no vertices is not a NaN',
    lowestZ(new Float32Array(0)) === 0 && setOnBed(new Float32Array(0)).drop === 0,
  );

  // The real file: what the export button writes, with the box ticked and unticked.
  const solidLowest = lowestZ(res.positions);
  const dropped = setOnBed(res.positions);
  const droppedFile = parseBinarySTL(new Uint8Array(buildBinarySTL(dropped.positions, res.indices).buffer));
  let fileLowest = Infinity;
  let fileHighest = -Infinity;
  let minX = Infinity;
  for (let i = 0; i < droppedFile.positions.length; i += 3) {
    if (droppedFile.positions[i + 2] < fileLowest) fileLowest = droppedFile.positions[i + 2];
    if (droppedFile.positions[i + 2] > fileHighest) fileHighest = droppedFile.positions[i + 2];
    if (droppedFile.positions[i] < minX) minX = droppedFile.positions[i];
  }
  let layoutMinX = Infinity;
  for (let i = 0; i < res.positions.length; i += 3) if (res.positions[i] < layoutMinX) layoutMinX = res.positions[i];
  console.log(
    `      the built shell's lowest Z in model coordinates is ${solidLowest.toFixed(3)}; ` +
    `written to the bed it spans Z 0…${(fileHighest - fileLowest).toFixed(2)} (${fmt(droppedFile.triCount)} triangles)`,
  );
  check(
    'the exported file’s lowest vertex is Z 0 — not near it, exactly it',
    Math.abs(fileLowest) < 1e-5 && fileHighest > fileLowest,
    `lowest Z ${fileLowest.toExponential(1)}, highest ${fileHighest.toFixed(3)}`,
  );
  check(
    'and dropping it moved only Z, so the part is the same shape in the plate plane',
    Math.abs(minX - layoutMinX) < 1e-5 && droppedFile.triCount === stl.triangles,
    `min X ${minX.toFixed(3)} vs ${layoutMinX.toFixed(3)}, ${fmt(droppedFile.triCount)} triangles`,
  );
  const droppedBack = (() => {
    const t = buildTopology(droppedFile.positions, droppedFile.positions.length / 3);
    const idx = new Int32Array(droppedFile.triCount * 3);
    for (let i = 0; i < idx.length; i += 1) idx[i] = t.weldOf[i];
    return validateSolid({ positions: t.positions, indices: idx });
  })();
  check(
    'the part on the bed is the same watertight solid, same volume, same window',
    droppedBack.watertight === true &&
      droppedBack.components === v.components &&
      Math.abs(droppedBack.volume - v.volume) < 1e-3 * Math.max(1, v.volume),
    `volume ${fmt(droppedBack.volume, 1)} vs ${fmt(v.volume, 1)}, ${droppedBack.components} piece(s)`,
  );
  check(
    'the drop is exactly the lowest Z the build had',
    Math.abs(dropped.drop - solidLowest) < 1e-6,
    `dropped ${dropped.drop.toFixed(3)}, build's lowest ${solidLowest.toFixed(3)}`,
  );
  // Unticked: the file is the shell where it sits on the model, floating and all — the escape
  // hatch for lining the mask up against the figure in the slicer.
  const keptFile = parseBinarySTL(new Uint8Array(buildBinarySTL(res.positions, res.indices).buffer));
  let keptLowest = Infinity;
  for (let i = 2; i < keptFile.positions.length; i += 3) if (keptFile.positions[i] < keptLowest) keptLowest = keptFile.positions[i];
  check(
    'unticked, the file keeps the model’s own coordinates (that is what the box is for)',
    Math.abs(keptLowest - solidLowest) < 1e-5,
    `lowest Z ${keptLowest.toFixed(3)} — the same as the build's`,
  );

  // ------------------------------------------------- the stencil that comes out in two pieces
  //
  // The report: "it hovers above the bed until separate objects is selected and then it drops
  // down". A slicer imports the shells of one STL as *parts of a single object* and keeps the
  // coordinates they were written with — only "split to objects" drops each one onto the plate.
  // So moving the assembly by its single lowest point is not enough: the lower piece lands and
  // every other piece keeps hovering. These pin the shape of the fix and then measure it on a
  // real two-piece export.
  {
    // Two tetrahedra, 40 mm apart in Z and 20 mm apart in X: two shells, like a window on the
    // head and one at the feet.
    const tetra = (b) => [b, b + 2, b + 1, b, b + 1, b + 3, b, b + 3, b + 2, b + 1, b + 2, b + 3];
    const stacked = Float32Array.from([
      0, 0, 5, 4, 0, 5, 0, 3, 5, 0, 0, 8,
      20, 0, 45, 24, 0, 45, 20, 3, 45, 20, 0, 48,
    ]);
    const stackedIdx = Int32Array.from([...tetra(0), ...tetra(4)]);
    const shellMinZ = (arr, from, to) => {
      let min = Infinity;
      for (let v = from; v < to; v += 1) min = Math.min(min, arr[v * 3 + 2]);
      return min;
    };

    // The whole-solid drop, with no indices to find the pieces in — the shape of the first fix.
    const whole = setOnBed(stacked);
    check(
      'dropping the whole solid by its lowest point leaves the second piece in the air',
      whole.pieces === 1 && whole.drop === 5 && Math.abs(shellMinZ(whole.positions, 4, 8) - 40) < 1e-6,
      `pieces ${whole.pieces}, the upper shell now at Z ${shellMinZ(whole.positions, 4, 8).toFixed(2)} (it was 45)`,
    );

    // Every piece placed: the fix. Each shell moves by its own lowest Z, nothing else moves.
    const both = setOnBed(stacked, stackedIdx);
    check(
      'given the indices, every piece is placed and both shells rest on Z 0',
      both.pieces === 2 &&
        Math.abs(shellMinZ(both.positions, 0, 4)) < 1e-6 &&
        Math.abs(shellMinZ(both.positions, 4, 8)) < 1e-6,
      `pieces ${both.pieces}, shells now at Z ${shellMinZ(both.positions, 0, 4).toFixed(2)} and ${shellMinZ(both.positions, 4, 8).toFixed(2)}`,
    );
    check(
      'the piece that had to travel furthest is what it reports, and the solid\u2019s lowest Z is still its own',
      Math.abs(both.moved - 45) < 1e-6 && both.drop === 5,
      `moved ${both.moved} (the upper shell was floating 45 mm up), drop ${both.drop}`,
    );
    let xyMoved = 0;
    for (let i = 0; i < stacked.length; i += 1) {
      if (i % 3 === 2) continue;
      if (Math.abs(both.positions[i] - stacked[i]) > 1e-9) xyMoved += 1;
    }
    check(
      'placing the pieces moves Z only, and only in the copy that is written',
      xyMoved === 0 && both.positions !== stacked && stacked[2] === 5 && stacked[14] === 45,
      `${xyMoved} X/Y values changed; the solid handed in still starts at Z ${stacked[2]} and ${stacked[14]}`,
    );
    const resting = Float32Array.from(stacked);
    for (let v = 0; v < 8; v += 1) resting[v * 3 + 2] -= shellMinZ(stacked, v < 4 ? 0 : 4, v < 4 ? 4 : 8);
    const nothing = setOnBed(resting, stackedIdx);
    check(
      'a two-piece solid already resting on the plate is handed back as it is',
      nothing.pieces === 2 && nothing.moved === 0 && nothing.positions === resting,
      `pieces ${nothing.pieces}, moved ${nothing.moved}, same array: ${nothing.positions === resting}`,
    );
    // A triangle soup shares no vertices at all, so nothing joins any two triangles: treating
    // each triangle as its own piece would scatter the part instead of placing it.
    const soupPositions = Float32Array.from(
      Array.from({ length: 8 }, () => [
        0, 0, 5, 4, 0, 5, 0, 3, 5, 0, 0, 8,
        20, 0, 45, 24, 0, 45, 20, 3, 45, 20, 0, 48,
      ]).flat(),
    );
    const soupIdx = Int32Array.from({ length: soupPositions.length / 3 }, (_, i) => i);
    const soupPlaced = setOnBed(soupPositions, soupIdx);
    check(
      'a soup with nothing shared is treated as one piece, not scattered',
      soupPlaced.pieces === 1 && soupPlaced.drop === 5 && soupPlaced.moved === 5,
      `pieces ${soupPlaced.pieces}, moved ${soupPlaced.moved}`,
    );

    // The real thing: a mask that comes out in two pieces — a window on the head and one at the
    // feet, with a short reach and the widening off — exported with the box ticked. Every piece
    // has to reach the plate in the file, not just the lowest one.
    const head = frontOf(centre.z + size.z * 0.28, centre.z + size.z * 0.36);
    const foot = frontOf(bbox.min.z, bbox.min.z + size.z * 0.08);
    const twoSelection = createSelection(faceCount);
    for (const at of [head, foot]) {
      applyFaces(twoSelection, facesNear([positions[at * 3], positions[at * 3 + 1], positions[at * 3 + 2]], brush), { add: true });
    }
    const paintedTwo = paintedFromFaces(twoSelection);
    const resTwo = buildStencil({
      topology,
      painted: paintedTwo,
      params: { ...params, coverRadius: 8, growIfSplit: false },
    });
    check(
      'a short reach and no widening give a stencil in two pieces',
      resTwo.ok === true && resTwo.stats.components === 2,
      resTwo.ok ? `${resTwo.stats.components} piece(s), ${fmt(resTwo.stats.solidTriangles)} triangles` : resTwo.warnings.join(' '),
    );
    const asBuilt = filePieceBands(new Uint8Array(buildBinarySTL(resTwo.positions, resTwo.indices).buffer));
    const placedTwo = setOnBed(resTwo.positions, resTwo.indices);
    const onPlate = filePieceBands(new Uint8Array(buildBinarySTL(placedTwo.positions, resTwo.indices).buffer));
    console.log(
      `      as built the two pieces sit at Z ${asBuilt.bands.map((b) => b.minZ.toFixed(2)).join(' and ')}; ` +
      `written to the plate: ${onPlate.bands.map((b) => `${b.minZ.toFixed(2)}…${b.maxZ.toFixed(2)}`).join(' and ')}`,
    );
    check(
      'the file still holds both pieces after the placement',
      asBuilt.bands.length === 2 && onPlate.bands.length === 2,
      `${asBuilt.bands.length} as built, ${onPlate.bands.length} written`,
    );
    check(
      'and the file the export writes has every piece resting on Z 0',
      onPlate.bands.every((b) => Math.abs(b.minZ) < 1e-5),
      `lowest Z per piece: ${onPlate.bands.map((b) => b.minZ.toExponential(1)).join(', ')}`,
    );
    check(
      'which is the difference between the report and the fix: as built, the upper piece floats',
      asBuilt.bands[1].minZ > 20 && Math.abs(placedTwo.moved - asBuilt.bands[1].minZ) < 1e-4 && placedTwo.pieces === 2,
      `as built it floated at ${asBuilt.bands[1].minZ.toFixed(2)} mm, the placement moved ${placedTwo.moved.toFixed(2)} mm`,
    );
    // Both pieces rest on Z 0 afterwards, so the bands can come back in either order — compare
    // what the plate plane sees, not the order it arrives in.
    const footprint = (bands, axis) => bands.map((b) => (axis === 'x' ? b.minX : b.minY).toFixed(4)).sort().join(', ');
    check(
      'the pieces keep their X and Y, so they still line up with the figure',
      footprint(onPlate.bands, 'x') === footprint(asBuilt.bands, 'x') &&
        footprint(onPlate.bands, 'y') === footprint(asBuilt.bands, 'y'),
      `min X ${footprint(onPlate.bands, 'x')} vs ${footprint(asBuilt.bands, 'x')}`,
    );
    // Unticked is the escape hatch here too: both pieces stay where the model has them.
    check(
      'unticked, a two-piece file keeps both pieces where the model has them',
      Math.abs(asBuilt.bands[0].minZ - lowestZ(resTwo.positions)) < 1e-4 && asBuilt.bands[1].minZ > 20,
      `lowest Z ${asBuilt.bands[0].minZ.toFixed(2)}, upper piece at ${asBuilt.bands[1].minZ.toFixed(2)}`,
    );
  }
}

// ------------------------------------------------- the window really is the painted area

const modelGrid = new TriGrid(parsed.positions, 2);
// TriGrid indexes a triangle soup, so the indexed solid has to be expanded first — feeding it
// raw vertex triplets would silently test against nonsense "triangles".
const soup = (() => {
  const out = new Float32Array(res.indices.length * 3);
  for (let i = 0; i < res.indices.length; i += 1) {
    const src = res.indices[i] * 3;
    out[i * 3] = res.positions[src];
    out[i * 3 + 1] = res.positions[src + 1];
    out[i * 3 + 2] = res.positions[src + 2];
  }
  return out;
})();
const solidGrid = new TriGrid(soup, 2);

// The build reports the real clearance between the mask's inner face and the surface. Check
// it against a direct measurement of every inner vertex against the whole model, which knows
// nothing about how the shell was built.
{
  const surfCount = res.stats.solidVertices / 2;
  let independentMin = Infinity;
  const all = [];
  for (let k = 0; k < surfCount; k += 1) {
    const d = modelGrid.nearest(res.positions[k * 6], res.positions[k * 6 + 1], res.positions[k * 6 + 2], 2).dist;
    if (!Number.isFinite(d)) continue;
    all.push(d);
    if (d < independentMin) independentMin = d;
  }
  all.sort((a, b) => a - b);
  const independentMedian = all[Math.floor(all.length * 0.5)];
  const c = s.clearance;
  console.log(
    `      clearance: reported min ${c.min.toFixed(3)} median ${c.median.toFixed(3)}, ` +
      `independent min ${independentMin.toFixed(3)} median ${independentMedian.toFixed(3)} ` +
      `(requested ${c.requested}, ${c.tight} vertices under ${(c.requested * 0.5).toFixed(2)})`,
  );
  check(
    'the reported clearance matches an independent measurement',
    Math.abs(independentMedian - c.median) < 0.01 &&
      independentMin <= c.min + 1e-6 &&
      c.min - independentMin < Math.max(0.02, c.requested * 0.5),
    `median ${c.median.toFixed(3)} vs ${independentMedian.toFixed(3)}, min ${c.min.toFixed(3)} vs ${independentMin.toFixed(3)}`,
  );
  check(
    'the clearance is positive everywhere (the inner face never cuts into the model)',
    c.min > 0 && independentMin > -1e-6,
    `min ${c.min.toFixed(4)} (independent ${independentMin.toFixed(4)})`,
  );
}

// Parity against the mask itself: a probe inside the window is air, the same probe over the
// surrounding shell is inside mask material.
const insideMask = new InsideTester(solidGrid);

const paintedW = new Uint8Array(topology.wCount);
for (let i = 0; i < painted.length; i += 1) if (painted[i]) paintedW[topology.weldOf[i]] = 1;

// Surface distance from the paint: tells which vertices the shell should cover (and the
// straight-line distance would not — the far side of the head is a few units away through
// the skull). Both fields come from the generator's own geodesic pass.
const fromPaint = geodesicField(
  topology,
  [...paintedW].flatMap((p, v) => (p ? [v] : [])),
  { maxDist: params.coverRadius * 1.5 },
);
const windowBorder = [];
for (let v = 0; v < topology.wCount; v += 1) {
  if (!paintedW[v]) continue;
  for (let k = topology.neighborStart[v]; k < topology.neighborStart[v + 1]; k += 1) {
    if (!paintedW[topology.neighbors[k]]) {
      windowBorder.push(v);
      break;
    }
  }
}
const insidePaint = geodesicField(topology, windowBorder, { maxDist: params.overhang * 8 });

// Probe along the same normal the generator offsets along, at a height that is above the
// inner face (standoff 0.1) and below the outer face everywhere (the lip is 0.39 thick).
const HEIGHT = 0.25;
const probe = (v) => {
  const p = [topology.positions[v * 3], topology.positions[v * 3 + 1], topology.positions[v * 3 + 2]];
  const n = [topology.normals[v * 3], topology.normals[v * 3 + 1], topology.normals[v * 3 + 2]];
  const hit = modelGrid.signed(p[0], p[1], p[2], 2);
  if (!hit.closest || hit.dist > 0.05) return null;
  return insideMask.test(p[0] + n[0] * HEIGHT, p[1] + n[1] * HEIGHT, p[2] + n[2] * HEIGHT);
};

let openSamples = 0;
let openMaterial = 0;
for (let v = 0; v < topology.wCount; v += 3) {
  if (!paintedW[v] || !(insidePaint[v] > params.overhang * 3)) continue; // clear of the window lip
  const covered = probe(v);
  if (covered === null) continue;
  openSamples += 1;
  if (covered) openMaterial += 1;
}
check(
  'the mask leaves the painted area open',
  openSamples > 100 && openMaterial / openSamples < 0.01,
  `${openMaterial}/${openSamples} probes above painted vertices hit mask material`,
);

let ringSamples = 0;
let ringCovered = 0;
let ringSkipped = 0;
for (let v = 0; v < topology.wCount; v += 3) {
  if (paintedW[v]) continue;
  // The band the shell must cover: outside the paint, short of the outer rim.
  if (!(fromPaint[v] > 1.5) || !(fromPaint[v] < s.coverRadius * 0.5)) continue;
  const covered = probe(v);
  if (covered === null) {
    ringSkipped += 1;
    continue;
  }
  ringSamples += 1;
  if (covered) ringCovered += 1;
}
check(
  'the mask covers the surface around the window',
  ringSamples > 200 && ringCovered / ringSamples > 0.98,
  `${ringCovered}/${ringSamples} probes between the window and the rim found mask material` +
    (ringSkipped ? ` (${ringSkipped} skipped: no model face within 0.05)` : ''),
);

// ---------------------------------------------------------------- selection JSON round trip
// The app's export → import path (js/io.js + SelectionTint) on the selection this suite made:
// what is written has to come back as the same window, or a saved session is a lie.
const features = [{ id: 1, name: 'Selection', color: '#ffc94d' }];
const paintedBefore = tint.paintedPairs();
const maskJson = JSON.stringify(
  buildMaskJSON({ mask: tint, features, modelName: 'Sprunki Mercuy.stl', pairs: paintedBefore }),
);
const maskParsed = parseMaskJSON(maskJson);
check('selection JSON: format and version are the documented ones', maskParsed.data.format === 'stl-mask' && maskParsed.data.version === 1);
check('selection JSON: vertexCount is the model\'s vertex count', maskParsed.data.vertexCount === tint.vertexCount, `${fmt(maskParsed.data.vertexCount, 0)}`);
check(
  'selection JSON: one pair per corner inside the window, nothing per corner outside it',
  maskParsed.data.paintedVertices === paintedBefore.length / 2 && maskParsed.pairs.length === paintedBefore.length,
  `${fmt(paintedBefore.length / 2, 0)} corners, ${(maskJson.length / 1048576).toFixed(1)} MB`,
);
check(
  'selection JSON: the one id the format carries survives the trip',
  maskParsed.features.length === 1 && maskParsed.features[0].color === features[0].color && maskParsed.features[0].name === features[0].name,
);
const importedTint = new SelectionTint(geometry);
importedTint.loadPairs(maskParsed.pairs);
const paintedAfter = importedTint.paintedPairs();
check(
  'selection JSON: import reproduces every corner',
  paintedAfter.length === paintedBefore.length && paintedAfter.every((v, i) => v === paintedBefore[i]),
  `${fmt(paintedAfter.length / 2, 0)} corners back`,
);
// The import turns corners back into faces — a triangle counts when any of its corners was inside
// the saved window — and that is what the tint is then rebuilt from, so the reopened selection is
// the saved one or a rim thicker, never thinner.
const reopenedFaces = createSelection(faceCount);
{
  const paintedFlags = new Uint8Array(tint.vertexCount);
  for (let i = 0; i < tint.vertexCount; i += 1) paintedFlags[i] = importedTint.ids[i] ? 1 : 0;
  reopenedFaces.faces.set(facesFromPainted(paintedFlags, faceCount));
  const widened = paintedFromFaces(reopenedFaces);
  let lost = 0;
  for (let i = 0; i < paintedFlags.length; i += 1) if (paintedFlags[i] && !widened[i]) lost += 1;
  check(
    'a reopened selection keeps every saved corner, and adds only the rims of its triangles',
    lost === 0 && countSelected(reopenedFaces) >= countSelected(selection) - selectedRight,
    `${fmt(lost)} saved corners lost, ${fmt(countSelected(reopenedFaces))} faces in the reopened selection`,
  );
}
// The guide documents the vertexCount mismatch as a warning rather than a refusal: the
// importer has to expose both numbers for the UI to compare.
const sample36 = { format: 'stl-mask', version: 1, vertexCount: 36, features: [], painted: [0, 1, 1, 1] };
check(
  'selection JSON: a file for another model is importable but flagged by its vertexCount',
  parseMaskJSON(JSON.stringify(sample36)).data.vertexCount !== tint.vertexCount,
  `${sample36.vertexCount} vs ${fmt(tint.vertexCount, 0)}`,
);

// ------------------------------------------------- the save has to match the screen
//
// The report this answers: select a window, build the stencil, export it, select more panels,
// export again — and the second file held only the first round's windows under a fresh timestamp,
// because the export wrote the build it had in hand rather than the selection on screen. The engine
// was never the problem, so this pins the two halves the fix rests on: that the shell in hand really
// is a different, older part after more selection, and that a saved selection can be loaded back
// and built on.
const paintedMaskOf = () => {
  const m = paintedFromFaces(selection);
  let count = 0;
  for (let i = 0; i < m.length; i += 1) if (m[i]) count += 1;
  return { painted: m, count };
};
/** Frontmost surface point in a y band, so a click certainly lands on the model. */
function frontMostIn(yLo, yHi) {
  let best = null;
  for (let i = 0; i < tint.vertexCount; i += 1) {
    const y = positions[i * 3 + 1];
    if (y < yLo || y > yHi) continue;
    const z = positions[i * 3 + 2];
    if (!best || z > best[2]) best = [positions[i * 3], y, z];
  }
  return best;
}
const stlBytes = (r) => Buffer.from(buildBinarySTL(r.positions, r.indices).buffer);

{
  const round1 = res; // what the panel had in hand: the two eye windows
  const chest = frontMostIn(centre.y - size.y * 0.12, centre.y + size.y * 0.02);
  const added = selectNear(chest, brush);
  check(
    'a second selection adds another window to the selection',
    added > 0,
    `${fmt(added)} faces at ${chest.map((n) => n.toFixed(1)).join(', ')}`,
  );

  const round2 = buildStencil({ topology, painted: paintedMaskOf().painted, params });
  check(
    'the new window is its own window in a rebuild, and the parts differ',
    round2.stats.windowLoops > round1.stats.windowLoops &&
      Buffer.compare(stlBytes(round1), stlBytes(round2)) !== 0,
    `${round1.stats.windowLoops} -> ${round2.stats.windowLoops} windows, ` +
      `${stlBytes(round1).length} -> ${stlBytes(round2).length} bytes`,
  );
  // The unit the app compares when it decides a build is stale: the corners inside the window
  // (what `stencil.paintedCount` is set to) against the selection as it stands now.
  const round1Painted = paintedBefore.length / 2;
  check(
    'the shell in hand was built from the smaller selection',
    round1Painted < paintedMaskOf().count,
    `built from ${fmt(round1Painted)} corners; the selection now has ` +
      `${fmt(paintedMaskOf().count)} — the numbers the stale test compares`,
  );

  // The other direction, which is what dropping a window means: unselect exactly the faces the
  // window list names — the same corner-to-face mapping the Remove row uses — and rebuild. The
  // window has to leave the shell.
  const windows = maskWindows(topology, tint.ids);
  const biggest = windows[0];
  const beforeRemoval = paintedMaskOf().count;
  const doomed = new Uint8Array(faceCount);
  for (const c of biggest.fileVertices) doomed[Math.floor(c / 3)] = 1;
  history.remember(selection);
  const changedFaces = applyFaces(selection, doomed, { remove: true });
  syncTint();
  const round3 = buildStencil({ topology, painted: paintedMaskOf().painted, params });
  check(
    'the window list reaches the built shell: dropping a window drops it from the rebuild',
    changedFaces > 0 &&
      paintedMaskOf().count < beforeRemoval &&
      round3.stats.windowLoops === round2.stats.windowLoops - 1,
    `${fmt(windows.length)} window(s) listed, ${fmt(changedFaces)} faces unselected; ` +
      `${round2.stats.windowLoops} -> ${round3.stats.windowLoops} window(s) in the shell`,
  );
  history.undo(selection);
  syncTint();
  check(
    'and one undo puts the window back where it was',
    paintedMaskOf().count === beforeRemoval,
    `${fmt(paintedMaskOf().count)} corners inside the window again`,
  );

  // Saving the place and carrying on: the session file, reopened, keeps growing. This is the
  // "save the windows I have selected and load them back to add more" flow.
  const savedStencil = {
    coverRadius: params.coverRadius,
    wall: params.wall,
    standoff: params.standoff,
    overhang: params.overhang,
    growIfSplit: false,
  };
  const session = JSON.stringify(
    buildMaskJSON({
      mask: tint,
      features,
      modelName: 'Sprunki Mercuy.stl',
      pairs: tint.paintedPairs(),
      stencil: savedStencil,
    }),
  );
  const reopened = parseMaskJSON(session);
  check(
    'the session file carries the build settings it was saved with',
    reopened.stencil !== null &&
      reopened.stencil.coverRadius === params.coverRadius &&
      reopened.stencil.growIfSplit === false,
    JSON.stringify(reopened.stencil),
  );
  check(
    'a file saved before that field existed still loads (no settings, no complaint)',
    parseMaskJSON(JSON.stringify(sample36)).stencil === null,
  );

  // A reopened file, the way the app imports one: corners in, faces out, then built on.
  const resumedTint = new SelectionTint(geometry);
  resumedTint.loadPairs(reopened.pairs);
  const resumed = createSelection(faceCount);
  const resumedPainted = new Uint8Array(tint.vertexCount);
  for (let i = 0; i < tint.vertexCount; i += 1) resumedPainted[i] = resumedTint.ids[i] ? 1 : 0;
  resumed.faces.set(facesFromPainted(resumedPainted, faceCount));
  const resumedMask = paintedFromFaces(resumed);
  let missing = 0;
  for (let i = 0; i < resumedPainted.length; i += 1) if (resumedPainted[i] && !resumedMask[i]) missing += 1;
  check(
    'a reloaded selection covers every corner that was saved',
    missing === 0 && countSelected(resumed) > 0,
    `${fmt(missing)} corners missing, ${fmt(countSelected(resumed))} faces selected`,
  );

  const mouth = frontMostIn(centre.y + size.y * 0.06, centre.y + size.y * 0.15);
  const extra = new Uint8Array(faceCount);
  {
    const wanted = facesNear(mouth, brush);
    let n = 0;
    for (let t = 0; t < faceCount; t += 1) {
      if (wanted[t] && !resumed.faces[t]) {
        extra[t] = 1;
        n += 1;
      }
    }
    check('the reopened selection can still be added to', n > 0, `${fmt(n)} faces added at the mouth`);
  }
  applyFaces(resumed, extra, { add: true });
  const grew = countSelected(resumed);
  const resumedBuild = buildStencil({ topology, painted: paintedFromFaces(resumed), params });
  check(
    'windows added after a reload reach the build',
    resumedBuild.stats.paintedVertices > round2.stats.paintedVertices &&
      resumedBuild.stats.windowLoops >= round2.stats.windowLoops &&
      Buffer.compare(stlBytes(resumedBuild), stlBytes(round2)) !== 0,
    `${fmt(grew)} faces in the reopened selection, ` +
      `${fmt(round2.stats.paintedVertices)} -> ${fmt(resumedBuild.stats.paintedVertices)} corners, ` +
      `${round2.stats.windowLoops} -> ${resumedBuild.stats.windowLoops} windows`,
  );
}

// ------------------------------------------------- a picked face has to reach the shell
//
// The report this answers: pick a few triangles with Select faces, build, and the shell comes back
// untouched — the picked faces are in the selection (the tint shows them) but not in the stencil,
// while Part panels and box drags work. Two mechanisms in the engine dropped a small window, both
// measured on the bundled figure: a painted island thinner than the window inlay has no inside to
// bite into (a one-triangle pick is three welded vertices, all of them boundary, so the depth field
// is 0 across it), and the inside smoothing that shapes a good rim lifts a small island's values
// back above the cut level (a 52-face patch is 0.53 deep, well past the 0.35 inlay, and still came
// out with `windowLoops: 0`). Either way the build reported success and the picked faces were
// simply absent from it. The guarantee now is that *every* selected island opens a window.
//
// Checked by looking for the hole rather than by trusting a count: a ray from the face, both ways
// along its normal, finds the inner sheet — the standoff above the surface, a fraction of a unit —
// over a covered spot and nothing at all over a window, where it simply leaves through the hole.
// The reach is a fraction of a unit and not a whole band, because everything past the standoff
// belongs to the shell *beside* the spot: measured here, a one-face window had the neighbouring
// inner sheet 0.7 units away sideways, so a ray three units long read the window as covered.
const faceCentroid = (t) => [
  (positions[t * 9] + positions[t * 9 + 3] + positions[t * 9 + 6]) / 3,
  (positions[t * 9 + 1] + positions[t * 9 + 4] + positions[t * 9 + 7]) / 3,
  (positions[t * 9 + 2] + positions[t * 9 + 5] + positions[t * 9 + 8]) / 3,
];
const faceNormal = (t) => {
  const ax = positions[t * 9];
  const ay = positions[t * 9 + 1];
  const az = positions[t * 9 + 2];
  const ux = positions[t * 9 + 3] - ax;
  const uy = positions[t * 9 + 4] - ay;
  const uz = positions[t * 9 + 5] - az;
  const vx = positions[t * 9 + 6] - ax;
  const vy = positions[t * 9 + 7] - ay;
  const vz = positions[t * 9 + 8] - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
};
/** Crossings of a triangle soup along one ray, within `reach`; Möller–Trumbore, no backface cull. */
function rayHits(pos, idx, origin, dir, reach) {
  let hits = 0;
  for (let t = 0; t < idx.length / 3; t += 1) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const px = dir[1] * e2z - dir[2] * e2y;
    const py = dir[2] * e2x - dir[0] * e2z;
    const pz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = origin[0] - pos[a];
    const ty = origin[1] - pos[a + 1];
    const tz = origin[2] - pos[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 1e-6 && dist <= reach) hits += 1;
  }
  return hits;
}
/**
 * Sheets of the shell right over this face: nothing when the window is there, else the inner sheet.
 *
 * The ray starts on the mesh and follows the *welded* normal at that vertex rather than the
 * triangle's own: a one-triangle window is only about a third of a unit across, and a triangle
 * normal tilted a few degrees off the surface slopes the ray out through the side of the hole
 * within a single unit of travel — which read a small window as covered until the probe was
 * anchored to the surface normal.
 */
function sheetsOver(r, face, reach = 0.6) {
  const v = topology.weldOf[face * 3];
  const at = [topology.positions[v * 3], topology.positions[v * 3 + 1], topology.positions[v * 3 + 2]];
  const n = [topology.normals[v * 3], topology.normals[v * 3 + 1], topology.normals[v * 3 + 2]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const dir = [n[0] / len, n[1] / len, n[2] / len];
  const back = [-dir[0], -dir[1], -dir[2]];
  return rayHits(r.positions, r.indices, at, dir, reach) + rayHits(r.positions, r.indices, at, back, reach);
}

{
  // One face, picked on the front of the head: the smallest selection the tool can make.
  const picked = frontMostIn(centre.y + size.y * 0.18, centre.y + size.y * 0.34);
  // And a second, separate pick a couple of units away, still inside the mask band.
  const pickedPoint = new THREE.Vector3(picked[0], picked[1], picked[2]);
  let second = -1;
  for (let t = 0; t < faceCount; t += 1) {
    const c = faceCentroid(t);
    const d = Math.hypot(c[0] - picked[0], c[1] - picked[1], c[2] - picked[2]);
    if (d > 2 && d < 3) { second = t; break; }
  }
  const single = createSelection(faceCount);
  // Which face the click lands on: the one whose centroid is the front-most point in the band.
  let faceA = -1;
  let bestD = Infinity;
  for (let t = 0; t < faceCount; t += 1) {
    const c = faceCentroid(t);
    const d = Math.hypot(c[0] - pickedPoint.x, c[1] - pickedPoint.y, c[2] - pickedPoint.z);
    if (d < bestD) { bestD = d; faceA = t; }
  }
  // No widening: the two windows have to stay two, and each piece has to stay within one reach.
  const smallParams = { ...params, growIfSplit: false, coverRadius: Math.min(params.coverRadius, 12) };

  // A face well outside both picks but inside the mask band, so "covered" has a meaning.
  let coverageFace = -1;
  for (let t = 0; t < faceCount; t += 1) {
    const c = faceCentroid(t);
    const d = Math.hypot(c[0] - picked[0], c[1] - picked[1], c[2] - picked[2]);
    if (d > 5 && d < 8) { coverageFace = t; break; }
  }

  single.faces[faceA] = 1;
  const one = buildStencil({ topology, painted: paintedFromFaces(single), params: smallParams });
  if (!one.ok) {
    console.log(`FAIL  a single picked face builds a shell  — ${one.warnings.join(' ')}`);
    console.log(`\n${failures + 1} failure(s)`);
    process.exit(1);
  }
  const solid = validateSolid(one);
  check(
    'a single picked face builds a shell with a window of its own',
    one.stats.windowLoops === 1 && one.stats.windowOpen === true,
    `loops ${one.stats.windowLoops}, open ${one.stats.windowOpen}, ${fmt(one.stats.paintedVertices, 0)} welded vertices painted`,
  );
  check(
    'and the window is over the face that was picked, with the model still covered beside it',
    sheetsOver(one, faceA) === 0 && sheetsOver(one, coverageFace) >= 1,
    `${sheetsOver(one, faceA)} sheet(s) over the picked face, ${sheetsOver(one, coverageFace)} over one ` +
      `${Math.hypot(...faceCentroid(coverageFace).map((n, i) => n - picked[i])).toFixed(1)} away`,
  );
  check(
    'and a one-face window still prints: watertight, outward, on its own',
    solid.watertight === true && solid.outward === true && one.stats.components === 1,
    `edges ${JSON.stringify(solid.edgeHistogram)}, ${one.stats.components} piece(s)`,
  );
  check(
    'the build says the window was cut at the island edge, because it is thinner than the inlay',
    one.stats.thinIslands === 1 && one.warnings.some((w) => w.includes('thinner than the')) &&
      one.stats.thinIslandRim > 0 && one.stats.thinIslandRim < params.wall,
    `${one.stats.thinIslands} thin island(s), rim ${one.stats.thinIslandRim.toFixed(3)}`,
  );

  // Two separate picks are two windows, and unpicking one closes it — Alt-clicking a face back off
  // a panel has to reach the shell the same way.
  single.faces[second] = 1;
  const both = buildStencil({ topology, painted: paintedFromFaces(single), params: smallParams });
  single.faces[second] = 0;
  const alone = buildStencil({ topology, painted: paintedFromFaces(single), params: smallParams });
  check(
    'two separate picks are two windows, and unpicking one takes its window back out',
    both.stats.windowLoops === 2 && alone.stats.windowLoops === 1 &&
      sheetsOver(both, second) === 0 && sheetsOver(alone, second) >= 1 && sheetsOver(alone, faceA) === 0,
    `${both.stats.windowLoops} windows with both picked, ${alone.stats.windowLoops} after unpicking; ` +
      `the unpicked face is covered by ${sheetsOver(alone, second)} sheet(s) again`,
  );

  // The workflow in the report: a Part panel, then a face picked somewhere else on the model. Both
  // write the same selection, so the shell has to carry a window for each — that is "Build stencil
  // recognises both" made checkable. The picked face is deliberately outside the panel's own patch
  // (a click covers a brush-sized area, so a pick 2.6 away would simply be inside the panel window).
  let farPick = -1;
  for (let t = 0; t < faceCount; t += 1) {
    const c = faceCentroid(t);
    const d = Math.hypot(c[0] - picked[0], c[1] - picked[1], c[2] - picked[2]);
    if (d > 8 && d < 12) { farPick = t; break; }
  }
  const mixed = createSelection(faceCount);
  applyFaces(mixed, facesNear(pickedPoint.toArray(), brush), { add: true });
  const panelFaces = countSelected(mixed);
  const panelOnly = buildStencil({ topology, painted: paintedFromFaces(mixed), params: smallParams });
  mixed.faces[farPick] = 1;
  const mixedBuild = buildStencil({ topology, painted: paintedFromFaces(mixed), params: smallParams });
  check(
    'a picked face adds its own window to a Part panel, in one shell',
    panelFaces > 100 && mixedBuild.ok === true &&
      mixedBuild.stats.windowLoops === panelOnly.stats.windowLoops + 1 &&
      mixedBuild.stats.thinIslands === 1,
    `${fmt(panelFaces)} faces from the panel click -> ${panelOnly.stats.windowLoops} window(s); ` +
      `+ 1 picked face (${fmt(farPick)}, outside the panel) -> ${mixedBuild.ok ? mixedBuild.stats.windowLoops : '-'} window(s), ` +
      `${mixedBuild.ok ? mixedBuild.stats.components : '-'} piece(s)`,
  );
  // The panel's own window is where the panel was clicked, the shell covers what neither gesture
  // touched, and the added window did not break the solid. The picked face's window itself is not
  // probed from above: a one-triangle window is narrower than the mask's own 0.35 inlay lip, so
  // the lip overhangs it and a ray straight up hits that, not the hole.
  check(
    'and the panel window is still where it was clicked, on a shell that stays watertight',
    sheetsOver(mixedBuild, faceA) === 0 && sheetsOver(mixedBuild, coverageFace) >= 1 &&
      validateSolid(mixedBuild).watertight === true,
    `panel face ${sheetsOver(mixedBuild, faceA)} sheet(s), ${sheetsOver(mixedBuild, coverageFace)} over ` +
      `${Math.hypot(...faceCentroid(coverageFace).map((n, i) => n - picked[i])).toFixed(1)} away`,
  );
}

// ---------------------------------- the same picks, with the panel's own numbers, in the written file
//
// The block above opens a window for a picked face with a reach-limited build; this one does it the
// way the app does when somebody clicks a triangle and presses Export without touching a slider:
// the panel's own numbers (reach from the model's diagonal, widening on, "sit the exported part on
// the bed" on, which is how both boxes ship), the real STL writer, and the file read back.
//
// Whether the window is *in the file* is read out of the file's own topology rather than inferred
// from a count, because a count is what made the bug invisible: `windowLoops` was 0 and the panel
// said the build was fine. A window is a tunnel through the shell — a mask that covers a selection
// without opening it is a plain lump of solid — and that is the one property of a one-triangle
// window that is not a matter of scale. V - E + F on a closed surface is 2 - 2 × (tunnels), so the
// written file reads 2 with no window at all and 0 with one, whatever the window's size. The probes
// a person would try instead all fail at this scale: the shell's sheet is coarse next to a single
// model triangle, so a count of triangles over the picked face's middle misses it either way, and a
// ray has to cross the whole standoff-plus-wall band, which drifts sideways out of a window a third
// of a unit across and reads the window's own rim as coverage.

/**
 * The solid the export button writes, welded: the shell, its triangle count, and its tunnels.
 *
 * `windows` is how many separate holes the file has — `(2 - χ) / 2`, one per tunnel — which is the
 * panel's `windowLoops`, read back out of the file the user opens in a slicer instead of from the
 * build that was supposed to write it.
 */
function exportedFile(res, { onBed = true } = {}) {
  const placed = onBed && res.indices.length ? setOnBed(res.positions, res.indices) : null;
  const written = placed ? placed.positions : res.positions;
  const file = parseBinarySTL(new Uint8Array(buildBinarySTL(written, res.indices).buffer));
  const topo = buildTopology(file.positions, file.positions.length / 3);
  const idx = new Int32Array(file.triCount * 3);
  for (let i = 0; i < idx.length; i += 1) idx[i] = topo.weldOf[i];
  const edges = new Set();
  for (let t = 0; t < idx.length / 3; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = idx[t * 3 + k];
      const b = idx[t * 3 + ((k + 1) % 3)];
      if (a !== b) edges.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  }
  const chi = topo.wCount - edges.size + idx.length / 3;
  // The bed placement moves the whole shell in Z; the model face a reading is anchored to has to
  // move with it, or every plane test lands a model's height away from the shell.
  return {
    shell: file.positions,
    indices: idx,
    triangles: file.triCount,
    dz: placed ? -placed.drop : 0,
    chi,
    windows: (2 - chi) / 2,
  };
}

/**
 * Shell triangles sitting over the middle of this mesh face, within three walls of its plane.
 *
 * The face's own geometry is read in the model's coordinates; `dz` is the bed placement the written
 * file carries (Z only), subtracted once, in the offset from the face to each shell centroid. It is
 * not mixed into the face's own edges: doing that tilts the plane and the reading comes back empty
 * for everything, window or not.
 */
function coveringShells(file, face, dz = 0) {
  const ax = positions[face * 9];
  const ay = positions[face * 9 + 1];
  const az = positions[face * 9 + 2];
  const e1 = [positions[face * 9 + 3] - ax, positions[face * 9 + 4] - ay, positions[face * 9 + 5] - az];
  const e2 = [positions[face * 9 + 6] - ax, positions[face * 9 + 7] - ay, positions[face * 9 + 8] - az];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const nl = Math.hypot(nx, ny, nz) || 1;
  const n = [nx / nl, ny / nl, nz / nl];
  const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
  const d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
  const d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
  const den = d00 * d11 - d01 * d01 || 1;
  let over = 0;
  for (let t = 0; t < file.indices.length / 3; t += 1) {
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let k = 0; k < 3; k += 1) {
      const v = file.indices[t * 3 + k] * 3;
      px += file.shell[v] / 3;
      py += file.shell[v + 1] / 3;
      pz += file.shell[v + 2] / 3;
    }
    const wx = px - ax;
    const wy = py - ay;
    const wz = pz - az - dz;
    if (Math.abs(wx * n[0] + wy * n[1] + wz * n[2]) > params.wall * 3) continue;
    const d02 = wx * e1[0] + wy * e1[1] + wz * e1[2];
    const d12 = wx * e2[0] + wy * e2[1] + wz * e2[2];
    const v = (d11 * d02 - d01 * d12) / den;
    const w = (d00 * d12 - d01 * d02) / den;
    if (1 - v - w > 0.2 && v > 0.2 && w > 0.2) over += 1;
  }
  return over;
}



{
  const spot = frontMostIn(centre.y + size.y * 0.18, centre.y + size.y * 0.34);
  const near = (p, lo, hi) => {
    for (let t = 0; t < faceCount; t += 1) {
      const c = faceCentroid(t);
      const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      if (d > lo && d < hi) return t;
    }
    return -1;
  };
  // The triangle a click lands on, the next click beside it, one across the mask, and a face the
  // mask has to cover — the four the readings need.
  const clicked = near(spot, 0, 0.5);
  const beside = near(spot, 2, 3);
  const away = near(spot, 8, 12);
  const covered = near(spot, 5, 8);

  const one = createSelection(faceCount);
  one.faces[clicked] = 1;
  const oneRes = buildStencil({ topology, painted: paintedFromFaces(one), params });
  const oneFile = oneRes.ok ? exportedFile(oneRes) : null;
  check(
    'a clicked face builds with the panel’s own numbers, no slider touched',
    oneRes.ok === true && oneRes.stats.windowLoops === 1 && oneRes.stats.windowOpen === true,
    oneRes.ok ? `${oneRes.stats.windowLoops} window(s), reach ${fmt(oneRes.stats.coverRadius)}` : oneRes.warnings.join(' '),
  );
  check(
    'and the file the export writes has that window in it: one tunnel through the shell',
    oneFile !== null && oneFile.windows === 1 && validateSolid(oneRes).watertight === true,
    oneFile
      ? `χ ${oneFile.chi} -> ${oneFile.windows} tunnel(s); ${fmt(oneFile.triangles)} triangles, ` +
        `${fmt(coveringShells(oneFile, covered, oneFile.dz))} of them over model ` +
        `${Math.hypot(...faceCentroid(covered).map((n, i) => n - spot[i])).toFixed(1)} away, ` +
        `${fmt(coveringShells(oneFile, clicked, oneFile.dz))} over the clicked face`
      : 'no file',
  );

  // Two more clicks, two more windows — the file has to carry a tunnel per window, and the same
  // reading has to hold for a face on the far side of the mask.
  one.faces[beside] = 1;
  one.faces[away] = 1;
  const threeRes = buildStencil({ topology, painted: paintedFromFaces(one), params });
  const threeFile = threeRes.ok ? exportedFile(threeRes) : null;
  check(
    'three clicked faces are three windows, and three tunnels in the written file',
    threeFile !== null && threeRes.stats.windowLoops === 3 && threeFile.windows === 3,
    threeFile
      ? `${fmt(countSelected(one))} faces clicked -> χ ${threeFile.chi} -> ${threeFile.windows} tunnel(s)`
      : 'no file',
  );

  // The workflow in the report: click a Part panel, then click one face well outside it. Both are
  // the one selection, so the file carries a window for each — and the added triangle, which the
  // report said never reached the stencil, changes the file's topology the way the panel did.
  const mixed = createSelection(faceCount);
  applyFaces(mixed, facesNear(spot, brush), { add: false });
  const panelRes = buildStencil({ topology, painted: paintedFromFaces(mixed), params });
  const panelFile = panelRes.ok ? exportedFile(panelRes) : null;
  mixed.faces[away] = 1;
  const mixedRes = buildStencil({ topology, painted: paintedFromFaces(mixed), params });
  const mixedFile = mixedRes.ok ? exportedFile(mixedRes) : null;
  check(
    'a face clicked onto a Part panel opens its own window in the written file',
    mixedFile !== null && panelFile !== null &&
      mixedRes.stats.windowLoops === panelRes.stats.windowLoops + 1 &&
      mixedFile.windows === panelFile.windows + 1,
    mixedFile
      ? `${fmt(countSelected(mixed))} faces selected, ${panelRes.stats.windowLoops} -> ${mixedRes.stats.windowLoops} ` +
        `window(s); the file's tunnels ${panelFile.windows} -> ${mixedFile.windows}`
      : 'no file',
  );
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all app-path checks passed'}`);
process.exit(failures ? 1 : 0);
