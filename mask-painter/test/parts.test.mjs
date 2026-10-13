// Seam-based parts: click a panel of the model and get a window exactly that size.
//
//   node test/parts.test.mjs
//
// Three levels: the crease rule itself on a synthetic cube where the answer is known, the
// segmentation of the real model (how many parts, how big, that every face lands in one), and
// the end-to-end promise — paint a part, build a stencil, and the window opens over that part
// and nothing else.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { MaskLayer } from '../js/mask.js';
import { createFeatureList } from '../js/features.js';
import { buildTopology, buildStencil, stencilDefaultsForDiagonal, geodesicField } from '../js/stencil.js';
import { buildParts, partSoupVertices, partsNearPoint, DEFAULT_SEAM_ANGLE } from '../js/parts.js';
import { parseBinarySTL, fmt, TriGrid, InsideTester } from './helpers.mjs';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- the rule, on a cube

/** A unit cube as a triangle soup: 6 flat faces, 90° creases between them. */
function cubeSoup() {
  const v = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3],
  ];
  const out = [];
  for (const [a, b, c, d] of quads) {
    for (const t of [[a, b, c], [a, c, d]]) for (const i of t) out.push(...v[i]);
  }
  return Float32Array.from(out);
}

{
  const soup = cubeSoup();
  const topo = buildTopology(soup, soup.length / 3);
  check('cube welds to 8 vertices and 12 faces', topo.wCount === 8 && topo.faceCount === 12, `${topo.wCount} / ${topo.faceCount}`);

  const tight = buildParts(topo, { seamAngleDeg: 10, minPartFaces: 0 });
  check(
    'creases at 90° cut the cube into its 6 flat faces',
    tight.partCount === 6 && tight.partSizes.every((n) => n === 2),
    `${tight.partCount} parts of ${tight.partSizes.join('/')} faces`,
  );
  check('and they are found by the seam edges', tight.seamEdges === 12, `${tight.seamEdges} seam edges`);

  const loose = buildParts(topo, { seamAngleDeg: 120, minPartFaces: 0 });
  check('a 120° angle treats the whole cube as one part', loose.partCount === 1 && loose.seamEdges === 0, `${loose.partCount} parts`);

  const one = partSoupVertices(tight, 0);
  check('a part reports the soup vertices of its faces', one.length === 6, `${one.length} indices: ${one.join(',')}`);
}

// ---------------------------------------------------------------- the real model

const parsed = parseBinarySTL(fs.readFileSync(path.resolve(here, '../../Sprunki Mercuy.stl')));
const positions = Float32Array.from(parsed.positions);
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.computeBoundingBox();
const mask = new MaskLayer(geometry, createFeatureList());
const topo = buildTopology(positions, mask.vertexCount);

const t0 = Date.now();
// ---- panels near a point: what the Part panel offers when a click lands on the wrong one
{
  const cubeTopo = buildTopology(cubeSoup(), 36);
  const cube = buildParts(cubeTopo, { seamAngleDeg: 10, minPartFaces: 0 });
  // face 0 is the z=0 quad; its centre is 0.62-0.71 from the four side faces and 1.03 from
  // the one opposite it.
  const centreOfFace0 = [0.5, 0.5, 0];
  const near = partsNearPoint(cube, cubeTopo, centreOfFace0, 0.7, { excludePart: 0 });
  check(
    'a point on a cube face finds the four faces beside it',
    near.length === 4 && near.every((n) => n.part !== cube.facePart[2]),
    near.map((n) => `part ${n.part} @${n.distance.toFixed(2)}`).join(' '),
  );
  check(
    'they come back nearest first',
    near.every((n, i) => i === 0 || near[i - 1].distance <= n.distance),
    near.map((n) => n.distance.toFixed(2)).join(' <= '),
  );
  check(
    'the face you are standing on is left out',
    partsNearPoint(cube, cubeTopo, centreOfFace0, 0.7).some((n) => n.part === 0) &&
      !near.some((n) => n.part === 0),
  );
  check(
    'sizes travel with the candidates, so the small one can be told apart',
    near.every((n) => n.faces === cube.partSizes[n.part] && Math.abs(n.share - 1 / 6) < 1e-9),
    near.map((n) => `${n.faces} faces, ${(n.share * 100).toFixed(1)}%`).join(' | '),
  );
  // The face under the point is 0.24 away (its own triangles), the ones beside it 0.62.
  check(
    'a radius smaller than the nearest panel returns nothing',
    partsNearPoint(cube, cubeTopo, centreOfFace0, 0.35, { excludePart: 0 }).length === 0,
  );
  check('the list is capped', partsNearPoint(cube, cubeTopo, centreOfFace0, 0.7, { limit: 2 }).length === 2);
  check('a zero radius is not a query', partsNearPoint(cube, cubeTopo, centreOfFace0, 0).length === 0);
}

