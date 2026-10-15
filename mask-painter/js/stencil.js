/**
 * stencil.js — turn a selection into a printable paint stencil.
 *
 * The selected area becomes a WINDOW in a thin shell that conforms to the model, so the
 * mask can be held on the figure and only the selected area is exposed to the brush.
 *
 * Pipeline:
 *   1. weld the STL triangle soup into shared vertices; build adjacency + vertex normals
 *   2. geodesic (surface) distance field from the selected set — no tunnelling through air
 *   3. smooth it into a signed field: negative inside the selected area, positive outside
 *   4. clip the surface to the band [-overhang, coverRadius]: a smooth window edge and a
 *      smooth rim, independent of the mesh's triangle size
 *   5. offset the clipped surface outward on both sides and close it with walls along the
 *      boundary loops, giving one watertight solid
 *
 * Deliberately dependency-free (no three.js): the identical code runs in the browser and
 * under Node for verification (test/stencil.test.mjs).
 */

// ---------------------------------------------------------------- growables

class GrowF32 {
  constructor(cap = 1024) {
    this.a = new Float32Array(cap);
    this.n = 0;
  }

  _need(k) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Float32Array(c);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }

  push(v) {
    this._need(1);
    this.a[this.n++] = v;
  }

  push3(x, y, z) {
    this._need(3);
    const a = this.a;
    a[this.n++] = x;
    a[this.n++] = y;
    a[this.n++] = z;
  }

  toArray() {
    return this.a.slice(0, this.n);
  }
}

class GrowI32 {
  constructor(cap = 1024) {
    this.a = new Int32Array(cap);
    this.n = 0;
  }

  _need(k) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Int32Array(c);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }

  push(v) {
    this._need(1);
    this.a[this.n++] = v;
  }

  push3(x, y, z) {
    this._need(3);
    const a = this.a;
    a[this.n++] = x;
    a[this.n++] = y;
    a[this.n++] = z;
  }

  toArray() {
    return this.a.slice(0, this.n);
  }
}

// ---------------------------------------------------------------- min heap

class MinHeap {
  constructor(cap = 1024) {
    this.ids = new Int32Array(cap);
    this.keys = new Float64Array(cap);
    this.n = 0;
    this.topKey = Infinity;
  }

  push(id, key) {
    if (this.n === this.ids.length) {
      const bIds = new Int32Array(this.ids.length * 2);
      const bKeys = new Float64Array(this.keys.length * 2);
      bIds.set(this.ids);
      bKeys.set(this.keys);
      this.ids = bIds;
      this.keys = bKeys;
    }
    let i = this.n++;
    this.ids[i] = id;
    this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      const ti = this.ids[p];
      const tk = this.keys[p];
      this.ids[p] = this.ids[i];
      this.keys[p] = this.keys[i];
      this.ids[i] = ti;
      this.keys[i] = tk;
      i = p;
    }
  }

  pop() {
    const id = this.ids[0];
    this.topKey = this.keys[0];
    this.n -= 1;
    if (this.n > 0) {
      this.ids[0] = this.ids[this.n];
      this.keys[0] = this.keys[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.keys[l] < this.keys[m]) m = l;
        if (r < this.n && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        const ti = this.ids[m];
        const tk = this.keys[m];
        this.ids[m] = this.ids[i];
        this.keys[m] = this.keys[i];
        this.ids[i] = ti;
        this.keys[i] = tk;
        i = m;
      }
    }
    return id;
  }
}

// ---------------------------------------------------------------- helpers

const QUANT = 1e-4;

const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v) => Math.round(v * 100) / 100;

/** Hash a large integer key (used for exact numeric edge tables). */
function hashKey(key) {
  const hi = Math.floor(key / 4294967296) | 0;
  const lo = (key - Math.floor(key / 4294967296) * 4294967296) | 0;
  return (Math.imul(hi, 0x27d4eb2d) ^ Math.imul(lo, 0x165667b1)) | 0;
}

// ---------------------------------------------------------------- parameters

export const DEFAULT_STENCIL_PARAMS = {
  coverRadius: 15, // how far the mask material reaches from the painted area (model units)
  wall: 1.2, // sheet thickness once the edge has thickened up
  edgeLip: 0.4, // thickness at the window edge (thin lip so paint cannot creep under)
  edgeFade: 3, // distance over which the edge thickens to `wall`
  rim: 2.6, // thickness at the outer rim (a stiff edge to grip)
  rimFade: 5, // distance over which the rim thickens
  standoff: 0.1, // gap between the model surface and the mask's inner face
  overhang: 0.35, // mask material overlapping the painted boundary (anti-bleed lip)
  smoothPasses: 3, // smoothing passes outside the window (rounds the rim)
  smoothInsidePasses: 8, // passes inside it (rounds the window edge itself)
  smoothStrength: 0.5,
  growIfSplit: true, // widen the cover radius until the mask is one piece
  maxGrowSteps: 6,
  growFactor: 1.25,
  maxCoverRadius: null, // defaults to 45% of the model diagonal
};

/** Sensible starting numbers scaled to the model's own size. */
export function stencilDefaultsForDiagonal(diagonal) {
  const d = Math.max(Number(diagonal) || 100, 1);
  return {
    ...DEFAULT_STENCIL_PARAMS,
    coverRadius: round2(d * 0.115),
    wall: round2(d * 0.0092),
    edgeLip: round2(Math.max(d * 0.003, 0.05)),
    edgeFade: round2(d * 0.023),
    rim: round2(d * 0.02),
    rimFade: round2(d * 0.038),
    // The gap the mask leaves for sliding onto the figure. 0.15% of the diagonal is ~0.2 on a
    // 10 cm figure, which is about the smallest gap an FDM print reproduces reliably.
    standoff: round2(Math.max(d * 0.0015, 0.05)),
    overhang: round2(d * 0.0027),
    maxCoverRadius: round2(d * 0.45),
  };
}

// ---------------------------------------------------------------- topology

/**
 * Welds the triangle soup into a shared-vertex mesh and derives everything the stencil
 * builder needs. Expensive (a second or two on a million-vertex model), so callers cache
 * the result per loaded model.
 */
