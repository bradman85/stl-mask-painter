# STL Mask Painter

Load a 3D model (STL), lay a paintable mask over it, and paint named features onto the
surface with a brush, a region flood fill, and an eyedropper. The mask can be painted in
solid colours, hidden per feature, undone/redone, and exported as JSON (re-importable) or
as a binary PLY of the painted shell.

What is painted becomes the **window of a printable paint stencil**: a one-piece shell that
conforms to the model, so you can hold it on the figure and only the painted area — an eye,
a mouth, a marking — is exposed to the brush. It exports as a binary STL.

The bundled example is [`Sprunki Mercuy.stl`](../Sprunki%20Mercuy.stl) — 422,658 triangles,
1,267,974 vertices — and it loads, orients and becomes paintable in about 0.3 s.

## Run it

ES modules and `fetch` mean the app has to be served over HTTP (opening `index.html` from
disk with `file://` will not work). The included server serves the **parent** directory so
the example model next to the app folder is reachable:

```bash
node serve.mjs                  # http://127.0.0.1:8137/mask-painter/index.html
node serve.mjs 9000             # pick another port
node serve.mjs 3000 0.0.0.0     # reachable from other machines / a hosted preview
```

The stencil generator has its own tests, which run on the bundled model and take a few
seconds:

```bash
npm ci        # three.js, needed by the mask layer the tests drive
npm test      # engine, app path, painting edits, parts, UI wiring, guide-vs-app
```

Alternatively use any static server rooted at the repository folder, or drop an `.stl`
onto the viewport — the app does not need the example model to be useful.

## The guide

