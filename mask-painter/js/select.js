/**
 * select.js — picking whole models (the separate shells inside one file) and single faces out of
 * a triangle soup, and taking the picked ones back out of it.
 *
 * Why this exists: an STL is not a scene. Exporters routinely write several models into one
 * file — a figure plus a base, a duplicate sitting beside it, a stray blob from a failed boolean
 * — and nothing in the format says they are separate objects. They are only visible as *shells*:
 * groups of triangles joined to each other by shared edges, with no edge crossing between the
 * groups. Two shells that merely touch at a point stay separate here, because a shared point is
 * not a shared surface — the same rule a slicer uses when it reports "2 objects".
 *
 * The second half of the file is the surgery: `filterSoup` copies a soup without the faces that
 * were rejected and reports, for every corner it kept, which corner it came from — so the paint
 * (which is per vertex) survives a removal, and so does the undo history that describes it.
 *
 * Dependency-free on purpose: the same code runs in the page and under Node, where the shells and
 * the filtering are checked on a soup whose shells are known by construction.
 */

// Welded vertex ids stay below 2^23 (see buildTopology), so an id pair packs into one exact
// integer key and a Map can hold it without collisions.
const ID_SHIFT = 8388608;

/**
 * The separate models in a soup, as connected groups of faces.
 *
 * Faces are joined when they share an *edge* (two welded corners), which is what a slicer means
 * by one object: two shells that only meet at a corner are reported separately, and a shell that
 * is inside another is a shell of its own.
 *
 * `faceShell[t]` is the shell of face `t`; shells are numbered biggest first, so shell 0 is the
 * main body and `shellFaces` is in faces-descending order — the order a list wants to show.
 * `shellBounds` is min/max per shell as `[minX, minY, minZ, maxX, maxY, maxZ]`, in the file's own
 * coordinates (what "is this model below the other one" has to be measured in).
 */
