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

/** Mask + palette as JSON: the authoritative, re-importable format. */
export function buildMaskJSON({ mask, features, modelName, pairs }) {
  return {
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
  return { data, features, pairs: data.painted };
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
