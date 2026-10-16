# STL Mask Painter — validation document

Every feature the app exposes, with the steps to test it and what a correct result looks like.
It is derived from the on-screen guide (`help.html`), which explains what each control is *for*;
this document is about proving it works.

- **Running the checks:** `npm test` proves the geometry, the selection model, the segmentation,
  the stencil and the wiring without a browser. The items below are the interactive half — the
  things only a person in front of a viewport can confirm.
- **Record as you go.** Each item ends with a verdict line: tick **pass** or **fail** and write
  what you saw. A fail without a note cannot be reproduced.
- **Coverage matrix** maps each guide section to the items that test it.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| **PASS** | Matches the expected result exactly. |
| **FAIL** | Does not match. Note the model, the numbers in the status bar, the first console error. |
| **BLOCKED** | Cannot be tested in this environment (no touch screen, no slicer, …). Say why. |
| **N/A** | Not applicable to this run — the feature was unreachable for a documented reason. |

## Environment and setup

1. `cd mask-painter` and run `node serve.mjs`. It prints the URL to open —
   `http://127.0.0.1:8137/mask-painter/index.html` unless that port is taken.
2. Open it in a browser with WebGL (Chrome, Firefox, Edge, Safari) and leave the developer
   console open: several items ask for the absence of errors.
3. The app starts with **no model** — that is the shipped behaviour, not a fault. Load the
   bundled model with **Load example model** unless an item says otherwise. It is
   `Sprunki Mercuy.stl` — 422,658 triangles, 1,267,974 vertices, bounding box 60.1 × 103.4 ×
   53.0 units.
4. Between sections, **reload the page** to start from a clean selection. Several checks are about
   *what changed*, which needs a known starting point.
5. Timings below come from a desktop-class machine; treat them as orders of magnitude, not
   budgets.

**Test data**

