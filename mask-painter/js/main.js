import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { Viewer } from './viewer.js';
import { MaskLayer } from './mask.js';
import { createFeatureList, nextFeatureId } from './features.js';
import * as io from './io.js';

// The example model that ships next to this app (repo root).
const DEFAULT_MODEL_URL = new URL('../Sprunki Mercuy.stl', location.href).href;

const el = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

const state = {
  features: createFeatureList(),
  currentFeatureId: 1,
  tool: 'brush',
  brushRadius: 3.2,
  mirrorX: false,
  mirrorPlaneX: 0,
  fillAngle: 60,
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
  viewer.setGeometry(geometry, { upAxis: state.upAxis, overlayGeometry });
  viewer.setGridVisible(el('showGrid').checked);
  const bvhMs = Math.round(performance.now() - tBvh);

  modelName = name;

  // Sensible defaults from the model's own size.
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const center = geometry.boundingBox.getCenter(new THREE.Vector3());
  const diag = size.length();
  state.brushRadius = Math.max(0.3, Math.round((diag / 40) * 10) / 10);
  el('brushRadius').value = String(Math.min(16, state.brushRadius));
  state.mirrorPlaneX = Math.round(center.x * 100) / 100;
  el('mirrorPlaneX').value = String(state.mirrorPlaneX);

  applyDisplayState();
  renderPalette();
  updateStats();
  updateHud();

  el('modelName').textContent =
    `${name} — ${fmt(triangles)} triangles · ${fmt(geometry.attributes.position.count)} vertices · ` +
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} units`;
  setLoading(false);
  setStatus(
    `Loaded ${name} in ${Math.round(performance.now() - t0)} ms (pick acceleration ${bvhMs} ms). ` +
    `Left-drag to paint “${featureById(state.currentFeatureId)?.name || 'feature'}”.`,
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
 * Feature under the cursor for the eyedropper: the painted neighbourhood around the hit
 * point votes, weighted by distance. Testing only the hit triangle's three vertices is
 * unreliable on dense meshes with coincident faces, where the nearest triangle can be
 * unpainted even though the surface under the cursor is painted.
 */
function featureUnderHit(hit) {
  if (!hit) return 0;
  const radius = Math.max(state.brushRadius, mask.estimateEdgeLength() * 2);
  const p = [hit.localPoint.x, hit.localPoint.y, hit.localPoint.z];
  const weights = new Map();
  mask.forEachVertexNear(p, radius, (i, d2) => {
    const id = mask.ids[i];
    if (!id) return;
    weights.set(id, (weights.get(id) || 0) + 1 / (d2 + 1e-6));
  });
  let best = 0;
  let bestW = 0;
  for (const [id, w] of weights) if (w > bestW) { bestW = w; best = id; }
  return best;
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

function onPointerDown(e) {
  if (!mask) return;
  if (e.button !== 0 || state.navigate || e.altKey || e.ctrlKey || e.metaKey) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit) return;
  e.preventDefault();

  if (state.tool === 'picker') {
    const id = featureUnderHit(hit);
    if (id) {
      state.currentFeatureId = id;
      renderPalette();
      updateHud();
      setStatus(`Picked “${featureById(id)?.name || id}”.`);
    } else {
      setStatus('Nothing painted under the cursor.');
    }
    return;
  }

  capturePointer(e.pointerId);

  if (state.tool === 'fill') {
    mask.beginStroke();
    const res = mask.fillFrom([hit.localPoint.x, hit.localPoint.y, hit.localPoint.z], {
      id: paintId(),
      angleLimitDeg: state.fillAngle,
      maxVertices: state.fillLimit,
      seedNormal: state.mirrorX ? null : hit.localNormal,
    });
    if (state.mirrorX) {
      mask.fillFrom([state.mirrorPlaneX * 2 - hit.localPoint.x, hit.localPoint.y, hit.localPoint.z], {
        id: paintId(),
        angleLimitDeg: state.fillAngle,
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
  updateCursor(hit);
  el('statusCursor').textContent = hit ? cursorText(hit.worldPoint) : '';
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
  else if (state.tool === 'picker') color = '#ffe066';
  else if (state.tool === 'fill') color = '#8affc1';
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
  el('hudTool').textContent = { brush: 'Brush', fill: 'Region fill', erase: 'Erase', picker: 'Pick' }[state.tool];
  el('hudRadius').textContent = `r ${state.brushRadius.toFixed(1)}`;
  el('brushRadiusVal').textContent = state.brushRadius.toFixed(1);
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll('.tool')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  el('fillOptions').classList.toggle('on', tool === 'fill');
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

// -------------------------------------------------------------- exports

function requireModel() {
  if (!mask) {
    setStatus('Load a model first.');
    return false;
  }
  return true;
}

function exportMaskJSON() {
  if (!requireModel()) return;
  const pairs = mask.paintedPairs();
  if (!pairs.length) {
    setStatus('Nothing painted yet — paint a feature first.');
    return;
  }
  const data = io.buildMaskJSON({ mask, features: state.features, modelName, pairs });
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  io.downloadBlob(`${io.safeBaseName(modelName)}-mask.json`, blob);
  setStatus(`Exported mask: ${fmt(pairs.length / 2)} painted vertices, ${fmt(data.features.length)} features (${(blob.size / 1048576).toFixed(1)} MB).`);
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
    const { data, features, pairs } = io.parseMaskJSON(text);
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
    setStatus(`Imported mask: ${fmt(pairs.length / 2)} painted vertices${added ? `, ${added} new features` : ''}.`);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`);
  }
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
el('fillAngle').addEventListener('input', (e) => {
  state.fillAngle = Number(e.target.value);
  el('fillAngleVal').textContent = `${state.fillAngle}°`;
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
  mask.clearFeature(id);
  mask.flush();
  updateStats();
  setStatus(`Cleared ${fmt(n)} vertices of “${featureById(id)?.name || id}”.`);
});
el('clearAllBtn').addEventListener('click', () => {
  if (!requireModel()) return;
  if (!window.confirm('Clear the whole mask? This can be undone with Ctrl+Z.')) return;
  mask.clearAll();
  mask.flush();
  updateStats();
  setStatus('Mask cleared.');
});
el('hideAllBtn').addEventListener('click', () => {
  if (!requireModel()) return;
  const anyVisible = state.features.some((f) => !mask.isHidden(f.id));
  for (const f of state.features) mask.setHidden(f.id, anyVisible);
  mask.flush();
  renderPalette();
  setStatus(anyVisible ? 'All paint hidden.' : 'All paint shown.');
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
    case 'b': setTool('brush'); break;
    case 'f': setTool('fill'); break;
    case 'e': setTool('erase'); break;
    case 'i': setTool('picker'); break;
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
renderPalette();
updateUndoButtons();
updateHud();
loadFromURL(DEFAULT_MODEL_URL);
