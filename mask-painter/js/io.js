import { MAX_FEATURE_ID, UNPAINTED_ID } from './features.js';

export const MASK_FORMAT = 'stl-mask';
export const MASK_VERSION = 1;

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeBaseName(name) {
  return (name || 'model').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_');
}

/**
 * Mask + palette as JSON: the authoritative, re-importable format.
 *
 * `stencil` is optional — the build settings that were in the panel when the mask was saved. They
 * are not needed to bring the painting back, but a session that returns with the numbers it was
 * saved with rebuilds the same shell, which is what "save the windows and load them back up to
 * add more" has to mean when the next step is pressing Build again. Files without it still load.
 */
export function buildMaskJSON({ mask, features, modelName, pairs, stencil = null }) {
  const out = {
    format: MASK_FORMAT,
    version: MASK_VERSION,
    model: modelName,
    unit: 'model units',
    vertexCount: mask.vertexCount,
    features: features.map((f) => ({ id: f.id, name: f.name, color: f.color })),
    paintedVertices: pairs.length / 2,
    // flat [vertexIndex, featureId, ...] pairs
    painted: pairs,
  };
  if (stencil) out.stencil = stencil;
  return out;
}

/** Saved build settings, clamped to what the panel accepts. Null when the file has none. */
function parseStencilSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v, min) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : null);
  return {
    coverRadius: num(raw.coverRadius, 1),
    wall: num(raw.wall, 0.2),
    standoff: num(raw.standoff, 0),
    overhang: num(raw.overhang, 0),
    growIfSplit: raw.growIfSplit !== false,
  };
}

export function parseMaskJSON(text) {
  const data = JSON.parse(text);
  if (!data || data.format !== MASK_FORMAT) {
    throw new Error('Not an STL mask file (missing "format": "stl-mask").');
  }
  if (!Array.isArray(data.painted)) throw new Error('Mask file has no "painted" vertex list.');
  const features = Array.isArray(data.features)
    ? data.features
        .filter((f) => f && Number.isInteger(f.id) && f.id > UNPAINTED_ID && f.id <= MAX_FEATURE_ID)
        .map((f) => ({ id: f.id, name: String(f.name || `Feature ${f.id}`), color: f.color || '#888888' }))
    : [];
  return { data, features, pairs: data.painted, stencil: parseStencilSettings(data.stencil) };
}

/**
 * Binary PLY of the painted shell: only triangles whose three vertices carry a feature
 * are written, so the export is the mask itself rather than the whole model.
 */
export function buildPLY(mask) {
  const pos = mask.position.array;
  const triCount = mask.vertexCount / 3;
  const keep = [];
  for (let t = 0; t < triCount; t += 1) {
    const a = t * 3;
    if (mask.ids[a] !== UNPAINTED_ID && mask.ids[a + 1] !== UNPAINTED_ID && mask.ids[a + 2] !== UNPAINTED_ID) {
      keep.push(a);
    }
  }

  // Repack the kept triangles onto their own vertex list.
  const remap = new Map();
  const verts = [];
  const faces = [];
  for (const base of keep) {
    const tri = [];
    for (let k = 0; k < 3; k += 1) {
      const i = base + k;
      let mapped = remap.get(i);
      if (mapped === undefined) {
        mapped = verts.length;
        remap.set(i, mapped);
        verts.push(i);
      }
      tri.push(mapped);
    }
    faces.push(tri);
  }

  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment STL mask export - per-vertex feature colours\n' +
    `element vertex ${verts.length}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n' +
    `element face ${faces.length}\n` +
    'property list uchar uint vertex_indices\n' +
    'end_header\n';

  const vertexStride = 12 + 4;
  const faceStride = 1 + 12;
  const size = header.length + verts.length * vertexStride + faces.length * faceStride;
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < header.length; i += 1) bytes[i] = header.charCodeAt(i) & 255;
  let off = header.length;

  for (const srcIndex of verts) {
    view.setFloat32(off, pos[srcIndex * 3], true);
    view.setFloat32(off + 4, pos[srcIndex * 3 + 1], true);
    view.setFloat32(off + 8, pos[srcIndex * 3 + 2], true);
    const r = Math.round(Math.min(1, Math.max(0, mask.colors[srcIndex * 4])) * 255);
    const g = Math.round(Math.min(1, Math.max(0, mask.colors[srcIndex * 4 + 1])) * 255);
    const b = Math.round(Math.min(1, Math.max(0, mask.colors[srcIndex * 4 + 2])) * 255);
    view.setUint8(off + 12, r);
    view.setUint8(off + 13, g);
    view.setUint8(off + 14, b);
    view.setUint8(off + 15, mask.ids[srcIndex] === UNPAINTED_ID ? 0 : 255);
    off += vertexStride;
  }

  for (const tri of faces) {
    view.setUint8(off, 3);
    view.setUint32(off + 1, tri[0], true);
    view.setUint32(off + 5, tri[1], true);
    view.setUint32(off + 9, tri[2], true);
    off += faceStride;
  }

  return { blob: new Blob([buffer], { type: 'application/octet-stream' }), triangles: faces.length, vertices: verts.length };
}

/**
 * The same solid, moved so its lowest point rests on the print bed.
 *
 * A slicer treats Z = 0 as the plate, and an STL keeps whatever coordinates its exporter used.
 * A shell built on a model that is authored 40 mm above its own Z = 0 therefore lands in the
 * slicer floating 40 mm up, and the part has to be dragged down (or the plate lifted) before it
 * can be printed. The viewport does not show that, because centring the model on the grid moves
 * the view rather than the mesh — the written file is the only place the part can be put on the
 * bed.
 *
 * Only Z moves, and only the copy that gets written: X and Y stay exactly where the model has
 * them (the slicer's own arrange puts the part on the plate), the mask, the panels, the preview
 * and every other export keep the model's coordinates. `drop` is how far the part moved — the
 * lowest Z it had — which is what the status line reports. A part already sitting on Z 0 is
 * returned as it is, so nothing is copied for the common case.
 *
 * @param {Float32Array|number[]} positions flat xyz, the solid's own vertices
 * @returns {{ positions: Float32Array|number[], drop: number }} `drop` is the lowest Z the part
 *   had: positive when it was floating, negative when it was sunk into the plate, 0 when it was
 *   already sitting on it.
 */
export function setOnBed(positions) {
  const drop = lowestZ(positions);
  if (drop === 0) return { positions, drop: 0 };
  const out = positions.slice();
  for (let i = 2; i < out.length; i += 3) out[i] -= drop;
  return { positions: out, drop };
}

/** The lowest Z of a solid's own vertices — how high its lowest point floats over Z = 0. */
export function lowestZ(positions) {
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) if (positions[i] < minZ) minZ = positions[i];
  return Number.isFinite(minZ) ? minZ : 0;
}

/**
 * Binary STL of an indexed triangle mesh — the format 3D printing tools want.
 * `positions` is a flat xyz array, `indices` a flat triangle index array.
 */
export function buildBinarySTL(positions, indices) {
  const triCount = indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = 'STL Mask Painter stencil';
  for (let i = 0; i < 80; i += 1) view.setUint8(i, i < header.length ? header.charCodeAt(i) & 255 : 32);
  view.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t += 1) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
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
    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    const verts = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let k = 0; k < 9; k += 1) view.setFloat32(off + 12 + k * 4, verts[k], true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  return { buffer, triangles: triCount, bytes: buffer.byteLength };
}