const parts = buildParts(topo, { seamAngleDeg: DEFAULT_SEAM_ANGLE });
const ms = Date.now() - t0;
console.log(
  `      ${fmt(parts.partCount)} parts at ${parts.seamAngleDeg}° in ${ms} ms · ` +
    `${fmt(parts.mergedSpecks)} slivers merged into neighbours · ${fmt(parts.seamEdges)} seam edges`,
);
console.log(
  `      sizes: ${parts.partSizes.slice(0, 10).map((n) => fmt(n)).join(' faces, ')} faces` +
    (parts.partSizes.length > 10 ? ', …' : ''),
);

const assigned = parts.facePart.reduce((counts, id) => {
  counts[id] = (counts[id] || 0) + 1;
  return counts;
}, []);
check('every face lands in exactly one part', parts.facePart.every((id) => id >= 0 && id < parts.partCount));
check(
  'part sizes match the faces that claim them',
  parts.partSizes.every((n, id) => assigned[id] === n),
  `${parts.partCount} parts`,
);
check('parts are ordered biggest first', parts.partSizes.every((n, i) => i === 0 || parts.partSizes[i - 1] >= n));
const usable = parts.partSizes.filter((n) => n >= 5000).length;
check(
  'the default angle gives a handful of parts worth clicking',
  parts.partCount >= 5 && parts.partCount <= 60 && usable >= 3 && parts.partSizes[0] / topo.faceCount < 0.8,
  `${parts.partCount} parts, ${usable} with 5,000+ faces, biggest ${(parts.partSizes[0] / topo.faceCount * 100).toFixed(0)}% of the model`,
);
// The default angle is the coarsest cut at which the small facial panels survive as panels of
// their own — at 12° (the Body parts preset) both eyebrows merge into the 48% panel behind
// them, which is what makes a Part click aimed at one select half the model instead.
const detailPanels = (d) => d.partSizes.filter((n) => n >= 1000 && n < topo.faceCount * 0.05).length;
{
  const coarser = buildParts(topo, { seamAngleDeg: 12 });
  check(
    'the default cuts finer than 12°, so the small panels stay clickable panels',
    parts.partCount > coarser.partCount &&
      parts.partSizes[0] < coarser.partSizes[0] &&
      detailPanels(parts) > detailPanels(coarser),
    `${parts.partCount} panels at ${parts.seamAngleDeg}° (biggest ${fmt(parts.partSizes[0])} = ` +
      `${((parts.partSizes[0] / topo.faceCount) * 100).toFixed(0)}%, ${detailPanels(parts)} detail-sized) vs ` +
      `${coarser.partCount} at 12° (biggest ${((coarser.partSizes[0] / topo.faceCount) * 100).toFixed(0)}%, ` +
      `${detailPanels(coarser)} detail-sized)`,
  );
}

