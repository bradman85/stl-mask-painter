# STL Mask Painter

Load a 3D model (STL), select the sub-parts of it you want to paint — a panel bounded by its
seams with one click, or any triangles you point at — and build a **printable paint stencil** from
that selection: a one-piece shell that conforms to the model, so you hold it on the figure and only
the selected area (an eye, a mouth, a marking) is exposed to the brush. The stencil exports as a
binary STL, and the selection saves as JSON you can open again later.

There is **one selection** and no painting: no brush, no palette, no colours to set. Every tool
writes the same set of triangles, so a panel taken with **Part** and a few triangles picked with
**Select faces** build one stencil together.

**The app opens empty.** It loads no model on start: the first model in a session is the one you
chose, and the bundled example is one click away behind **Load example model** —
[`Sprunki Mercuy.stl`](../Sprunki%20Mercuy.stl), 422,658 triangles, 1,267,974 vertices, which
loads and orients in about 0.3 s.

## Run it

**Already running:** [bradman85.github.io/stl-mask-painter](https://bradman85.github.io/stl-mask-painter/)
— this repository served by GitHub Pages, on any device, updated by every push to `main`. Nothing
to install; that is the whole deployment. To run a copy of your own, the two sections below are a
Codespace and a local server.

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
npm test      # engine, app path, selection, parts, cleanup, box select, UI wiring, guide-vs-app
```

Alternatively use any static server rooted at the repository folder, or drop an `.stl`
onto the viewport — the app does not need the example model to be useful.

## The guide

Every panel heading in the app carries a small **?** that opens `help.html` at that panel's
section, and the top bar has a **Guide** button (`?` or `F1` also work). The page has one
section per panel — top bar, selection, seam panels, windows, tint & view, stencil, model & view,
export/import — each explaining what every control does, what it costs, and what it does *not* do,
plus the full detail of the three file formats: the [selection JSON](#export--import), the import
path, the selected-shell PLY and the stencil STL. Code blocks have a **Copy** button, including a
small **valid, importable selection JSON** you can paste into a file and load back.

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

Three tools select; none of them paints. They all write the one selection, so switching between
them never clears what the others selected, and <kbd>B</kbd> builds the stencil from whatever is in
it.

| Tool | What it does | Shortcut |
| --- | --- | --- |
| Part | Selects the whole panel of the model under the cursor, bounded by its seams — a head, a torso, a limb. Every click also lists the panels near the cursor (size and distance), which is how a thin or hidden panel is reached when the click lands next to it. Nothing is drawn under the cursor in this tool: it takes a panel, not a triangle, and the status bar and the list say which one | `P` |
| Select models | The pick is the whole model (the separate shell) under the cursor, so **Remove selected** can take a stray one out of the file. A drag picks every model its rectangle covers | `S` |
| Select faces | The pick is one triangle at a time, or a rectangle's worth of them. The selected triangles are tinted amber and the one under the cursor is outlined white, so a click is judged before it happens | `Shift`+`S` |

- **Part** adds the panel to the selection. `Shift`-click adds another panel, `Alt`-click takes one
  off. Both are one undo step each, and neither clears what was already selected — which is what
  makes *take the head with Part, then take the eyes back off it a few triangles at a time* the
  actual workflow rather than three separate selections.
- **Select faces** clicks one triangle: click again to unselect it, `Shift`-click to add, `Alt`-click
  to take one off. A drag is a rectangle: a plain drag makes the selection exactly what the box
  covers, `Shift` adds, `Alt` takes off, and `Esc` throws the drag away. The rectangle is evaluated
  in screen space — the mesh's coordinates go through the model, view and projection matrices, are
  divided by the clip-space `w` and compared with the box — so it takes exactly what you can see
  under it, from any camera angle, and only what faces you (see the measured numbers below).
- **Seam angle** (3–60°, default 8°) decides how finely the model is cut into panels, and the four
  presets are the measured sweet spots: **Face details** 5° (eyes, brows and mouth become panels of
  their own), **Portrait** 8° (the default), **Body parts** 12° (head, torso, limbs, feet),
  **Broad shapes** 25° (limbs merged into the body). **Show seams** draws the boundaries.
- **Select all** (`Ctrl+A`), **Select none** (`Esc`) and **Invert selection** (`Shift+I`) — the
  answer to "I meant everything except that", since a click can only select what it lands on.
- **List windows** names every separate group of selected faces, with **Remove** and **Keep only** on
  each row, and **Drop small windows** unselects everything below a size threshold in one step. Each
  group of selected faces becomes one opening in the built stencil, so this is where the specks that
  would become loose pieces are taken out.
- **Remove selected** takes the selected faces — or whole models — out of the model, and **Restore
  removed** puts them back. The selection and its undo history are carried through the cut.
- **Undo / redo** with `Ctrl+Z` / `Ctrl+Shift+Z`: a click, a rectangle, a panel, a window removal and
  an invert are one step each (40 kept). A gesture that selects what was already selected is not a
  step at all.
- **Selection tint**, **ghost shell** (dim everything not selected to see the window in context),
  base-model visibility, wireframe, ground grid. The grid is the print bed: it is drawn on the
  model's own lowest point, under its own footprint, in both centring modes — so an STL authored
  hundreds of units from the origin is never left hanging beside the grid.
- **Up axis** — Y-up is right for character models, Z-up for CAD/printer meshes.
- **Views**: Front / Back / Left / Right / Top / Home.
- Right-drag orbits, middle-drag pans, wheel zooms. Hold `Space` (or use the **Navigate** button) to
  orbit with the left button while the selection tools stay armed.

The rectangle is a screen-space selection, and three details are worth knowing:

- **It takes only what faces you.** A rectangle over the face of a closed figure also covers the
  back of the head, whose triangles project into the same pixels; those are culled with the
  triangle's own normal against the camera, and the status bar reports how many were left alone.
  **Part** works in model space and has no facing rule at all.
- **Alt/Ctrl takes off** the triangles under the rectangle instead of adding them, and `Esc` throws a
  drag away. A drag may start on the background — it does not need the model under the cursor — and a
  rectangle that takes nothing says so instead of looking like a dead tool.
- **`Ctrl+A` then `Alt`-drag** is the fastest way to hand-pick a window out of a whole model.

Measured on the bundled figure (`test/boxselect.test.mjs`): a rectangle over the middle of the body
(the middle 30% of the viewport, 930,758 triangles under it) takes **433,903** of them in **29 ms**,
leaving the 496,855 that face away alone, and what it takes is compared triangle for triangle against
three.js' own projection over twelve rectangles, dragged every way at the real camera.

## Cleaning up an STL that holds more than one model

An STL is not a scene. Exporters routinely write several models into one file — a figure plus the
base it was cut from, a duplicate left beside it, a blob from a boolean that did not finish — and
nothing in the format says they are separate objects. Two things go wrong because of it: the extra
geometry gets selected and built into the window, and the part you want can end up **hanging in the
air**, because the bed is drawn under the lowest point of *everything* in the file, stray model
included.

**Select models** (`S`) and **Select faces** (`Shift`+`S`) are the way in — one tool, two scopes,
both of them buttons in the tool row rather than a menu to find. They select geometry and take it
out of the model:

- **Whole models.** `js/select.js` cuts the file on shared faces — the same rule a slicer uses
  when it reports *2 objects*, so two models that merely touch at a corner stay separate and a
  model standing inside another is a model of its own. The panel lists them biggest first with the
  faces, the share of the file and the size of each, and a click in the list or in the viewport
  picks one (a second click unpicks it; `Shift` picks outright, `Alt`/`Ctrl` unpicks).
- **Single faces.** The pick is one triangle at a time instead, for geometry that is not a separate
  model — a spur, a chunk welded to the figure, a ring of triangles that came out wrong.
- **A rectangle is a selection, not a sixth button.** Hold the left button in either scope and drag:
  the rectangle is drawn as you drag, and on release everything inside it is picked — the triangles
  themselves in the faces scope, the model of every triangle it covers in the models scope. `Shift`
  drags an addition, `Alt` a removal, a plain drag makes the pick exactly what the box covers, and
  `Esc` throws a drag away. A press that does not move is still the click it always was. The rule
  for a triangle is its **centre** and its own normal, so a box over the face of a closed figure
  takes the front and reports how many triangles it left facing away — `facesInScreenRect()` in
  `js/boxselect.js`, checked against three.js' own `project()` for the centre pixel.
- **What is selected is drawn as a filled tint** (amber for the selection, and — while **Select
  faces** is in hand — white for the face under the cursor), with the boundary of the selected faces
  outlined on top. The cursor's own tint is the *face* tool's because a face is what it is judging;
  **Part** leaves the cursor unpainted and reports the panel it would take in words instead. The tint is what makes a
  single selected face visible: edges alone z-fight with the triangle they trace and show nothing at
  all. It stays lit whatever tool is in hand, because the selection is shared by every tool and is
  what **Build stencil** and **Remove selected** act on — hiding it merely because the tool changed
  made a selection that was still there look like it had been thrown away.
  `js/highlight.js` owns that drawing and takes the group to draw into as an argument, which is
  what lets the whole path — draw, replace, clear — run under Node in `test/select.test.mjs`
  instead of only in a browser. That matters here: the first version of this code kept its colours
  in a destructured third argument and was also called to *clear* the highlight, with two. It threw
  `Cannot destructure property 'color' of 'undefined'` on the first load of every session, and
  because the load path has no `try`/`catch` around it, the loading overlay stayed on **Preparing
  mask layer…** and no model ever appeared. Clearing is now a function of its own, the drawing
  options all have defaults, and both halves are executed by the suite rather than pattern-matched.
- **`Ctrl`+`A` / Select all**, then click off the few you want to keep, is the fast way through a
  file of many; **Select none** (`Esc`) and **Invert selection** cover the other directions.
- There is nothing to press between selecting and stencilling: the stencil is built from the
  selection, so a selected region is one **Build stencil** away from being printable. Press
  **Build stencil** with nothing selected and the status bar says exactly that, rather than the
  button appearing to do nothing.
- **Remove selected** is a two-click confirmation and cannot leave the model empty.
  **Restore removed** puts every removed face back.

A removal is stored as *"the file, minus these faces"*, not as an edit to the geometry, which is
what makes it reversible. It rebuilds the mesh with a **corner map**, so the selection stays on
exactly the triangles it was made on and the undo history is renumbered rather than thrown away —
`Ctrl+Z` still reaches the same faces. The geometry then goes back through the loader's own path, so
the bounding box, the camera, the panels and the bed are all measured again: remove a model that
was standing under the figure and the figure **drops onto the plate**. The stencil, the seams and
the welded topology describe the old geometry, so they are discarded instead of being left saying
something about a model that is no longer there.

Nothing here rewrites your STL on disk: a removed model is out of the session (not selected, not
welded into a stencil, not in the selected-shell PLY) until you restore it.

## Selecting a whole panel in one click

A click selects the panel its ray lands on — the triangle under the cursor, resolved back to the
mesh's own face order (`viewer.sourceTriangleIndex`), which is the order the mask, the welded
topology and the panels are all built in. That translation is not optional: three-mesh-bvh
installs an index buffer of its own on a mesh that has none and groups the triangles in BVH
order, so its `faceIndex` names an unrelated triangle — a panel from elsewhere in the model, at
every seam angle — while still being in range, so nothing else complains.

On the bundled model, selecting the panel you hit is still a real limit: the opening panel is
**43% of the mesh and most of the front view** while the face details are **0.8–2.4% of the
mesh** — strips a few pixels wide. Missing one by two pixels selects the panel behind it and
leaves the strip bare, which looks like the tool ran backward. It did not; it selected the face it
hit. Three things make that recoverable:

- after every Part click the panel lists the panels with surface within a click's reach of the
  click, nearest first, each with its size and distance (`js/parts.js` → `partsNearPoint`, a
  geometric query, so it also finds panels hidden behind the one you hit);
- the status bar names the smaller panel it thinks you were aiming at — *"the detail you aimed
  at is probably Part 9 (8,477 faces, 2.01% of the mesh, 0.1 away)"* — and the finer preset that
  would cut it out on its own, so the recovery is one click and does not require reading a list;
- **Invert selection** when the complement is what you actually wanted.


Pointing at an eye or a panel exactly by hand is fiddly. The **Part** tool does it in one click:
the model is cut into panels along its **seams** — an edge whose two faces meet at more than
the *seam angle*, i.e. a crease rather than a smooth curve — and clicking a panel selects all of
it. That panel is what the stencil turns into a window.

- `P` picks the tool. **Click** replaces the selection with that panel (like a lasso
  selection), **Shift-click** adds another panel to it, **Alt-click** takes one
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
  that the same angle produces thousands of one-triangle parts and clicking one selects a
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

Cutting the model into panels takes about 0.4 s on the bundled figure and is cached per model and
seam angle, so moving the slider and clicking around stays responsive.

Two things worth knowing when the window is a whole panel:

- A panel is usually much bigger than a hand-picked window, so the shell around it is a
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

## How the selection is drawn

An STL has no UVs, so the selection is drawn **per vertex** rather than as a texture:

- `SelectionTint` (in `js/mask.js`) keeps a corner flag array derived from the selected faces and
  an RGBA `Float32Array` written straight into a vertex-colour attribute on an overlay mesh. The
  flags are derived, never edited directly: `setSelection()` is the only thing that writes them, so
  the tint cannot drift away from the face selection the stencil is built from.
- The overlay is a clone of the model with `polygonOffset` pulling it in front, so it
  reads as a 3D shell hugging the surface rather than a flat decal.
- Unselected corners have alpha 0, so nothing shows through except the selection. Their RGB is
  kept at the model's neutral tone, which also means the overlay still looks right even if
  a renderer ignored vertex alpha.
- The face under the cursor is drawn as its own highlight by `js/highlight.js`, which takes the
  group to draw into as an argument — that is what lets the whole path (draw, replace, clear) run
  under Node in `test/select.test.mjs` rather than only in a browser. It is drawn by the **Select**
  tool only: `onPointerMove` calls `updateHoverFace` in that tool and `clearHoverFace` in Part, and
  `setTool` clears it on the way into Part so a face outlined for one tool cannot outlive it.
- Colour updates are uploaded with `BufferAttribute.addUpdateRange`, so a selection that changes a
  few faces re-uploads only the changed slice of the colour buffer instead of the whole 20 MB
  attribute. Above 150,000 selected faces the tint is switched off and the panel says so; the
  selection itself is untouched and the build still uses all of it.

Picking uses a three-mesh-bvh BVH built once per model (≈160 ms for 422k triangles), so the hover
outline and a click are a sub-millisecond raycast even while dragging a rectangle. Because that BVH
re-indexes a non-indexed mesh in its own order, `pick()` translates the hit triangle back to the
loaded mesh's face order (`sourceTriangleIndex`) — the order every other part of the app uses: the
selection, the welded topology, the saved selection JSON and the panel segmentation.

Modifier clicks (`Shift`/`Alt`) mean the same thing to both selection tools — add, and take off —
so a panel selected with **Part** is what **Select faces** refines, and the other way round.

## Stencil (printable)

Select the area that must stay exposed, press **Build stencil**, and the selected region turns
into a window cut out of a one-piece shell. The shell is printed, held on the figure, and the
window is what gets painted. **Discard stencil** throws a built shell away (preview, result and
the export it enabled) so a new one can be built without reloading the model; it leaves the
selection alone, and **Select none** leaves the shell alone — the panel says when the selection no
longer matches the build.

The pipeline (all in `js/stencil.js`, dependency-free so the identical code runs in the
browser and under Node):

1. **Weld** the STL triangle soup into shared vertices, with adjacency and smooth vertex
   normals (422,658 faces → 211,331 welded vertices on the example model).
2. **Geodesic distance field** from the selected set — distance measured across the surface,
   so the mask never tunnels through air between an arm and the body.
3. **Smooth** it into a signed field, negative inside the selection, positive outside, then make
   sure every selected island dips past the cut: an island with no room inside it for the window
   inlay is cut at its own edge instead of being dropped, which is what makes a single picked face a
   window rather than nothing at all.
4. **Clip** the surface to the band `[-overhang, reach]`: the window edge and the outer rim
   land on smooth level curves instead of following the mesh's triangles.
5. **Offset and close**: the clipped sheet is pushed out along its normals to the standoff
   height, a second copy is placed a wall thickness above it, and side walls stitch the
   boundary loops — one watertight solid.

| Panel field | Meaning | Default on the example model |
| --- | --- | --- |
| Reach | where mask material starts, from the selected boundary | 15 units (scaled from the model's diagonal) |
| Wall | sheet thickness away from the window | 1.19 |
| Standoff | gap between model surface and the mask's inner face (the clearance the mask needs to slide on) | 0.2 |
| Window inlay | mask material overlapping the selected boundary, so paint cannot creep under the window edge | 0.35 |

Numbers are in model units, which are millimetres for a model exported at final size. The
window edge itself is deliberately thinner (`edgeLip`, ~0.4) than the rest of the sheet, so
a brush stroke meets a thin lip rather than a wall.

### Looking at the shell: the three viewport toggles

Once a shell is built, three layers are stacked over the model and each can hide the next one: the
shell itself, the model underneath it, and the amber tint of the selected faces. Three chips in the
top-right corner of the viewport switch them and report them — a chip reads **on** while its layer
is showing and **off** while it is hidden — and two of them are the panel's own checkboxes under
shorter names (**Stencil** is **Preview**, **Model** is **Show base model**, **Selection** is
**Show the selection tint**). Either control moves the other, because both go through `setViewLayer()`
in `js/main.js`; nothing writes a layer's `visible` behind its back, and `updateViewState()` redraws
the chips from the layers rather than from the click, so a chip cannot report a state the viewport is
not in. The **Stencil** chip is disabled until a build has succeeded — there is no shell to show
before that.

The pair exists for the build-and-rebuild loop: select, build, keep selecting, build again. With the
tint hidden you look *through* the shell's windows at the model's own shading instead of a flat
amber fill; with the model hidden you inspect the printable part on its own; and with the shell
hidden you are back to plain selecting with the selection still tinted.

One coupling rule is enforced, and only one: **the shell going off puts the model back on.** A shell
with the model hidden under it is the inspection view; a hidden shell with a hidden model is an empty
viewport, which reads as a broken app rather than a hidden layer. So **Stencil** off — and
**Discard stencil**, and loading another model — turns the model back on. The face tint is never
forced: whether it is on or off is the reader's choice, and the next press of the shell chip leaves
it exactly as it was.

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

Every separate selected region becomes its own **window** in the shell, and regions that do not
touch become separate pieces — so the stray triangles a hand-picked selection leaves turn into a part with
extra windows, several loose shells and nothing to hold them together on the print bed. There
are two ways to be rid of one, both in the Windows panel: **Drop small windows**, which releases
every window smaller than the threshold above it, and **List windows**, which names each one and
lets you remove the one you mean.

A window is a connected selected region of the **welded** surface, found by walking the vertex
adjacency the welder already built (`js/cleanup.js`, dependency-free like the stencil engine).
Welded because an STL repeats every vertex once per triangle: two triangles that share an edge
share no vertex index at all, and only the weld makes them neighbours. The threshold is a share
of the model's diagonal (2% by default, 0–100) compared with each window's **bounding box**,
because a speck is a size on the print, not a vertex count — the same speck is 40 vertices on a
coarse mesh and 4,000 on a dense one.

The trim is one undo step, like every other edit to the selection, and it always keeps the largest
window, so a threshold set too high can shrink the selection to its main region but never wipe it
out (the status bar says when it was spared). On the bundled figure a panel selected on the chest
with one stray speck of triangles near it is two islands, **28.02** and **2.66** units across; the
default threshold releases the speck — 87 faces, 261 corners, exactly the corners inside it and
nothing else — in one undo step, all measured in `test/cleanup.test.mjs`.

**A threshold can only say "smaller than this", and only about whole windows.** It skips the
largest and it cannot split anything, so a selection that is *one* connected region has nothing it
can ever release, whatever it is set to: two panels that touch (a Shift-click on the panel next
to the selected one — 552,231 corners at 90.8 units across on the bundled figure, measured in
`test/cleanup.test.mjs`), two eyes picked separately that meet in the middle, a rectangle dragged
into the neighbour it already had. That is what **List windows**
is for. It lists every window with its vertex count, its size in units and as a share of
the model, each row carrying:

- **Remove** — releases that window, the largest included; the row's `fileVertices` (the
  selection's own indices, joined to the window through the weld) are exactly what the edit
  releases.
- **Keep only** — releases every other window, which is how you keep one panel out of several.

Both are one undo step, and the list rebuilds itself from what is left, so the numbers on screen
are the numbers in the selection. The list is hidden the moment the selection changes — every row
names the corners behind it — so it never describes a selection that no longer exists. When a threshold
can do nothing the status bar says so in those words and names the two things that can, instead
of reporting zero and looking like a dead button.

### Clearance: does it fit onto the model?

The standoff is the gap the mask leaves, but the gap it *achieves* is not the same number
everywhere, so every build measures the distance from each inner-face vertex to the nearest
surface triangle and reports it (median, minimum, and how many spots are tighter than half
the standoff). Measured on the example model with both eyes selected:

| Standoff asked for | median | 5th percentile | minimum | inner vertices under 0.05 |
| --- | --- | --- | --- | --- |
| 0.1 | 0.100 | 0.067 | 0.002 | 579 of 71,206 (0.8%) |
| **0.2 (default)** | **0.200** | **0.134** | **0.003** | **76 (0.1%)** |
| 0.3 | 0.300 | 0.194 | 0.005 | 37 (0.05%) |

(`node test/clearance.mjs 0.1 0.2 0.3`, both eyes selected, measured against the whole model.)

The bulk of the mask keeps exactly the standoff asked for. The tight spots are creases
sharper than the averaged vertex normal can follow: offsetting along it there would push the
inner face *into* the model, which is worse than touching, so the generator pulls the offset
back to the surface at those vertices instead (spread over one ring of neighbours). That is
why the minimum barely improves when the standoff is raised, and why a rigid mask will rub
at a handful of spots. Practical readings:

- 0.15–0.25 keeps a real gap over ~99% of the part on this figure and is a good starting
  point for FDM; resin printers hold a smaller gap but the same crease limits apply.
- The panel says how many vertices came out tight, so you can judge before printing.
- The fix for a stubborn crease is geometric, not numeric: keep the selected window away from
  it, reduce the reach so the shell stops before it, or sand/ream those few spots after
  printing. `node test/clearance.mjs [standoff …]` prints the full distribution for any
  standoff, measured against the whole model rather than the mask's own footprint.

**If the selection is in more than one place** the mask grows its reach automatically until the
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

Checks on the example model (both eyes selected, panel defaults): 98,820 triangles, one piece,
2 windows, wall 0.39–2.60 mm, standoff 0.19, volume 2,111, 4.7 MB STL (= 84 + 50 × 98,820) —
rebuilt from the file it is still watertight, one piece, same volume. The 2 windows are real
through-holes: the shell's Euler characteristic is −2, and each selected disc is one of them. Mesh weld 419 ms and build 444 ms for
that model; the welded topology is cached and reused by later builds.

## Export / import

- **Save selection (JSON)** — the session file: `format: "stl-mask"`, the model's vertex count, a
  one-entry feature table (id 1, the selection colour), the build settings that were in the stencil
  panel, and a flat list of `[corner, id]` pairs — one per corner inside the window. **Open
  selection (JSON)…** reads it back, warns if the vertex count differs, and turns the corners into
  *faces*: a triangle counts when any of its corners was in the file, which keeps a saved window
  whole rather than opening a rim-wide gap in it. A file written by the earlier painting version of
  the app still opens: its several ids all come back as the one selection. Import is one undo step.
- **Selected shell PLY** — binary little-endian PLY containing only triangles whose three
  vertices are selected, with `red/green/blue/alpha` properties, so it opens in MeshLab,
  Blender or CloudCompare. It is a zero-thickness copy of the surface, for looking at the window
  beside the model — not a printable part.
- **Export stencil STL** — the built shell as a binary STL, named `<model>-paint-stencil.stl`, with
  the optional **Sit the exported part on the bed** placing every piece on Z 0 (see above).

### Why the stencil export rebuilds

A build is a snapshot of the selection, so `stencil.result` can be older than the selection on
screen. Pressing **Export stencil STL** compares the current selection's corner count against
`stencil.paintedCount` and, if they differ, builds again through the same
`buildStencilPart()` path before writing anything — the status bar says it did. This is the fix for
"my second save only has the first windows": the old code wrote the build it had in hand, so two
more Shift-clicked panels landed in a file with today's timestamp and last round's windows.

## Files

```
mask-painter/
  index.html        the app: panels, tool row, viewport
  help.html         the guide (one section per panel, plus the three file formats)
  VALIDATION.md     the same material as a sign-off checklist
  serve.mjs         static server (serves the parent directory, so the example model is reachable)
  css/style.css
  js/main.js        app controller: load, tools, pointer handling, import/export, stencil panel
  js/viewer.js      scene, lights, orbit controls, BVH picking, ground grid, views
  js/selection.js   THE selection: the face set, add/remove/invert, corner mapping, undo history
  js/mask.js        SelectionTint: the corner flags and the vertex-colour overlay
  js/highlight.js   the face under the cursor, drawn as its own group
  js/parts.js       seam segmentation and the panel-near-a-point query
  js/stencil.js     the generator: weld, fields, clip, walls, validation (no dependencies)
  js/cleanup.js     window analysis: the list to remove from, and what a trim would release
  js/select.js      shells of a file, filters, face counts, the highlight arrays
  js/boxselect.js   the screen-space rectangle: matrices, rect maths, facesInScreenRect
  js/io.js          mask JSON, PLY, binary STL, on-bed placement
  test/             Node tests: engine, app path, selection, parts, cleanup, box select, wiring, guide
  vendor/           three.js and three-mesh-bvh
```

`window.maskPainter` exposes `{ state, viewer, mask, io, cleanup, history, selectAt, loadFromURL,
openGuide, … }` for poking at a session from the console.

## Verified behaviour

Both halves of "does it work" are in the repository: `npm test` for everything a machine can check
(nine suites, all of them on the real 422,658-triangle model or on meshes with known answers), and
`VALIDATION.md` for the interactive half — one item per feature with the steps and the expected
result. What follows is a sample of the numbers behind the claims above; each line names the suite
that produces it.

- **The selection is the one thing every tool writes.** A Part panel and a rectangle and a single
  click all end in the same face array, so a build sees all of them. `test/selection.test.mjs` adds,
  removes, replaces, inverts, undoes and redoes that array, and checks the tint holds the corners of
  the selected faces and nothing else.
- **A picked face is a window.** A one-face selection builds a shell with `windowLoops: 1`, one
  piece, watertight and outward, with the hole over the face that was picked — proved by a ray
  through the shell rather than by trusting a count — and a Part panel with one face picked on
  another part of the model carries two windows, one per place. `test/app-path.test.mjs`;
  `test/stencil.test.mjs` pins the same for a dot smaller than the window inlay, which used to come
  back with `windowOpen: false` and no window at all.
- **The rectangle is screen space and culls what faces away.** A box over the middle of the body
  (930,758 triangles under it) takes **433,903** of them in **29 ms**, leaving the 496,855 that face
  away, compared triangle for triangle with three.js' own projection over twelve rectangles.
  `test/boxselect.test.mjs`.
- **Panels are a geometric query.** At the default 8° the bundled figure is 26 panels: the largest
  is 181k faces (43%), the smallest 0.05%. A click reports the panel it hit and lists the panels near
  the click; a click that missed a facial strip by two pixels can be recovered in one click.
  `test/parts.test.mjs`, which also drives a real raycast through a real camera over the whole
  viewport and checks every hit against the model's own face order.
- **The shell is printable.** Every case in `test/stencil.test.mjs` (single eye, both eyes, a narrow
  cover radius, a dot smaller than the inlay, a head cap, a front slab, two far-apart areas, nothing
  selected, everything selected, and a standoff sweep) is checked for: every edge used exactly twice
  with consistent winding, outward volume, the window genuinely open, mask material in the ring
  around it, the inner face never both behind the surface and inside the figure, thickness inside the
  expected band, and one connected shell or an honest warning — plus the exported STL re-read and
  re-checked, same volume, still watertight.
- **The window edge stays inside the selection.** With the default 0.35 inlay the cut lands inside
  the selected boundary, and the build reports the window loops and the rim thickness it achieved.
  Where that is impossible — an island thinner than the inlay — the build cuts at the island's own
  edge, reaches at most one triangle's width past the selection, and says so.
- **Exports are the selection on screen.** The stencil export rebuilds when the selection has moved
  on; the session file round-trips every corner; the PLY holds exactly the selected shell.
  `test/app-path.test.mjs`.
- **Nothing leaves the page.** Parsing, segmentation, selecting and the build all run in the tab;
  there is no server-side step and no telemetry.

The guide and this document are checked against the app by `test/help.test.mjs`: every control in
`index.html` has to be named in the guide, every panel's **?** link has to resolve, the formats the
guide quotes have to match `js/io.js`, the suite list has to match `package.json`, and every guide
section has to be covered by a validation item.

## Limitations

- **The interactive half needs a person.** Drops, hovers, drags, keyboard shortcuts and the feel of a
  click are covered by `VALIDATION.md`, not by `npm test`.
- **One model at a time.** A load replaces the session's geometry and its selection; the file on disk
  is never rewritten.
- **The mask is a band, not a body.** The shell covers the reach around the window (about 11.5% of
  the model's diagonal by default). Raise the reach for more plastic, or turn on widening for a
  one-piece part at the cost of several builds.
- **Selecting has a floor set by the mesh.** The window edge can be no finer than the model's
  triangles; the smoothing in the build hides some of that, not all.
- **Small selections are still windows, but they are small.** A window thinner than the 0.35 window
  inlay is cut at the selection's own edge, which exposes up to one triangle's width of bare model
  and prints as a pinprick opening — perfect for a marking, not a way to make a large hole out of
  three triangles. Select a real area for an opening you can paint through comfortably.
- **Clearance at creases is zero, by design.** The offset is pulled back to the surface where the
  surface bends too tightly for the standoff to fit. That is a geometric limit, not a setting.
- **Huge selections are not tinted.** Above 150,000 selected faces the overlay is switched off for
  speed and the panel says so; the selection and the build are unaffected.
- **Builds take seconds on a big model.** The weld (~0.4 s) is cached per model, the build is
  0.7–1.5 s per attempt, and widening multiplies the attempts.
