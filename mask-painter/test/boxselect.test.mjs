// Box paint (and the Select tool's box): the rubber band dragged on screen, and the inverse
// transform behind it.
//
//   node test/boxselect.test.mjs
//
// Three levels. The rule, on a cloud of vertices whose screen positions are known exactly: what
// the selector returns has to match what three.js' own `project()` says, vertex for vertex, over a
// spread of rectangles — including the ones people actually drag (backwards, one pixel, off the
// model). Then the real model through a real camera, where the pixels are checked independently
// and the facing rule decides whether a box over the face takes the back of the head too. Then the
// paint: the selection has to land on the mask as one undo step, and undo has to take it back.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { MaskLayer } from '../js/mask.js';
import { createFeatureList } from '../js/features.js';
import { centreTranslation } from '../js/viewer.js';
import { verticesInScreenRect, facesInScreenRect, screenMatrix, normaliseRect, rectContains, rectSize } from '../js/boxselect.js';
import { parseBinarySTL, fmt } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const W = 800;
const H = 600;

// ---------------------------------------------------------------- the rule, on a known cloud

{
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const points = [];
  for (let iy = -2; iy <= 2; iy += 1) {
    for (let ix = -2; ix <= 2; ix += 1) points.push([ix * 1.5, iy * 1.5, 0]);
  }
  const positions = Float32Array.from(points.flat());
  const normals = Float32Array.from(points.flatMap(() => [0, 0, 1]));
  const identity = new THREE.Matrix4().identity().elements;
  const matrix = screenMatrix(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, identity);

  /** Where three.js itself says a vertex is drawn. The independent half of every check below. */
  const screenOf = (p) => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
    return { x: (v.x * 0.5 + 0.5) * W, y: (0.5 - v.y * 0.5) * H };
  };
  const pixels = points.map(screenOf);

  // The composition of the three matrices is the app's whole transform, so it is checked against
  // three.js' own multiply rather than against itself.
  const expectedMatrix = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const composed = [...matrix];
  const reference = expectedMatrix.elements;
  let worst = 0;
  for (let i = 0; i < 16; i += 1) worst = Math.max(worst, Math.abs(composed[i] - reference[i]));
  check('the composed screen matrix is the one three.js builds', worst < 1e-9, `largest cell difference ${worst.toExponential(1)}`);

  const rects = [
    { x0: 0, y0: 0, x1: W, y1: H },
    { x0: 0, y0: 0, x1: W / 2, y1: H / 2 },
    { x0: W / 2, y0: H / 2, x1: W, y1: H },
    { x0: 0, y0: H * 0.45, x1: W, y1: H * 0.55 },
    { x0: W * 0.4, y0: 0, x1: W * 0.6, y1: H },
    { x0: W * 0.47, y0: H * 0.45, x1: W * 0.53, y1: H * 0.55 },
    { x0: W * 0.1, y0: H * 0.1, x1: W * 0.15, y1: H * 0.15 },
    { x0: W * 0.9, y0: H * 0.9, x1: W * 0.95, y1: H * 0.95 },
    { x0: 400, y0: 0, x1: 400, y1: H },
    { x0: W * 0.8, y0: H * 0.2, x1: W * 0.2, y1: H * 0.7 }, // dragged bottom-right to top-left
    { x0: -50, y0: -50, x1: W + 50, y1: H + 50 },
    { x0: W * 0.3, y0: H * 0.3, x1: W * 0.35, y1: H * 0.35 },
  ];

  let agreed = 0;
  let mismatches = 0;
  let selected = 0;
  let misplaced = 0;
  for (const raw of rects) {
    const rect = normaliseRect({ x: raw.x0, y: raw.y0 }, { x: raw.x1, y: raw.y1 });
    const want = points
      .map((_, i) => i)
      .filter((i) => rectContains(rect, pixels[i].x, pixels[i].y));
    const got = [...verticesInScreenRect({ positions, normals, matrix, width: W, height: H, rect, camera: [0, 0, 10] }).vertices];
    selected += got.length;
    if (want.join(',') === got.join(',')) agreed += 1;
    else mismatches += 1;
    // Where three.js puts every vertex it handed back, in case the sets differ.
    for (const i of got) if (!rectContains(rect, pixels[i].x, pixels[i].y)) misplaced += 1;
  }
  check(
    'what the selector takes is exactly what three.js projects into the rectangle',
    mismatches === 0 && agreed === rects.length,
    `${agreed}/${rects.length} rectangles agreed, ${selected} vertex hits`,
  );
  check('and nothing outside the rectangle is ever handed back', misplaced === 0);

  // The screen is y-down: the cloud's top row is a *smaller* pixel y than its bottom row.
  const topRow = pixels.filter((_, i) => points[i][1] > 0).map((p) => p.y);
  const bottomRow = pixels.filter((_, i) => points[i][1] < 0).map((p) => p.y);
  check(
    'the y axis runs down from the top of the canvas, like the pointer events do',
    Math.max(...topRow) < Math.min(...bottomRow),
    `upper cloud rows at y ${Math.min(...topRow).toFixed(0)}–${Math.max(...topRow).toFixed(0)}, lower rows at ${Math.min(...bottomRow).toFixed(0)}–${Math.max(...bottomRow).toFixed(0)}`,
  );

  const whole = { x0: 0, y0: 0, x1: W, y1: H };
  const base = { positions, normals, matrix, width: W, height: H, rect: whole, camera: [0, 0, 10] };
  const facing = verticesInScreenRect(base);
  const reversed = {
    ...base,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(points.flatMap(() => [0, 0, -1])),
  };
  const away = verticesInScreenRect(reversed);
  check(
    'a box over a closed surface leaves out the vertices that face away — unless it is asked not to',
    facing.count === 25 && away.count === 0 && away.hidden === 25,
    `${facing.count} taken, ${away.count} taken with the normals reversed (${away.hidden} reported as facing away)`,
  );
  const all = verticesInScreenRect({ ...reversed, facingOnly: false });
  check('turning the facing rule off takes them all, which is what a shell wants', all.count === 25, `${all.count} taken`);

  // Behind the camera: the camera sits at z 10 looking at the origin, so a vertex at z 20 is behind
  // its own lens and has no pixel at all.
  const behindPositions = Float32Array.from([...positions, 2, 0, 20]);
  const behindNormals = Float32Array.from([...normals, 0, 0, 1]);
  const behind = verticesInScreenRect({ ...base, positions: behindPositions, normals: behindNormals });
  check(
    'a vertex behind the camera is dropped instead of projected onto a pixel that is not its own',
    behind.count === 25 && behind.behind === 1,
    `${behind.count} taken, ${behind.behind} behind the camera`,
  );

  // In front of the camera but inside the near plane: the renderer clips it, so its pixel is not
  // part of the picture the rectangle was dragged over. It projects to the middle of the screen
  // (the division by a tiny w puts it there), which is exactly why the clip test has to be there.
  const nearPositions = Float32Array.from([...positions, 0, 0, 9.97]);
  const nearNormals = Float32Array.from([...normals, 0, 0, 1]);
  const clipped = verticesInScreenRect({ ...base, positions: nearPositions, normals: nearNormals });
  check(
    'a vertex inside the near plane is clipped, not taken as if it were on screen',
    clipped.count === 25 && clipped.vertices.length === 25 && clipped.behind === 0,
    `${clipped.count} taken of ${clipped.vertices.length} candidates near a full-screen box (the extra vertex is 0.03 in front of the lens, near plane 0.1)`,
  );

  // Mirroring: the box is taken again on the other side of the plane, exactly as the mirrored
  // brush paints the other side of the model. The plane is deliberately *not* at the origin and
  // the camera is not on it, so a reflected camera or a reflected normal that forgot to reflect
  // would show up here rather than cancelling out.
  const pair = {
    positions: Float32Array.from([-2.5, 0, 0, 3.5, 0, 0, 3.5, 0, 0, 3.5, 0, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, -1, 3, 0, 1]),
    matrix,
    width: W,
    height: H,
    rect: { x0: 0, y0: 0, x1: 200, y1: H }, // the left hand side of the screen
    camera: [1.5, 0, 10],
  };
  const plain = verticesInScreenRect(pair);
  const mirrored = verticesInScreenRect({ ...pair, mirror: { planeX: 0.5 } });
  check(
    'a box on one side takes only that side until mirroring is on',
    plain.count === 1 && plain.vertices[0] === 0,
    `${plain.count} taken: ${[...plain.vertices].join(', ')}`,
  );
  check(
    'with mirroring on, the reflection of what the box covers is taken as well',
    mirrored.count === 3 && mirrored.mirrored === 2 && mirrored.vertices[1] === 1,
    `${mirrored.count} taken, ${mirrored.mirrored} of them mirrored (vertex 1 is the mirror of 0 about x = 0.5)`,
  );
  // Vertex 3 faces the *reflected* camera and not the real one (its normal leans 3:1 along x),
  // so it is only taken if the camera is reflected with the vertex.
  check(
    'and the reflection is judged against the reflected camera, not the one the user is looking from',
    [...mirrored.vertices].includes(3) && ![...plain.vertices].includes(3),
    `with mirroring: ${[...mirrored.vertices].join(', ')}; without: ${[...plain.vertices].join(', ')}`,
  );
  check(
    'and a reflected vertex that faces away is not taken just because its mirror image is in the box',
    ![...mirrored.vertices].includes(2),
    `taken: ${[...mirrored.vertices].join(', ')} (vertex 2 faces away)`,
  );

  const r = normaliseRect({ x: 40, y: 90 }, { x: 10, y: 20 });
  const size = rectSize(r);
  check(
    'the rectangle from two dragged corners is normalised, whichever way it was dragged',
    r.x0 === 10 && r.y0 === 20 && r.x1 === 40 && r.y1 === 90 && size.width === 30 && size.height === 70,
    `x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}`,
  );
}

