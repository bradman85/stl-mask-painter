// Helpers for the stencil verification harness: STL parsing, a triangle grid for exact
// point-to-surface distances, and simple painting primitives.
// No dependencies: runs on the raw model file.

export function parseBinarySTL(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buffer.byteLength < expected) throw new Error(`truncated STL: ${buffer.byteLength} < ${expected}`);
  const positions = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t += 1) {
    const off = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k += 1) positions[t * 9 + k] = view.getFloat32(off + k * 4, true);
  }
  return { positions, triCount };
}

/** Uniform grid over triangles; finds the exact nearest point on a surface. */
export class TriGrid {
  constructor(positions, cell = 2) {
    this.positions = positions;
    const triCount = positions.length / 9;
    let mnx = Infinity;
    let mny = Infinity;
    let mnz = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    let mxz = -Infinity;
    for (let t = 0; t < triCount; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        const x = positions[t * 9 + k * 3];
        const y = positions[t * 9 + k * 3 + 1];
        const z = positions[t * 9 + k * 3 + 2];
        if (x < mnx) mnx = x;
        if (y < mny) mny = y;
        if (z < mnz) mnz = z;
        if (x > mxx) mxx = x;
        if (y > mxy) mxy = y;
        if (z > mxz) mxz = z;
      }
    }
    this.min = [mnx - 1, mny - 1, mnz - 1];
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((mxx - mnx) / cell) + 3);
    this.ny = Math.max(1, Math.ceil((mxy - mny) / cell) + 3);
    this.nz = Math.max(1, Math.ceil((mxz - mnz) / cell) + 3);
    const total = this.nx * this.ny * this.nz;
    const cellOf = new Int32Array(triCount);
    const counts = new Int32Array(total + 1);
    for (let t = 0; t < triCount; t += 1) {
      const cx = Math.min(this.nx - 1, Math.max(0, Math.floor((positions[t * 9] - this.min[0]) / cell)));
      const cy = Math.min(this.ny - 1, Math.max(0, Math.floor((positions[t * 9 + 1] - this.min[1]) / cell)));
      const cz = Math.min(this.nz - 1, Math.max(0, Math.floor((positions[t * 9 + 2] - this.min[2]) / cell)));
      const idx = cx + this.nx * (cy + this.ny * cz);
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
    const items = new Int32Array(triCount);
    for (let t = 0; t < triCount; t += 1) items[cursor[cellOf[t]]++] = t;
    this.starts = starts;
    this.items = items;
    this.triCount = triCount;
  }

  /** Nearest triangle to (x,y,z) within `rings` cells. Returns {dist, closest, normal}. */
  nearest(x, y, z, rings = 2) {
    const { cell, nx, ny, nz } = this;
    const bx = Math.max(0, Math.floor((x - this.min[0]) / cell) - rings);
    const by = Math.max(0, Math.floor((y - this.min[1]) / cell) - rings);
    const bz = Math.max(0, Math.floor((z - this.min[2]) / cell) - rings);
    const ex = Math.min(nx - 1, Math.floor((x - this.min[0]) / cell) + rings);
    const ey = Math.min(ny - 1, Math.floor((y - this.min[1]) / cell) + rings);
    const ez = Math.min(nz - 1, Math.floor((z - this.min[2]) / cell) + rings);
    let best = Infinity;
    let bestTri = -1;
    let bcp = null;
    for (let cz = bz; cz <= ez; cz += 1) {
      for (let cy = by; cy <= ey; cy += 1) {
        for (let cx = bx; cx <= ex; cx += 1) {
          const idx = cx + nx * (cy + ny * cz);
          for (let k = this.starts[idx]; k < this.starts[idx + 1]; k += 1) {
            const t = this.items[k];
            const d = pointTriDistance2(x, y, z, t, this.positions, bcp || (bcp = [0, 0, 0]));
            if (d < best) {
              best = d;
              bestTri = t;
            }
          }
        }
      }
    }
    return { dist: Math.sqrt(best), tri: bestTri, closest: bcp ? bcp.slice() : null };
  }

  /** Signed distance: positive outside (uses the nearest triangle's own normal). */
  signed(x, y, z, rings = 2) {
    const hit = this.nearest(x, y, z, rings);
    if (hit.tri < 0) return { dist: Infinity, sign: 0, tri: -1 };
    const p = this.positions;
    const t = hit.tri * 9;
    const ax = p[t];
    const ay = p[t + 1];
    const az = p[t + 2];
    const bx = p[t + 3];
    const by = p[t + 4];
    const bz = p[t + 5];
    const cx = p[t + 6];
    const cy = p[t + 7];
    const cz = p[t + 8];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const c = hit.closest;
    const dot = (x - c[0]) * nx + (y - c[1]) * ny + (z - c[2]) * nz;
    return { dist: hit.dist, sign: dot >= 0 ? 1 : -1, tri: hit.tri, closest: c, normal: [nx, ny, nz] };
  }
}