Every panel heading in the app carries a small **?** that opens `help.html` at that panel's
section, and the top bar has a **Guide** button (`?` or `F1` also work). The page has one
section per panel — top bar, features, paint, mask, stencil, model & view, export/import —
each explaining what every control does, what it costs, and what it does *not* do, plus the
full detail of the three file formats: [mask JSON](#export--import), the import path, the
painted-shell PLY and the stencil STL. Code blocks have a **Copy** button, including a small
**valid, importable mask JSON** you can paste into a file and load back.

`VALIDATION.md` is the same material as a sign-off checklist: one item per feature, with the
steps to perform, the result to expect and the suite that backs it, plus what must *not* be
logged as a failure. `test/help.test.mjs` keeps it in step — every guide section has to be
covered by an item, every link in it must resolve, and the coverage counts cannot drift.

The guide is checked against the app by `test/help.test.mjs`: every panel's **?** must resolve
to a real section, every button, checkbox, slider and menu option in `index.html` must be
named in the guide, and the format constants it quotes must still be the ones in `js/io.js`.
The suite list is checked against `package.json` too — the guide has to name every suite
`npm test` runs, say how many there are, and no `*.test.mjs` may sit on disk unrun.
Add a control, a format field or a suite without documenting it and `npm test` fails, which is
what keeps this page and the guide in step with the app rather than describing an older one.

Three.js and three-mesh-bvh are vendored under `vendor/`, so no install is needed to run.
`npm install` only restores the packages used to refresh those vendored copies.

## Tools

| Tool | What it does | Shortcut |
| --- | --- | --- |
| Brush | Paints the selected feature into every vertex inside the brush radius | `B` |
| Region fill | Flood-fills the connected surface from the clicked point, stopping where the surface turns more than the angle limit | `F` |
| Erase | Paints "unpainted" back into the mask | `E` |
| Pick | Eyedropper with a live preview: the ring takes the colour of the feature under the cursor, and in the status bar; a click makes that feature current and hands back to the tool you were painting with (`Shift`-click to keep picking) | `I` |
| Part | Paints the whole panel of the model under the cursor, bounded by its seams. Every click also lists the panels near the cursor (size and distance), which is how a thin or hidden panel is selected when the click lands next to it | `P` |

- **Features** are a palette of named colours (Eyes, Pupils, Mouth, …). Add your own; each
  row shows how many vertices it owns, and can be hidden or cleared individually.
  `1`…`9` select the first nine features.
- **Invert mask** (Mask panel, `Shift`+`I`) swaps painted for unpainted in one undoable step —
  the answer to "I meant everything except that", since a click can only select what it lands on.
- **Brush radius** `[` / `]`, suitable default derived from the model's size.
- **Mirror across X** paints the mirrored point too (plane defaults to the model's centre).
- **Mask opacity**, **ghost shell** (dim unpainted area to see the mask in context),
  base-model visibility, wireframe, ground grid.
- **Up axis** — Y-up is right for character models, Z-up for CAD/printer meshes.
- **Views**: Front / Back / Left / Right / Top / Home.
- **Undo / redo** with `Ctrl+Z` / `Ctrl+Shift+Z`; a whole brush stroke, a fill, a clear and a
  palette removal are each one step (40 kept).
- **Taking back a bad stroke**, four ways: `Ctrl+Z` (the whole dragged stroke at once, not one
  brush stamp), the **Erase** tool (`E`) to wipe part of it and repaint, **Clear feature** to
  drop everything painted for the selected feature, **Clear all** for the mask. None of them
  touch the loaded model, and undo restores the previous vertex ids exactly. **Clear all**
  arms on the first click and wipes on the second (within four seconds) — no `window.confirm`,
  which some embedded browser views block silently. Buttons that have nothing to act on say
  so in the status bar instead of doing nothing.
- Right-drag orbits, middle-drag pans, wheel zooms. Hold `Space` (or use the **Navigate**
  button) to orbit with the left button while painting tools stay armed.

## Selecting a whole part instead of painting it by hand

A click selects the panel its ray lands on, and on the bundled model that is a real limit: the
opening panel is **43% of the mesh and most of the front view** while the face details are
**0.8–2.4% of the mesh** — strips a few pixels wide. Missing one by two pixels paints the panel
behind it and leaves the strip bare, which looks like the tool ran backward. It did not; it
painted the face it hit. Three things make that recoverable:

- after every Part click the panel lists the panels with surface within a brush radius of the
  click, nearest first, each with its size and distance (`js/parts.js` → `partsNearPoint`, a
  geometric query, so it also finds panels hidden behind the one you hit);
- the status bar names the smaller panel it thinks you were aiming at — *"the detail you aimed
  at is probably Part 9 (8,477 faces, 2.01% of the mesh, 0.1 away)"* — and the finer preset that
  would cut it out on its own, so the recovery is one click and does not require reading a list;
- **Invert mask** when the complement is what you actually wanted.


Painting an eye or a panel exactly by hand is fiddly. The **Part** tool does it in one click:
the model is cut into panels along its **seams** — an edge whose two faces meet at more than
the *seam angle*, i.e. a crease rather than a smooth curve — and clicking a panel paints all
of it with the current feature. That painted panel is what the stencil turns into a window.

- `P` picks the tool. **Click** replaces the feature's paint with that panel (like a lasso
  selection), **Shift-click** adds another panel to the same feature, **Alt-click** takes one
  away. One click is one undo step.
- **Seam angle** (8° by default) is the whole control. Lower cuts finer, higher merges
  panels together. The panel reports how many parts that angle produces, and the **preset row**
  beside it names the measured sweet spots — **Face details 5°**, **Portrait 8°** (the default),
  **Body parts 12°**, **Broad shapes 25°** — so the cut is one click rather than a slider drag
  and a guess.
- **Show seams** draws the seams as yellow lines, so it is obvious where a click will stop
  before you click.
- Hairline creases are everywhere in scanned or generated meshes, so panels smaller than
  0.02% of the mesh are merged into the neighbour they share the longest seam with. Without
  that the same angle produces thousands of one-triangle parts and clicking one paints a
  speck.

On the bundled figure (`Sprunki Mercuy.stl`, 422,658 faces) the default 8° gives 26 panels:

| Seam angle | panels | largest panel | notes |
| --- | --- | --- | --- |
| 5° (Face details) | 35 | 87k faces (21%) | eyes, eyebrows and mouth are panels of their own |
| **8° (default, Portrait)** | **26** | **181k (43%)** | both eyebrows and both eyes separate; head, torso, legs, arms, feet |
| 12° (Body parts) | 21 | 204k (48%) | the eyebrows merge into the 48% panel |
| 25° (Broad shapes) | 14 | 221k (52%) | limbs merge into the body |
| 35° | 12 | 226k (53%) | two big shells and slivers — too coarse to click |

The default is the coarsest cut at which the small facial panels stay clickable panels of their
own, and still coarse enough that a torso or a limb is one click. At 12° a click aimed at an
eyebrow selects the 48% panel behind it — the case that made the Part tool feel like it ran
backward.

Region fill uses the same seam angle, so "flood the surface until it hits a crease" and
"click the whole panel" now agree on what a crease is. Cutting the model into parts takes
about 0.4 s on the bundled figure and is cached per model and angle.

Two things worth knowing when the window is a whole panel:

- A panel is usually much bigger than a hand-painted window, so the shell around it is a
  *band*, not a ring that closes behind it. **Widen the reach until the mask is one piece**
  (on by default) grows the reach to force a single piece — for a panel-sized window that can
  spread the shell over most of the figure, and it costs several builds. Turn it off to keep a
  band around the window (one build, far less plastic). Either way, if the shell still comes
  out in more than one piece the panel says so.
- The window edge insets a couple of units inside the panel (the field is smoothed so the cut
  is not ragged), so a sliver of the panel's rim stays covered by mask material. Probe
  measurements on the bundled model: 1 of 595 face centres deep inside a clicked panel stayed
  covered, and 2525 of 2525 face centres 1–10 units of surface away had shell material on
  them.

## How the mask works

An STL has no UVs, so the mask is **per vertex** rather than a texture:

- `MaskLayer` keeps an `Int16Array` of feature ids and an RGBA `Float32Array` written
  straight into a vertex-colour attribute on an overlay mesh.
- The overlay is a clone of the model with `polygonOffset` pulling it in front, so it
  reads as a 3D shell hugging the surface rather than a flat decal.
- Unpainted vertices have alpha 0, so nothing shows through except the paint. Their RGB is
  kept at the model's neutral tone, which also means the overlay still looks right even if
  a renderer ignored vertex alpha.
- Painting is a query against a uniform vertex grid (`maxDimension / 64` cells), so a
  brush stamp only touches the vertices actually inside it; a 3.2-unit brush on the example
  model marks 2,817 vertices and every one is within the radius (measured max error 3.189).
- Region fill grows over vertex adjacency (neighbour distance taken from the mesh's own
  median edge length) with an optional surface-angle limit, capped by a vertex budget.
- Colour updates are uploaded with `BufferAttribute.addUpdateRange`, so a stroke re-uploads
  only the changed slice of the colour buffer instead of the whole 20 MB attribute.

Picking uses a three-mesh-bvh BVH built once per model (≈160 ms for 422k triangles), so a
brush sample is a sub-millisecond raycast even while dragging.

The **Pick** tool's vote (`MaskLayer.featureUnderPoint`) is the same call the hover preview and
the click use, so the ring cannot promise one feature and the click deliver another; it lives in
`js/mask.js` rather than the DOM layer so it is unit-tested with the rest of the painting code.

Modifier clicks (`Alt`/`Ctrl`) are only meaningful to the **Part** tool — a panel is removed with
`Alt`-click — so they are filtered by `modifierClickIgnored()` rather than dropped globally, which
is what had made documented panel removal a no-op.

## Paint stencil (printable)

Paint the area that must stay exposed, press **Build stencil**, and the painted region turns
into a window cut out of a one-piece shell. The shell is printed, held on the figure, and the
window is what gets painted.

The pipeline (all in `js/stencil.js`, dependency-free so the identical code runs in the
browser and under Node):

1. **Weld** the STL triangle soup into shared vertices, with adjacency and smooth vertex
   normals (422,658 faces → 211,331 welded vertices on the example model).
2. **Geodesic distance field** from the painted set — distance measured across the surface,
   so the mask never tunnels through air between an arm and the body.
3. **Smooth** it into a signed field, negative inside the paint, positive outside.
4. **Clip** the surface to the band `[-overhang, reach]`: the window edge and the outer rim
   land on smooth level curves instead of following the mesh's triangles.
5. **Offset and close**: the clipped sheet is pushed out along its normals to the standoff
   height, a second copy is placed a wall thickness above it, and side walls stitch the
   boundary loops — one watertight solid.

| Panel field | Meaning | Default on the example model |
| --- | --- | --- |
| Reach | where mask material starts, from the painted boundary | 15 units (scaled from the model's diagonal) |
| Wall | sheet thickness away from the window | 1.19 |
| Standoff | gap between model surface and the mask's inner face (the clearance the mask needs to slide on) | 0.2 |
| Window inlay | mask material overlapping the painted boundary, so paint cannot creep under the window edge | 0.35 |

Numbers are in model units, which are millimetres for a model exported at final size. The
window edge itself is deliberately thinner (`edgeLip`, ~0.4) than the rest of the sheet, so
a brush stroke hits a thin lip rather than a wall.

### Clearance: does it fit onto the model?

The standoff is the gap the mask leaves, but the gap it *achieves* is not the same number
everywhere, so every build measures the distance from each inner-face vertex to the nearest
surface triangle and reports it (median, minimum, and how many spots are tighter than half
the standoff). Measured on the example model with two eyes painted:

| Standoff asked for | median | 5th percentile | minimum | inner vertices under 0.05 |
| --- | --- | --- | --- | --- |
| 0.1 | 0.100 | 0.067 | 0.002 | 579 of 71,206 (0.8%) |
| **0.2 (default)** | **0.200** | **0.134** | **0.003** | **76 (0.1%)** |
| 0.3 | 0.300 | 0.194 | 0.005 | 37 (0.05%) |

(`node test/clearance.mjs 0.1 0.2 0.3`, two painted eyes, measured against the whole model.)

The bulk of the mask keeps exactly the standoff asked for. The tight spots are creases
sharper than the averaged vertex normal can follow: offsetting along it there would push the
inner face *into* the model, which is worse than touching, so the generator pulls the offset
back to the surface at those vertices instead (spread over one ring of neighbours). That is
why the minimum barely improves when the standoff is raised, and why a rigid mask will rub
at a handful of spots. Practical readings:

- 0.15–0.25 keeps a real gap over ~99% of the part on this figure and is a good starting
  point for FDM; resin printers hold a smaller gap but the same crease limits apply.
- The panel says how many vertices came out tight, so you can judge before printing.
- The fix for a stubborn crease is geometric, not numeric: keep the painted window away from
  it, reduce the reach so the shell stops before it, or sand/ream those few spots after
  printing. `node test/clearance.mjs [standoff …]` prints the full distribution for any
  standoff, measured against the whole model rather than the mask's own footprint.

**If the paint is in more than one place** the mask grows its reach automatically until the
pieces join into a single part (a few passes, reported in the panel); if they are simply too
far apart, it says so and leaves the pieces separate rather than pretending. A loose island
of shell surrounded by the window is dropped, and point contacts in the clipped sheet are
split so no edge is shared by four triangles — both are reported as notes.

Two honest limits:

- **Undercuts.** A single rigid shell has to slide on and off. The example figure has arms
  and a head wider than its neck, so a mask that reaches right around it cannot be placed;
  keep the reach local (around the face, say) or print in a flexible resin.
- **Undercuts are geometry, not a bug**: nothing here can make a rigid piece that wraps a
  wider-than-neck shape removable. The app tells you the piece comes out whole; deciding
  what is placeable is still a judgement about the model.

Checks on the example model (two painted eyes, panel defaults): 98,820 triangles, one piece,
2 windows, wall 0.39–2.60 mm, standoff 0.19, volume 2,111, 4.7 MB STL (= 84 + 50 × 98,820) —
rebuilt from the file it is still watertight, one piece, same volume. The 2 windows are real
through-holes: the shell's Euler characteristic is −2, and each painted disc is one of them. Mesh weld 419 ms and build 444 ms for
that model; the welded topology is cached and reused by later builds.

## Export / import

- **Mask JSON** — `format: "stl-mask"`, the palette and a flat `[vertexIndex, featureId, …]`
  list. Re-import merges features into the palette and warns if the vertex count differs.
- **Painted shell PLY** — binary little-endian PLY containing only triangles whose three
  vertices are painted, with `red/green/blue/alpha` properties, so it opens in MeshLab,
  Blender, CloudCompare and friends.
- **Stencil STL** — binary STL of the printable mask, from the painted area. Written
  straight from the built solid; a copy can be kept in the viewport as a preview
  (double-sided, semi-transparent, toggled by **Preview**). The preview is drawn *under* the
  paint layer, so painted areas stay in their exact colours while the shell reads clearly on
  everything else — you can keep painting and clearing with the preview on.
- **Screenshot** — PNG of the viewport.

## Files

```
mask-painter/
  index.html        UI shell + import map
  css/style.css     dark panel styling
  js/main.js        app controller: load, palette, tools, pointer painting, import/export
  js/viewer.js      scene, lights, orbit controls, BVH picking, brush cursor, views
  js/mask.js        MaskLayer: ids, colours, vertex grid, brush, fill, undo/redo
  js/features.js    default feature palette
  js/io.js          mask JSON + binary PLY + binary STL writers, import parsing
  js/stencil.js     printable-stencil engine: weld, geodesic field, clipping, solid, checks
  js/parts.js       seam-based part segmentation for one-click panel selection
  help.html         the guide: one section per panel + the file formats (linked from the app)
  VALIDATION.md     the same features as a sign-off checklist: steps, expected result, suite
  serve.mjs         tiny static server for the app + neighbouring models
  test/             Node tests: engine, app path, painting edits, parts, UI wiring, guide
  vendor/           three.module.js, OrbitControls, STLLoader, three-mesh-bvh
```

`window.maskPainter` exposes `{ state, viewer, mask, io, paintAt, loadFromURL, openGuide, … }`
for console poking and scripted checks.

## Verified behaviour

Checked against the bundled model through the app's own UI paths (synthetic pointer and
DOM events, pixel reads from the live WebGL canvas):

- load: 422,658 triangles in ~0.3 s, BVH 160 ms, 60 fps; a second, different model
  (7,224 vertices) loads and repaints with its own mask.
- brush accuracy: 2,817 vertices per stamp, max distance from the hit point 3.189 ≤ radius 3.2.
- mirroring: painted vertices split into original and mirrored clusters with zero outliers
  around the plane.
- region fill: 25° limit → 40,078 vertices confined to a 13.6-unit band; 180° → whole shell,
  truncated at the vertex budget.
- erase removes exactly one stamp's worth (2,817); undo restores it; redo re-applies it.
- masked alpha: tinting unpainted vertices red with alpha 0 changes no pixels; the same
  vertices with alpha 1 turn red — vertex alpha is genuinely honoured.
- rendering: 6.5% of viewport pixels classify as the Head colour, 2.7% Body, plus Eyes and
  Mouth dabs, matching the painted vertex counts.
- JSON round trip: export → import reproduces every vertex and feature id exactly
  (`test/app-path.test.mjs`, 6,814 painted vertices on the bundled model; the format scales
  with the paint, not the model — 82,127 painted vertices is a 0.79 MB file).
- painting edits: a dragged 9-stamp stroke paints 10,127 vertices as one history step; undo
  removes all of it and redo restores the same ids; the erase brush takes back part of it
  (10,127 → 4,633) and undo restores exactly those; Clear feature and Clear all are each one
  undoable step; hiding a feature does not count as an edit.
- seam parts: the crease rule is checked on a cube where the answer is known (90° creases
  cut it into its 6 flat faces, 120° leaves one part); on the bundled model every face lands
  in exactly one part, sizes match, parts come out biggest-first, the default 8° gives 26
  panels with 10 of them at 5,000+ faces, and merging the slivers is what removes the tail
  (7,550 raw parts -> 26);
- clicking a part paints exactly the part's vertices as one undo step (undo restores, redo
  reapplies), shift-click composes two panels into one window, a plain click replaces the
  selection, and building a stencil from a clicked panel opens a window over that panel
  (1/595 deep face centres still covered) with shell material across the band around it
  (2525/2525) and none on the far side of the figure (14186/14186 bare);