export function buildTopology(positions, vertexCount, { onProgress = null } = {}) {
  const faceCount = Math.floor(vertexCount / 3);
  const t0 = Date.now();

  // --- weld coincident vertices: an STL repeats every vertex once per triangle
  const tableSize = nextPow2(Math.max(16, vertexCount * 2));
  const hmask = tableSize - 1;
  const table = new Int32Array(tableSize).fill(-1);
  const qx = new Int32Array(vertexCount);
  const qy = new Int32Array(vertexCount);
  const qz = new Int32Array(vertexCount);
  const wpos = new Float32Array(vertexCount * 3);
  const weldOf = new Int32Array(vertexCount);
  let wCount = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const ix = Math.round(x / QUANT);
    const iy = Math.round(y / QUANT);
    const iz = Math.round(z / QUANT);
    let h =
      (Math.imul(ix, 0x1f1f1f1f) ^ Math.imul(iy, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1)) & hmask;
    let w = -1;
    for (;;) {
      const cand = table[h];
      if (cand < 0) break;
      if (qx[cand] === ix && qy[cand] === iy && qz[cand] === iz) {
        w = cand;
        break;
      }
      h = (h + 1) & hmask;
    }
    if (w < 0) {
      w = wCount;
      wCount += 1;
      table[h] = w;
      qx[w] = ix;
      qy[w] = iy;
      qz[w] = iz;
      wpos[w * 3] = x;
      wpos[w * 3 + 1] = y;
      wpos[w * 3 + 2] = z;
    }
    weldOf[i] = w;
  }
  const weldMs = Date.now() - t0;
  if (onProgress) onProgress(0.35, `welded ${wCount.toLocaleString('en-US')} vertices`);

  // --- faces, area-weighted normals, model orientation, size
  const faces = new Int32Array(faceCount * 3);
  const nrm = new Float32Array(wCount * 3);
  let degenerateFaces = 0;
  let surfaceArea = 0;
  let edgeSum = 0;
  let volume = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let t = 0; t < faceCount; t += 1) {
    const a = weldOf[t * 3];
    const b = weldOf[t * 3 + 1];
    const c = weldOf[t * 3 + 2];
    faces[t * 3] = a;
    faces[t * 3 + 1] = b;
    faces[t * 3 + 2] = c;
    if (a === b || b === c || a === c) {
      degenerateFaces += 1;
      continue;
    }
    const ax = wpos[a * 3];
    const ay = wpos[a * 3 + 1];
    const az = wpos[a * 3 + 2];
    const bx = wpos[b * 3];
    const by = wpos[b * 3 + 1];
    const bz = wpos[b * 3 + 2];
    const cx = wpos[c * 3];
    const cy = wpos[c * 3 + 1];
    const cz = wpos[c * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    nrm[a * 3] += nx;
    nrm[a * 3 + 1] += ny;
    nrm[a * 3 + 2] += nz;
    nrm[b * 3] += nx;
    nrm[b * 3 + 1] += ny;
    nrm[b * 3 + 2] += nz;
    nrm[c * 3] += nx;
    nrm[c * 3 + 1] += ny;
    nrm[c * 3 + 2] += nz;
    surfaceArea += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    edgeSum += Math.hypot(ux, uy, uz) + Math.hypot(bx - cx, by - cy, bz - cz) + Math.hypot(cx - ax, cy - ay, cz - az);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    if (ax < minX) minX = ax;
    if (ay < minY) minY = ay;
    if (az < minZ) minZ = az;
    if (bx < minX) minX = bx;
    if (by < minY) minY = by;
    if (bz < minZ) minZ = bz;
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cz < minZ) minZ = cz;
    if (ax > maxX) maxX = ax;
    if (ay > maxY) maxY = ay;
    if (az > maxZ) maxZ = az;
    if (bx > maxX) maxX = bx;
    if (by > maxY) maxY = by;
    if (bz > maxZ) maxZ = bz;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
    if (cz > maxZ) maxZ = cz;
  }

  // Normals must point outward, or the shell would grow into the model.
  const orientSign = volume >= 0 ? 1 : -1;
  for (let v = 0; v < wCount; v += 1) {
    const x = nrm[v * 3];
    const y = nrm[v * 3 + 1];
    const z = nrm[v * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-12) {
      nrm[v * 3] = (x / len) * orientSign;
      nrm[v * 3 + 1] = (y / len) * orientSign;
      nrm[v * 3 + 2] = (z / len) * orientSign;
    }
  }

  // --- vertex adjacency (CSR). Every edge is seen by both of its triangles, so each
  // vertex's list is deduped (otherwise every neighbour appears twice and degrees double).
  const rawStart = new Int32Array(wCount + 1);
  for (let t = 0; t < faceCount; t += 1) {
    const a = faces[t * 3];
    const b = faces[t * 3 + 1];
    const c = faces[t * 3 + 2];
    if (a !== b) {
      rawStart[a + 1] += 1;
      rawStart[b + 1] += 1;
    }
    if (b !== c) {
      rawStart[b + 1] += 1;
      rawStart[c + 1] += 1;
    }
    if (c !== a) {
      rawStart[c + 1] += 1;
      rawStart[a + 1] += 1;
    }
  }
  let acc = 0;
  for (let v = 0; v <= wCount; v += 1) {
    const d = rawStart[v];
    rawStart[v] = acc;
    acc += d;
  }
  const rawNeighbors = new Int32Array(acc);
  const cursor = rawStart.slice(0, wCount);
  const addUnique = (p0, q0) => {
    if (p0 === q0) return;
    const start = rawStart[p0];
    const end = cursor[p0];
    for (let i = start; i < end; i += 1) if (rawNeighbors[i] === q0) return;
    rawNeighbors[cursor[p0]] = q0;
    cursor[p0] += 1;
  };
  for (let t = 0; t < faceCount; t += 1) {
    const a = faces[t * 3];
    const b = faces[t * 3 + 1];
    const c = faces[t * 3 + 2];
    addUnique(a, b);
    addUnique(b, a);
    addUnique(b, c);
    addUnique(c, b);
    addUnique(c, a);
    addUnique(a, c);
  }
  const neighborStart = new Int32Array(wCount + 1);
  for (let v = 0; v < wCount; v += 1) neighborStart[v + 1] = neighborStart[v] + (cursor[v] - rawStart[v]);
  const neighbors = new Int32Array(neighborStart[wCount]);
  for (let v = 0; v < wCount; v += 1) {
    neighbors.set(rawNeighbors.subarray(rawStart[v], cursor[v]), neighborStart[v]);
  }

  // How well the averaged vertex normal agrees with each incident face. On a smooth
  // surface this is ~1; in a tight concave crease it goes negative, which is exactly
  // where offsetting along the averaged normal would push material into the model.
  const normalSafety = new Float32Array(wCount).fill(1);
  for (let t = 0; t < faceCount; t += 1) {
    const a = faces[t * 3];
    const b = faces[t * 3 + 1];
    const c = faces[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const ax = wpos[a * 3];
    const ay = wpos[a * 3 + 1];
    const az = wpos[a * 3 + 2];
    const ux = wpos[b * 3] - ax;
    const uy = wpos[b * 3 + 1] - ay;
    const uz = wpos[b * 3 + 2] - az;
    const vx = wpos[c * 3] - ax;
    const vy = wpos[c * 3 + 1] - ay;
    const vz = wpos[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const v of [a, b, c]) {
      const d = nrm[v * 3] * nx + nrm[v * 3 + 1] * ny + nrm[v * 3 + 2] * nz;
      if (d < normalSafety[v]) normalSafety[v] = d;
    }
  }
  for (let v = 0; v < wCount; v += 1) normalSafety[v] = clamp01(normalSafety[v]);
  // A vertex next to a tight crease still offsets into the neighbouring face's material,
  // so the clamp is spread over one ring.
  let spread = new Float32Array(wCount);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let v = 0; v < wCount; v += 1) {
      let m = normalSafety[v];
      for (let k = neighborStart[v]; k < neighborStart[v + 1]; k += 1) {
        const s2 = normalSafety[neighbors[k]];
        if (s2 < m) m = s2;
      }
      spread[v] = m;
    }
    normalSafety.set(spread);
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return {
    wCount,
    weldOf,
    normalSafety,
    positions: wpos.subarray(0, wCount * 3),
    normals: nrm.subarray(0, wCount * 3),
    faces,
    faceCount,
    neighborStart,
    neighbors,
    meanEdgeLength: faceCount ? edgeSum / (faceCount * 3) : 1,
    surfaceArea,
    diagonal,
    bbox: [minX, minY, minZ, maxX, maxY, maxZ],
    orientation: orientSign > 0 ? 'outward' : 'inward (corrected)',
    degenerateFaces,
    timing: { weldMs },
  };
}

// ---------------------------------------------------------------- distance fields

