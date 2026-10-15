// Verifies the printable-stencil generator on the real model (Sprunki Mercuy.stl).
//
//   node test/stencil.test.mjs
//
// The headline functional question is the one the app promises: does the generated part
// expose ONLY the painted area, and is it a printable (watertight) single piece that hugs
// the model without intersecting it? Each case checks that directly:
//   - every undirected edge used exactly twice, opposite directions, volume > 0
//   - the inner face never ends up inside the model, and stays within the standoff
//   - probes over deep painted vertices are air (the window is open)
//   - probes over the unpainted ring around the window hit mask material
//   - the whole thing is one connected shell

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTopology,
  buildStencil,
  validateSolid,
  stencilDefaultsForDiagonal,
  geodesicField,
} from '../js/stencil.js';
import { buildBinarySTL } from '../js/io.js';
import {
  parseBinarySTL,
  TriGrid,
  fmt,
  nearestWelded,
  geodesicDisc,
  mergePainted,
  paintedThickness,
  InsideTester,
  solidPieces,
} from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.resolve(here, '../../Sprunki Mercuy.stl');
const raw = fs.readFileSync(modelPath);
const { positions, triCount } = parseBinarySTL(raw);
const vertexCount = positions.length / 3;

let failures = 0;
let checks = 0;
const lines = [];
const check = (name, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const info = (msg) => lines.push(`      ${msg}`);

console.log(`model: ${modelPath}`);
console.log(`triangles ${fmt(triCount, 0)}  vertices ${fmt(vertexCount, 0)}`);

const tTopo = Date.now();
const topo = buildTopology(positions, vertexCount);
console.log(
  `topology: ${fmt(topo.wCount, 0)} welded vertices, ${fmt(topo.faceCount, 0)} faces, ` +
    `${fmt(Date.now() - tTopo, 0)} ms (weld ${topo.timing.weldMs} ms)`,
);
console.log(
  `  diagonal ${fmt(topo.diagonal)}  mean edge ${fmt(topo.meanEdgeLength, 3)}  ` +
    `surface ${fmt(topo.surfaceArea)}  normals ${topo.orientation}  degenerate faces ${topo.degenerateFaces}`,
);
check('model welds first, not last', topo.wCount < vertexCount, `${fmt(vertexCount - topo.wCount, 0)} duplicate vertices merged`);
check('model normals point outward', topo.orientation === 'outward');

console.log('building the model surface grid for distance checks…');
const tGrid = Date.now();
const modelGrid = new TriGrid(positions, 2);
const modelInside = new InsideTester(modelGrid);
console.log(`  grid ready in ${fmt(Date.now() - tGrid, 0)} ms`);

// ---------------------------------------------------------------- feature picking

// Head: the model's bbox is x 60 wide, y 103 tall, y+ up. The face is the +z side of the
// upper part. These pick the two forward-most points in the eye band, one per side.
const centreX = (topo.bbox[0] + topo.bbox[3]) / 2;
const yBand = [topo.bbox[1] + (topo.bbox[4] - topo.bbox[1]) * 0.55, topo.bbox[1] + (topo.bbox[4] - topo.bbox[1]) * 0.8];
const forwards = (side) => {
  let best = null;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (y < yBand[0] || y > yBand[1]) continue;
    if (side > 0 ? x < centreX + 3 : x > centreX - 3) continue;
    if (!best || z > best[2]) best = [x, y, z];
  }
  return best;
};
const eyeL = forwards(-1);
const eyeR = forwards(1);
const defaults = stencilDefaultsForDiagonal(topo.diagonal);
console.log(`defaults: ${JSON.stringify(defaults)}\n`);

/** Non-indexed triangle list for a solid, for the distance-grid checks. */
function expand(positions, indices) {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i += 1) {
    const s = indices[i] * 3;
    out[i * 3] = positions[s];
    out[i * 3 + 1] = positions[s + 1];
    out[i * 3 + 2] = positions[s + 2];
  }
  return out;
}

function weldedPainted(painted) {
  // The harness paints in welded space (length wCount) in some cases and in the STL's
  // original soup space in others; buildStencil accepts both, so must this.
  if (painted.length === topo.wCount) return Uint8Array.from(painted);
  const w = new Uint8Array(topo.wCount);
  for (let i = 0; i < painted.length; i += 1) if (painted[i]) w[topo.weldOf[i]] = 1;
  return w;
}