- what Hide all paint / Clear feature / Clear all actually change on screen: painted vertices
  carry alpha 1 in the overlay's colour buffer (so they cover whatever is beneath them),
  hidden and cleared ones carry alpha 0 (and cleared ones return to the neutral unpainted
  RGB); `flush()` asks the renderer for the whole colour buffer after Clear all and only a
  slice after one brush stamp.
- PLY: byte size matches the declared vertex/face counts, no malformed faces, indices in range.
- failure paths: a missing model reports `HTTP 404` in the status bar and leaves the
  current model intact.
- the panel list: on a cube where the distances are known (0.62 to the four faces beside a point,
  1.03 to the one opposite, so a 0.7 radius returns the four and a 0.35 radius returns none), and
  on the real model that the thin panel a click missed is on the list within a brush radius and
  that picking it paints exactly that panel while leaving the 43% panel alone;
- invert: both directions exactly mirrored (1,259,403 painted / 8,571 released on one stroke),
  two undos, `Shift`+I, and the redo path for the snapshot-based edits — Clear all, Clear feature
  and Invert — which is where redo used to restore the *old* image instead of reapplying the
  change (a snapshot only records the state from before the edit);
- the eyedropper: the vote the hover preview shows is the vote the click makes, it finds the
  feature the brush just painted (3,307 vertices in range), reports nothing off the model or
  away from the paint, prefers the feature painted on top, falls back to the paint underneath
  when the top patch is erased, and agrees with `Clear all`; a modifier click is proven not to
  be swallowed before the Part tool sees it;
