/**
 * boxselect.js — which triangles a rectangle dragged on screen covers.
 *
 * A point's place on screen is its inverse transform: the mesh's own coordinates go through
 * the model, view and projection matrices (`M · p`, column-major), and dividing by the clip-space
 * `w` gives the pixel the vertex is drawn at. A rectangle dragged over the viewport is therefore
 * a test in that space.
 *
 * Two things the screen can hide and this file refuses to guess about:
 *
 *   • **Facing.** A box over the face of a closed figure also covers the back of the head, whose
 *     triangles project into the same pixels. Those are culled with the triangle's own normal and
 *     the camera position (the same test the GPU uses to discard back faces), so a box selects
 *     what you can see of it and reports how many it left alone.
 *   • **Behind the camera.** A point behind the camera divides by a negative `w` and lands
 *     somewhere on screen that has nothing to do with where it is, so those are dropped too,
 *     along with anything outside the near and far planes.
 *
 * The vertex version of this test — a rectangle that painted every vertex under it — used to live
 * here too, for the tool that painted the mask. The app selects faces now and has no use for it.
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
 * The triangles a rectangle dragged on screen covers.
 *
 * This is the inverse transform of the projection, asked about a triangle instead of
 * a vertex: a face is under the rectangle when the pixel its **centre** is drawn at is inside it.
 * The centre is the honest rule for a box that means "these triangles" — "any corner inside" takes
 * a triangle that is mostly outside, "every corner inside" drops one that is mostly inside, and
 * both read as the box ignoring what it plainly covers.
 *
 * Facing is decided from the triangle's own normal, computed from its three corners rather than
 * read from a normal attribute: the soup's vertex normals are shared between faces and have been
 * averaged, which is right for shading and wrong for "is this triangle pointing at me". A box over
 * the face of a closed figure otherwise takes the back of the head as well, whose centre projects
 * into the same pixels.
 *
 * Returns a `0/1` mask over faces, so the caller decides what a pick is (this triangle, or the
 * model it belongs to); `covered` is how many faces were under the rectangle at all, `hidden` how
 * many of those point away, and `behind` how many centres had no usable pixel.
 */
export function facesInScreenRect({
  positions,
  matrix,
  width,
  height,
  rect,
  camera = null,
  facingOnly = true,
}) {
  const faceCount = Math.floor(positions.length / 9);
  const r = normaliseRect(rect);
  const m = matrix;
  const canFace = !!camera;
  const faces = new Uint8Array(faceCount);
  let covered = 0;
  let hidden = 0;
  let behind = 0;
  let count = 0;

  for (let t = 0; t < faceCount; t += 1) {
    const base = t * 9;
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];
    const x = (ax + bx + cx) / 3;
    const y = (ay + by + cy) / 3;
    const z = (az + bz + cz) / 3;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(cw > MIN_CLIP_W)) {
      behind += 1;
      continue;
    }
    const clipZ = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (clipZ < -cw || clipZ > cw) continue;
    const px = m[0] * x + m[4] * y + m[8] * z + m[12];
    const py = m[1] * x + m[5] * y + m[9] * z + m[13];
    const sx = (px / cw) * 0.5 * width + width * 0.5;
    const sy = height * 0.5 - (py / cw) * 0.5 * height;
    if (sx < r.x0 || sx > r.x1 || sy < r.y0 || sy > r.y1) continue;
    covered += 1;
    if (facingOnly && canFace) {
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (nx * (camera[0] - x) + ny * (camera[1] - y) + nz * (camera[2] - z) <= 0) {
        hidden += 1;
        continue;
      }
    }
    faces[t] = 1;
    count += 1;
  }

  return { faces, count, covered, hidden, behind };
}
