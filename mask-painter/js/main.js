import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { Viewer } from './viewer.js';
import { MaskLayer } from './mask.js';
import { createFeatureList, nextFeatureId } from './features.js';
import * as io from './io.js';
import { buildTopology, buildStencil, validateSolid, stencilDefaultsForDiagonal } from './stencil.js';
import { buildParts, partSoupVertices, partsNearPoint, DEFAULT_SEAM_ANGLE } from './parts.js';
import { paintedIslands, planIslandTrim } from './cleanup.js';

// The example model that ships next to this app (repo root).
const DEFAULT_MODEL_URL = new URL('../Sprunki Mercuy.stl', location.href).href;

const el = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

const TOOL_NAMES = { brush: 'Brush', fill: 'Region fill', part: 'Part', erase: 'Erase', picker: 'Pick' };

const state = {
  features: createFeatureList(),
  currentFeatureId: 1,
  tool: 'brush',
  lastPaintTool: 'brush',
  brushRadius: 3.2,
  mirrorX: false,
  mirrorPlaneX: 0,
  seamAngle: DEFAULT_SEAM_ANGLE,
  fillLimit: 200000,
  navigate: false,
  upAxis: 'y',
};

const canvas = el('canvas');
const viewer = new Viewer(canvas);
viewer.onFps = (fps) => {
  el('statusFps').textContent = `${fps} fps`;
};

let mask = null;
let modelName = '';
let stroke = null;

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
  paintPartAt,
  setSeamAngle,
  invertPaint,
  trimIslands,
  countIslands,
  setCentreOnGrid: (on) => viewer.setCentreOnGrid(on),
  islandIo: { paintedIslands, planIslandTrim },
  pickFeatureUnderPoint: (p, radius) => mask.featureUnderPoint(p, radius ?? maskedPickRadius()),
  openGuide,
  stencilOutOfDate,
  rebuildStencil,
  partsIo: { buildParts, partSoupVertices },
  stencilIo: { buildTopology, buildStencil, validateSolid },
  get stencil() {
    return stencil;
  },
  paintAt(x, y) {
    const hit = viewer.pick(x, y);
    if (!hit || !mask) return 0;
    mask.beginStroke();
    const n = paintHit(hit);
    mask.endStroke();
    mask.flush();
    updateStats();
    return n;
  },
};

// ---------------------------------------------------------------- helpers

const nextPaint = () =>
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