const belowMin = parts.partSizes.filter((n) => n < parts.minPartFaces).length;
check(
  'slivers are merged away, not left as clickable specks',
  belowMin / parts.partCount < 0.05,
  `${belowMin} of ${parts.partCount} parts below ${parts.minPartFaces} faces`,
);
// ---- why a click can select "everything except the thing you aimed at"
//
// On this model the opening panel is half the mesh and the details are fractions of a percent
// of it, so a click that misses a thin panel by a little paints the panel behind it — half the
// model — while the thin one stays bare, which reads as the button running backward. The
// numbers below are the reason the panel list exists.
{
  const biggest = parts.partSizes[0];
  const smallest = parts.partSizes[parts.partCount - 1];
  check(
    'one panel dominates the model, so a near-miss paints half of it',
    biggest / topo.faceCount > 0.4,
    `part 1 is ${fmt(biggest)} faces = ${((biggest / topo.faceCount) * 100).toFixed(1)}% of the mesh`,
  );
  check(
    'the panels a click can miss are fractions of a percent',
    smallest < 500 && smallest / topo.faceCount < 0.002,
    `smallest panel ${fmt(smallest)} faces = ${((smallest / topo.faceCount) * 100).toFixed(3)}% of the mesh`,
  );
  // The realistic miss: the cursor was on a thin panel, the ray hit the giant one behind it.
  const thinId = parts.partSizes.findIndex((n) => n > 200 && n < 600);
  const thinFace = parts.facePart.findIndex((id) => id === thinId);
  const a = topo.faces[thinFace * 3] * 3;
  const b = topo.faces[thinFace * 3 + 1] * 3;
  const c = topo.faces[thinFace * 3 + 2] * 3;
  const pt = [0, 1, 2].map((k) => (topo.positions[a + k] + topo.positions[b + k] + topo.positions[c + k]) / 3);
  const radius = 3.2; // the app's default brush on this model
  const found = partsNearPoint(parts, topo, pt, radius, { excludePart: 0, limit: 6 });
  const thin = found.find((n) => n.part === thinId);
  check(
    'the panel the click missed is on the list it offers',
    Boolean(thin) && thin.distance < radius,
    `part ${thinId + 1} (${fmt(parts.partSizes[thinId])} faces) is ${thin ? thin.distance.toFixed(2) : '-'} from the click`,
  );
  check(
    'the list is short, ranked and size-labelled',
    found.length <= 6 && found.every((n, i) => i === 0 || found[i - 1].distance <= n.distance) &&
      found.every((n) => n.share === parts.partSizes[n.part] / topo.faceCount),
    found.map((n) => `part ${n.part + 1}:${fmt(n.faces)}@${n.distance.toFixed(1)}`).join(' '),
  );
  // Choosing one from the list paints exactly that panel, not the one under the cursor.
  const pick = partSoupVertices(parts, thin.part, []);
  mask.beginStroke();
  const painted = mask.paintIndices(pick, 5);
  const recorded = mask.endStroke();
  mask.flush();
  check(
    'picking a panel from the list paints exactly that panel',
    recorded && painted === parts.partSizes[thin.part] * 3,
    `part ${thin.part + 1}: ${fmt(painted)} of ${fmt(parts.partSizes[thin.part] * 3)} vertices`,
  );
  check(
    'and leaves the giant panel the click landed on alone',
    mask.stats().counts.get(1) === undefined,
    `feature 1 has ${fmt(mask.stats().counts.get(1) || 0)} vertices`,
  );
  // Leave the mask and the history exactly as this section found them, so the checks below
  // (which count undo steps) still see a clean slate.
  mask.clearAll();
  mask.history.length = 0;
  mask.redoStack.length = 0;
}

const raw = buildParts(topo, { seamAngleDeg: DEFAULT_SEAM_ANGLE, minPartFaces: 0 });
check(
  'merging is what removes the tail',
  raw.partCount > parts.partCount * 10,
  `${fmt(raw.partCount)} parts unmerged -> ${fmt(parts.partCount)} merged`,
);

// ---------------------------------------------------------------- painting a part

// A limb-sized part: big enough to be a real window, small enough to build quickly.
const limbId = parts.partSizes.findIndex((n) => n >= 4000 && n <= 25000);
const limbFaces = parts.partSizes[limbId];
const limbIndices = partSoupVertices(parts, limbId);
const unique = new Set(limbIndices);
check('a limb-sized part exists to click', limbId >= 0 && limbFaces >= 4000, `part ${limbId}: ${fmt(limbFaces)} faces`);

const before = Int16Array.from(mask.ids);
mask.beginStroke();
const painted = mask.paintIndices(limbIndices, 1);
mask.endStroke();
check(
  'clicking a part paints exactly its vertices',
  painted === mask.stats().painted && painted === unique.size,
  `${fmt(painted)} painted, ${fmt(unique.size)} unique vertices in the part`,
);
check('one part click is one undo step', mask.history.length === 1 && mask.canUndo());

mask.undo();
let diff = 0;
for (let i = 0; i < before.length; i += 1) if (before[i] !== mask.ids[i]) diff += 1;
check('undo takes the whole part back', diff === 0 && mask.stats().painted === 0, `${fmt(diff)} vertices differ`);
mask.redo();
check('redo puts it back', mask.stats().painted === painted, `${fmt(mask.stats().painted)} painted`);

