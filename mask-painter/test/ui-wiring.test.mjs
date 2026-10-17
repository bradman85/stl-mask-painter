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
  />no model loaded</.test(html) && /load &rarr; select &rarr; stencil/.test(html),
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
  'discarding a stencil says the selection is untouched, so the shell is not mistaken for it',
  /Stencil discarded[\s\S]{0,240}?The selection is untouched/.test(js),
);
check(
  'a stale build points at both ways out',
  /the selection has changed since this was built[\s\S]{0,160}?Discard stencil/.test(js),
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
// There are two tools and both of them select, so what can go wrong silently is now the join
// between them rather than the paint: a tool that clears what the other selected (there is one
// selection, and it belongs to neither), a modifier filtered out before the tool that means
// something by it sees it, and a hover highlight describing a scope the tool is no longer in.
const maskSrc = fs.readFileSync(path.resolve(here, '../js/mask.js'), 'utf8');
const selectionSrc = fs.readFileSync(path.resolve(here, '../js/selection.js'), 'utf8');

check(
  'the tool row is the two selection tools, and nothing that paints',
  (html.match(/class="tool"/g) || []).length === 3 &&
    /data-tool="part"/.test(html) && (html.match(/data-tool="select"/g) || []).length === 2 &&
    !/data-tool="brush"|data-tool="box"|data-tool="fill"|data-tool="picker"|data-tool="erase"/.test(html),
  (html.match(/class="tool"[^>]*/g) || []).map((t) => (t.match(/data-tool="[^"]+"/) || [''])[0]).join(' '),
);
check(
  'every tool has a display name, and neither is a painting tool',
  /const TOOL_NAMES = \{ part: 'Part', select: 'Select' \};/.test(js),
  (js.match(/const TOOL_NAMES = [^;]*;/) || [''])[0],
);
// The arrangement the whole redesign rests on: switching tool clears nothing, because a selection
// is not a tool's private state. Pick a head with Part and refine the eyes with Select faces.
{
  const setToolFn = js.slice(js.indexOf('function setTool('), js.indexOf('function applyDisplayState('));
  check(
    'switching tool clears nothing: the selection belongs to no tool',
    setToolFn.length > 0 && /state\.tool = tool === 'part' \? 'part' : 'select';/.test(setToolFn) &&
      !/selectNoFaces\(\)|mask\.clear\(\)|createSelection\(/.test(setToolFn),
    `${setToolFn.split('\n').length} lines, none of them clearing the selection`,
  );
  check(
    'and the panel says the selection is still there, which is how a reader finds out',
    /const picked = mask \? selectedFaces\(\) : 0;/.test(js) && /face\$\{picked === 1 \? '' : 's'\} selected/.test(js),
  );
}
// The bug this pins: Alt/Ctrl-click used to be filtered out before the Part tool ran, so the
// documented "Alt-click removes a panel" never worked. There is no longer a guard that can eat a
// modifier: pointerdown filters on the button and on navigating, and hands everything else to the
// tool in hand, which reads its own modifiers.
check(
  'pointerdown filters on the button and on navigating, not on modifiers',
  /function onPointerDown\(e\) \{\s*\n\s*if \(!mask\) return;\s*\n\s*if \(e\.button !== 0 \|\| state\.navigate\) return;/.test(js) &&
    !/modifierClickIgnored/.test(js),
);
check(
  'and each tool reads its own modifiers, so Shift and Alt mean the same thing in both',
  /selectPartAt\(hit\.faceIndex, \{\s*\n\s*add: e\.shiftKey,\s*\n\s*remove: e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey,/.test(js) &&
    /add: e\.shiftKey,\s*\n\s*remove: e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey,/.test(js),
);
check(
  'the hover face is drawn by the Select tool, which is the tool that clicks a face',
  /function onPointerMove\(e\)[\s\S]{0,1600}?if \(state\.tool === 'select'\) updateHoverFace\(hit \? hit\.faceIndex : null\);/.test(js) &&
    /function updateHoverFace\(faceIndex\)/.test(js),
);
// Part takes a whole panel, so a single triangle lighting up under the cursor describes a click
// that Part will not make. The report was exactly that: "when in Part mode the triangles should
// not light up under mouse movement". Two paths have to agree about it — the pointer move that
// would draw one, and the tool switch that would leave the last one on screen.
check(
  'and Part draws none: a triangle lit up for a tool that takes panels describes the wrong click',
  /function onPointerMove\(e\)[\s\S]{0,1600}?else clearHoverFace\(\);/.test(js),
);
check(
  'including on the way in, so a tint left by the Select tool does not outlive the tool',
  /function setTool\(tool\) \{[\s\S]{0,400}?if \(state\.tool !== 'select'\) clearHoverFace\(\);/.test(js),
);
check(
  'and the scope clears it, because the scope is what a hover means',
  /function setSelectScope\(scope\)[\s\S]{0,400}?clearHoverFace\(\);/.test(js),
);
check(
  'a click that misses the model clears the selection and says so',
  /selectNoFaces\(\);\s*\n\s*setStatus\('Nothing under the cursor/.test(js),
);
check(
  'and a click off a model in the models scope explains instead of appearing to do nothing',
  /Click on the model to select it\./.test(js),
);
check(
  'no paint machinery is left in the mask layer',
  /export class SelectionTint/.test(maskSrc) &&
    !/featureUnderPoint|paintSphere|paintIndices|beginStroke|endStroke/.test(maskSrc) &&
    !/feature|palette|brush/i.test(maskSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
);
check(
  'and the mask is written from the selection and nowhere else',
  /tintScratch = paintedFromFaces\(cleanup\.selection, tintScratch\);/.test(js) &&
    /const corners = mask\.setSelection\(tintScratch\);/.test(js) &&
    (js.match(/\.setSelection\(/g) || []).length === 1,
  `${(js.match(/\.setSelection\(/g) || []).length} call site(s)`,
);

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
    /el\('seamAngle'\)\.addEventListener\('change',[\s\S]{0,160}ensureParts\(\{ force: true, quiet: true \}\)/.test(js),
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
check('main.js feeds the reported face to the panel lookup', /selectPartAt\(hit\.faceIndex/.test(js));

// Invert, select all and select none are one function each in the selection core, reached from a
// button and a key, rather than a third way of editing the mask.
check(
  'select all, select none and invert are all wired to the selection core',
  declared.has('selectAllBtn') && declared.has('selectNoneBtn') && declared.has('selectInvertBtn') &&
    /el\('selectAllBtn'\)\.addEventListener\('click', selectAllFaces\)/.test(js) &&
    /el\('selectNoneBtn'\)\.addEventListener\('click', selectNoFaces\)/.test(js) &&
    /el\('selectInvertBtn'\)\.addEventListener\('click', invertPickedFaces\)/.test(js),
);
check(
  'each of the three is the core function and not a second implementation',
  /const n = setAll\(cleanup\.selection, true\);/.test(js) && /export function setAll\(sel, on\)/.test(selectionSrc) &&
    /setAll\(cleanup\.selection, false\);/.test(js) &&
    /const n = invertSelection\(cleanup\.selection\);/.test(js) && /export function invertSelection\(sel\)/.test(selectionSrc),
);
check('Shift+I inverts the selection', /if \(e\.shiftKey\) invertPickedFaces\(\);/.test(js));
// Undo has to walk the selection, not the tint: the tint is derived, so a history of tints could
// be undone into a picture the selection no longer describes.
check(
  'undo and redo walk the selection through one history',
  /history\.remember\(cleanup\.selection\)/.test(js) &&
    /history\.undo\(cleanup\.selection\)/.test(js) &&
    /history\.redo\(cleanup\.selection\)/.test(js) &&
    /export class SelectionHistory/.test(selectionSrc) &&
    !/mask\.undo\(\)|mask\.redo\(\)/.test(js),
);
check('and a gesture that changes nothing is not an undo step', /countChanges\(cleanup\.selection, wanted, opts\)/.test(js));
check('the parts module exposes the proximity query', /export function partsNearPoint/.test(
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
  'a button that cannot help says which shape of selection it cannot help with',
  /Nothing to trim: the whole mask is one painted window/.test(js) &&
    /“List windows” removes it, or Select faces takes/.test(js) && !/erase brush/.test(js),
);
check(
  'and a threshold that is merely too low names the percentage that would work',
  /A threshold over[\s\S]{0,120}?would release it/.test(js) && /wouldNeed = \(smallest\.diagonal \/ topo\.diagonal\) \* 100/.test(js),
);
const rowFn = js.slice(js.indexOf('function renderWindowList('), js.indexOf('function windowFaces('));
check(
  'every window gets a row naming its size, in units and in faces',
  rowFn.length > 0 && /w\.diagonal\.toFixed\(2\)/.test(rowFn) && /fmt\(windowFaces\(w\)\)/.test(rowFn) &&
    /fmt\(w\.vertices\)/.test(rowFn) && !/features/.test(rowFn),
);
check(
  'the row buttons are the two the guide names',
  /textContent = 'Remove'/.test(rowFn) && /textContent = 'Keep only'/.test(rowFn),
);
check('Remove releases exactly the window its row names', /releaseWindows\(\[w\], `Removed window/.test(rowFn));
check('Keep only releases every other window', /windows\.filter\(\(other\) => other !== w\)/.test(rowFn));
check('a button with nothing to do is disabled rather than misleading', /only\.disabled = windows\.length === 1/.test(rowFn));
check(
  'a release is exactly the faces the window carries',
  /for \(const w of targets\) corners\.push\(\.\.\.w\.fileVertices\)/.test(js) &&
    /for \(const c of corners\) \{\s*\n\s*const t = Math\.floor\(c \/ 3\);/.test(js) &&
    /fileVertices: fileVertices\[k\]/.test(cleanupSrc),
);
check(
  'releasing a window is one selection edit, like every other',
  /const changed = applyPickToSelection\(wanted, \{ remove: true \}\);\s*\n\s*afterSelection\(changed\);/.test(js),
);
check('the list rebuilds itself from what is left', /await listWindows\(\{ quiet: true \}\)/.test(js));
check(
  'the list is hidden the moment the mask it describes changes',
  /if \(windowBox && !windowBox\.hidden\) windowBox\.hidden = true/.test(js),
);
check(
  'the trim lands as one selection edit that releases exactly the planned faces',
  /for \(const c of plan\.released\) \{\s*\n\s*const t = Math\.floor\(c \/ 3\);/.test(js) &&
    /const changed = applyPickToSelection\(wanted, \{ remove: true \}\);/.test(js),
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
check('a trim points at the build it leaves behind', /build again to match the selection/.test(js));
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

// ------------------------------------------------ the rectangle is a gesture of Select
//
// Drag a rectangle and select what it covers. The half that cannot be checked statically is the
// projection itself (`test/boxselect.test.mjs` measures that against three.js' own `project()`),
// so what is pinned here is every join that could silently come apart: the rectangle in the tool
// that owns it, the overlay element, the inverse transform being handed the right three matrices,
// the rectangle being applied in the scope in hand, and the whole drag landing as one selection
// edit rather than one per face.
const boxSrc = fs.readFileSync(path.resolve(here, '../js/boxselect.js'), 'utf8');
const boxViewerSrc = fs.readFileSync(path.resolve(here, '../js/viewer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.resolve(here, '../css/style.css'), 'utf8');
check('the rectangle being dragged is drawn', declared.has('boxSelect') && /\.box-select\b/.test(cssSrc) && /\.box-select\[hidden\]/.test(cssSrc));
check(
  'there is no box tool any more: a rectangle is how the Select tool is dragged',
  !/data-tool="box"/.test(html) && !/startBoxSelect|boxDrag|finishBoxSelect/.test(js) &&
    /function startSelectDrag\(e\)/.test(js) && /function finishSelectDrag\(\)/.test(js),
);
check(
  'a press in the Select tool selects nothing yet: it starts a gesture decided on release',
  /if \(state\.tool === 'part'\) \{[\s\S]{0,300}?startSelectDrag\(e\);[\s\S]{0,80}?\}/.test(js) &&
    !/if \(selectDrag\) cancelSelectDrag\(\);\s*\n\s*else if \(boxDrag\)/.test(js),
);
check(
  'a press that does not move is the click it always was, and a moved one is a box',
  /const DRAG_SLOP = 3;/.test(js) &&
    /if \(width < DRAG_SLOP && height < DRAG_SLOP\) return;/.test(js) &&
    /void selectClickAt\(drag\.toClient, drag\);/.test(js),
);
check(
  'dragging updates the rectangle, and releasing applies it',
  /if \(selectDrag\) \{\s*\n\s*moveSelectDrag\(e\);/.test(js) &&
    /canvas\.addEventListener\('pointerup', endStroke\)/.test(js) &&
    /function endStroke\(\) \{\s*\n\s*if \(selectDrag\) finishSelectDrag\(\);/.test(js) &&
    /showBoxRect\(selectDrag\.from, p\);/.test(js),
);
check(
  'Esc throws a pending rectangle away, and so does switching tool',
  /case 'escape':\s*\n\s*if \(selectDrag\) cancelSelectDrag\(\);/.test(js) &&
    /if \(state\.tool !== 'select' && selectDrag\) cancelSelectDrag\(\);/.test(js),
);
check(
  'the selection itself is the inverse transform, taken in canvas pixels',
  /const p = canvasPoint\(e\);/.test(js) && /function canvasPoint\(e\)[\s\S]{0,220}?canvas\.getBoundingClientRect\(\)/.test(js) &&
    /viewer\.facesInScreenRect\(normaliseRect\(drag\.from, drag\.to\)\)/.test(js),
);
check(
  'the viewer composes projection × view × model and hands it to the selection maths',
  /facesInScreenRect\(rect, \{ facingOnly = true \} = \{\}\)/.test(boxViewerSrc) &&
    /screenMatrix\(\s*\n\s*this\.camera\.projectionMatrix\.elements,\s*\n\s*this\.camera\.matrixWorldInverse\.elements,\s*\n\s*this\.baseMesh\.matrixWorld\.elements,/.test(boxViewerSrc) &&
    /import \{ screenMatrix, facesInScreenRect \} from '\.\/boxselect\.js'/.test(boxViewerSrc),
);
// A rectangle picks triangles, not vertices: the centre of the triangle decides, and its own
// normal (from its corners, not from a shading normal shared between faces) says which way it
// points — so a box over the face of a closed figure does not also take the back of the head.
check(
  "the rectangle is measured on face centres, by the triangle's own normal",
  /export function facesInScreenRect\(\{/.test(boxSrc) &&
    /const x = \(ax \+ bx \+ cx\) \/ 3;/.test(boxSrc) &&
    /const nx = uy \* vz - uz \* vy;/.test(boxSrc) &&
    /return \{ faces, count, covered, hidden, behind \};/.test(boxSrc) &&
    /camera: \[cam\.x, cam\.y, cam\.z\],\s*\n\s*facingOnly,/.test(boxViewerSrc),
);
check(
  "the camera and the normals are taken in the mesh's own coordinates, which is what the mask counts in",
  /worldToLocal\(this\.camera\.position\.clone\(\)\)/.test(boxViewerSrc) &&
    /positions: this\.baseGeometry\.attributes\.position\.array,/.test(boxViewerSrc),
);
// The rectangle in the models scope: every model one of the covered faces belongs to.
check(
  'the rectangle selects what the scope selects: faces, or the model every covered face is in',
  /const changed = applyPickToSelection\(sel\.faces, drag\);/.test(js) &&
    /if \(cleanup\.scope === 'models'\) \{\s*\n\s*void pickModelsInRect\(sel, drag\);\s*\n\s*return;\s*\n\s*\}/.test(js) &&
    /if \(sel\.faces\[t\]\) touched\.add\(shells\.faceShell\[t\]\);/.test(js),
);
check(
  'a whole drag lands on the selection as one edit, and a drag that changes nothing as none',
  /const wanted = new Uint8Array\(cleanup\.selection\.faces\.length\);/.test(js) &&
    /if \(!countChanges\(cleanup\.selection, wanted, opts\)\) return 0;/.test(js) &&
    /history\.remember\(cleanup\.selection\);\s*\n\s*return applyFaces\(cleanup\.selection, wanted, opts\);/.test(js),
);
check(
  'the status line admits what the box could not take',
  /face away and were left alone/.test(js) && /nothing under the rectangle — drag it over the model/.test(js) &&
    /taken off the pick/.test(js) && /the pick is now exactly those/.test(js),
);
check(
  'boxselect.js keeps the rules a screen-space box needs, and exports them',
  /export function normaliseRect/.test(boxSrc) &&
    /export function screenMatrix/.test(boxSrc) &&
    /export function facesInScreenRect/.test(boxSrc) &&
    !/export function verticesInScreenRect/.test(boxSrc) &&
    /export function rectSize/.test(boxSrc) &&
    /if \(!\(cw > MIN_CLIP_W\)\) \{\s*\n\s*behind \+= 1;/.test(boxSrc) &&
    /if \(clipZ < -cw \|\| clipZ > cw\) continue;/.test(boxSrc) &&
    /return \{ faces, count, covered, hidden, behind \};/.test(boxSrc) &&
    !/facesCamera/.test(boxSrc),
);

// --------------------------------------------------- cleaning up the model
//
// Pick the models in the file (or single faces) and take them out. The picking rule and the
// surgery are measured in `test/select.test.mjs`; what is pinned here is every join between the
// panel, the tool and the geometry: the tool and its key, the scope menu, the three pick buttons,
// the two-click removal, the geometry going back through the loader's own path so the bed is
// re-measured, and the paint and the history being carried across.
const selectSrc = fs.readFileSync(path.resolve(here, '../js/select.js'), 'utf8');
check('the Selection panel carries the Select tool', /<button class="tool" data-tool="select"/.test(html));
check('main.js names it, so the HUD can say what is active', /select: 'Select'/.test(js));
check(
  'and S selects it — whole models, or single faces with Shift',
  /case 's':\s*\n\s*\/\/[^\n]*\n\s*setTool\('select'\);\s*\n\s*setSelectScope\(e\.shiftKey \? 'faces' : 'models'\);/.test(js),
);
check(
  'its options panel exists and is shown for that tool',
  declared.has('selectOptions') && /el\('selectOptions'\)\.classList\.toggle\('on', state\.tool === 'select'\)/.test(js) &&
    /el\('seamOptions'\)\.classList\.toggle\('on', state\.tool === 'part'\)/.test(js) &&
    !/boxOptions/.test(js),
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
  'no brush, fill, eyedropper or paint palette is left in the panel',
  // The three swatches in Preferences are the layer colours, not the paint palette: the check is
  // that nothing paints a model any more, so it looks for the brush and the palette rather than
  // for the word "colour", which the colour preferences legitimately use.
  !/\bbrush\b/i.test(html) &&
    !/Eyedropper|Fill region|palette/i.test(html) &&
    !/id="featureList"|id="palette"/.test(html),
);
check(
  'select all, select none and invert are the three buttons of the panel',
  declared.has('selectAllBtn') && declared.has('selectNoneBtn') && declared.has('selectInvertBtn') &&
    /el\('selectAllBtn'\)\.addEventListener\('click', selectAllFaces\)/.test(js) &&
    /el\('selectNoneBtn'\)\.addEventListener\('click', selectNoFaces\)/.test(js) &&
    /el\('selectInvertBtn'\)\.addEventListener\('click', invertPickedFaces\)/.test(js),
);
check('and Ctrl+A is the same thing, for the few-out-of-many case', /if \(meta && e\.key\.toLowerCase\(\) === 'a'\)/.test(js) && /selectAllFaces\(\);\s*\n\s*return;/.test(js));
check(
  'a press selects nothing on the way down: the gesture is decided on release',
  /function onPointerDown\(e\)[\s\S]{0,600}?startSelectDrag\(e\);\s*\n\}/.test(js) &&
    /function finishSelectDrag\(\)/.test(js),
);
check(
  'a press that does not move is the click it always was, and a moved one is a box',
  /const DRAG_SLOP = 3;/.test(js) &&
    /if \(width < DRAG_SLOP && height < DRAG_SLOP\) return;/.test(js) &&
    /if \(!drag\.active\) \{\s*\n\s*void selectClickAt\(drag\.toClient, drag\);\s*\n\s*return;\s*\n\s*\}/.test(js),
);
check(
  'a click picks the model or the face under the cursor',
  /async function selectClickAt\(client, \{ add = false, remove = false \} = \{\}\)/.test(js) &&
    /const hit = viewer\.pick\(client\.x, client\.y\);/.test(js) &&
    /pickFace\(hit\.faceIndex, \{ add, remove \}\)/.test(js) &&
    /const shell = shells\.faceShell\[hit\.faceIndex\]/.test(js),
);
check(
  'a drag in the Select tool draws the same rectangle and picks what is inside it on release',
  /const sel = viewer\.facesInScreenRect\(normaliseRect\(drag\.from, drag\.to\)\);/.test(js) &&
    /afterSelection\(changed\);/.test(js) &&
    /showBoxRect\(selectDrag\.from, p\);/.test(js),
);
check(
  'the rectangle selects what the scope selects: faces, or the model every covered face is in',
  /applyPickToSelection\(sel\.faces, drag\)/.test(js) &&
    /if \(cleanup\.scope === 'models'\) \{\s*\n\s*void pickModelsInRect\(sel, drag\);\s*\n\s*return;\s*\n\s*\}/.test(js) &&
    /if \(sel\.faces\[t\]\) touched\.add\(shells\.faceShell\[t\]\);/.test(js),
);
// One rule, in the selection core, shared by a click, a rectangle and a panel: plain replaces,
// Shift adds, Alt removes. The app must not reimplement it a third time.
check(
  'a plain drag is the pick outright, Shift drags an addition and Alt drags a removal',
  /export function applyFaces\(sel, wanted, \{ add = false, remove = false \} = \{\}\)/.test(selectionSrc) &&
    /const want = remove\s*\n\s*\? t < n && wanted\[t\]\s*\n\s*\? 0\s*\n\s*: sel\.faces\[t\]/.test(selectionSrc) &&
    !/cleanup\.selected\[t\] = (wanted\[t\] \? 1 : 0)/.test(js) &&
    /add: e\.shiftKey,\s*\n\s*remove: e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey,/.test(js) &&
    /remove: e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey,/.test(js),
);
check(
  'a rectangle still being dragged is thrown away by Esc and by switching tool',
  /case 'escape':[\s\S]{0,120}?if \(selectDrag\) cancelSelectDrag\(\);/.test(js) &&
    /if \(state\.tool !== 'select' && selectDrag\) cancelSelectDrag\(\);/.test(js) &&
    /function cancelSelectDrag\(\)/.test(js),
);
// The reported bug behind this line: a selection that was still there used to stop being drawn as
// soon as another tool came up, so a working selection looked thrown away. The tint is drawn from
// the selection, not from the tool, and there is no longer a path that could say otherwise.
check(
  'the selection is drawn whatever tool is in hand, because it is still the selection',
  /function syncTint\(\) \{[\s\S]{0,300}?tintScratch = paintedFromFaces\(cleanup\.selection, tintScratch\);/.test(js) &&
    !/state\.tool === 'select' \? cleanup\.selection/.test(js) &&
    /function afterSelection\(changed\) \{[\s\S]{0,120}?syncTint\(\);/.test(js),
);
// The other reported dead end: a pick was not paint, so "Build stencil" refused and read as the
// button doing nothing. There is nothing to convert any more — a pick *is* the selection the
// build uses — so the check is that the old two-step is gone and the refusal names both tools.
check(
  'there is no "turn the pick into paint" step left anywhere',
  !declared.has('paintPickedBtn') && !/paintPickedFaces|Paint picked faces/.test(js) &&
    /function selectedMask\(\) \{[\s\S]{0,200}?paintedFromFaces\(cleanup\.selection\)/.test(js),
);
check(
  'and "Build stencil" says how to select, instead of appearing to do nothing',
  /Nothing selected yet — the stencil is built from the selection: click a panel with Part/.test(js) &&
    /or pick triangles with Select faces/.test(js),
);
check('the model list is built from the shells of the file', declared.has('modelRows') && declared.has('modelList') && /function renderShellList\(\)/.test(js) && /shellsOf\(topology\)/.test(js));
check(
  'Esc unpicks everything, and a model list exists to click instead of the viewport',
  /case 'escape':\s*\n\s*if \(selectDrag\) cancelSelectDrag\(\);\s*\n\s*else if \(state\.tool === 'select' && selectedFaces\(\)\) selectNoFaces\(\);/.test(js),
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
  /filterSoup\(\{ positions: soup\.positions, normals: soup\.normals \}, keep\)/.test(js) &&
    !/filterSoup\([\s\S]{0,120}?ids: oldIds/.test(js) &&
    /viewer\.setGeometry\(geometry, \{\s*\n\s*upAxis: state\.upAxis,\s*\n\s*overlayGeometry,\s*\n\s*centre: el\('centreOnGrid'\)\.checked,/.test(js),
);
check(
  'the selection is carried through the cut, face by face, and the undo history with it',
  /cleanup\.selection = remapSelection\(cleanup\.selection, cut\.faceMap, cut\.faces\)/.test(js) &&
    /history\.remap\(cut\.faceMap, cut\.faces\)/.test(js) &&
    /export function remapSelection\(sel, faceMap, newCount\)/.test(selectionSrc) &&
    /remap\(faceMap, faceCount\)/.test(selectionSrc) &&
    !/remapHistory/.test(js),
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
//
// The second bug pinned here is why the drawing lives in its own module: the first version kept
// the colours in a destructured third argument and was *also* called to clear the highlight, with
// two arguments. That threw on every model load — the loading overlay stuck on "Preparing mask
// layer…" and nothing ever loaded — and no source pattern above could see it, because nothing ran
// the code. `js/highlight.js` takes the group to draw into as an argument, and `test/select.test.mjs`
// draws, replaces and clears a highlight for real; these are the joins to it.
const highlightSrc = fs.readFileSync(path.resolve(here, '../js/highlight.js'), 'utf8');
check(
  'main.js imports the highlight helpers, so they are in scope where it calls them',
  /^import \{ drawHighlight, clearHighlight, HIGHLIGHT_FACE_LIMIT \} from '\.\/highlight\.js';$/m.test(js),
);
check(
  'the hovered face is drawn as a filled, offset tint, not as hairlines on the surface',
  /function updateHoverFace\(faceIndex\)/.test(js) &&
    /cleanup\.hover = drawHighlight\(viewer\.modelGroup, mask\.position\.array, cleanup\.hover, under, \{\s*\n\s*color: 0xffffff,/.test(js) &&
    /new THREE\.Mesh\(\s*\n\s*data\.fill,\s*\n\s*new THREE\.MeshBasicMaterial\(\{/.test(highlightSrc) &&
    /const offset = \{ polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 \};/.test(highlightSrc) &&
    /side: THREE\.DoubleSide,\s*\n\s*\.\.\.offset,/.test(highlightSrc) &&
    /new THREE\.LineSegments\(\s*\n\s*data\.edges,/.test(highlightSrc),
);
// The selection itself is drawn by the tint the mask layer writes into the overlay geometry, which
// is a different thing from the hover outline: one is the selection, the other follows the cursor.
check(
  'the selection is tinted by the mask layer, and the hover by the highlight module',
  /overlayGeometry\.setAttribute\('color', new THREE\.BufferAttribute\(mask\.colors, 4\)\);/.test(js) &&
    /_writeVertex\(i\)/.test(maskSrc) && /export function hexToRgb/.test(selectionSrc) &&
    /color: 0xffffff/.test(js) && /cleanup\.hover = clearHighlight\(viewer\.modelGroup, cleanup\.hover\);/.test(js),
);
// The shipped crash, as a rule rather than a memory: drawing has defaults for every option and
// clearing is a function of its own, so no path can destructure an options object it was not given.
check(
  'the highlight options all have defaults, so drawing cannot be called without them',
  /export function drawHighlight\(\s*\n\s*parent,\s*\n\s*positions,\s*\n\s*existing,\s*\n\s*faceMask,\s*\n\s*\{ color = 0xffffff, fillOpacity = 0\.4, lineOpacity = 0\.9, order = 2, limit = HIGHLIGHT_FACE_LIMIT \} = \{\},/.test(highlightSrc),
);
check(
  'clearing the highlight is its own function, so it cannot be a draw call missing its options',
  /export function clearHighlight\(parent, group\)/.test(highlightSrc) &&
    /cleanup\.hover = clearHighlight\(viewer\.modelGroup, cleanup\.hover\);/.test(js) &&
    /function clearHoverFace\(\)/.test(js) &&
    !/drawHighlight\([^)]*null\)/.test(js),
);
// The load path is where the crash left the app stuck, and it is also where a stale selection would
// come from if one were kept: a fresh model gets a fresh tint and an empty selection, and nothing
// survives from the model before it.
check(
  'a new model gets a new tint and an empty selection, so nothing survives the load',
  /mask = new SelectionTint\(overlayGeometry\);\s*\n\s*overlayGeometry\.setAttribute\('color', new THREE\.BufferAttribute\(mask\.colors, 4\)\);/.test(js) &&
    /function resetSelection\(\) \{\s*\n\s*cleanup\.selection = createSelection\(faceCountInHand\(\)\);/.test(js) &&
    !/resetPickedFaces|updatePickHighlight/.test(js),
);
check(
  'and the panel is told, rather than left showing the last model’s numbers',
  /function resetSelection\(\) \{[\s\S]{0,500}?updateStats\(\);[\s\S]{0,80}?updateHud\(\);/.test(js),
);
check(
  'a selection too big to tint says so in the panel instead of silently drawing nothing',
  /export const HIGHLIGHT_FACE_LIMIT = 150000;/.test(highlightSrc) &&
    /import \{ drawHighlight, clearHighlight, HIGHLIGHT_FACE_LIMIT \} from '\.\/highlight\.js';/.test(js) &&
    /picked > HIGHLIGHT_FACE_LIMIT \? ' · too many to tint in the viewport, so the tint is off' : ''/.test(js) &&
    /export function highlightArrays\(positions, faceMask, \{ limit = 150000 \} = \{\}\)/.test(selectSrc),
);
check(
  'a one-model file does not tint the whole model on hover — there is nothing to choose there',
  /const whole =\s*\n\s*cleanup\.scope === 'models' && shells && shells\.shellCount > 1 \? shells\.faceShell\[faceIndex\] : undefined;/.test(js) &&
    /This file holds one model, so a click here selects the whole file/.test(js),
);
check(
  'select.js keeps the rules the cleanup needs, and exports them',
  /export function shellsOf/.test(selectSrc) && /export function filterSoup/.test(selectSrc) &&
    /export function shellSize/.test(selectSrc) && /export function countFaces/.test(selectSrc) &&
    /const key = a < b \? a \* ID_SHIFT \+ b : b \* ID_SHIFT \+ a;/.test(selectSrc) &&
    !/remapHistory|inverseCornerMap|pickedCorners/.test(selectSrc),
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
// be a session (rather than just a vertex list) is the selection and the build settings.
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
  'a loaded selection becomes the selection, and is compared against the build in hand',
  /mask\.loadPairs\(pairs\);[\s\S]{0,400}?history\.remember\(cleanup\.selection\);/.test(js) &&
    /cleanup\.selection\.faces\.set\(facesFromPainted\(painted, cleanup\.selection\.faces\.length\)\)/.test(js) &&
    /mask\.loadPairs\(pairs\);[\s\S]{0,900}?updateStencilStats\(\);/.test(js),
);
check(
  'the buttons read as save and open, and both say how to carry on',
  /Save selection \(JSON\)/.test(html) &&
    /Open selection \(JSON\)/.test(html) &&
    /“Open selection \(JSON\)” brings it back to carry on/.test(js) &&
    /Click a panel with Part to add to it, then “Build stencil”/.test(js),
);
check(
  'and the panel says a mask saved by the painting version opens as one selection',
  /all of them come back as the[\s\S]{0,40}?one selection/.test(html),
);

// ------------------------------------------------- the viewport visibility chips
//
// Once a shell is built, three layers can hide one another: the shell, the model under it, and the
// amber tint of the selected faces. What can go wrong silently is the *join* rather than any one
// switch: a chip that reports a state the viewport is not in, a second path that sets a layer
// without the chips hearing about it, or the one coupling rule (the shell going off must put the
// model back on, or the viewport is empty) living in one control and not the other.
const viewChips = [
  ['viewStencilBtn', 'stencil'],
  ['viewModelBtn', 'model'],
  ['viewHighlightBtn', 'highlight'],
];
check(
  'the viewport carries a chip per layer, and main.js knows the same three',
  viewChips.every(([id]) => new RegExp(`id="${id}"`).test(html)) &&
    viewChips.every(([, layer]) => new RegExp(`layer: '${layer}'`).test(js)) &&
    /const VIEW_CHIPS = \[\s*\n\s*\{ id: 'viewStencilBtn', layer: 'stencil' \},/.test(js),
);
check(
  'each chip is both the switch and the state indicator, and the state comes from the layer',
  /function viewState\(\) \{[\s\S]{0,200}?stencil: !!stencil\.mesh && stencil\.mesh\.visible,[\s\S]{0,120}?model: el\('showBase'\)\.checked,[\s\S]{0,120}?highlight: el\('showOverlay'\)\.checked,/.test(js) &&
    /function updateViewState\(\) \{[\s\S]{0,400}?btn\.dataset\.state = on \? 'on' : 'off';[\s\S]{0,200}?btn\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/.test(js) &&
    /btn\.disabled = chip\.layer === 'stencil' && !built;/.test(js) &&
    /\.view-toggle::after \{\s*\n\s*content: attr\(data-state\);/.test(fs.readFileSync(path.resolve(here, '../css/style.css'), 'utf8')),
);
check(
  'and the page says what the chips are for, in the panel the switches live in',
  /id="viewState"[^>]*role="group"/.test(html) &&
    /the three chips in the top-right corner of the viewport/i.test(html),
);
// One switch, two controls: the chips and the panel's own checkboxes both go through
// `setViewLayer`, so neither can set a layer behind the other's back.
check(
  'a chip and the panel checkbox for the same layer run the same code',
  /function setViewLayer\(layer, on, \{ announce = true \} = \{\}\)/.test(js) &&
    /el\('showBase'\)\.addEventListener\('change', \(e\) => setViewLayer\('model', e\.target\.checked, \{ announce: false \}\)\);/.test(js) &&
    /el\('showOverlay'\)\.addEventListener\('change', \(e\) =>\s*\n\s*setViewLayer\('highlight', e\.target\.checked, \{ announce: false \}\),/.test(js) &&
    /el\('stencilPreview'\)\.addEventListener\('change', \(e\) =>\s*\n\s*setViewLayer\('stencil', e\.target\.checked, \{ announce: false \}\),/.test(js) &&
    /for \(const chip of VIEW_CHIPS\) \{\s*\n\s*el\(chip\.id\)\.addEventListener\('click',/.test(js),
);
check(
  'no handler reaches a layer directly, where the chips would never hear about it',
  !/el\('showBase'\)\.addEventListener\('change', \(e\) => viewer\.setBaseVisible/.test(js) &&
    !/el\('showOverlay'\)\.addEventListener\('change', \(e\) => viewer\.setOverlayVisible/.test(js) &&
    !/el\('stencilPreview'\)\.addEventListener\('[a-z]+', \(e\) => \{\s*\n\s*if \(stencil\.mesh\) stencil\.mesh\.visible = e\.target\.checked;/.test(js),
);
// The rule the request is about: the shell off means the model on. It is applied wherever the
// shell goes away — the chip (and the `Preview` checkbox, which is the same switch), a discard and
// a new model — so there is no way to end up looking at an empty viewport.
check(
  'hiding the stencil puts the model back on, so the viewport is never empty',
  /function showModelIfHidden\(\) \{\s*\n\s*if \(el\('showBase'\)\.checked\) return false;\s*\n\s*el\('showBase'\)\.checked = true;\s*\n\s*viewer\.setBaseVisible\(true\);\s*\n\s*return true;/.test(js) &&
    /if \(!on\) forcedModel = showModelIfHidden\(\);/.test(js),
);
check(
  'and the three places the shell disappears apply it too: discard and a new model',
  /function discardStencil\(\)[\s\S]{0,800}?showModelIfHidden\(\);/.test(js) &&
    /function resetStencil\(\)[\s\S]{0,400}?const hadShell = !!stencil\.mesh;[\s\S]{0,200}?if \(hadShell\) showModelIfHidden\(\);/.test(js),
);
check(
  'the tint is never forced: the coupling is the model alone',
  !/showOverlay'\)\.checked = true;/.test(js.slice(js.indexOf('function setViewLayer('), js.indexOf('function applyDisplayState('))) &&
    /selection tint keeps its own switch/.test(js),
);
// The chips are only as honest as their refresh points. Every path that builds, drops or refuses a
// shell has to redraw them, or the chip describes the last build instead of this one.
check(
  'every path that changes whether a shell exists redraws the chips',
  (js.match(/updateViewState\(\);/g) || []).length >= 5 &&
    /stencil\.mesh\.visible = el\('stencilPreview'\)\.checked;\s*\n\s*viewer\.modelGroup\.add\(stencil\.mesh\);\s*\n\s*updateViewState\(\);/.test(js) &&
    /function resetStencil\(\)[\s\S]{0,900}?updateViewState\(\);/.test(js) &&
    // 800 rather than the original 400: applying the colour preferences on every geometry install
    // (a reload, a removal) added a call and a note to `applyDisplayState`, and the point of the
    // pattern is that the function ends by redrawing the chips, not the exact byte count.
    /function applyDisplayState\(\)[\s\S]{0,800}?updateViewState\(\);/.test(js),
);
check(
  'and the chips are reachable from the console handle, like every other scripted check',
  /\n\s*setViewLayer,\n\s*viewState,\n\s*updateViewState,/.test(js),
);

// ------------------------------------------------- reloading, colours and the label
//
// Five things a user asked for after the chips landed, each of which fails silently when it is only
// half-wired: a Reload button that reloads the file that is actually open, three colour
// preferences, the remove-button label that has to name itself again, work that must not take the
// viewport away, and a click that must wait for a running cut instead of being dropped.
check('the top bar carries a Reload button, disabled until a model is loaded', /id="reloadBtn" disabled/.test(html) && /id="reloadBtn"/.test(html));
check('and it is wired to one function', /el\('reloadBtn'\)\.addEventListener\('click', \(\) => void reloadModel\(\)\)/.test(js) && /async function reloadModel\(\)/.test(js));
check(
  'Reload re-loads the file the session started from — a URL or a file handle',
  /lastSource = \{ kind: 'url'|\{ kind: 'url', url \}/.test(js) &&
    /kind: 'file', file/.test(js) &&
    /if \(lastSource\.kind === 'url'\)/.test(js) &&
    /lastSource\.file\.arrayBuffer\(\)/.test(js),
);
check(
  'a load is what enables it, and a failed reload does not claim to have started over',
  /if \(source\) setLastSource\(source\);\s*\n\s*loadCount \+= 1;/.test(js) &&
    /if \(loadCount === before\) return;/.test(js),
);
check(
  'a new model is a new undo history',
  /history\.clear\(\);/.test(js) && /clear\(\) \{\s*\n\s*this\.undoStack\.length = 0;/.test(selectionSrc),
);
check(
  'Preferences carries the three layer colours, with the defaults the docs quote',
  declared.has('colorModel') && declared.has('colorSelection') && declared.has('colorStencil') &&
    /id="colorModel" value="#9aa4b2"/.test(html) &&
    /id="colorSelection" value="#ffc94d"/.test(html) &&
    /id="colorStencil" value="#ffb703"/.test(html),
);
check(
  'each swatch feeds one colour, and only through setColorPref',
  /for \(const \[key, spec\] of Object\.entries\(COLOR_PREFS\)\)/.test(js) &&
    /input\.addEventListener\('input', \(\) => setColorPref\(key, input\.value, \{ save: false \}\)\)/.test(js) &&
    /el\('colorsResetBtn'\)\.addEventListener\('click', resetColorPrefs\)/.test(js),
);
check(
  'the three colours reach the three layers, and are re-painted when a geometry is installed',
  /viewer\.setBaseColor\(colors\.model\)/.test(js) &&
    /mask\.setColor\(colors\.selection\)/.test(js) &&
    /stencil\.mesh\.material\.color\.set\(colors\.stencil\)/.test(js) &&
    /setBaseColor\(hex\) \{/.test(viewerSrc) &&
    /setColor\(hex\) \{/.test(maskSrc) &&
    /color: colors\.stencil,/.test(js) &&
    /function applyDisplayState\(\)[\s\S]{0,800}?applyColors\(\);/.test(js),
);
check(
  'and are remembered in the browser, not in the build',
  /localStorage\.getItem\(PREFS_KEY\)/.test(js) && /localStorage\.setItem\(PREFS_KEY/.test(js) &&
    /loadColorPrefs\(\);/.test(js) && /saveColorPrefs\(\)/.test(js),
);
check(
  'the Remove button names itself again: the label follows the armed state',
  /function syncRemoveLabel\(\)/.test(js) &&
    /btn\.textContent = cleanup\.armedAt \? 'Click again to remove' : 'Remove selected'/.test(js) &&
    /setTimeout\(\(\) => \{[\s\S]{0,200}?cleanup\.armedAt = 0;[\s\S]{0,200}?syncRemoveLabel\(\);/.test(js) &&
    /function afterSelection\(changed\) \{[\s\S]{0,120}?disarmRemove\(\);/.test(js),
);
check(
  'a freshly loaded page cannot remove on the first click (zero is not a timestamp)',
  /const armed = cleanup\.armedAt > 0 && !\(now - cleanup\.armedAt > 4000\)/.test(js),
);
check(
  'work a click starts reports in the chip, not under the full-screen overlay',
  declared.has('working') && declared.has('workingText') && /\.working\b/.test(cssSrc) &&
    /function setWorking\(show, text\)/.test(js) &&
    /const report = \(text\) => \(quiet \? setWorking\(true, text\) : setLoading\(true, text\)\)/.test(js) &&
    /ensureParts\(\{ quiet: true \}\)/.test(js),
);
check(
  'the weld, the cut and the model count are shared in-flight, so a click waits instead of getting null',
  /stencil\.topologyPromise/.test(js) && /parts\.promise/.test(js) && /cleanup\.shellsPromise/.test(js) &&
    !/parts\.building/.test(js) && !/shellsPending/.test(js),
);

console.log(`\n${missing.length + missingExports.length + (failures ? 1 : 0) === 0 ? 'all wiring checks passed' : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