// ---------------------------------------------------------------- case runner

const caseSummaries = [];

function runCase(name, { painted, params = {}, expect = {} }) {
  const t0 = Date.now();
  const res = buildStencil({ topology: topo, painted, params: { ...defaults, ...params } });
  const ms = Date.now() - t0;
  const p = { ...defaults, ...params };

  if (!res.ok) {
    if (expect.mustFail) {
      check(`${name}: refuses with a clear reason`, true, `${res.reason}: ${res.warnings[0]}`);
    } else {
      check(`${name}: builds a stencil`, false, `${res.reason} — ${res.warnings.join(' ')}`);
    }
    return res;
  }

  const s = res.stats;
  info(
    `cover ${fmt(s.coverRadius)}  window ${s.windowOpen ? 'open' : 'CLOSED'}  loops ${s.boundaryLoops} ` +
      `(${s.windowLoops} window)  pieces ${s.components}  pass(es) ${s.attempts}`,
  );
  info(
    `solid ${fmt(s.solidTriangles, 0)} tris / ${fmt(s.solidVertices, 0)} verts · surface ${fmt(s.surfaceTriangles, 0)} tris · ` +
      `walls ${fmt(s.wallTriangles, 0)} tris · volume ${fmt(s.volume, 1)} · bbox ${s.size.map((v) => fmt(v, 1)).join(' x ')}`,
  );
  info(
    `thickness ${fmt(s.thicknessMin, 3)} … ${fmt(s.thicknessMax, 3)} · standoff ${fmt(s.standoff, 3)} ` +
      `(min ${fmt(s.standoffMin, 3)}) · ` +
      `outer area ${fmt(s.outerArea, 1)} · field ${s.fieldMs} ms · total ${ms} ms`,
  );
  for (const w of res.warnings) info(`warning: ${w}`);

  caseSummaries.push({ name, ms, stats: s, warnings: res.warnings });

  // --- printable: closed, consistently oriented, one shell
  const v = validateSolid(res);
  check(
    `${name}: watertight and consistently oriented`,
    v.watertight === true,
    `nonManifoldEdges ${v.nonManifoldEdges}, sameDirectionEdges ${v.sameDirectionEdges}, degenerate ${v.degenerate}, edge histogram ${JSON.stringify(v.edgeHistogram)}`,
  );
  check(`${name}: outward-facing solid`, v.outward === true, `signed volume ${fmt(v.volume, 1)}`);
  // The measured gap is unsigned, so 0 means "touching at a clamped crease", not "inside":
  // the signed checks above are what prove the inner face never cuts into the model.
  const c = s.clearance;
  check(
    `${name}: measures the clearance under the mask`,
    c && c.min >= 0 && c.median >= p.standoff * 0.5 && c.measured > 0,
    c
      ? `min ${c.min.toFixed(3)} median ${c.median.toFixed(3)} p05 ${c.p05.toFixed(3)} ` +
        `for a ${p.standoff} standoff, ${c.tight} vertices under ${(p.standoff * 0.5).toFixed(2)}`
      : 'not measured',
  );
  check(
    `${name}: single part (one connected shell)`,
    v.components === (expect.components ?? 1),
    `components ${v.components}`,
  );

  if (!v.watertight && v.nonManifoldEdges > 0 && v.nonManifoldEdges <= 8) {
    const counts = new Map();
    for (let t = 0; t < res.indices.length; t += 3) {
      for (let e = 0; e < 3; e += 1) {
        const a = res.indices[t + e];
        const b = res.indices[t + ((e + 1) % 3)];
        if (a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    for (const [key, n] of counts) {
      if (n === 2) continue;
      const [a, b] = key.split('|').map(Number);
      info(
        `non-manifold edge x${n}: ${[a, b]
          .map((i) => `(${res.positions[i * 3].toFixed(2)}, ${res.positions[i * 3 + 1].toFixed(2)}, ${res.positions[i * 3 + 2].toFixed(2)})`)
          .join(' .. ')}`,
      );
    }
  }

  // --- the mask hugs the model without intersecting it
  const halfVerts = res.positions.length / 6;
  const step = Math.max(1, Math.floor(halfVerts / 400));
  let sinks = 0;
  let behindLocal = 0;
  let oddParity = 0;
  let worstGap = 0;
  let sampled = 0;
  // Two independent tests, both of which have to agree, because each has a blind spot:
  //  - the sign against the nearest triangle's own normal is unreliable in a crease (the
  //    closest triangle can be a neighbour whose normal points sideways);
  //  - the ray-parity test calls a vertex "inside" where the figure overlaps itself (an arm
  //    across the belly), even though it is 0.1 above the surface being masked.
  // A vertex both tests call buried is a real intersection. Each count is reported so a
  // regression in either one is still visible.
  for (let k = 0; k < halfVerts; k += step) {
    const x = res.positions[k * 6];
    const y = res.positions[k * 6 + 1];
    const z = res.positions[k * 6 + 2];
    const signed = modelGrid.signed(x, y, z, 2);
    sampled += 1;
    if (signed.dist > worstGap) worstGap = signed.dist;
    if (signed.dist <= 0.02) continue; // touching the model is allowed (clamped standoff)
    const behind = signed.sign < 0;
    const odd = modelInside.test(x, y, z);
    if (behind) behindLocal += 1;
    if (odd) oddParity += 1;
    if (behind && odd) sinks += 1;
  }
  check(
    `${name}: inner face never sinks into the model`,
    sinks === 0,
    `${sinks}/${sampled} sampled inner vertices are behind the surface they were offset from ` +
      `and inside the figure (worst gap ${fmt(worstGap, 3)}, standoff ${fmt(s.standoff, 2)}; ` +
      `local test alone ${behindLocal}, ray test alone ${oddParity})`,
  );
  check(
    `${name}: inner face stays within the standoff`,
    worstGap <= Math.max(s.standoff * 2, 0.3),
    `worst gap ${fmt(worstGap, 3)}`,
  );
  if (s.windowOpen) {
    check(
      `${name}: window lip is the thin edge`,
      s.thicknessMin <= p.edgeLip * 1.3 + 1e-6,
      `min thickness ${fmt(s.thicknessMin, 3)} vs edgeLip ${p.edgeLip}`,
    );
  } else {
    info(`window closed, so there is no thin lip: min thickness ${fmt(s.thicknessMin, 3)}`);
  }
  check(
    `${name}: rim is the grip thickness`,
    Math.abs(s.thicknessMax - p.rim) <= 0.15 && s.thicknessMax > s.thicknessMin,
    `max thickness ${fmt(s.thicknessMax, 3)} vs rim ${p.rim}`,
  );

  // --- the functional promise: air over the paint, material around it
  const paintedW = weldedPainted(painted);
  const ring = [];
  for (let w = 0; w < topo.wCount; w += 1) {
    if (paintedW[w]) continue;
    for (let k = topo.neighborStart[w]; k < topo.neighborStart[w + 1]; k += 1) {
      if (paintedW[topo.neighbors[k]]) {
        ring.push(w);
        break;
      }
    }
  }
  // Geodesic depth inside the painted set: "deep" means far enough in that the mask's
  // anti-bleed lip (which deliberately overlaps the paint edge) cannot reach the probe.
  const borderSeeds = [];
  for (let w = 0; w < topo.wCount; w += 1) {
    if (!paintedW[w]) continue;
    for (let k = topo.neighborStart[w]; k < topo.neighborStart[w + 1]; k += 1) {
      if (!paintedW[topo.neighbors[k]]) {
        borderSeeds.push(w);
        break;
      }
    }
  }
  const depthIn = geodesicField(topo, borderSeeds, { maxDist: 1e9, allow: paintedW });
  const deep = [];
  for (let w = 0; w < topo.wCount; w += 1) {
    if (paintedW[w] && depthIn[w] >= Math.max(1.35, 0 - p.overhang + 1.0)) deep.push(w);
  }
  for (let w = 0; w < topo.wCount; w += 1) {
    if (paintedW[w]) continue;
    for (let k = topo.neighborStart[w]; k < topo.neighborStart[w + 1]; k += 1) {
      if (paintedW[topo.neighbors[k]]) {
        ring.push(w);
        break;
      }
    }
  }

  if (expect.windowOpen !== false) {
    const solidGrid = new TriGrid(expand(res.positions, res.indices), 2);
    const probeH = 0.3;
    let blocked = 0;
    let sampledDeep = 0;
    const blockedDepths = [];
    const deepStep = Math.max(1, Math.floor(deep.length / 150));
    for (let i = 0; i < deep.length; i += deepStep) {
      const w = deep[i];
      const qx = topo.positions[w * 3] + topo.normals[w * 3] * probeH;
      const qy = topo.positions[w * 3 + 1] + topo.normals[w * 3 + 1] * probeH;
      const qz = topo.positions[w * 3 + 2] + topo.normals[w * 3 + 2] * probeH;
      const near = solidGrid.nearest(qx, qy, qz, 2);
      sampledDeep += 1;
      if (near.dist < 0.25) {
        blocked += 1;
        blockedDepths.push(depthIn[w]);
      }
    }
    if (blocked) {
      info(
        `blocked probes sit at depth ${fmt(Math.min(...blockedDepths), 2)} … ${fmt(Math.max(...blockedDepths), 2)} ` +
          `inside the paint (the lip deliberately overlaps the edge by ${fmt(s.windowOverhang, 2)})`,
      );
    }
    // A selection with nothing deeper than the lip has no deep vertex to probe: on a dot a couple
    // of faces across, the lip deliberately overhangs the whole window, so "air over every probe"
    // is not the promise there — the window opening is.
    check(
      `${name}: window is open over the paint (probes are air)`,
      blocked === 0 && (sampledDeep > 0 || deep.length === 0),
      deep.length === 0
        ? 'nothing in the paint is deeper than the lip, so there is no deep probe to take'
        : `${blocked}/${sampledDeep} probes above painted vertices hit material`,
    );

    const probeC = s.standoff + Math.abs(p.thicknessMax ?? p.wall) * 0.5;
    let uncovered = 0;
    let sampledRing = 0;
    const ringStep = Math.max(1, Math.floor(ring.length / 150));
    for (let i = 0; i < ring.length; i += ringStep) {
      const w = ring[i];
      const qx = topo.positions[w * 3] + topo.normals[w * 3] * probeC;
      const qy = topo.positions[w * 3 + 1] + topo.normals[w * 3 + 1] * probeC;
      const qz = topo.positions[w * 3 + 2] + topo.normals[w * 3 + 2] * probeC;
      const near = solidGrid.nearest(qx, qy, qz, 2);
      sampledRing += 1;
      if (near.dist > Math.max(p.wall * 1.5, 0.6)) uncovered += 1;
    }
    check(
      `${name}: mask material surrounds the window (probes hit the mask)`,
      sampledRing > 0 && uncovered === 0,
      `${uncovered}/${sampledRing} probes outside the paint found no mask material`,
    );
  }

  if (expect.windowOpen === false) {
    check(
      `${name}: reports the closed window`,
      res.warnings.some((w) => /window did not open/i.test(w)),
      res.warnings.join(' | ') || 'no warning',
    );
  }
  if (expect.minWindowLoops !== undefined) {
    check(
      `${name}: ${expect.minWindowLoops} separate window(s)`,
      s.windowLoops >= expect.minWindowLoops,
      `window loops ${s.windowLoops}`,
    );
  }
  if (expect.warning) {
    check(
      `${name}: warns about widening`,
      res.warnings.some((w) => w.includes(expect.warning)),
      res.warnings.join(' | ') || 'no warning',
    );
  }
  return res;
}

// ---------------------------------------------------------------- the cases

const eyeRadius = 2;
const eyeLS = nearestWelded(topo, eyeL[0], eyeL[1], eyeL[2]);
const eyeRS = nearestWelded(topo, eyeR[0], eyeR[1], eyeR[2]);
const gd = (seed, radius) => geodesicDisc(topo, geodesicField, seed, radius);
const describe = (name, mask) => {
  const t = paintedThickness(topo, mask.paintedW);
  console.log(
    `case: ${name} — ${fmt(mask.count, 0)} painted vertices, ${t.maxHop} hops deep ` +
      `(${fmt(t.reached, 0)}/${fmt(t.total, 0)} reachable from the boundary)`,
  );
  return t;
};

const leftEye = gd(eyeLS, eyeRadius);
const rightEye = gd(eyeRS, eyeRadius);
const bothEyes = mergePainted(leftEye.paintedW, rightEye.paintedW);
const eyeGap = Math.hypot(eyeL[0] - eyeR[0], eyeL[1] - eyeR[1], eyeL[2] - eyeR[2]);
console.log(`eye seeds: L(${eyeL.map((v) => fmt(v, 1)).join(', ')}) R(${eyeR.map((v) => fmt(v, 1)).join(', ')}) separation ${fmt(eyeGap)}\n`);

const capY = topo.bbox[1] + (topo.bbox[4] - topo.bbox[1]) * 0.72;
const cap = (() => {
  const paintedW = new Uint8Array(topo.wCount);
  let n = 0;
  for (let v = 0; v < topo.wCount; v += 1) {
    if (topo.positions[v * 3 + 1] > capY) {
      paintedW[v] = 1;
      n += 1;
    }
  }
  return { paintedW, count: n };
})();

const frontSlab = (() => {
  const zCut = topo.bbox[5] - 8;
  const paintedW = new Uint8Array(topo.wCount);
  let n = 0;
  for (let v = 0; v < topo.wCount; v += 1) {
    if (topo.positions[v * 3 + 2] > zCut) {
      paintedW[v] = 1;
      n += 1;
    }
  }
  return { paintedW, count: n };
})();

const footSeed = nearestWelded(topo, (topo.bbox[0] + topo.bbox[3]) / 2, topo.bbox[1], (topo.bbox[2] + topo.bbox[5]) / 2);
const footDisc = gd(footSeed, 3);
const headTopSeed = nearestWelded(topo, (topo.bbox[0] + topo.bbox[3]) / 2, topo.bbox[4], (topo.bbox[2] + topo.bbox[5]) / 2);
const headTopDisc = gd(headTopSeed, 3);
const headAndFoot = mergePainted(footDisc.paintedW, headTopDisc.paintedW);

describe('single eye', leftEye);
runCase('single eye', { painted: leftEye.paintedW, expect: { minWindowLoops: 1 } });

describe('both eyes', bothEyes);
const resBoth = runCase('both eyes', { painted: bothEyes.paintedW, expect: { minWindowLoops: 2 } });

describe('both eyes, narrow cover radius', bothEyes);
const resNarrow = runCase('both eyes, narrow cover', {
  painted: bothEyes.paintedW,
  params: { coverRadius: 2, maxCoverRadius: 40 },
  expect: { components: 2, minWindowLoops: 2 },
});
check(
  'both eyes, narrow cover: widened the search before giving up',
  resNarrow.ok && resNarrow.stats.attempts > 1 && resNarrow.stats.coverRadius > 2,
  resNarrow.ok ? `${resNarrow.stats.attempts} passes, cover ${fmt(resNarrow.stats.coverRadius)}` : 'did not build',
);
check(
  'both eyes, narrow cover: says so instead of shipping a split part',
  resNarrow.ok && resNarrow.warnings.some((w) => /separate pieces/.test(w)),
  resNarrow.ok ? resNarrow.warnings.filter((w) => /pieces/.test(w)).join(' | ') : 'did not build',
);

// two spots near each other: growth must bridge them into one part
const farField = geodesicField(topo, [eyeRS], { maxDist: 12 });
let seedB = -1;
for (let v = 0; v < topo.wCount; v += 1) {
  if (farField[v] >= 9 && farField[v] < 9.5) {
    seedB = v;
    break;
  }
}
const spotA = gd(eyeRS, 3);
const spotB = gd(seedB, 3);
const twoSpots = mergePainted(spotA.paintedW, spotB.paintedW);
describe('two spots 9 units apart', twoSpots);
const resBridge = runCase('two nearby spots', {
  painted: twoSpots.paintedW,
  params: { coverRadius: 1.5, maxCoverRadius: 20 },
  expect: { components: 1, minWindowLoops: 2 },
});
check(
  'two nearby spots: widened the cover radius to make one part',
  resBridge.ok && resBridge.stats.attempts > 1 && resBridge.warnings.some((w) => /widened/.test(w)),
  resBridge.ok ? `${resBridge.stats.attempts} passes, cover ${fmt(resBridge.stats.coverRadius)}` : 'did not build',
);

describe('both eyes, widening disabled', bothEyes);
runCase('both eyes, widening off', {
  painted: bothEyes.paintedW,
  params: { coverRadius: 2, growIfSplit: false },
  expect: { components: 2, warning: 'separate pieces' },
});

console.log('case: a dot smaller than the overhang');
const dot = gd(eyeRS, 0.6);
describe('dot smaller than overhang', dot);
// This case used to pin the app's worst behaviour: a dot with a 3.0 window inlay came back with
// `windowOpen: false`, a shell with no opening over the selected dot at all — so a handful of faces
// picked with Select faces silently never reached the stencil, while a Part panel or a box drag
// (thousands of faces, plenty deep for the inlay to bite into) worked. The guarantee now is that
// every selected island opens: an island with no room for the inlay is cut at its own edge, the
// build says so, and the shell is still a printable solid.
const resDot = runCase('dot smaller than overhang', {
  painted: dot.paintedW,
  params: { overhang: 3 },
  expect: { minWindowLoops: 1 },
});
check(
  'dot smaller than overhang: the window opens instead of coming back closed',
  resDot.ok === true && resDot.stats.windowOpen === true &&
    !resDot.warnings.some((w) => /window did not open/i.test(w)),
  resDot.ok ? `window ${resDot.stats.windowOpen ? 'open' : 'CLOSED'}, ${resDot.stats.windowLoops} loop(s)` : 'did not build',
);
check(
  'dot smaller than overhang: says the cut is at the island edge, and how far past it',
  resDot.ok === true &&
    resDot.stats.thinIslands === 1 &&
    resDot.stats.thinIslandRim > 0 &&
    resDot.stats.thinIslandRim <= topo.meanEdgeLength * 1.001 &&
    resDot.warnings.some((w) => /thinner than the 3 window inlay/.test(w)),
  resDot.ok ? `${resDot.stats.thinIslands} island(s), rim ${fmt(resDot.stats.thinIslandRim, 3)} vs edge ${fmt(topo.meanEdgeLength, 3)}` : 'did not build',
);
check(
  'dot smaller than overhang: the window is still where the dot is (the paint is not covered)',
  resDot.ok === true && resDot.stats.paintedVertices > 0,
  resDot.ok ? `${resDot.stats.paintedVertices} painted vertices under the window` : 'did not build',
);

describe(`head cap above y=${fmt(capY, 1)}`, cap);
runCase('head cap', { painted: cap.paintedW, params: { coverRadius: 12 }, expect: { minWindowLoops: 1 } });

describe('front slab (face plate)', frontSlab);
runCase('front slab', { painted: frontSlab.paintedW, params: { coverRadius: 10 }, expect: { minWindowLoops: 1 } });

describe('head and foot together (far apart)', headAndFoot);
// At this cover radius the clipped sheet also produces a tiny island enclosed by the window
// (16 triangles, joined to nothing). It is dropped rather than shipped as a loose sliver, so
// only the two intended pieces remain: the head mask and the foot mask.
const resHeadFoot = runCase('head and foot', {
  painted: headAndFoot.paintedW,
  params: { coverRadius: 8 },
  expect: { components: 2, warning: 'separate pieces' },
});
if (resHeadFoot.ok) {
  check(
    'head and foot: the loose island was dropped, not shipped',
    resHeadFoot.stats.droppedIslandTriangles > 0 &&
      resHeadFoot.warnings.some((w) => /small island/.test(w)),
    `${resHeadFoot.stats.droppedIslandTriangles} island triangles, ` +
      `${resHeadFoot.stats.pinchSplits} point-contact vertices split, ` +
      `${resHeadFoot.stats.danglingBoundaryVertices} dangling boundary vertices`,
  );
}

describe('both eyes, tighter standoff', bothEyes);
const tightStandoff = runCase('both eyes, standoff 0.1', {
  painted: bothEyes.paintedW,
  params: { standoff: 0.1 },
  expect: { minWindowLoops: 2 },
});
describe('both eyes, roomier standoff', bothEyes);
const wideStandoff = runCase('both eyes, standoff 0.3', {
  painted: bothEyes.paintedW,
  params: { standoff: 0.3 },
  expect: { minWindowLoops: 2 },
});
if (tightStandoff.ok && wideStandoff.ok) {
  const a = tightStandoff.stats.clearance;
  const b = wideStandoff.stats.clearance;
  check(
    'a roomier standoff lifts the clearance the bulk of the mask keeps',
    b.median > a.median * 2 && b.p05 > a.p05 * 1.8 && b.min >= a.min,
    `median ${a.median.toFixed(3)} -> ${b.median.toFixed(3)}, ` +
      `p05 ${a.p05.toFixed(3)} -> ${b.p05.toFixed(3)}, min ${a.min.toFixed(3)} -> ${b.min.toFixed(3)}`,
  );
  check(
    'the sharpest creases stay tight whatever the standoff is asked for',
    b.min >= 0 && b.min < 0.1 && b.tight > 0,
    `min clearance ${b.min.toFixed(4)} at a 0.3 standoff, ${b.tight} vertices pulled back to the surface`,
  );
}

console.log('case: nothing painted\n');
runCase('nothing painted', { painted: new Uint8Array(topo.wCount), expect: { mustFail: true } });

console.log('case: everything painted\n');
const everything = new Uint8Array(topo.wCount).fill(1);
runCase('everything painted', { painted: everything, expect: { mustFail: true } });
// ---------------------------------------------------------------- exported STL

console.log('checking the exported STL…\n');
if (resBoth.ok) {
  const stl = buildBinarySTL(resBoth.positions, resBoth.indices);
  const tri = resBoth.indices.length / 3;
  check('STL: byte size matches the triangle count', stl.bytes === 84 + tri * 50, `${stl.bytes} bytes for ${fmt(tri, 0)} triangles`);
  const rt = parseBinarySTL(Buffer.from(stl.buffer));
  check('STL: re-reads with the same triangle count', rt.triCount === tri, `${rt.triCount} vs ${tri}`);
  const topo2 = buildTopology(rt.positions, rt.positions.length / 3);
  const idx2 = new Int32Array(rt.triCount * 3);
  for (let t = 0; t < rt.triCount; t += 1) {
    idx2[t * 3] = topo2.weldOf[t * 3];
    idx2[t * 3 + 1] = topo2.weldOf[t * 3 + 1];
    idx2[t * 3 + 2] = topo2.weldOf[t * 3 + 2];
  }
  const v2 = validateSolid({ positions: topo2.positions, indices: idx2 });
  const srcVerts = resBoth.positions.length / 3;
  info(
    `STL round trip: ${fmt(srcVerts, 0)} solid vertices -> ${fmt(topo2.wCount, 0)} after re-welding ` +
      `(${fmt(srcVerts - topo2.wCount, 0)} merges), components ${v2.components}, volume ${fmt(v2.volume, 1)} ` +
      `(source ${fmt(validateSolid(resBoth).volume, 1)})`,
  );
  check(
    'STL: still watertight after a round trip through the file',
    v2.watertight === true && v2.components === 1,
    `components ${v2.components}, nonManifoldEdges ${v2.nonManifoldEdges}, volume ${fmt(v2.volume, 1)}`,
  );
} else {
  check('STL export', false, 'the two-eye stencil did not build');
}

// ---------------------------------------------------------------- report

console.log(lines.join('\n'));
console.log('\n--- case summary ---');
for (const c of caseSummaries) {
  console.log(
    `${c.name.padEnd(30)} ${String(c.ms + ' ms').padStart(8)}  solid ${String(fmt(c.stats.solidTriangles, 0)).padStart(9)} tris  ` +
      `pieces ${c.stats.components}  windowLoops ${c.stats.windowLoops}  cover ${fmt(c.stats.coverRadius, 1)}`,
  );
}
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`\nFAILURES:`);
  for (const l of lines) if (l.startsWith('FAIL')) console.log(l);
}
process.exit(failures ? 1 : 0);