function featureById(id) {
  return state.features.find((f) => f.id === id) || null;
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

function paintId() {
  return state.tool === 'erase' ? 0 : state.currentFeatureId;
}

function screenRadiusPx(worldRadius, worldPoint) {
  const dist = viewer.camera.position.distanceTo(worldPoint);
  const halfFov = THREE.MathUtils.degToRad(viewer.camera.fov / 2);
  const rect = canvas.getBoundingClientRect();
  return (worldRadius / Math.max(dist * Math.tan(halfFov), 1e-6)) * (rect.height / 2);
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
  await nextPaint();

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

  setLoading(true, 'Preparing mask layer…');
  await nextPaint();

  const overlayGeometry = geometry.clone();
  mask = new MaskLayer(overlayGeometry, state.features);
  overlayGeometry.setAttribute('color', new THREE.BufferAttribute(mask.colors, 4));

  const triangles = geometry.attributes.position.count / 3;
  setLoading(true, `Building pick acceleration for ${fmt(triangles)} triangles…`);
  await nextPaint();

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

  // Sensible defaults from the model's own size.
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const center = geometry.boundingBox.getCenter(new THREE.Vector3());
  const diag = size.length();
  state.brushRadius = Math.max(0.3, Math.round((diag / 40) * 10) / 10);
  el('brushRadius').value = String(Math.min(16, state.brushRadius));
  state.mirrorPlaneX = Math.round(center.x * 100) / 100;
  el('mirrorPlaneX').value = String(state.mirrorPlaneX);

  el('seamAngleVal').textContent = `${state.seamAngle}°`;
applyDisplayState();
  renderPalette();
  updateStats();
  updateHud();

  el('modelName').textContent =
    `${name} — ${fmt(triangles)} triangles · ${fmt(geometry.attributes.position.count)} vertices · ` +
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} units`;
  setLoading(false);
  setStatus(
    `Loaded ${name} in ${Math.round(performance.now() - t0)} ms (pick acceleration ${bvhMs} ms); ` +
    `${centreNote()}. Left-drag to paint “${featureById(state.currentFeatureId)?.name || 'feature'}”.`,
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

// ------------------------------------------------------------- painting

function paintHit(hit) {
  const id = paintId();
  const r = state.brushRadius;
  const p = [hit.localPoint.x, hit.localPoint.y, hit.localPoint.z];
  let changed = mask.paintSphere(p, r, id);
  if (state.mirrorX) {
    changed += mask.paintSphere([state.mirrorPlaneX * 2 - p[0], p[1], p[2]], r, id);
  }
  return changed;
}

/**
 * Feature under the cursor for the eyedropper. The vote itself lives in the mask
 * (`featureUnderPoint`), which is also what the hover preview uses, so what the ring shows
 * before a click is exactly what the click picks.
 */
function featureUnderHit(hit) {
  if (!hit) return { id: 0, painted: 0 };
  const radius = maskedPickRadius();
  return mask.featureUnderPoint([hit.localPoint.x, hit.localPoint.y, hit.localPoint.z], radius);
}

/** How far the eyedropper looks: the brush, or a couple of mesh steps, whichever is larger. */
function maskedPickRadius() {
  return Math.max(state.brushRadius, mask.estimateEdgeLength() * 2);
}

/**
 * The eyedropper. Picking changes nothing about the model, so the feedback has to be
 * deliberate: the hover preview has already put the candidate feature's colour on the ring,
 * this reports the feature and how much of it is under the cursor, and — unless you hold
 * Shift — the tool hands back to whatever you were painting with, so the pick is something
 * you can use immediately.
 */
function pickAt(hit, { stay = false } = {}) {
  const { id, painted } = featureUnderHit(hit);
  if (!id) {
    setStatus(
      painted
        ? 'Nothing painted under the cursor — that feature is painted elsewhere on the model.'
        : 'Nothing painted under the cursor — paint an area first (Brush, Region fill or Part), then pick its feature.',
    );
    return 0;
  }
  state.currentFeatureId = id;
  const name = featureById(id)?.name || String(id);
  const total = mask.stats().counts.get(id) || 0;
  renderPalette();
  if (stay) {
    updateHud();
    setStatus(`Picked “${name}” — ${fmt(total)} vertices painted with it. Shift-click to keep picking.`);
  } else {
    const back = state.lastPaintTool === 'picker' ? 'brush' : state.lastPaintTool;
    setTool(back);
    setStatus(
      `Picked “${name}” (${fmt(total)} vertices). Now painting with it as the ${TOOL_NAMES[back]} — ` +
        'Shift-click with Pick to sample several areas without switching back.',
    );
  }
  return id;
}

function paintSegment(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.min(24, Math.max(2, screenRadiusPx(state.brushRadius, lastWorldPoint || viewer.viewCenter || new THREE.Vector3()) * 0.35));
  const n = Math.min(64, Math.max(1, Math.ceil(dist / step)));
  const minSkip = (state.brushRadius * 0.25) ** 2;
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const hit = viewer.pick(from.x + dx * t, from.y + dy * t);
    if (!hit) continue;
    if (lastWorldPoint && hit.worldPoint.distanceToSquared(lastWorldPoint) < minSkip) continue;
    lastWorldPoint = hit.worldPoint;
    stroke.changed += paintHit(hit);
    updateCursor(hit);
  }
  mask.flush();
  updateHud();
}

let lastWorldPoint = null;

/**
 * Only the Part tool does anything with modifier clicks (Shift adds a panel, Alt/Ctrl removes
 * one). For every other tool a modifier click means "not painting" and is ignored — but it
 * must be ignored *here*, after this test, or Alt-click never reaches the Part tool.
 */
function modifierClickIgnored(e) {
  return (e.altKey || e.ctrlKey || e.metaKey) && state.tool !== 'part';
}

function onPointerDown(e) {
  if (!mask) return;
  if (e.button !== 0 || state.navigate || modifierClickIgnored(e)) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit) {
    if (state.tool === 'picker') setStatus('Nothing under the cursor — click on the model surface.');
    return;
  }
  e.preventDefault();

  if (state.tool === 'picker') {
    pickAt(hit, { stay: e.shiftKey });
    return;
  }

  if (state.tool === 'part') {
    partClick(e);
    return;
  }

  capturePointer(e.pointerId);

  if (state.tool === 'fill') {
    mask.beginStroke();
    const res = mask.fillFrom([hit.localPoint.x, hit.localPoint.y, hit.localPoint.z], {
      id: paintId(),
      angleLimitDeg: state.seamAngle,
      maxVertices: state.fillLimit,
      seedNormal: state.mirrorX ? null : hit.localNormal,
    });
    if (state.mirrorX) {
      mask.fillFrom([state.mirrorPlaneX * 2 - hit.localPoint.x, hit.localPoint.y, hit.localPoint.z], {
        id: paintId(),
        angleLimitDeg: state.seamAngle,
        maxVertices: state.fillLimit,
        seedNormal: null,
      });
    }
    mask.endStroke();
    mask.flush();
    updateStats();
    setStatus(
      `Region fill: ${fmt(res.changed)} vertices${res.truncated ? ' (hit the max-vertex limit)' : ''}.`,
    );
    return;
  }

  mask.beginStroke();
  stroke = { pointerId: e.pointerId, last: { x: e.clientX, y: e.clientY }, changed: 0 };
  lastWorldPoint = hit.worldPoint;
  stroke.changed += paintHit(hit);
  updateCursor(hit);
  mask.flush();
}

function onPointerMove(e) {
  if (!mask) return;
  if (stroke) {
    paintSegment(stroke.last, { x: e.clientX, y: e.clientY });
    stroke.last = { x: e.clientX, y: e.clientY };
    el('statusCursor').textContent = cursorText(lastWorldPoint);
    return;
  }
  const hit = viewer.pick(e.clientX, e.clientY);
  // With the eyedropper the ring shows the candidate *before* the click, so the tool reads
  // as alive even when the click would change nothing (picking the feature you already have).
  hoverPick = hit && state.tool === 'picker' ? featureUnderHit(hit) : null;
  updateCursor(hit);
  el('statusCursor').textContent = hit ? cursorText(hit.worldPoint) + pickHint() : '';
}

let hoverPick = null;

function pickHint() {
  if (state.tool !== 'picker') return '';
  if (!hoverPick || !hoverPick.id) return '  ·  Pick: nothing painted';
  const f = featureById(hoverPick.id);
  return `  ·  Pick: ${f?.name || hoverPick.id} (click to paint with it)`;
}

function cursorText(p) {
  if (!p) return '';
  return `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`;
}

function endStroke() {
  if (!stroke) return;
  releasePointer(stroke.pointerId);
  stroke = null;
  const recorded = mask.endStroke();
  mask.flush();
  if (recorded) updateStats();
  updateUndoButtons();
}

function updateCursor(hit) {
  if (!hit) {
    viewer.hideCursor();
    return;
  }
  let color = '#ffffff';
  if (state.tool === 'erase') color = '#ff8a8a';
  else if (state.tool === 'picker') {
    // The feature under the cursor, so the ring previews exactly what a click would pick.
    color = hoverPick && hoverPick.id ? featureById(hoverPick.id)?.color || '#ffe066' : '#6d747d';
  }
  else if (state.tool === 'fill') color = '#8affc1';
  else if (state.tool === 'part') color = '#ffd24d';
  else if (featureById(state.currentFeatureId)) color = featureById(state.currentFeatureId).color;
  viewer.setCursor({
    point: hit.worldPoint,
    normal: hit.worldNormal,
    radius: state.brushRadius,
    color,
  });
}

// ------------------------------------------------------------------- UI

function renderPalette() {
  const wrap = el('palette');
  wrap.textContent = '';
  state.features.forEach((f, index) => {
    const row = document.createElement('div');
    row.className = 'feature';
    if (f.id === state.currentFeatureId) row.classList.add('active');
    if (mask && mask.isHidden(f.id)) row.classList.add('off');
    row.title = index < 9 ? `Press ${index + 1} to select “${f.name}”` : f.name;

    const sw = document.createElement('i');
    sw.className = 'swatch';
    sw.style.background = f.color;

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.name;

    const count = document.createElement('span');
    count.className = 'fcount';
    count.dataset.id = String(f.id);
    count.textContent = '0';

    const hide = document.createElement('button');
    hide.className = 'mini';
    hide.textContent = mask && mask.isHidden(f.id) ? '◌' : '◉';
    hide.title = 'Hide or show this feature’s paint';
    hide.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFeatureHidden(f.id);
    });

    const remove = document.createElement('button');
    remove.className = 'mini';
    remove.textContent = '✕';
    remove.title = 'Remove this feature from the palette';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeFeature(f.id);
    });

    row.addEventListener('click', () => {
      state.currentFeatureId = f.id;
      renderPalette();
      updateHud();
    });

    row.append(sw, name, count, hide, remove);
    wrap.appendChild(row);
  });
}

function toggleFeatureHidden(id) {
  if (!mask) return;
  mask.setHidden(id, !mask.isHidden(id));
  mask.flush();
  renderPalette();
}

function removeFeature(id) {
  const stats = mask ? mask.stats().counts.get(id) || 0 : 0;
  if (stats > 0 && !window.confirm(`“${featureById(id)?.name}” has ${fmt(stats)} painted vertices. Remove it and clear that paint?`)) {
    return;
  }
  const entry = { type: 'snapshot', ids: mask.ids.slice() };
  state.features = state.features.filter((f) => f.id !== id);
  if (mask) {
    mask.clearFeature(id, { record: false });
    mask.history.push(entry);
    mask.redoStack.length = 0;
    mask.setFeatures(state.features);
    mask.flush();
  }
  if (state.currentFeatureId === id) state.currentFeatureId = state.features[0]?.id ?? 0;
  renderPalette();
  updateStats();
  updateHud();
}

function addFeature() {
  const nameInput = el('featureName');
  const colorInput = el('featureColor');
  const name = nameInput.value.trim() || `Feature ${state.features.length + 1}`;
  const feature = { id: nextFeatureId(state.features), name, color: colorInput.value };
  state.features.push(feature);
  state.currentFeatureId = feature.id;
  if (mask) mask.setFeatures(state.features);
  nameInput.value = '';
  renderPalette();
  updateStats();
  updateHud();
  setStatus(`Added feature “${name}”.`);
}

function updateStats() {
  if (!mask) return;
  const s = mask.stats();
  el('paintStats').textContent =
    `${fmt(s.painted)} of ${fmt(s.total)} vertices painted ` +
    `(${((s.painted / s.total) * 100).toFixed(1)}% of the mask).`;
  for (const node of document.querySelectorAll('.fcount')) {
    node.textContent = fmt(s.counts.get(Number(node.dataset.id)) || 0);
  }
  const current = s.counts.get(state.currentFeatureId) || 0;
  const clearBtn = el('clearFeatureBtn');
  clearBtn.disabled = current === 0;
  clearBtn.title = current
    ? `Clear the ${fmt(current)} vertices painted as “${featureById(state.currentFeatureId)?.name || ''}” (Ctrl+Z undoes it)`
    : 'The selected feature has no paint to clear';
  if (stencil.result) updateStencilStats(s.painted);
  updateUndoButtons();
}

function updateUndoButtons() {
  el('undoBtn').disabled = !mask || !mask.canUndo();
  el('redoBtn').disabled = !mask || !mask.canRedo();
}

function updateHud() {
  const chip = el('hudFeature');
  const painted = featureById(state.currentFeatureId);
  const erasing = state.tool === 'erase';
  chip.querySelector('.swatch').style.background = erasing ? '#ff8a8a' : painted?.color || '#666';
  chip.querySelector('span').textContent = erasing ? 'Erasing' : painted?.name || '—';
  el('hudTool').textContent = TOOL_NAMES[state.tool];
  el('hudRadius').textContent = `r ${state.brushRadius.toFixed(1)}`;
  el('brushRadiusVal').textContent = state.brushRadius.toFixed(1);
}

function setTool(tool) {
  // Remembered so the eyedropper can hand back to it after a pick.
  if (tool !== 'picker') state.lastPaintTool = tool;
  state.tool = tool;
  for (const b of document.querySelectorAll('.tool')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  el('fillOptions').classList.toggle('on', tool === 'fill');
  el('seamOptions').classList.toggle('on', tool === 'fill' || tool === 'part');
  hoverPick = null;
  // The panel list belongs to the click that produced it, not to the next tool.
  if (tool !== 'part') hidePartCandidates();
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
  viewer.setPointerMode(on ? 'navigate' : 'paint');
  el('navigateBtn').textContent = `Navigate: ${on ? 'on' : 'off'}`;
  el('navigateBtn').classList.toggle('active', on);
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

/** Every painted vertex, whichever feature it belongs to. The window is all of them. */
function paintedMask() {
  const painted = new Uint8Array(mask.vertexCount);
  let count = 0;
  for (let i = 0; i < painted.length; i += 1) {
    if (mask.ids[i] !== 0) {
      painted[i] = 1;
      count += 1;
    }
  }
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
  await nextPaint();
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
    await nextPaint();
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
 * Paints one seam-bounded part. A plain click replaces the current feature's paint with the
 * part (the lasso "select this"), Shift adds another part, Alt removes one.
 *
 * `near` is where the click landed, in model space; it is only used to rank the other panels
 * that meet this one, which the panel offers as alternatives (see `renderPartCandidates`).
 */
function paintPartAt(faceIndex, { add = false, remove = false, near = null } = {}) {
  const d = parts.data;
  const topology = stencil.topology;
  if (!d || !topology || faceIndex == null || faceIndex < 0 || faceIndex >= d.facePart.length) return 0;
  return applyPartSelection(d.facePart[faceIndex], { add, remove, near });
}

function applyPartSelection(partId, { add = false, remove = false, near = null } = {}) {
  const d = parts.data;
  const topology = stencil.topology;
  if (!d || !topology || !(partId >= 0)) return 0;
  const indices = partSoupVertices(d, partId, partScratch);
  const featureId = remove ? 0 : state.currentFeatureId;
  mask.beginStroke();
  if (!add && !remove) mask.paintIndices(mask.verticesOf(state.currentFeatureId, paintScratch), 0);
  const changed = mask.paintIndices(indices, featureId);
  const recorded = mask.endStroke();
  mask.flush();
  updateStats();

  const faces = d.partSizes[partId];
  const share = faces / topology.faceCount;
  const name = featureById(state.currentFeatureId)?.name || 'feature';
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
      `${fmt(changed)} vertices painted${remove ? '' : ` as “${name}”`} (seams at ${d.seamAngleDeg}°).` +
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
    el('partInfo').textContent =
      `Part ${partId + 1} is ${(share * 100).toFixed(0)}% of the model — ` +
      (finer
        ? `click one of the smaller panels in the list, or press ${finer.label} (${finer.angle}°) to cut the model finer.`
        : 'click one of the smaller panels in the list.');
  } else {
    reportParts();
  }
  return recorded ? changed : 0;
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
  // How far to look: a few mesh steps, never less than the brush the user is used to.
  const radius = Math.max(state.brushRadius, topology.meanEdgeLength * 4);
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
    btn.title = `Select this panel (${fmt(n.faces)} faces) with the current feature`;
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
let paintScratch = [];

async function partClick(e) {
  if (!mask) return;
  const d = await ensureParts();
  if (!d) return;
  // faceIndex is the hit triangle in the file's own face order — the order the panels were cut
  // in. The BVH's own index counts in its internal order instead (see viewer.sourceTriangleIndex),
  // and feeding that to facePart paints an unrelated panel, which reads as the tool ignoring
  // your click.
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit || hit.faceIndex == null) return;
  updateSeams();
  paintPartAt(hit.faceIndex, {
    add: e.shiftKey,
    remove: e.altKey || e.ctrlKey || e.metaKey,
    near: hit.localPoint,
  });
}

async function buildStencilPart() {
  if (!requireModel()) return null;
  const { painted, count } = paintedMask();
  if (!count) {
    setStatus('Nothing painted yet — paint the area the mask should expose, then build.');
    return null;
  }

  const t0 = performance.now();
  await ensureTopology();
  const weldMs = performance.now() - t0;

  const params = stencilParamsFromInputs();
  setLoading(true, `Building the mask around ${fmt(count)} painted vertices…`);
  await nextPaint();
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
    `Stencil discarded${triangles ? ` (${fmt(triangles)} triangles)` : ''}. The mask is untouched — ` +
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
    lines.push('⚠ the mask has been repainted since this was built — build again to match it, or “Discard stencil” to throw this one away.');
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
      setStatus('Nothing painted yet — paint the windows, build the stencil, then export.');
      return;
    }
    let res = stencil.result;
    let rebuilt = false;
    if (!res || stencilOutOfDate()) {
      setStatus('The mask has changed since the last build — building again before exporting…');
      res = await rebuildStencil();
      if (!res) return;
      if (!res.ok) {
        setStatus(`Nothing exported: the stencil could not be built (${res.warnings[0]}).`);
        return;
      }
      rebuilt = true;
    }
    const { buffer, triangles, bytes } = io.buildBinarySTL(res.positions, res.indices);
    io.downloadBlob(`${io.safeBaseName(modelName)}-paint-stencil.stl`, new Blob([buffer], { type: 'model/stl' }));
    const s = res.stats;
    setStatus(
      `Exported paint stencil: ${fmt(triangles)} triangles (${(bytes / 1048576).toFixed(1)} MB), ` +
        `${s.windowLoops} window${s.windowLoops === 1 ? '' : 's'} in ` +
        `${s.components === 1 ? 'one piece' : `${s.components} pieces`}` +
        (rebuilt
          ? ' — rebuilt from the current mask first, because the paint had changed since the last build.'
          : '.'),
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
 * Saves the painting as a session file: the windows (the painted vertices), the palette and the
 * build settings, so it can be opened again later on the same model and carried on from there.
 */
function exportMaskJSON() {
  if (!requireModel()) return;
  const pairs = mask.paintedPairs();
  if (!pairs.length) {
    setStatus('Nothing painted yet — paint a feature first.');
    return;
  }
  const data = io.buildMaskJSON({
    mask,
    features: state.features,
    modelName,
    pairs,
    stencil: stencilSettings(),
  });
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  io.downloadBlob(`${io.safeBaseName(modelName)}-mask.json`, blob);
  setStatus(
    `Saved mask: ${fmt(pairs.length / 2)} painted vertices, ${fmt(data.features.length)} features ` +
      `(${(blob.size / 1048576).toFixed(1)} MB). “Open mask (JSON)” brings it back to carry on.`,
  );
}

function exportPLY() {
  if (!requireModel()) return;
  const { blob, triangles, vertices } = io.buildPLY(mask);
  if (!triangles) {
    setStatus('Nothing painted yet — paint a feature first.');
    return;
  }
  io.downloadBlob(`${io.safeBaseName(modelName)}-mask.ply`, blob);
  setStatus(`Exported painted shell: ${fmt(triangles)} triangles, ${fmt(vertices)} vertices (${(blob.size / 1048576).toFixed(1)} MB).`);
}

async function importMaskFile(file) {
  if (!requireModel()) return;
  try {
    const text = await file.text();
    const { data, features, pairs, stencil: savedStencil } = io.parseMaskJSON(text);
    if (data.vertexCount && data.vertexCount !== mask.vertexCount) {
      setStatus(
        `Warning: mask was painted on ${fmt(data.vertexCount)} vertices but this model has ${fmt(mask.vertexCount)}.`,
      );
    }
    const known = new Set(state.features.map((f) => f.id));
    let added = 0;
    for (const f of features) {
      if (!known.has(f.id)) {
        state.features.push(f);
        known.add(f.id);
        added += 1;
      }
    }
    mask.setFeatures(state.features);
    mask.loadPairs(pairs);
    mask.flush();
    renderPalette();
    updateStats();
    // A loaded mask is not the mask the build in the panel was made from, whatever the counts
    // say, so the panel has to be told to compare them rather than left showing old numbers.
    updateStencilStats();
    const settings = applyStencilSettings(savedStencil);
    setStatus(
      `Loaded mask: ${fmt(pairs.length / 2)} painted vertices${added ? `, ${added} new feature${added === 1 ? '' : 's'}` : ''}` +
        `${settings ? ', build settings restored' : ''}, on “${featureById(state.currentFeatureId)?.name || 'feature'}”. ` +
        'Shift-click more panels with the Part tool, then build again to see the windows.',
    );
  } catch (err) {
    setStatus(`Import failed: ${err.message}`);
  }
}

/**
 * Invert the mask: everything painted is released and everything not painted takes the current
 * feature. This is the escape hatch for "I meant the other thing" — a click can only select the
 * panel it lands on, and the complement is usually what the other thing is.
 */
function invertPaint() {
  if (!requireModel()) return;
  const id = state.currentFeatureId;
  if (!id || !featureById(id)) {
    setStatus('Select a feature first — the inverted paint needs a colour to use.');
    return;
  }
  const { cleared, painted } = mask.invert(id);
  mask.flush();
  updateStats();
  if (!cleared && !painted) {
    setStatus('Nothing to invert — the mask covers everything already; Ctrl+Z undoes an invert.');
    return;
  }
  const name = featureById(id)?.name || '';
  setStatus(
    `Inverted the mask: ${fmt(painted)} vertices now painted as “${name}”, ${fmt(cleared)} released. ` +
      'Ctrl+Z brings the previous mask back.',
  );
}

/**
 * The painted islands of the mask, for the count and the trim below.
 *
 * Both go through this so the numbers they report cannot disagree, and the threshold is read
 * from the panel every time rather than remembered, so raising it and pressing the button twice
 * trims harder the second time.
 */
async function analyseIslands() {
  if (!requireModel()) return null;
  const painted = mask.stats().painted;
  if (!painted) {
    setStatus('Nothing painted yet — paint the area the mask should expose first.');
    return null;
  }
  const percent = Math.max(0, Math.min(50, Number(el('trimPercent').value) || 0));
  const topology = await ensureTopology();
  const t0 = performance.now();
  const plan = planIslandTrim({
    topology,
    ids: mask.ids,
    minDiagonal: (percent / 100) * topology.diagonal,
  });
  return { plan, percent, topology, painted, ms: Math.round(performance.now() - t0) };
}

/**
 * The dry run: how many painted islands there are and which of them a trim would release.
 * Sizes are the islands' bounding boxes, because that is what the threshold is measured in —
 * a spec is a size on the print, not a vertex count (the same spec is 40 vertices on a coarse
 * mesh and 4,000 on a dense one).
 */
async function countIslands() {
  const got = await analyseIslands();
  if (!got) return;
  const { plan, percent, topology, ms } = got;
  const largest = plan.details[0];
  const smallest = plan.details[plan.details.length - 1];
  setStatus(
    `${fmt(plan.islands)} painted island${plan.islands === 1 ? '' : 's'} (${fmt(got.painted)} vertices): ` +
      `largest ${fmt(largest.vertices)} vertices, ${largest.diagonal.toFixed(2)} units across; smallest ` +
      `${fmt(smallest.vertices)} vertices, ${smallest.diagonal.toFixed(2)} across. At under ` +
      `${plan.threshold.toFixed(2)} units (${percent}% of the model's ${topology.diagonal.toFixed(1)}-unit diagonal) ` +
      `a trim would release ${fmt(plan.doomedIslands)} of them` +
      `${plan.doomedIslands ? ` (${fmt(plan.doomedVertices)} vertices)` : ''} — each island is its own window ` +
      `in the built stencil. (${ms} ms)`,
  );
}