| Data | Where it comes from |
| --- | --- |
| The bundled figure | **Load example model** |
| A tiny valid selection | The *Ready to import* block in [Export / import](help.html#mask-json) — 4 selected corners on a 36-vertex model |
| A deliberately wrong mask | The same file, loaded while the bundled figure is open (its `vertexCount` is 36, the figure has 1,267,974) |
| A non-STL file | Any `.png` or `.json` — used to prove drag & drop ignores it |

## Coverage matrix

| Guide section | Items |
| --- | --- |
| [Getting started](help.html#start) | L1–L8, U1–U2 |
| [Top bar](help.html#topbar) | L1–L8 |
| [Selection](help.html#selection) | P1–P3, P5, P9, P11–P12, M1, M3 |
| [The tools](help.html#select) | P1–P5, K1 |
| [The rectangle](help.html#select-box) | P6 |
| [Seam panels](help.html#parts) | P1, P3–P4 |
| [Select all, none, invert](help.html#select-more) | P8–P9 |
| [Cleaning up the model](help.html#cleanup) | P12–P13, V5 |
| [Whole models](help.html#cleanup-models) | P7, P12 |
| [The bed](help.html#cleanup-bed) | P13 |
| [Windows](help.html#windows) | M5–M6 |
| [The window list](help.html#windows-list) | M4 |
| [Tint & view](help.html#tint) | M1–M3 |
| [Stencil (STL)](help.html#stencil) | S1–S13, P11, M6 |
| [Model & view](help.html#view) | V1–V5, P10 |
| [Export / import](help.html#export) | X1–X11 |
| [Selection JSON](help.html#mask-json) | X1–X3, X9 |
| [Importing](help.html#import-json) | X4–X7, X11 |
| [Selected shell PLY](help.html#ply) | X8 |
| [Stencil STL](help.html#stl) | S9–S10 |
| [Keyboard & mouse](help.html#shortcuts) | K1–K2 |
| [How it works](help.html#howitworks) | N1–N3 |
| [How it is verified](help.html#tests) | N4 |

---

# A. Startup & loading

#### L1 · The app loads and runs

**Steps**
1. `node serve.mjs`, then open the printed URL with the console **and the network panel** open.
2. Watch both while the page settles.

**Expected** Panel and viewport render and no model is loaded, because nothing asks for one: the
network panel shows **no request for `Sprunki Mercuy.stl`** and the console has no errors. The model
line reads `no model loaded`; the Selection panel's stats line reads `Load a model to see how much
of it is selected.`; the stencil panel reads `No stencil built yet.` with **Export stencil STL**
disabled and **Build stencil** live (clicking it says `Load a model first.`); the status bar
says `Ready — nothing loaded yet. Drop an .stl anywhere, use “Open STL…”, or load the bundled
example with “Load example model”.` The viewport is empty background — the ground grid is the
model's bed and appears with the first model — so the only way a model ever loads is an action of
yours: **Open STL…**, **Load example model**, or a drop.
**Guide** [Getting started](help.html#start)
**Automated** `test/ui-wiring.test.mjs` — every element id `main.js` looks up exists in the
markup, `loadFromURL(DEFAULT_MODEL_URL)` has exactly one call site and it is the **Load example
model** button (a boot-time fetch fails the suite), boot ends at the status line above, and the two
empty states are still in the markup; serving itself checked with `curl` (200, `text/html;
charset=utf-8`).
**Result** ☐ pass ☐ fail — notes:

#### L2 · Open STL… loads a binary or ASCII STL

**Steps**
1. **Open STL…** and pick `Sprunki Mercuy.stl` (or any other STL).
2. Note the model line and the status bar. Watch the console.

**Expected** The model appears framed by the camera, and the loading overlay goes through its
messages (`Parsing STL…`, `Preparing mask layer…`, `Building pick acceleration for 422,658
triangles…`) and then **clears** — see L8 for what that overlay being left up means. The model line
shows the file name, `422,658 triangles`, `1,267,974 vertices` and the bounding box. A fresh empty
selection is created — the stats line reads `0 of 422,658 faces selected (0.0%) · 0 of 1,267,974
corners inside the window`. Load takes roughly 0.3 s, almost all of it the pick acceleration
structure (BVH). The console has no errors.
**Guide** [Top bar](help.html#topbar)
**Automated** `test/app-path.test.mjs` drives the same parser and `MaskLayer` construction on
the real file.
**Result** ☐ pass ☐ fail — notes:

#### L3 · Load example model

**Steps**
1. Reload the page and confirm the empty start (L1) — no model, nothing fetched.
2. Press **Load example model**.

**Expected** Same result as L2 without a file dialog, and this is the only way the bundled file is
ever loaded: it is not fetched until the button is pressed. If the `.stl` is missing from the parent
folder, the status bar reports the HTTP error and whatever was loaded stays loaded.
**Guide** [Top bar](help.html#topbar)
**Automated** not automated — needs a browser fetch.
**Result** ☐ pass ☐ fail — notes:

#### L4 · Drag & drop

**Steps**
1. Drag an `.stl` onto the viewport.
2. Then drag a `.png` (or `.json`) onto the viewport.

**Expected** The STL loads exactly as **Open STL…** would. The non-STL is ignored and the
current model is left alone.
**Guide** [Top bar](help.html#topbar)
**Automated** not automated — browser file drag events.
**Result** ☐ pass ☐ fail — notes:

#### L5 · Screenshot

**Steps**
1. Select something so the viewport has visible tint.
2. Turn on the stencil **Preview** and **Show seams** if you want them in the image.
3. Press **Screenshot**.

**Expected** A PNG downloads named `<model>-mask-view.png`, showing the viewport exactly as
rendered — selection tint, preview and seam lines included.
**Guide** [Top bar](help.html#topbar)
**Automated** not automated — canvas capture.
**Result** ☐ pass ☐ fail — notes:

#### L6 · The model line

**Steps**
1. Load the example model.
2. Compare the numbers against the expected figures in the Environment section above.

**Expected** File name, triangle count, vertex count and bounding box
(`60.1 × 103.4 × 53.0 units`). Units are whatever the STL uses; the guide says "mm" where a
printed number is meant, because every STL that prints well is in millimetres at final size.
**Guide** [Top bar](help.html#topbar)
**Automated** `test/app-path.test.mjs` (model dimensions used throughout).
**Result** ☐ pass ☐ fail — notes:

#### L7 · A second model replaces the mask

**Steps**
1. Load the example model and select the eyes (Part at the 5° preset, or Select faces).
2. Load a different STL (any other file will do).

**Expected** The selection is gone — the stats line reads `0 of <faces> faces selected (0.0%) ·
0 of <vertices> corners inside the window` and the viewport shows no tint: a selection is face
indices into one mesh, so it only means anything for the model it was made on.
**Guide** [Top bar](help.html#topbar)
**Automated** `test/ui-wiring.test.mjs` — a new model gets a new tint and an empty selection, and the
panel is told rather than left showing the last model's numbers.
**Result** ☐ pass ☐ fail — notes:

#### L8 · A load cannot end stuck on the loading overlay

**Steps**
1. Reload, then load any STL — **Load example model** is quickest — with the console open.
2. Watch the overlay text: `Parsing STL…`, `Preparing mask layer…`, `Building pick acceleration for
   422,658 triangles…`.
3. Pick a face (**Shift**+**S**, then click) and then load a model over it, so there is a highlight
   to release; then do it again with a whole model picked.

**Expected** The overlay clears and the model line, the status bar and the panels all fill in. It
never stops on **Preparing mask layer…** with the console showing an uncaught error: the load path
releases the face-pick highlight when it builds the new mask layer, and anything thrown there leaves
the overlay up, no model loaded, and nothing to do but reload. That is what a session does when
that release goes wrong — the highlight used to be cleared through the *drawing* function with its
colour options missing, which threw `Cannot destructure property 'color' of 'undefined'` on the
first load of every session, and the app was unusable until it was fixed. Loading twice in one
session and loading with faces already picked are both on this path.
**Guide** [Getting started](help.html#start)
**Automated** `test/select.test.mjs` runs the highlight path for real against a `THREE.Group` —
draw a pick, replace one with another (and free the one it replaced), clear one, clear nothing — so
a throw in it fails `npm test` instead of a session; `test/ui-wiring.test.mjs` pins that clearing is
its own function with no options to miss, that every drawing option has a default, that the pick is
released on the load path, and that the drawing lives in `js/highlight.js` rather than reaching into
the viewer from a closure. Verified in a real headless browser while fixing it: the shipped commit
leaves `#loading` visible with the text `Preparing mask layer…` and reports the throw, the fixed one
loads the model in 1.4 s and clears the overlay.
**Result** ☐ pass ☐ fail — notes:

---

# B. Selection — the tools

#### P1 · A Part click selects the whole panel

**Steps**
1. Load the bundled model. Press <kbd>P</kbd> (or click **Part**).
2. Click the face of the figure, somewhere well inside it.
3. Click a shoe, then a whole leg.

**Expected** The panel under the cursor is selected — every triangle of it — and the status bar
reports `Selected part <n> of <m> — <faces> faces (<share>% of the mesh), <faces> faces added to the
selection (<selected> of 422,658 selected in all, seams at 8°)`. On the face of the figure the panel
is about 43% of the mesh and the bar adds the sentence naming the smaller panel the click probably
aimed at (`the detail you aimed at is probably Part <n> …`), because a click can only ever select the
panel it lands on. The selected triangles are tinted amber, the stats line counts them, and nothing
is added to the mesh or the file.

Nothing lights up under the cursor while **Part** is the tool in hand. A panel is not a triangle, so
a triangle outlined under a cursor that is about to take a head or a limb describes the wrong click:
Part names the panel it would take in the status bar and in the list the click opens, and the white
outline under the cursor belongs to **Select faces** (P5). Switching from Select faces to Part takes
that outline off screen rather than leaving the last one drawn — a face still lit up in Part mode is
the report this rule answers.
**Guide** [Selection](help.html#selection) · [Seam panels](help.html#parts)
**Automated** `test/parts.test.mjs` — the seam rule on a cube with a known answer, then every face of
one part on the real model, and a real raycast through a real camera reporting the model's own
triangle order. `test/ui-wiring.test.mjs` — the pointer move draws the hover face in the Select tool
and clears it in Part, and `setTool` clears it on the way into Part, so no path can leave one lit.
**Result** ☐ pass ☐ fail — notes:

#### P2 · Shift-click and Alt-click add and remove panels

**Steps**
1. With one panel selected, Shift-click a second one away from the first.
2. Alt-click the second one.
3. Alt-click the first one, then undo once.

**Expected** <kbd>Shift</kbd> adds the second panel to the same selection (`Added part … added to the
selection`), <kbd>Alt</kbd> takes exactly that panel back off, and neither click clears what was
there. Both are one undo step each, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings the panel back and
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> takes it off again. The stats line and the tint track
every step.
**Guide** [Selection](help.html#selection)
**Automated** `test/selection.test.mjs` — adding, removing and replacing a widget's worth of faces,
and that a gesture which changes nothing is not an undo step.
**Result** ☐ pass ☐ fail — notes:

#### P3 · The panel list — when the click was a near-miss

**Steps**
1. With **Seams** cut at 8°, aim at a thin panel — an eyebrow, the mouth — and click a few pixels
   off it, so a big panel gets selected.
2. Look at the list that appeared under the seam slider, and click the entry for the panel you meant.

**Expected** The list names the panels that meet the one selected, closest to the click first, with
each row's face count, share of the mesh and distance; **Hide this list** closes it. Clicking a row
selects that panel instead (one undo step, and it replaces the selection like a plain click does). A
click that lands on nothing leaves the selection alone.
**Guide** [Seam panels](help.html#parts)
**Automated** `test/parts.test.mjs` — the panel-near-a-point query, including that the thin panel a
click missed is on the list.
**Result** ☐ pass ☐ fail — notes:

#### P4 · Seam angle, the presets and Show seams

**Steps**
1. Drag **Seam angle** from 8° up to 25° and down to 5°, clicking a panel at each setting.
2. Press the four presets (**Face details 5°**, **Portrait 8°**, **Body parts 12°**, **Broad
   shapes 25°**).
3. Tick **Show seams**, orbit, then untick it.

**Expected** A smaller angle cuts the model into more, smaller panels; 5° separates the eyes, brows
and mouth into panels of their own, 25° merges the limbs into the body. Each preset moves the slider
to its angle and lights itself up. The seam readout and the panel stats update with the slider; the
panel list follows the angle after a rebuild of about half a second the first time. **Show seams**
draws the panel boundaries as lines, and the Part click keeps selecting whole panels while it is on.
**Guide** [Seam panels](help.html#parts)
**Automated** `test/help.test.mjs` — the default angle and the four presets are the same in the code,
the markup and the guide.
**Result** ☐ pass ☐ fail — notes:

#### P5 · Select faces — a click picks one triangle

**Steps**
1. Press <kbd>Shift</kbd>+<kbd>S</kbd> (or click **Select faces**), then click a single triangle on
   the face of the figure.
2. Click the same triangle again; then click three others with <kbd>Shift</kbd> held, and take one
   back off with <kbd>Alt</kbd>.
3. Watch the status bar and the stats line.

**Expected** The triangle under the cursor is outlined white while this tool is in hand, so the click
is judged before it happens. One triangle is tinted per click and the status bar says `Selected face <i> of 422,658 —
<n> selected in all. Shift-click adds, Alt-click takes one off, “Select all” takes the lot.` A second
plain click on the same triangle unselects it; <kbd>Shift</kbd> adds without ever flipping,
<kbd>Alt</kbd> removes. The stats line counts the faces and the corners inside the window.
**Guide** [Selection](help.html#selection)
**Automated** `test/selection.test.mjs` and `test/app-path.test.mjs` — the click path writes the one
selection, and a one-face selection is a window in the built shell.
**Result** ☐ pass ☐ fail — notes:

#### P6 · Select faces — the rectangle

**Steps**
1. With **Select faces** in hand, drag a rectangle over one eye and release.
2. Drag another rectangle over the other eye with <kbd>Shift</kbd> held, then a third over one of
   them with <kbd>Alt</kbd> held.
3. Start a drag and press <kbd>Esc</kbd> before releasing it.

**Expected** Releasing a plain drag makes the selection exactly the triangles the rectangle covered —
and only those facing the camera: the status bar names how many were under it all told and how many
of those faced away and were left alone. <kbd>Shift</kbd> adds the box's faces to the selection,
<kbd>Alt</kbd> takes them off. <kbd>Esc</kbd> throws the drag away and says `the rectangle was
cancelled — the pick is unchanged`. One drag is one undo step, however many triangles it took.
**Guide** [The rectangle](help.html#select-box)
**Automated** `test/boxselect.test.mjs` — the projection against three.js' own, the facing rule, a
vertex behind the camera, and a mid-body box on the real figure.
**Result** ☐ pass ☐ fail — notes:

#### P7 · Select models — the shells in one file

**Steps**
1. Press <kbd>S</kbd> (or click **Select models**) on a file that holds more than one shell, and
   click one of the models in the viewport.
2. Use the model list that appears, then **Count models**.

**Expected** The whole separate model under the cursor is selected (`Selected Model <n> — <faces>
faces (<faces> in the model)`), and the list under the selection stats names each model with its face
count and size. A click on a model toggles it; **Count models** reports the shells without changing
the selection. On a one-model file the tool says so and suggests **Select faces** instead.
**Guide** [Whole models](help.html#cleanup-models)
**Automated** `test/select.test.mjs` — the shell rule on a soup whose models are known by
construction, including two boxes meeting at a single corner.
**Result** ☐ pass ☐ fail — notes:

#### P8 · Select all, select none and invert

**Steps**
1. <kbd>Ctrl</kbd>+<kbd>A</kbd>, then <kbd>Esc</kbd>.
2. Select one eye with <b>Part</b>, then press <kbd>Shift</kbd>+<kbd>I</kbd> (**Invert selection**).
3. Press it again.

**Expected** **Select all** takes every triangle and says so; <kbd>Esc</kbd> clears the selection and
nothing else. Invert swaps what is selected for what is not in one undo step, and the stats line
reports both counts; inverting twice returns to the original selection (and the second invert is a
separate undo step).
**Guide** [Select all, select none, invert](help.html#select-more)
**Automated** `test/selection.test.mjs` — select all, none and invert, exactly mirrored counts.
**Result** ☐ pass ☐ fail — notes:

#### P9 · Undo and redo across both tools

**Steps**
1. Select a panel with **Part**, then a rectangle with **Select faces**, then one triangle.
2. <kbd>Ctrl</kbd>+<kbd>Z</kbd> five times, then <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>
   five times.

**Expected** Every gesture is one step, whichever tool made it, and undo walks back through them in
order — one triangle, then the rectangle, then the panel — restoring the exact faces and the tint
with them; redo walks forward again. A click that selected what was already selected is not a step.
The Undo and Redo buttons disable at the ends of the history.
**Guide** [Undo and redo](help.html#select-more)
**Automated** `test/selection.test.mjs` — the history: the exact faces back, redo after an add and
after a removal, and a snapshot renumbered across a soup that was cut.
**Result** ☐ pass ☐ fail — notes:

#### P10 · Navigate — selecting without letting go

**Steps**
1. Click **Navigate: off** so it reads **Navigate: on**, then left-drag in the viewport.
2. Hold <kbd>Space</kbd> and left-drag with **Navigate: off**.
3. Right-drag, middle-drag, wheel.

**Expected** With **Navigate: on**, or while <kbd>Space</kbd> is held, the left button orbits and
nothing is selected, whichever tool is up; releasing the key puts the tool back. Right-drag orbits,
middle-drag pans and the wheel zooms at all times. Selecting never moves the model, and the exports
keep the file's own coordinates.
**Guide** [Model & view](help.html#view)
**Automated** `test/ui-wiring.test.mjs` — the navigate toggle is wired to the viewer's pointer mode.
**Result** ☐ pass ☐ fail — notes:

#### P11 · Part and Select faces share one selection — and the stencil is built from all of it

**Steps**
1. Load the bundled model and click a panel with <b>Part</b> (a shoe is a good, small one).
2. Switch to **Select faces** and click one triangle somewhere else on the model, well away from the
   panel.
3. Press **Build stencil**.
4. Now <kbd>Alt</kbd>-click that single triangle off and build again.

**Expected** Switching tools never clears the selection: the panel stays tinted amber while the
triangle is added, and the status line after the triangle click counts both (`<n> selected in all`).
The build reports `2 windows` — one for the panel, one for the single face — and `one piece` when the
band around them closes. After <kbd>Alt</kbd>-clicking the triangle off, the rebuild reports
`1 window`. A single picked face on its own is a window too: the build says
`1 selected island is thinner than the 0.35 window inlay, so its window was cut at its own edge`, and
a ray straight through the built shell over that triangle passes through the hole rather than through
mask material. This is the report the app was fixed for: picked faces used to be absent from the
built stencil while Part panels and box drags worked.
**Guide** [Selection](help.html#selection) · [Stencil](help.html#stencil)
**Automated** `test/app-path.test.mjs` — a one-face selection, a Part panel plus one picked face, and
unpicking a face, each checked by looking for the hole in the built shell; `test/stencil.test.mjs`
pins the same guarantee for a dot smaller than the window inlay.
**Result** ☐ pass ☐ fail — notes:

#### P12 · Removing faces and models — and putting them back

**Steps**
1. Select a model in a multi-model file and press **Remove selected** twice (the button reads
   **Click again to remove**).
2. Press **Restore removed**.
3. Select a patch of faces on the figure, remove them, and restore.

**Expected** The first press only arms the button; the second takes the geometry out and the status
line says where the bed ended up, because the model's own lowest point moved. The selection carries
through the cut face by face, the undo history with it, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> puts the
removal back. **Restore removed** puts every removed face back exactly as the file had it, and the
exports, the panels and the built shell are discarded with the geometry they described.
**Guide** [Cleaning up the model](help.html#cleanup)
**Automated** `test/select.test.mjs` — the filtered soup holds exactly the faces it should, the
corner map points back at the file, and the selection and its history are renumbered.
**Result** ☐ pass ☐ fail — notes:

#### P13 · The bed — why a model can load in the air

**Steps**
1. Load the bundled model with **Centre model on the grid** ticked, then untick it.
2. Note the model's lowest point and the grid.

**Expected** The ground grid is drawn on the model's own lowest point, so the figure stands on it
either way; centring moves the *view*, not the mesh, so the selection, the mask and every export keep
the file's own coordinates. The stencil panel's **Sit the exported part on the bed** is what decides
the Z of the file that is written.
**Guide** [The bed](help.html#cleanup-bed)
**Automated** `test/select.test.mjs` — a copy written 30 units below the figure lifts it off the bed
by exactly that, and removing it puts the lowest point back at 0.
**Result** ☐ pass ☐ fail — notes:

---

# C. Tint, windows and the stats line

#### M1 · Selection tint

**Steps**
1. Select a panel, then drag **Selection tint** from 100% down to 0 and back.
2. Untick **Show the selection tint**, then tick it again.

**Expected** The amber tint over the selected triangles fades with the slider and disappears at 0,
leaving the selection otherwise intact (the stats, the exports and the build are unaffected). With
the box unticked the tint is gone entirely and the selection is still there. Everything else on the
model keeps its own colour; nothing is drawn where nothing is selected.
**Guide** [Tint & view](help.html#tint)
**Automated** `test/selection.test.mjs` — the tint holds the corners of the selected faces and
nothing else, and the colour buffer is what makes the selection visible.
**Result** ☐ pass ☐ fail — notes:

#### M2 · Ghost shell and the view toggles

**Steps**
1. Select a panel and tick **Ghost shell**.
2. Toggle **Show base model**, **Show ground grid** and **Wireframe** one at a time.

**Expected** **Ghost shell** gives everything that is *not* selected a faint alpha, so the selected
window reads through the figure; the rest of the model is untouched. The other three toggles show and
hide the model, the bed grid and the wireframe without changing the selection, the mask or any
export.
**Guide** [Tint & view](help.html#tint)
**Automated** `test/ui-wiring.test.mjs` — every display toggle in the markup is wired to the viewer.
**Result** ☐ pass ☐ fail — notes:

#### M3 · The stats line

**Steps**
1. Load the model and read `#selectionStats`.
2. Select a panel, then **Select all**, then <kbd>Esc</kbd>.
3. Select more than 150,000 faces.

**Expected** The line reads `Load a model to see how much of it is selected.` before anything is
loaded, then `0 of 422,658 faces selected (0.0%) · 0 of 1,267,974 corners inside the window`. Every
edit updates both numbers, and the second is exactly three times the first (every triangle has three
corners). Above 150,000 faces the line adds `too many to tint in the viewport, so the tint is off` —
the selection is unchanged and the build still uses all of it.
**Guide** [Selection](help.html#selection)
**Automated** `test/selection.test.mjs` — the corner count is three per selected face; the limit
notice is pinned by `test/ui-wiring.test.mjs`.
**Result** ☐ pass ☐ fail — notes:

#### M4 · List windows — removing one by name

**Steps**
1. Select two areas that do not touch, e.g. one shoe and one hand.
2. Press **List windows**.
3. Press **Remove** on one row, then **List windows** again.
4. Press **Keep only** on a row.

**Expected** The list names every window — each connected group of selected faces is one opening in
the built stencil — with its face count, its share of the mesh and its size. **Remove** unselects
that window alone and rebuilds the tint, leaving the others exactly as they were; **Keep only** keeps
that window and unselects every other one. Both are one undo step, and both are refused with a
readable message when the selection is empty or is a single window.
**Guide** [The window list](help.html#windows-list)
**Automated** `test/app-path.test.mjs` — dropping the window the list names drops it from the
rebuild, and one undo puts it back.
**Result** ☐ pass ☐ fail — notes:

#### M5 · Drop small windows

**Steps**
1. Select a big patch and add a couple of specks elsewhere (single faces are enough).
2. Set **Drop windows under (% of the model)** to 2 and press **Drop small windows**.
3. Press it again, and press it with everything selected as one connected region.

**Expected** Every window smaller than the threshold goes in one undo step and the largest is always
kept: the status line says which windows went and how much of the selection is left. Pressed a second
time there is nothing to do and the button says so. With one connected selection the panel explains
that no size threshold can split it, and points at **List windows** instead.
**Guide** [Windows](help.html#windows)
**Automated** `test/cleanup.test.mjs` — trimming on a made-up mesh with three islands of known sizes,
a threshold above every island still keeping the largest, and a blob plus two stray dabs on the real
figure landing as one undo step.
**Result** ☐ pass ☐ fail — notes:

#### M6 · The window count is the window list

**Steps**
1. Select one area, press **Build stencil** and note the window count in the result panel.
2. Select a second, separate area and build again.
3. Select two areas that touch (Shift-click two neighbouring panels) and build.

**Expected** The panel's window count matches what **List windows** shows for the same selection, and
each build's count is one more than the last for a separate area. Two neighbours that touch are one
window, not two — the selection is per triangle, and connected triangles are connected however they
were selected.
**Guide** [Windows](help.html#windows) · [Stencil](help.html#stencil)
**Automated** `test/stencil.test.mjs` — the window loops of every case, and `test/app-path.test.mjs`
for the hand-built ones.
**Result** ☐ pass ☐ fail — notes:

---
# D. Stencil (STL)

#### S1 · Build the stencil

**Steps**
1. Select one eye — Part at the 5° preset, or a few triangles with Select faces.
2. Press **Build stencil**. Read the result panel.

**Expected** The build succeeds and reports: triangle count, how many pieces, **how many
windows** (one per separate group of selected faces — take the eye and the eyebrow as two groups
and this reads 2), the reach used, the wall thickness range achieved, the standoff, the bounding box,
whether it is watertight, the measured clearance, per-stage timings, and any warnings. First
build also welds the model (~0.4 s, cached); the build itself takes 0.7–1.5 s with the widening
option on. Warnings are not decoration — they are the conditions under which the part will not do
what you expect.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/stencil.test.mjs` — every case in the suite (a single eye, both eyes, a narrow
cover, a dot smaller than the inlay, a head cap, a front slab, two far-apart areas, nothing
selected, everything selected, a standoff sweep) checked for two-triangles-per-edge,
outward winding, positive volume, an open window, mask material in the ring, one piece or an
honest warning. `test/app-path.test.mjs` builds with the panel's own defaults.
**Result** ☐ pass ☐ fail — notes:

#### S2 · Selecting more after a build

**Steps**
1. Build a stencil.
2. Select somewhere else without rebuilding — and then press **Export stencil STL**.

**Expected** The panel carries `⚠ the selection has changed since this was built — build again to
match it, or “Discard stencil” to throw this one away.`, because the app never hands you a silently
stale part. Selecting more does not invalidate the geometry you already have. Pressing **Build
stencil** again reuses the cached weld, so the rebuild is fast. Exporting, on the other hand,
never writes a stale part: it builds again first (S9), so the file matches the mask on screen even
if you skip the manual build.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/app-path.test.mjs` (a second build reuses the cached topology).
**Result** ☐ pass ☐ fail — notes:

#### S3 · Preview draws under the tint

**Steps**
1. Build a stencil, leave **Preview** on.
2. Select part of the shell and clear another part, keeping the preview on.
3. Turn **Preview** off.

**Expected** The shell is semi-transparent and double-sided, and you can orbit around it. It
draws **under** the selection tint, so selected areas keep their colour and stay fully visible;
with the preview off you are looking at the mask alone.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/ui-wiring.test.mjs` pins the preview's render order relative to the tint layer.
**Result** ☐ pass ☐ fail — notes:

#### S4 · Reach

**Steps**
1. Build with **Reach** at a small value, then at a large one.

**Expected** Reach is how far the mask material extends from the window boundary *across the
surface*. Default is ~11.5% of the model's diagonal (15 mm on the bundled figure). Small reach
gives a band around the window; large reach wraps the figure. Triangle count and build time both
grow with it.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/stencil.test.mjs` (the band is measured from the selection field).
**Result** ☐ pass ☐ fail — notes:

#### S5 · Wall

**Steps**
1. Build at the default **Wall** (1.19 mm) and note the reported wall range.
2. Raise it and rebuild.

**Expected** The sheet away from the window is the wall thickness; the window edge is
deliberately thinner (~0.4 mm, half the wall) so a brush meets a thin lip instead of a wall and
paint cannot wick under it. The result panel reports the wall range it achieved.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/stencil.test.mjs` — thickness stays inside the expected band for every case.
**Result** ☐ pass ☐ fail — notes:

#### S6 · Standoff and the clearance you actually get

**Steps**
1. Build with **Standoff** at 0.19 mm (the default). Read the reported clearance.
2. Rebuild at 0.3 mm and compare the median, the 5th percentile, the minimum and the count of
   spots tighter than half the standoff.

**Expected** The reported clearance is the gap *achieved*, measured from every inner-face
vertex to the nearest surface triangle — not just the number you typed. Expect roughly: 0.1 mm →
median 0.100, min 0.002; 0.2 mm → median 0.200, min 0.003; 0.3 mm → median 0.300, min 0.005.
The minimum barely improves as you raise the standoff, because creases sharper than the averaged
vertex normal force the offset back to the surface — a geometric limit, not a setting.
**Guide** [Stencil (STL) → Clearance](help.html#stencil)
**Automated** `test/app-path.test.mjs` cross-checks the reported clearance against an
independent measurement of every inner vertex; `node test/clearance.mjs 0.1 0.2 0.3` prints the
distribution for any standoff.
**Result** ☐ pass ☐ fail — notes:

#### S7 · Window inlay

**Steps**
1. Build at the default **Window inlay** (0.35 mm), then rebuild with 0.

**Expected** Inlay is mask material overlapping the *selected* side of the boundary, so paint
cannot creep under the window edge. Raising it makes the window slightly smaller than the
selection and the edge more forgiving; 0 puts the window exactly on the selected boundary.
On top of the inlay there is always a small inset, because the distance field is smoothed so the
cut is not ragged.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/stencil.test.mjs` — the "narrow cover" and "dot smaller than the inlay"
cases cover both ends.
**Result** ☐ pass ☐ fail — notes:

#### S8 · Widen the reach until the mask is one piece

**Steps**
1. Select one big panel with **Part** (about half the figure). Leave **Widen the reach…** on and
   build — note the time and the reported piece count and reach.
2. Turn it off and build again.

**Expected** With it on, the reach is grown automatically (up to six times, in 25% steps) until
the shell is one piece, or the limit is reached — this is the main reason a build can take
several seconds (up to ~6 builds, 8.8 s on the measured run). With it off you get a band around
the panel: one pass, far less material, much faster (about 110,676 triangles in 749 ms versus
644,876). If it still comes out in pieces, the panel says so.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/parts.test.mjs` — a part-sized window builds and the shell covers the band
around it (2525/2525 probes) with nothing on the far side (14186/14186 bare).
**Result** ☐ pass ☐ fail — notes:

#### S9 · Export stencil STL, and the save that must match the screen

**Steps**
1. Before building anything, look at **Export stencil STL**.
2. Build successfully, press it, and check the downloaded file's size.
3. Now Shift-click two more panels (or select another area), leave the build alone, and press
   **Export stencil STL** again. Compare the two files: window count in the result panel, and the
   STL sizes.
4. Press **Build stencil** and export once more; compare with step 3.

**Expected** Disabled until a build has succeeded (and left disabled after a refused build). It
writes a binary STL named `<model>-paint-stencil.stl` whose size is exactly
`84 + 50 × triangles` bytes.
The second export must contain **every** window, not just the ones from the last build: the app
notices the selection has moved on, builds again first (the status bar says so while it works), and
reports `… Rebuilt from the current selection first, because the selection had changed since the
last build.` Its file is therefore
bigger than the first one and matches what step 4 writes. Before this was fixed the second export
was a byte-for-byte copy of the first, under a fresh timestamp — the reported bug. If that
rebuild is rejected, nothing is written and the status bar says why rather than leaving an older
part to be saved.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/stencil.test.mjs` — byte size equals `84 + 50 × triangles`, and the file
re-reads into the same watertight, same-volume solid. `test/app-path.test.mjs` rounds the real
model twice: the second round is its own window in a rebuild (2 → 3 windows, 4.9 MB → 10.6 MB)
while the build in hand still describes the smaller mask; `test/ui-wiring.test.mjs` pins that the
export rebuilds before writing and writes nothing when the rebuild is refused.
**Result** ☐ pass ☐ fail — notes:

#### S10 · The exported part in a slicer

**Steps**
1. Load the exported STL beside the figure in your slicer.
2. Slice it without repair.

**Expected** It is a single watertight solid, in the model's own units: X and Y in the model's own
coordinate frame, so it lines up with the figure without scaling, and — with **Sit the exported
part on the bed** ticked (the default, S13) — its lowest point on **Z 0**, so the slicer puts it on
the plate instead of leaving it floating. Up axis is *not* baked in — rotate it in the slicer if
your printer expects Z up. The selected area is a hole, not a thin wall.
**Guide** [Stencil (STL) → Stencil STL](help.html#stl)
**Automated** `test/stencil.test.mjs` (watertight and consistent winding, re-read from the file);
`test/app-path.test.mjs` measures the written file's lowest Z;
**not** automated for slicer behaviour.
**Result** ☐ pass ☐ fail — notes:

#### S11 · The documented clearance sweep

**Steps**
1. Run `node test/clearance.mjs 0.1 0.2 0.3` in `mask-painter/`.

**Expected** It prints the clearance distribution at each standoff, measured against the whole
model rather than against the mask's own footprint — the reference behind the table in the
guide.
**Guide** [Stencil (STL) → Clearance](help.html#stencil)
**Automated** this *is* the tool; `test/app-path.test.mjs` checks the same numbers from the app
path.
**Result** ☐ pass ☐ fail — notes:

#### S12 · Discard a built stencil

**Steps**
1. Build a stencil, then press **Discard stencil**.
2. Clear the selection with **Select none** (Esc) while a build is in hand, and read the status
   bar.

**Expected** Discarding removes the shell from the viewport, clears the result panel back to
"No stencil built yet.", disables **Export stencil STL** and says how many triangles went; the
button is only enabled while a build exists (a refused build, a discarded one and a fresh model
all leave it disabled). The selection is untouched — a build is a snapshot of the selection, so
keeping the shell after clearing it is allowed, and the status bar says the shell is still there
and names this button. Before this control existed the only way to remove a shell was to load
the model again.
**Guide** [Stencil (STL)](help.html#stencil)
**Automated** `test/ui-wiring.test.mjs` — the button exists, its handler is `discardStencil`, and
that function clears the preview, drops the result and disables the export.
**Result** ☐ pass ☐ fail — notes:

#### S13 · The exported part sits on the bed — every piece of it

**Steps**
1. Load the example model, select a face window (the eyes are the quickest), build the stencil and
   read the result panel's size line.
2. Leave **Sit the exported part on the bed (Z = 0)** ticked and press **Export stencil STL**.
   Read the status bar.
3. Open the file in a slicer: it must land flat on the plate with no dragging, and with no
   `Split to objects` needed.
4. Untick the box, export again, and compare the two files in the slicer next to the figure.
5. Tick it, load a model that already sits on its own Z 0 (or a **Z up** CAD part), and export:
   the status bar should say nothing moved.
6. The multi-piece case, which is the one the option used to leave hovering. Turn **Widen the
   reach until the mask is one piece** off, set **Reach (mm)** to 8, select one window high on the
   figure (the head) and one low down (the feet), and build — the result panel must say
   **2 pieces**. Export with the box ticked and read the status bar, then import the file into the
   slicer.
7. Repeat step 6 with the box unticked and compare the two files in the slicer.

**Expected** With the box ticked the written file's **lowest vertex is exactly Z 0** — the status
bar says `sat on the bed: moved down 41.00 mm so the part's lowest Z is 0 (X and Y untouched)` for
the example face mask, which in model coordinates has its lowest point at Z 41.0 and therefore
floats 41 mm in the air in a slicer. The part is otherwise identical: same triangles, same size,
still one watertight piece, and X/Y unchanged, so it still lines up with the figure. **Only the
written copy moves** — the mask, the panels, the preview and the result panel are untouched (select
and build once, then export with the box on and off: the viewport must not change either time).
Unticked, the status bar says `left in the model's own coordinates (lowest Z 41.00)` and the file
is the shell exactly where it sits on the model, which is what you want for lining the mask up
against the figure in a slicer. A part already on Z 0 reports `its lowest point was already on
Z 0, so nothing moved`.

Step 6 is the report that the fix had to be corrected for: **every piece is placed, not just the
whole solid by its single lowest point.** A slicer imports the shells of one STL as parts of one
object and keeps the coordinates they were written with, so the two-piece stencil measures
`2 pieces` and its pieces sit at Z −2.37 and **32.10** in model coordinates; dropping the assembly
writes Z 0 and **32.10**, i.e. the upper piece still hovers 32 mm over the plate until the user
picks `Split to objects`, which is what "it still hovers until separate objects is selected" was.
With the box ticked the status bar must say `sat each of its 2 pieces on the bed: the furthest
moved 32.10 mm so every piece's lowest Z is 0 (X and Y untouched)` and both pieces must rest flat
on the plate in the slicer — no splitting, no dragging. The pieces keep their X and Y, so nothing
moves in the plate plane; only the written copy changes. Unticked (step 7) the file keeps both
pieces at the heights the model has them (Z −2.37 and 32.10), which is the alignment escape hatch.
**Guide** [Stencil (STL)](help.html#stencil), [Stencil STL format](help.html#stl)
**Automated** `test/app-path.test.mjs` — the transform as arithmetic (floating, sunk −3 → 0, and
already-on-the-plate returned unchanged), that the array it is given is never edited, and the real
export: the file's lowest Z is 0 exactly, it spans Z 0…12.27, min X matches the build's, and it
re-reads as the same watertight solid (98,820 triangles, volume 2,110.9) — plus that unticking
leaves the file at the build's own 41.002. For step 6 the same suite builds a real two-piece
stencil (36,624 triangles, pieces at Z −2.37 and 32.10), exports it, and re-reads the file: it
still holds 2 pieces, **every piece's lowest Z is 0** (0.0e+0 each), the pieces keep their min X
and min Y, and as built the upper piece floated 32.10 mm — the amount the placement reports. The
whole-solid drop is pinned as the failing shape (pieces 1, the upper shell still at Z 40 with the
synthetic two-shell solid), and a triangle soup is pinned as left in one piece rather than
scattered. `test/ui-wiring.test.mjs` pins the control, its default and its tooltip, that the export
hands `setOnBed` the indices so the pieces can be found, that a piece already resting is not
copied, and that neither branch writes anything but Z.
**Result** ☐ pass ☐ fail — notes:

---

# E. Model & view

#### V1 · Up axis

**Steps**
1. Load the example model (it loads as **Y up**).
2. Switch to **Z up**, then **X up**, then back to **Y up**.

**Expected** The model rotates into the screen's Y-up world and the camera re-frames it. This
only changes display and framing — no coordinate in the mask or in any export is touched (check
by exporting before and after; the files are byte-identical).
**Guide** [Model & view](help.html#view)
**Automated** not automated — display-only transform in `js/viewer.js`.
**Result** ☐ pass ☐ fail — notes:

#### V2 · Camera presets

**Steps**
1. Press **Front**, **Back**, **Left**, **Right**, **Top**, then **Home**.

**Expected** Each frames the whole model from that direction; **Home** is the three-quarter view
the model loads with. Selecting works from any angle; a rectangle takes only the triangles facing
the camera, and **Part** takes the panel its ray hits.
**Guide** [Model & view](help.html#view)
**Automated** not automated — camera framing.
**Result** ☐ pass ☐ fail — notes:

#### V3 · Navigation

**Steps**
1. Right-drag, middle-drag and wheel in the viewport.
2. Hold `Space` and left-drag.
3. On a touch screen: one finger over the model, then two fingers.

**Expected** Right-drag orbits, middle-drag pans, the wheel zooms. `Space` + left-drag orbits
without disarming the selection tool. One finger selects; two fingers pan and zoom.
**Guide** [Model & view](help.html#view)
**Automated** not automated — pointer and touch handling.
**Result** ☐ pass ☐ fail — notes:

#### V4 · Status bar

**Steps**
1. Select, export, import, and provoke a no-op (Select none with nothing selected).
2. Move the cursor over the model and off it.

**Expected** The left side reports what just happened — what was selected, how many faces,
what was exported — and any warning that needs attention. The right side shows the cursor's
model-space position and the frame rate; both update as you move.
**Guide** [Model & view](help.html#view)
**Automated** `test/ui-wiring.test.mjs` (the status element exists and the actions write to it).
**Result** ☐ pass ☐ fail — notes:

#### V5 · Centre the model on the grid

**Steps**
1. Load the example model and read the status bar — it says whether the model had to be moved.
2. Untick **Centre model on the grid**, then tick it again.
3. Export the mask JSON (X1) and import it again with centring on, then repeat with centring off.
4. If you have an STL authored far from the origin, load it and watch where it lands.

**Expected** With the checkbox on (the default) a loaded model is moved so its footprint centre
sits on the grid's centre lines and its lowest point on the grid's plane; the status bar reports how
far it moved, or that it was already centred. Unticking puts the model back exactly where the file
puts it. Either way the grid is sized from the model's own bounding box and selecting behaves the
same. It is a view transform, like the up axis: no coordinate the mask or an export is written in
changes, so masks imported before or after still line up with the original STL. The bundled figure
is authored about 10 units off in x and 42 in y; the offset reported is −10.5, 42.1, −26.4.
**Guide** [Model & view](help.html#view)
**Automated** `test/cleanup.test.mjs` (the offset arithmetic on real boxes, and that measuring it
leaves the model's coordinates untouched); `test/ui-wiring.test.mjs` pins that centring writes only
`group.position`.
**Result** ☐ pass ☐ fail — notes:

---

# F. Export / import

#### X1 · Save selection (JSON)

**Steps**
1. With nothing selected, press **Save selection (JSON)**.
2. Select something and press it again.

**Expected** With an empty selection it refuses politely in the status bar instead of writing an
empty file (`Nothing selected yet — select the area the stencil should expose first.`). With a
selection it downloads `<model>-mask.json`, and the status bar reports the corner count and the file
size and points at **Open selection (JSON)…**. This is the session file: it holds the windows you
have marked up *now*, including this round's Shift-clicked panels, and it is the only format that
can be loaded back in.
**Guide** [Export / import](help.html#export)
**Automated** `test/app-path.test.mjs` — export → import of the selection this suite makes is exact,
corner for corner and id for id.
**Result** ☐ pass ☐ fail — notes:

#### X2 · Mask JSON fields

**Steps**
1. Export a selection.
2. Open the file in a text editor and compare it with the schema table in the guide.

**Expected** `format: "stl-mask"`, `version: 1`, `model`, `unit: "model units"`,
`vertexCount` equal to the model's vertex count (1,267,974), `features` holding the single entry
this app has (`id: 1`, its name and colour), `paintedVertices` equal to half the length of
`painted`, and `painted` as a flat `[vertexIndex, featureId]` pair list holding only the corners
inside the window — id 0 never appears in it. Sizes scale with the selection: a whole-panel
selection is a multi-megabyte file, a few triangles a few kilobytes. The file also carries
`stencil` with the build settings that were in the panel (`coverRadius`, `wall`, `standoff`,
`overhang`, `growIfSplit`); the field is optional, and a file without it still loads.
**Guide** [Export / import → Selection JSON](help.html#mask-json)
**Automated** `test/app-path.test.mjs` asserts each field; `test/help.test.mjs` proves the
embedded sample in the guide parses with the fields the importer reads.
**Result** ☐ pass ☐ fail — notes:

#### X3 · Round trip is exact

**Steps**
1. Select a couple of panels; note the stats line's face and corner counts.
2. **Save selection (JSON)**, then **Select none**.
3. **Open selection (JSON)…** and pick the file you just saved.

**Expected** Both counts return to exactly what they were, and the status bar reports the loaded
corner count, the face count, that the build settings were restored, and that clicking a panel with
Part is the next step.
**Guide** [Export / import → Import a saved selection](help.html#import-json)
**Automated** `test/app-path.test.mjs` — the imported selection reproduces every corner and id.
**Result** ☐ pass ☐ fail — notes:

#### X11 · Save your place, reload it and add more windows

**Steps**
1. Load the example model, mark up two panels with **Part** (Shift-click the second) and press
   **Save selection (JSON)**.
2. Reload the page (or load another model and come back), then **Load example model** again.
3. Press **Open selection (JSON)…** and pick the file. Then Shift-click a third panel, press **Build
   stencil**, and export.

**Expected** The reloaded selection has both windows exactly where they were (status bar: the
corner count, the face count, `build settings restored`, and the next step). The third panel is
added to the loaded selection rather than replacing it, and the build reports **3 windows** —
including the ones from the previous session — so the exported STL has all three. This is the flow
the file format is for: the selection JSON is the thing you save to keep working, and the stencil
export rebuilds from it rather than serving a stale build (S9).
**Guide** [Export / import → Import a saved selection](help.html#import-json)
**Automated** `test/app-path.test.mjs` — a saved session files the build settings, reopens with
every corner and id intact, and a window added after the reload reaches the build (3 → 4 windows
on the bundled model).
**Result** ☐ pass ☐ fail — notes:

#### X4 · A mask from the painting version opens as one selection

**Steps**
1. Import the guide's sample — its `features` table carries two ids, as an older file would.
2. Note the stats line, then import the same file again.

**Expected** Every corner the file lists comes back selected: this app has exactly one feature, so
several ids collapse into the one selection rather than being refused. Importing the same file twice
changes nothing, because a selection is a set of faces and an import replaces it as one undo step.
**Guide** [Export / import → Import a saved selection](help.html#import-json)
**Automated** `test/selection.test.mjs` — a mask saved by the painting version (several ids, brushed
per vertex) loads as one selection over the same corners; `test/help.test.mjs` proves the guide's
sample carries the ids the importer reads.
**Result** ☐ pass ☐ fail — notes:

#### X5 · Vertex-count mismatch warns

**Steps**
1. With the bundled figure open, import the guide's 36-vertex sample (`vertexCount: 36`).

**Expected** The import is **not** blocked, but the status bar warns `Warning: this selection was
saved on 36 vertices but this model has 1,267,974.`, so the corners land on the wrong triangles. A mask
from a slightly re-exported mesh is often close enough to be a starting point, which is why it
is a warning and not a refusal.
**Guide** [Export / import → Import a saved selection](help.html#import-json)
**Automated** `test/app-path.test.mjs` — the importer exposes both numbers, so this comparison
cannot silently disappear.
**Result** ☐ pass ☐ fail — notes:

#### X6 · A bad file is refused without damage

**Steps**
1. Select something.
2. Try to import a JSON file that is not a mask (e.g. `{}` or a random document), then a file
   that is not JSON at all.

**Expected** The status bar shows the reason (`Not an STL mask file…`, `Mask file has no
"painted" vertex list.`, or a JSON parse error). Your current selection is left exactly as it was;
nothing is half-applied.
**Guide** [Export / import → Import a saved selection](help.html#import-json)
**Automated** `test/help.test.mjs` (the format/`painted` validation the guide describes is the
one in `js/io.js`).
**Result** ☐ pass ☐ fail — notes:

#### X7 · Import is one undo step

**Steps**
1. Select something; export it; **Select none**; import it.
2. Press `Ctrl`+`Z`.

**Expected** One undo returns the selection to what it was before the import (empty).
**Guide** [Export / import → Import a saved selection](help.html#import-json)
**Automated** `test/selection.test.mjs` (the load path's history semantics).
**Result** ☐ pass ☐ fail — notes:

#### X8 · Selected shell PLY

**Steps**
1. Select a patch that includes triangles whose neighbours are not selected.
2. Press **Selected shell PLY** and inspect the header of the downloaded file, or open it in
   MeshLab/Blender/CloudCompare.

**Expected** `binary_little_endian 1.0` with the vertex and face counts in the header and the
documented property list (x, y, z as floats; red, green, blue, alpha as uchar; faces as
`list uchar uint`). Only triangles whose *three* corners are all selected are written, and the
vertices are repacked onto their own list, so the file is the selected shell rather than the whole
model. Per-vertex colour is the selection colour; alpha is 255 where selected and 0 elsewhere.
Byte size is `header + 16 × vertices + 13 × faces`, and the app reports both counts and the file
size after export. It is a zero-thickness display artefact, not a printable part.
**Guide** [Export / import → Selected shell PLY](help.html#ply)
**Automated** `test/help.test.mjs` proves the guide's layout matches `js/io.js`'s writer
exports; the byte-level layout is otherwise manual.
**Result** ☐ pass ☐ fail — notes:

#### X9 · The guide's sample loads

**Steps**
1. Copy the *Ready to import* JSON block from the guide (each code block has a **Copy** button).
2. Paste it into `example-mask.json`.
3. **Open selection (JSON)…** and pick it.

**Expected** The block is valid JSON and imports without an error. On a model with 36 vertices
all four listed corners come back selected — the file's two ids are the one selection here — and on
the bundled figure it imports with the vertex-count warning from X5.
**Guide** [Export / import → Selection JSON](help.html#mask-json)
**Automated** `test/help.test.mjs` parses the embedded sample with the app's own importer and
checks it against a 1,267,974-vertex model and a 36-vertex one.
**Result** ☐ pass ☐ fail — notes:

#### X10 · Copy buttons

**Steps**
1. Press **Copy** on any code block in the guide.

**Expected** The block's text (without the button's own label) goes to the clipboard, and a
non-clipboard fallback covers browsers that refuse the clipboard API. This is the one thing HTTP
checks cannot prove.
**Guide** [Export / import](help.html#export)
**Automated** not automated — clipboard permission.
**Result** ☐ pass ☐ fail — notes:

---

# G. Keyboard, mouse and the guide

#### K1 · Every binding

**Steps**
1. Press each key below, in a loaded session with something selected, and compare with the expected
   result.

**Expected**

| Key | Action | Expected result | Result |
| --- | --- | --- | --- |
| `P` | Part tool | The Part button becomes active and the cursor line names it. | ☐ pass ☐ fail |
| `S` | Select models | The Select models button is active; a click takes the whole model under the cursor. | ☐ pass ☐ fail |
| `Shift`+`S` | Select faces | The same tool with the pick set to single triangles. | ☐ pass ☐ fail |
| `Ctrl`+`A` | Select all | Every face in the model is selected; the stats line counts them. | ☐ pass ☐ fail |
| `Shift`+`I` | Invert | The window becomes everything except what was selected (`I` alone does nothing). | ☐ pass ☐ fail |
| `B` | Build | **Build stencil** runs from the selection in hand. | ☐ pass ☐ fail |
| `Ctrl`+`Z` | Undo | The last edit is taken back. | ☐ pass ☐ fail |
| `Ctrl`+`Shift`+`Z` | Redo | The undone edit is re-applied. | ☐ pass ☐ fail |
| `Esc` | Cancel / clear | A rectangle being dragged is thrown away; with Select faces and something selected, the
selection is cleared; otherwise the panel list is hidden. | ☐ pass ☐ fail |
| `Space` (hold) | Orbit | Left-drag orbits without leaving the selection tool. | ☐ pass ☐ fail |
| `Shift`+click (either tool) | Add | Another panel, face or model joins the selection. | ☐ pass ☐ fail |
| `Alt`+click (either tool) | Remove | What the click covers leaves the selection. | ☐ pass ☐ fail |
| `Shift`+drag / `Alt`+drag (Select faces) | Rectangle | The faces inside the rectangle join or leave the selection. | ☐ pass ☐ fail |
| `?` or `F1` | Guide | The guide opens in a new tab. | ☐ pass ☐ fail |
| right-drag / middle-drag / wheel | Navigate | Orbit / pan / zoom. | ☐ pass ☐ fail |
| drop an `.stl` | Load | The model loads (see L4). | ☐ pass ☐ fail |

**Guide** [Keyboard & mouse](help.html#shortcuts)
**Automated** `test/ui-wiring.test.mjs` (the key handler ignores keys while a field has focus);
`test/help.test.mjs` (`?` and `F1` reach `openGuide`).
**Result** ☐ pass ☐ fail — notes:

#### K2 · Typing is safe

**Steps**
1. Click into a number field (a stencil parameter, say) and type `b`, `p`, `s`, `i`, `1`, `?`.

**Expected** The characters are typed. No tool switches, no selection changes and no guide tab —
shortcuts are ignored while a text or number field has focus.
**Guide** [Keyboard & mouse](help.html#shortcuts)
**Automated** `test/ui-wiring.test.mjs` (the key handler checks the focused element).
**Result** ☐ pass ☐ fail — notes:

#### U1 · Launching the guide

**Steps**
1. Press the **Guide** button in the top bar.
2. Press `?` on a machine with a keyboard, then `F1`.
3. Press the small `?` next to each panel heading — Selection, Seams & panels, Windows, Tint & view,
   Model, Stencil (STL), Export / import.
4. In the console, run `window.maskPainter.openGuide()`.

**Expected** The guide opens in a new tab; each panel's `?` opens it *at that panel's section*,
scrolled to it. The console handle works too.
**Guide** [Getting started](help.html#start)
**Automated** `test/ui-wiring.test.mjs` (`openGuide` exists, points at `help.html`, is on the
console handle, and is bound to `?` and `F1`); `test/help.test.mjs` proves every panel `?` link
resolves to a section that exists.
**Result** ☐ pass ☐ fail — notes:

#### U2 · The guide describes the app you have

**Steps**
1. Walk each panel in the app with its guide section open beside it.
2. Try anything the guide says is possible; look for a control the guide does not mention.

**Expected** Every control in the app appears in the guide with its behaviour, cost and limits,
and no documented control is missing from the app. The guide's footer links to this validation
document.
**Guide** [How it is verified](help.html#tests)
**Automated** `test/help.test.mjs` — every button, checkbox, slider, number field and menu
option in `index.html` is named in the guide, and the suite list in the guide matches the suites
`npm test` runs.
**Result** ☐ pass ☐ fail — notes:

---

# H. Non-functional

#### N1 · Nothing leaves the page

**Steps**
1. Open the browser's network panel, clear it, and use the app: load, select, build the stencil,
   export every format.
2. Run a session with the developer tools set to offline after the page has loaded (keep the
   vendored files cached).

**Expected** Requests only for the app's own files — `index.html`, `css/`, `js/`, `vendor/`, and
the `.stl` when you load the example. No analytics, no telemetry, no upload of the model or the
mask; parsing, segmentation, selecting and the stencil build all run in the page.
**Guide** [How it works](help.html#howitworks)
**Automated** not automated — needs the browser's network panel.
**Result** ☐ pass ☐ fail — notes:

#### N2 · Performance on the bundled model

**Steps**
1. Time the operations below (the guide's table is the reference).

**Expected**

| Step | Expected | Measured | Result |
| --- | --- | --- | --- |
| Load + BVH | ~0.3 s | | ☐ pass ☐ fail |
| Hover pick | sub-millisecond (the outline follows the cursor) | | ☐ pass ☐ fail |
| Rectangle select | ~29 ms for 930,758 triangles under the box (measured) | | ☐ pass ☐ fail |
| Seam parts | ~0.4 s first Part click or **Show seams**, then cached | | ☐ pass ☐ fail |
| Mesh weld | ~0.4 s on the first stencil build, then cached | | ☐ pass ☐ fail |
| Stencil build | 0.7–1.5 s (plus each widening attempt) | | ☐ pass ☐ fail |
| STL export | ~0.1 s per 100k triangles | | ☐ pass ☐ fail |

**Guide** [How it works](help.html#howitworks)
**Automated** not automated — needs a browser; the geometry-side costs are measured in the
suites' own output.
**Result** ☐ pass ☐ fail — notes:

#### N3 · Documented limits behave as documented

**Steps**
1. Confirm each limit below — these are *expected*, not defects (see the next section).

**Expected**

| Limit | How to see it | Expected | Result |
| --- | --- | --- | --- |
| Resolution comes from the mesh | Turn on **Wireframe** and select on a coarse mesh | The window edge is blocky, no finer than the triangles | ☐ pass ☐ fail |
| The window insets | Select a patch, build, and compare the window with the selection | Mask material covers a thin sliver of what you selected | ☐ pass ☐ fail |
| Clearance at creases is zero | Build at 0.3 mm standoff and read the minimum | The minimum barely improves; a few spots still touch | ☐ pass ☐ fail |
| Undercuts | Build a shell that wraps the whole figure | It builds, but cannot be placed on a rigid print | ☐ pass ☐ fail |
| One piece is preferred, not guaranteed | Select two far-apart areas with widening off | More than one shell, reported in plain words | ☐ pass ☐ fail |
| A click selects the panel it hits | Click two pixels off a thin panel | The big panel is selected and the list appears (P10) | ☐ pass ☐ fail |
| A hidden panel cannot be clicked | Aim at a detail that is behind another surface | The panel in front is selected; the hidden one is only reachable from the list (P10) | ☐ pass ☐ fail |

**Guide** [How it works](help.html#howitworks)
**Automated** `test/stencil.test.mjs` (the "must fail" cases — nothing selected, everything
selected, a dot smaller than the inlay) and `test/parts.test.mjs` (panel sizes, the near-miss
list, and that every raycast reports the triangle under the cursor in the model's face order,
which is the order the panels are cut in).
**Result** ☐ pass ☐ fail — notes:

#### N4 · The automated suites

**Steps**
1. `npm ci` (only needed to restore the vendored library copies; the app itself needs no
   install), then `npm test`.
2. Confirm the exit status is 0 and read the per-suite summaries.

**Expected** Nine suites pass: `stencil.test.mjs` (137 checks), `app-path.test.mjs`,
`selection.test.mjs`, `parts.test.mjs`, `cleanup.test.mjs`, `boxselect.test.mjs`,
`select.test.mjs`, `ui-wiring.test.mjs` and `help.test.mjs` (224 checks).
The last one proves this documentation cannot drift from the app: a new control or a new suite
that is not documented fails the build.
**Guide** [How it is verified](help.html#tests)
**Automated** this *is* the automated half of this document — see the note at the top.
**Result** ☐ pass ☐ fail — notes:

---

# Do not log these as failures

They are documented behaviour, they are geometry rather than bugs, and they are all explained in
the guide. Record them under N3 instead:

- A mask that wraps a figure with arms or a wider head **cannot be placed** on a rigid print. The
  app guarantees and reports a *whole* part; whether it is placeable is a judgement about your
  model.
- A few inner-face spots sit **on the surface** at any standoff, wherever a crease is sharper
  than the averaged vertex normal can follow. 0.15–0.25 mm keeps a real gap over ~99% of the
  part.
- A **sliver of the selected area stays covered** by mask material: the window edge is smoothed
  and inset on purpose, and **Window inlay** is the deliberate part of that overlap.
- A **click on a thin panel can select the big panel behind it** — the ray really did hit the
  big panel, so that is the panel you get. The panel list and `Alt`-click are the workaround; a
  two-pixel target cannot be made easy to hit. A panel that is *hidden behind* the surface is
  only reachable from that list.
- **A rectangle leaves the surface facing away** alone, and says so in the status bar. A screen
  rectangle covers the back of a closed figure as well, and taking it would be a surprise; with
  the figure turned, the same rectangle takes the other surface instead.
- A **hidden model** still counts, still exports and still becomes part of the window — hiding the
  base model or the tint is view-only, and **Ghost shell** never changes a selection.
- The stencil is **not** part of the undo history. Selecting more after a build leaves the old part
  in hand; the panel says so and asks you to build again.
- **Undo stops after 40 steps**, and undoing past the cap does nothing rather than erroring.

# Sign-off

| Field | Value |
| --- | --- |
| Build / commit | |
| Tester | |
| Date | |
| Browser and version | |
| Machine (CPU / GPU) | |
| Model(s) used | |
| Environment setup steps followed | ☐ yes ☐ no — notes: |
| Items run | ___ of 64 |
| Passes / failures / blocked | ___ / ___ / ___ |
| Blocking failures | |
| Notes | |

**Failure report template** — one per failed item:

```
Item:            P10
Model:           Sprunki Mercuy.stl (422,658 triangles)
Steps:           clicked the left eyebrow, 2 px inside its edge
Expected:        eyebrow panel selected
Observed:        the 43% panel selected; the eyebrow stayed bare
Status bar:      Selected part 1 of 26 — 181,000 faces (43.0% of the mesh), 181,000 faces added to
the selection (181,000 of 422,658 selected in all, seams at 8°)
Console:         (first error, if any)
Reproduced:      yes / no / intermittent
```
