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

const stencilIds = ['stencilBuildBtn', 'stencilExportBtn', 'stencilPreview', 'stencilReach', 'stencilWall', 'stencilStandoff', 'stencilOverhang', 'stencilStats'];
const missingStencil = stencilIds.filter((id) => !declared.has(id));
check('the stencil panel is complete', missingStencil.length === 0, missingStencil.join(', '));

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
check('the guard exempts the Part tool so Alt-click reaches it',
  /function modifierClickIgnored\(e\) \{\s*\n\s*return \(e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey\) && state\.tool !== 'part';/.test(js));
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

console.log(`\n${missing.length + missingExports.length + (failures ? 1 : 0) === 0 ? 'all wiring checks passed' : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
