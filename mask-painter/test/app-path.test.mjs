// Drives the export path the way the app does it: the real MaskLayer paints the real model,
// the painted ids become the stencil window, the panel's own default numbers are used, and
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
import { MaskLayer } from '../js/mask.js';
import { createFeatureList } from '../js/features.js';
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

// ---------------------------------------------------------------- the app's mask layer

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const maskLayer = new MaskLayer(geometry, createFeatureList());
check('MaskLayer wraps the loaded geometry', maskLayer.vertexCount === positions.length / 3);

// Paint two eye discs, the way a user would with the brush: feature 1 on the left eye.
const bbox = geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox);
const centre = bbox.getCenter(new THREE.Vector3());
const size = bbox.getSize(new THREE.Vector3());
const diagonal = size.length();
const brush = Math.max(0.5, diagonal / 45);

let eyeLeft = null;
let eyeRight = null;
for (let i = 0; i < maskLayer.vertexCount; i += 1) {
  const x = positions[i * 3];
  const y = positions[i * 3 + 1];
  const z = positions[i * 3 + 2];
  if (y < centre.y + size.y * 0.18 || y > centre.y + size.y * 0.34) continue;
  const p = new THREE.Vector3(x, y, z);
  if (x < centre.x && (!eyeLeft || z > eyeLeft.z)) eyeLeft = p;
  if (x > centre.x && (!eyeRight || z > eyeRight.z)) eyeRight = p;
}
const paintedLeft = maskLayer.paintSphere(eyeLeft.toArray(), brush, 1);
const paintedRight = maskLayer.paintSphere(eyeRight.toArray(), brush, 2);
check('painting two features marks vertices', paintedLeft > 0 && paintedRight > 0, `${fmt(paintedLeft)} + ${fmt(paintedRight)} vertices`);

const stats = maskLayer.stats();
check('mask stats agree with the paint', stats.painted === paintedLeft + paintedRight, `${fmt(stats.painted)} painted`);

// ---------------------------------------------------------------- the app's build path

const painted = new Uint8Array(maskLayer.vertexCount);
for (let i = 0; i < painted.length; i += 1) if (maskLayer.ids[i] !== 0) painted[i] = 1;

// Exactly the derivation the panel does (stencilParamsFromInputs / stencilDefaultsForModel).
const defaults = stencilDefaultsForDiagonal(diagonal);
const params = { ...defaults };
params.edgeLip = Math.min(params.wall * 0.5, defaults.edgeLip);
params.edgeFade = Math.max(params.edgeFade, params.wall * 2);
params.maxCoverRadius = Math.max(defaults.maxCoverRadius || defaults.coverRadius * 3, params.coverRadius * 2);

const tTopo = Date.now();
const topology = buildTopology(positions, maskLayer.vertexCount);
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
    const twoLayer = new MaskLayer(geometry, createFeatureList());
    twoLayer.paintSphere([positions[head * 3], positions[head * 3 + 1], positions[head * 3 + 2]], brush, 1);
    twoLayer.paintSphere([positions[foot * 3], positions[foot * 3 + 1], positions[foot * 3 + 2]], brush, 2);
    const paintedTwo = new Uint8Array(twoLayer.vertexCount);
    for (let i = 0; i < paintedTwo.length; i += 1) if (twoLayer.ids[i] !== 0) paintedTwo[i] = 1;
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

// ---------------------------------------------------------------- mask JSON round trip
// The app's export → import path (js/io.js + MaskLayer) on the mask this suite painted:
// what is written has to be exactly what comes back, or a saved session is a lie.
const features = createFeatureList();
const paintedBefore = maskLayer.paintedPairs();
const maskJson = JSON.stringify(
  buildMaskJSON({ mask: maskLayer, features, modelName: 'Sprunki Mercuy.stl', pairs: paintedBefore }),
);
const maskParsed = parseMaskJSON(maskJson);
check('mask JSON: format and version are the documented ones', maskParsed.data.format === 'stl-mask' && maskParsed.data.version === 1);
check('mask JSON: vertexCount is the model\'s vertex count', maskParsed.data.vertexCount === maskLayer.vertexCount, `${fmt(maskParsed.data.vertexCount, 0)}`);
check(
  'mask JSON: one pair per painted vertex, nothing per unpainted vertex',
  maskParsed.data.paintedVertices === paintedBefore.length / 2 && maskParsed.pairs.length === paintedBefore.length,
  `${fmt(paintedBefore.length / 2, 0)} vertices, ${(maskJson.length / 1048576).toFixed(1)} MB`,
);
check(
  'mask JSON: the palette survives the trip',
  maskParsed.features.length === features.length && maskParsed.features[0].color === features[0].color && maskParsed.features[0].name === features[0].name,
);
const importedMask = new MaskLayer(geometry, createFeatureList());
importedMask.loadPairs(maskParsed.pairs);
const paintedAfter = importedMask.paintedPairs();
check(
  'mask JSON: import reproduces every vertex and id',
  paintedAfter.length === paintedBefore.length && paintedAfter.every((v, i) => v === paintedBefore[i]),
  `${fmt(paintedAfter.length / 2, 0)} vertices back`,
);
// The guide documents the vertexCount mismatch as a warning rather than a refusal: the
// importer has to expose both numbers for the UI to compare.
const sample36 = { format: 'stl-mask', version: 1, vertexCount: 36, features: [], painted: [0, 1, 1, 1] };
check(
  'mask JSON: a file for another model is importable but flagged by its vertexCount',
  parseMaskJSON(JSON.stringify(sample36)).data.vertexCount !== maskLayer.vertexCount,
  `${sample36.vertexCount} vs ${fmt(maskLayer.vertexCount, 0)}`,
);