// Shift-click adds another part to the same feature instead of replacing the selection.
const secondId = parts.partSizes.findIndex((n, id) => id !== limbId && n >= 200 && n <= 3000);
const secondIndices = partSoupVertices(parts, secondId);
const grouped = new Set([...unique, ...new Set(secondIndices)]);
mask.beginStroke();
mask.paintIndices(secondIndices, 1);
mask.endStroke();
check(
  'two parts can be composed into one window (shift-click)',
  mask.stats().painted === grouped.size && mask.stats().counts.get(1) === grouped.size,
  `${fmt(mask.stats().painted)} vertices from parts ${limbId} and ${secondId}`,
);
// and a plain click on a third part replaces the selection rather than piling up
const thirdId = parts.partSizes.findIndex((n, id) => id !== limbId && id !== secondId && n >= 200);
const thirdIndices = partSoupVertices(parts, thirdId);
mask.beginStroke();
mask.paintIndices(mask.verticesOf(1, []), 0);
mask.paintIndices(thirdIndices, 1);
mask.endStroke();
check(
  'a plain click replaces the selection',
  mask.stats().painted === new Set(thirdIndices).size,
  `${fmt(mask.stats().painted)} vertices for part ${thirdId}`,
);

// ------------------------------------------------- the window is the part, end to end

mask.clearAll({ record: false });
for (let i = 0; i < mask.vertexCount; i += 1) mask.ids[i] = 0;
mask.refreshColors();
mask.beginStroke();
mask.paintIndices(limbIndices, 1);
mask.endStroke();

const paintedFlags = new Uint8Array(mask.vertexCount);
for (let i = 0; i < paintedFlags.length; i += 1) if (mask.ids[i] !== 0) paintedFlags[i] = 1;
const paintedFlagsW = new Uint8Array(topo.wCount);
for (let i = 0; i < paintedFlags.length; i += 1) if (paintedFlags[i]) paintedFlagsW[topo.weldOf[i]] = 1;

const tBuild = Date.now();
// Widen-reach is off: for a part-sized window a local band around the part is wanted, and
// growing the reach instead balloons the shell over the whole figure.
const res = buildStencil({
  topology: topo,
  painted: paintedFlags,
  params: { ...stencilDefaultsForDiagonal(topo.diagonal), growIfSplit: false },
});
console.log(
  `      part ${limbId} as the window: ${res.ok ? `${fmt(res.stats.solidTriangles)} triangles, ` +
    `${res.stats.components} piece(s), ${res.stats.windowLoops} window(s), ` +
    `wall ${res.stats.thicknessMin.toFixed(2)}–${res.stats.thicknessMax.toFixed(2)}, ` +
    `${fmt(Date.now() - tBuild)} ms` : res.warnings.join(' ')}`,
);
check('a clicked part builds a stencil', res.ok === true, res.ok ? '' : res.warnings.join(' '));
check(
  'the build reports the pieces it came out in instead of hiding them',
  res.ok && (res.stats.components === 1 || res.warnings.some((w) => /separate pieces/.test(w))),
  res.ok ? `${res.stats.components} piece(s): ${res.warnings.filter((w) => /pieces/.test(w)).join(' ') || 'one piece'}` : '',
);

