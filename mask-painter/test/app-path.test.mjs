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
import { buildBinarySTL, buildMaskJSON, parseMaskJSON } from '../js/io.js';
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

console.log(`\n${failures ? `${failures} failure(s)` : 'all app-path checks passed'}`);
process.exit(failures ? 1 : 0);
