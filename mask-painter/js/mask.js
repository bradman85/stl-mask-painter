import * as THREE from 'three';
import { hexToRgb, MAX_FEATURE_ID, UNPAINTED_ID } from './features.js';

// Unpainted vertices keep the model's neutral tone (and alpha 0), so the overlay is
// invisible where nothing has been painted even on a renderer that ignores vertex alpha.
const UNPAINTED_RGB = [0.72, 0.74, 0.78];

/**
 * A paintable mask over a triangle mesh.
 *
 * There is no UV data in an STL, so the mask is stored per vertex:
 *   - `ids[i]`      feature id painted at vertex i (0 = unpainted)
 *   - `colors[i*4]` RGBA written straight into the overlay geometry's colour attribute
 *
 * Painting is a spatial query over a uniform vertex grid, which keeps a brush stamp
 * cheap even on a mesh with >1M vertices.
 */
export class MaskLayer {
  constructor(geometry, features, { maxHistory = 40 } = {}) {
    this.geometry = geometry;
    this.position = geometry.attributes.position;
    this.vertexCount = this.position.count;
    this.ids = new Int16Array(this.vertexCount);
    this.colors = new Float32Array(this.vertexCount * 4);
    this.hidden = new Set();
    this.backdrop = false;
    this.maxHistory = maxHistory;
    this.history = [];
    this.redoStack = [];
    this._stroke = null;
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;

    this._colorLUT = new Float32Array((MAX_FEATURE_ID + 1) * 3);
    this.setFeatures(features, { rebuild: true });
    this._buildGrid();
    this.vertexNormals = null;
    this._edgeLength = null;
    this.refreshColors();
  }

  // ---------------------------------------------------------------- features

  setFeatures(features, { rebuild = false } = {}) {
    this.features = features;
    const lut = this._colorLUT;
    lut.fill(0.5);
    const known = new Set();
    for (const f of features) {
      const { r, g, b } = hexToRgb(f.color);
      const o = f.id * 3;
      lut[o] = r;
      lut[o + 1] = g;
      lut[o + 2] = b;
      known.add(f.id);
    }
    if (!rebuild) {
      // A removed feature releases its vertices instead of leaving orphan colours.
      let touched = false;
      for (let i = 0; i < this.vertexCount; i += 1) {
        const id = this.ids[i];
        if (id !== UNPAINTED_ID && !known.has(id)) {
          this.ids[i] = UNPAINTED_ID;
          touched = true;
        }
      }
      if (touched) this.refreshColors();
    }
  }

  featureColor(id) {
    const o = id * 3;
    return [this._colorLUT[o], this._colorLUT[o + 1], this._colorLUT[o + 2]];
  }

  // ------------------------------------------------------------------- grid

