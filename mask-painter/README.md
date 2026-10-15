# STL Mask Painter

Load a 3D model (STL), lay a paintable mask over it, and paint named features onto the
surface with a brush, a region flood fill, and an eyedropper. The mask can be painted in
solid colours, hidden per feature, undone/redone, and exported as JSON (re-importable) or
as a binary PLY of the painted shell.

What is painted becomes the **window of a printable paint stencil**: a one-piece shell that
conforms to the model, so you can hold it on the figure and only the painted area — an eye,
a mouth, a marking — is exposed to the brush. It exports as a binary STL.

**The app opens empty.** It loads no model on start: the first model in a session is the one you
chose, and the bundled example is one click away behind **Load example model** —
[`Sprunki Mercuy.stl`](../Sprunki%20Mercuy.stl), 422,658 triangles, 1,267,974 vertices, which
loads, orients and becomes paintable in about 0.3 s.

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
npm test      # engine, app path, painting edits, parts, cleanup, UI wiring, guide-vs-app
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
| Box select | Drag a rectangle over the viewport: every vertex whose screen position falls inside it, and which faces the camera, is painted — or released with `Alt`/`Ctrl` held. One drag, one undo step | `X` |
| Select models | Picks the whole model (the separate shell) under the cursor, tinted yellow, then **Remove picked** takes it out of the model. Paints nothing | `S` |
| Select faces | The same tool with the pick set to one triangle at a time — the face under the cursor is tinted white, the pick yellow | `Shift`+`S` |

- **Features** are a palette of named colours (Eyes, Pupils, Mouth, …). Add your own; each
  row shows how many vertices it owns, and can be hidden or cleared individually.
  `1`…`9` select the first nine features.
- **Invert mask** (Mask panel, `Shift`+`I`) swaps painted for unpainted in one undoable step —
  the answer to "I meant everything except that", since a click can only select what it lands on.