// --------------------------------------------- the triangles a rectangle covers
//
// The Select tool's rubber band picks triangles, not vertices, and the rule for "is this triangle
// under the box" is its **centre**. Both halves of that are checked here against three.js' own
// vector maths: the pixel the centre is drawn at (`project()`), and the triangle's own normal from
// its corners (`sub`/`cross`/`dot`), so a sign error or a rule that quietly became "any corner
// inside" shows up as a disagreement rather than as a plausible number.
{
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const identity = new THREE.Matrix4().identity().elements;
  const matrix = screenMatrix(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, identity);
  const camAt = new THREE.Vector3(0, 0, 10);

  // Four triangles in the z = 0 plane: two wide ones that reach across the screen and one small
  // one at the middle, all wound counter-clockwise as seen from the camera and so facing it, plus
  // a fourth below the middle wound the other way, which points away. The winding is what decides
  // facing, so these four are the whole fixture: a triangle the camera cannot see is the case the
  // rule exists for.
  const faces = [
    [[-3, 3, 0], [-3, 0, 0], [0, 3, 0]], // A, face on, centre up-left
    [[0, 0, 0], [3, -3, 0], [3, 0, 0]], // B, face on, centre down-right
    [[-0.5, 0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0]], // C, face on, centre of the screen
    [[-0.5, -1.5, 0], [0.5, -1.5, 0], [0, -2.5, 0]], // D, wound the other way: points away
  ];
  const soup = Float32Array.from(faces.flat(2));
  const faceCount = soup.length / 9;

  /** three.js' own answer for a face: where its centre is drawn, and which way it points. */
  const reference = (t) => {
    const v = [0, 1, 2].map((k) => new THREE.Vector3(soup[t * 9 + k * 3], soup[t * 9 + k * 3 + 1], soup[t * 9 + k * 3 + 2]));
    const centre = new THREE.Vector3().add(v[0]).add(v[1]).add(v[2]).multiplyScalar(1 / 3);
    const projected = centre.clone().project(camera);
    const normal = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
    return {
      x: (projected.x * 0.5 + 0.5) * W,
      y: (0.5 - projected.y * 0.5) * H,
      facing: normal.dot(new THREE.Vector3().subVectors(camAt, centre)) > 0,
    };
  };
  const pixels = faces.map((_, t) => reference(t));

  const rects = [
    { x0: 0, y0: 0, x1: W, y1: H },
    { x0: 0, y0: 0, x1: W / 2, y1: H / 2 },
    { x0: W / 2, y0: H / 2, x1: W, y1: H },
    { x0: W * 0.45, y0: H * 0.45, x1: W * 0.55, y1: H * 0.55 },
    { x0: W * 0.30, y0: H * 0.30, x1: W * 0.40, y1: H * 0.40 },
    { x0: W * 0.8, y0: H * 0.2, x1: W * 0.2, y1: H * 0.7 },
    { x0: W * 0.55, y0: H * 0.55, x1: W * 0.85, y1: H * 0.85 },
  ];

  let agreed = 0;
  let mismatches = 0;
  let picked = 0;
  for (const raw of rects) {
    const rect = normaliseRect({ x: raw.x0, y: raw.y0 }, { x: raw.x1, y: raw.y1 });
    const want = faces.map((_, t) => t).filter((t) => rectContains(rect, pixels[t].x, pixels[t].y) && pixels[t].facing);
    const res = facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect, camera: [0, 0, 10] });
    const got = [...res.faces].map((on, t) => (on ? t : -1)).filter((t) => t >= 0);
    picked += got.length;
    if (want.join(',') === got.join(',')) agreed += 1;
    else mismatches += 1;
    // The counts the status line quotes have to describe the same rectangle the mask does.
    if (got.length !== res.count || res.count !== res.covered - res.hidden) mismatches += 100;
  }
  check(
    'the faces a box covers are the ones three.js draws its centre inside, and they point at the camera',
    mismatches === 0 && agreed === rects.length,
    `${agreed}/${rects.length} rectangles agreed, ${picked} face hits`,
  );

  // The rule itself: the centre decides. The wide up-left triangle's centre sits well away from
  // the top-left corner, so a box over that corner — which certainly covers part of the triangle,
  // and would be taken by a "any corner inside" rule — leaves it out, while a box on its centre
  // takes it with the corners outside.
  const corner = facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect: { x0: 0, y0: 0, x1: W * 0.08, y1: H * 0.08 }, camera: [0, 0, 10] });
  const cent = pixels[0];
  const centred = facesInScreenRect({
    positions: soup,
    matrix,
    width: W,
    height: H,
    rect: { x0: cent.x - 4, y0: cent.y - 4, x1: cent.x + 4, y1: cent.y + 4 },
    camera: [0, 0, 10],
  });
  check(
    'the triangle’s centre decides: a box on a corner misses it, a box on its centre takes it',
    corner.count === 0 && centred.count === 1 && centred.faces[0] === 1,
    `corner box took ${corner.count}, a 8×8 box on the centre took ${centred.count}`,
  );
  check(
    'and turning the facing rule off takes the far side as well',
    facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect: { x0: 0, y0: 0, x1: W, y1: H }, camera: [0, 0, 10], facingOnly: false }).count === faceCount,
    `${facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect: { x0: 0, y0: 0, x1: W, y1: H }, camera: [0, 0, 10], facingOnly: false }).count} of ${faceCount} faces`,
  );

  // Three of the four face the camera; the fourth is wound the other way, so a whole-screen box
  // has to take three and report the other one as facing away.
  const whole = facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect: { x0: 0, y0: 0, x1: W, y1: H }, camera: [0, 0, 10] });
  const backFace = { x0: pixels[3].x - 6, y0: pixels[3].y - 6, x1: pixels[3].x + 6, y1: pixels[3].y + 6 };
  const onBack = facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect: backFace, camera: [0, 0, 10] });
  check(
    'a box over the back of the surface takes nothing and says how many faces pointed away',
    onBack.count === 0 && onBack.covered === 1 && onBack.hidden === 1 && whole.count === 3,
    `on the back: ${onBack.count} taken of ${onBack.covered} covered (${onBack.hidden} facing away); whole screen: ${whole.count} of ${faceCount}`,
  );

  // Behind the camera: `w` is negative, so the division would land it somewhere unrelated.
  const behindSoup = Float32Array.from([...soup, ...faces[2].flat().map((v, k) => (k % 3 === 2 ? 20 : v))]);
  const behind = facesInScreenRect({ positions: behindSoup, matrix, width: W, height: H, rect: { x0: 0, y0: 0, x1: W, y1: H }, camera: [0, 0, 10] });
  check(
    'a triangle behind the camera is dropped instead of projected onto a pixel that is not its own',
    behind.count === 3 && behind.behind === 1,
    `${behind.count} taken, ${behind.behind} behind the camera`,
  );
  const nothing = facesInScreenRect({ positions: soup, matrix, width: W, height: H, rect: { x0: 2, y0: 2, x1: 8, y1: 8 }, camera: [0, 0, 10] });
  check('a box over the background takes nothing and reports nothing covered', nothing.count === 0 && nothing.covered === 0);
}