  _buildGrid() {
    const arr = this.position.array;
    const n = this.vertexCount;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const x = arr[i * 3];
      const y = arr[i * 3 + 1];
      const z = arr[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;
    const maxDim = Math.max(sx, sy, sz) || 1;
    const cell = Math.max(maxDim / 64, 1e-5);
    const nx = Math.max(1, Math.ceil(sx / cell) + 1);
    const ny = Math.max(1, Math.ceil(sy / cell) + 1);
    const nz = Math.max(1, Math.ceil(sz / cell) + 1);
    const total = nx * ny * nz;

    const cellIndex = new Int32Array(n);
    const counts = new Int32Array(total);
    for (let i = 0; i < n; i += 1) {
      const cx = Math.min(nx - 1, Math.max(0, Math.floor((arr[i * 3] - minX) / cell)));
      const cy = Math.min(ny - 1, Math.max(0, Math.floor((arr[i * 3 + 1] - minY) / cell)));
      const cz = Math.min(nz - 1, Math.max(0, Math.floor((arr[i * 3 + 2] - minZ) / cell)));
      const idx = cx + nx * (cy + ny * cz);
      cellIndex[i] = idx;
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
    const items = new Int32Array(n);
    for (let i = 0; i < n; i += 1) items[cursor[cellIndex[i]]++] = i;

    this.grid = { min: [minX, minY, minZ], cell, nx, ny, nz, starts, items };
    this.cell = cell;
    this.bboxSize = [sx, sy, sz];
    this.bboxMin = [minX, minY, minZ];
    this.bboxMax = [maxX, maxY, maxZ];
    this.diagonal = Math.hypot(sx, sy, sz);
  }

  /** Visits every vertex whose position is within `radius` of `p` (cb gets squared distance). */
  forEachVertexNear(p, radius, cb) {
    const g = this.grid;
    const arr = this.position.array;
    const r2 = radius * radius;
    const lo = (v, o) => Math.max(0, Math.floor((v - radius - g.min[o]) / g.cell));
    const hi = (v, o, dim) =>
      Math.min(dim - 1, Math.floor((v + radius - g.min[o]) / g.cell));
    const x0 = lo(p[0], 0);
    const y0 = lo(p[1], 1);
    const z0 = lo(p[2], 2);
    const x1 = hi(p[0], 0, g.nx);
    const y1 = hi(p[1], 1, g.ny);
    const z1 = hi(p[2], 2, g.nz);
    for (let cz = z0; cz <= z1; cz += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const rowBase = g.nx * (cy + g.ny * cz);
        for (let cx = x0; cx <= x1; cx += 1) {
          const cellIdx = cx + rowBase;
          const start = g.starts[cellIdx];
          const end = g.starts[cellIdx + 1];
          for (let k = start; k < end; k += 1) {
            const i = g.items[k];
            const dx = arr[i * 3] - p[0];
            const dy = arr[i * 3 + 1] - p[1];
            const dz = arr[i * 3 + 2] - p[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) cb(i, d2);
          }
        }
      }
    }
  }

  nearestVertex(p) {
    let best = -1;
    let bestD2 = Infinity;
    const arr = this.position.array;
    let radius = this.cell;
    for (let attempt = 0; attempt < 4 && best < 0; attempt += 1) {
      this.forEachVertexNear(p, radius, (i) => {
        const dx = arr[i * 3] - p[0];
        const dy = arr[i * 3 + 1] - p[1];
        const dz = arr[i * 3 + 2] - p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      });
      radius *= 3;
    }
    return best;
  }

  // ------------------------------------------------------------- colouring

  _writeVertex(i, id) {
    const o4 = i * 4;
    if (id === UNPAINTED_ID) {
      const a = this.backdrop ? 0.16 : 0;
      this.colors[o4] = UNPAINTED_RGB[0];
      this.colors[o4 + 1] = UNPAINTED_RGB[1];
      this.colors[o4 + 2] = UNPAINTED_RGB[2];
      this.colors[o4 + 3] = a;
    } else {
      const o3 = id * 3;
      this.colors[o4] = this._colorLUT[o3];
      this.colors[o4 + 1] = this._colorLUT[o3 + 1];
      this.colors[o4 + 2] = this._colorLUT[o3 + 2];
      this.colors[o4 + 3] = this.hidden.has(id) ? 0 : 1;
    }
    if (i < this._dirtyMin) this._dirtyMin = i;
    if (i > this._dirtyMax) this._dirtyMax = i;
  }

  refreshColors() {
    for (let i = 0; i < this.vertexCount; i += 1) this._writeVertex(i, this.ids[i]);
  }

  setBackdrop(on) {
    this.backdrop = !!on;
    this.refreshColors();
  }

  setHidden(id, hidden) {
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    for (let i = 0; i < this.vertexCount; i += 1) {
      if (this.ids[i] === id) this._writeVertex(i, id);
    }
  }

  isHidden(id) {
    return this.hidden.has(id);
  }

  /** Uploads only the range of the colour buffer that changed. */
  flush() {
    const attr = this.geometry.attributes.color;
    if (!attr) return;
    if (this._dirtyMax < this._dirtyMin) return;
    const start = this._dirtyMin * 4;
    const count = (this._dirtyMax - this._dirtyMin + 1) * 4;
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
    attr.needsUpdate = true;
    if (typeof attr.addUpdateRange === 'function') {
      attr.addUpdateRange(start, count);
    }
  }

  // --------------------------------------------------------------- strokes

  beginStroke() {
    this._stroke = new Map();
  }

  cancelStroke() {
    this._stroke = null;
  }

  _assign(i, id) {
    const prev = this.ids[i];
    if (prev === id) return false;
    this.ids[i] = id;
    this._writeVertex(i, id);
    if (this._stroke) this._stroke.set(i, prev);
    return true;
  }

  /** Binary brush stamp: every vertex within `radius` of `p` becomes `id`. */
  paintSphere(p, radius, id) {
    let changed = 0;
    this.forEachVertexNear(p, radius, (i) => {
      if (this._assign(i, id)) changed += 1;
    });
    return changed;
  }

  endStroke() {
    const stroke = this._stroke;
    this._stroke = null;
    if (!stroke || stroke.size === 0) return false;
    const idx = new Int32Array(stroke.size);
    const prev = new Int16Array(stroke.size);
    const next = new Int16Array(stroke.size);
    let k = 0;
    for (const [i, p] of stroke) {
      idx[k] = i;
      prev[k] = p;
      next[k] = this.ids[i];
      k += 1;
    }
    this._pushHistory({ type: 'deltas', idx, prev, next });
    return true;
  }

  _pushHistory(entry) {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.redoStack.length = 0;
  }

  _snapshotIds() {
    return { type: 'snapshot', ids: this.ids.slice() };
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    if (entry.type === 'deltas') {
      for (let k = 0; k < entry.idx.length; k += 1) {
        const i = entry.idx[k];
        this.ids[i] = entry.prev[k];
        this._writeVertex(i, entry.prev[k]);
      }
    } else {
      this.ids.set(entry.ids);
      this.refreshColors();
    }
    this.redoStack.push(entry);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    if (entry.type === 'deltas') {
      for (let k = 0; k < entry.idx.length; k += 1) {
        const i = entry.idx[k];
        this.ids[i] = entry.next[k];
        this._writeVertex(i, entry.next[k]);
      }
    } else {
      this.ids.set(entry.ids);
      this.refreshColors();
    }
    this.history.push(entry);
    return true;
  }

  canUndo() {
    return this.history.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  // ------------------------------------------------------------------ edits

  clearAll({ record = true } = {}) {
    if (record) this._pushHistory(this._snapshotIds());
    this.ids.fill(UNPAINTED_ID);
    this.refreshColors();
  }

  clearFeature(id, { record = true } = {}) {
    if (record) this._pushHistory(this._snapshotIds());
    for (let i = 0; i < this.vertexCount; i += 1) {
      if (this.ids[i] === id) {
        this.ids[i] = UNPAINTED_ID;
        this._writeVertex(i, UNPAINTED_ID);
      }
    }
  }

  featureIdAt(i) {
    return this.ids[i];
  }

  stats() {
    const counts = new Map();
    let painted = 0;
    for (let i = 0; i < this.vertexCount; i += 1) {
      const id = this.ids[i];
      if (id !== UNPAINTED_ID) {
        counts.set(id, (counts.get(id) || 0) + 1);
        painted += 1;
      }
    }
    return { counts, painted, total: this.vertexCount };
  }

  // ------------------------------------------------------------ flood fill

  _vertexNormals() {
    if (!this.vertexNormals) {
      const n = this.geometry.attributes.normal;
      this.vertexNormals = n ? n.array : new Float32Array(this.vertexCount * 3);
    }
    return this.vertexNormals;
  }

  /** Median triangle edge length: the natural "one step across the surface". */
  estimateEdgeLength() {
    if (this._edgeLength) return this._edgeLength;
    const arr = this.geometry.attributes.position.array;
    const triCount = this.vertexCount / 3;
    const lengths = [];
    const stride = Math.max(1, Math.floor(triCount / 2000));
    for (let t = 0; t < triCount; t += stride) {
      const a = t * 9;
      const b = a + 3;
      const c = a + 6;
      lengths.push(Math.hypot(arr[b] - arr[a], arr[b + 1] - arr[a + 1], arr[b + 2] - arr[a + 2]));
      lengths.push(Math.hypot(arr[c] - arr[b], arr[c + 1] - arr[b + 1], arr[c + 2] - arr[b + 2]));
    }
    lengths.sort((x, y) => x - y);
    const med = lengths.length ? lengths[Math.floor(lengths.length / 2)] : this.cell;
    this._edgeLength = Math.max(med * 2.2, 1e-4);
    return this._edgeLength;
  }

  /**
   * Region growing from the vertex nearest `p`. `angleLimitDeg` stops the grow when the
   * surface turns more than that between neighbouring vertices (180 = whole shell).
   */
  fillFrom(p, { id, angleLimitDeg = 60, maxVertices = 200000, seedNormal = null }) {
    const eps = this.estimateEdgeLength();
    const norms = this._vertexNormals();
    const cosLimit = Math.cos((Math.min(180, Math.max(1, angleLimitDeg)) * Math.PI) / 180);
    const seed = this.nearestVertex(p);
    if (seed < 0) return { changed: 0, visited: 0, truncated: false };

    const seedDir = seedNormal
      ? new THREE.Vector3(seedNormal.x, seedNormal.y, seedNormal.z).normalize()
      : new THREE.Vector3(norms[seed * 3], norms[seed * 3 + 1], norms[seed * 3 + 2]);

    const visited = new Uint8Array(this.vertexCount);
    const stack = [seed];
    visited[seed] = 1;
    let visitedCount = 0;
    let changed = 0;
    let truncated = false;

    while (stack.length) {
      const i = stack.pop();
      visitedCount += 1;
      if (this._assign(i, id)) changed += 1;
      if (visitedCount >= maxVertices) {
        truncated = true;
        break;
      }
      const nx = norms[i * 3];
      const ny = norms[i * 3 + 1];
      const nz = norms[i * 3 + 2];
      const dot = nx * seedDir.x + ny * seedDir.y + nz * seedDir.z;
      if (dot < cosLimit && angleLimitDeg < 180) continue;
      const px = this.position.array[i * 3];
      const py = this.position.array[i * 3 + 1];
      const pz = this.position.array[i * 3 + 2];
      this.forEachVertexNear([px, py, pz], eps, (j) => {
        if (visited[j]) return;
        visited[j] = 1;
        stack.push(j);
      });
    }
    return { changed, visited: visitedCount, truncated };
  }

  // ------------------------------------------------------------ persistence

  paintedPairs() {
    const out = [];
    for (let i = 0; i < this.vertexCount; i += 1) {
      const id = this.ids[i];
      if (id !== UNPAINTED_ID) out.push(i, id);
    }
    return out;
  }

  loadPairs(pairs) {
    this.ids.fill(UNPAINTED_ID);
    for (let k = 0; k + 1 < pairs.length; k += 2) {
      const i = pairs[k];
      const id = pairs[k + 1];
      if (i >= 0 && i < this.vertexCount && id > 0 && id <= MAX_FEATURE_ID) this.ids[i] = id;
    }
    this.history.length = 0;
    this.redoStack.length = 0;
    this.refreshColors();
  }
}
