/**
 * boxselect.js — which vertices a rectangle dragged on screen covers.
 *
 * A point's place on screen is its inverse transform: the mesh's own coordinates go through
 * the model, view and projection matrices (`M · p`, column-major), and dividing by the clip-space
 * `w` gives the pixel the vertex is drawn at. A rectangle dragged over the viewport is therefore
 * a test in that space — a vertex is under the rectangle when its own pixel is inside it — and
 * the mirror case is the same test on the *reflected* vertex, which is what "paint the other side
 * too" means once the screen is between the user and the mesh.
 *
 * Two things the screen can hide and this file refuses to guess about:
 *
 *   • **Facing.** A box over the face of a closed figure also covers the back of the head, whose
 *     vertices project into the same pixels. Those are culled with the vertex normal and the
 *     camera position (the same test the GPU uses to discard back faces), so a box paints what
 *     you can see of it and reports how many it left alone.
 *   • **Behind the camera.** A vertex behind the camera divides by a negative `w` and lands
 *     somewhere on screen that has nothing to do with where it is, so those are dropped too,
 *     along with anything outside the near and far planes.
 *
 * Dependency-free on purpose: the same code runs in the page and under Node, where the geometry
 * is checked against a real camera (see `test/boxselect.test.mjs`).
 */

/**
 * The rectangle between two dragged corners, in pixels, top-left first.
 *
 * Accepts either two corner points (`{x, y}` each) or a rectangle already in this shape, since
 * callers hold one or the other depending on how far the drag has got. Normalising twice is a
 * no-op, which is why the selector can run it over whatever it is handed.
 */
export function normaliseRect(a, b = undefined) {
  if (b === undefined) {
    // Already a rectangle: only its corners may be out of order (a drag that ended up and left).
    return {
      x0: Math.min(a.x0, a.x1),
      y0: Math.min(a.y0, a.y1),
      x1: Math.max(a.x0, a.x1),
      y1: Math.max(a.y0, a.y1),
    };
  }
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/** True when a screen pixel is inside the rectangle (edges included). */
export function rectContains(rect, x, y) {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

/** How big a rectangle is, for the status line while it is being dragged. */
export function rectSize(rect) {
  return { width: Math.max(0, rect.x1 - rect.x0), height: Math.max(0, rect.y1 - rect.y0) };
}

/**
 * The whole transform a vertex goes through to reach the screen, as one matrix.
 *
 * Kept here rather than in the viewer so the composition can be checked without a renderer: the
 * viewer hands over the three matrices it already has (`camera.projectionMatrix`,
 * `camera.matrixWorldInverse`, `mesh.matrixWorld`, all column-major the way three.js lays them
 * out) and the test compares the result against three.js' own multiplication.
 */
export function screenMatrix(projection, view, model, out = new Float64Array(16)) {
  const vm = multiply4(view, model, new Float64Array(16));
  return multiply4(projection, vm, out);
}

/** `out = a · b`, both column-major 4×4. */
function multiply4(a, b, out) {
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

// A vertex closer than this to the camera plane has no meaningful pixel: `w` approaches zero and
// the division explodes. It is behind or on the lens, either way not on screen.
const MIN_CLIP_W = 1e-6;

/**
 * The vertices of a mesh whose screen pixel falls inside a rectangle.
 *
 * @param {object} o
 * @param {Float32Array|number[]} o.positions flat xyz of the mesh, in its own coordinates
 * @param {Float32Array|number[]|null} o.normals flat xyz normals in the same coordinates. Used for
 *   the facing test; without them a box takes every vertex under it, front and back.
 * @param {ArrayLike<number>} o.matrix the mesh-to-clip matrix (projection × view × model),
 *   column-major, as `THREE.Matrix4.elements` is laid out
 * @param {number} o.width canvas width in the same pixels the rectangle is measured in
 * @param {number} o.height canvas height
 * @param {{x0:number,y0:number,x1:number,y1:number}} o.rect the rectangle, y down from the top
 * @param {ArrayLike<number>|null} o.camera the camera position in the mesh's own coordinates
 * @param {{planeX:number}|null} o.mirror reflect the rectangle in the plane x = planeX, i.e. take
 *   the mirror image of everything the box covers, the way the mirrored brush does
 * @param {boolean} o.facingOnly drop vertices that face away from the camera (default true)
 * @returns {{ vertices: Int32Array, count: number, covered: number, hidden: number,
 *   mirrored: number, behind: number }} `vertices` is in mesh order; `covered` is how many
 *   vertices were under the rectangle at all, `hidden` how many of those were dropped for facing
 *   away, `mirrored` how many were added by the reflected box and `behind` how many were behind
 *   the camera or outside the near/far planes.
 */
export function verticesInScreenRect({
  positions,
  normals = null,
  matrix,
  width,
  height,
  rect,
  camera = null,
  mirror = null,
  facingOnly = true,
}) {
  const vertexCount = Math.floor(positions.length / 3);
  const r = normaliseRect(rect);
  const m = matrix;
  const canFace = !!(normals && camera);
  const picks = new Uint8Array(vertexCount);
  let covered = 0;
  let hidden = 0;
  let behind = 0;

  // Inlined rather than a per-vertex closure: a full-size model is over a million vertices and
  // this runs on every release of the mouse.
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(cw > MIN_CLIP_W)) {
      behind += 1;
      continue;
    }
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (cz < -cw || cz > cw) continue;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const sx = (cx / cw) * 0.5 * width + width * 0.5;
    const sy = height * 0.5 - (cy / cw) * 0.5 * height;
    if (sx < r.x0 || sx > r.x1 || sy < r.y0 || sy > r.y1) continue;
    covered += 1;
    if (facingOnly && canFace && !facesCamera(normals, i, x, y, z, camera[0], camera[1], camera[2])) {
      hidden += 1;
      continue;
    }
    picks[i] = 1;
  }

  let mirrored = 0;
  if (mirror && Number.isFinite(mirror.planeX)) {
    const twice = mirror.planeX * 2;
    for (let i = 0; i < vertexCount; i += 1) {
      if (picks[i]) continue;
      const x = twice - positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (!(cw > MIN_CLIP_W)) continue;
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (cz < -cw || cz > cw) continue;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const sx = (cx / cw) * 0.5 * width + width * 0.5;
      const sy = height * 0.5 - (cy / cw) * 0.5 * height;
      if (sx < r.x0 || sx > r.x1 || sy < r.y0 || sy > r.y1) continue;
      if (facingOnly && canFace) {
        // The reflected vertex keeps its own outward normal reflected with it: the mirror flips
        // the x component, and the camera it has to face is the reflected camera.
        const nx = -normals[i * 3];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];
        const vx = twice - camera[0] - x;
        const vy = camera[1] - y;
        const vz = camera[2] - z;
        if (nx * vx + ny * vy + nz * vz <= 0) continue;
      }
      picks[i] = 1;
      mirrored += 1;
    }
  }

  let count = 0;
  for (let i = 0; i < vertexCount; i += 1) if (picks[i]) count += 1;
  const vertices = new Int32Array(count);
  let at = 0;
  for (let i = 0; i < vertexCount; i += 1) if (picks[i]) vertices[at++] = i;
  return { vertices, count, covered, hidden, mirrored, behind };
}

/** Does this vertex's outward normal point towards the camera? */
function facesCamera(normals, i, x, y, z, camX, camY, camZ) {
  return (
    normals[i * 3] * (camX - x) + normals[i * 3 + 1] * (camY - y) + normals[i * 3 + 2] * (camZ - z) > 0
  );
}