- **Brush radius** `[` / `]`, suitable default derived from the model's size.
- **Mirror across X** paints the mirrored point too (plane defaults to the model's centre).
- **Mask opacity**, **ghost shell** (dim unpainted area to see the mask in context),
  base-model visibility, wireframe, ground grid. The grid is the print bed: it is drawn on the
  model's own lowest point, under its own footprint, in both centring modes — so an STL authored
  hundreds of units from the origin is never left hanging beside the grid.
- **Up axis** — Y-up is right for character models, Z-up for CAD/printer meshes.
- **Views**: Front / Back / Left / Right / Top / Home.

**Box select** (`X`) is the rubber band. Hold the left button and drag a rectangle: every vertex
whose *screen position* falls inside it is painted with the current feature, as one undo step, no
matter how many panels or painted windows the selection crosses. The rectangle is a screen-space
selection — the mesh's own coordinates go through the model, view and projection matrices, are
divided by the clip-space `w` and compared with the box — so it takes exactly what you can see
under it, from any camera angle. Three details are worth knowing:

- **It takes only what faces you.** A rectangle over the face of a closed figure also covers the
  back of the head, whose vertices project into the same pixels; those are culled with the vertex
  normal against the camera, and the status bar reports how many were left alone. The Brush,
  Region fill and Part tools work in model space and have no facing rule at all.
- **Mirroring applies.** With **Mirror across X** on, the box is taken again on the other side of
  the plane (a vertex is selected when its own pixel is in the rectangle or when its mirror
  image's pixel is), which is the reflection of the rectangle rather than of the brush sphere.
- **`Alt`/`Ctrl` releases** paint under the rectangle instead, and `Esc` throws a drag away. A
  drag may start on the background — it does not need the model under the cursor — and a
  rectangle that takes nothing says so instead of looking like a dead tool.

Measured on the bundled figure (`test/boxselect.test.mjs`): a box over the middle of the body
(the middle 30% of the viewport) selects **433,903** of the **930,758** vertices under it in
**29 ms** — 496,855 are facing away and are left alone — and what it selects is compared vertex
for vertex against three.js' own projection over twelve rectangles, dragged every way.
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

## Cleaning up an STL that holds more than one model

An STL is not a scene. Exporters routinely write several models into one file — a figure plus the
base it was cut from, a duplicate left beside it, a blob from a boolean that did not finish — and
nothing in the format says they are separate objects. Two things go wrong because of it: the extra
geometry gets painted and built into the mask, and the part you want can end up **hanging in the
air**, because the bed is drawn under the lowest point of *everything* in the file, stray model
included.

**Select models** (`S`) and **Select faces** (`Shift`+`S`) are the way in — one tool, two scopes,
both of them buttons in the tool row rather than a menu to find. They pick geometry and take it out
of the model:

- **Whole models.** `js/select.js` cuts the file on shared faces — the same rule a slicer uses
  when it reports *2 objects*, so two models that merely touch at a corner stay separate and a
  model standing inside another is a model of its own. The panel lists them biggest first with the
  faces, the share of the file and the size of each, and a click in the list or in the viewport
  picks one (a second click unpicks it; `Shift` picks outright, `Alt`/`Ctrl` unpicks).
- **Single faces.** The pick is one triangle at a time instead, for geometry that is not a separate
  model — a spur, a chunk welded to the figure, a ring of triangles that came out wrong.
- **What is picked is drawn as a filled tint** (yellow for the pick, white for the face under the
  cursor), with the boundary of the picked faces outlined on top. The tint is what makes a single
  picked face visible: edges alone z-fight with the triangle they trace and show nothing at all.
  `js/highlight.js` owns that drawing and takes the group to draw into as an argument, which is
  what lets the whole path — draw, replace, clear — run under Node in `test/select.test.mjs`
  instead of only in a browser. That matters here: the first version of this code kept its colours
  in a destructured third argument and was also called to *clear* the highlight, with two. It threw
  `Cannot destructure property 'color' of 'undefined'` on the first load of every session, and
  because the load path has no `try`/`catch` around it, the loading overlay stayed on **Preparing
  mask layer…** and no model ever appeared. Clearing is now a function of its own, the drawing
  options all have defaults, and both halves are executed by the suite rather than pattern-matched.
- **`Ctrl`+`A` / Select all**, then click off the few you want to keep, is the fast way through a
  file of many; **Select none** (`Esc`) and **Invert pick** cover the other directions.
- **Remove picked** is a two-click confirmation (the label changes for four seconds, like Clear
  all) and cannot leave the model empty. **Restore removed** puts every removed face back.

A removal is stored as *"the file, minus these faces"*, not as an edit to the geometry, which is
what makes it reversible. It rebuilds the mesh with a **corner map**, so the paint stays exactly
where it was painted and the mask's undo history is renumbered rather than thrown away — `Ctrl+Z`
still reaches the paint it used to. The geometry then goes back through the loader's own path, so
the bounding box, the camera, the panels and the bed are all measured again: remove a model that
was standing under the figure and the figure **drops onto the plate**. The stencil, the seams and
the welded topology describe the old geometry, so they are discarded instead of being left saying
something about a model that is no longer there.

Nothing here rewrites your STL on disk: a removed model is out of the session (not painted, not
welded into a stencil, not in the painted shell PLY) until you restore it.

## Selecting a whole part instead of painting it by hand

A click selects the panel its ray lands on — the triangle under the cursor, resolved back to the
mesh's own face order (`viewer.sourceTriangleIndex`), which is the order the mask, the welded
topology and the panels are all built in. That translation is not optional: three-mesh-bvh
installs an index buffer of its own on a mesh that has none and groups the triangles in BVH
order, so its `faceIndex` names an unrelated triangle — a panel from elsewhere in the model, at
every seam angle — while still being in range, so nothing else complains.

On the bundled model, selecting the panel you hit is still a real limit: the opening panel is
**43% of the mesh and most of the front view** while the face details are **0.8–2.4% of the
mesh** — strips a few pixels wide. Missing one by two pixels paints the panel behind it and
leaves the strip bare, which looks like the tool ran backward. It did not; it painted the face it
hit. Three things make that recoverable:

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

## Where the model sits

An STL keeps whatever coordinates its exporter used, and the grid in the viewport is drawn
around the origin — so a mesh authored inside a CAD assembly arrives hundreds of units away
and hangs in space beside the grid, with nothing on screen to bring it back. **Centre model on
the grid** (Model & view, on by default) moves a loaded model so its footprint centre sits on
the grid's centre lines and its lowest point sits on the grid's plane; the status bar reports
the distance it moved. Unticking it puts the model back exactly where the file puts it.

It is a transform on the model *group*, like the up axis, and not a rewrite of the geometry:
the mask is per vertex, the panels are per face and every export is written in the file's own
coordinates, so none of those may move under it. `viewer.centreTranslation(box)` is the whole
of the arithmetic — the offset that centres a box — and `js/viewer.js` applies it to
`modelGroup.position` and to nothing else, which is what `test/ui-wiring.test.mjs` pins and
`test/cleanup.test.mjs` checks on real boxes. The bundled figure reads as an offset of
−10.5, 42.1, −26.4.

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
brush sample is a sub-millisecond raycast even while dragging. Because that BVH re-indexes a
non-indexed mesh in its own order, `pick()` translates the hit triangle back to the loaded
mesh's face order (`sourceTriangleIndex`) — the order every other part of the app uses: the
mask, the welded topology, the exported mask JSON and the panel segmentation.

The **Pick** tool's vote (`MaskLayer.featureUnderPoint`) is the same call the hover preview and
the click use, so the ring cannot promise one feature and the click deliver another; it lives in
`js/mask.js` rather than the DOM layer so it is unit-tested with the rest of the painting code.

Modifier clicks (`Alt`/`Ctrl`) are only meaningful to the **Part** tool — a panel is removed with
`Alt`-click — so they are filtered by `modifierClickIgnored()` rather than dropped globally, which
is what had made documented panel removal a no-op.

## Paint stencil (printable)

Paint the area that must stay exposed, press **Build stencil**, and the painted region turns
into a window cut out of a one-piece shell. The shell is printed, held on the figure, and the
window is what gets painted. **Discard stencil** throws a built shell away (preview, result and
the export it enabled) so a new one can be built without reloading the model; it leaves the
mask alone, and **Clear all** in the Mask panel leaves the shell alone — the panel says when the
paint no longer matches the build.

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

### Sitting the exported part on the bed

A slicer reads **Z = 0 as the plate**, and an STL keeps the coordinates its exporter used — so a
shell built on a figure whose origin is somewhere else lands in the slicer floating, and the part
has to be dragged down before it will print. The viewport never shows this: **Centre model on the
grid** moves the *view*, not the mesh, so what looks like it is standing on the grid is not where
the file says it is. Measured on the example model, a mask built around the face has its lowest
vertex at **Z 41.0** in model coordinates — 41 mm of air under it in a slicer, which is what
"the Z is not zeroed out" looks like.

**Sit the exported part on the bed (Z = 0)** (on by default) fixes it in the file, where it has
to be fixed: `io.setOnBed(positions, indices)` returns a copy of the solid with **every piece** of
it resting on Z 0 (`io.lowestZ` reports the solid's own lowest Z — positive when the part was
floating, negative when it was sunk into the plate — and the result also carries how many pieces
were placed and how far the furthest one had to travel). Only Z moves, and only in the copy that
is written: X and Y stay where the model has them (the slicer's own arrange puts the part on the
plate), and the mask, the panels, the built shell and the preview keep the model's coordinates, so
nothing on screen or in any other export changes. A part already on Z 0 is handed back without
being copied. Untick the box to get the model's own coordinates back, which is what you want when
the mask has to line up against the figure in a slicer — or when mask and model are printed in one
job. The status line always says which of the three happened.

| What the status line says | Meaning |
| --- | --- |
| `sat on the bed: moved down 41.00 mm so the part's lowest Z is 0 (X and Y untouched)` | the box was ticked and the one-piece part was floating |
| `sat each of its 2 pieces on the bed: the furthest moved 32.10 mm so every piece's lowest Z is 0 (X and Y untouched)` | ticked, and the stencil came out in more than one piece |
| `its lowest point was already on Z 0, so nothing moved` | ticked, and the model was authored on its own Z 0 |
| `left in the model's own coordinates (lowest Z 41.00)` | unticked |

### A stencil that comes out in more than one piece

Placing the whole solid by its single lowest point is not enough, and that is the second half of
the "it still hovers" report. A slicer imports the shells of one STL as **parts of a single
object**, and parts keep the coordinates they were written with: only **Split to objects** drops
each one onto the plate. So a stencil that the result panel reports as two pieces — a window on
the head and one at the feet, with a short reach and the widening off, comes out as 2 pieces
**32 mm apart** — went on hovering over the upper piece's air while the option appeared to do
nothing, because dropping the assembly put the lower piece on the plate (measured: the two pieces
built at Z −2.37 and 32.10; the whole-solid drop writes them at Z 0 and **32.10**, which is the
hover the user then removed by hand with *Split to objects*).

`setOnBed` therefore places **each piece by its own lowest Z**. The pieces are the shells of the
indexed solid — triangles that share a vertex, the same rule the result panel counts pieces with —
and a triangle soup, which shares nothing, is deliberately left as one piece rather than being
taken apart triangle by triangle. The measured file after the fix: both pieces at Z 0 (0…18.26 and
0…13.90), same X and Y as built, same two watertight pieces.

### Trimming the specks that would become extra windows

Every separate painted region becomes its own **window** in the shell, and regions that do not
touch become separate pieces — so the stray dabs a brush always leaves turn into a part with
extra windows, several loose shells and nothing to hold them together on the print bed. There
are two ways to be rid of one, both in the Mask panel: **Trim windows**, which releases every
window smaller than a threshold, and **List windows**, which names each one and lets you remove
the one you mean.

A window is a connected painted region of the **welded** surface, found by walking the vertex
adjacency the welder already built (`js/cleanup.js`, dependency-free like the stencil engine).
Welded because an STL repeats every vertex once per triangle: two triangles that share an edge
share no vertex index at all, and only the weld makes them neighbours. The threshold is a share
of the model's diagonal (2% by default, 0–100) compared with each window's **bounding box**,
because a speck is a size on the print, not a vertex count — the same speck is 40 vertices on a
coarse mesh and 4,000 on a dense one.

The trim is one undo step, like every other mask edit, and it always keeps the largest window,
so a threshold set too high can shrink a mask to its main region but never wipe it out (the
status bar says when it was spared). On the bundled figure a chest blob with two stray dabs is
three islands at 27.2, 2.0 and 1.9 units across; the default threshold releases the two dabs —
429 vertices, exactly the vertices inside them and nothing else — in one ~60 ms pass.

**A threshold can only say "smaller than this", and only about whole windows.** It skips the
largest and it cannot split anything, so a mask that is *one* connected region has nothing it
can ever release, whatever it is set to: two panels that touch (a Shift-click on the panel next
to the selected one — 552,231 vertices at 90.8 units across on the bundled figure, measured in
`test/cleanup.test.mjs`), a stroke back and forth, a region fill. That is what **List windows**
is for. It lists every painted window with its vertex count, its size in units and as a share of
the model, and the features it is painted with, each row carrying:

- **Remove** — releases that window, the largest included; the row's `fileVertices` (the mask's
  own indices, joined to the window through the weld) are exactly what the edit releases.
- **Keep only** — releases every other window, which is how you keep one panel out of several.

Both are one undo step, and the list rebuilds itself from what is left, so the numbers on screen
are the numbers in the mask. The list is hidden the moment the mask changes — every row names
the vertices behind it — so it never describes a mask that no longer exists. When a threshold
can do nothing the status bar says so in those words and names the two things that can, instead
of reporting zero and looking like a dead button.

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
far apart, it says so and leaves the pieces separate rather than pretending — each piece is then
placed on the plate on export, so a multi-piece stencil still prints (see *Sitting the exported
part on the bed*). A loose island
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

- **Save mask (JSON)** — the session file: `format: "stl-mask"`, the palette, a flat
  `[vertexIndex, featureId, …]` list of the windows you marked up, and the build settings from
  the stencil panel (`stencil: { coverRadius, wall, standoff, overhang, growIfSplit }`).
  **Open mask (JSON)…** merges the features into the palette, warns if the vertex count differs,
  and puts those settings back, so loading the same model later and reopening the file lets you
  keep adding windows and build the same part. Files without the `stencil` block still load.
- **Painted shell PLY** — binary little-endian PLY containing only triangles whose three
  vertices are painted, with `red/green/blue/alpha` properties, so it opens in MeshLab,
  Blender, CloudCompare and friends.
- **Stencil STL** — binary STL of the printable mask, rebuilt from the mask as it stands on
  screen: if the paint has changed since the last build, the export builds again first (and says
  so), so the file always holds every window rather than last round's. The lowest point of the
  written file is Z 0 unless **Sit the exported part on the bed** is unticked, so it lands on the
  slicer's plate instead of floating at the model's own Z. A copy of the build can be
  kept in the viewport as a preview (double-sided, semi-transparent, toggled by **Preview**, or
  removed with **Discard stencil**). The preview is drawn *under* the
  paint layer, so painted areas stay in their exact colours while the shell reads clearly on
  everything else — you can keep painting and clearing with the preview on.
- **Screenshot** — PNG of the viewport.

### Why the stencil export rebuilds

A build is a snapshot of the paint, so `stencil.result` can be older than the mask on screen. A
straight copy of it is a valid STL with last round's windows, which is how "I Shift-clicked three
more panels, saved again, and the file only has the first ones" happens: the bytes are round one's,
the timestamp is today's. The export now asks `stencilOutOfDate()` (the app's own comparison: the
painted vertex count against `stencil.paintedCount`) and rebuilds through the same
`rebuildStencil()` path **Build stencil** uses before writing anything, refusing to write at all if
that build is rejected. The status line names the windows and pieces that went into the file.
`test/app-path.test.mjs` pins both halves on the real model — the second round really is another
window in a rebuild (2 → 3 windows at 4.9 MB → 10.6 MB), and the build in hand really does describe
the smaller mask — and `test/ui-wiring.test.mjs` pins the export path in the source.

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
  js/cleanup.js     painted-window analysis: the list to remove from, and what a trim would release
  help.html         the guide: one section per panel + the file formats (linked from the app)
  VALIDATION.md     the same features as a sign-off checklist: steps, expected result, suite
  serve.mjs         tiny static server for the app + neighbouring models
  test/             Node tests: engine, app path, painting edits, parts, cleanup, wiring, guide
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
Measured by `test/cleanup.test.mjs` on the same model:

