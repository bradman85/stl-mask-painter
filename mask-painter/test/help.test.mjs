// Keeps the on-screen guide (help.html) honest against the app (index.html).
//
// A guide rots the moment a control is added and the doc is not touched. These
// checks fail the build when index.html grows a control the guide never
// mentions, when a panel's "?" link points at a section that does not exist,
// or when one of the documented formats (mask JSON / import / PLY / STL)
// loses its section.
//
// Node only: reads the two HTML files as text. No browser, no three.js.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const helpHtml = readFileSync(join(root, 'help.html'), 'utf8');

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else failures.push(detail ? `${name} — ${detail}` : name);
}

// ---------- text helpers -------------------------------------------------
const decode = (s) =>
  s.replace(/&hellip;/g, '…').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&deg;/g, '°').replace(/&times;/g, '×').replace(/&rarr;/g, '→')
    .replace(/&mdash;/g, '—').replace(/&minus;/g, '-').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (t) => decode(t.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const norm = (t) => strip(t).toLowerCase();

// The guide's readable text, tags removed, so we can search it.
const helpText = norm(helpHtml);

// A panel label like "Seam angle 12°" or "Up axis <select>" reduces to the words
// that name the control: drop any options a <select> carries, drop a trailing
// parenthetical, then everything from the first live value on.
function controlName(label) {
  let s = strip(label);
  for (const opt of optionTexts) s = s.split(opt).join(' ');
  const paren = s.search(/\s*[（(]/);
  if (paren > 0) s = s.slice(0, paren);
  const words = s.split(' ').filter(Boolean);
  const cut = words.findIndex((w) => /[0-9]/.test(w) || w === '…');
  if (cut > 0) words.length = cut;
  // Trailing connectives the markup puts before the input ("...plane at <input>").
  while (words.length && /^(at|to|on|of|in|with|and|across)$/i.test(words[words.length - 1])) words.pop();
  return words.join(' ').replace(/…$/, '').trim().toLowerCase();
}
// Compared against the lower-cased guide text, so the name is lower-cased too — a caller that
// passes a label as it is written on screen must not silently fail.
const mentions = (name) => helpText.includes(name.toLowerCase().replace(/\s+/g, ' '));

// ---------- 1. the guide exists and is wired to the app ------------------
check('index.html links to help.html', /href="help\.html"/.test(indexHtml));
check('guide links back to the app', /href="index\.html"/.test(helpHtml) || /index\.html#/.test(helpHtml));
check('guide has a top-bar section', /id="topbar"/.test(helpHtml));

// ---------- 2. every panel "?" link resolves to a real section ----------
const anchorLinks = [...indexHtml.matchAll(/href="help\.html#([^"]+)"/g)].map((m) => m[1]);
check('every panel has a guide link', anchorLinks.length >= 6, `found ${anchorLinks.length}`);
const sectionIds = new Set([...helpHtml.matchAll(/<(?:section|h[2-4])[^>]*id="([^"]+)"/g)].map((m) => m[1]));
for (const a of new Set(anchorLinks)) {
  check(`anchor #${a} exists in the guide`, sectionIds.has(a));
}

// ---------- 3. every in-page nav link in the guide resolves --------------
const helpHrefs = [...helpHtml.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
for (const a of new Set(helpHrefs)) {
  check(`guide nav #${a} resolves`, sectionIds.has(a) || new RegExp(`id="${a}"`).test(helpHtml));
}

// ---------- 4. every control the user can see is documented --------------
const labels = [...indexHtml.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => strip(m[1]));
const buttons = [...indexHtml.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => strip(m[1]));
const options = [...indexHtml.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => strip(m[1]));
// A <select>'s options are documented as separate rows, so they must not be
// folded into the label that wraps the select.
const optionTexts = options.map((o) => strip(o)).sort((a, b) => b.length - a.length);

const seen = new Set();
for (const raw of [...labels, ...options]) {
  const name = controlName(raw);
  if (!name || seen.has(name)) continue;
  seen.add(name);
  check(`guide documents "${raw}"`, mentions(name));
}
for (const raw of buttons) {
  const name = controlName(raw).replace(/^navigate.*/, 'navigate');
  if (seen.has('button:' + name)) continue;
  seen.add('button:' + name);
  check(`guide documents button "${raw}"`, mentions(name));
}

// The paint tools are the ones a reader most needs named, and single common
// words would pass a loose substring test — so require them inside the tools
// section specifically.
const toolsSection = (() => {
  const from = helpHtml.indexOf('id="paint-tools"');
  if (from < 0) return '';
  const next = helpHtml.indexOf('<h3', from + 10);
  return norm(helpHtml.slice(from, next < 0 ? from + 4000 : next));
})();
check('guide has a paint-tools section', toolsSection.length > 0);
for (const tool of ['Brush', 'Erase', 'Region fill', 'Part', 'Pick', 'Add']) {
  check(`tools section names "${tool}"`, toolsSection.includes(tool.toLowerCase()));
}

// ---------- 5. the formats the user asked about are covered --------------
const required = [
  ['mask JSON format', 'mask-json'],
  ['import mask JSON', 'import-json'],
  ['PLY export format', 'ply'],
  ['STL export format', 'stl'],
];
for (const [what, id] of required) {
  check(`guide documents the ${what}`, sectionIds.has(id));
  check(`the ${what} section has prose`, new RegExp(`id="${id}"[\\s\\S]{40,}`).test(helpHtml));
}
check('guide mentions the Mask JSON button', helpText.includes('mask json'));
check('guide mentions the Painted shell PLY button', helpText.includes('painted shell ply'));
check('guide mentions the Import mask JSON button', helpText.includes('import mask json'));
// The copy buttons in the guide are how a reader gets a real file into the
// editor; if they vanish the sections above become decorative.
// The sample is only useful if the reader can get it out of the page, so the
// copy helper has to put a button on every code block.
check('guide adds a copy button to every pre', /querySelectorAll\('pre'\)/.test(helpHtml) && /className = 'copy'/.test(helpHtml));
check('copy button excludes its own label from the copied text', /cloneNode\(true\)[\s\S]{0,200}\.copy/.test(helpHtml));
check('copy has a non-clipboard fallback', /navigator\.clipboard\.writeText/.test(helpHtml) && /execCommand\('copy'\)/.test(helpHtml));
check('guide has a filter box', /id="filter"/.test(helpHtml));

// ---------- 6. the app can actually launch the guide --------------------
const mainJs = readFileSync(join(root, 'js/main.js'), 'utf8');
check('the app defines openGuide', /function openGuide\s*\(/.test(mainJs));
check('openGuide opens help.html', /new URL\('help\.html'/.test(mainJs));
check('openGuide is reachable from the console handle', /\bok,\n\s*openGuide|\n\s*openGuide,/.test(mainJs));
check('"?" opens the guide', /case '\?':/.test(mainJs));
check('F1 opens the guide', /case 'f1':/.test(mainJs));

// ---------- 7. the formats actually match the code ----------------------
const ioJs = readFileSync(join(root, 'js/io.js'), 'utf8');
const appJs = readFileSync(join(root, 'js/main.js'), 'utf8');
// Sample the two JSON files the guide embeds and prove the app can read them.
const jsonSamples = [...helpHtml.matchAll(/<pre class="json">([\s\S]*?)<\/pre>/g)].map((m) => decode(m[1]));
check('guide embeds a ready-to-import mask', jsonSamples.length > 0);
for (const [i, raw] of jsonSamples.entries()) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* reported below */ }
  check(`embedded JSON sample ${i + 1} parses`, parsed !== null);
  if (parsed && parsed.kind === 'mask') {
    check('sample masks carry features', Array.isArray(parsed.features) && parsed.features.length > 0);
    check('sample masks carry a model name', typeof parsed.model === 'string' && parsed.model.length > 0);
    // The app's importer keys off exactly these fields.
    check('importer reads "features"', /\.features/.test(appJs));
    check('importer reads "model"', /\bmodel\b/.test(appJs));
  }
}
check('guide documents the version field', /"version"/.test(helpHtml));
check('io.js exports the mask JSON builder the guide describes', /export function buildMaskJSON/.test(ioJs));
// The session fields are part of the format the guide documents, so the schema in the guide and the
// writer have to agree on them: a saved mask that carries settings the guide never mentions (or a
// guide that documents a field nothing writes) is the drift this file exists to catch.
check(
  "the guide's schema documents the saved build settings",
  /"stencil"/.test(helpHtml) && /out\.stencil = stencil/.test(ioJs),
);
check('io.js reads them back, and does not require them', /stencil: parseStencilSettings\(data\.stencil\)/.test(ioJs));
check('the import section explains saving your place', /<h3 id="import-json">[\s\S]{0,4000}?Saving your place and carrying on/.test(helpHtml));
check('io.js exports the mask JSON parser the guide describes', /export function parseMaskJSON/.test(ioJs));
check('io.js exports a PLY writer', /export function buildPLY/.test(ioJs));
check('io.js exports a binary STL writer', /export function buildBinarySTL/.test(ioJs));
// The guide names the real format constants, so a rename cannot leave it lying.
check('guide names the format constant value', helpText.includes('stl-mask'));
check('io.js format constant matches the guide', /MASK_FORMAT = 'stl-mask'/.test(ioJs));

// ---------- 8. the guide's suite list matches what npm test runs ---------
// The guide names a count of suites and each one by file. Adding a seventh
// suite (or renaming one) and not touching the doc is exactly the drift this
// file exists to catch, so the doc is checked against package.json itself.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const suites = [
  ...new Set([...(pkg.scripts?.test || '').matchAll(/test\/([a-z0-9-]+)\.test\.mjs/g)].map((m) => m[1])),
];
const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = NUMBERS[suites.length] || String(suites.length);
check('npm test runs at least one suite', suites.length > 0, pkg.scripts?.test);
for (const name of suites) check(`guide names the ${name} suite`, helpText.includes(`test/${name}.test.mjs`));
check(
  `guide says npm test runs ${count} suite(s)`,
  helpText.includes(`${count} suite`),
  `${suites.length} suites in package.json (${suites.join(', ')})`,
);
// Every suite on disk has to be run, or the count above and the guide's
// promises describe a test run that is not the one you get.
const onDisk = readdirSync(join(root, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => f.replace(/\.test\.mjs$/, ''));
for (const name of onDisk) check(`${name}.test.mjs is run by npm test`, suites.includes(name));

// ---------- 9. the validation document tracks the guide -----------------
// VALIDATION.md is the manual half of "how it is verified": one item per feature, with steps
// and an expected result. It rots exactly the way the guide does, so it is checked here.
const validation = readFileSync(join(root, 'VALIDATION.md'), 'utf8');
const validationText = norm(validation);
const items = [...validation.matchAll(/^#### (\S+) · /gm)].map((m) => m[1]);
const countOf = (re) => (validation.match(re) || []).length;
check('the validation document has items', items.length >= 40, `${items.length} items`);
check('every validation item id is unique', new Set(items).size === items.length);
check(
  'every item has the same four parts',
  countOf(/^\*\*Steps\*\*$/gm) === items.length &&
    countOf(/^\*\*Expected\*\*/gm) === items.length &&
    countOf(/^\*\*Guide\*\*/gm) === items.length &&
    countOf(/^\*\*Result\*\*/gm) === items.length,
  `${items.length} items vs ${countOf(/^\*\*Steps\*\*$/gm)} steps / ${countOf(/^\*\*Expected\*\*/gm)} expected / ${countOf(/^\*\*Guide\*\*/gm)} guide / ${countOf(/^\*\*Result\*\*/gm)} result`,
);

// Each guide section has to be tested by at least one item, or a whole panel can be added to
// the app and the guide and never reach the checklist. The anchor is matched with its closing
// bracket so "#paint" is not satisfied by "#paint-tools".
const guideLines = validation.match(/^\*\*Guide\*\*.*$/gm) || [];
const docSectionIds = [...helpHtml.matchAll(/<section class="doc" id="([^"]+)"/g)].map((m) => m[1]);
check('the guide has sections to validate', docSectionIds.length >= 8, docSectionIds.join(', '));
for (const id of docSectionIds) {
  check(`some item tests the ${id} section`, guideLines.some((l) => l.includes(`(help.html#${id})`)));
}

// Every link in the document has to point at a section that exists (the anchor set from
// section 2 above covers the sub-headings as well as the panels).
const referenced = [...validation.matchAll(/help\.html#([a-z0-9-]+)/g)].map((m) => m[1]);
check('the document references guide anchors', referenced.length > 0);
for (const a of new Set(referenced)) check(`VALIDATION.md points at a real section: #${a}`, sectionIds.has(a));

// The coverage matrix has to span every item: for each prefix, it must list a range from the
// first item to the last, so an added item cannot fall outside the map.
const matrixStart = validation.indexOf('## Coverage matrix');
const matrix = validation.slice(matrixStart, validation.indexOf('# A. Startup'));
// A row may list a run ("L1–L7") or a single item ("N4"), so the second half is optional.
const ranges = [...matrix.matchAll(/([A-Z]+)(\d+)(?:–([A-Z]+)(\d+))?/g)].map((m) => [
  m[1],
  Number(m[2]),
  m[3] || m[1],
  m[4] ? Number(m[4]) : Number(m[2]),
]);
// Ranges are compared as numbers, so a typo in the matrix is a failure rather than a string
// comparison that quietly passes.
check('the coverage matrix has ranges', matrixStart > 0 && ranges.length > 0);
for (const p of new Set(items.map((i) => i.replace(/\d+$/, '')))) {
  const nums = items.filter((i) => i.startsWith(p)).map((i) => Number(i.slice(p.length)));
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  // A prefix may be split across rows (the N items are listed by section), so merge the rows
  // and check the merged span reaches the last item without a gap.
  const spans = ranges.filter(([a, , b]) => a === p && b === p).map(([, l, , h]) => [l, h]).sort((x, y) => x[0] - y[0]);
  let reach = lo - 1;
  for (const [l, h] of spans) if (l <= reach + 1 && h > reach) reach = h;
  check(
    `the coverage matrix spans ${p}${lo}–${p}${hi}`,
    spans.length > 0 && reach >= hi,
    spans.length ? `rows cover ${p}${lo}–${p}${reach}` : 'no row for this prefix',
  );
}

// The sign-off block counts the items, so it cannot be left stale.
const signoff = validation.match(/Items run \| ___ of (\d+) \|/);
check('the sign-off count matches the items', signoff !== null && Number(signoff[1]) === items.length, `${signoff && signoff[1]} vs ${items.length}`);
check('the document tells the tester how to run the app', validationText.includes('node serve.mjs'));
check('the document records what must not be logged as a failure', /Do not log these as failures/i.test(validation));
check('the guide links to the validation document', /href="VALIDATION\.md"/.test(helpHtml));
check('the README links to the validation document', /VALIDATION\.md/.test(readFileSync(join(root, 'README.md'), 'utf8')));

// ---------- 10. the seam-angle default and its presets agree everywhere ---
// The default angle is written down in four places — the segmentation code, the slider markup,
// the slider's readout and the guide's table — and the presets in three (the code list, the
// buttons and the guide). A preset row is worse than useless if the guide's measurements belong
// to different angles, so all of them are checked against each other rather than trusted.
const partsJs = readFileSync(join(root, 'js/parts.js'), 'utf8');
const defaultAngle = Number((partsJs.match(/DEFAULT_SEAM_ANGLE\s*=\s*(\d+)/) || [])[1]);
check('parts.js declares a seam-angle default', Number.isFinite(defaultAngle), `DEFAULT_SEAM_ANGLE = ${defaultAngle}`);
const sliderAngle = Number((indexHtml.match(/id="seamAngle"[^>]*value="(\d+)"/) || [])[1]);
check(
  'the slider starts at the angle the code uses',
  sliderAngle === defaultAngle,
  `slider ${sliderAngle} vs DEFAULT_SEAM_ANGLE ${defaultAngle}`,
);
const readoutAngle = Number((indexHtml.match(/id="seamAngleVal">(\d+)&deg;/) || [])[1]);
check('the slider readout shows the same angle', readoutAngle === defaultAngle, `readout ${readoutAngle}`);

// The preset list in main.js, and the buttons that offer it.
const presetBlock = mainJs.match(/const SEAM_PRESETS = \[([\s\S]*?)\];/);
const codePresets = [...(presetBlock ? presetBlock[1].matchAll(/angle:\s*(\d+),\s*label:\s*'([^']+)'/g) : [])].map(
  (m) => ({ angle: Number(m[1]), label: m[2] }),
);
check('main.js lists seam-angle presets', codePresets.length >= 3, `${codePresets.length} presets`);
const markupPresets = [...indexHtml.matchAll(/data-seam="(\d+)"[^>]*>([^<]*)</g)].map((m) => ({
  angle: Number(m[1]),
  label: decode(m[2]).replace(/\s*\d+°$/, '').trim(),
}));
check(
  'the markup offers the same presets as the code',
  markupPresets.length === codePresets.length &&
    markupPresets.every((p) => codePresets.some((c) => c.angle === p.angle && c.label === p.label)),
  `${markupPresets.map((p) => `${p.label} ${p.angle}`).join(', ')} vs ${codePresets.map((p) => `${p.label} ${p.angle}`).join(', ')}`,
);
check('one preset is the default angle', codePresets.some((c) => c.angle === defaultAngle), `default ${defaultAngle}`);
const guideRows = [...helpHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => decode(m[1]));
for (const c of codePresets) {
  // Whole words against the lower-cased guide text, so "Portrait" cannot be satisfied by
  // "PortraitX" or by a longer unrelated word.
  check(`the guide names the ${c.label} preset`, new RegExp(`\\b${c.label.toLowerCase()}\\b`).test(helpText), c.label);
  // The measured table is what makes the preset credible, so the row for that angle has to name
  // that preset — the numbers and the button cannot drift apart. Matched as a whole cell label
  // (`>Portrait<`), so a renamed or typo'd pill is a failure rather than a substring hit.
  check(
    `the guide's table lists ${c.label} at ${c.angle}°`,
    guideRows.some((row) => row.includes(`${c.angle}°`) && row.includes(`>${c.label}<`)),
    guideRows.filter((r) => r.includes(`${c.angle}°`)).map((r) => r.replace(/\s+/g, ' ').slice(0, 90)).join(' || '),
  );
}
check('the guide states the default angle', helpText.includes(`default ${defaultAngle}°`));
// The row that carries the "default" marker, which may also name its preset after it.
const defaultRow = helpHtml.match(/<td class="k">(\d+)° <span class="pill now">default<\/span>/);
check(
  `the guide marks the ${defaultAngle}° row as the default`,
  defaultRow !== null && Number(defaultRow[1]) === defaultAngle,
  defaultRow ? `marked row is ${defaultRow[1]}°` : 'no row marked',
);
// The guide quotes a status line the app builds. If either side is reworded the sample becomes a
// lie, so the phrase that carries the new guidance has to exist on both sides.
check(
  'the guide quotes the status line the app builds',
  helpHtml.includes('the detail you aimed at is probably Part') &&
    mainJs.includes('the detail you aimed at is probably Part') &&
    /\$\{verb\} part \$\{partId \+ 1\} of \$\{d\.partCount\}/.test(mainJs) &&
    /<pre>Selected part 1 of 26/.test(helpHtml),
);

// ---------- report -------------------------------------------------------
console.log(`help.test.mjs: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(1);
}
