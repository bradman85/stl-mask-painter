// Static check of the UI wiring: every element id main.js looks up must exist in index.html,
// and every id the panel defines should be reachable. This is what breaks silently when a
// button is added in one file and not the other.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../index.html'), 'utf8');
const js = fs.readFileSync(path.resolve(here, '../js/main.js'), 'utf8');

const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
const queried = [...js.matchAll(/querySelector(?:All)?\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const missing = [...used].filter((id) => !declared.has(id)).sort();
check('every el(...) lookup exists in index.html', missing.length === 0, missing.join(', '));

// Attribute selectors such as [data-view] must match something in the markup; class and
// tag selectors are checked by presence of the string.
const attributeSelectors = queried.filter((q) => q.startsWith('[data-'));
check(
  'the selectors main.js queries are present in the markup',
  attributeSelectors.every((q) => html.includes(q.slice(1, -1))),
  queried.join(' | '),
);

// The app has to open empty. Auto-loading the bundled example on boot meant the first second of
// every session went on parsing and welding a model the user did not ask for, and the mask
// session started with somebody else's figure in it. `Load example model` is the only caller of
// `loadFromURL(DEFAULT_MODEL_URL)`; boot has to end at a status line that says what to do instead.
check(
  'the app does not load the example model on boot',
  (js.match(/loadFromURL\(DEFAULT_MODEL_URL\)/g) || []).length === 1 &&
    !/^\s*loadFromURL\(DEFAULT_MODEL_URL\);\s*$/m.test(js),
  `${(js.match(/loadFromURL\(DEFAULT_MODEL_URL\)/g) || []).length} call site(s)`,
);
check(
  'the example model is behind its button, and only there',
  /el\('loadExampleBtn'\)\.addEventListener\('click', \(\) => loadFromURL\(DEFAULT_MODEL_URL\)\)/.test(js) &&
    /id="loadExampleBtn"/.test(html),
);
check(
  'and an empty app says how to get a model in',
  /resetStencil\(\);\s*\n\s*setStatus\(\s*\n\s*'Ready — nothing loaded yet\. Drop an \.stl anywhere, use “Open STL…”, or load the bundled '/.test(js) &&
    /Load example model/.test(js),
);
check(
  'the empty states the app opens with are still in the markup',
  />no model loaded</.test(html) && /No model loaded\./.test(html),
);

const stencilIds = ['stencilBuildBtn', 'stencilClearBtn', 'stencilExportBtn', 'stencilPreview', 'stencilReach', 'stencilWall', 'stencilStandoff', 'stencilOverhang', 'stencilStats'];
const missingStencil = stencilIds.filter((id) => !declared.has(id));
check('the stencil panel is complete', missingStencil.length === 0, missingStencil.join(', '));

// The build has to be removable: clearing the mask used to leave the shell in the viewport with
// no button to drop it, so the only way to get a clean slate was to load the model again.
check(
  'a built stencil can be discarded without reloading the model',
  /el\('stencilClearBtn'\)\.addEventListener\('click', discardStencil\)/.test(js),
);
check(
  'discard drops the preview, the result and the export it enabled',
  /function discardStencil\(\)[\s\S]{0,600}?clearStencilPreview\(\)[\s\S]{0,200}?stencil\.result = null[\s\S]{0,200}?stencilExportBtn'\)\.disabled = true/.test(js),
);
check(
  'the button follows the build: on after a success, off on a refusal, a discard or a new model',
  (js.match(/stencilClearBtn'\)\.disabled = true/g) || []).length >= 3 &&
    /stencilClearBtn'\)\.disabled = false/.test(js),
);
check(
  'clearing the mask names the stencil it leaves behind',
  /Mask cleared[\s\S]{0,200}?Discard stencil/.test(js),
);
check(
  'a stale build points at both ways out',
  /repainted since this was built[\s\S]{0,120}?Discard stencil/.test(js),
);

const exported = ['buildTopology', 'buildStencil', 'validateSolid', 'stencilDefaultsForDiagonal'];
const stencilSrc = fs.readFileSync(path.resolve(here, '../js/stencil.js'), 'utf8');
const missingExports = exported.filter((name) => !new RegExp(`export function ${name}\\b`).test(stencilSrc));
check('main.js only imports exports stencil.js really has', missingExports.length === 0, missingExports.join(', '));

check(
  'main.js imports the stencil module',
  /from '\.\/stencil\.js'/.test(js),
  (js.match(/import \{[^}]*\} from '\.\/stencil\.js'/) || [''])[0],
);

// ------------------------------------------------------------------ tool wiring
//
// The Pick tool lives in the DOM layer, so the parts of it that can go wrong silently are
// checked here by source: that the vote it shows while hovering is the same call the click
// makes, that the click hands control back to the previous paint tool, and that the modifier
// guard cannot swallow Alt-click before the Part tool sees it (it did, once).
const maskSrc = fs.readFileSync(path.resolve(here, '../js/mask.js'), 'utf8');

check('the picker vote lives in the mask, where it is tested', /featureUnderPoint\(p, radius\)/.test(maskSrc));
check('main.js uses the mask vote instead of reimplementing it',
  /mask\.featureUnderPoint\(/.test(js) && !/const weights = new Map\(\)/.test(js));
check('the hover preview and the click use the same function',
  (js.match(/featureUnderHit\(hit\)/g) || []).length >= 2,
  `${(js.match(/featureUnderHit\(hit\)/g) || []).length} call sites`);
check('the picker has a click handler of its own', /function pickAt\(hit/.test(js));
check('the pick handler is what a picker click runs', /state\.tool === 'picker'\) \{\s*\n\s*pickAt\(hit/.test(js));
check('Shift-click keeps the picker active instead of switching back', /pickAt\(hit, \{ stay: e\.shiftKey \}\)/.test(js));
check('a pick hands back to the remembered paint tool', /state\.lastPaintTool/.test(js) && /setTool\(back\)/.test(js));
check('the paint tool is remembered whenever a non-picker tool is chosen',
  /if \(tool !== 'picker'\) state\.lastPaintTool = tool;/.test(js));
check('every tool has a display name', /const TOOL_NAMES = \{[^}]*brush[^}]*picker[^}]*\}/.test(js));
check('the cursor preview is cleared when the tool changes', /hoverPick = null;/.test(js));
check('the ring previews the hovered feature colour', /hoverPick && hoverPick\.id \? featureById\(hoverPick\.id\)\?\.color/.test(js));
check('an empty hover is distinguishable from "no paint at all"', /hoverPick\.painted|painted\b/.test(js));
// The bug this pins: Alt/Ctrl-click used to be filtered out before the Part tool ran, so the
// documented "Alt-click removes a panel" never worked.
check('modifier clicks are filtered by a named guard', /function modifierClickIgnored\(e\)/.test(js));
check(
  'the guard exempts the tools that mean something by a modifier: Part, Box select and Select',
  /function modifierClickIgnored\(e\) \{\s*\n\s*(?:\/\/[^\n]*\n\s*)*return \(\s*\n?\s*\(e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey\) &&[\s\S]{0,200}?state\.tool !== 'part' &&[\s\S]{0,80}?state\.tool !== 'box' &&[\s\S]{0,80}?state\.tool !== 'select'/.test(
    js,
  ),
);
check('pointerdown uses the guard rather than testing modifiers inline',
  /if \(e\.button !== 0 \|\| state\.navigate \|\| modifierClickIgnored\(e\)\) return;/.test(js));
check('the Part tool still reads its own modifiers', /add: e\.shiftKey/.test(js) && /remove: e\.altKey/.test(js));
check('the picker reports a click that misses the model', /Nothing under the cursor/.test(js));

// ------------------------------------------------- panels near the cursor, and invert
check('main.js imports the proximity query', /import \{[^}]*partsNearPoint[^}]*\} from '\.\/parts\.js'/.test(js));
check('the candidates come from that query', /partsNearPoint\(d, topology, \[near\.x, near\.y, near\.z\], radius, \{ excludePart: partId/.test(js));
check('the panel under the cursor is excluded from its own list', /excludePart: partId/.test(js));
check('a click passes the point it landed on', /near: hit\.localPoint/.test(js));
check('each candidate selects that panel', /applyPartSelection\(n\.part, \{ near \}\)/.test(js));
check(
  'candidates are labelled with their size, so a sliver is recognisable',
  /fmt\(n\.faces\)/.test(js) && /n\.share \* 100/.test(js) && /% of the mesh/.test(js) && /n\.distance\.toFixed\(1\)/.test(js),
);
check('the list can be dismissed', /box\.hidden = true/.test(js));
check('the panel list is hidden until a part is clicked', /id="partCandidates" class="candidates" hidden/.test(html));

// ------------------------------------------------- seam-angle presets
// The preset row is a second way into the seam angle. It has to reach the same state the
// slider does (one source of truth) or the button lights up at an angle the cut is not using.
check(
  'the preset buttons are in the markup',
  declared.has('seamPresets') && (html.match(/data-seam="/g) || []).length >= 3,
  `${(html.match(/data-seam="/g) || []).length} buttons`,
);
check('main.js queries the button row', /querySelectorAll\('\[data-seam\]'\)/.test(js));
check(
  'a preset press goes through setSeamAngle',
  /setSeamAngle\(Number\(btn\.dataset\.seam\)/.test(js),
);
check(
  'setSeamAngle writes the slider, its readout and the button state',
  /el\('seamAngle'\)\.value = String\(state\.seamAngle\)/.test(js) &&
    /el\('seamAngleVal'\)\.textContent = `\$\{state\.seamAngle\}°`/.test(js) &&
    /classList\.toggle\('on', Number\(btn\.dataset\.seam\) === state\.seamAngle\)/.test(js),
);
check(
  'the presets are one list, and the finer one is computed from it',
  /const SEAM_PRESETS = \[/.test(js) && /function finerPreset\(angle\)/.test(js),
);
check(
  'the slider tracks a drag without re-cutting on every step',
  /el\('seamAngle'\)\.addEventListener\('input',[\s\S]{0,160}syncSeamPresets\(\)/.test(js) &&
    /el\('seamAngle'\)\.addEventListener\('change',[\s\S]{0,160}ensureParts\(\{ force: true \}\)/.test(js),
);
check(
  'a Part click names the panel it thinks you aimed at',
  /the detail you aimed at is probably Part/.test(js) && /finerPreset\(d\.seamAngleDeg\)/.test(js),
);

// ------------------------------------------------- picking: file order, not BVH order
//
// The Part tool reads parts.facePart[hit.faceIndex], so the index pick() reports has to be the
// hit triangle in the file's own order — the order the mask, the welded topology and the panel
// segmentation are built in. MeshBVH installs an index buffer of its own on a mesh that has
// none and groups the triangles in BVH order, so the raw index names another panel entirely
// (test/parts.test.mjs drives a real raycast to show that). These pin the translation and the
// order it depends on.
const viewerSrc = fs.readFileSync(path.resolve(here, '../js/viewer.js'), 'utf8');
check('viewer exports the file-order triangle translation', /export function sourceTriangleIndex\(hit, soupSource/.test(viewerSrc));
check(
  'pick() reports that triangle instead of the BVH one',
  /faceIndex: sourceTriangleIndex\(hit, this\.soupSource\)/.test(viewerSrc),
);
const soupRead = viewerSrc.indexOf('this.soupSource = !geometry.index');
check(
  'the mesh order is read before the BVH installs an index of its own',
  soupRead > 0 && soupRead < viewerSrc.indexOf('new MeshBVH(geometry)'),
  soupRead > 0 ? `at ${soupRead}, BVH at ${viewerSrc.indexOf('new MeshBVH(geometry)')}` : 'assignment missing',
);
check('main.js feeds the reported face to the panel lookup', /paintPartAt\(hit\.faceIndex/.test(js));

check('the invert button exists', declared.has('invertBtn'));
check('the invert button is wired', /el\('invertBtn'\)\.addEventListener\('click', invertPaint\)/.test(js));
check('the invert uses the mask method', /mask\.invert\(id\)/.test(js));
check('Shift+I inverts, plain I picks', /if \(e\.shiftKey\) invertPaint\(\);/.test(js));
check('the mask implements invert', /invert\(id, \{ record = true \} = \{\}\)/.test(maskSrc));
check('undo records the state a snapshot replaces, so redo works',
  /entry\.next = this\.ids\.slice\(\)/.test(maskSrc) && /this\.ids\.set\(entry\.next \|\| entry\.ids\)/.test(maskSrc));
check('the parts module exposes it', /export function partsNearPoint/.test(
  fs.readFileSync(path.resolve(here, '../js/parts.js'), 'utf8'),
));

// --------------------------------- islands: the trim, the window list, and centring the model
//
// Two things a painted mask needs that are not painting: getting rid of the parts of it that
// would only become extra windows and loose pieces in the exported stencil, and bringing a model
// back to the grid when the file's exporter left it hundreds of units away. Both are checked
// here for the parts that can go wrong silently: the threshold being read, the edit being one
// undo step, the largest island being kept, and centring moving the model group rather than the
// coordinates the mask and every export are written in.
//
// The window list is the half of the trim that a size threshold cannot be: a threshold can only
// release whole islands *other* than the largest, so a mask that is one connected region has
// nothing it can ever release. The list names every window and hands back the vertices behind
// the one to remove — including the largest — which is what "remove or designate and remove"
// needs. These checks pin the wiring of that, the disabled button where there is nothing to do,
// and that the list cannot outlive the mask it describes.
const cleanupSrc = fs.readFileSync(path.resolve(here, '../js/cleanup.js'), 'utf8');
check(
  'the mask panel carries the trim controls and the window list',
  ['trimBtn', 'windowsBtn', 'trimPercent', 'windowList', 'windowRows', 'windowHint'].every((id) => declared.has(id)),
);
check('the window list starts hidden', /id="windowList" class="candidates" hidden/.test(html));
check(
  'the island engine exports what the app imports',
  /export function paintedIslands\(/.test(cleanupSrc) &&
    /export function planIslandTrim\(/.test(cleanupSrc) &&
    /export function maskWindows\(/.test(cleanupSrc),
);
check('main.js imports the island engine', /import \{ paintedIslands, planIslandTrim, maskWindows \} from '\.\/cleanup\.js'/.test(js));
check('the engine has no dependency on three or the DOM', !/from 'three|document\.|window\./.test(cleanupSrc));
check('the trim button runs the trim', /el\('trimBtn'\)\.addEventListener\('click', trimWindows\)/.test(js));
check('the window list is its own button', /el\('windowsBtn'\)\.addEventListener\('click', \(\) => listWindows\(\)\)/.test(js));
check('the threshold is read from the panel every time, not remembered', /Number\(el\('trimPercent'\)\.value\)/.test(js));
check(
  'the threshold runs to 100% of the model, so a typed 99 is not silently cut to 50',
  /Math\.min\(100, Number\(el\('trimPercent'\)\.value\)/.test(js) && /id="trimPercent"[^>]*max="100"/.test(html) &&
    !/Math\.min\(50, Number\(el\('trimPercent'\)/.test(js),
);
check(
  'both go through one analysis, so the numbers cannot disagree',
  (js.match(/await analyseWindows\(/g) || []).length === 2 && /minDiagonal: \(percent \/ 100\) \* topology\.diagonal/.test(js),
);
check(
  'a button that cannot help says which shape of mask it cannot help with',
  /Nothing to trim: the whole mask is one painted window/.test(js) &&
    /“List windows” removes it, or the erase brush takes/.test(js),
);
check(
  'and a threshold that is merely too low names the percentage that would work',
  /A threshold over[\s\S]{0,120}?would release it/.test(js) && /wouldNeed = \(smallest\.diagonal \/ topo\.diagonal\) \* 100/.test(js),
);
const rowFn = js.slice(js.indexOf('function renderWindowList('), js.indexOf('function featureListText('));
check(
  'every window gets a row naming its size and the features it is painted with',
  rowFn.length > 0 && /w\.diagonal\.toFixed\(2\)/.test(rowFn) && /featureListText\(w\.features\)/.test(rowFn),
);
check(
  'the row buttons are the two the guide names',
  /textContent = 'Remove'/.test(rowFn) && /textContent = 'Keep only'/.test(rowFn),
);
check('Remove releases exactly the window its row names', /releaseWindows\(\[w\], `Removed window/.test(rowFn));
check('Keep only releases every other window', /windows\.filter\(\(other\) => other !== w\)/.test(rowFn));
check('a button with nothing to do is disabled rather than misleading', /only\.disabled = windows\.length === 1/.test(rowFn));
check(
  'a release is exactly the vertices the window carries',
  /for \(const w of targets\) released\.push\(\.\.\.w\.fileVertices\)/.test(js) &&
    /fileVertices: fileVertices\[k\]/.test(cleanupSrc),
);
check(
  'releasing a window is one undo step, like every other mask edit',
  /mask\.beginStroke\(\);\s*\n\s*const changed = mask\.paintIndices\(released, 0\);\s*\n\s*const recorded = mask\.endStroke\(\);/.test(js),
);
check('the list rebuilds itself from what is left', /await listWindows\(\{ quiet: true \}\)/.test(js));
check(
  'the list is hidden the moment the mask it describes changes',
  /if \(windowBox && !windowBox\.hidden\) windowBox\.hidden = true/.test(js),
);
check(
  'the trim lands as one undo step that releases exactly the planned vertices',
  /mask\.beginStroke\(\);\s*\n\s*const changed = mask\.paintIndices\(plan\.released, 0\);\s*\n\s*const recorded = mask\.endStroke\(\);/.test(js),
);
check(
  'the largest island is always kept, so a mask of specks is never wiped out',
  /const largest = islands\.length \? islands\[0\] : null;/.test(cleanupSrc) &&
    /island !== largest && island\.diagonal < threshold/.test(cleanupSrc),
);
check('the islands are numbered largest first, so island 0 is the mask proper', /islands\.sort\(\(a, b\) => b\.vertices - a\.vertices/.test(cleanupSrc));
check(
  'a spec is measured by its size, not its vertex count',
  /diagonal: Math\.hypot\(sx, sy, sz\)/.test(cleanupSrc) && /island\.diagonal < threshold/.test(cleanupSrc),
);
check('a trim points at the build it leaves behind', /build again to match the trimmed mask/.test(js));
check(
  'the vertices a trim and a removal release are file vertices, joined to the islands through the weld',
  /doomedWelds\[weldOf\[i\]\]/.test(cleanupSrc) && /label\[weldOf\[i\]\]/.test(cleanupSrc),
);
check(
  'main.js exposes the island engine for scripted checks',
  /islandIo: \{ paintedIslands, planIslandTrim, maskWindows \}/.test(js),
);

check('the centring control exists', declared.has('centreOnGrid'));
check('it starts checked, so a fresh model is centred by default', /id="centreOnGrid" checked/.test(html));
check('the centring control is wired', /el\('centreOnGrid'\)\.addEventListener\('change', onCentreToggle\)/.test(js));
check('a loaded model is placed with whatever the control says', /centre: el\('centreOnGrid'\)\.checked/.test(js));
check('viewer exports the centring offset as a pure function of a box', /export function centreTranslation\(box\)/.test(viewerSrc));
check(
  'centring moves the model group, never the geometry the mask is indexed by',
  /this\._applyCentre\(\)/.test(viewerSrc) &&
    /_applyCentre\(\) \{[\s\S]{0,400}?group\.position\.copy\(offset\)/.test(viewerSrc) &&
    !/_applyCentre\(\) \{[\s\S]{0,400}?position\.array/.test(viewerSrc),
);
check('the offset is re-measured when the up axis turns the model', /setUpAxis\(axis\) \{[\s\S]{0,200}?this\._applyCentre\(\)/.test(viewerSrc));
check(
  'centring can be turned off, which puts the file coordinates back',
  /setCentreOnGrid\(on = true\)/.test(viewerSrc) && /if \(!this\.baseMesh \|\| !this\.centred\) return;/.test(viewerSrc),
);

// ------------------------------------------------- the export must match the screen
//
// A build is a snapshot of the paint, so the result in hand can be older than the mask on screen:
// Shift-click two more panels, press Export stencil STL again, and a straight copy of the old
// shell lands on disk with a fresh timestamp and last round's windows — the "my second save only
// has the first windows" report. These pin the fix: the export asks whether the paint has moved
// on, rebuilds if it has, and writes nothing at all if that rebuild is refused.
check(
  'the export can tell when the build is older than the mask',
  /function stencilOutOfDate\(\)/.test(js) && /mask \? mask\.stats\(\)\.painted : 0\) !== stencil\.paintedCount/.test(js),
);
check(
  'Build stencil and the export share one build path',
  /async function rebuildStencil\(\)/.test(js) && (js.match(/await rebuildStencil\(\)/g) || []).length === 2,
);
check(
  'Export stencil STL rebuilds before writing when the paint has moved on',
  /async function exportStencilSTL\(\)[\s\S]{0,900}?if \(!res \|\| stencilOutOfDate\(\)\)[\s\S]{0,400}?res = await rebuildStencil\(\)/.test(js),
);
check(
  'and writes the fresh result, never the old one',
  /const placed = onBed \? io\.setOnBed\(res\.positions, res\.indices\) : null;/.test(js) &&
    /const written = placed \? placed\.positions : res\.positions;/.test(js) &&
    /const \{ buffer, triangles, bytes \} = io\.buildBinarySTL\(written, res\.indices\)/.test(js) &&
    !/buildBinarySTL\(stencil\.result/.test(js),
);
check('a refused rebuild writes no file at all', /Nothing exported: the stencil could not be built/.test(js));
check(
  'the exported line names the windows and pieces that went into the file',
  /\$\{s\.windowLoops\} window\$\{s\.windowLoops === 1 \? '' : 's'\} in/.test(js),
);
check('the export button still calls it', /el\('stencilExportBtn'\)\.addEventListener\('click', exportStencilSTL\)/.test(js));

// -------------------------------------------------------- the part has to land on the bed
//
// The report: the exported stencil floats in the slicer, and the Z has to be hunted for. A slicer
// reads Z = 0 as the plate and an STL keeps its exporter's coordinates, so the file is the only
// place the part can be put on the bed — the viewport never shows the problem, because centring
// moves the view rather than the mesh. These pin the three halves that can go wrong silently:
// the option being read from the panel, only the written copy moving, and only Z moving in it.
const ioSrc = fs.readFileSync(path.resolve(here, '../js/io.js'), 'utf8');
check('the stencil panel carries the bed option', declared.has('stencilOnBed'));
check('it is on by default, so an export lands on the plate', /id="stencilOnBed" checked/.test(html));
check(
  'the export reads it every time instead of remembering it',
  /const onBed = el\('stencilOnBed'\)\.checked;/.test(js),
);
check(
  'checked, the written points are the ones setOnBed() moved; unticked, the build\'s own',
  /onBed \? io\.setOnBed\(res\.positions, res\.indices\) : null/.test(js),
);
check(
  'the placement is handed the indices, so the pieces of a multi-piece stencil can be found',
  /io\.setOnBed\(res\.positions, res\.indices\)/.test(js) && /export function setOnBed\(positions, indices = null\)/.test(ioSrc),
);
check(
  'the solid is moved by a copy, so the panel and the preview keep their own vertices',
  /export function setOnBed\(positions, indices = null\)[\s\S]{0,1200}?positions\.slice\(\)/.test(ioSrc),
);
check(
  'and only Z is moved in it — X and Y stay where the model has them',
  /for \(let i = 2; i < out\.length; i \+= 3\) out\[i\] -= drop;/.test(ioSrc) &&
    /out\[v \* 3 \+ 2\] -= shells\.lowest\[p\];/.test(ioSrc) &&
    !/out\[i \+= 1\]|out\[i \+ 1\] -=/.test(ioSrc.split('export function setOnBed')[1] || '') &&
    !/out\[v \* 3\] =|out\[v \* 3 \+ 1\]/.test(ioSrc.split('export function setOnBed')[1] || ''),
);
check(
  'a part already on Z 0 is not copied or moved at all',
  /if \(drop === 0\) return \{ positions, drop: 0, pieces: positions\.length \? 1 : 0, moved: 0 \};/.test(ioSrc),
);
// The shells have to be found for any of that to happen: triangles that share a vertex are one
// piece, several pieces are placed separately, and a soup with nothing shared is left alone.
check(
  'the pieces are found by the vertices their triangles share',
  /function shellLowestZ\(positions, indices\)/.test(ioSrc) &&
    /const prev = firstTriangleOf\.get\(v\);/.test(ioSrc) &&
    /if \(lowest\.length < 2 \|\| lowest\.length === tri\) return null;/.test(ioSrc),
);
check(
  'the status line says what happened to Z, either way',
  /sat on the bed:[\s\S]{0,160}?lowest Z is 0/.test(js) && /already on Z 0, so nothing moved/.test(js) &&
    /left in the model's own coordinates \(lowest Z/.test(js),
);
check(
  'and names the pieces when the stencil came out in more than one',
  /sat each of its \$\{placed\.pieces\} pieces on the bed/.test(js) &&
    /every piece's lowest Z is 0/.test(js) &&
    /its \$\{s\.components\} pieces wherever the model has them/.test(js),
);
check(
  'the panel option says it covers every piece',
  /id="stencilOnBed" checked title="[^"]*every piece/.test(html),
);

// ------------------------------------------------------- the box select tool
//
// Drag a rectangle and paint what it covers. The half that cannot be checked statically is the
// projection itself (`test/boxselect.test.mjs` measures that against three.js' own `project()`),
// so what is pinned here is every join that could silently come apart: the tool in the toolbar,
// the key, the overlay element and the drag path, the inverse transform being handed the right
// three matrices, and the selection landing on the mask as one undo step.
const boxSrc = fs.readFileSync(path.resolve(here, '../js/boxselect.js'), 'utf8');
const boxViewerSrc = fs.readFileSync(path.resolve(here, '../js/viewer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.resolve(here, '../css/style.css'), 'utf8');
check('the paint panel carries the box tool', /<button class="tool" data-tool="box"/.test(html));
check('main.js names it, so the HUD and the status lines can say what is active', /box: 'Box select'/.test(js));
check('and X selects it', /case 'x': setTool\('box'\); break;/.test(js));
check('the rectangle being dragged is drawn', declared.has('boxSelect') && /\.box-select\b/.test(cssSrc) && /\.box-select\[hidden\]/.test(cssSrc));
check('its options panel exists and is shown for that tool', declared.has('boxOptions') && /el\('boxOptions'\)\.classList\.toggle\('on', tool === 'box'\)/.test(js));
check(
  'the drag starts without needing the model under the cursor, and before any paint path',
  /if \(state\.tool === 'box'\) \{\s*\n\s*startBoxSelect\(e\);\s*\n\s*return;\s*\n\s*\}/.test(js) &&
    /function startBoxSelect\(e\)[\s\S]{0,900}?boxDrag = \{ pointerId: e\.pointerId, from: p, to: p, erase: e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \};/.test(js),
);
check(
  'dragging updates the rectangle, and releasing applies it',
  /if \(boxDrag\) \{\s*\n\s*moveBoxSelect\(e\);/.test(js) && /if \(boxDrag\) \{\s*\n\s*finishBoxSelect\(\);\s*\n\s*return;/.test(js),
);
check('Esc throws a pending rectangle away', /case 'escape':[\s\S]{0,80}?if \(boxDrag\) cancelBoxSelect\(\);/.test(js));
check(
  'the Alt/Ctrl drag is the eraser here, so it is not swallowed as "not painting"',
  /state\.tool !== 'part' &&\s*\n?\s*state\.tool !== 'box'/.test(js) &&
    /const id = drag\.erase \? 0 : paintId\(\);/.test(js),
);
check(
  'and the Select tool reads its modifiers too, rather than being filtered out as "not painting"',
  /state\.tool !== 'select'/.test(js) && /const remove = e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey;/.test(js),
);
check(
  'the selection itself is the inverse transform, taken in canvas pixels',
  /const p = canvasPoint\(e\);/.test(js) && /function canvasPoint\(e\)[\s\S]{0,220}?canvas\.getBoundingClientRect\(\)/.test(js) &&
    /viewer\.selectInScreenRect\(normaliseRect\(drag\.from, drag\.to\)/.test(js),
);
check(
  'mirroring is handed to the selection, so the box is taken on the other side too',
  /mirror: state\.mirrorX \? \{ planeX: state\.mirrorPlaneX \} : null/.test(js),
);
check(
  'the viewer composes projection × view × model and hands it to the selection maths',
  /selectInScreenRect\(rect, \{ mirror = null, facingOnly = true \} = \{\}\)/.test(boxViewerSrc) &&
    /screenMatrix\(\s*\n\s*this\.camera\.projectionMatrix\.elements,\s*\n\s*this\.camera\.matrixWorldInverse\.elements,\s*\n\s*this\.baseMesh\.matrixWorld\.elements,/.test(boxViewerSrc) &&
    /import \{ screenMatrix, verticesInScreenRect \} from '\.\/boxselect\.js'/.test(boxViewerSrc),
);
check(
  'the camera and the normals are taken in the mesh\'s own coordinates, which is what the mask counts in',
  /worldToLocal\(this\.camera\.position\.clone\(\)\)/.test(boxViewerSrc) &&
    /positions: geometry\.attributes\.position\.array/.test(boxViewerSrc),
);
check(
  'a whole drag lands on the mask as one undo step',
  /mask\.beginStroke\(\);\s*\n\s*const changed = mask\.paintIndices\(sel\.vertices, id\);\s*\n\s*const recorded = mask\.endStroke\(\);/.test(js),
);
check(
  'the status line admits what the box could not take',
  /face the camera/.test(js) && /face away and were left alone/.test(js) && /mirrored across X/.test(js) &&
    /nothing under the rectangle — drag it over the model/.test(js),
);
check(
  'boxselect.js keeps the rules a screen-space box needs, and exports them',
  /export function verticesInScreenRect/.test(boxSrc) &&
    /export function normaliseRect/.test(boxSrc) &&
    /export function screenMatrix/.test(boxSrc) &&
    /if \(!\(cw > MIN_CLIP_W\)\)/.test(boxSrc) &&
    /if \(cz < -cw \|\| cz > cw\) continue;/.test(boxSrc) &&
    /facesCamera\(normals, i, x, y, z, camera\[0\], camera\[1\], camera\[2\]\)/.test(boxSrc),
);

// --------------------------------------------------- cleaning up the model
//
// Pick the models in the file (or single faces) and take them out. The picking rule and the
// surgery are measured in `test/select.test.mjs`; what is pinned here is every join between the
// panel, the tool and the geometry: the tool and its key, the scope menu, the three pick buttons,
// the two-click removal, the geometry going back through the loader's own path so the bed is
// re-measured, and the paint and the history being carried across.
const selectSrc = fs.readFileSync(path.resolve(here, '../js/select.js'), 'utf8');
check('the paint panel carries the Select tool', /<button class="tool" data-tool="select"/.test(html));
check('main.js names it, so the HUD can say what is active', /select: 'Select'/.test(js));
check(
  'and S selects it — whole models, or single faces with Shift',
  /case 's':\s*\n\s*\/\/[^\n]*\n\s*setTool\('select'\);\s*\n\s*setSelectScope\(e\.shiftKey \? 'faces' : 'models'\);/.test(js),
);
check(
  'its options panel exists and is shown for that tool',
  declared.has('selectOptions') && /el\('selectOptions'\)\.classList\.toggle\('on', tool === 'select'\)/.test(js),
);
// The scope used to be a menu inside the panel, and a picker nobody finds is a picker nobody
// uses: the two halves of the tool are buttons in the tool row, one per scope.
check(
  'the two halves of the tool are two buttons in the tool row, not a menu to find',
  /<button class="tool" data-tool="select" data-scope="models"[^>]*>Select models<\/button>/.test(html) &&
    /<button class="tool" data-tool="select" data-scope="faces"[^>]*>Select faces<\/button>/.test(html) &&
    !/id="selectScope"/.test(html),
);
check(
  'and the pressed one sets the scope',
  /if \(btn\.dataset\.scope\) setSelectScope\(btn\.dataset\.scope\);/.test(js) &&
    /function setSelectScope\(scope\)[\s\S]{0,200}?cleanup\.scope = scope === 'faces' \? 'faces' : 'models';/.test(js),
);
check(
  'only the half that is in hand is lit up',
  /function syncToolButtons\(\)[\s\S]{0,400}?const scope = b\.dataset\.scope;[\s\S]{0,200}?b\.dataset\.tool === state\.tool && \(!scope \|\| scope === cleanup\.scope\)/.test(js),
);
check(
  'the eyedropper says it picks paint, so it is not mistaken for the face picker',
  /Eyedropper: make the feature painted under the cursor/.test(html),
);
check(
  'select all, select none and invert are all wired',
  declared.has('selectAllBtn') && declared.has('selectNoneBtn') && declared.has('selectInvertBtn') &&
    /el\('selectAllBtn'\)\.addEventListener\('click', selectAllFaces\)/.test(js) &&
    /el\('selectNoneBtn'\)\.addEventListener\('click', selectNoFaces\)/.test(js) &&
    /el\('selectInvertBtn'\)\.addEventListener\('click', invertPickedFaces\)/.test(js) &&
    /function selectAllFaces\(\)[\s\S]{0,200}?cleanup\.selected\.fill\(1\)/.test(js),
);
check('and Ctrl+A is the same thing, for the few-out-of-many case', /if \(meta && e\.key\.toLowerCase\(\) === 'a'\)/.test(js) && /selectAllFaces\(\);\s*\n\s*return;/.test(js));
check(
  'a click picks the model or the face under the cursor, and does not paint',
  /if \(state\.tool === 'select'\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*void selectClick\(e\);\s*\n\s*return;\s*\n\s*\}/.test(js) &&
    /async function selectClick\(e\)/.test(js) &&
    /const hit = viewer\.pick\(e\.clientX, e\.clientY\);/.test(js) &&
    /pickFace\(hit\.faceIndex, \{ add, remove \}\)/.test(js) &&
    /const shell = shells\.faceShell\[hit\.faceIndex\]/.test(js),
);
check('the model list is built from the shells of the file', declared.has('modelRows') && declared.has('modelList') && /function renderShellList\(\)/.test(js) && /shellsOf\(topology\)/.test(js));
check(
  'Esc unpicks everything, and a model list exists to click instead of the viewport',
  /case 'escape':\s*\n\s*if \(boxDrag\) cancelBoxSelect\(\);\s*\n\s*else if \(state\.tool === 'select' && pickedFaces\(\)\) selectNoFaces\(\);/.test(js),
);
check(
  'removing is a two-click confirmation, so it cannot happen by accident',
  /Click again to remove/.test(js) && /now - cleanup\.armedAt > 4000/.test(js) &&
    /el\('removeFacesBtn'\)\.addEventListener\('click', removeClicked\)/.test(js),
);
check(
  'a removal cannot leave the model empty',
  /const left = soup\.faceCount - countFaces\(trial\);\s*\n\s*if \(!left\)/.test(js) && /nothing was removed/.test(js),
);
check(
  'the geometry is rebuilt from the file’s own soup, and goes back through the loader’s path',
  /filterSoup\(\{ positions: soup\.positions, normals: soup\.normals, ids: oldIds \}, keep\)/.test(js) &&
    /viewer\.setGeometry\(geometry, \{\s*\n\s*upAxis: state\.upAxis,\s*\n\s*overlayGeometry,\s*\n\s*centre: el\('centreOnGrid'\)\.checked,/.test(js),
);
check(
  'the paint is carried corner by corner, and the undo history with it',
  /mask\.ids\.set\(cut\.ids\)/.test(js) &&
    /mask\.history = remapHistory\(oldHistory, cut\.cornerMap, mask\.vertexCount\)/.test(js) &&
    /mask\.redoStack = remapHistory\(oldRedo, cut\.cornerMap, mask\.vertexCount\)/.test(js),
);
check(
  'the stencil and the panels are discarded with the geometry they describe',
  /cleanup\.liveFace = cut\.faceMap;[\s\S]{0,400}?resetStencil\(\);/.test(js),
);
check(
  'the status line says where the bed ended up, which is the whole point of removing a model',
  /The bed is under the surviving model's lowest point/.test(js) &&
    /bed is under its lowest point/.test(js) &&
    /function applyRemoval\(origFaceList/.test(js),
);
check(
  'restore puts every removed face back',
  /async function restoreRemovedFaces\(\)/.test(js) && /cleanup\.removed\.fill\(0\);/.test(js) &&
    /el\('restoreFacesBtn'\)\.addEventListener\('click', \(\) => void restoreRemovedFaces\(\)\)/.test(js),
);
// The bug this pins: a pick drawn as edges alone is invisible. Three hairlines lying on the
// surface they trace z-fight with the triangle they belong to, so a single picked face showed
// nothing at all and the tool looked dead. A pick has to be a filled, offset tint.
check(
  'the pick is drawn as a filled tint as well as edges, not as hairlines on the surface',
  /function updatePickHighlight\(\)/.test(js) &&
    /cleanup\.outline = drawHighlight\(cleanup\.outline, faces, \{\s*\n\s*color: 0xffd24d,\s*\n\s*fillOpacity: 0\.5,/.test(js) &&
    /new THREE\.Mesh\(\s*\n\s*data\.fill,\s*\n\s*new THREE\.MeshBasicMaterial\(\{/.test(js) &&
    /const offset = \{ polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 \};/.test(js) &&
    /side: THREE\.DoubleSide,\s*\n\s*\.\.\.offset,/.test(js) &&
    /new THREE\.LineSegments\(\s*\n\s*data\.edges,/.test(js),
);
check(
  'and the hovered face is tinted white the same way',
  /function updateHoverFace\(faceIndex\)/.test(js) &&
    /cleanup\.hover = drawHighlight\(cleanup\.hover, under, \{\s*\n\s*color: 0xffffff,\s*\n\s*fillOpacity: 0\.35,/.test(js),
);
check(
  'a pick too big to draw says so in the panel instead of silently not drawing',
  /const HIGHLIGHT_FACE_LIMIT = 60000;/.test(js) && /too many to tint in the viewport/.test(js) &&
    /export function highlightArrays\(positions, faceMask, \{ limit = 60000 \} = \{\}\)/.test(selectSrc),
);
check(
  'a one-model file does not tint the whole model on hover — there is nothing to choose there',
  /const whole =\s*\n\s*cleanup\.scope === 'models' && shells && shells\.shellCount > 1 \? shells\.faceShell\[faceIndex\] : undefined;/.test(js) &&
    /This file holds one model, so a click here picks the whole file/.test(js),
);
check(
  'select.js keeps the rules the cleanup needs, and exports them',
  /export function shellsOf/.test(selectSrc) && /export function filterSoup/.test(selectSrc) &&
    /export function remapHistory/.test(selectSrc) && /export function inverseCornerMap/.test(selectSrc) &&
    /const key = a < b \? a \* ID_SHIFT \+ b : b \* ID_SHIFT \+ a;/.test(selectSrc),
);
check(
  'the viewer draws the bed on the model’s own lowest point, not a fraction of its height below it',
  /export function gridPlacement\(box\)/.test(boxViewerSrc) &&
    /const \{ x, y, z, span \} = gridPlacement\(this\.boundingBox\);/.test(boxViewerSrc) &&
    /this\.grid\.position\.set\(x, y, z\);/.test(boxViewerSrc) &&
    !/this\.grid\.position\.y = this\.boundingBox\.min\.y - size\.y \* 0\.02;/.test(boxViewerSrc),
);

// ------------------------------------------------- the session file
// Saving the windows and loading them back to add more is the mask JSON; what it has to carry to
// be a session (rather than just a vertex list) is the palette and the build settings.
check('the mask JSON carries the build settings', /stencil: stencilSettings\(\)/.test(js) && /function stencilSettings\(\)/.test(js));
check('the guide documents that field', /"stencil"/.test(fs.readFileSync(path.resolve(here, '../help.html'), 'utf8')));
check(
  'opening a mask puts the settings back into the panel',
  /function applyStencilSettings\(s\)/.test(js) && /applyStencilSettings\(savedStencil\)/.test(js),
);
check(
  'io.js hands the settings back, and tolerates a file from before they existed',
  /stencil: parseStencilSettings\(data\.stencil\)/.test(fs.readFileSync(path.resolve(here, '../js/io.js'), 'utf8')),
);
check(
  'a loaded mask is compared against the build in hand, not left saying old numbers',
  /mask\.loadPairs\(pairs\);[\s\S]{0,500}?updateStencilStats\(\);/.test(js),
);
check(
  'the buttons read as save and open, and both say how to carry on',
  /Save mask \(JSON\)/.test(html) &&
    /Open mask \(JSON\)/.test(html) &&
    /Open mask \(JSON\)” brings it back to carry on/.test(js) &&
    /Shift-click more panels with the Part tool/.test(js),
);

console.log(`\n${missing.length + missingExports.length + (failures ? 1 : 0) === 0 ? 'all wiring checks passed' : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