/** Squared distance from a point to triangle `tri`, closest point written into `out`. */
export function pointTriDistance2(px, py, pz, tri, positions, out) {
  const t = tri * 9;
  const ax = positions[t];
  const ay = positions[t + 1];
  const az = positions[t + 2];
  const bx = positions[t + 3];
  const by = positions[t + 4];
  const bz = positions[t + 5];
  const cx = positions[t + 6];
  const cy = positions[t + 7];
  const cz = positions[t + 8];
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
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v;
    out[1] = ay + aby * v;
    out[2] = az + abz * v;
    const dx = px - out[0];
    const dy = py - out[1];
    const dz = pz - out[2];
    return dx * dx + dy * dy + dz * dz;
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
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w;
    out[1] = ay + acy * w;
    out[2] = az + acz * w;
    const dx = px - out[0];
    const dy = py - out[1];
    const dz = pz - out[2];
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + (cx - bx) * w;
    out[1] = by + (cy - by) * w;
    out[2] = bz + (cz - bz) * w;
    const dx = px - out[0];
    const dy = py - out[1];
    const dz = pz - out[2];
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
  const dx = px - out[0];
  const dy = py - out[1];
  const dz = pz - out[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Marks every original vertex inside any of the given spheres. */
export function paintSpheres(positions, spheres, { mirrorX = null } = {}) {
  const vertexCount = positions.length / 3;
  const painted = new Uint8Array(vertexCount);
  const all = [...spheres];
  if (mirrorX !== null) {
    for (const s of spheres) all.push([mirrorX * 2 - s[0], s[1], s[2], s[3]]);
  }
  let n = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    for (const [cx, cy, cz, r] of all) {
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      if (dx * dx + dy * dy + dz * dz <= r * r) {
        painted[i] = 1;
        n += 1;
        break;
      }
    }
  }
  return { painted, count: n };
}

export function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return String(n);
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Nearest welded vertex to a world point. */
export function nearestWelded(topo, x, y, z) {
  let best = -1;
  let bestD = Infinity;
  for (let v = 0; v < topo.wCount; v += 1) {
    const dx = topo.positions[v * 3] - x;
    const dy = topo.positions[v * 3 + 1] - y;
    const dz = topo.positions[v * 3 + 2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

/** Paints a geodesic disc: every welded vertex within `radius` of `seed` along the surface. */
export function geodesicDisc(topo, geodesicField, seed, radius) {
  const dist = geodesicField(topo, [seed], { maxDist: radius * 1.5 });
  const paintedW = new Uint8Array(topo.wCount);
  let count = 0;
  for (let v = 0; v < topo.wCount; v += 1) {
    if (dist[v] <= radius) {
      paintedW[v] = 1;
      count += 1;
    }
  }
  return { paintedW, count, maxDepth: radius };
}

export function mergePainted(...masks) {
  const out = new Uint8Array(masks[0].length);
  let n = 0;
  for (let i = 0; i < out.length; i += 1) {
    for (const m of masks) {
      if (m[i]) {
        out[i] = 1;
        n += 1;
        break;
      }
    }
  }
  return { paintedW: out, count: n };
}

/** Hop depth from the painted boundary into the painted set — how thick the feature is. */
export function paintedThickness(topo, paintedW) {
  const INF = -1;
  const hop = new Int32Array(topo.wCount).fill(INF);
  const queue = [];
  for (let v = 0; v < topo.wCount; v += 1) {
    if (!paintedW[v]) continue;
    let border = false;
    for (let k = topo.neighborStart[v]; k < topo.neighborStart[v + 1]; k += 1) {
      if (!paintedW[topo.neighbors[k]]) {
        border = true;
        break;
      }
    }
    if (border) {
      hop[v] = 0;
      queue.push(v);
    }
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const v = queue[qi];
    for (let k = topo.neighborStart[v]; k < topo.neighborStart[v + 1]; k += 1) {
      const n1 = topo.neighbors[k];
      if (!paintedW[n1] || hop[n1] !== INF) continue;
      hop[n1] = hop[v] + 1;
      queue.push(n1);
    }
  }
  let max = 0;
  let reached = 0;
  for (let v = 0; v < topo.wCount; v += 1) {
    if (!paintedW[v] || hop[v] === INF) continue;
    reached += 1;
    if (hop[v] > max) max = hop[v];
  }
  return { maxHop: max, reached, total: paintedW.reduce((a, b) => a + b, 0) };
}

/** Möller–Trumbore: does the ray from (x,y,z) along dir hit triangle `tri` ahead of it? */
function rayHitsTriangle(x, y, z, dir, tri, positions) {
  const t = tri * 9;
  const ax = positions[t];
  const ay = positions[t + 1];
  const az = positions[t + 2];
  const e1x = positions[t + 3] - ax;
  const e1y = positions[t + 4] - ay;
  const e1z = positions[t + 5] - az;
  const e2x = positions[t + 6] - ax;
  const e2y = positions[t + 7] - ay;
  const e2z = positions[t + 8] - az;
  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return false;
  const inv = 1 / det;
  const tx = x - ax;
  const ty = y - ay;
  const tz = z - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return dist > 1e-6;
}

/**
 * Is a point inside the solid? Counts the ray crossings.
 *
 * The ray deliberately runs along a direction that is not axis-aligned: this model is a
 * regular grid-like mesh, and a near-axis ray grazes mesh edges, which double-counts or
 * misses crossings (measured: ~2% wrong answers).
 */
export class InsideTester {
  constructor(grid) {
    this.grid = grid;
    this.seen = new Int32Array(Math.max(1, grid.triCount)).fill(-1);
    this.stamp = 0;
    // Three deliberately unrelated directions. A regular grid mesh can make one fixed
    // direction graze edges systematically, so the verdict is a majority vote.
    this.dirs = [
      [0.5773503, 0.5527708, 0.6009252],
      [0.2672612, 0.8017837, 0.5345225],
      [0.6804138, 0.2721655, 0.6804138],
    ];
  }

  /** How many of the three independent rays read the point as inside (0..3). */
  votes(x, y, z) {
    let n = 0;
    for (const d of this.dirs) if (this.castOnce(x, y, z, d)) n += 1;
    return n;
  }

  test(x, y, z) {
    return this.votes(x, y, z) >= 2;
  }

  castOnce(x, y, z, dir) {
    const grid = this.grid;
    const cell = grid.cell;
    const clamp = (v, n) => Math.min(n - 1, Math.max(0, v));
    let cx = clamp(Math.floor((x - grid.min[0]) / cell), grid.nx);
    let cy = clamp(Math.floor((y - grid.min[1]) / cell), grid.ny);
    let cz = clamp(Math.floor((z - grid.min[2]) / cell), grid.nz);
    const tMax = [
      (grid.min[0] + (cx + 1) * cell - x) / dir[0],
      (grid.min[1] + (cy + 1) * cell - y) / dir[1],
      (grid.min[2] + (cz + 1) * cell - z) / dir[2],
    ];
    const tDelta = [cell / dir[0], cell / dir[1], cell / dir[2]];
    const stamp = (this.stamp += 1);
    const seen = this.seen;
    let crossings = 0;
    for (let guard = 0; guard < 4096; guard += 1) {
      if (cx < 0 || cy < 0 || cz < 0 || cx >= grid.nx || cy >= grid.ny || cz >= grid.nz) break;
      // a 3x3x3 block: triangles are bucketed by one cell, and the block makes the walk
      // robust to triangles that straddle a cell boundary
      for (let ox = -1; ox <= 1; ox += 1) {
        const xx = cx + ox;
        if (xx < 0 || xx >= grid.nx) continue;
        for (let oy = -1; oy <= 1; oy += 1) {
          const yy = cy + oy;
          if (yy < 0 || yy >= grid.ny) continue;
          for (let oz = -1; oz <= 1; oz += 1) {
            const zz = cz + oz;
            if (zz < 0 || zz >= grid.nz) continue;
            const idx = xx + grid.nx * (yy + grid.ny * zz);
            for (let k = grid.starts[idx]; k < grid.starts[idx + 1]; k += 1) {
              const tri = grid.items[k];
              if (seen[tri] === stamp) continue;
              seen[tri] = stamp;
              if (rayHitsTriangle(x, y, z, dir, tri, grid.positions)) crossings += 1;
            }
          }
        }
      }
      const axis = tMax[0] <= tMax[1] && tMax[0] <= tMax[2] ? 0 : tMax[1] <= tMax[2] ? 1 : 2;
      if (axis === 0) cx += 1;
      else if (axis === 1) cy += 1;
      else cz += 1;
      tMax[axis] += tDelta[axis];
    }
    return crossings % 2 === 1;
  }
}

/** Hop depth of every painted vertex from the painted boundary. */
export function paintHops(topo, paintedW) {
  const INF = -1;
  const hop = new Int32Array(topo.wCount).fill(INF);
  const queue = [];
  for (let v = 0; v < topo.wCount; v += 1) {
    if (!paintedW[v]) continue;
    let border = false;
    for (let k = topo.neighborStart[v]; k < topo.neighborStart[v + 1]; k += 1) {
      if (!paintedW[topo.neighbors[k]]) {
        border = true;
        break;
      }
    }
    if (border) {
      hop[v] = 0;
      queue.push(v);
    }
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const v = queue[qi];
    for (let k = topo.neighborStart[v]; k < topo.neighborStart[v + 1]; k += 1) {
      const n1 = topo.neighbors[k];
      if (!paintedW[n1] || hop[n1] !== INF) continue;
      hop[n1] = hop[v] + 1;
      queue.push(n1);
    }
  }
  return hop;
}

/** Connected shells of a solid, split by shared edges. Each piece reports its triangles and
 *  the set of rounded vertex positions it uses (for "do these two shells touch?" checks). */
export function solidPieces(solid) {
  const { positions, indices } = solid;
  const tris = indices.length / 3;
  const parent = new Int32Array(tris);
  for (let i = 0; i < tris; i += 1) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const owner = new Map();
  for (let t = 0; t < tris; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t * 3 + k];
      const b = indices[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const prev = owner.get(key);
      if (prev === undefined) owner.set(key, t);
      else {
        const ra = find(prev);
        const rb = find(t);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const byRoot = new Map();
  for (let t = 0; t < tris; t += 1) {
    const r = find(t);
    let piece = byRoot.get(r);
    if (!piece) {
      piece = { tris: 0, verts: new Set() };
      byRoot.set(r, piece);
    }
    piece.tris += 1;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k];
      piece.verts.add(
        `${positions[v * 3].toFixed(3)},${positions[v * 3 + 1].toFixed(3)},${positions[v * 3 + 2].toFixed(3)}`,
      );
    }
  }
  return [...byRoot.values()];
}
