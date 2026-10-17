import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { screenMatrix, facesInScreenRect } from './boxselect.js';

const BACKGROUND = 0x10141a;

// Axis conversions applied to the loaded model so it stands up in three.js' Y-up world.
const UP_ROTATIONS = {
  y: [0, 0, 0],
  z: [-Math.PI / 2, 0, 0],
  x: [0, 0, Math.PI / 2],
};

/**
 * The triangle of the file's own mesh that a raycast hit belongs to.
 *
 * three-mesh-bvh gives a mesh that has no index buffer one of its own, and orders the
 * triangles in BVH order, so a hit's own `faceIndex` counts in that order — while the mask,
 * the welded topology, the panel segmentation (`parts.facePart`) and the exported mask JSON
 * all follow the file order of the clone the mask was built from, taken before the BVH
 * existed. Every index stays in range either way, so nothing throws: a consumer of the raw
 * index just reads the wrong triangle. That is what made the Part tool paint a panel from
 * somewhere else in the model — "it never selects what I click on" — at every seam angle.
 *
 * `hit.face.a` is the first corner of the hit triangle in the original mesh (the BVH's own
 * index buffer maps BVH triangle -> file vertex), so `a / 3` is the triangle index in file
 * order — the one everything else in this app means by "face". An STL soup always starts a
 * triangle on a multiple of 3; if it does not (an indexed source, which this app never
 * loads), the mesh order already is the file order and the raw index is left alone.
 */
export function sourceTriangleIndex(hit, soupSource = true) {
  if (!hit) return null;
  const a = hit.face ? hit.face.a : null;
  if (soupSource && Number.isInteger(a) && a >= 0 && a % 3 === 0) return a / 3;
  return hit.faceIndex;
}

/**
 * The translation that puts a model's footprint centre over the grid's centre lines and its
 * lowest point on the grid's plane.
 *
 * An STL carries whatever coordinates its exporter used: a mesh authored in a CAD assembly
 * arrives hundreds of units from the origin the grid is drawn around, so it hangs in space
 * beside the grid with nothing on screen to move it back. The grid is sized from the model and
 * centred on the origin, so this is the offset that makes the two agree.
 *
 * Kept as a pure function of the box so it can be checked without a renderer (the offset is in
 * world space, i.e. measured after any up-axis rotation).
 */
export function centreTranslation(box) {
  const centre = box.getCenter(new THREE.Vector3());
  return new THREE.Vector3(-centre.x, -box.min.y, -centre.z);
}

/**
 * Where the ground grid goes: on the model's own lowest point, under its own footprint.
 *
 * The grid is the print bed, so its plane has to be the plane the model stands on. Two ways to
 * get that wrong, both of which leave the model visibly hanging in the air:
 *
 *   • dropping the grid a fixed fraction of the model's height *below* the model's lowest point
 *     (2% of a 100 mm figure is a 2 mm gap under its feet), and
 *   • leaving the grid at the world origin while the model is somewhere else. With centring off,
 *     an STL authored in a CAD assembly is hundreds of units from the origin — the grid then sits
 *     beside the model rather than under it, which reads as "the model is off the bed" even though
 *     the model never moved.
 *
 * The grid therefore follows the model: centred on its footprint, at the height of its lowest
 * point, in both centring modes. A pure function of the box so it can be checked without a
 * renderer.
 */
export function gridPlacement(box) {
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return {
    x: centre.x,
    y: box.min.y,
    z: centre.z,
    span: Math.max(size.x, size.z, 1e-3) * 3.5,
  };
}

