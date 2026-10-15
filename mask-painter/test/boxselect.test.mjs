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
import { centreTranslation } from '../js/viewer.js';
import { facesInScreenRect, screenMatrix, normaliseRect, rectContains, rectSize } from '../js/boxselect.js';
import { parseBinarySTL, fmt } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const W = 800;
const H = 600;

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
const base = {
  positions: modelPositions,
  matrix: modelMatrix,
  width: W,
  height: H,
  camera: [camLocal.x, camLocal.y, camLocal.z],
};

const middle = { x0: W * 0.35, y0: H * 0.3, x1: W * 0.65, y1: H * 0.7 };
const faceCount = modelPositions.length / 9;

{
  // Independent pixel check: three.js projects each triangle's **centre** through the same camera
  // and the same model group, and this is where the app's own matrix — or a rule that quietly
  // became "any corner inside" — would show up wrong.
  const faceCentre = (t) => {
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k += 1) {
      const i = t * 3 + k;
      c.add(new THREE.Vector3(modelPositions[i * 3], modelPositions[i * 3 + 1], modelPositions[i * 3 + 2]));
    }
    return c.multiplyScalar(1 / 3);
  };
  const faceNormal = (t) => {
    const v = [0, 1, 2].map((k) => {
      const i = t * 3 + k;
      return new THREE.Vector3(modelPositions[i * 3], modelPositions[i * 3 + 1], modelPositions[i * 3 + 2]);
    });
    return new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
  };

  const t0 = Date.now();
  const selection = facesInScreenRect({ ...base, rect: middle });
  const selectMs = Date.now() - t0;

  const project = new THREE.Vector3();
  const sampleStep = 337;
  let expected = 0;
  let missed = 0;
  let outside = 0;
  for (let t = 0; t < faceCount; t += sampleStep) {
    const centre = faceCentre(t);
    const world = centre.clone().applyMatrix4(mesh.matrixWorld);
    project.copy(world).project(cam);
    const sx = (project.x * 0.5 + 0.5) * W;
    const sy = (0.5 - project.y * 0.5) * H;
    const inside = rectContains(middle, sx, sy);
    if (selection.faces[t] && !inside) outside += 1;
    if (!inside) continue;
    // Facing from the triangle's own normal, in the mesh's own coordinates, with three.js doing
    // the arithmetic: the same rule the selector uses, computed twice.
    const worldNormal = faceNormal(t).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
    const toCam = new THREE.Vector3().subVectors(cam.position, world);
    if (worldNormal.dot(toCam) <= 0) continue;
    expected += 1;
    if (!selection.faces[t]) missed += 1;
  }
  check(
    'on the real model, every sampled face three.js draws its centre inside the box was taken',
    missed === 0 && expected > 20,
    `${expected} sampled front-facing faces inside, ${missed} missed`,
  );
  check(
    'and nothing the selector took has its centre outside the rectangle three.js projects to',
    outside === 0,
    `${outside} of the ${fmt(selection.count)} taken faces project outside the box`,
  );
  check(
    'a box over a closed figure reports how much of it faces away',
    selection.covered > selection.count && selection.hidden > 0 && selection.count > 100,
    `${fmt(selection.count)} taken of ${fmt(selection.covered)} under the box (${fmt(selection.hidden)} facing away), ${selectMs} ms for ${fmt(faceCount)} faces`,
  );
  check(
    'the face mask is one flag per triangle, and the counts describe the same rectangle',
    selection.faces.length === faceCount &&
      (() => {
        let n = 0;
        for (const on of selection.faces) if (on) n += 1;
        return n === selection.count;
      })() &&
      selection.count === selection.covered - selection.hidden,
    `${fmt(selection.count)} flags set of ${fmt(faceCount)}`,
  );
  check('a rectangle dragged over a big mesh stays fast enough to feel instant', selectMs < 2500, `${selectMs} ms`);

  const empty = facesInScreenRect({ ...base, rect: { x0: 2, y0: 2, x1: 6, y1: 6 } });
  check('a rectangle over the background takes nothing', empty.count === 0 && empty.covered === 0, `${empty.count} taken`);
}

console.log(`\n${failures ? `${failures} failure(s)` : "all box-select checks passed"}`);
process.exit(failures ? 1 : 0);
