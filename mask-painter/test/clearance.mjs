// Measures the real gap between the mask's inner face and the model surface.
//
// The nominal standoff is what the generator offsets by, but the true clearance can be
// smaller: offsetting along vertex normals closes the gap in concave regions, and the
// generator deliberately clamps the offset back in tight creases so the inner face does not
// dig in. This prints the distribution of true distances for a few painted areas and
// standoffs, which is what decides whether a printed mask slides onto the figure.
//
//   node test/clearance.mjs [standoff [standoff ...]]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { MaskLayer } from '../js/mask.js';
import { createFeatureList } from '../js/features.js';
import { buildTopology, buildStencil, stencilDefaultsForDiagonal } from '../js/stencil.js';
import { parseBinarySTL, fmt, TriGrid } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const parsed = parseBinarySTL(fs.readFileSync(path.resolve(here, '../../Sprunki Mercuy.stl')));
const positions = Float32Array.from(parsed.positions);
const grid = new TriGrid(parsed.positions, 2);

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.computeBoundingBox();
const bbox = geometry.boundingBox;
const centre = bbox.getCenter(new THREE.Vector3());
const size = bbox.getSize(new THREE.Vector3());
const diagonal = size.length();

const maskLayer = new MaskLayer(geometry, createFeatureList());
const brush = Math.max(0.5, diagonal / 45);

/** Two eye discs, and a bigger cap over the top of the head. */
function paintEyes() {
  const ml = new MaskLayer(geometry, createFeatureList());
  const eye = (side) => {
    let best = null;
    for (let i = 0; i < ml.vertexCount; i += 1) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (y < centre.y + size.y * 0.18 || y > centre.y + size.y * 0.34) continue;
      if (side > 0 ? x < centre.x : x > centre.x) continue;
      if (!best || z > best[2]) best = [x, y, z];
    }
    ml.paintSphere(best, brush, 1);
    return best;
  };
  eye(-1);
  eye(1);
  return ml;
}

function paintHeadCap() {
  const capY = bbox.min.y + size.y * 0.78;
  const ml = new MaskLayer(geometry, createFeatureList());
  const p = [centre.x, bbox.max.y, centre.z];
  ml.paintSphere(p, diagonal * 0.12, 1);
  void capY;
  return ml;
}

const areas = [
  ['two eyes (default brush)', paintEyes()],
  ['head cap (12% of the diagonal)', paintHeadCap()],
];

const wanted = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const standoffs = wanted.length ? wanted : [0.05, 0.1, 0.2, 0.3];

const topology = buildTopology(positions, maskLayer.vertexCount);
const defaults = stencilDefaultsForDiagonal(diagonal);

console.log(`model diagonal ${fmt(diagonal, 1)} units — standoffs ${standoffs.join(', ')}\n`);
console.log(
  'area                              standoff  min     p0.5    p5      median  <0.05  <0.1  <0.15  interior',
);

for (const [name, ml] of areas) {
  const painted = new Uint8Array(ml.vertexCount);
  for (let i = 0; i < painted.length; i += 1) if (ml.ids[i] !== 0) painted[i] = 1;
  for (const standoff of standoffs) {
    const params = {
      ...defaults,
      standoff,
      edgeLip: Math.min(defaults.wall * 0.5, defaults.edgeLip),
      edgeFade: Math.max(defaults.edgeFade, defaults.wall * 2),
      maxCoverRadius: defaults.maxCoverRadius,
    };
    const res = buildStencil({ topology, painted, params });
    if (!res.ok) {
      console.log(`${name.padEnd(33)} ${String(standoff).padEnd(9)} refused: ${res.warnings[0]}`);
      continue;
    }
    const surfCount = res.stats.solidVertices / 2;
    const dists = [];
    let interior = 0;
    for (let k = 0; k < surfCount; k += 1) {
      const x = res.positions[k * 6];
      const y = res.positions[k * 6 + 1];
      const z = res.positions[k * 6 + 2];
      const hit = grid.signed(x, y, z, 2);
      if (!Number.isFinite(hit.dist)) continue;
      if (hit.sign < 0) interior += 1;
      dists.push(hit.dist);
    }
    dists.sort((a, b) => a - b);
    const at = (q) => (dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * q))] : NaN);
    const below = (t) => dists.filter((d) => d < t).length;
    console.log(
      `${name.padEnd(33)} ${String(standoff).padEnd(9)} ` +
        `${at(0).toFixed(3)}   ${at(0.005).toFixed(3)}   ${at(0.05).toFixed(3)}   ${at(0.5).toFixed(3)}   ` +
        `${String(below(0.05)).padStart(5)}  ${String(below(0.1)).padStart(4)}  ${String(below(0.15)).padStart(5)}  ` +
        `${String(interior).padStart(8)}`,
    );
  }
}