export function shellsOf(topology) {
  const { faces, faceCount, positions } = topology;
  if (!faceCount) {
    return {
      faceCount: 0,
      shellCount: 0,
      faceShell: new Int32Array(0),
      shellFaces: new Int32Array(0),
      shellBounds: new Float32Array(0),
    };
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
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const owner = new Map();
  for (let t = 0; t < faceCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = faces[t * 3 + k];
      const b = faces[t * 3 + ((k + 1) % 3)];
      if (a === b) continue; // a degenerate edge joins nothing
      const key = a < b ? a * ID_SHIFT + b : b * ID_SHIFT + a;
      const prev = owner.get(key);
      // The third face on an edge (non-manifold input) still joins: it shares the edge too.
      if (prev === undefined) owner.set(key, t);
      else union(prev, t);
    }
  }

  // Compact to dense shell ids, biggest first.
  const rootToShell = new Map();
  const sizes = [];
  const faceShell = new Int32Array(faceCount).fill(-1);
  const bounds = [];
  for (let t = 0; t < faceCount; t += 1) {
    const r = find(t);
    let id = rootToShell.get(r);
    if (id === undefined) {
      id = sizes.length;
      rootToShell.set(r, id);
      sizes.push(0);
      bounds.push([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    }
    faceShell[t] = id;
    sizes[id] += 1;
    const box = bounds[id];
    for (let k = 0; k < 3; k += 1) {
      const v = faces[t * 3 + k] * 3;
      const x = positions[v];
      const y = positions[v + 1];
      const z = positions[v + 2];
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (z < box[2]) box[2] = z;
      if (x > box[3]) box[3] = x;
      if (y > box[4]) box[4] = y;
      if (z > box[5]) box[5] = z;
    }
  }

  const order = sizes.map((n, id) => [n, id]).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const remap = new Int32Array(sizes.length);
  order.forEach(([, id], i) => {
    remap[id] = i;
  });
  const shellFaces = Int32Array.from(order.map(([n]) => n));
  const shellBounds = new Float32Array(sizes.length * 6);
  order.forEach(([, id], i) => {
    for (let k = 0; k < 6; k += 1) shellBounds[i * 6 + k] = bounds[id][k];
  });
  for (let t = 0; t < faceCount; t += 1) faceShell[t] = remap[faceShell[t]];

  return { faceCount, shellCount: sizes.length, faceShell, shellFaces, shellBounds };
}

/** Size of a shell's own bounding box, as `[x, y, z]` — how big that model is by itself. */
export function shellSize(shellBounds, shell) {
  const o = shell * 6;
  return [
    shellBounds[o + 3] - shellBounds[o],
    shellBounds[o + 4] - shellBounds[o + 1],
    shellBounds[o + 5] - shellBounds[o + 2],
  ];
}

/**
 * Which faces are in the given shells, as a `0/1` array over faces.
 *
 * Used both to select a shell and to *report* one: the counts the panel shows come from here, so
 * a click and the list cannot disagree about what a shell contains.
 */
export function facesOfShells(shells, wanted, out = null) {
  const mask = out && out.length === shells.faceCount ? out : new Uint8Array(shells.faceCount);
  mask.fill(0);
  const set = wanted instanceof Set ? wanted : new Set(wanted);
  for (let t = 0; t < shells.faceCount; t += 1) {
    if (set.has(shells.faceShell[t])) mask[t] = 1;
  }
  return mask;
}

/** How many faces a `0/1` face mask keeps — the count every status line quotes. */
export function countFaces(mask) {
  let n = 0;
  for (let t = 0; t < mask.length; t += 1) if (mask[t]) n += 1;
  return n;
}

/**
 * A soup without the faces `keepFace` rejects.
 *
 * Everything is copied in face order, so the kept triangles stay where they were relative to each
 * other. `cornerMap` is the part the rest of the app needs: `cornerMap[i]` is the corner index
 * `i` had *before* the cut, which is how the paint (`mask.ids`, one entry per corner) and the
 * undo history are carried across a removal instead of being thrown away. `faceMap[i]` does the
 * same for faces, which is how the geometry in hand is traced back to the file it came from.
 */
export function filterSoup({ positions, normals = null, ids = null }, keepFace) {
  const faceCount = Math.floor(positions.length / 9);
  let kept = 0;
  for (let t = 0; t < faceCount; t += 1) if (keepFace[t]) kept += 1;

  const outPositions = new Float32Array(kept * 9);
  const outNormals = normals ? new Float32Array(kept * 9) : null;
  const outIds = ids ? new Int16Array(kept * 3) : null;
  const cornerMap = new Int32Array(kept * 3);
  const faceMap = new Int32Array(kept);

  let w = 0;
  let g = 0;
  for (let t = 0; t < faceCount; t += 1) {
    if (!keepFace[t]) continue;
    faceMap[g] = t;
    g += 1;
    for (let k = 0; k < 3; k += 1) {
      const corner = t * 3 + k;
      const src = corner * 3;
      outPositions[w * 3] = positions[src];
      outPositions[w * 3 + 1] = positions[src + 1];
      outPositions[w * 3 + 2] = positions[src + 2];
      if (outNormals) {
        outNormals[w * 3] = normals[src];
        outNormals[w * 3 + 1] = normals[src + 1];
        outNormals[w * 3 + 2] = normals[src + 2];
      }
      if (outIds) outIds[w] = ids[corner];
      cornerMap[w] = corner;
      w += 1;
    }
  }
  return { positions: outPositions, normals: outNormals, ids: outIds, cornerMap, faceMap, faces: kept };
}

/**
 * The triangles of a `0/1` face mask, plus their boundary: what a pick is drawn with.
 *
 * The fill is the point of this function. Edges alone were the first attempt at showing a pick and
 * they were invisible — three hairlines lying exactly on the surface they trace z-fight with the
 * triangle they belong to, so a single picked face on a big model showed nothing at all and the
 * tool looked broken. Filling the triangles is what makes a pick visible from across the room; the
 * boundary only says where the picked faces stop, which is what matters once a pick is a region.
 *
 * Returns `null` for a mask that picks nothing, and for one above `limit`: a highlight that would
 * be tens of thousands of triangles is left to the count in the panel rather than drawn.
 */
export function highlightArrays(positions, faceMask, { limit = 60000 } = {}) {
  const faces = faceMask.length;
  let picked = 0;
  for (let t = 0; t < faces; t += 1) if (faceMask[t]) picked += 1;
  if (!picked || picked > limit) return null;
  const fill = new Float32Array(picked * 9);
  const edges = new Float32Array(picked * 18);
  let f = 0;
  let e = 0;
  for (let t = 0; t < faces; t += 1) {
    if (!faceMask[t]) continue;
    const base = t * 9;
    for (let k = 0; k < 9; k += 1) fill[f + k] = positions[base + k];
    f += 9;
    for (let k = 0; k < 3; k += 1) {
      const a = base + k * 3;
      const b = base + ((k + 1) % 3) * 3;
      edges[e] = positions[a];
      edges[e + 1] = positions[a + 1];
      edges[e + 2] = positions[a + 2];
      edges[e + 3] = positions[b];
      edges[e + 4] = positions[b + 1];
      edges[e + 5] = positions[b + 2];
      e += 6;
    }
  }
  return { fill, edges, faces: picked };
}

/** The corner map of `filterSoup` run backwards: old corner -> new corner, or -1 if it is gone. */
export function inverseCornerMap(cornerMap) {
  let maxOld = -1;
  for (let i = 0; i < cornerMap.length; i += 1) if (cornerMap[i] > maxOld) maxOld = cornerMap[i];
  const toNew = new Int32Array(maxOld + 1).fill(-1);
  for (let i = 0; i < cornerMap.length; i += 1) toNew[cornerMap[i]] = i;
  return toNew;
}

/**
 * The mask's undo history, renumbered for a soup that was cut.
 *
 * Every entry names corners by index, and a cut moves them, so a history left alone would undo
 * the wrong vertices — silently, and only on the next Ctrl+Z. Entries that name a corner which no
 * longer exists lose those corners; a snapshot (a whole-mask edit) is rebuilt corner by corner,
 * so paint that survived the cut is what redo puts back.
 */
export function remapHistory(history, cornerMap, newCount) {
  if (!history || history.length === 0) return [];
  const toNew = inverseCornerMap(cornerMap);
  const sample = (ids) => {
    const out = new Int16Array(newCount);
    for (let i = 0; i < cornerMap.length; i += 1) {
      const v = ids[cornerMap[i]];
      out[i] = v === undefined ? 0 : v;
    }
    return out;
  };
  const out = [];
  for (const entry of history) {
    if (entry.type === 'deltas') {
      const idx = [];
      const prev = [];
      const next = [];
      for (let k = 0; k < entry.idx.length; k += 1) {
        const at = entry.idx[k];
        const moved = at < toNew.length ? toNew[at] : -1;
        if (moved < 0) continue;
        idx.push(moved);
        prev.push(entry.prev[k]);
        next.push(entry.next[k]);
      }
      if (idx.length) {
        out.push({
          type: 'deltas',
          idx: Int32Array.from(idx),
          prev: Int16Array.from(prev),
          next: Int16Array.from(next),
        });
      }
    } else {
      const copy = { type: 'snapshot', ids: sample(entry.ids) };
      if (entry.next) copy.next = sample(entry.next);
      out.push(copy);
    }
  }
  return out;
}