if (res.ok) {
  const soup = new Float32Array((res.indices.length / 3) * 9);
  for (let i = 0; i < res.indices.length; i += 1) {
    const s = res.indices[i] * 3;
    soup[i * 3] = res.positions[s];
    soup[i * 3 + 1] = res.positions[s + 1];
    soup[i * 3 + 2] = res.positions[s + 2];
  }
  const maskGrid = new TriGrid(soup, 2);
  const insideMask = new InsideTester(maskGrid);

  // Surface distance from the painted part decides what the shell should cover: straight-line
  // distance does not, because the far side of a limb is a few units away through the limb and
  // tens of units away across its surface.
  const fromPaint = geodesicField(
    topo,
    (() => {
      const seeds = [];
      for (let v = 0; v < topo.wCount; v += 1) if (paintedFlagsW[v]) seeds.push(v);
      return seeds;
    })(),
    { maxDist: 45 },
  );

  const centroidProbe = (t) => {
    const a = t * 9;
    const c = [0, 1, 2].map((d) => (positions[a + d] + positions[a + 3 + d] + positions[a + 6 + d]) / 3);
    const u = [positions[a + 3] - positions[a], positions[a + 4] - positions[a + 1], positions[a + 5] - positions[a + 2]];
    const v = [positions[a + 6] - positions[a], positions[a + 7] - positions[a + 1], positions[a + 8] - positions[a + 2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    return {
      c,
      n,
      covered: insideMask.test(c[0] + n[0] * 0.25, c[1] + n[1] * 0.25, c[2] + n[2] * 0.25),
      face: t,
    };
  };

  // How far inside the painted area each welded vertex sits: the window deliberately insets
  // its edge, so only the interior is expected to be open.
  const border = [];
  for (let v = 0; v < topo.wCount; v += 1) {
    if (!paintedFlagsW[v]) continue;
    for (let k = topo.neighborStart[v]; k < topo.neighborStart[v + 1]; k += 1) {
      if (!paintedFlagsW[topo.neighbors[k]]) {
        border.push(v);
        break;
      }
    }
  }
  const depth = geodesicField(topo, border, { maxDist: 12 });

  let openSamples = 0;
  let openMaterial = 0;
  let edgeCovered = 0;
  let edgeSamples = 0;
  for (let t = 0; t < parts.facePart.length; t += 23) {
    if (parts.facePart[t] !== limbId) continue;
    const deep = [0, 1, 2].every((k) => depth[topo.faces[t * 3 + k]] > 3);
    const r = centroidProbe(t);
    if (deep) {
      openSamples += 1;
      if (r.covered) openMaterial += 1;
    } else {
      edgeSamples += 1;
      if (r.covered) edgeCovered += 1;
    }
  }
  check(
    'the window opens over the part that was clicked',
    openSamples > 30 && openMaterial / openSamples < 0.02,
    `${openMaterial}/${openSamples} face centres deep inside the part are still covered` +
      ` (${edgeCovered}/${edgeSamples} near its seam, where the window edge insets)`,
  );

  // The shell is a band around the part, not a cover for the whole figure: near the part it
  // must be there, on the far side of the model it must not be.
  let nearSamples = 0;
  let nearCovered = 0;
  let farSamples = 0;
  let farBare = 0;
  for (let t = 0; t < parts.facePart.length; t += 11) {
    if (parts.facePart[t] === limbId) continue;
    const field = Math.min(
      fromPaint[topo.faces[t * 3]],
      fromPaint[topo.faces[t * 3 + 1]],
      fromPaint[topo.faces[t * 3 + 2]],
    );
    if (!Number.isFinite(field)) {
      farSamples += 1;
      if (!centroidProbe(t).covered) farBare += 1;
      continue;
    }
    if (field > 1 && field < 10) {
      nearSamples += 1;
      if (centroidProbe(t).covered) nearCovered += 1;
    }
  }
  // Presence, not containment: the shell sits a standoff above the surface, so a ray-parity
  // test 0.25 above the model reads "outside" wherever the surface bends (only 0.06 of margin
  // over the standoff). What matters is whether shell material is there at all, which is what
  // this measures — the window check above uses parity, where the margin is large.
  const shellNear = (x, y, z, r) => maskGrid.nearest(x, y, z, 3).dist <= r;
  let bandSamples = 0;
  let bandHit = 0;
  let farShell = 0;
  for (let t = 0; t < parts.facePart.length; t += 11) {
    if (parts.facePart[t] === limbId) continue;
    const field = Math.min(
      fromPaint[topo.faces[t * 3]],
      fromPaint[topo.faces[t * 3 + 1]],
      fromPaint[topo.faces[t * 3 + 2]],
    );
    if (!Number.isFinite(field)) {
      const r = centroidProbe(t);
      if (shellNear(r.c[0], r.c[1], r.c[2], 1.5)) farShell += 1;
      continue;
    }
    if (field > 1 && field < 10) {
      const r = centroidProbe(t);
      const p = [0, 1, 2].map((d) => r.c[d] + r.n[d] * 0.25);
      bandSamples += 1;
      if (shellNear(p[0], p[1], p[2], 0.6)) bandHit += 1;
    }
  }
  check(
    'the shell wraps the band around the window',
    bandSamples > 200 && bandHit / bandSamples > 0.99,
    `${bandHit}/${bandSamples} face centres 1-10 units of surface away from the part have shell material on them`,
  );
  check(
    'and it stays local instead of sheathing the whole figure',
    farSamples > 200 && farBare / farSamples > 0.95,
    `${farBare}/${farSamples} face centres more than 45 units of surface away are bare ` +
      `(${farShell} of them had shell material within 1.5)`,
  );
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all part checks passed'}`);
process.exit(failures ? 1 : 0);
