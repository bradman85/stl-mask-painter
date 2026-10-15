import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { Viewer } from './viewer.js';
import { SelectionTint } from './mask.js';
import * as io from './io.js';
import { buildTopology, buildStencil, validateSolid, stencilDefaultsForDiagonal } from './stencil.js';
import { buildParts, partSoupVertices, partsNearPoint, DEFAULT_SEAM_ANGLE } from './parts.js';
import { paintedIslands, planIslandTrim, maskWindows } from './cleanup.js';
import { normaliseRect, rectSize } from './boxselect.js';
import { shellsOf, shellSize, countFaces, filterSoup } from './select.js';
import {
  createSelection,
  countSelected,
  countChanges,
  applyFaces,
  setAll,
  invertSelection,
  paintedFromFaces,
  facesFromVertices,
  facesFromPainted,
  remapSelection,
  SelectionHistory,
  SELECTION_COLOR,
  SELECTION_ID,
} from './selection.js';
import { drawHighlight, clearHighlight, HIGHLIGHT_FACE_LIMIT } from './highlight.js';

// The example model that ships next to this app (repo root).
const DEFAULT_MODEL_URL = new URL('../Sprunki Mercuy.stl', location.href).href;

const el = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * There are two tools, and they are both ways of selecting: panels cut by seams, and single
 * triangles. Everything else this app used to have in the tool row — a brush, a region fill, a
 * rectangle that painted, an eraser and an eyedropper — existed to paint the model in colours,
 * which turned out to be a second, harder way of saying "these triangles".
 */
const TOOL_NAMES = { part: 'Part', select: 'Select' };

const state = {
  tool: 'select',
  seamAngle: DEFAULT_SEAM_ANGLE,
  navigate: false,
  upAxis: 'y',
};

const canvas = el('canvas');
const viewer = new Viewer(canvas);
viewer.onFps = (fps) => {
  el('statusFps').textContent = `${fps} fps`;
};

/**
 * The selection, drawn on the model.
 *
 * It is called the mask because that is what it becomes: the window of the shell the stencil build
 * wraps. It holds no state of its own — every corner flag in it comes from `cleanup.selection`
 * (`syncTint` is the one place that writes it), so "the stencil is built from the selection" is a
 * fact about the data rather than a habit two pieces of code have to keep in step.
 */
let mask = null;
let modelName = '';
let selectDrag = null;
// The selection's undo history: snapshots of the face array, one per edit.
const history = new SelectionHistory({ limit: 40 });
// Drawn before the first model is loaded, so the scratch array is not reallocated per edit.
let tintScratch = null;
// How far the pointer has to travel before a click becomes a drag. A click wobbles a pixel or two,
// and a two-pixel box would pick nothing and read as a tool that had stopped working.
const DRAG_SLOP = 3;

// The paint stencil: an optional solid built from the painted mask. The welded topology is
// expensive on a big model, so it is cached per loaded model and reused across rebuilds.
const stencil = {
  topology: null,
  topologyFor: '',
  result: null,
  mesh: null,
  buildMs: 0,
};

// Seam-based parts, cached per model and seam angle. The segmentation pass takes a few
// hundred milliseconds on the example model, so it is only recomputed when one of those
// actually changes.
const parts = {
  data: null,
  key: '',
  seams: null,
  seamsKey: '',
  building: false,
};

// The model cleanup: the separate models (shells) inside one file, and the faces picked out of
// the model in hand. `soup` is the file exactly as it was loaded, so every removal is a view of
// it rather than an edit that cannot be undone — `removed` marks the faces taken out, and the
// geometry in hand is derived from the two.
const cleanup = {
  soup: null,
  removed: null,
  // The selection: `{ faceCount, faces }`, the one thing every tool writes and the stencil reads.
  selection: null,
  liveFace: null,
  shells: null,
  shellsKey: '',
  shellsPending: false,
  hover: null,
  hoverKey: '',
  scope: 'faces',
  build: 0,
  armedAt: 0,
  /**
   * The selected faces as a plain `0/1` array.
   *
   * A getter rather than a second field: the array is the selection's own storage, and a copy
   * kept alongside it is a copy that can drift.
   */
  get selected() {
    return this.selection ? this.selection.faces : null;
  },
};

// The named seam-angle cuts the preset row offers. The angles are the measured sweet spots on
// the bundled figure (the table is in help.html#paint-parts) and the labels are what the guide
// documents; test/help.test.mjs fails if those three lists — here, the markup and the guide —
// stop agreeing. The default (DEFAULT_SEAM_ANGLE, "Portrait") is the coarsest cut at which the
// small facial panels stay clickable panels of their own.
const SEAM_PRESETS = [
  { angle: 5, label: 'Face details' },
  { angle: 8, label: 'Portrait' },
  { angle: 12, label: 'Body parts' },
  { angle: 25, label: 'Broad shapes' },
];
const presetFor = (angle) => SEAM_PRESETS.find((p) => p.angle === angle) || null;

/** The next finer preset than `angle` — the "cut finer" suggestion after a big-panel click. */
function finerPreset(angle) {
  let best = null;
  for (const p of SEAM_PRESETS) if (p.angle < angle && (!best || p.angle > best.angle)) best = p;
  return best;
}

// Handle for console debugging / scripted checks.
window.maskPainter = {
  state,
  viewer,
  io,
  get mask() {
    return mask;
  },
  loadFromURL,
  loadFromBuffer,
  exportMaskJSON,
  exportPLY,
  importMaskFile,
  buildStencilPart,
  exportStencilSTL,
  ensureParts,
  currentParts: () => parts.data,
  selectPartAt,
  setSeamAngle,
  selectAllFaces,
  selectNoFaces,
  invertPickedFaces,
  removeSelectedFaces: removeClicked,
  restoreRemovedFaces,
  setSelectScope,
  ensureShells,
  get cleanup() {
    return cleanup;
  },
  get history() {
    return history;
  },
  selectIo: {
    shellsOf,
    filterSoup,
    countFaces,
    createSelection,
    countSelected,
    applyFaces,
    paintedFromFaces,
    facesFromVertices,
    facesFromPainted,
    remapSelection,
  },
  trimWindows,
  listWindows,
  releaseWindows,
  setCentreOnGrid: (on) => viewer.setCentreOnGrid(on),
  islandIo: { paintedIslands, planIslandTrim, maskWindows },
  openGuide,
  stencilOutOfDate,
  rebuildStencil,
  partsIo: { buildParts, partSoupVertices },
  stencilIo: { buildTopology, buildStencil, validateSolid },
  get stencil() {
    return stencil;
  },
  /** What a click in the viewport selects, for scripted checks. */
  selectAt(x, y, opts = {}) {
    return selectClickAt({ x, y }, opts);
  },
};

// ---------------------------------------------------------------- helpers

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function setStatus(msg) {
  el('statusMsg').textContent = msg;
}

/** The on-screen guide: one section per panel, plus the file formats. */
function openGuide(hash = '') {
  const url = new URL('help.html', location.href);
  if (hash) url.hash = hash;
  window.open(url.href, '_blank', 'noopener');
}

function setLoading(show, text) {
  el('loading').hidden = !show;
  if (text) el('loadingText').textContent = text;
}

// Pointer capture throws for pointer ids the browser never activated (synthetic events),
// which must not abort a stroke.
function capturePointer(id) {
  try {
    canvas.setPointerCapture(id);
  } catch {
    /* ignore */
  }
}

function releasePointer(id) {
  try {
    canvas.releasePointerCapture(id);
  } catch {
    /* ignore */
  }
}

/** What the HUD calls the tool in hand — the two scopes of Select pick different things. */
function toolLabel(tool = state.tool, scope = cleanup.scope) {
  if (tool === 'part') return TOOL_NAMES.part;
  return scope === 'models' ? 'Select models' : 'Select faces';
}

// ------------------------------------------------------------ model load

async function loadFromURL(url) {
  setLoading(true, 'Downloading model…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const name = decodeURIComponent(url.split('/').pop() || 'model.stl');
    await loadFromBuffer(buffer, name);
  } catch (err) {
    setLoading(false);
    setStatus(`Could not load ${url} (${err.message}). Use “Open STL…” or drop a file.`);
  }
}

async function loadFromBuffer(buffer, name) {
  const t0 = performance.now();
  setLoading(true, 'Parsing STL…');
  await nextFrame();

  let geometry;
  try {
    geometry = new STLLoader().parse(buffer);
  } catch (err) {
    setLoading(false);
    setStatus(`Could not parse ${name}: ${err.message}`);
    return;
  }
  // STL normals come from the file and are often wrong; recompute so shading and the
  // region-fill angle test both work off real geometry.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  // The file itself, kept so the Select tool can take models (and single faces) out of it and
  // put them back.
  captureSoup(geometry);

  setLoading(true, 'Preparing mask layer…');
  await nextFrame();

  const overlayGeometry = geometry.clone();
  mask = new SelectionTint(overlayGeometry);
  overlayGeometry.setAttribute('color', new THREE.BufferAttribute(mask.colors, 4));
  tintScratch = null;
  resetSelection();

  const triangles = geometry.attributes.position.count / 3;
  setLoading(true, `Building pick acceleration for ${fmt(triangles)} triangles…`);
  await nextFrame();

  const tBvh = performance.now();
  viewer.setGeometry(geometry, {
    upAxis: state.upAxis,
    overlayGeometry,
    centre: el('centreOnGrid').checked,
  });
  viewer.setGridVisible(el('showGrid').checked);
  const bvhMs = Math.round(performance.now() - tBvh);

  modelName = name;
  resetStencil();

  const size = geometry.boundingBox.getSize(new THREE.Vector3());

  el('seamAngleVal').textContent = `${state.seamAngle}°`;
  applyDisplayState();
  updateStats();
  updateHud();

  el('modelName').textContent =
    `${name} — ${fmt(triangles)} triangles · ${fmt(geometry.attributes.position.count)} vertices · ` +
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} units`;
  setLoading(false);  setStatus(
    `Loaded ${name} in ${Math.round(performance.now() - t0)} ms (pick acceleration ${bvhMs} ms); ` +
      `${centreNote()}, and the bed is under its lowest point (${viewer.bedY.toFixed(2)}). ` +
      'Click a panel with Part (P) to take the whole of it, or drag a box in Select faces ' +
      '(Shift+S); “Build stencil” turns the selection into the shell.',
  );
}

/**
 * Where the model ended up, in words, for the status bar.
 *
 * An STL keeps its exporter's coordinates, and the grid is drawn around the origin, so a file
 * authored in a CAD assembly arrives off the grid with no way to move it — the complaint this
 * answers. The wording says what actually happened: moved, already there, or centring off.
 */
function centreNote() {
  if (!viewer.centred) return 'centring is off, so it sits where the file puts it';
  const [dx, dy, dz] = viewer.centreOffset.toArray();
  return Math.hypot(dx, dy, dz) < 1e-3
    ? 'it is already centred on the grid'
    : `it was moved ${dx.toFixed(1)}, ${dy.toFixed(1)}, ${dz.toFixed(1)} units to stand on the grid centre`;
}

/**
 * Centring is a property of the view, like the up axis: it moves the model group, never the
 * geometry, so the mask, the panels and every export keep the file's own coordinates and the
 * toggle can be turned off again at any time.
 */
function onCentreToggle(e) {
  if (!viewer.baseMesh) return;
  const { centred } = viewer.setCentreOnGrid(e.target.checked);
  setStatus(
    centred
      ? `Centred on the grid — ${centreNote()}. The mask and every export keep the file's own coordinates.`
      : "Centring off — the model is back at the coordinates the file gives it, and the grid follows its own centre.",
  );
}

