// Trimming a mask down to the regions that are worth printing.
//
// A mask is painted with a brush, so it always carries company: a dab that landed beside the
// eye instead of on it, a stamp from a stroke that ran off the edge of the part, a speck left
// behind where a fill stopped at a seam. The stencil build is honest about every one of them —
// each separate painted region becomes its own window in the shell, and regions that do not
// touch each other become separate pieces — so a handful of specks turns into a part with a
// handful of extra windows, several loose shells and nothing to hold them together on the
// print bed. This module finds those islands and offers the two ways to be rid of one: a size
// threshold (`planIslandTrim`) and a list that can be pointed at by name (`maskWindows`).
//
// The threshold is the blunt one, and it has a blind spot worth knowing about: it can only
// release islands *other* than the largest, and only whole islands — so a mask that is one
// connected region (two panels that touch, a stroke back and forth, a fill) has nothing a size
// test can ever take out, however high it is set. That is what the list is for: it names every
// window and hands back exactly the vertices that release that one.
//
// Pure typed arrays, no three.js and no DOM: the same code runs in the page and under Node in
// test/cleanup.test.mjs.
//
// An island is a connected group of painted vertices of the *welded* surface, found by walking
// the neighbour lists `buildTopology()` built. Welded rather than per file vertex because an
// STL repeats every vertex once per triangle: two triangles that share an edge share no vertex
// index at all, and it is the weld that makes them neighbours.

/**
 * One painted island: how many welded vertices it has, and the box they span.
 *
 * The box is what a trim threshold is measured against — a size in model units says something
 * about whether a printer can use the piece, while a vertex count does not: the same spec is
 * 40 vertices on a coarse mesh and 4,000 on a dense one.
 */
function describeIsland(id, members, positions) {
  const n = members.length;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < n; k += 1) {
    const v = members[k] * 3;
    const x = positions[v];
    const y = positions[v + 1];
    const z = positions[v + 2];
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
  return {
    id,
    vertices: n,
    members,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [sx, sy, sz],
    diagonal: Math.hypot(sx, sy, sz),
  };
}

/**
 * Every painted region of a welded model.
 *
 * A welded vertex counts as painted when any file vertex welded onto it was painted — painting
 * is a spatial query, so the copies of one position always agree, but a panel selection can
 * touch only the copy its own triangle carries.
 *
 * @param {object} topology from `buildTopology()` (uses `wCount`, `weldOf`, `neighborStart`,
 *   `neighbors`, `positions`)
 * @param {Int16Array|Int8Array} ids the mask: a feature id per file vertex, 0 = unpainted
 * @returns {{ painted: Uint8Array, label: Int32Array, islands: object[] }} `label` is the
 *   island index per welded vertex (`-1` unpainted), and `islands` is largest first.
 */
