// Seam-based parts: click a panel of the model and get a window exactly that size.
//
//   node test/parts.test.mjs
//
// Three levels: the crease rule itself on a synthetic cube where the answer is known, the
// segmentation of the real model (how many parts, how big, that every face lands in one), and
// the end-to-end promise — select a part, build a stencil, and the window opens over that part
// and nothing else. The selection is written the way the app writes it: faces in, corners out.

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
  SelectionHistory,
} from '../js/selection.js';
import { buildTopology, buildStencil, stencilDefaultsForDiagonal, geodesicField } from '../js/stencil.js';
import { buildParts, partSoupVertices, partsNearPoint, DEFAULT_SEAM_ANGLE } from '../js/parts.js';
import { sourceTriangleIndex } from '../js/viewer.js';
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
const tint = new SelectionTint(geometry);
const topo = buildTopology(positions, tint.vertexCount);
// The one selection, and the one step that shows it: faces -> corner flags. `paint()` is the
// app's own `syncTint`, so every check below is reading the mask the stencil build reads.
const faceCount = positions.length / 9;
const selection = createSelection(faceCount);
const history = new SelectionHistory({ limit: 40 });
const paint = () => tint.setSelection(paintedFromFaces(selection));
paint();

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
  // Choosing one from the list selects exactly that panel, not the one under the cursor.
  const pick = partSoupVertices(parts, thin.part, []);
  const picked = applyFaces(selection, facesFromVertices(pick, faceCount));
  paint();
  check(
    'picking a panel from the list selects exactly that panel',
    picked === parts.partSizes[thin.part] && countSelected(selection) === parts.partSizes[thin.part],
    `part ${thin.part + 1}: ${fmt(picked)} of ${fmt(parts.partSizes[thin.part])} faces`,
  );
  check(
    'and leaves the giant panel the click landed on alone',
    tint.stats().painted === parts.partSizes[thin.part] * 3,
    `${fmt(tint.stats().painted)} corners, all of them from that one panel`,
  );
  // Leave the selection and the history exactly as this section found them, so the checks below
  // (which count undo steps) still see a clean slate.
  applyFaces(selection, new Uint8Array(faceCount));
  paint();
  history.undoStack.length = 0;
  history.redoStack.length = 0;
}

const raw = buildParts(topo, { seamAngleDeg: DEFAULT_SEAM_ANGLE, minPartFaces: 0 });
check(
  'merging is what removes the tail',
  raw.partCount > parts.partCount * 10,
  `${fmt(raw.partCount)} parts unmerged -> ${fmt(parts.partCount)} merged`,
);

// ------------------------------------------------- what a click actually reports
//
// The Part tool selects `parts.facePart[hit.faceIndex]`, so the face index a raycast reports has
// to be the hit triangle in *file order* — the order the mask, the welded topology and this
// segmentation are all built in. MeshBVH installs an index buffer of its own on a mesh that has
// none and groups the triangles in BVH order, so its own `faceIndex` counts in that order:
// every ray below then lands on an unrelated panel, with the index still in range, so nothing
// throws — the Part tool just paints a panel from elsewhere in the model, at every seam angle.
// This drives a real BVH raycast through a real camera, the way the viewer does, and holds the
// picker to the contract: the face it reports is the triangle the ray hit, and the detail
// panels a user can see on screen are panels they can click.
{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.raycast = acceleratedRaycast;
  const group = new THREE.Group();
  group.add(mesh);
  group.rotation.set(-Math.PI / 2, 0, 0); // the app's 'z' up axis, as viewer.applyUpAxis sets it
  group.updateMatrixWorld(true);
  // Read before the BVH below installs an index of its own, as viewer.setGeometry does.
  const soupSource = !geometry.index;
  geometry.boundsTree = new MeshBVH(geometry);

  const W = 1280;
  const H = 800;
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 10000);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  const centre = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  const dist = (size.length() * 0.5 / Math.sin((35 * Math.PI) / 180 / 2)) * 1.08; // viewer.frameModel
  camera.position.copy(centre).addScaledVector(new THREE.Vector3(0.35, 0.55, 0.78).normalize(), dist);
  camera.near = Math.max(dist / 2000, 0.01);
  camera.far = dist * 40;
  camera.updateProjectionMatrix();
  camera.lookAt(centre);
  camera.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const ndc = new THREE.Vector2();
  const pick = (px, py) => {
    ndc.set((px / W) * 2 - 1, -(py / H) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(mesh, false)[0];
    return hit ? { face: sourceTriangleIndex(hit, soupSource), raw: hit.faceIndex, local: mesh.worldToLocal(hit.point.clone()) } : null;
  };

  // Barycentric containment: is `tri` the file-order triangle the point sits on?
  const contains = (tri, p) => {
    const P = [0, 1, 2].map((k) => positions[tri * 9 + k]);
    const B = [0, 1, 2].map((k) => positions[tri * 9 + 3 + k]);
    const C = [0, 1, 2].map((k) => positions[tri * 9 + 6 + k]);
    const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const v0 = sub(C, P);
    const v1 = sub(B, P);
    const v2 = [p.x - P[0], p.y - P[1], p.z - P[2]];
    const d00 = dot(v0, v0);
    const d01 = dot(v0, v1);
    const d11 = dot(v1, v1);
    const d20 = dot(v2, v0);
    const d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    const v = (d11 * d20 - d01 * d21) / den;
    const w = (d00 * d21 - d01 * d20) / den;
    return Math.min(1 - v - w, v, w) >= -1e-4;
  };

  let rays = 0;
  let resolvedOk = 0;
  let rawOk = 0;
  let outOfRange = 0;
  const clickedPanels = new Map();
  for (let py = 4; py < H; py += 8) {
    for (let px = 4; px < W; px += 8) {
      const hit = pick(px, py);
      if (!hit) continue;
      rays += 1;
      const id = parts.facePart[hit.face];
      if (id === undefined) outOfRange += 1;
      else clickedPanels.set(id, (clickedPanels.get(id) || 0) + 1);
      if (contains(hit.face, hit.local)) resolvedOk += 1;
      if (contains(hit.raw, hit.local)) rawOk += 1;
    }
  }
  check(
    'every raycast reports the triangle it hit, in file order',
    rays > 500 && resolvedOk === rays && outOfRange === 0,
    `${resolvedOk}/${rays} hits resolve to the containing triangle (${outOfRange} out of range)`,
  );
  // The trap this pins: the raw BVH index is a different triangle, from its own ordering. If a
  // future BVH returns file-order indices this fails loudly, and the translation can go.
  check(
    'the BVH face index alone would land on another panel, so the picker translates it',
    rawOk / rays < 0.01,
    `${rawOk}/${rays} raw indices point at the containing triangle`,
  );
  const detailOnScreen = [...clickedPanels.keys()].filter((id) => parts.partSizes[id] >= 1000 && parts.partSizes[id] < topo.faceCount * 0.05);
  check(
    'a click can reach the detail panels it can see (eyes, brows, mouth)',
    detailOnScreen.length >= 6,
    `${detailOnScreen.length} small panels reachable on screen: ${detailOnScreen.join(', ')}`,
  );
}