// --------------------------------------------------------------- selecting

/**
 * A press in the viewport. Both tools select; neither paints.
 *
 * Select starts a drag that is decided on release — a click picks the one thing under the cursor,
 * a drag picks what the rectangle covers — and Part acts on the press itself, because the panel it
 * selects is the one the cursor is over.
 */
function onPointerDown(e) {
  if (!mask) return;
  if (e.button !== 0 || state.navigate) return;
  if (state.tool === 'part') {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    void partClick(e);
    return;
  }
  startSelectDrag(e);
}

function onPointerMove(e) {
  if (!mask) return;
  if (selectDrag) {
    moveSelectDrag(e);
    return;
  }
  const hit = viewer.pick(e.clientX, e.clientY);
  // The face under the cursor is outlined before the click, so "the face under the cursor" is
  // something you can see rather than something you have to believe — and it is outlined whichever
  // selection tool is in hand, because both of them are aiming at a face.
  updateHoverFace(hit ? hit.faceIndex : null);
  el('statusCursor').textContent = hit
    ? state.tool === 'part'
      ? `face ${fmt(hit.faceIndex)} — click to select the panel it belongs to`
      : `face ${fmt(hit.faceIndex)}`
    : '';
}

function cursorText(p) {
  if (!p) return '';
  return `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`;
}

function endStroke() {
  if (selectDrag) finishSelectDrag();
}

// ------------------------------------------------- the rectangle a selection drag draws

/**
 * The rectangle a drag is drawing, in the pixels the viewer's selection is measured in.
 *
 * The app's own coordinates everywhere else are the file's, and they are not what a rubber band
 * is drawn in: the drag is in pixels, canvas-relative (`clientX/Y` minus the canvas rect), and the
 * inverse transform — `viewer.facesInScreenRect` — is what turns those pixels back into the faces
 * underneath them.
 */
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function showBoxRect(from, to) {
  const node = el('boxSelect');
  const r = normaliseRect(from, to);
  const canvasRect = canvas.getBoundingClientRect();
  const viewRect = el('viewport').getBoundingClientRect();
  node.hidden = false;
  node.style.left = `${canvasRect.left - viewRect.left + r.x0}px`;
  node.style.top = `${canvasRect.top - viewRect.top + r.y0}px`;
  node.style.width = `${r.x1 - r.x0}px`;
  node.style.height = `${r.y1 - r.y0}px`;
}

function hideBoxRect() {
  const node = el('boxSelect');
  if (node) node.hidden = true;
}

// ------------------------------------------------------ select (click, and a rubber band)

/**
 * A press in the Select tool. Nothing is picked yet: this only starts the gesture.
 *
 * A **click** picks the one thing under the cursor — the face, or the model, the current scope
 * selects — and a **drag** draws a rectangle and picks everything inside it when the button comes
 * up. The rectangle used to be a tool of its own — the **Box select** button — because back then
 * "select" meant paint and the box did not paint. With one selection there is nothing for a second
 * button to mean: picking a rectangle is a gesture of the Select tool, so it lives here.
 */
function startSelectDrag(e) {
  e.preventDefault();
  capturePointer(e.pointerId);
  const p = canvasPoint(e);
  selectDrag = {
    pointerId: e.pointerId,
    from: p,
    to: p,
    fromClient: { x: e.clientX, y: e.clientY },
    toClient: { x: e.clientX, y: e.clientY },
    // Shift adds to the pick, Alt/Ctrl takes what the box covers off it, and a plain drag makes
    // the pick exactly what the box covers.
    add: e.shiftKey,
    remove: e.altKey || e.ctrlKey || e.metaKey,
    active: false,
  };
  viewer.hideCursor();
  el('statusCursor').textContent = '';
}

function moveSelectDrag(e) {
  const p = canvasPoint(e);
  selectDrag.to = p;
  selectDrag.toClient = { x: e.clientX, y: e.clientY };
  const rect = normaliseRect(selectDrag.from, p);
  const { width, height } = rectSize(rect);
  if (!selectDrag.active) {
    if (width < DRAG_SLOP && height < DRAG_SLOP) return;
    selectDrag.active = true;
    showBoxRect(selectDrag.from, p);
    setStatus(
      `Select: drag the rectangle over what to ${selectDrag.remove ? 'unpick' : 'pick'}, then ` +
        'release — only the faces of the surface facing you are taken (Esc cancels).',
    );
  } else {
    showBoxRect(selectDrag.from, p);
  }
  el('statusCursor').textContent = `${Math.round(width)} × ${Math.round(height)} px`;
}

function cancelSelectDrag() {
  const drag = selectDrag;
  if (!drag) return;
  selectDrag = null;
  releasePointer(drag.pointerId);
  hideBoxRect();
  viewer.hideCursor();
  if (drag.active) {
    setStatus('Select: the rectangle was cancelled — the pick is unchanged.');
  }
}

/**
 * Applies one rectangle's worth of faces to the pick.
 *
 * A plain drag *replaces* the pick rather than toggling each face it covers: toggling forty
 * thousand triangles one at a time is not a selection anybody can reason about, and "the box is
 * the selection now" is what a rubber band means elsewhere. Shift adds and Alt takes off, which
 * is the same pair of modifiers a click uses.
 */
function applyPickToSelection(wanted, opts = {}) {
  if (!cleanup.selection) return 0;
  // Nothing to change means nothing to undo: a click that selects what is already selected must
  // not put an entry in the history.
  if (!countChanges(cleanup.selection, wanted, opts)) return 0;
  history.remember(cleanup.selection);
  return applyFaces(cleanup.selection, wanted, opts);
}

/**
 * The rectangle that was just released, applied in the scope in hand.
 *
 * The counts are the honest part of selecting in screen space, exactly as they are for the
 * rectangle paint: how many faces were under the rectangle at all, how many of those pointed away
 * and were left alone, and how many had no usable pixel. Without them a box that took the back of
 * the head as well, or nothing at all, is indistinguishable from a box that worked.
 */
function finishSelectDrag() {
  const drag = selectDrag;
  selectDrag = null;
  releasePointer(drag.pointerId);
  hideBoxRect();
  viewer.hideCursor();
  if (!mask) return;

  // No drag: the click this tool has always had, with the same modifiers.
  if (!drag.active) {
    void selectClickAt(drag.toClient, drag);
    return;
  }

  const sel = viewer.facesInScreenRect(normaliseRect(drag.from, drag.to));
  if (!sel.count) {
    setStatus(
      sel.covered
        ? `Select: all ${fmt(sel.covered)} faces in the rectangle point away from you — nothing ` +
            `picked (${fmt(selectedFaces())} still picked).`
        : 'Select: nothing under the rectangle — drag it over the model.',
    );
    return;
  }

  if (cleanup.scope === 'models') {
    void pickModelsInRect(sel, drag);
    return;
  }
  const changed = applyPickToSelection(sel.faces, drag);
  afterSelection(changed);
  setStatus(
    `Select: ${fmt(sel.count)} face${sel.count === 1 ? '' : 's'} in the rectangle — ` +
      `${drag.remove ? `${fmt(changed)} taken off the pick` : drag.add ? `${fmt(changed)} added to the pick` : 'the pick is now exactly those'} · ` +
      `${fmt(selectedFaces())} selected in all` +
      (sel.hidden ? ` (${fmt(sel.hidden)} of the ${fmt(sel.covered)} under it face away and were left alone)` : '') +
      '. “Build stencil” turns the selection into the shell; “Remove selected” takes it out of the model.',
  );
}

/** The same rectangle in the models scope: the whole model of every face the box covered. */
async function pickModelsInRect(sel, drag) {
  const shells = await ensureShells();
  if (!shells) return;
  const touched = new Set();
  for (let t = 0; t < sel.faces.length && t < shells.faceCount; t += 1) {
    if (sel.faces[t]) touched.add(shells.faceShell[t]);
  }
  if (!touched.size) {
    setStatus('Select: nothing under the rectangle — drag it over a model.');
    return;
  }
  const wanted = new Uint8Array(shells.faceCount);
  for (let t = 0; t < shells.faceCount; t += 1) if (touched.has(shells.faceShell[t])) wanted[t] = 1;
  const changed = applyPickToSelection(wanted, drag);
  afterSelection(changed);
  const names = [...touched].sort((a, b) => a - b).map((s) => `Model ${s + 1}`).join(', ');
  setStatus(
    `Select: the rectangle covers ${names} — ${fmt(countFaces(wanted))} faces` +
      (drag.remove ? `, ${fmt(changed)} taken off the pick` : drag.add ? `, ${fmt(changed)} added to the pick` : ' picked') +
      ` · ${fmt(selectedFaces())} picked in all.`,
  );
}

// ------------------------------------------------------------------- UI

/**
 * The one stats line, and the two buttons whose state hangs off the selection.
 *
 * It reports the selection twice over on purpose: **faces** is what the user selected and what the
 * panel counts, and **corners in the window** is what the stencil build consumes, so the two
 * numbers the app is reasoning about are both on screen.
 */
function updateStats() {
  const node = el('selectionStats');
  if (node) {
    if (!mask || !cleanup.selection) {
      node.textContent = 'Load a model to see how much of it is selected.';
    } else {
      const faces = cleanup.selection.faces.length;
      const picked = selectedFaces();
      const corners = mask.stats().painted;
      const removed = removedFaces();
      node.textContent =
        `${fmt(picked)} of ${fmt(faces)} faces selected (${((picked / Math.max(1, faces)) * 100).toFixed(1)}%) · ` +
        `${fmt(corners)} of ${fmt(mask.vertexCount)} corners inside the window` +
        (picked > HIGHLIGHT_FACE_LIMIT ? ' · too many to tint in the viewport, so the tint is off' : '') +
        (removed ? ` · ${fmt(removed)} faces removed (Restore puts them back)` : '');
    }
  }
  const removeBtn = el('removeFacesBtn');
  if (removeBtn) removeBtn.disabled = selectedFaces() === 0;
  const restoreBtn = el('restoreFacesBtn');
  if (restoreBtn) restoreBtn.disabled = removedFaces() === 0;
  if (stencil.result) updateStencilStats(mask ? mask.stats().painted : 0);
  updateUndoButtons();
  // The window list describes the selection as it was when it was built: every row is one
  // connected group of faces, so the moment the selection is edited the row sizes are wrong and
  // the Remove buttons point at groups that no longer exist. Hiding it is the honest answer —
  // "List windows" rebuilds it from the selection in hand.
  const windowBox = el('windowList');
  if (windowBox && !windowBox.hidden) windowBox.hidden = true;
}

function updateUndoButtons() {
  el('undoBtn').disabled = !cleanup.selection || !history.canUndo;
  el('redoBtn').disabled = !cleanup.selection || !history.canRedo;
}

function updateHud() {
  el('hudTool').textContent = toolLabel();
  const node = el('hudSelection');
  if (!node) return;
  const picked = mask ? selectedFaces() : 0;
  node.textContent = mask
    ? `${fmt(picked)} face${picked === 1 ? '' : 's'} selected`
    : 'nothing selected';
  node.style.color = mask && picked ? SELECTION_COLOR : '';
}

/**
 * Lights up the tool buttons. The Select tool carries two of them — one per scope — so a button
 * with a scope is only active when that scope is the one in hand: the pair reads as one tool with
 * two modes rather than two tools that both light up.
 */