// ---------------------------------------------------------------- the real model, one camera

const parsed = parseBinarySTL(fs.readFileSync(path.resolve(here, '../../Sprunki Mercuy.stl')));
const modelGeometry = new THREE.BufferGeometry();
modelGeometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(parsed.positions), 3));
modelGeometry.computeVertexNormals();
modelGeometry.computeBoundingBox();
const modelPositions = modelGeometry.attributes.position.array;
const modelNormals = modelGeometry.attributes.normal.array;
const FOV = 35;

// The app's own arrangement, in the app's own order: the mesh keeps the file's coordinates, the
// model group carries the up-axis rotation and then the centring offset (measured *after* the
// rotation, which is why it is computed here in two steps), and the camera frames the result from
// the home direction — exactly what `Viewer.setGeometry` + `frameModel` do.
const mesh = new THREE.Mesh(modelGeometry);
const group = new THREE.Object3D();
group.add(mesh);
group.rotation.set(-Math.PI / 2, 0, 0);
group.updateMatrixWorld(true);
group.position.copy(centreTranslation(new THREE.Box3().setFromObject(group)));
group.updateMatrixWorld(true);

const worldBox = new THREE.Box3().setFromObject(mesh);
const worldCentre = worldBox.getCenter(new THREE.Vector3());
const radius = Math.max(worldBox.getSize(new THREE.Vector3()).length() * 0.5, 1e-3);
const dist = (radius / Math.sin(((FOV * Math.PI) / 180) / 2)) * 1.08;
const dir = new THREE.Vector3(0.35, 0.55, 0.78).normalize();
const cam = new THREE.PerspectiveCamera(FOV, W / H, Math.max(dist / 2000, 0.01), dist * 40);
cam.position.copy(worldCentre).addScaledVector(dir, dist);
cam.lookAt(worldCentre);
cam.updateMatrixWorld(true);