// ------------------------------------------------------------- selecting a part
//
// A part arrives from the segmentation as a list of soup vertices, and the selection is a set of
// faces: `facesFromVertices` is the join, and it is the same function `main.js` uses, so what is
// checked here is what a Part click does.

// A limb-sized part: big enough to be a real window, small enough to build quickly.
const limbId = parts.partSizes.findIndex((n) => n >= 4000 && n <= 25000);
const limbFaces = parts.partSizes[limbId];
const limbIndices = partSoupVertices(parts, limbId);
const unique = new Set(limbIndices);
check('a limb-sized part exists to click', limbId >= 0 && limbFaces >= 4000, `part ${limbId}: ${fmt(limbFaces)} faces`);

const before = Uint8Array.from(selection.faces);
history.remember(selection);
const picked = applyFaces(selection, facesFromVertices(limbIndices, faceCount));
paint();
check(
  'clicking a part selects exactly its faces',
  picked === limbFaces && countSelected(selection) === limbFaces && tint.stats().painted === unique.size,
  `${fmt(picked)} faces, ${fmt(unique.size)} corners`,
);
check('one part click is one undo step', history.undoStack.length === 1 && history.canUndo);

history.undo(selection);
paint();
let diff = 0;
for (let i = 0; i < before.length; i += 1) if (before[i] !== selection.faces[i]) diff += 1;
check('undo takes the whole part back', diff === 0 && countSelected(selection) === 0, `${fmt(diff)} faces differ`);
history.redo(selection);
paint();
check('redo puts it back', countSelected(selection) === picked, `${fmt(countSelected(selection))} faces`);

// Shift-click adds another part to the selection instead of replacing it.
const secondId = parts.partSizes.findIndex((n, id) => id !== limbId && n >= 200 && n <= 3000);
const secondIndices = partSoupVertices(parts, secondId);
const secondFaces = parts.partSizes[secondId];
const grouped = new Set([...unique, ...new Set(secondIndices)]);
const addedSecond = applyFaces(selection, facesFromVertices(secondIndices, faceCount), { add: true });
paint();
check(
  'two parts can be composed into one window (shift-click)',
  addedSecond === secondFaces && countSelected(selection) === limbFaces + secondFaces &&
    tint.stats().painted === grouped.size,
  `${fmt(countSelected(selection))} faces from parts ${limbId} and ${secondId}, ${fmt(tint.stats().painted)} corners`,
);
// and a plain click on a third part replaces the selection rather than piling up
const thirdId = parts.partSizes.findIndex((n, id) => id !== limbId && id !== secondId && n >= 200);
const thirdIndices = partSoupVertices(parts, thirdId);
const thirdFaces = parts.partSizes[thirdId];
applyFaces(selection, facesFromVertices(thirdIndices, faceCount));
paint();
check(
  'a plain click replaces the selection',
  countSelected(selection) === thirdFaces && tint.stats().painted === new Set(thirdIndices).size,
  `${fmt(countSelected(selection))} faces for part ${thirdId}, ${fmt(tint.stats().painted)} corners`,
);

// ------------------------------------------------- the window is the part, end to end

applyFaces(selection, new Uint8Array(faceCount));
applyFaces(selection, facesFromVertices(limbIndices, faceCount));
paint();
check(
  'one click on the limb is the whole window',
  countSelected(selection) === limbFaces && tint.stats().painted === unique.size,
  `${fmt(countSelected(selection))} faces selected`,
);

// This is the object the build is handed: `main.js` derives it the same way, from the selection.
const paintedFlags = paintedFromFaces(selection);
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