- the guide: every panel heading's link resolves, every control in `index.html` is named in
  `help.html`, the four format sections exist, the embedded sample parses as valid JSON with
  the fields the importer reads, the quoted format constants match `js/io.js`, and the guide's
  suite list matches the suites `npm test` actually runs (175 checks).

Checked for the stencil (`npm test`: the generator suite's 131 checks on the bundled model, plus
the app path and the wiring):

- every undirected edge is used by exactly two triangles and the winding is outward on all
  ten cases (single eye, both eyes, a dot smaller than the window inlay, a head cap, a front
  slab, two features at opposite ends, nothing painted, everything painted, …);
- the window really is open: probes above painted vertices hit air, probes in the ring
  between window and rim hit mask material (0/139 and 2901/2910 on the app path);
- the inner face never sinks into the model: no sample is both behind the nearest surface
  and inside the figure, and the offset stays inside the standoff everywhere else;
- thickness stays in the band between the window lip and the rim, and the part is one
  connected shell whenever the paint can be bridged;
- the exported STL is byte-size consistent, re-reads to the same triangle count, and welds
  back into the same watertight, same-volume solid;
- the clearance reported in the panel matches an independent measurement of every inner
  vertex against the whole model (median and minimum agree to 0.001), stays non-negative,
  and scales with the standoff while the sharpest creases stay tight.

## Limitations

- The mask is per vertex, so brush resolution is limited by the model's tessellation; a
  coarse mesh gives blocky edges.
- Exported masks are only meaningful for the model they were painted on (imports warn on a
  vertex-count mismatch; there is no UV/space independent mapping).
- Painting intentionally blocks left-drag orbit — switch on **Navigate** (or hold `Space`).
- Region fill can bleed across a thin gap if the surface angle limit is high; lower the
  angle limit for tight areas.