const modelMatrix = screenMatrix(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements, mesh.matrixWorld.elements);
const camLocal = mesh.worldToLocal(cam.position.clone());
// The figure's own mid-plane, which is what "Mirror across X plane at …" is set to for a figure
// that is roughly symmetric about its own centre.
const mirrorPlaneX = modelGeometry.boundingBox.getCenter(new THREE.Vector3()).x;

const base = {
  positions: modelPositions,
  normals: modelNormals,
  matrix: modelMatrix,
  width: W,
  height: H,
  camera: [camLocal.x, camLocal.y, camLocal.z],
};

const middle = { x0: W * 0.35, y0: H * 0.3, x1: W * 0.65, y1: H * 0.7 };
const t0 = Date.now();
const selection = verticesInScreenRect({ ...base, rect: middle });
const selectMs = Date.now() - t0;

{
  // Independent pixel check: three.js projects the vertex through the same camera and the same
  // model group, and this is where the app's own matrix would show up wrong.
  const project = new THREE.Vector3();
  const sampleStep = 211;
  let sampled = 0;
  let expected = 0;
  let missed = 0;
  let outside = 0;
  const taken = new Set(selection.vertices);
  const cameraWorld = cam.position;
  for (let i = 0; i < modelPositions.length / 3; i += sampleStep) {
    const p = new THREE.Vector3(modelPositions[i * 3], modelPositions[i * 3 + 1], modelPositions[i * 3 + 2]);
    const world = p.clone().applyMatrix4(mesh.matrixWorld);
    project.copy(world).project(cam);
    const sx = (project.x * 0.5 + 0.5) * W;
    const sy = (0.5 - project.y * 0.5) * H;
    const inside = rectContains(middle, sx, sy);
    if (taken.has(i) && !inside) outside += 1;
    if (!inside) continue;
    sampled += 1;
    // Facing, taken in the mesh's own coordinates the way the selector takes it: the mesh's own
    // outward normal against the camera brought back into that space.
    const nx = modelNormals[i * 3];
    const ny = modelNormals[i * 3 + 1];
    const nz = modelNormals[i * 3 + 2];
    const toCam = [cameraWorld.x - world.x, cameraWorld.y - world.y, cameraWorld.z - world.z];
    const worldNormal = new THREE.Vector3(nx, ny, nz).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
    if (worldNormal.x * toCam[0] + worldNormal.y * toCam[1] + worldNormal.z * toCam[2] <= 0) continue;
    expected += 1;
    if (!taken.has(i)) missed += 1;
  }
  check(
    'on the real model, every sampled vertex three.js puts inside the box was taken',
    missed === 0 && expected > 50,
    `${expected} sampled front-facing vertices inside, ${missed} missed, ${sampled} sampled`,
  );
  check(
    'and nothing the selector took lies outside the rectangle three.js projects to',
    outside === 0,
    `${outside} of the ${fmt(selection.count)} taken vertices project outside the box`,
  );
  check(
    'a box over a closed figure reports how much of it faces away',
    selection.covered > selection.count && selection.hidden > 0,
    `${fmt(selection.count)} taken of ${fmt(selection.covered)} under the box (${fmt(selection.hidden)} facing away), ${selectMs} ms for ${fmt(modelPositions.length / 3)} vertices`,
  );
  check(
    'the selection is in mesh order, in range, with no duplicates',
    (() => {
      let ok = true;
      let prev = -1;
      for (const i of selection.vertices) {
        if (i <= prev || i < 0 || i * 3 >= modelPositions.length) ok = false;
        prev = i;
      }
      return ok && selection.vertices.length === selection.count;
    })(),
    `${fmt(selection.count)} indices`,
  );
  check('a rectangle dragged over a big mesh stays fast enough to feel instant', selectMs < 2500, `${selectMs} ms`);

  const mirroredReal = verticesInScreenRect({ ...base, rect: middle, mirror: { planeX: mirrorPlaneX } });
  check(
    'mirroring adds the reflection of the box on the real model too',
    mirroredReal.mirrored > 0 && mirroredReal.count > selection.count,
    `${fmt(mirroredReal.count)} taken with mirroring (${fmt(mirroredReal.mirrored)} mirrored) vs ${fmt(selection.count)} without`,
  );

  const empty = verticesInScreenRect({ ...base, rect: { x0: 2, y0: 2, x1: 6, y1: 6 } });
  check('a rectangle over the background takes nothing', empty.count === 0 && empty.covered === 0, `${empty.count} taken`);

  // The same rectangle, picking triangles instead of vertices: what the Select tool's box does on
  // the real figure. A middle box has to take a usable number of faces, leave the far side of the
  // head out, and be fast enough that releasing the mouse feels instant.
  const t1 = Date.now();
  const faceSelection = facesInScreenRect({ positions: modelPositions, matrix: modelMatrix, width: W, height: H, rect: middle, camera: [camLocal.x, camLocal.y, camLocal.z] });
  const faceMs = Date.now() - t1;
  check(
    'on the real model the same box picks triangles, leaving the far side of the head out',
    faceSelection.count > 1000 && faceSelection.count < modelPositions.length / 9 && faceSelection.hidden > 0,
    `${fmt(faceSelection.count)} faces of ${fmt(modelPositions.length / 9)} (${fmt(faceSelection.hidden)} of the ${fmt(faceSelection.covered)} under the box face away), ${faceMs} ms`,
  );
  check('and picking the triangles in a box is fast enough to keep up with a drag', faceMs < 2500, `${faceMs} ms`);
}