- islands: a blob plus two dabs come back as three islands (27.2, 2.0 and 1.9 units across); a
  2% threshold releases exactly the 429 vertices inside the dabs, keeps the blob bit for bit, and
  the whole plan takes ~60 ms on the welded mesh.
- windows: the list names every painted window with the file vertices behind it; two panels that
  touch come back as **one** window (552,231 vertices, 90.8 units) that no threshold releases at
  2%, 50% or 99%, and Remove releases exactly it — one undo puts all of it back; the largest
  window (a 32,578-vertex blob) can be removed while the dab beside it stays, which the trim's
  largest-island rule forbids, and Keep only does the reverse.
- centring: the grid offset on the bundled figure is −10.5, 42.1, −26.4 units; applying it centres
  the box and puts its lowest point on the grid, it leaves the model's own coordinates untouched,
  and it is a no-op for a model that is already centred.
- the bed: the built shell around the example face has its lowest vertex at **Z 41.0** in model
  coordinates (it would float 41 mm in a slicer); the exported file with the option on measures
  **lowest Z = 0 exactly** and spans Z 0…12.27, re-reads as the same watertight solid (98,820
  triangles, volume 2,110.9 both ways, 1 piece), and its min X is unchanged — Z only; with the box
  unticked the file's lowest Z is the build's own 41.002 again. The transform itself is checked as
  arithmetic: floating, sunk (−3 → 0) and already-on-the-plate solids, and that the array it is given
  is never edited (the preview and the panel share it).
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
- the click path: a real BVH raycast through a real camera, sampled across the whole viewport,
  reports the triangle it actually hit in the loaded mesh's face order every time (1,560/1,560
  hits), and the detail panels a user can see (eyes, brows, mouth, feet) are panels those rays
  select — while the BVH's own raw index fails that same test on all 1,560, which is the bug
  that made the Part tool paint a panel from elsewhere in the model;
- the guide: every panel heading's link resolves, every control in `index.html` is named in
  `help.html`, the four format sections exist, the embedded sample parses as valid JSON with
  the fields the importer reads, the quoted format constants match `js/io.js`, and the guide's
  suite list matches the suites `npm test` actually runs (215 checks);
- the box select: what the selector takes is compared with three.js' own `project()` vertex for
  vertex over twelve rectangles — whole screen, half, a band, one vertex, dragged backwards, one
  pixel wide, off the model — and the composed projection × view × model matrix against three.js'
  own multiplication; on the real figure every sampled vertex three.js puts inside the box was
  taken, every taken vertex projects inside it, a vertex behind the camera is dropped rather than
  projected onto a pixel that is not its own, a mirrored box takes the reflected surface but not
  the reflected vertices that face away, and the selection reaches the mask as the painted
  vertices in one undo step (undo and redo restoring the exact count).

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