/**
 * Owns the WebGL scene: model + mask overlay, lights, orbit controls, brush cursor,
 * and the accelerated raycast used by every painting tool.
 */
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    this.camera.position.set(0, 60, 220);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = 0.9;
    this.setPointerMode('select');

    this.scene.add(new THREE.HemisphereLight(0xdce7ff, 0x2b3138, 0.9));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(0.6, 1.2, 0.9);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.7);
    rim.position.set(-0.9, 0.3, -0.7);
    this.scene.add(rim);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this.grid = null;
    this.baseMesh = null;
    this.overlayMesh = null;
    this.overlayGeometry = null;
    this.boundingBox = null;
    this.upAxis = 'z';
    this.fitDistance = 200;
    this.soupSource = true;
    this.centred = true;
    this.centreOffset = new THREE.Vector3();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.ndc = new THREE.Vector2();

    this._buildCursor();

    this._onResize = this._onResize.bind(this);
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(canvas.parentElement || canvas);
    this._onResize();

    this._fps = { frames: 0, last: performance.now(), value: 0 };
    this.renderer.setAnimationLoop(() => this._renderFrame());
  }

  _renderFrame() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const f = this._fps;
    f.frames += 1;
    const now = performance.now();
    if (now - f.last >= 500) {
      f.value = Math.round((f.frames * 1000) / (now - f.last));
      f.frames = 0;
      f.last = now;
      if (this.onFps) this.onFps(f.value);
    }
  }

  get fps() {
    return this._fps.value;
  }

  _onResize() {
    const parent = this.canvas.parentElement || this.canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- cursor

  _buildCursor() {
    this.cursor = new THREE.Group();
    this.cursor.visible = false;
    this.cursor.renderOrder = 999;

    this.cursorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.0, 72),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    this.cursorRing.renderOrder = 999;
    this.cursorDot = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false }),
    );
    this.cursorDot.renderOrder = 1000;
    this.cursor.add(this.cursorRing);
    this.cursor.add(this.cursorDot);
    this.cursor.raycast = () => {};
    this.cursorRing.raycast = () => {};
    this.cursorDot.raycast = () => {};
    this.scene.add(this.cursor);

    this.cursorZ = new THREE.Vector3(0, 0, 1);
  }

  setCursor({ point, normal, radius, color }) {
    if (!point) {
      this.cursor.visible = false;
      return;
    }
    const n = normal ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const offset = Math.max(radius * 0.02, this.fitDistance * 0.0006);
    this.cursor.position.copy(point).addScaledVector(n, offset);
    this.cursor.quaternion.setFromUnitVectors(this.cursorZ, n);
    const r = Math.max(radius, 1e-4);
    this.cursorRing.scale.set(r, r, r);
    this.cursorDot.scale.set(r * 0.06, r * 0.06, r * 0.06);
    if (color !== undefined) this.cursorRing.material.color.set(color);
    this.cursor.visible = true;
  }

  hideCursor() {
    this.cursor.visible = false;
  }

  // ------------------------------------------------------------- model

  /**
   * Installs a model. `geometry` is the STL geometry; the returned overlay geometry is a
   * clone that carries the mask's vertex colours.
   */
  setGeometry(geometry, { upAxis = 'z', overlayGeometry = null, centre = null } = {}) {
    this.disposeModel();
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (typeof centre === 'boolean') this.centred = centre;

    // Read the mesh's order before the BVH below installs an index buffer of its own; the
    // hit's triangle has to be translated back to it (see sourceTriangleIndex).
    this.soupSource = !geometry.index;
    this.baseGeometry = geometry;
    this.overlayGeometry = overlayGeometry || geometry.clone();
    this.upAxis = upAxis;

    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0x9aa4b2,
      roughness: 0.82,
      metalness: 0.02,
      flatShading: false,
    });
    this.baseMesh = new THREE.Mesh(geometry, baseMaterial);
    this.baseMesh.raycast = acceleratedRaycast;

    const overlayMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      roughness: 0.9,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.overlayMesh = new THREE.Mesh(this.overlayGeometry, overlayMaterial);
    this.overlayMesh.raycast = () => {};

    this.modelGroup.add(this.baseMesh);
    this.modelGroup.add(this.overlayMesh);
    this.applyUpAxis(upAxis);
    // Where the model sits is decided here, after the rotation, because the offset is measured
    // in world space — the space the grid lives in.
    this._applyCentre();

    // Picking acceleration: built once, reused by every tool call.
    const t0 = performance.now();
    geometry.boundsTree = new MeshBVH(geometry);
    this.bvhBuildMs = Math.round(performance.now() - t0);

    this.boundingBox = new THREE.Box3().setFromObject(this.modelGroup);
    this._buildGrid();
    this.frameModel();
    return this.overlayGeometry;
  }

  applyUpAxis(axis) {
    this.upAxis = axis in UP_ROTATIONS ? axis : 'z';
    const [rx, ry, rz] = UP_ROTATIONS[this.upAxis];
    this.modelGroup.rotation.set(rx, ry, rz);
    this.modelGroup.updateMatrixWorld(true);
  }

  setUpAxis(axis) {
    this.applyUpAxis(axis);
    // Turning the model changes which way its footprint and its lowest point face, so the
    // centring offset is re-measured rather than reused.
    this._applyCentre();
    this.boundingBox = new THREE.Box3().setFromObject(this.modelGroup);
    this._buildGrid();
    this.frameModel();
  }

  /**
   * Centres the model on the grid, or puts it back at the coordinates it was loaded with.
   *
   * This moves the model group — the same place the up-axis rotation lives — and never the
   * geometry: the mask is per vertex, the panels are per face and every export is written in the
   * file's own coordinates, so the mesh itself must not move under them. The grid follows the
   * model's own bounding box, so with centring on the model stands on the grid's centre, and with
   * it off you get the file's coordinates back, unchanged.
   *
   * Returns `{ centred, offset }`, the translation applied in world units, for the status bar.
   */
  setCentreOnGrid(on = true) {
    this.centred = !!on;
    this._applyCentre();
    this.boundingBox = new THREE.Box3().setFromObject(this.modelGroup);
    this._buildGrid();
    this.frameModel();
    return { centred: this.centred, offset: this.centreOffset.toArray() };
  }

  _applyCentre() {
    const group = this.modelGroup;
    group.position.set(0, 0, 0);
    group.updateMatrixWorld(true);
    this.centreOffset.set(0, 0, 0);
    if (!this.baseMesh || !this.centred) return;
    const offset = centreTranslation(new THREE.Box3().setFromObject(group));
    group.position.copy(offset);
    group.updateMatrixWorld(true);
    this.centreOffset.copy(offset);
  }

  _buildGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose?.();
      this.grid = null;
    }
    if (!this.boundingBox) return;
    const { x, y, z, span } = gridPlacement(this.boundingBox);
    this.grid = new THREE.GridHelper(span, 40, 0x33404f, 0x232a33);
    this.grid.position.set(x, y, z);
    this.scene.add(this.grid);
    // The plate the model stands on, in world units: the grid is drawn on it, so a caller can
    // say where the bed ended up (and how far the model's lowest point is above it).
    this.bedY = y;
  }

  frameModel() {
    if (!this.boundingBox) return;
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-3);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.08;
    const dir = new THREE.Vector3(0.35, 0.55, 0.78).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 2000, 0.01);
    this.camera.far = dist * 40;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.fitDistance = dist;
    this.viewCenter = center;
    this.viewRadius = radius;
  }

  /** Named viewpoints for quick navigation around the model. */
  setView(name) {
    if (!this.boundingBox) return;
    const center = this.viewCenter || this.boundingBox.getCenter(new THREE.Vector3());
    const dist = this.fitDistance || 200;
    const dirs = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 1, 0.001],
      home: [0.35, 0.55, 0.78],
    };
    const dir = new THREE.Vector3(...(dirs[name] || dirs.home)).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
  }

  setPointerMode(mode) {
    this.pointerMode = mode;
    if (mode === 'select') {
      // Left button selects; right orbit, middle pan, wheel zoom. On touch, one finger selects
      // and two fingers pan/zoom so the gestures never fight the selection.
      this.controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE,
      };
      this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      };
      this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  // ------------------------------------------------------------- picking

  /**
   * Raycasts the model. Returns world + model-local hits, or null. `faceIndex` is the hit
   * triangle in the loaded file's own face order (see `sourceTriangleIndex`) — the order the
   * mask, the welded topology and the panel segmentation are all built in.
   */
  pick(clientX, clientY) {
    if (!this.baseMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    // Raycasting needs current world matrices. The render loop usually refreshes them,
    // but a raycast in the same task as a camera change (or while frames are throttled)
    // would otherwise use a stale camera and miss the model.
    this.camera.updateMatrixWorld();
    this.baseMesh.updateWorldMatrix(true, false);
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.baseMesh, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const worldPoint = hit.point.clone();
    const localPoint = this.baseMesh.worldToLocal(worldPoint.clone());
    const localNormal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(this.baseMesh.matrixWorld);
    const worldNormal = localNormal.clone().applyMatrix3(normalMatrix).normalize();
    return { worldPoint, localPoint, worldNormal, localNormal, faceIndex: sourceTriangleIndex(hit, this.soupSource) };
  }

  /**
   * The triangles of the loaded model that a screen rectangle covers.
   *
   * The rectangle arrives in canvas pixels — the corners a drag collected, `clientX/Y` minus the
   * canvas bounding rect — and this is what a rubber band in the Select tool means. The matrix is
   * the whole inverse transform in one: model → world (the up-axis rotation and the centring offset
   * live on the model group, which is why the mesh itself never moves) → camera → clip, and
   * `boxselect.js` divides by `w`. The camera position is taken in the mesh's own coordinates so
   * the facing test needs no normal matrix. The answer is a `0/1` mask over faces in the mask's own
   * face order, so the caller can select the faces, or map them to the models they belong to,
   * without translating indices.
   */
  facesInScreenRect(rect, { facingOnly = true } = {}) {
    const empty = { faces: new Uint8Array(0), count: 0, covered: 0, hidden: 0, behind: 0 };
    if (!this.baseMesh || !this.baseGeometry) return empty;
    this.camera.updateMatrixWorld();
    this.baseMesh.updateWorldMatrix(true, false);
    const matrix = screenMatrix(
      this.camera.projectionMatrix.elements,
      this.camera.matrixWorldInverse.elements,
      this.baseMesh.matrixWorld.elements,
    );
    const cam = this.baseMesh.worldToLocal(this.camera.position.clone());
    return facesInScreenRect({
      positions: this.baseGeometry.attributes.position.array,
      matrix,
      width: this.canvas.clientWidth || 1,
      height: this.canvas.clientHeight || 1,
      rect,
      camera: [cam.x, cam.y, cam.z],
      facingOnly,
    });
  }

  // ------------------------------------------------------------- display

  setOverlayOpacity(v) {
    if (this.overlayMesh) this.overlayMesh.material.opacity = v;
  }

  /** The colour the unpainted model is drawn in — a preference, not a constant. */
  setBaseColor(hex) {
    if (this.baseMesh) this.baseMesh.material.color.set(hex);
  }

  setBaseVisible(v) {
    if (this.baseMesh) this.baseMesh.visible = v;
  }

  setOverlayVisible(v) {
    if (this.overlayMesh) this.overlayMesh.visible = v;
  }

  setWireframe(v) {
    if (this.baseMesh) this.baseMesh.material.wireframe = v;
  }

  setGridVisible(v) {
    if (this.grid) this.grid.visible = v;
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  disposeModel() {
    if (this.baseMesh) {
      this.modelGroup.remove(this.baseMesh);
      this.baseGeometry?.dispose();
      this.baseMesh.material.dispose();
      this.baseMesh = null;
    }
    if (this.overlayMesh) {
      this.modelGroup.remove(this.overlayMesh);
      this.overlayGeometry?.dispose();
      this.overlayMesh.material.dispose();
      this.overlayMesh = null;
      this.overlayGeometry = null;
    }
    this.hideCursor();
  }
}
