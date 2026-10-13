/**
 * parts.js — cut a mesh into parts along its seams, so one click can select a whole panel of
 * the model (an ear, a shoe, the front of a shirt) instead of painting it by hand.
 *
 * A seam is an edge whose two faces meet at more than `seamAngleDeg`, i.e. a crease rather
 * than a smooth curve. Flood-filling the faces without crossing seams gives connected parts;
 * clicking a part paints every vertex of every face in it, which is the "lasso" the mask
 * window wants. Deliberately dependency-free: the same code runs in the browser and in Node.
 */

// Measured on the bundled figure (422,658 faces):
//   5°  35 parts, biggest 87k (21%), 18 worth clicking — eyes, brows and mouth on their own
//   8°  26 parts, biggest 181k (43%), 14 worth clicking — the eyebrows are panels of their own
//  12°  21 parts, biggest 204k (48%), 10 worth clicking — the eyebrows merge into the 48% panel
//  25°  14 parts, biggest 221k (52%),  4 worth clicking — limbs merge into the body
//  35°  12 parts, biggest 226k (53%),  2 worth clicking — two blobs plus slivers
// 8° is the default because it is the coarsest angle at which the small facial panels survive
// as clickable parts (at 12° a click aimed at an eyebrow selects the 48% panel behind it, which
// reads as the Part tool running backward), while a whole torso or limb is still one click.
export const DEFAULT_SEAM_ANGLE = 8;

/** Faces below this many faces are treated as mesh noise and merged into a neighbour. */
export function defaultMinPartFaces(faceCount) {
  return Math.max(40, Math.round(faceCount * 0.0002));
}

/**
 * Faces of a welded mesh, split at the creases sharper than `seamAngleDeg`.
 *
 * Scanned and generated meshes are full of hairline creases, so a raw crease split leaves
 * thousands of one-triangle parts and clicking one paints a speck. Parts smaller than
 * `minPartFaces` are merged into the neighbour they share the longest seam with, which turns
 * the tail into something a click can use.
 */