export function paintedIslands(topology, ids) {
  const { wCount, weldOf, neighborStart, neighbors, positions } = topology;
  const painted = new Uint8Array(wCount);
  for (let i = 0; i < ids.length && i < weldOf.length; i += 1) {
    if (ids[i] !== 0) painted[weldOf[i]] = 1;
  }

  const seen = new Uint8Array(wCount);
  const islands = [];
  const stack = [];
  for (let start = 0; start < wCount; start += 1) {
    if (!painted[start] || seen[start]) continue;
    const members = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const v = stack.pop();
      members.push(v);
      for (let k = neighborStart[v]; k < neighborStart[v + 1]; k += 1) {
        const n = neighbors[k];
        if (painted[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    islands.push(describeIsland(islands.length, members, positions));
  }

  // Largest first, then renumber, so island 0 is always the mask proper — the one a trim keeps.
  islands.sort((a, b) => b.vertices - a.vertices || a.id - b.id);
  const label = new Int32Array(wCount).fill(-1);
  for (let i = 0; i < islands.length; i += 1) {
    islands[i].id = i;
    for (const v of islands[i].members) label[v] = i;
  }
  return { painted, label, islands };
}

/**
 * The painted windows of a mask, largest first: one entry per connected painted region, each
 * carrying the file vertices that make it up.
 *
 * This is the list a size threshold cannot express. `fileVertices` is exactly the set of file
 * vertices a mask edit has to release to take that one window out and leave every other window
 * untouched, which is what "remove or designate and remove" needs: a threshold says "smaller
 * than this", a window says "that one".
 *
 * `features` reports which features the window is painted with (largest group first), because a
 * window can be composed of several selections — Shift-click with the Part tool paints another
 * panel with the current feature and keeps the window one window if the two panels touch.
 *
 * @param {object} topology from `buildTopology()`
 * @param {Int16Array|Int8Array} ids the mask, 0 = unpainted
 * @returns {object[]} largest first, each `{ id, weldedVertices, vertices, fileVertices, size,
 *   diagonal, centre, features }` — `vertices`/`fileVertices` count and list file vertices,
 *   `weldedVertices` is the welded count the size test works in.
 */
export function maskWindows(topology, ids) {
  const { weldOf } = topology;
  const { label, islands } = paintedIslands(topology, ids);
  const fileVertices = islands.map(() => []);
  for (let i = 0; i < ids.length && i < weldOf.length; i += 1) {
    if (ids[i] === 0) continue;
    const window = label[weldOf[i]];
    if (window >= 0) fileVertices[window].push(i);
  }
  return islands.map((island, k) => ({
    id: island.id,
    weldedVertices: island.vertices,
    vertices: fileVertices[k].length,
    fileVertices: fileVertices[k],
    size: island.size,
    diagonal: island.diagonal,
    centre: [
      (island.min[0] + island.max[0]) / 2,
      (island.min[1] + island.max[1]) / 2,
      (island.min[2] + island.max[2]) / 2,
    ],
    features: featureCounts(ids, fileVertices[k]),
  }));
}

/** Which feature the file vertices of one window carry, largest group first. */
function featureCounts(ids, fileVertices) {
  const counts = new Map();
  for (const i of fileVertices) counts.set(ids[i], (counts.get(ids[i]) || 0) + 1);
  return [...counts]
    .map(([id, vertices]) => ({ id, vertices }))
    .sort((a, b) => b.vertices - a.vertices || a.id - b.id);
}

/**
 * What a trim would release, without touching anything.
 *
 * The blind spot is deliberate and is worth repeating: only islands *other* than the largest,
 * and only whole islands. A one-window mask has nothing a threshold can do; `maskWindows()` is
 * how that window gets named and taken out by hand.
 *
 * @returns {object} `released` are the file-vertex indices to un-paint (the mask edit itself),
 *   with `threshold`, `islands` (count), `doomedIslands`, `doomedVertices`, `largestVertices`,
 *   `largestDiagonal`, `sparedLargest` (the largest island sat under the threshold as well) and
 *   `details` (one line per island, largest first).
 */
export function planIslandTrim({ topology, ids, minDiagonal }) {
  const threshold = Math.max(0, Number(minDiagonal) || 0);
  const { weldOf } = topology;
  // `label` is indexed by welded vertex — the island a painted position belongs to — while the
  // mask is per file vertex, so the weld is what joins the two.
  const { label, islands } = paintedIslands(topology, ids);
  const largest = islands.length ? islands[0] : null;
  const doomed = islands.filter((island) => island !== largest && island.diagonal < threshold);

  const doomedWelds = new Uint8Array(topology.wCount);
  for (const island of doomed) {
    for (const v of island.members) doomedWelds[v] = 1;
  }
  const released = [];
  for (let i = 0; i < ids.length && i < weldOf.length; i += 1) {
    if (ids[i] !== 0 && doomedWelds[weldOf[i]]) released.push(i);
  }

  return {
    threshold,
    islands: islands.length,
    doomedIslands: doomed.length,
    doomedVertices: released.length,
    released,
    largestVertices: largest ? largest.vertices : 0,
    largestDiagonal: largest ? largest.diagonal : 0,
    // True when the mask is only specks: the one island kept sat under the threshold as well.
    sparedLargest: doomed.length > 0 && largest !== null && largest.diagonal < threshold,
    details: islands.map((island) => ({
      id: island.id,
      vertices: island.vertices,
      diagonal: island.diagonal,
      size: island.size,
    })),
  };
}