/** Multi-source Dijkstra over the mesh graph. Edge weight is the edge's length. */
export function geodesicField(topo, seeds, { maxDist = Infinity, allow = null } = {}) {
  const { wCount, positions, neighborStart, neighbors } = topo;
  const dist = new Float64Array(wCount).fill(Infinity);
  const heap = new MinHeap(Math.max(256, seeds.length * 4));
  for (const s of seeds) {
    if (dist[s] === 0) continue;
    dist[s] = 0;
    heap.push(s, 0);
  }
  while (heap.n > 0) {
    const u = heap.pop();
    const du = heap.topKey;
    if (du > maxDist) break;
    if (du > dist[u]) continue; // stale heap entry
    const ux = positions[u * 3];
    const uy = positions[u * 3 + 1];
    const uz = positions[u * 3 + 2];
    const start = neighborStart[u];
    const end = neighborStart[u + 1];
    for (let k = start; k < end; k += 1) {
      const v = neighbors[k];
      if (allow !== null && allow[v] === 0) continue;
      const dx = positions[v * 3] - ux;
      const dy = positions[v * 3 + 1] - uy;
      const dz = positions[v * 3 + 2] - uz;
      const nd = du + Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (nd < dist[v] && nd <= maxDist) {
        dist[v] = nd;
        heap.push(v, nd);
      }
    }
  }
  return dist;
}

/** Laplacian smoothing inside one side of the window edge: rounds the faceted
 * level sets of a geodesic field without pulling the two sides together. */
function smoothField(topo, field, mask, passes, strength) {
  if (!(passes > 0) || !(strength > 0)) return;
  const { wCount, neighborStart, neighbors } = topo;
  let src = field;
  let dst = new Float32Array(wCount);
  for (let it = 0; it < passes; it += 1) {
    dst.set(src);
    for (let v = 0; v < wCount; v += 1) {
      if (mask && mask[v] === 0) continue;
      const sv = src[v];
      if (!Number.isFinite(sv)) continue;
      const start = neighborStart[v];
      const end = neighborStart[v + 1];
      let sum = 0;
      let cnt = 0;
      for (let k = start; k < end; k += 1) {
        // Never average across the window edge: mixing the two sides would shrink the
        // painted region's depth field and close small windows entirely.
        if (mask && mask[neighbors[k]] === 0) continue;
        const s = src[neighbors[k]];
        if (Number.isFinite(s)) {
          sum += s;
          cnt += 1;
        }
      }
      if (!cnt) continue;
      dst[v] = sv + strength * (sum / cnt - sv);
    }
    if (src === field) {
      src = dst;
      dst = new Float32Array(wCount);
    } else {
      const tmp = src;
      src = dst;
      dst = tmp;
    }
  }
  field.set(src);
}

// ---------------------------------------------------------------- clipping + solid

/**
 * Cuts the surface to the band [lo, hi] and closes it into a solid.
 *
 * Every polygon vertex is either an original mesh vertex or a point on a mesh edge at one
 * of the two levels; cut points are cached per (edge, level) so the two triangles sharing
 * an edge always produce the identical point — that is what makes the result watertight.
 */
/** Squared distance from a point to a triangle, plus the closest point. Ericson, RTCD §5.1.5. */
function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
    return apx * apx + apy * apy + apz * apz;
  }
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx;
    out[1] = by;
    out[2] = bz;
    return bpx * bpx + bpy * bpy + bpz * bpz;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    return cpx * cpx + cpy * cpy + cpz * cpz;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    out[0] = ax + abx * t;
    out[1] = ay + aby * t;
    out[2] = az + abz * t;
    const dx = px - out[0];
    const dy = py - out[1];
    const dz = pz - out[2];
    return dx * dx + dy * dy + dz * dz;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    out[0] = ax + acx * t;
    out[1] = ay + acy * t;
    out[2] = az + acz * t;
    const dx = px - out[0];
    const dy = py - out[1];
    const dz = pz - out[2];
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + (cx - bx) * t;
    out[1] = by + (cy - by) * t;
    out[2] = bz + (cz - bz) * t;
    const dx = px - out[0];
    const dy = py - out[1];
    const dz = pz - out[2];
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = va + vb + vc || 1e-20;
  const v = vb / denom;
  const w = vc / denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
  const dx = px - out[0];
  const dy = py - out[1];
  const dz = pz - out[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * True clearance between the mask's inner face and the surface it was built from.
 *
 * The nominal standoff is what the surface was offset by, but that is not the same thing as
 * the gap a printer will produce: offsetting along averaged vertex normals closes the gap in
 * concave regions, and the offset is deliberately clamped back toward zero at creases sharper
 * than the average normal can follow, so the mask touches the model there instead of cutting
 * into it. This measures the real distance from every inner-face vertex to the nearest
 * surface triangle, which is what decides whether the printed part slides on.
 */
function measureClearance(sPos, sTris, surfTris, positionsOut, meanEdgeLength, requested) {
  const surfCount = sPos.n / 3;
  if (surfTris === 0 || surfCount === 0) return null;
  // A cell a couple of edges wide keeps the ring-expansion search small: it has to reach
  // only as far as the offset height (a fraction of the requested clearance) before it can
  // stop, and the stop rule guarantees nothing closer was skipped.
  const cell = Math.max(meanEdgeLength * 2, requested * 2, 0.25);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let t = 0; t < surfTris; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = sTris.a[t * 3 + k] * 3;
      const x = sPos.a[v];
      const y = sPos.a[v + 1];
      const z = sPos.a[v + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  const pad = cell * 2;
  minX -= pad;
  minY -= pad;
  minZ -= pad;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const total = nx * ny * nz;
  const counts = new Int32Array(total + 1);
  const cellOf = new Int32Array(surfTris);
  const cellIndex = (x, y, z) => {
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const cy = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / cell)));
    const cz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / cell)));
    return cx + nx * (cy + ny * cz);
  };
  for (let t = 0; t < surfTris; t += 1) {
    const a = sTris.a[t * 3] * 3;
    const b = sTris.a[t * 3 + 1] * 3;
    const c = sTris.a[t * 3 + 2] * 3;
    // Centroid bucket: the cell is several edges wide, so a triangle cannot be missed by a
    // query that scans a ring of cells around the vertex above it.
    const idx = cellIndex(
      (sPos.a[a] + sPos.a[b] + sPos.a[c]) / 3,
      (sPos.a[a + 1] + sPos.a[b + 1] + sPos.a[c + 1]) / 3,
      (sPos.a[a + 2] + sPos.a[b + 2] + sPos.a[c + 2]) / 3,
    );
    cellOf[t] = idx;
    counts[idx] += 1;
  }
  const starts = new Int32Array(total + 1);
  let acc = 0;
  for (let c = 0; c < total; c += 1) {
    starts[c] = acc;
    acc += counts[c];
  }
  starts[total] = acc;
  const cursor = starts.slice(0, total);
  const items = new Int32Array(surfTris);
  for (let t = 0; t < surfTris; t += 1) items[cursor[cellOf[t]]++] = t;

  const rings = 2;
  const closest = [0, 0, 0];
  let min = Infinity;
  let tight = 0;
  const samples = [];
  const stride = Math.max(1, Math.floor(surfCount / 20000));
  for (let k = 0; k < surfCount; k += 1) {
    const px = positionsOut[k * 6];
    const py = positionsOut[k * 6 + 1];
    const pz = positionsOut[k * 6 + 2];
    // Widen the search cell by cell and stop once the best hit is closer than the ring
    // already searched: the inner face sits a fraction of a cell above the surface, so this
    // usually settles in the first ring instead of scanning the full block.
    const gx = Math.floor((px - minX) / cell);
    const gy = Math.floor((py - minY) / cell);
    const gz = Math.floor((pz - minZ) / cell);
    let best = Infinity;
    for (let r = 0; r <= rings; r += 1) {
      const bx = Math.max(0, gx - r);
      const by = Math.max(0, gy - r);
      const bz = Math.max(0, gz - r);
      const ex = Math.min(nx - 1, gx + r);
      const ey = Math.min(ny - 1, gy + r);
      const ez = Math.min(nz - 1, gz + r);
      for (let cz = bz; cz <= ez; cz += 1) {
        for (let cy = by; cy <= ey; cy += 1) {
          for (let cx = bx; cx <= ex; cx += 1) {
            const idx = cx + nx * (cy + ny * cz);
            for (let i = starts[idx]; i < starts[idx + 1]; i += 1) {
              const t = items[i] * 3;
              const a = sTris.a[t] * 3;
              const b = sTris.a[t + 1] * 3;
              const c = sTris.a[t + 2] * 3;
              const d2 = pointTriDist2(
                px, py, pz,
                sPos.a[a], sPos.a[a + 1], sPos.a[a + 2],
                sPos.a[b], sPos.a[b + 1], sPos.a[b + 2],
                sPos.a[c], sPos.a[c + 1], sPos.a[c + 2],
                closest,
              );
              if (d2 < best) best = d2;
            }
          }
        }
      }
      if (best <= (r * cell) * (r * cell)) break;
    }
    const d = Math.sqrt(best);
    if (d < min) min = d;
    if (d < requested * 0.5) tight += 1;
    if (k % stride === 0 && Number.isFinite(d)) samples.push(d);
  }
  samples.sort((a, b) => a - b);
  const pct = (q) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] : 0);
  return {
    requested,
    min,
    median: pct(0.5),
    p05: pct(0.05),
    tight,
    measured: surfCount,
  };
}