export function buildParts(
  topology,
  { seamAngleDeg = DEFAULT_SEAM_ANGLE, minPartFaces = null, mergeRounds = 6 } = {},
) {
  const { faces, faceCount, positions } = topology;
  if (!faceCount) {
    return { facePart: new Int32Array(0), partCount: 0, partSizes: [], seamEdges: 0, seamAngleDeg };
  }
  const faceNormals = new Float32Array(faceCount * 3);
  for (let t = 0; t < faceCount; t += 1) {
    const a = faces[t * 3] * 3;
    const b = faces[t * 3 + 1] * 3;
    const c = faces[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    faceNormals[t * 3] = nx / len;
    faceNormals[t * 3 + 1] = ny / len;
    faceNormals[t * 3 + 2] = nz / len;
  }

  const parent = new Int32Array(faceCount);
  for (let t = 0; t < faceCount; t += 1) parent[t] = t;
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

  // Welded vertex ids stay below 2^23, so these keys are exact integers.
  const cosLimit = Math.cos((Math.max(0, Math.min(180, seamAngleDeg)) * Math.PI) / 180);
  const owner = new Map();
  const seamPairs = [];
  const seamFaces = [];
  let seamEdges = 0;
  for (let t = 0; t < faceCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = faces[t * 3 + k];
      const b = faces[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? a * 8388608 + b : b * 8388608 + a;
      const prev = owner.get(key);
      if (prev === undefined) {
        owner.set(key, t);
        continue;
      }
      const dot =
        faceNormals[t * 3] * faceNormals[prev * 3] +
        faceNormals[t * 3 + 1] * faceNormals[prev * 3 + 1] +
        faceNormals[t * 3 + 2] * faceNormals[prev * 3 + 2];
      if (dot >= cosLimit) {
        const ra = find(prev);
        const rb = find(t);
        if (ra !== rb) parent[ra] = rb;
      } else {
        seamEdges += 1;
        seamPairs.push(a, b);
        seamFaces.push(prev, t);
      }
    }
  }

  // Merge the specks into the neighbour they share the most seam with, so a click always
  // lands on a panel rather than on a sliver of mesh noise.
  const minFaces = minPartFaces === null ? defaultMinPartFaces(faceCount) : minPartFaces;
  let mergedSpecks = 0;
  if (mergeRounds > 0) {
    const size = new Map();
    for (let t = 0; t < faceCount; t += 1) {
      const r = find(t);
      size.set(r, (size.get(r) || 0) + 1);
    }
    for (let round = 0; round < mergeRounds; round += 1) {
      // longest shared seam between an undersized part and each of its neighbours
      const shared = new Map();
      const bump = (key, n) => shared.set(key, (shared.get(key) || 0) + n);
      for (let i = 0; i < seamFaces.length; i += 2) {
        const ra = find(seamFaces[i]);
        const rb = find(seamFaces[i + 1]);
        if (ra === rb) continue;
        const key = ra < rb ? ra * 8388608 + rb : rb * 8388608 + ra;
        bump(key, 1);
      }
      let mergedThisRound = 0;
      for (const [key, n] of shared) {
        const ra = Math.floor(key / 8388608);
        const rb = key - ra * 8388608;
        const sa = size.get(ra) || 0;
        const sb = size.get(rb) || 0;
        const small = sa <= sb ? ra : rb;
        const big = sa <= sb ? rb : ra;
        if ((size.get(small) || 0) >= minFaces) continue;
        if (find(small) !== small) continue; // already absorbed this round
        const rootSmall = find(small);
        const rootBig = find(big);
        if (rootSmall === rootBig || (size.get(rootBig) || 0) < (size.get(rootSmall) || 0)) continue;
        parent[rootSmall] = rootBig;
        size.set(rootBig, (size.get(rootBig) || 0) + (size.get(rootSmall) || 0));
        size.set(rootSmall, 0);
        mergedThisRound += 1;
        void n;
      }
      mergedSpecks += mergedThisRound;
      if (mergedThisRound === 0) break;
    }
  }

  // Compact the roots into dense part ids, biggest first so part 0 is the main shell.
  const rootToPart = new Map();
  const sizes = [];
  const facePart = new Int32Array(faceCount).fill(-1);
  for (let t = 0; t < faceCount; t += 1) {
    const r = find(t);
    let id = rootToPart.get(r);
    if (id === undefined) {
      id = sizes.length;
      rootToPart.set(r, id);
      sizes.push(0);
    }
    facePart[t] = id;
    sizes[id] += 1;
  }
  const order = sizes.map((n, id) => [n, id]).sort((x, y) => y[0] - x[0]);
  const remap = new Int32Array(sizes.length);
  order.forEach(([, id], i) => {
    remap[id] = i;
  });
  const sortedSizes = order.map(([n]) => n);
  for (let t = 0; t < faceCount; t += 1) facePart[t] = remap[facePart[t]];

  return {
    seamAngleDeg,
    facePart,
    partCount: sortedSizes.length,
    partSizes: sortedSizes,
    seamEdges,
    seamVerts: Int32Array.from(seamPairs),
    faceNormals,
    minPartFaces: minFaces,
    mergedSpecks,
  };
}

/**
 * Panels with surface within `radius` of `point`, closest first.
 *
 * This is how the Part panel offers the thing you were aiming at. A click can only select the
 * panel it lands on, and on the bundled model one panel covers 48% of the mesh while the
 * details are 0.1% of it — a strip a few pixels wide on screen — so a near-miss paints half the
 * model and the strip stays bare. The panel under the cursor is excluded (you already have it),
 * and the panels that come back include ones that merely pass close by, including panels hidden
 * behind the surface that was hit, which seam adjacency alone would never find.
 *
 * `distance` is from `point` to the nearest face of that panel, in model units.
 */
export function partsNearPoint(parts, topology, point, radius, { excludePart = -1, limit = 6 } = {}) {
  const { faces, faceCount, positions } = topology;
  const out = [];
  if (!(radius > 0) || !point) return out;
  const r2 = radius * radius;
  const best = new Map();
  for (let t = 0; t < faceCount; t += 1) {
    const part = parts.facePart[t];
    if (part === excludePart) continue;
    const a = faces[t * 3] * 3;
    const b = faces[t * 3 + 1] * 3;
    const c = faces[t * 3 + 2] * 3;
    const cx = (positions[a] + positions[b] + positions[c]) / 3 - point[0];
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 - point[1];
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 - point[2];
    const d2 = cx * cx + cy * cy + cz * cz;
    if (d2 > r2) continue;
    const seen = best.get(part);
    if (!seen || d2 < seen.d2) best.set(part, { d2, part });
  }
  for (const { d2, part } of best.values()) {
    out.push({
      part,
      faces: parts.partSizes[part],
      distance: Math.sqrt(d2),
      share: parts.partSizes[part] / faceCount,
    });
  }
  out.sort((x, y) => x.distance - y.distance || x.faces - y.faces);
  return out.slice(0, limit);
}

/** Soup-space vertex indices of every face in a part (one soup triangle per welded face). */
export function partSoupVertices(parts, partId, out = []) {
  out.length = 0;
  const { facePart } = parts;
  for (let t = 0; t < facePart.length; t += 1) {
    if (facePart[t] !== partId) continue;
    out.push(t * 3, t * 3 + 1, t * 3 + 2);
  }
  return out;
}