function syncToolButtons() {
  for (const b of document.querySelectorAll('.tool')) {
    const scope = b.dataset.scope;
    const on = b.dataset.tool === state.tool && (!scope || scope === cleanup.scope);
    b.classList.toggle('active', on);
  }
}

/**
 * Switches tool.
 *
 * Nothing is cleared, and that is the point of the whole arrangement: a panel selected with Part
 * is exactly what Select faces is meant to refine triangle by triangle, and the faces selected one
 * at a time are what Part adds a panel to. What changes is which panel is showing.
 */
function setTool(tool) {
  state.tool = tool === 'part' ? 'part' : 'select';
  syncToolButtons();
  el('seamOptions').classList.toggle('on', state.tool === 'part');
  el('selectOptions').classList.toggle('on', state.tool === 'select');
  if (state.tool === 'select' && cleanup.scope === 'models') void ensureShells();
  renderShellList();
  renderModelPickHint();
  // The panel list belongs to the click that produced it, not to the next tool.
  if (state.tool !== 'part') hidePartCandidates();
  // A rectangle belongs to the tool that started it: switching tools mid-drag throws it away
  // rather than finishing a selection the user has already stopped asking for.
  if (state.tool !== 'select' && selectDrag) cancelSelectDrag();
  hideBoxRect();
  updateHud();
}

function applyDisplayState() {
  viewer.setOverlayOpacity(Number(el('overlayOpacity').value));
  viewer.setOverlayVisible(el('showOverlay').checked);
  viewer.setBaseVisible(el('showBase').checked);
  viewer.setWireframe(el('wireframe').checked);
  viewer.setGridVisible(el('showGrid').checked);
  if (mask) {
    mask.setBackdrop(el('ghostShell').checked);
    mask.flush();
  }
}

function setNavigate(on) {
  state.navigate = on;
  viewer.setPointerMode(on ? 'navigate' : 'select');
  el('navigateBtn').textContent = `Navigate: ${on ? 'on' : 'off'}`;
  el('navigateBtn').classList.toggle('active', on);
}

// --------------------------------------------------------- model cleanup

/**
 * The file as it was loaded: the soup every removal is a view of.
 *
 * Keeping the file's own arrays (rather than editing the geometry in place) is what makes the
 * whole feature reversible: taking a model out marks faces in `removed`, and the geometry in
 * hand is always "the file minus those faces", so restoring is the same operation run backwards
 * and no copy of the model has to be kept per edit.
 */
function captureSoup(geometry) {
  const positions = geometry.attributes.position.array;
  cleanup.soup = {
    positions: positions.slice(),
    normals: geometry.attributes.normal.array.slice(),
    faceCount: Math.floor(positions.length / 9),
  };
  cleanup.removed = new Uint8Array(cleanup.soup.faceCount);
  cleanup.liveFace = new Int32Array(cleanup.soup.faceCount);
  for (let f = 0; f < cleanup.soup.faceCount; f += 1) cleanup.liveFace[f] = f;
  cleanup.build = 0;
  // The pick itself is sized from the mask layer, which does not exist yet at this point: the
  // loader calls `resetSelection()` again once it does.
}

function faceCountInHand() {
  return mask ? Math.floor(mask.vertexCount / 3) : 0;
}

/** A model with nothing selected: the state every load starts from. */
function resetSelection() {
  cleanup.selection = createSelection(faceCountInHand());
  tintScratch = null;
  cleanup.shells = null;
  cleanup.shellsKey = '';
  clearHoverFace();
  syncTint();
  renderShellList();
  updateStats();
  updateHud();
}

/**
 * Shows the selection: the one place the face selection becomes the tint on the model.
 *
 * This is the whole "the stencil is built from what you selected" claim, made mechanical: the
 * corner flags the stencil builder reads (`mask.ids`) are written here and nowhere else, from the
 * faces, so no second copy of the selection can drift out of step with the first. Every edit — a
 * panel, a click, a box, an invert, an undo — ends here.
 */
function syncTint() {
  if (!mask || !cleanup.selection) return 0;
  tintScratch = paintedFromFaces(cleanup.selection, tintScratch);
  const corners = mask.setSelection(tintScratch);
  mask.flush();
  return corners;
}

/** What every selection edit does afterwards: show it, count it, and say what it means. */
function afterSelection(changed) {
  syncTint();
  renderShellList();
  updateStats();
  renderModelPickHint();
  updateHud();
  return changed;
}

function selectedFaces() {
  return cleanup.selected ? countFaces(cleanup.selected) : 0;
}

function removedFaces() {
  return cleanup.removed ? countFaces(cleanup.removed) : 0;
}

/**
 * The separate models in the file, cut on shared faces. Cached per model *and* per geometry:
 * removing a model changes the shells of what is left, so the cache key carries the build
 * counter as well as the file name.
 */
async function ensureShells() {
  if (!mask || !cleanup.soup) return null;
  const key = `${modelName}|${cleanup.build}`;
  if (cleanup.shells && cleanup.shellsKey === key) return cleanup.shells;
  if (cleanup.shellsPending) return cleanup.shells;
  cleanup.shellsPending = true;
  try {
    const topology = await ensureTopology();
    if (!mask || !cleanup.soup) return null;
    cleanup.shells = shellsOf(topology);
    cleanup.shellsKey = key;
  } finally {
    cleanup.shellsPending = false;
  }
  renderShellList();
  updateStats();
  return cleanup.shells;
}

/** Says how many models the file holds, for the panel's own button. */
function reportShells(shells) {
  renderShellList();
  updateStats();
  if (!shells) {
    setStatus('Load a model first — there is nothing to count.');
    return;
  }
  if (shells.shellCount <= 1) {
    setStatus(
      `This file holds one model (${fmt(shells.faceCount)} faces) — nothing extra to remove. ` +
        'Switch the pick to single faces to take single faces out of it.',
    );
    return;
  }
  const biggest = shells.shellFaces[0];
  const rest = [];
  for (let s = 1; s < shells.shellCount && s < 5; s += 1) rest.push(fmt(shells.shellFaces[s]));
  setStatus(
    `This file holds ${fmt(shells.shellCount)} separate models: the largest is ${fmt(biggest)} faces ` +
      `(${((biggest / shells.faceCount) * 100).toFixed(0)}% of the file), the rest have ${rest.join(', ')} faces. ` +
      'The bed sits under the lowest point of any of them, so select the models you do not want and “Remove selected”.',
  );
}

function isShellSelected(shell) {
  const shells = cleanup.shells;
  if (!shells || !cleanup.selected) return false;
  for (let t = 0; t < shells.faceCount; t += 1) {
    if (shells.faceShell[t] === shell) return !!cleanup.selected[t];
  }
  return false;
}

/** The models in the file, one row each, with a tick that picks the whole of one. */
function renderShellList() {
  const box = el('modelList');
  const rows = el('modelRows');
  if (!box || !rows) return;
  const shells = cleanup.shells;
  const wanted = state.tool === 'select' && cleanup.scope === 'models' && shells && shells.shellCount;
  if (!wanted) {
    box.hidden = true;
    return;
  }
  rows.textContent = '';
  el('modelHint').textContent =
    `${fmt(shells.shellCount)} separate ${shells.shellCount === 1 ? 'model' : 'models'} in this file. ` +
    'Click one to pick it (again to unpick), or pick it in the viewport with the Select tool:';
  for (let s = 0; s < shells.shellCount; s += 1) {
    const faces = shells.shellFaces[s];
    const size = shellSize(shells.shellBounds, s);
    const btn = document.createElement('button');
    btn.className = 'candidate';
    const left = document.createElement('b');
    left.textContent = `${isShellSelected(s) ? '\u2713 ' : ''}Model ${s + 1}`;
    const right = document.createElement('small');
    right.textContent =
      `${fmt(faces)} faces (${((faces / shells.faceCount) * 100).toFixed(1)}% of the file) · ` +
      `${size.map((n) => n.toFixed(1)).join(' \u00d7 ')} units`;
    btn.append(left, right);
    btn.title = `Pick this model (${fmt(faces)} faces) for removal`;
    btn.addEventListener('click', () => pickShell(s));
    rows.appendChild(btn);
  }
  box.hidden = false;
}

/**
 * Highlights what is under the cursor before the click: the model it belongs to, or the single
 * face. A file with one model has nothing to choose between, so nothing is highlighted there and
 * the panel says so instead — a whole-model highlight on a one-model file is a screenful of tint
 * that means nothing.
 */
function updateHoverFace(faceIndex) {
  if (!mask || faceIndex == null || faceIndex < 0 || faceIndex >= faceCountInHand()) {
    clearHoverFace();
    return;
  }
  const shells = cleanup.shells;
  const whole =
    cleanup.scope === 'models' && shells && shells.shellCount > 1 ? shells.faceShell[faceIndex] : undefined;
  const key = whole === undefined ? `f${faceIndex}` : `s${whole}`;
  if (cleanup.hoverKey === key) return;
  const under = new Uint8Array(faceCountInHand());
  if (whole === undefined) under[faceIndex] = 1;
  else for (let t = 0; t < under.length; t += 1) under[t] = shells.faceShell[t] === whole ? 1 : 0;
  cleanup.hover = drawHighlight(viewer.modelGroup, mask.position.array, cleanup.hover, under, {
    color: 0xffffff,
    fillOpacity: 0.35,
    lineOpacity: 0.9,
    order: 4,
  });
  cleanup.hoverKey = key;
}

function clearHoverFace() {
  if (cleanup.hoverKey === '' && !cleanup.hover) return;
  cleanup.hover = clearHighlight(viewer.modelGroup, cleanup.hover);
  cleanup.hoverKey = '';
}

/** Picks or unpicks a whole model, from the list or from a click on it. */
function pickShell(shell, { add = false, remove = false } = {}) {
  const shells = cleanup.shells;
  if (!shells || shell < 0 || shell >= shells.shellCount) return 0;
  // A plain click toggles — "select all, then take the few off one by one" is the whole point —
  // while Shift and Alt say pick and unpick outright, for a row of clicks that must not flip.
  const on = remove ? false : add ? true : !isShellSelected(shell);
  let changed = 0;
  for (let t = 0; t < shells.faceCount; t += 1) {
    if (shells.faceShell[t] !== shell) continue;
    if (cleanup.selected[t] === (on ? 1 : 0)) continue;
    changed += 1;
  }
  if (!changed) return 0;
  history.remember(cleanup.selection);
  for (let t = 0; t < shells.faceCount; t += 1) {
    if (shells.faceShell[t] === shell) cleanup.selected[t] = on ? 1 : 0;
  }
  afterSelection(changed);
  setStatus(
    `${on ? 'Selected' : 'Unselected'} Model ${shell + 1} — ${fmt(changed)} faces (${fmt(shells.shellFaces[shell])} in the model). ` +
      `${fmt(selectedFaces())} selected in all; “Remove selected” takes them out of the model.`,
  );
  return changed;
}

/** Picks or unpicks a single face — one triangle of the file's own mesh. */
function pickFace(faceIndex, { add = false, remove = false } = {}) {
  if (!mask || !cleanup.selection || faceIndex == null || faceIndex < 0 || faceIndex >= cleanup.selected.length) {
    return 0;
  }
  const on = remove ? false : add ? true : !cleanup.selected[faceIndex];
  if (cleanup.selected[faceIndex] === (on ? 1 : 0)) return 0;
  history.remember(cleanup.selection);
  cleanup.selected[faceIndex] = on ? 1 : 0;
  afterSelection(1);
  setStatus(
    `${on ? 'Selected' : 'Unselected'} face ${fmt(faceIndex)} of ${fmt(cleanup.selected.length)} — ` +
      `${fmt(selectedFaces())} selected in all. Shift-click adds, Alt-click takes one off, “Select all” takes the lot.`,
  );
  return 1;
}