/**
 * Releases the painted islands a printer cannot use: the specks and stray dabs that would
 * otherwise each become another window, and often another loose piece, in the exported stencil.
 *
 * One undo step, like every other mask edit, and the largest island is always kept — a threshold
 * set too high can shrink a mask to its main region but never wipe it out. The rest of the mask
 * is untouched, and a built stencil is left in the viewport with the panel saying it is stale.
 */
async function trimIslands() {
  const got = await analyseIslands();
  if (!got) return;
  const { plan, percent, topology } = got;
  const plural = (n) => (n === 1 ? '' : 's');
  if (!plan.doomedIslands) {
    const smallest = plan.details[plan.details.length - 1];
    setStatus(
      `Nothing to trim: ${fmt(plan.islands)} island${plural(plan.islands)}, the smallest ` +
        `${smallest.diagonal.toFixed(2)} units across, and none is under ${plan.threshold.toFixed(2)} ` +
        `(${percent}% of the model's ${topology.diagonal.toFixed(1)}-unit diagonal). Raise the threshold ` +
        'to trim harder, or press “Count islands” to see their sizes.'
    );
    return;
  }
  mask.beginStroke();
  const changed = mask.paintIndices(plan.released, 0);
  const recorded = mask.endStroke();
  mask.flush();
  updateStats();
  updateStencilStats();
  const kept = plan.islands - plan.doomedIslands;
  setStatus(
    `Trimmed ${fmt(plan.doomedIslands)} island${plural(plan.doomedIslands)} under ` +
      `${plan.threshold.toFixed(2)} units (${percent}% of size): ${fmt(changed)} vertices released, ` +
      `${((changed / got.painted) * 100).toFixed(1)}% of the mask. ${fmt(kept)} island${plural(kept)} left, ` +
      `the largest ${fmt(plan.largestVertices)} vertices. Ctrl+Z brings them back.` +
      (plan.sparedLargest ? ' The largest island is under the threshold too, so it was kept.' : '') +
      (stencil.result ? ' The built stencil is still in the viewport — build again to match the trimmed mask.' : ''),
  );
  if (!recorded) setStatus('Nothing was released — the islands were already unpainted.');
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
canvas.addEventListener('pointerleave', (e) => {
  if (!stroke) {
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
el('addFeatureBtn').addEventListener('click', addFeature);
el('featureName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFeature();
});

for (const btn of document.querySelectorAll('.tool')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
}
for (const btn of document.querySelectorAll('[data-view]')) {
  btn.addEventListener('click', () => viewer.setView(btn.dataset.view));
}

el('brushRadius').addEventListener('input', (e) => {
  state.brushRadius = Number(e.target.value);
  updateHud();
});
el('mirrorX').addEventListener('change', (e) => {
  state.mirrorX = e.target.checked;
});
el('mirrorPlaneX').addEventListener('input', (e) => {
  state.mirrorPlaneX = Number(e.target.value) || 0;
});
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
el('fillLimit').addEventListener('input', (e) => {
  state.fillLimit = Math.max(1000, Number(e.target.value) || 200000);
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
el('undoBtn').addEventListener('click', () => {
  if (mask?.undo()) {
    mask.flush();
    updateStats();
    setStatus('Undo.');
  }
});
el('redoBtn').addEventListener('click', () => {
  if (mask?.redo()) {
    mask.flush();
    updateStats();
    setStatus('Redo.');
  }
});
el('clearFeatureBtn').addEventListener('click', () => {
  if (!requireModel()) return;
  const id = state.currentFeatureId;
  const n = mask.stats().counts.get(id) || 0;
  if (!n) {
    setStatus(`Nothing painted for “${featureById(id)?.name || id}” — nothing to clear.`);
    return;
  }
  mask.clearFeature(id);
  mask.flush();
  updateStats();
  setStatus(`Cleared ${fmt(n)} vertices of “${featureById(id)?.name || id}”.`);
});
// Two clicks rather than window.confirm: a confirm dialog is silently blocked in some
// embedded browser views, which made the button look broken instead of asking.
let clearAllArmedAt = 0;
el('clearAllBtn').addEventListener('click', () => {
  if (!requireModel()) return;
  if (!mask.stats().painted) {
    setStatus('Nothing painted yet.');
    return;
  }
  const now = performance.now();
  if (now - clearAllArmedAt > 4000) {
    clearAllArmedAt = now;
    el('clearAllBtn').textContent = 'Click again to clear';
    setStatus('Click “Clear all” again within 4 seconds to wipe the whole mask (Ctrl+Z undoes it).');
    return;
  }
  clearAllArmedAt = 0;
  el('clearAllBtn').textContent = 'Clear all';
  const n = mask.stats().painted;
  mask.clearAll();
  mask.flush();
  updateStats();
  setStatus(
    `Mask cleared (${fmt(n)} vertices). Ctrl+Z brings it back.` +
      (stencil.result
        ? ' The built stencil is still in the viewport — “Discard stencil” removes it, or paint and build again.'
        : ''),
  );
});
el('hideAllBtn').addEventListener('click', () => {
  if (!requireModel()) return;
  if (!mask.stats().painted) {
    setStatus('Nothing painted yet.');
    return;
  }
  const anyVisible = state.features.some((f) => !mask.isHidden(f.id));
  for (const f of state.features) mask.setHidden(f.id, anyVisible);
  mask.flush();
  renderPalette();
  setStatus(anyVisible ? 'All paint hidden.' : 'All paint shown.');
});

el('invertBtn').addEventListener('click', invertPaint);
el('trimBtn').addEventListener('click', trimIslands);
el('islandInfoBtn').addEventListener('click', countIslands);
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
  if (meta) return;

  switch (e.key.toLowerCase()) {
    case '?':
    case 'f1':
      // The guide each panel links to; also reachable from the top bar.
      e.preventDefault();
      openGuide();
      break;
    case 'b': setTool('brush'); break;
    case 'f': setTool('fill'); break;
    case 'e': setTool('erase'); break;
    case 'i':
      // Shift+I is the invert; I on its own is the eyedropper.
      if (e.shiftKey) invertPaint();
      else setTool('picker');
      break;
    case 'p': setTool('part'); break;
    case 'm':
      el('mirrorX').checked = !el('mirrorX').checked;
      state.mirrorX = el('mirrorX').checked;
      setStatus(state.mirrorX ? 'Mirror painting on.' : 'Mirror painting off.');
      break;
    case '[':
    case ']': {
      const delta = e.key === '[' ? -0.4 : 0.4;
      state.brushRadius = Math.min(16, Math.max(0.2, state.brushRadius + delta));
      el('brushRadius').value = String(state.brushRadius);
      updateHud();
      break;
    }
    case ' ': {
      if (!e.repeat) setNavigate(true);
      e.preventDefault();
      break;
    }
    default: {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const f = state.features[n - 1];
        if (f) {
          state.currentFeatureId = f.id;
          renderPalette();
          updateHud();
        }
      }
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') setNavigate(false);
});

// Boot: try the example model, degrade gracefully if it is not reachable.
setTool('brush');
setNavigate(false);
syncSeamPresets();
renderPalette();
updateUndoButtons();
updateHud();
resetStencil();
loadFromURL(DEFAULT_MODEL_URL);