/**
 * Clipping can leave a small island of surface that is enclosed by the window boundary but
 * separate from the main sheet (a "pocket"). It would print as a loose sliver of mask with
 * nothing holding it, so keep only the biggest connected sheet plus any island that is big
 * enough to be a deliberately separate part (the caller warns about those). Dropping an
 * island cannot open the rest: an island carries no boundary of its own to stitch to.
 * Faces are compacted in place; returns how many triangles were dropped.
 */
function dropTinyIslands(sTris, triCount, minTris) {
  if (triCount === 0) return { dropped: 0, sheets: 1 };
  const idx = sTris.a;
  const parent = new Int32Array(triCount);
  for (let t = 0; t < triCount; t += 1) parent[t] = t;
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
  for (let t = 0; t < triCount; t += 1) {
    const b = t * 3;
    for (let k = 0; k < 3; k += 1) {
      const a = idx[b + k];
      const c = idx[b + ((k + 1) % 3)];
      if (a === c) continue;
      const key = a < c ? a * 8388608 + c : c * 8388608 + a;
      const prev = owner.get(key);
      if (prev === undefined) owner.set(key, t);
      else {
        const ra = find(prev);
        const rb = find(t);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const size = new Map();
  for (let t = 0; t < triCount; t += 1) {
    const r = find(t);
    size.set(r, (size.get(r) || 0) + 1);
  }
  if (size.size === 1) return { dropped: 0, sheets: 1 };
  let mainRoot = -1;
  let mainSize = 0;
  for (const [r, n] of size) {
    if (n > mainSize) {
      mainSize = n;
      mainRoot = r;
    }
  }
  const drop = new Set();
  for (const [r, n] of size) if (r !== mainRoot && n <= minTris) drop.add(r);
  if (drop.size === 0) return { dropped: 0, sheets: size.size };
  let write = 0;
  let dropped = 0;
  for (let t = 0; t < triCount; t += 1) {
    if (drop.has(find(t))) {
      dropped += 1;
      continue;
    }
    const b = t * 3;
    idx[write * 3] = idx[b];
    idx[write * 3 + 1] = idx[b + 1];
    idx[write * 3 + 2] = idx[b + 2];
    write += 1;
  }
  sTris.n = write * 3;
  return { dropped, sheets: size.size - drop.size };
}

/**
 * A clipped surface can touch itself at a single vertex — two patches that share one point
 * and nothing else ("bowtie"). It is legitimate geometry, but it is not manifold: the wall
 * built around it would have to bridge sheets that are not really neighbours, leaving an
 * edge used by four triangles. The standard repair is to give every extra sheet its own
 * copy of the vertex, at the same position and normal, and re-index that sheet's corners.
 * Returns how many copies were made.
 */
function repairPinchVertices(sPos, sNrm, sT, sOff, sTris, sS, triCount, windowCuts) {
  const vCount = sS.n;
  const idx = sTris.a;
  const incStart = new Int32Array(vCount + 1);
  for (let t = 0; t < triCount; t += 1) {
    const b = t * 3;
    incStart[idx[b] + 1] += 1;
    incStart[idx[b + 1] + 1] += 1;
    incStart[idx[b + 2] + 1] += 1;
  }
  for (let v = 1; v <= vCount; v += 1) incStart[v] += incStart[v - 1];
  const inc = new Int32Array(incStart[vCount]);
  const cursor = incStart.slice(0, vCount);
  for (let t = 0; t < triCount; t += 1) {
    const b = t * 3;
    let c = idx[b];
    inc[cursor[c]] = t;
    cursor[c] += 1;
    c = idx[b + 1];
    inc[cursor[c]] = t;
    cursor[c] += 1;
    c = idx[b + 2];
    inc[cursor[c]] = t;
    cursor[c] += 1;
  }

  let splits = 0;
  let par = new Int32Array(64);
  const owner = new Map();
  const sheets = new Map();
  const find = (x) => {
    let r = x;
    while (par[r] !== r) r = par[r];
    while (par[x] !== r) {
      const n = par[x];
      par[x] = r;
      x = n;
    }
    return r;
  };

  for (let v = 0; v < vCount; v += 1) {
    const s0 = incStart[v];
    const n = incStart[v + 1] - s0;
    if (n <= 1) continue;
    if (par.length < n) par = new Int32Array(Math.max(n, par.length * 2));
    for (let i = 0; i < n; i += 1) par[i] = i;
    owner.clear();
    for (let i = 0; i < n; i += 1) {
      const b = inc[s0 + i] * 3;
      for (let k = 0; k < 3; k += 1) {
        const a = idx[b + k];
        const c = idx[b + ((k + 1) % 3)];
        if (a !== v && c !== v) continue;
        const other = a === v ? c : a;
        const prev = owner.get(other);
        if (prev === undefined) owner.set(other, i);
        else {
          const ra = find(prev);
          const rb = find(i);
          if (ra !== rb) par[ra] = rb;
        }
      }
    }
    const home = find(0);
    for (let i = 0; i < n; i += 1) {
      const r = find(i);
      if (r === home) continue;
      let id = sheets.get(r);
      if (id === undefined) {
        id = sS.n;
        const vp = v * 3;
        const x = sPos.a[vp];
        const y = sPos.a[vp + 1];
        const z = sPos.a[vp + 2];
        const nx = sNrm.a[vp];
        const ny = sNrm.a[vp + 1];
        const nz = sNrm.a[vp + 2];
        const t = sT.a[v];
        const off = sOff.a[v];
        const field0 = sS.a[v];
        sPos.push3(x, y, z);
        sNrm.push3(nx, ny, nz);
        sS.push(field0);
        sT.push(t);
        sOff.push(off);
        if (windowCuts.has(v)) windowCuts.add(id);
        sheets.set(r, id);
        splits += 1;
      }
      const b = inc[s0 + i] * 3;
      for (let k = 0; k < 3; k += 1) if (idx[b + k] === v) idx[b + k] = id;
    }
  }
  return splits;
}

export function clipToSolid(topo, field, lo, hi, params, fieldBound) {
  const { wCount, faces, faceCount, positions, normals, meanEdgeLength } = topo;
  const snap = Math.max(meanEdgeLength * 0.02, 1e-7);
  const standoff = Math.max(0, params.standoff);
  const wallT = Math.max(0, params.wall);
  const edgeLip = Math.min(Math.max(0, params.edgeLip), wallT);
  const rimT = Math.max(wallT, params.rim);
  const band = Math.max(hi - lo, 1e-6);
  const edgeFade = Math.min(Math.max(0, params.edgeFade), band * 0.35);
  const rimFade = Math.min(Math.max(0, params.rimFade), band * 0.35);

  const thicknessAt = (s) => {
    let t = wallT;
    if (edgeFade > 0 && s < lo + edgeFade) {
      t = edgeLip + (wallT - edgeLip) * clamp01((s - lo) / edgeFade);
    }
    if (rimFade > 0 && s > hi - rimFade) {
      t = Math.max(t, wallT + (rimT - wallT) * clamp01((s - (hi - rimFade)) / rimFade));
    }
    return t;
  };

  const safety = topo.normalSafety || null;
  const sPos = new GrowF32(8192);
  const sNrm = new GrowF32(8192);
  const sS = new GrowF32(4096);
  const sT = new GrowF32(4096);
  const sOff = new GrowF32(4096); // actual standoff per surface vertex
  const meshSurf = new Int32Array(wCount).fill(-1);
  const cutCache = new Map();
  const windowCuts = new Set();
  const sval = (v) => {
    const f = field[v];
    return Number.isFinite(f) ? f : fieldBound + 1;
  };

  const addSurf = (x, y, z, nx, ny, nz, s, off) => {
    const id = sS.n;
    sPos.push3(x, y, z);
    sNrm.push3(nx, ny, nz);
    sS.push(s);
    sT.push(thicknessAt(s));
    sOff.push(off);
    return id;
  };

  const meshVertex = (w) => {
    let id = meshSurf[w];
    if (id < 0) {
      id = addSurf(
        positions[w * 3],
        positions[w * 3 + 1],
        positions[w * 3 + 2],
        normals[w * 3],
        normals[w * 3 + 1],
        normals[w * 3 + 2],
        sval(w),
        safety ? standoff * safety[w] : standoff,
      );
      meshSurf[w] = id;
    }
    return id;
  };

  // Surface vertex ids stay below 2^23 (mesh vertices + cut points), which keeps the
  // numeric edge keys below exact-integer range.
  const smallIds = wCount < 4194304;
  // Cut points that land almost exactly on an edge endpoint reuse that vertex: otherwise
  // two distinct output vertices share a position, which a slicer welds into a degenerate
  // triangle and a broken shell.
  const posSnap = Math.max(meanEdgeLength * 0.01, QUANT * 2);
  const cutVertex = (a, b, levelIdx) => {
    const mn = a < b ? a : b;
    const mx = a < b ? b : a;
    const key = smallIds ? (mn * 4194304 + mx) * 2 + levelIdx : `${mn}:${mx}:${levelIdx}`;
    const cached = cutCache.get(key);
    if (cached !== undefined) return cached;
    const lvl = levelIdx === 0 ? lo : hi;
    const sa = sval(mn);
    const sb = sval(mx);
    const denom = sb - sa;
    const t = Math.abs(denom) > 1e-12 ? (lvl - sa) / denom : 0;
    const x = positions[mn * 3] + (positions[mx * 3] - positions[mn * 3]) * t;
    const y = positions[mn * 3 + 1] + (positions[mx * 3 + 1] - positions[mn * 3 + 1]) * t;
    const z = positions[mn * 3 + 2] + (positions[mx * 3 + 2] - positions[mn * 3 + 2]) * t;
    let nx = normals[mn * 3] + (normals[mx * 3] - normals[mn * 3]) * t;
    let ny = normals[mn * 3 + 1] + (normals[mx * 3 + 1] - normals[mn * 3 + 1]) * t;
    let nz = normals[mn * 3 + 2] + (normals[mx * 3 + 2] - normals[mn * 3 + 2]) * t;
    const d0 = Math.hypot(x - positions[mn * 3], y - positions[mn * 3 + 1], z - positions[mn * 3 + 2]);
    if (d0 <= posSnap) return meshVertex(mn);
    const d1 = Math.hypot(x - positions[mx * 3], y - positions[mx * 3 + 1], z - positions[mx * 3 + 2]);
    if (d1 <= posSnap) return meshVertex(mx);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const off = safety
      ? standoff * (safety[mn] + (safety[mx] - safety[mn]) * t)
      : standoff;
    const id = addSurf(x, y, z, nx, ny, nz, lvl, off);
    cutCache.set(key, id);
    if (levelIdx === 0) windowCuts.add(id);
    return id;
  };

  // --- clip every face to the band
  const sTris = new GrowI32(16384);
  const poly = new Int32Array(12);
  let keptFaces = 0;
  for (let t = 0; t < faceCount; t += 1) {
    const a = faces[t * 3];
    const b = faces[t * 3 + 1];
    const c = faces[t * 3 + 2];
    const sa = sval(a);
    const sb = sval(b);
    const sc = sval(c);
    const ca = sa < lo - snap ? 0 : sa > hi + snap ? 2 : 1;
    const cb = sb < lo - snap ? 0 : sb > hi + snap ? 2 : 1;
    const cc = sc < lo - snap ? 0 : sc > hi + snap ? 2 : 1;
    if (ca === cb && cb === cc && ca !== 1) continue; // wholly in the window or wholly outside

    let pn = 0;
    const ids = [a, b, c];
    const cls = [ca, cb, cc];
    for (let k = 0; k < 3; k += 1) {
      const p = ids[k];
      const q = ids[(k + 1) % 3];
      const cp = cls[k];
      const cq = cls[(k + 1) % 3];
      if (cp === 1) poly[pn++] = meshVertex(p);
      if (cp !== cq) {
        const sp = sval(p);
        const sq = sval(q);
        const denom = sq - sp;
        const cuts = [];
        // Use the classes, not raw comparisons, so a vertex sitting on a level is never
        // both kept and cut.
        if ((cp === 0) !== (cq === 0) && denom !== 0) cuts.push([0, (lo - sp) / denom]);
        if ((cp === 2) !== (cq === 2) && denom !== 0) cuts.push([1, (hi - sp) / denom]);
        cuts.sort((x, y) => x[1] - y[1]);
        for (const cut of cuts) poly[pn++] = cutVertex(p, q, cut[0]);
      }
    }
    // A cut point snapped back onto a vertex already in the polygon would create a
    // degenerate triangle, so repeats are dropped (a simple polygon has distinct corners).
    let unique = 0;
    for (let k = 0; k < pn; k += 1) {
      const id = poly[k];
      let dup = false;
      for (let j = 0; j < unique; j += 1) {
        if (poly[j] === id) {
          dup = true;
          break;
        }
      }
      if (!dup) poly[unique++] = id;
    }
    pn = unique;
    for (let k = 1; k + 1 < pn; k += 1) {
      sTris.push3(poly[0], poly[k], poly[k + 1]);
    }
    if (pn >= 3) keptFaces += 1;
  }

  const pinchSplits = repairPinchVertices(sPos, sNrm, sT, sOff, sTris, sS, sTris.n / 3, windowCuts);
  const islandDrop = dropTinyIslands(sTris, sTris.n / 3, Math.max(40, Math.round((sTris.n / 3) * 0.002)));

  const surfCount = sS.n;
  const surfTris = sTris.n / 3;
  if (surfTris === 0) {
    return {
      ok: false,
      reason: 'empty',
      warnings: ['The stencil came out empty — paint a larger area or reduce the window overhang.'],
    };
  }

  // --- boundary loops, surface sanity and connected pieces
  const emap = new Map();
  const triCount = surfTris;
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i += 1) parent[i] = i;
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
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  };
  let nonManifoldSurfaceEdges = 0;
  let orientationClashes = 0;
  const keyOf = (i, j) => (i < j ? i * 8388608 + j : j * 8388608 + i);
  const dirOf = (i, j) => (i < j ? 0 : 1);
  for (let t = 0; t < triCount; t += 1) {
    const i0 = sTris.a[t * 3];
    const i1 = sTris.a[t * 3 + 1];
    const i2 = sTris.a[t * 3 + 2];
    const e0 = i0 < i1 ? i0 : i1;
    const e1 = i0 < i1 ? i1 : i0;
    const f0 = i1 < i2 ? i1 : i2;
    const f1 = i1 < i2 ? i2 : i1;
    const g0 = i2 < i0 ? i2 : i0;
    const g1 = i2 < i0 ? i0 : i2;
    for (let e = 0; e < 3; e += 1) {
      const a = e === 0 ? i0 : e === 1 ? i1 : i2;
      const b = e === 0 ? i1 : e === 1 ? i2 : i0;
      if (a === b) continue;
      const key = e === 0 ? e0 * 8388608 + e1 : e === 1 ? f0 * 8388608 + f1 : g0 * 8388608 + g1;
      const prev = emap.get(key);
      if (prev === undefined) {
        emap.set(key, { n: 1, dir: dirOf(a, b), tri: t });
      } else {
        prev.n += 1;
        if (prev.n > 2) nonManifoldSurfaceEdges += 1;
        else if (prev.dir === dirOf(a, b)) orientationClashes += 1;
        union(prev.tri, t);
      }
    }
  }
  let components = 0;
  for (let i = 0; i < triCount; i += 1) if (find(i) === i) components += 1;

  // --- walls along every boundary loop
  const walls = new GrowI32(4096);
  const boundaryVertexDegree = new Map();
  const loopParent = new Map();
  const loopFind = (x) => {
    let r = x;
    while (loopParent.get(r) !== r) r = loopParent.get(r);
    while (loopParent.get(x) !== r) {
      const n = loopParent.get(x);
      loopParent.set(x, r);
      x = n;
    }
    return r;
  };
  const loopUnion = (x, y) => {
    if (!loopParent.has(x)) loopParent.set(x, x);
    if (!loopParent.has(y)) loopParent.set(y, y);
    const rx = loopFind(x);
    const ry = loopFind(y);
    if (rx !== ry) loopParent.set(rx, ry);
  };
  let boundaryEdges = 0;
  for (let t = 0; t < triCount; t += 1) {
    const i0 = sTris.a[t * 3];
    const i1 = sTris.a[t * 3 + 1];
    const i2 = sTris.a[t * 3 + 2];
    for (let e = 0; e < 3; e += 1) {
      const a = e === 0 ? i0 : e === 1 ? i1 : i2;
      const b = e === 0 ? i1 : e === 1 ? i2 : i0;
      if (a === b) continue;
      const key = keyOf(a, b);
      const rec = emap.get(key);
      if (!rec || rec.n !== 1) continue;
      boundaryEdges += 1;
      walls.push3(2 * a, 2 * b, 2 * b + 1);
      walls.push3(2 * a, 2 * b + 1, 2 * a + 1);
      boundaryVertexDegree.set(a, (boundaryVertexDegree.get(a) || 0) + 1);
      boundaryVertexDegree.set(b, (boundaryVertexDegree.get(b) || 0) + 1);
      loopUnion(a, b);
    }
  }
  let danglingBoundaryVertices = 0;
  const loopRoots = new Set();
  const windowLoopRoots = new Set();
  for (const [v, deg] of boundaryVertexDegree) {
    if (deg !== 2) danglingBoundaryVertices += 1;
    const r = loopFind(v);
    loopRoots.add(r);
    if (windowCuts.has(v)) windowLoopRoots.add(r);
  }

  // --- assemble the solid: inner face, outer face, walls along the boundary loops
  const positionsOut = new Float32Array(surfCount * 6);
  let thicknessMin = Infinity;
  let thicknessMax = 0;
  let standoffMin = Infinity;
  for (let i = 0; i < surfCount; i += 1) {
    const px = sPos.a[i * 3];
    const py = sPos.a[i * 3 + 1];
    const pz = sPos.a[i * 3 + 2];
    const nx = sNrm.a[i * 3];
    const ny = sNrm.a[i * 3 + 1];
    const nz = sNrm.a[i * 3 + 2];
    const t = sT.a[i];
    const g = sOff.a[i];
    if (t < thicknessMin) thicknessMin = t;
    if (t > thicknessMax) thicknessMax = t;
    if (g < standoffMin) standoffMin = g;
    positionsOut[i * 6] = px + nx * g;
    positionsOut[i * 6 + 1] = py + ny * g;
    positionsOut[i * 6 + 2] = pz + nz * g;
    positionsOut[i * 6 + 3] = px + nx * (g + t);
    positionsOut[i * 6 + 4] = py + ny * (g + t);
    positionsOut[i * 6 + 5] = pz + nz * (g + t);
  }

  const clearance = measureClearance(sPos, sTris, surfTris, positionsOut, meanEdgeLength, standoff);

  const indices = new GrowI32(surfTris * 12 + walls.n);
  for (let t = 0; t < surfTris; t += 1) {
    indices.push3(2 * sTris.a[t * 3] + 1, 2 * sTris.a[t * 3 + 1] + 1, 2 * sTris.a[t * 3 + 2] + 1);
  }
  for (let t = 0; t < surfTris; t += 1) {
    indices.push3(2 * sTris.a[t * 3 + 2], 2 * sTris.a[t * 3 + 1], 2 * sTris.a[t * 3]);
  }
  for (let i = 0; i < walls.n; i += 1) indices.push(walls.a[i]);

  const indicesOut = indices.toArray();
  let volume = signedVolume(positionsOut, indicesOut);
  let flipped = false;
  if (volume < 0) {
    for (let t = 0; t < indicesOut.length; t += 3) {
      const tmp = indicesOut[t + 1];
      indicesOut[t + 1] = indicesOut[t + 2];
      indicesOut[t + 2] = tmp;
    }
    volume = -volume;
    flipped = true;
  }

  // --- size stats
  let outerArea = 0;
  for (let t = 0; t < surfTris; t += 1) {
    const i0 = sTris.a[t * 3];
    const i1 = sTris.a[t * 3 + 1];
    const i2 = sTris.a[t * 3 + 2];
    const ax = sPos.a[i0 * 3];
    const ay = sPos.a[i0 * 3 + 1];
    const az = sPos.a[i0 * 3 + 2];
    const bx = sPos.a[i1 * 3];
    const by = sPos.a[i1 * 3 + 1];
    const bz = sPos.a[i1 * 3 + 2];
    const cx = sPos.a[i2 * 3];
    const cy = sPos.a[i2 * 3 + 1];
    const cz = sPos.a[i2 * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    outerArea += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }

  const ob = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positionsOut.length; i += 3) {
    const x = positionsOut[i];
    const y = positionsOut[i + 1];
    const z = positionsOut[i + 2];
    if (x < ob[0]) ob[0] = x;
    if (y < ob[1]) ob[1] = y;
    if (z < ob[2]) ob[2] = z;
    if (x > ob[3]) ob[3] = x;
    if (y > ob[4]) ob[4] = y;
    if (z > ob[5]) ob[5] = z;
  }

  return {
    ok: true,
    positions: positionsOut,
    indices: indicesOut,
    stats: {
      coverRadius: hi,
      windowOverhang: -lo,
      surfaceTriangles: surfTris,
      keptModelFaces: keptFaces,
      solidTriangles: indicesOut.length / 3,
      solidVertices: positionsOut.length / 3,
      wallTriangles: walls.n / 3,
      components,
      boundaryEdges,
      boundaryLoops: loopRoots.size,
      windowLoops: windowLoopRoots.size,
      windowOpen: windowCuts.size > 0,
      danglingBoundaryVertices,
      pinchSplits,
      droppedIslandTriangles: islandDrop.dropped,
      nonManifoldSurfaceEdges,
      orientationClashes,
      outerArea,
      volume,
      flippedWinding: flipped,
      clearance,
      thicknessMin: thicknessMin === Infinity ? 0 : thicknessMin,
      thicknessMax,
      standoff,
      standoffMin: standoffMin === Infinity ? standoff : standoffMin,
      size: [ob[3] - ob[0], ob[4] - ob[1], ob[5] - ob[2]],
      modelFaces: faceCount,
    },
    warnings: [],
  };
}

function signedVolume(positions, indices) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

// ---------------------------------------------------------------- public API

/**
 * Makes sure every painted island dips below the window cut level, so every one of them opens.
 *
 * The window is cut where the field crosses `lo` — the inlay, a bite taken *inside* the painted
 * area so the mask's lip overlaps bare model and paint cannot creep under the edge. Two things
 * stop that crossing from ever forming on a small selection, both measured on the bundled figure:
 *
 *   - a one-triangle pick welds to three vertices and none of them is inside anything, so the
 *     depth field is 0 across the whole island: there is no inside to bite into, and no vertex ever
 *     reaches the level;
 *   - the inside smoothing that shapes a good rim lifts a small island's values back towards its
 *     surroundings — a 52-face patch is 0.53 deep, deeper than the 0.35 inlay, and still came out
 *     of the build with no window at all.
 *
 * Either way the build reported success with `windowLoops: 0`: the shell had no opening and the
 * selected faces were simply absent from it, down to `windowOpen: false`. That is the report
 * "the individual faces do not process the stencil".
 *
 * So an island with no room inside it for that bite is given one: the whole island is set level
 * with the rest of the window, a little past the cut, so every edge leaving it crosses cleanly.
 * The cut then lands a fraction of an edge *outside* the island's own boundary, which is the honest
 * place for it — an island thinner than the inlay has no inside to inset into, so its window is the
 * island plus a small rim of bare model, and buildStencil says so in words (see the warning, and
 * `thinIslands` / `thinIslandRim` in the stats).
 *
 * How far past the cut is not a free choice: the marker has to clear the distance at which a cut
 * point is snapped back onto the island's own vertex (`posSnap` in clipToSolid, a hundredth of an
 * edge). Snapping there collapses the ring of triangles around the window and leaves a shell with
 * an edge used by four triangles, which is to say one a slicer refuses. A cut sits `t` along the
 * edge from the island vertex to an unpainted neighbour, with `t = target / (target + neighbour's
 * field)`; setting `target` from the *largest* neighbour field makes the shortest of those crossings
 * exactly a quarter of an edge, a factor of twenty-five clear of the snap.
 *
 * Idempotent: an island already reaching the level is left alone, so re-running it on the field of
 * a widened attempt changes nothing.
 *
 * @returns {{opened: number, rim: number}} how many islands needed opening, and how far past the
 *   selection the widest of their windows reaches, in model units.
 */
function openSmallIslands(topo, paintedW, field, lo) {
  const { wCount, neighborStart, neighbors, meanEdgeLength } = topo;
  const snap = Math.max(meanEdgeLength * 0.02, 1e-7);
  // An island dipping shallower than this has no clean crossing inside it to cut.
  const room = meanEdgeLength * 0.25;
  const seen = new Uint8Array(wCount);
  const stack = [];
  const island = [];
  let opened = 0;
  let rim = 0;
  for (let start = 0; start < wCount; start += 1) {
    if (!paintedW[start] || seen[start]) continue;
    stack.length = 0;
    island.length = 0;
    stack.push(start);
    seen[start] = 1;
    let lowest = Infinity;
    let neighbourMax = 0;
    while (stack.length) {
      const v = stack.pop();
      island.push(v);
      const f = field[v];
      if (Number.isFinite(f) && f < lowest) lowest = f;
      for (let k = neighborStart[v]; k < neighborStart[v + 1]; k += 1) {
        const n = neighbors[k];
        if (paintedW[n]) {
          if (!seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
          continue;
        }
        const nf = field[n];
        if (Number.isFinite(nf) && nf > neighbourMax) neighbourMax = nf;
      }
    }
    if (!(lowest > lo - room)) continue;
    opened += 1;
    const target = Math.max(snap * 5, (neighbourMax - lo) / 3);
    const level = lo - target;
    for (const v of island) field[v] = level;
    // The crossing runs from the island's vertex out to an unpainted one, so where that neighbour
    // already sits at the cut level the window reaches a whole edge past the selection.
    rim = Math.max(rim, meanEdgeLength);
  }
  return { opened, rim };
}

/**
 * Turns painted vertices into a printable single-piece stencil.
 *
 * @param {object} o
 * @param {object} o.topology from buildTopology()
 * @param {Uint8Array} o.painted 1 for painted vertices (per original or per welded vertex)
 * @param {object} [o.params] see DEFAULT_STENCIL_PARAMS
 * @param {function} [o.onProgress] (fraction, label)
 */
export function buildStencil({ topology, painted, params = {}, onProgress = null }) {
  const topo = topology;
  const { wCount, weldOf, neighborStart, neighbors, meanEdgeLength, diagonal } = topo;
  const report = (f, label) => {
    if (onProgress) onProgress(f, label);
  };

  // map the painted flags onto welded vertices
  const paintedW = new Uint8Array(wCount);
  if (painted.length === wCount) {
    for (let v = 0; v < wCount; v += 1) if (painted[v]) paintedW[v] = 1;
  } else {
    for (let i = 0; i < painted.length; i += 1) if (painted[i]) paintedW[weldOf[i]] = 1;
  }
  let paintedCount = 0;
  for (let v = 0; v < wCount; v += 1) if (paintedW[v]) paintedCount += 1;
  if (paintedCount === 0) {
    return {
      ok: false,
      reason: 'unpainted',
      warnings: ['Nothing is painted, so there is no window to cut. Paint the feature first.'],
    };
  }
  if (paintedCount === wCount) {
    return {
      ok: false,
      reason: 'all-painted',
      warnings: [
        'Every vertex is painted, so there is no unpainted area left to mask — the mask would cover the whole model with no window. Select one feature, or erase the paint outside the window area.',
      ],
    };
  }

  const p = { ...DEFAULT_STENCIL_PARAMS, ...params };
  const maxRadius = p.maxCoverRadius || diagonal * 0.45;
  const growSteps = p.growIfSplit ? Math.max(0, p.maxGrowSteps) : 0;
  const lo = -p.overhang;
  const margin = p.rimFade + p.edgeFade + meanEdgeLength * 4 + 1e-6;

  // seeds: the whole painted set (outer field) and its inner boundary (depth field)
  const seedsOut = [];
  const seedsIn = [];
  const paintedVerts = [];
  for (let v = 0; v < wCount; v += 1) {
    if (!paintedW[v]) continue;
    paintedVerts.push(v);
    seedsOut.push(v);
    let touchesUnpainted = false;
    for (let k = neighborStart[v]; k < neighborStart[v + 1]; k += 1) {
      if (!paintedW[neighbors[k]]) {
        touchesUnpainted = true;
        break;
      }
    }
    if (touchesUnpainted) seedsIn.push(v);
  }
  if (!seedsIn.length) seedsIn.push(...paintedVerts); // the entire surface is painted

  const unpaintedW = new Uint8Array(wCount);
  for (let v = 0; v < wCount; v += 1) unpaintedW[v] = paintedW[v] ? 0 : 1;
  report(0.4, `distance field from ${paintedVerts.length.toLocaleString('en-US')} painted vertices`);
  const warnings = [];
  let field = null;
  let fieldBound = 0;
  // Islands that had to be cut at their own edge because they are thinner than the inlay.
  let thinIslands = { opened: 0, rim: 0 };
  let radius = p.coverRadius;
  let result = null;
  let attempts = 0;
  let fieldMs = 0;

  for (let step = 0; step <= growSteps; step += 1) {
    const hi = Math.min(radius, maxRadius);
    const bound = hi + margin;
    // The field only needs to exist a little past the cut level, and is recomputed only
    // when the search has to widen (i.e. when the mask came out in several pieces).
    if (!field || bound > fieldBound) {
      const t0 = Date.now();
      const distOut = geodesicField(topo, seedsOut, { maxDist: bound });
      const distIn = geodesicField(topo, seedsIn, { maxDist: bound + p.overhang, allow: paintedW });
      field = new Float32Array(wCount).fill(NaN);
      for (let v = 0; v < wCount; v += 1) {
        if (paintedW[v]) {
          field[v] = Number.isFinite(distIn[v]) ? -distIn[v] : 0;
        } else if (Number.isFinite(distOut[v]) && distOut[v] <= bound) {
          field[v] = distOut[v];
        }
      }
      smoothField(topo, field, unpaintedW, p.smoothPasses, p.smoothStrength);
      smoothField(topo, field, paintedW, p.smoothInsidePasses, p.smoothStrength);
      // A selection is a set of faces the user pointed at, so no island of it may come out of the
      // build without a window: the smoothing above is allowed to shape the rim, not to erase one.
      thinIslands = openSmallIslands(topo, paintedW, field, lo);
      fieldBound = bound;
      fieldMs += Date.now() - t0;
    }

    report(0.75, `cutting the shell (cover radius ${hi.toFixed(1)}, pass ${step + 1})`);
    attempts += 1;
    const built = clipToSolid(topo, field, lo, hi, p, fieldBound);
    if (!built.ok) return { ...built, warnings: [...warnings, ...(built.warnings || [])] };
    result = built;
    if (built.stats.components <= 1 || step === growSteps || hi >= maxRadius) break;
    warnings.push(
      `The mask came out in ${built.stats.components} pieces at a cover radius of ${hi.toFixed(1)}, so it was widened.`,
    );
    radius = Math.min(radius * p.growFactor, maxRadius);
  }

  const s = result.stats;
  const w = [...warnings];
  if (!s.windowOpen) {
    w.push(
      'The window did not open: the painted area is smaller than the window overhang, so the mask covers it completely. Reduce the overhang or paint a bigger area.',
    );
  }
  if (thinIslands.opened > 0) {
    w.push(
      `${thinIslands.opened} selected island${thinIslands.opened === 1 ? ' is' : 's are'} thinner than the ` +
        `${p.overhang} window inlay, so ${thinIslands.opened === 1 ? 'its window was' : 'their windows were'} cut at ` +
        `${thinIslands.opened === 1 ? 'its own' : 'their own'} edge instead of inset inside: a rim of up to ` +
        `${thinIslands.rim.toFixed(2)} of bare model stays unpainted there. Set the window inlay to 0 for an exact cut.`,
    );
  }
  if (s.components > 1) {
    w.push(
      `The mask is still ${s.components} separate pieces: the painted areas are further apart than the cover radius can bridge. Raise the cover radius to make it one part.`,
    );
  }
  if (s.clearance && s.clearance.tight > 0 && s.clearance.min < p.standoff * 0.5) {
    const pct = ((s.clearance.tight / s.clearance.measured) * 100).toFixed(1);
    w.push(
      `The mask comes within ${s.clearance.min.toFixed(3)} of the model at ${s.clearance.tight} vertices ` +
        `(${pct}% of it, at the sharpest creases): there the surface bends too tightly for the ` +
        `${p.standoff} standoff to fit, so the inner face is pulled back to the surface instead of ` +
        `cutting into it. The rest of the mask keeps a median clearance of ${s.clearance.median.toFixed(3)}. ` +
        `A rigid print will rub at those spots; raise the standoff, keep the window away from sharp ` +
        `creases, or expect to sand those few spots.`,
    );
  }
  if (s.droppedIslandTriangles > 0) {
    w.push(
      `A small island of the shell (${s.droppedIslandTriangles} triangles) came out surrounded by the window with nothing joining it, so it was left out — it would have printed as a loose sliver.`,
    );
  }
  if (s.danglingBoundaryVertices > 0) {
    w.push(`${s.danglingBoundaryVertices} boundary vertices are not part of a clean loop; the print may carry a sliver.`);
  }
  if (s.nonManifoldSurfaceEdges > 0) {
    w.push(`${s.nonManifoldSurfaceEdges} surface edges are used by more than two triangles.`);
  }
  if (s.windowOverhang <= 0) {
    w.push('The window edge sits outside the painted boundary, so a rim of bare model will stay unpainted.');
  }

  return {
    ok: true,
    positions: result.positions,
    indices: result.indices,
    stats: {
      ...s,
      paintedVertices: paintedVerts.length,
      thinIslands: thinIslands.opened,
      thinIslandRim: thinIslands.rim,
      attempts,
      smoothingPasses: p.smoothPasses,
      fieldMs,
      params: p,
    },
    warnings: w,
  };
}

// ---------------------------------------------------------------- verification

/**
 * Rigorous check of an indexed solid: every undirected edge must be used exactly twice,
 * with opposite directions, and no triangle may be degenerate. This is the check that
 * proves "printable": a slicer needs a closed, consistently oriented surface.
 */
export function validateSolid({ positions, indices }, { maxTriangles = 3000000 } = {}) {
  const tri = indices.length / 3;
  if (tri > maxTriangles) {
    return { skipped: true, reason: `too many triangles to verify (${tri})` };
  }
  let maxId = 0;
  for (let i = 0; i < indices.length; i += 1) if (indices[i] > maxId) maxId = indices[i];
  const K = maxId + 1;
  const tableSize = nextPow2(Math.max(16, Math.ceil(tri * 3 * 1.6)));
  const hmask = tableSize - 1;
  const keys = new Float64Array(tableSize).fill(-1);
  const cnt = new Uint8Array(tableSize);
  const dir = new Uint8Array(tableSize);
  const triOf = new Int32Array(tableSize).fill(-1);
  // union-find over triangles, so shared edges join them into shells
  const parent = new Int32Array(tri);
  for (let i = 0; i < tri; i += 1) parent[i] = i;
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
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  };
  let degenerate = 0;
  for (let t = 0; t < tri; t += 1) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      degenerate += 1;
      continue;
    }
    for (let e = 0; e < 3; e += 1) {
      const a = e === 0 ? i0 : e === 1 ? i1 : i2;
      const b = e === 0 ? i1 : e === 1 ? i2 : i0;
      const mn = a < b ? a : b;
      const mx = a < b ? b : a;
      const key = mn * K + mx;
      let h = hashKey(key) & hmask;
      for (;;) {
        const k = keys[h];
        if (k === key) {
          cnt[h] += 1;
          dir[h] |= a < b ? 1 : 2;
          union(triOf[h], t);
          break;
        }
        if (k === -1) {
          keys[h] = key;
          cnt[h] = 1;
          dir[h] = a < b ? 1 : 2;
          triOf[h] = t;
          break;
        }
        h = (h + 1) & hmask;
      }
    }
  }

  let nonManifoldEdges = 0;
  let sameDirectionEdges = 0;
  const histogram = new Map();
  for (let h = 0; h <= hmask; h += 1) {
    if (keys[h] === -1) continue;
    const c = cnt[h];
    histogram.set(c, (histogram.get(c) || 0) + 1);
    if (c !== 2) nonManifoldEdges += 1;
    else if (dir[h] !== 3) sameDirectionEdges += 1;
  }
  let components = 0;
  for (let i = 0; i < tri; i += 1) if (find(i) === i) components += 1;

  const volume = signedVolume(positions, indices);
  return {
    triangles: tri,
    vertices: positions.length / 3,
    degenerate,
    nonManifoldEdges,
    sameDirectionEdges,
    edgeHistogram: Object.fromEntries([...histogram.entries()].sort((a, b) => a[0] - b[0])),
    watertight: nonManifoldEdges === 0 && sameDirectionEdges === 0 && degenerate === 0,
    volume,
    outward: volume > 0,
    components,
  };
}