/** What the status bar says about the pick while the Select tool is up. */
function renderModelPickHint() {
  const node = el('selectHint');
  if (!node) return;
  const picked = selectedFaces();
  const scope = cleanup.scope === 'models' ? 'whole models' : 'single faces';
  const shells = cleanup.shells;
  const oneModel = cleanup.scope === 'models' && shells && shells.shellCount === 1;
  node.textContent =
    `Selecting ${scope}: ${fmt(picked)} face${picked === 1 ? '' : 's'} selected of ${fmt(faceCountInHand())} ` +
    '— the selected faces are tinted amber, the one under the cursor outlined white. ' +
    (oneModel
      ? 'This file holds one model, so a click here selects the whole file: press “Select faces” (or Shift+S) to take single triangles instead.'
      : cleanup.scope === 'models'
        ? 'Click a model in the viewport or a row in the list; Alt-click takes one off.'
        : 'Click a face; Shift-click adds, Alt-click takes one off.');
}

/**
 * A click in the viewport with the Select tool: the whole model, or the one face, under it.
 *
 * Takes a point and the two modifiers rather than a pointer event, because it is reached from two
 * places: a press and release that did not drag, and — through the same two flags — nothing else.
 * The drag path keeps its own modifiers so a released rectangle and a click agree about what
 * Shift and Alt mean.
 */
async function selectClickAt(client, { add = false, remove = false } = {}) {
  if (!mask) return;
  const hit = viewer.pick(client.x, client.y);
  if (!hit || hit.faceIndex == null) {
    if (!add && !remove) {
      selectNoFaces();
      setStatus('Nothing under the cursor — the selection was cleared.');
    } else {
      setStatus('Click on the model to select it.');
    }
    return;
  }
  if (cleanup.scope === 'faces') {
    pickFace(hit.faceIndex, { add, remove });
    return;
  }
  const shells = await ensureShells();
  if (!shells) return;
  const shell = shells.faceShell[hit.faceIndex];
  if (shell === undefined || shell < 0) return;
  if (shells.shellCount === 1) {
    setStatus(
      'This file holds one model, so picking it is the whole file — “Select all” does the same. ' +
        'Switch to “Select faces” to take a single triangle instead.',
    );
  }
  pickShell(shell, { add, remove });
}

function selectAllFaces() {
  if (!mask || !cleanup.selection) return;
  if (selectedFaces() === cleanup.selection.faces.length) return;
  history.remember(cleanup.selection);
  const n = setAll(cleanup.selection, true);
  afterSelection(n);
  setStatus(
    `Selected all ${fmt(n)} faces. Click a face to take it off the selection, or “Invert selection” ` +
      'to swap what is selected for what is not.',
  );
}

function selectNoFaces() {
  if (!mask || !cleanup.selection) return;
  if (!selectedFaces()) return;
  history.remember(cleanup.selection);
  setAll(cleanup.selection, false);
  afterSelection(0);
  setStatus('Nothing selected.');
}

function invertPickedFaces() {
  if (!mask || !cleanup.selection) return;
  history.remember(cleanup.selection);
  const n = invertSelection(cleanup.selection);
  afterSelection(n);
  setStatus(`Selection inverted — ${fmt(n)} of ${fmt(cleanup.selection.faces.length)} faces selected.`);
}

function setSelectScope(scope) {
  cleanup.scope = scope === 'faces' ? 'faces' : 'models';
  syncToolButtons();
  clearHoverFace();
  if (cleanup.scope === 'models' && mask && cleanup.soup) void ensureShells();
  renderShellList();
  renderModelPickHint();
  updateStats();
  if (state.tool === 'select' && mask) {
    setStatus(
      cleanup.scope === 'models'
        ? 'Pick: whole models — click the model to remove (the list in the panel picks the same ones), ' +
            'Ctrl+A for all of them, Alt-click to unpick one.'
        : 'Pick: single faces — click a triangle: Shift-click adds, Alt-click takes one off, Ctrl+A picks ' +
            'the lot. The face under the cursor is tinted white and the picked ones yellow.',
    );
  }
}

/**
 * Takes the picked faces out of the model.
 *
 * Rebuilt from the file's own soup with a face map, so the selection and its undo history survive
 * the cut, renumbered — the faces that stayed selected are still selected. The geometry goes back
 * through `viewer.setGeometry`, which re-measures the model and re-places the bed: this is what
 * puts a model that was standing on top of a stray one back on the plate.
 */