// ------------------------------------------------- the save has to match the screen
//
// The report this answers: paint a window, build the stencil, export it, Shift-click more panels,
// export again — and the second file held only the first round's windows under a fresh timestamp,
// because the export wrote the build it had in hand rather than the mask on screen. The engine was
// never the problem, so this pins the two halves the fix rests on: that the shell in hand really is
// a different, older part after more paint, and that a saved mask can be loaded back and built on.
const paintedMaskOf = (layer) => {
  const m = new Uint8Array(layer.vertexCount);
  let count = 0;
  for (let i = 0; i < m.length; i += 1) {
    if (layer.ids[i] !== 0) {
      m[i] = 1;
      count += 1;
    }
  }
  return { painted: m, count };
};
/** Frontmost surface point in a y band, so a stamp certainly lands on the model. */
function frontMostIn(yLo, yHi) {
  let best = null;
  for (let i = 0; i < maskLayer.vertexCount; i += 1) {
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
  const added = maskLayer.paintSphere(chest, brush, 3);
  check(
    'a second round of painting adds another window to the mask',
    added > 0,
    `${fmt(added)} vertices at ${chest.map((n) => n.toFixed(1)).join(', ')}`,
  );

  const round2 = buildStencil({ topology, painted: paintedMaskOf(maskLayer).painted, params });
  check(
    'the new window is its own window in a rebuild, and the parts differ',
    round2.stats.windowLoops > round1.stats.windowLoops &&
      Buffer.compare(stlBytes(round1), stlBytes(round2)) !== 0,
    `${round1.stats.windowLoops} -> ${round2.stats.windowLoops} windows, ` +
      `${stlBytes(round1).length} -> ${stlBytes(round2).length} bytes`,
  );
  // The unit the app compares when it decides a build is stale: painted vertices of the mask
  // (what `stencil.paintedCount` is set to) against the mask as it stands now.
  const round1Painted = paintedBefore.length / 2;
  check(
    'the shell in hand was built from the smaller mask',
    round1Painted < paintedMaskOf(maskLayer).count,
    `built from ${fmt(round1Painted)} painted vertices; the mask now has ` +
      `${fmt(paintedMaskOf(maskLayer).count)} — the numbers the stale test compares`,
  );

  // The other direction, which is what "remove excess from the stencil" means: take a window out
  // of the mask the way the window list's Remove row does — dump exactly the file vertices that
  // window carries, in one undoable stroke — and rebuild. The window has to leave the shell.
  const windows = maskWindows(topology, maskLayer.ids);
  const biggest = windows[0];
  const beforeRemoval = paintedMaskOf(maskLayer).count;
  maskLayer.beginStroke();
  const released = maskLayer.paintIndices(biggest.fileVertices, 0);
  const recordedRemoval = maskLayer.endStroke();
  maskLayer.flush();
  const round3 = buildStencil({ topology, painted: paintedMaskOf(maskLayer).painted, params });
  check(
    'the window list reaches the built shell: removing a window drops its window from the rebuild',
    recordedRemoval &&
      released === biggest.vertices &&
      beforeRemoval - released === paintedMaskOf(maskLayer).count &&
      round3.stats.windowLoops === round2.stats.windowLoops - 1,
    `${fmt(windows.length)} window(s) listed, largest ${fmt(biggest.vertices)} vertices released; ` +
      `${round2.stats.windowLoops} -> ${round3.stats.windowLoops} window(s) in the shell`,
  );
  maskLayer.undo();
  check(
    'and one undo puts the window back where it was',
    paintedMaskOf(maskLayer).count === beforeRemoval,
    `${fmt(paintedMaskOf(maskLayer).count)} painted again`,
  );

  // Saving the place and carrying on: the session file, reopened, keeps growing. This is the
  // "save the windows I have marked up and load them back to add more" flow.
  const savedStencil = {
    coverRadius: params.coverRadius,
    wall: params.wall,
    standoff: params.standoff,
    overhang: params.overhang,
    growIfSplit: false,
  };
  const session = JSON.stringify(
    buildMaskJSON({
      mask: maskLayer,
      features,
      modelName: 'Sprunki Mercuy.stl',
      pairs: maskLayer.paintedPairs(),
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

  const resumed = new MaskLayer(geometry, createFeatureList());
  resumed.setFeatures(reopened.features);
  resumed.loadPairs(reopened.pairs);
  let diff = 0;
  for (let i = 0; i < maskLayer.ids.length; i += 1) if (maskLayer.ids[i] !== resumed.ids[i]) diff += 1;
  check('a reloaded mask is the mask that was saved, window for window', diff === 0, `${fmt(diff)} vertices differ`);

  const mouth = frontMostIn(centre.y + size.y * 0.06, centre.y + size.y * 0.15);
  const grew = resumed.paintSphere(mouth, brush, 2);
  const resumedBuild = buildStencil({ topology, painted: paintedMaskOf(resumed).painted, params });
  check(
    'windows added after a reload reach the build',
    grew > 0 &&
      resumedBuild.stats.paintedVertices > round2.stats.paintedVertices &&
      resumedBuild.stats.windowLoops >= round2.stats.windowLoops &&
      Buffer.compare(stlBytes(resumedBuild), stlBytes(round2)) !== 0,
    `${fmt(round2.stats.paintedVertices)} -> ${fmt(resumedBuild.stats.paintedVertices)} painted vertices, ` +
      `${round2.stats.windowLoops} -> ${resumedBuild.stats.windowLoops} windows`,
  );
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all app-path checks passed'}`);
process.exit(failures ? 1 : 0);