// ---------------------------------------------------------------- the paint it drives

{
  const layer = new MaskLayer(modelGeometry, createFeatureList());
  layer.beginStroke();
  layer.paintIndices(selection.vertices, 1);
  const recorded = layer.endStroke();

  const painted = layer.verticesOf(1);
  check(
    'the selection travels to the mask as the painted vertices, in the mask’s own order',
    layer.stats().painted === selection.count &&
      painted.length === selection.count &&
      painted.every((v, k) => v === selection.vertices[k]),
    `${fmt(painted.length)} painted of ${fmt(selection.count)} selected`,
  );
  check('a box drag is one undo step', recorded === true && layer.canUndo() === true, `history ${layer.history.length}`);

  layer.undo();
  check('undo takes the whole box back', layer.stats().painted === 0, `${fmt(layer.stats().painted)} left painted`);
  layer.redo();
  check('and redo puts it back', layer.stats().painted === selection.count, `${fmt(layer.stats().painted)} painted again`);

  layer.beginStroke();
  const released = layer.paintIndices(selection.vertices, 0);
  layer.endStroke();
  check(
    'the same box with the eraser path releases exactly what it painted',
    released === selection.count && layer.stats().painted === 0,
    `${fmt(released)} released`,
  );
}

console.log(`\n${failures === 0 ? 'all box-select checks passed' : `${failures} failure(s)`}`);
if (failures) process.exit(1);