async function rebuildModelFromSoup({ what, faces, restoring = false } = {}) {
  const soup = cleanup.soup;
  setLoading(true, restoring ? 'Putting the model back…' : 'Rebuilding the model without the selected faces…');
  await nextFrame();

  const keep = new Uint8Array(soup.faceCount);
  for (let f = 0; f < soup.faceCount; f += 1) keep[f] = cleanup.removed[f] ? 0 : 1;

  const cut = filterSoup({ positions: soup.positions, normals: soup.normals }, keep);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(cut.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(cut.normals, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const overlayGeometry = geometry.clone();
  mask = new SelectionTint(overlayGeometry);
  overlayGeometry.setAttribute('color', new THREE.BufferAttribute(mask.colors, 4));
  tintScratch = null;
  // The selection survives the cut, renumbered: what was selected and stayed selected is still
  // selected, which is what makes "take the stray model out, then stencil what is left" two moves
  // rather than three. The history is renumbered with it, for the same reason.
  cleanup.selection = remapSelection(cleanup.selection, cut.faceMap, cut.faces);
  history.remap(cut.faceMap, cut.faces);

  viewer.setGeometry(geometry, {
    upAxis: state.upAxis,
    overlayGeometry,
    centre: el('centreOnGrid').checked,
  });
  viewer.setGridVisible(el('showGrid').checked);

  cleanup.liveFace = cut.faceMap;
  cleanup.build += 1;
  cleanup.shells = null;
  cleanup.shellsKey = '';
  resetStencil();
  clearHoverFace();
  applyDisplayState();
  syncTint();
  renderShellList();
  updateStats();
  updateHud();
  renderModelPickHint();
  updateUndoButtons();
  setLoading(false);

  const size = viewer.boundingBox.getSize(new THREE.Vector3());
  setStatus(
    `${what} ${fmt(faces)} face${faces === 1 ? '' : 's'}: ${fmt(cut.faces)} faces left, ` +
      `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} units. ` +
      `The bed is under the surviving model's lowest point (${viewer.bedY.toFixed(2)}), and ${centreNote()}.` +
      (restoring ? '' : ' “Restore removed” puts the geometry back.'),
  );
  if (removedFaces() && !parts.data) void ensureShells();
}

/** The whole
 * "take these faces out", with the one guard that matters: a model cannot be left empty.
 */
async function applyRemoval(origFaceList, { what = 'Removed' } = {}) {
  const soup = cleanup.soup;
  if (!soup || !origFaceList.length) return false;
  const trial = cleanup.removed.slice();
  let n = 0;
  for (const f of origFaceList) {
    if (!trial[f]) {
      trial[f] = 1;
      n += 1;
    }
  }
  const left = soup.faceCount - countFaces(trial);
  if (!left) {
    setStatus(
      'That would remove every face in the file, so nothing was removed — leave at least one model in hand.',
    );
    return false;
  }
  cleanup.removed = trial;
  await rebuildModelFromSoup({ what, faces: n });
  return true;
}

/** Removes every selected face. Two clicks: a confirm dialog is blocked in some embedded views. */
function removeClicked() {
  if (!requireModel()) return;
  const picked = selectedFaces();
  if (!picked) {
    setStatus('Nothing selected — click a model (or a face), or press “Select all”, then remove.');
    return;
  }
  const now = performance.now();
  // Two clicks rather than window.confirm: a confirm dialog is silently blocked in some embedded
  // browser views, which made the button look broken instead of asking.
  if (now - cleanup.armedAt > 4000) {
    cleanup.armedAt = now;
    el('removeFacesBtn').textContent = 'Click again to remove';
    const shells = cleanup.shells;
    const models = shells && cleanup.scope === 'models' ? shells.shellCount : 0;
    setStatus(
      `Click “Remove selected” again within 4 seconds to take ${fmt(picked)} faces out of the model` +
        (models ? ` (the file holds ${fmt(models)} models)` : '') +
        '. The selection keeps every face that stays, and “Restore removed” puts the geometry back.',
    );
    return;
  }
  cleanup.armedAt = 0;
  const list = [];
  for (let f = 0; f < cleanup.selected.length; f += 1) {
    if (cleanup.selected[f]) list.push(cleanup.liveFace[f]);
  }
  void applyRemoval(list, { what: 'Removed' });
}

async function restoreRemovedFaces() {
  if (!requireModel()) return;
  const removed = removedFaces();
  if (!removed) {
    setStatus('Nothing has been removed from this model.');
    return;
  }
  cleanup.removed.fill(0);
  await rebuildModelFromSoup({ what: 'Restored', faces: removed, restoring: true });
}

// -------------------------------------------------------- paint stencil

/** Where the mask numbers come from: the model's own size, overridable in the panel. */
function stencilDefaultsForModel() {
  const box = viewer.boundingBox;
  const diagonal = box ? box.getSize(new THREE.Vector3()).length() : 100;
  return stencilDefaultsForDiagonal(diagonal);
}

function resetParts() {
  parts.data = null;
  parts.key = '';
  clearSeams();
}

function resetStencil() {
  hidePartCandidates();
  resetParts();
  clearStencilPreview();
  stencil.result = null;
  stencil.topology = null;
  stencil.topologyFor = '';
  el('stencilExportBtn').disabled = true;
  el('stencilClearBtn').disabled = true;
  const defaults = stencilDefaultsForModel();
  el('stencilReach').value = String(Math.max(1, Math.round(defaults.coverRadius)));
  el('stencilWall').value = String(defaults.wall);
  el('stencilStandoff').value = String(defaults.standoff);
  el('stencilOverhang').value = String(defaults.overhang);
  updateStencilStats();
}

/**
 * The selection as the stencil build wants it: a flag per corner, plus how many are set.
 *
 * The corners come straight from the selected triangles, so there is no step where the selection
 * is copied into something else that could disagree with it — and the count is the same number the
 * panel shows.
 */
function selectedMask() {
  const painted = paintedFromFaces(cleanup.selection);
  let count = 0;
  for (let i = 0; i < painted.length; i += 1) if (painted[i]) count += 1;
  return { painted, count };
}

function stencilParamsFromInputs() {
  const defaults = stencilDefaultsForModel();
  const p = { ...defaults };
  const read = (id, fallback, min) => {
    const raw = el(id).value;
    if (raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(min, v) : fallback;
  };
  p.coverRadius = read('stencilReach', defaults.coverRadius, 1);
  p.wall = read('stencilWall', defaults.wall, 0.2);
  p.standoff = read('stencilStandoff', defaults.standoff, 0);
  p.overhang = read('stencilOverhang', defaults.overhang, 0);
  // The window edge has to stay thinner than the sheet it thickens into.
  p.edgeLip = Math.min(p.wall * 0.5, defaults.edgeLip);
  p.edgeFade = Math.max(p.edgeFade, p.wall * 2);
  // Widening (to force a single piece) has room to work above whatever reach was asked for.
  p.maxCoverRadius = Math.max(defaults.maxCoverRadius || defaults.coverRadius * 3, p.coverRadius * 2);
  p.growIfSplit = el('growIfSplit').checked;
  return p;
}

/** The welded surface, built once per loaded model and shared by everything that needs it. */
async function ensureTopology() {
  if (stencil.topology && stencil.topologyFor === modelName) return stencil.topology;
  setLoading(true, 'Welding the model into a shared-vertex surface…');
  await nextFrame();
  const t0 = performance.now();
  stencil.topology = buildTopology(mask.position.array, mask.vertexCount);
  stencil.topologyFor = modelName;
  stencil.weldMs = Math.round(performance.now() - t0);
  setLoading(false);
  return stencil.topology;
}

const seamAngleInput = () => Math.max(3, Math.min(60, Number(el('seamAngle').value) || DEFAULT_SEAM_ANGLE));

/** Lights up the preset the slider is currently sitting on, if it is one of them. */
function syncSeamPresets() {
  for (const btn of document.querySelectorAll('[data-seam]')) {
    btn.classList.toggle('on', Number(btn.dataset.seam) === state.seamAngle);
  }
}

/**
 * Moves the seam angle — what a preset button and any scripted change go through — and re-cuts
 * the model if one is loaded. The slider's own `input` handler only tracks the drag; the cut
 * happens on `change`, so dragging does not segment the model thirty times.
 */
async function setSeamAngle(angle, { announce = false } = {}) {
  state.seamAngle = Math.max(3, Math.min(60, Math.round(angle) || DEFAULT_SEAM_ANGLE));
  el('seamAngle').value = String(state.seamAngle);
  el('seamAngleVal').textContent = `${state.seamAngle}°`;
  syncSeamPresets();
  if (!mask) return;
  await ensureParts();
  updateSeams();
  if (!announce || !parts.data) return;
  const preset = presetFor(state.seamAngle);
  const biggest = parts.data.partSizes[0] || 0;
  setStatus(
    `${preset ? preset.label : 'Seam angle'}: seams at ${state.seamAngle}° cut the model into ` +
      `${fmt(parts.data.partCount)} panels, the biggest ${fmt(biggest)} faces ` +
      `(${((biggest / stencil.topology.faceCount) * 100).toFixed(0)}%) — click one with the Part tool.`,
  );
}

/** Cuts the model into seam-bounded parts, reusing the cache when nothing relevant changed. */
async function ensureParts({ force = false } = {}) {
  if (!mask) return null;
  const angle = seamAngleInput();
  const key = `${modelName}|${angle}`;
  if (!force && parts.data && parts.key === key) return parts.data;
  if (parts.building) return parts.data;
  parts.building = true;
  try {
    const topology = await ensureTopology();
    setLoading(true, `Cutting the model into parts (seams at ${angle}°)…`);
    await nextFrame();
    const t0 = performance.now();
    parts.data = buildParts(topology, { seamAngleDeg: angle });
    parts.key = key;
    parts.ms = Math.round(performance.now() - t0);
    reportParts();
  } finally {
    parts.building = false;
    setLoading(false);
  }
  return parts.data;
}

function reportParts() {
  const node = el('partInfo');
  if (!parts.data) {
    node.textContent = 'Move the slider to cut the model into parts.';
    return;
  }
  const d = parts.data;
  const usable = d.partSizes.filter((n) => n >= 1000).length;
  node.textContent =
    `${fmt(d.partCount)} parts at ${d.seamAngleDeg}° (${fmt(usable)} of them with 1,000+ faces, ` +
    `${fmt(d.mergedSpecks)} slivers merged) · ${fmt(d.seamEdges)} seam edges · ${parts.ms} ms`;
}

/** Yellow lines along the seams, so it is obvious where a click will stop. */
function updateSeams() {
  const on = el('showSeams').checked && parts.data;
  const topology = stencil.topology;
  if (!on || !topology || !parts.data.seamVerts.length) {
    clearSeams();
    return;
  }
  const key = parts.key;
  if (parts.seams && parts.seamsKey === key) {
    parts.seams.visible = true;
    return;
  }
  clearSeams();
  const pairs = parts.data.seamVerts;
  const positions = new Float32Array(pairs.length * 3);
  for (let i = 0; i < pairs.length; i += 1) {
    const v = pairs[i] * 3;
    positions[i * 3] = topology.positions[v];
    positions[i * 3 + 1] = topology.positions[v + 1];
    positions[i * 3 + 2] = topology.positions[v + 2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.85 });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'seams';
  lines.renderOrder = -2;
  viewer.modelGroup.add(lines);
  parts.seams = lines;
  parts.seamsKey = key;
}

function clearSeams() {
  if (!parts.seams) return;
  viewer.modelGroup.remove(parts.seams);
  parts.seams.geometry.dispose();
  parts.seams.material.dispose();
  parts.seams = null;
  parts.seamsKey = '';
}

/**
 * Selects one seam-bounded part: the whole panel, every triangle of it, in the one selection.
 *
 * A plain click replaces the selection with the panel, Shift adds another panel to it, Alt takes
 * one off — the same three modifiers Select faces uses on single triangles, so refining a panel
 * afterwards is the same gesture at a finer scale rather than a different convention.
 *
 * `near` is where the click landed, in model space; it is only used to rank the other panels
 * that meet this one, which the panel offers as alternatives (see `renderPartCandidates`).
 */
function selectPartAt(faceIndex, { add = false, remove = false, near = null } = {}) {
  const d = parts.data;
  const topology = stencil.topology;
  if (!d || !topology || faceIndex == null || faceIndex < 0 || faceIndex >= d.facePart.length) return 0;
  return applyPartSelection(d.facePart[faceIndex], { add, remove, near });
}

/**
 * A seam panel, written into the selection.
 *
 * The panel arrives as a list of soup vertices (that is how the segmentation carries it) and the
 * selection is a set of faces, so it is mapped across by corner — three corners per triangle, so
 * the panel's faces are exactly the triangles those corners belong to. This is the half of the
 * arrangement that makes Part and Select faces the same statement: a click here and a box drag
 * there write the same array, which is why either can build on what the other selected.
 */
function applyPartSelection(partId, { add = false, remove = false, near = null } = {}) {
  const d = parts.data;
  const topology = stencil.topology;
  if (!d || !topology || !(partId >= 0) || !cleanup.selection) return 0;
  const indices = partSoupVertices(d, partId, partScratch);
  const wanted = facesFromVertices(indices, cleanup.selection.faces.length, partFacesScratch);
  partFacesScratch = wanted;
  const changed = applyPickToSelection(wanted, { add, remove });
  afterSelection(changed);

  const faces = d.partSizes[partId];
  const share = faces / topology.faceCount;
  const verb = remove ? 'Removed' : add ? 'Added' : 'Selected';
  const { found, radius } = renderPartCandidates(partId, near);
  // The detail the click was most likely aimed at: a panel near the click that is a small
  // fraction of the one that got selected. Without naming it the status bar can only say "that
  // is a big panel", which leaves the reader to work out which of the listed panels was meant.
  const target =
    !add && !remove
      ? found.filter((n) => n.share <= 0.1 && n.share < share / 3).sort((a, b) => a.distance - b.distance)[0] || null
      : null;
  const finer = finerPreset(d.seamAngleDeg);
  const cutHint = finer ? ` or take the ${finer.label} cut (${finer.angle}°)` : '';
  setStatus(
    `${verb} part ${partId + 1} of ${d.partCount} — ${fmt(faces)} faces (${(share * 100).toFixed(1)}% of the mesh), ` +
      `${fmt(changed)} face${changed === 1 ? '' : 's'} ${remove ? 'taken off' : 'added to'} the selection ` +
      `(${fmt(selectedFaces())} of ${fmt(cleanup.selection.faces.length)} selected in all, seams at ${d.seamAngleDeg}°).` +
      (target
        ? ` That is ${(share * 100).toFixed(0)}% of the model — the detail you aimed at is probably Part ${target.part + 1} ` +
          `(${fmt(target.faces)} faces, ${(target.share * 100).toFixed(2)}% of the mesh, ${target.distance.toFixed(1)} away): ` +
          `click it in the list above${cutHint}.`
        : share > 0.15
          ? ` That is a big panel: pick a smaller one from the list above${cutHint}.`
          : '') +
      (found.length && !target
        ? ` ${found.length} other panel${found.length === 1 ? '' : 's'} meet it within ${radius.toFixed(1)} units of the click.`
        : '') +
      (add ? ' Shift-click another part to add it.' : ''),
  );
  if (share > 0.6) {
    // A click that took more than half the model is almost never what was meant, and the panel
    // says so where the slider is, next to the way out.

    el('partInfo').textContent =
      `Part ${partId + 1} is ${(share * 100).toFixed(0)}% of the model — ` +
      (finer
        ? `click one of the smaller panels in the list, or press ${finer.label} (${finer.angle}°) to cut the model finer.`
        : 'click one of the smaller panels in the list.');
  } else {
    reportParts();
  }
  return changed;
}

/**
 * The other panels that meet the one just selected, closest to the click.
 *
 * A click can only ever select the panel it lands on. On the bundled model the opening panel
 * is 48% of the mesh while the detail you may be aiming at is a strip of 332 faces that is a
 * few pixels wide on screen, so a click a little off selects half the model and the strip
 * stays bare — which reads as "the button ran backward". It did not: it selected the face it
 * hit. These are the panels it shares a seam with, so the one you meant is one click away
 * without pixel-hunting, including panels hidden behind the one under the cursor.
 */
function hidePartCandidates() {
  const box = el('partCandidates');
  if (box) box.hidden = true;
}

function renderPartCandidates(partId, near) {
  const d = parts.data;
  const topology = stencil.topology;
  const box = el('partCandidates');
  const list = el('candidateList');
  list.textContent = '';
  if (!d || !topology || partId < 0 || !near) {
    box.hidden = true;
    return { found: [], radius: 0 };
  }
  // How far to look: a few mesh steps, never less than the pick radius the tool is used with.
  const radius = topology.meanEdgeLength * 4;
  const found = partsNearPoint(d, topology, [near.x, near.y, near.z], radius, { excludePart: partId, limit: 6 });
  if (!found.length) {
    box.hidden = true;
    return { found: [], radius };
  }
  const currentShare = d.partSizes[partId] / topology.faceCount;
  el('candidateHint').textContent =
    `Panel ${partId + 1} covers ${(currentShare * 100).toFixed(1)}% of the mesh — a near-miss on a thin ` +
    `panel lands here. Panels within ${radius.toFixed(1)} units of the click; click one to select it instead:`;
  for (const n of found) {
    const btn = document.createElement('button');
    btn.className = 'candidate';
    const left = document.createElement('b');
    left.textContent = `Part ${n.part + 1}`;
    const right = document.createElement('small');
    right.textContent =
      `${fmt(n.faces)} faces (${(n.share * 100).toFixed(2)}% of the mesh) · ${n.distance.toFixed(1)} away`;
    btn.append(left, right);
    btn.title = `Select this panel (${fmt(n.faces)} faces)`;
    btn.addEventListener('click', () => applyPartSelection(n.part, { near }));
    list.appendChild(btn);
  }
  const clear = document.createElement('button');
  clear.className = 'candidate';
  clear.innerHTML = '<small>Hide this list</small>';
  clear.title = 'Hide the panel list';
  clear.addEventListener('click', () => {
    box.hidden = true;
  });
  list.appendChild(clear);
  box.hidden = false;
  return { found, radius };
}

let partScratch = [];
let partFacesScratch = null;

async function partClick(e) {
  if (!mask) return;
  const d = await ensureParts();
  if (!d) return;
  // faceIndex is the hit triangle in the file's own face order — the order the panels were cut
  // in. The BVH's own index counts in its internal order instead (see viewer.sourceTriangleIndex),
  // and feeding that to facePart selects an unrelated panel, which reads as the tool ignoring
  // your click.
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit || hit.faceIndex == null) return;
  updateSeams();
  selectPartAt(hit.faceIndex, {
    add: e.shiftKey,
    remove: e.altKey || e.ctrlKey || e.metaKey,
    near: hit.localPoint,
  });
}

async function buildStencilPart() {
  if (!requireModel()) return null;
  const { painted, count } = selectedMask();
  if (!count) {
    // Nothing selected is a refusal worth wording: the button sits at the bottom of a long panel
    // and "Build stencil does nothing" is the report this app has had more than any other.
    setStatus(
      'Nothing selected yet — the stencil is built from the selection: click a panel with Part ' +
        '(P), or pick triangles with Select faces (Shift+S), then build.',
    );
    return null;
  }

  const t0 = performance.now();
  await ensureTopology();
  const weldMs = performance.now() - t0;

  const params = stencilParamsFromInputs();
  setLoading(true, `Building the mask around ${fmt(count)} painted vertices…`);
  await nextFrame();
  const tBuild = performance.now();
  const res = buildStencil({ topology: stencil.topology, painted, params });
  stencil.paintedCount = count;
  stencil.buildMs = Math.round(performance.now() - tBuild);
  stencil.weldMs = Math.round(weldMs);
  setLoading(false);
  return res;
}

function clearStencilPreview() {
  if (!stencil.mesh) return;
  viewer.modelGroup.remove(stencil.mesh);
  stencil.mesh.geometry.dispose();
  stencil.mesh.material.dispose();
  stencil.mesh = null;
}

function showStencilPreview(res) {
  clearStencilPreview();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(res.indices), 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffb703,
    roughness: 0.62,
    metalness: 0,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  stencil.mesh = new THREE.Mesh(geometry, material);
  stencil.mesh.name = 'paint-stencil';
  // Draw the shell BEFORE the paint overlay, not after. Both are transparent and neither
  // writes depth, so the blend order decides what you see: painted vertices have alpha 1 in
  // the overlay, so they land on top of the shell in their exact colours, while the shell
  // still reads clearly on everything unpainted. With the shell drawn last (and double
  // sided) the paint came through at ~16% and hiding or clearing paint looked like it did
  // nothing.
  stencil.mesh.renderOrder = -1;
  stencil.mesh.visible = el('stencilPreview').checked;
  viewer.modelGroup.add(stencil.mesh);
}

/**
 * Throws the built stencil away: the preview mesh, the result and the export.
 *
 * Before this existed the only way to get rid of a built shell was to load the model again —
 * clearing the mask left the shell on screen with nothing to press, which reads as "the clear
 * did not work". The mask is deliberately not touched: the build is a snapshot of a mask, so
 * clearing paint and keeping the shell is a legitimate comparison (the panel says the part is
 * stale when the count no longer matches).
 */
function discardStencil() {
  if (!stencil.result && !stencil.mesh) {
    setStatus('No stencil built yet — nothing to discard.');
    return;
  }
  const triangles = stencil.result ? stencil.result.stats.solidTriangles : 0;
  clearStencilPreview();
  stencil.result = null;
  el('stencilExportBtn').disabled = true;
  el('stencilClearBtn').disabled = true;
  updateStencilStats();
  setStatus(
    `Stencil discarded${triangles ? ` (${fmt(triangles)} triangles)` : ''}. The selection is untouched — ` +
      'press “Build stencil” to make a new one.',
  );
}

function updateStencilStats(paintedNow = null) {
  const node = el('stencilStats');
  if (!stencil.result) {
    node.textContent = 'No stencil built yet.';
    return;
  }
  const res = stencil.result;
  const s = res.stats;
  const v = validateSolid(res);
  const lines = [
    `${fmt(s.solidTriangles)} triangles · ${s.components === 1 ? 'one piece' : `${s.components} pieces`} · ` +
      `${s.windowLoops} window${s.windowLoops === 1 ? '' : 's'} · reach ${s.coverRadius.toFixed(0)} mm`,
    `wall ${s.thicknessMin.toFixed(2)}–${s.thicknessMax.toFixed(2)} mm · standoff ${s.standoff.toFixed(2)} mm · ` +
      `size ${s.size.map((n) => n.toFixed(0)).join(' × ')} mm`,
    s.clearance
      ? `clearance inside the mask: median ${s.clearance.median.toFixed(3)} mm, min ${s.clearance.min.toFixed(3)} mm` +
        ` (${s.clearance.tight} of ${fmt(s.clearance.measured)} vertices under ${(s.clearance.requested * 0.5).toFixed(2)} mm)`
      : 'clearance not measured',
    `${v.watertight ? 'watertight ✓' : 'NOT watertight'} · every edge shared by two triangles` +
      (s.windowOpen ? '' : ' · window closed'),
    `built in ${fmt(stencil.buildMs)} ms (mesh weld ${fmt(stencil.weldMs || 0)} ms, cached)`,
  ];
  for (const w of res.warnings) lines.push(`⚠ ${w}`);
  const now = paintedNow === null ? (mask ? mask.stats().painted : null) : paintedNow;
  if (now !== null && now !== stencil.paintedCount) {
    lines.push('⚠ the selection has changed since this was built — build again to match it, or “Discard stencil” to throw this one away.');
  }
  node.textContent = lines.join('\n');
}

/**
 * True when the paint has moved on since the build in hand.
 *
 * A build is a snapshot of the mask, so `stencil.result` can be older than what is on screen:
 * paint three more panels with Shift-click and the result in hand still describes the old mask.
 * Its triangle count stays valid and its file still opens, which is exactly why this has to be
 * asked out loud before anything is written to disk.
 */
function stencilOutOfDate() {
  if (!stencil.result) return false;
  return (mask ? mask.stats().painted : 0) !== stencil.paintedCount;
}

/**
 * Builds the stencil for the mask as it stands and installs it: the shared half of **Build
 * stencil** and of the export, so both go through the same path and the same panel state.
 * Returns the build result (possibly one with `ok: false`), or null when there is nothing to
 * build.
 */
async function rebuildStencil() {
  const res = await buildStencilPart();
  if (!res) return null;
  if (!res.ok) {
    stencil.result = null;
    clearStencilPreview();
    el('stencilExportBtn').disabled = true;
    el('stencilClearBtn').disabled = true;
    el('stencilStats').textContent = res.warnings.join('\n');
    return res;
  }
  stencil.result = res;
  showStencilPreview(res);
  el('stencilExportBtn').disabled = false;
  el('stencilClearBtn').disabled = false;
  updateStencilStats();
  return res;
}

async function buildStencilClicked() {
  try {
    const res = await rebuildStencil();
    if (!res) return;
    if (!res.ok) {
      setStatus(`No stencil: ${res.warnings[0]}`);
      return;
    }
    const s = res.stats;
    setStatus(
      `Stencil built in ${fmt(stencil.buildMs)} ms: ${fmt(s.solidTriangles)} triangles, ` +
        `${s.components === 1 ? 'one piece' : `${s.components} pieces`}, ` +
        `${s.windowLoops} window${s.windowLoops === 1 ? '' : 's'}${res.warnings.length ? ' — see the panel for notes' : ''}.`,
    );
  } catch (err) {
    setLoading(false);
    setStatus(`Stencil build failed: ${err.message}`);
  }
}

/**
 * Writes the printable shell to disk.
 *
 * The file has to be the mask on screen, not the last thing that was built: Shift-click two more
 * panels, press Export again and a straight copy of the old result lands on disk with today's
 * timestamp and last round's windows — reported as "my second save only has the first windows".
 * So this rebuilds first whenever the paint has changed, and writes nothing at all if that
 * rebuild is refused (a refusal used to leave the old part in hand to be saved). Exporting an
 * unchanged mask still writes the build straight out, with no rebuild.
 *
 * The status line names the windows and pieces that went into the file, so the numbers can be
 * checked against the panel without opening the STL.
 */
async function exportStencilSTL() {
  try {
    if (!requireModel()) return;
    if (!mask.stats().painted) {
      setStatus('Nothing selected yet — select the windows, build the stencil, then export.');
      return;
    }
    let res = stencil.result;
    let rebuilt = false;
    if (!res || stencilOutOfDate()) {
      setStatus('The selection has changed since the last build — building again before exporting…');
      res = await rebuildStencil();
      if (!res) return;
      if (!res.ok) {
        setStatus(`Nothing exported: the stencil could not be built (${res.warnings[0]}).`);
        return;
      }
      rebuilt = true;
    }
    // A slicer reads Z = 0 as the plate, and the shell is written in the model's own
    // coordinates — which for a model authored away from its own origin means a part that lands
    // in the slicer floating in mid-air. The viewport never shows that, because centring the
    // model on the grid moves the view, not the mesh, so the file is the only place it can be
    // put right. Every piece is placed, not just the assembly's lowest point: a slicer imports
    // the shells of one STL as parts of one object and only drops them when they are split into
    // objects, so a two-piece stencil would otherwise keep hovering over its upper piece's air.
    // Only Z moves, and only in the copy that gets written.
    const lowest = io.lowestZ(res.positions);
    const onBed = el('stencilOnBed').checked;
    const placed = onBed ? io.setOnBed(res.positions, res.indices) : null;
    const written = placed ? placed.positions : res.positions;
    const { buffer, triangles, bytes } = io.buildBinarySTL(written, res.indices);
    io.downloadBlob(`${io.safeBaseName(modelName)}-paint-stencil.stl`, new Blob([buffer], { type: 'model/stl' }));
    const s = res.stats;
    setStatus(
      `Exported paint stencil: ${fmt(triangles)} triangles (${(bytes / 1048576).toFixed(1)} MB), ` +
        `${s.windowLoops} window${s.windowLoops === 1 ? '' : 's'} in ` +
        `${s.components === 1 ? 'one piece' : `${s.components} pieces`}` +
        (placed
          ? placed.moved === 0
            ? ' — its lowest point was already on Z 0, so nothing moved.'
            : placed.pieces > 1
              ? ` — sat each of its ${placed.pieces} pieces on the bed: the furthest moved ` +
                `${placed.moved.toFixed(2)} mm so every piece's lowest Z is 0 (X and Y untouched).`
              : ` — sat on the bed: moved ${lowest > 0 ? 'down' : 'up'} ${Math.abs(lowest).toFixed(2)} mm so the part's lowest Z is 0 (X and Y untouched).`
          : ` — left in the model's own coordinates (lowest Z ${lowest.toFixed(2)}` +
            `${s.components === 1 ? '' : `, its ${s.components} pieces wherever the model has them`}), so it lines up with the figure in the slicer.`) +
        (rebuilt ? ' Rebuilt from the current selection first, because the selection had changed since the last build.' : ''),
    );
  } catch (err) {
    setLoading(false);
    setStatus(`Export failed: ${err.message}`);
  }
}

// -------------------------------------------------------------- exports

function requireModel() {
  if (!mask) {
    setStatus('Load a model first.');
    return false;
  }
  return true;
}

/**
 * The build settings that are in the panel, for saving with a mask.
 *
 * They are not needed to reload the painting, but a session that comes back with the numbers it
 * was saved with rebuilds the same shell — which is what "save the windows and load them back up
 * to add more" has to mean when the next step is pressing Build again.
 */
function stencilSettings() {
  const p = stencilParamsFromInputs();
  return {
    coverRadius: p.coverRadius,
    wall: p.wall,
    standoff: p.standoff,
    overhang: p.overhang,
    growIfSplit: !!p.growIfSplit,
  };
}

/** Puts saved build settings back into the panel. Returns true when there were any to apply. */
function applyStencilSettings(s) {
  if (!s) return false;
  const put = (id, v) => {
    if (Number.isFinite(v)) el(id).value = String(v);
  };
  put('stencilReach', s.coverRadius);
  put('stencilWall', s.wall);
  put('stencilStandoff', s.standoff);
  put('stencilOverhang', s.overhang);
  if (typeof s.growIfSplit === 'boolean') el('growIfSplit').checked = s.growIfSplit;
  return true;
}

/**
/**
 * Saves the selection as a session file: the window (the corners inside it) and the build
 * settings, so it can be opened again later on the same model and carried on from there.
 *
 * The file keeps the format's `features` array, with the one id this app now has. That is not a
 * palette come back from the dead — it is what makes a mask saved by the previous, painting
 * version of the app still open here.
 */
function exportMaskJSON() {
  if (!requireModel()) return;
  const pairs = mask.paintedPairs();
  if (!pairs.length) {
    setStatus('Nothing selected yet — select the area the stencil should expose first.');
    return;
  }
  const data = io.buildMaskJSON({
    mask,
    features: [{ id: SELECTION_ID, name: 'Selection', color: SELECTION_COLOR }],
    modelName,
    pairs,
    stencil: stencilSettings(),
  });
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  io.downloadBlob(`${io.safeBaseName(modelName)}-mask.json`, blob);
  setStatus(
    `Saved selection: ${fmt(pairs.length / 2)} corners inside the window ` +
      `(${(blob.size / 1048576).toFixed(1)} MB). “Open selection (JSON)” brings it back to carry on.`,
  );
}

function exportPLY() {
  if (!requireModel()) return;
  const { blob, triangles, vertices } = io.buildPLY(mask);
  if (!triangles) {
    setStatus('Nothing selected yet — select the area first.');
    return;
  }
  io.downloadBlob(`${io.safeBaseName(modelName)}-mask.ply`, blob);
  setStatus(`Exported the selected shell: ${fmt(triangles)} triangles, ${fmt(vertices)} vertices (${(blob.size / 1048576).toFixed(1)} MB).`);
}

/**
 * Opens a saved selection.
 *
 * The file carries a painted corner per entry, and a selection is a set of triangles, so the two
 * meet by inclusion: every triangle that touches a saved corner is selected, and then the tint is
 * derived from those faces as it is for any other selection. That is what lets a mask saved by the
 * old palette version load as one selection instead of being refused, and it is also why a loaded
 * window can come back a rim thicker than it was saved — the file is per corner, the selection is
 * per triangle, and the larger of the two readings is the one that keeps a window whole.
 */
async function importMaskFile(file) {
  if (!requireModel()) return;
  try {
    const text = await file.text();
    const { data, pairs, stencil: savedStencil } = io.parseMaskJSON(text);
    if (data.vertexCount && data.vertexCount !== mask.vertexCount) {
      setStatus(
        `Warning: this selection was saved on ${fmt(data.vertexCount)} vertices but this model has ${fmt(mask.vertexCount)}.`,
      );
    }
    mask.loadPairs(pairs);
    const painted = new Uint8Array(mask.vertexCount);
    for (let i = 0; i < mask.vertexCount; i += 1) painted[i] = mask.ids[i] ? 1 : 0;
    history.remember(cleanup.selection);
    cleanup.selection = createSelection(mask.vertexCount / 3);
    cleanup.selection.faces.set(facesFromPainted(painted, cleanup.selection.faces.length));
    afterSelection(selectedFaces());
    // A loaded selection is not the one the build in the panel was made from, whatever the counts
    // say, so the panel has to be told to compare them rather than left showing old numbers.
    updateStencilStats();
    const settings = applyStencilSettings(savedStencil);
    setStatus(
      `Loaded the selection: ${fmt(pairs.length / 2)} corners inside the window, ` +
        `${fmt(selectedFaces())} of ${fmt(cleanup.selection.faces.length)} faces selected` +
        `${settings ? ', build settings restored' : ''}. Click a panel with Part to add to it, then “Build stencil”.`,
    );
  } catch (err) {
    setStatus(`Import failed: ${err.message}`);
  }
}

/**
 * The painted windows of the mask, plus what the panel's threshold would release.
 *
 * One analysis behind both buttons so the list and the trim cannot disagree about the numbers,
 * and the threshold is read from the panel every time rather than remembered, so raising it and
 * pressing the button again trims harder the second time.
 *
 * The percentage runs 0–100 of the model's diagonal. It used to stop at 50, which quietly turned
 * a typed 99 into a 50 and made "raise it until something goes" impossible to reach.
 */
async function analyseWindows({ quiet = false } = {}) {
  if (!requireModel()) return null;
  const painted = mask.stats().painted;
  if (!painted) {
    // Quiet when this is a refresh after an edit: the edit has a message of its own and the
    // caller has already said what happened.
    if (!quiet) setStatus('Nothing selected yet — select the area the mask should expose first.');
    return null;
  }
  const percent = Math.max(0, Math.min(100, Number(el('trimPercent').value) || 0));
  const topology = await ensureTopology();
  const t0 = performance.now();
  const windows = maskWindows(topology, mask.ids);
  const plan = planIslandTrim({
    topology,
    ids: mask.ids,
    minDiagonal: (percent / 100) * topology.diagonal,
  });
  return { windows, plan, percent, topology, painted, ms: Math.round(performance.now() - t0) };
}

/**
 * The window list: every connected painted region, with two ways to take one out.
 *
 * This is what a size threshold cannot be. Two panels that touch weld into one window, so a mask
 * built by Shift-clicking neighbours is a single island and no threshold, however high, will
 * ever release part of it — the trim only ever releases islands *other* than the largest. Here
 * each window has a name, a size and its own buttons: **Remove** releases the window that row
 * names (the largest included), and **Keep only** releases every other window, which is the way
 * to keep one panel out of the several that were painted.
 *
 * Both are one undo step, like every other mask edit, and the list rebuilds itself from what is
 * left afterwards, so the numbers on screen are the numbers in the mask.
 */
function renderWindowList({ windows, topology: topo, painted }) {
  const box = el('windowList');
  const list = el('windowRows');
  list.textContent = '';
  if (!windows.length) {
    box.hidden = true;
    return;
  }
  el('windowHint').textContent =
    `${fmt(windows.length)} painted window${windows.length === 1 ? '' : 's'} on the mask (${fmt(painted)} vertices) — ` +
    'each one is an opening in the built stencil. Remove takes one out by name, whatever its size:';
  windows.forEach((w, k) => {
    const row = document.createElement('div');
    row.className = 'candidate window-row';
    const label = document.createElement('b');
    label.textContent = `Window ${k + 1}`;
    const info = document.createElement('small');
    info.textContent =
      `${fmt(w.vertices)} vertices · ${w.diagonal.toFixed(2)} units across ` +
      `(${((w.diagonal / topo.diagonal) * 100).toFixed(1)}% of the model) · ${fmt(windowFaces(w))} faces`;
    const actions = document.createElement('span');
    actions.className = 'window-actions';
    const remove = document.createElement('button');
    remove.className = 'btn small';
    remove.textContent = 'Remove';
    remove.title =
      `Release window ${k + 1} (${fmt(w.vertices)} vertices) from the mask — one undo step, every other window kept`;
    remove.addEventListener('click', () =>
      releaseWindows([w], `Removed window ${k + 1} (${fmt(w.vertices)} vertices)`),
    );
    const only = document.createElement('button');
    only.className = 'btn small';
    only.textContent = 'Keep only';
    only.title =
      windows.length === 1
        ? `Window ${k + 1} is the only window — there is nothing else to release`
        : `Release the other ${windows.length - 1} window${windows.length === 2 ? '' : 's'} and keep window ${k + 1}`;
    only.disabled = windows.length === 1;
    only.addEventListener('click', () =>
      releaseWindows(
        windows.filter((other) => other !== w),
        `Kept only window ${k + 1} (${fmt(w.vertices)} vertices)`,
      ),
    );
    actions.append(remove, only);
    row.append(label, info, actions);
    list.appendChild(row);
  });
  const hide = document.createElement('button');
  hide.className = 'candidate';
  hide.innerHTML = '<small>Hide this list</small>';
  hide.title = 'Hide the window list — List windows brings it back';
  hide.addEventListener('click', () => {
    box.hidden = true;
  });
  list.appendChild(hide);
  box.hidden = false;
}

/**
 * The triangles a window covers.
 *
 * The island analysis reports the corners of the window (that is the shape a welded surface makes
 * easy); a triangle is `floor(corner / 3)`, and the count is deduplicated because two corners of
 * one triangle would otherwise count twice.
 */
function windowFaces(w) {
  const seen = new Set();
  for (const c of w.fileVertices) seen.add(Math.floor(c / 3));
  return seen.size;
}

/**
 * Releases whole windows from the mask: one stroke, one undo step, then the list rebuilds itself
 * from what is left.
 */
async function releaseWindows(targets, what) {
  const corners = [];
  for (const w of targets) corners.push(...w.fileVertices);
  if (!corners.length || !cleanup.selection) {
    setStatus(`${what}: there was nothing left to release.`);
    return;
  }
  const wanted = new Uint8Array(cleanup.selection.faces.length);
  for (const c of corners) {
    const t = Math.floor(c / 3);
    if (t >= 0 && t < wanted.length) wanted[t] = 1;
  }
  const before = selectedFaces();
  const changed = applyPickToSelection(wanted, { remove: true });
  afterSelection(changed);
  updateStencilStats();
  setStatus(
    `${what}: ${fmt(changed)} face${changed === 1 ? '' : 's'} unselected (of the ${fmt(before)} that were), ` +
      `${fmt(selectedFaces())} selected in all. Ctrl+Z brings them back.` +
      (stencil.result ? ' The built stencil is still in the viewport — build again to match the selection.' : ''),
  );
  await listWindows({ quiet: true });
}

/**
 * Lists the painted windows and says which of them the threshold would release.
 *
 * The dry-run half is worth its own button because the sizes are the only way to choose a
 * threshold that does anything: a mask that is one connected region has nothing to release. The
 * list is the half that can act on what it reports.
 */
async function listWindows({ quiet = false } = {}) {
  let got = null;
  try {
    got = await analyseWindows({ quiet });
  } catch (err) {
    setStatus(`Could not list the windows: ${err.message}`);
    return;
  }
  if (!got) {
    // Nothing painted: there is no list to show, and any list still on screen describes a mask
    // that has just been emptied.
    el('windowList').hidden = true;
    return;
  }
  renderWindowList(got);
  if (quiet) return;
  const { windows, plan, percent, topology: topo, painted, ms } = got;
  const largest = windows[0];
  const smallest = windows[windows.length - 1];
  setStatus(
    `${fmt(windows.length)} painted window${windows.length === 1 ? '' : 's'} (${fmt(painted)} vertices): ` +
      `largest ${fmt(largest.vertices)} vertices, ${largest.diagonal.toFixed(2)} units across; smallest ` +
      `${fmt(smallest.vertices)}, ${smallest.diagonal.toFixed(2)} across. ` +
      (windows.length === 1
        ? 'Everything selected is one window, so no size threshold can split it — Remove takes the whole of it ' +
          'out, and Select faces takes part of it back.'
        : `At under ${plan.threshold.toFixed(2)} units (${percent}% of the model's ` +
          `${topo.diagonal.toFixed(1)}-unit diagonal) Trim windows would release ${fmt(plan.doomedIslands)} of them ` +
          `(${fmt(plan.doomedVertices)} vertices).`) +
      ` (${ms} ms)`,
  );
}

/**
 * Releases the painted windows a printer cannot use: the specks and stray dabs that would
 * otherwise each become another window, and often another loose piece, in the exported stencil.
 *
 * One undo step, like every other mask edit, and the largest window is always kept — a threshold
 * set too high can shrink a mask to its main region but never wipe it out. The rest of the mask
 * is untouched, and a built stencil is left in the viewport with the panel saying it is stale.
 *
 * A threshold can only ever say "smaller than this", so the refusal below names the two things
 * that can do the job when it cannot: the window list for a whole window, Select faces for part of
 * one.
 */
async function trimWindows() {
  let got = null;
  try {
    got = await analyseWindows();
  } catch (err) {
    setStatus(`Trim failed: ${err.message}`);
    return;
  }
  if (!got) return;
  const { plan, percent, topology: topo, windows, painted } = got;
  const plural = (n) => (n === 1 ? '' : 's');
  if (!plan.doomedIslands) {
    const smallest = windows[windows.length - 1];
    const wouldNeed = (smallest.diagonal / topo.diagonal) * 100;
    setStatus(
      windows.length === 1
        ? `Nothing to trim: the whole mask is one painted window (${fmt(painted)} vertices), and a size ` +
          'threshold can only release whole windows. “List windows” removes it, or Select faces takes ' +
          'part of it back.'
        : `Nothing to trim under ${plan.threshold.toFixed(2)} units (${percent}% of the model's ` +
          `${topo.diagonal.toFixed(1)}-unit diagonal): ${fmt(windows.length)} windows, the smallest ` +
          `${smallest.diagonal.toFixed(2)} units across (${wouldNeed.toFixed(1)}% of the model). A threshold over ` +
          `${Math.ceil(wouldNeed * 10) / 10}% would release it — or press “List windows” to remove a particular one.`,
    );
    return;
  }
  const wanted = new Uint8Array(cleanup.selection.faces.length);
  for (const c of plan.released) {
    const t = Math.floor(c / 3);
    if (t >= 0 && t < wanted.length) wanted[t] = 1;
  }
  const changed = applyPickToSelection(wanted, { remove: true });
  afterSelection(changed);
  updateStencilStats();
  const kept = plan.islands - plan.doomedIslands;
  setStatus(
    `Trimmed ${fmt(plan.doomedIslands)} window${plural(plan.doomedIslands)} under ` +
      `${plan.threshold.toFixed(2)} units (${percent}% of the model's size): ${fmt(changed)} face${changed === 1 ? '' : 's'} unselected ` +
      `(${((changed / Math.max(1, selectedFaces() + changed)) * 100).toFixed(1)}% of the selection). ` +
      `${fmt(kept)} window${plural(kept)} left, the largest ${fmt(plan.largestVertices)} vertices. Ctrl+Z brings them back.` +
      (plan.sparedLargest ? ' The largest window is under the threshold too, so it was kept.' : '') +
      (stencil.result ? ' The built stencil is still in the viewport — build again to match the selection.' : ''),
  );
  if (!changed) setStatus('Nothing was dropped — those faces were already unselected.');
}

function screenshot() {
  const url = viewer.screenshot();
  fetch(url)
    .then((r) => r.blob())
    .then((blob) => {
      io.downloadBlob(`${io.safeBaseName(modelName)}-mask-view.png`, blob);
      setStatus('Saved a viewport screenshot.');
    })
    .catch(() => setStatus('Screenshot failed.'));
}

// --------------------------------------------------------------- wiring

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('pointerleave', () => {
  if (!selectDrag) {
    viewer.hideCursor();
    el('statusCursor').textContent = '';
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

el('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await loadFromBuffer(await file.arrayBuffer(), file.name);
  e.target.value = '';
});

el('loadExampleBtn').addEventListener('click', () => loadFromURL(DEFAULT_MODEL_URL));
el('shotBtn').addEventListener('click', screenshot);
for (const btn of document.querySelectorAll('.tool')) {
  btn.addEventListener('click', () => {
    setTool(btn.dataset.tool);
    // The Select tool's two buttons differ only in scope, so the scope follows the button that
    // was pressed rather than hiding in a menu.
    if (btn.dataset.scope) setSelectScope(btn.dataset.scope);
  });
}
for (const btn of document.querySelectorAll('[data-view]')) {
  btn.addEventListener('click', () => viewer.setView(btn.dataset.view));
}

el('seamAngle').addEventListener('input', (e) => {
  state.seamAngle = Number(e.target.value);
  el('seamAngleVal').textContent = `${state.seamAngle}°`;
  syncSeamPresets();
});
el('seamAngle').addEventListener('change', async () => {
  if (!mask) return;
  await ensureParts({ force: true });
  updateSeams();
});
// Preset buttons: the named cuts, in one click each.
for (const btn of document.querySelectorAll('[data-seam]')) {
  btn.addEventListener('click', () => setSeamAngle(Number(btn.dataset.seam), { announce: true }));
}
el('showSeams').addEventListener('change', async () => {
  if (!mask) return;
  if (el('showSeams').checked) {
    await ensureParts();
    updateSeams();
    if (!parts.seams) setStatus('No seams at this angle — lower it to split the model into parts.');
  } else {
    clearSeams();
  }
});

el('overlayOpacity').addEventListener('input', (e) => {
  viewer.setOverlayOpacity(Number(e.target.value));
  el('overlayOpacityVal').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
});
el('showOverlay').addEventListener('change', (e) => viewer.setOverlayVisible(e.target.checked));
el('ghostShell').addEventListener('change', (e) => {
  if (mask) {
    mask.setBackdrop(e.target.checked);
    mask.flush();
  }
});
el('showBase').addEventListener('change', (e) => viewer.setBaseVisible(e.target.checked));
el('showGrid').addEventListener('change', (e) => viewer.setGridVisible(e.target.checked));
el('wireframe').addEventListener('change', (e) => viewer.setWireframe(e.target.checked));

el('upAxis').addEventListener('change', (e) => {
  state.upAxis = e.target.value;
  if (viewer.baseMesh) {
    viewer.setUpAxis(state.upAxis);
    setStatus(`Model oriented with ${state.upAxis.toUpperCase()} as up.`);
  }
});

el('navigateBtn').addEventListener('click', () => setNavigate(!state.navigate));
// Undo and redo walk the *selection*, not the tint: the tint is derived, so a history of tints
// could be undone into a picture the selection no longer describes.
el('undoBtn').addEventListener('click', () => {
  if (!cleanup.selection || !history.undo(cleanup.selection)) return;
  afterSelection(selectedFaces());
  setStatus(`Undo — ${fmt(selectedFaces())} of ${fmt(cleanup.selection.faces.length)} faces selected.`);
});
el('redoBtn').addEventListener('click', () => {
  if (!cleanup.selection || !history.redo(cleanup.selection)) return;
  afterSelection(selectedFaces());
  setStatus(`Redo — ${fmt(selectedFaces())} of ${fmt(cleanup.selection.faces.length)} faces selected.`);
});
el('selectAllBtn').addEventListener('click', selectAllFaces);
el('selectNoneBtn').addEventListener('click', selectNoFaces);
el('selectInvertBtn').addEventListener('click', invertPickedFaces);
el('removeFacesBtn').addEventListener('click', removeClicked);
el('restoreFacesBtn').addEventListener('click', () => void restoreRemovedFaces());
el('countModelsBtn').addEventListener('click', () => void ensureShells().then(reportShells));

el('trimBtn').addEventListener('click', trimWindows);
el('windowsBtn').addEventListener('click', () => listWindows());
el('centreOnGrid').addEventListener('change', onCentreToggle);

el('stencilBuildBtn').addEventListener('click', buildStencilClicked);
el('stencilClearBtn').addEventListener('click', discardStencil);
el('stencilExportBtn').addEventListener('click', exportStencilSTL);
el('stencilPreview').addEventListener('change', (e) => {
  if (stencil.mesh) stencil.mesh.visible = e.target.checked;
});

el('exportMaskBtn').addEventListener('click', exportMaskJSON);
el('exportPlyBtn').addEventListener('click', exportPLY);
el('importInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await importMaskFile(file);
  e.target.value = '';
});

// Drag an STL anywhere onto the viewport.
const viewport = el('viewport');
viewport.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewport.classList.add('dragover');
});
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
viewport.addEventListener('drop', async (e) => {
  e.preventDefault();
  viewport.classList.remove('dragover');
  const file = [...(e.dataTransfer?.files || [])].find((f) => /\.stl$/i.test(f.name));
  if (file) await loadFromBuffer(await file.arrayBuffer(), file.name);
});

// Keyboard shortcuts.
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const meta = e.ctrlKey || e.metaKey;

  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) el('redoBtn').click();
    else el('undoBtn').click();
    return;
  }
  if (meta && e.key.toLowerCase() === 'a') {
    // Select all, for the pick: the way to take a few models out of a file of many.
    e.preventDefault();
    selectAllFaces();
    return;
  }
  if (meta) return;

  switch (e.key.toLowerCase()) {
    case '?':
    case 'f1':
      // The guide each panel links to; also reachable from the top bar.
      e.preventDefault();
      openGuide();
      break;
    case 's':
      // Shift+S is the face half of the same tool: one selection, single triangles.
      setTool('select');
      setSelectScope(e.shiftKey ? 'faces' : 'models');
      break;
    case 'p': setTool('part'); break;
    case 'escape':
      if (selectDrag) cancelSelectDrag();
      else if (state.tool === 'select' && selectedFaces()) selectNoFaces();
      else hidePartCandidates();
      break;
    case 'i':
      // Shift+I inverts the selection: the window becomes everything except what was selected.
      if (e.shiftKey) invertPickedFaces();
      break;
    case 'b':
      // B builds: the whole point of selecting, one keystroke from the selection.
      el('stencilBuildBtn').click();
      break;
    case ' ': {
      if (!e.repeat) setNavigate(true);
      e.preventDefault();
      break;
    }
    default:
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') setNavigate(false);
});

// Boot: an empty app, waiting for a model.
//
// The bundled example is *not* fetched on start. Loading it automatically meant the first thing
// the app did was spend a second parsing and welding somebody else's model — and the session then
// began with a figure in it, which is wrong for the one job this tool has: select the windows on
// **your** model. The example is one click away (**Load example model**, which is the only place
// `DEFAULT_MODEL_URL` is used), and every panel already has an empty state.
setTool('select');
setSelectScope('faces');
setNavigate(false);
updateUndoButtons();
updateHud();
resetStencil();
setStatus(
  'Ready — nothing loaded yet. Drop an .stl anywhere, use “Open STL…”, or load the bundled ' +
    'example with “Load example model”.',
);
