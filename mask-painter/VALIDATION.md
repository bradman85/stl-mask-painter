# STL Mask Painter — validation document

Every feature the app exposes, with the steps to test it and what a correct result looks like.
It is derived from the on-screen guide (`help.html`), which explains what each control is *for*;
this document is about proving it works.

- **Running the checks:** `npm test` proves the geometry, the editing model, the segmentation,
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
4. Between sections, **reload the page** to start from a clean mask. Several checks are about
   *what changed*, which needs a known starting point.
5. Timings below come from a desktop-class machine; treat them as orders of magnitude, not
   budgets.

**Test data**

| Data | Where it comes from |
| --- | --- |
| The bundled figure | **Load example model** |
| A tiny valid mask | The *Ready to import* block in [Export / import](help.html#mask-json) — 4 painted vertices on a 36-vertex model |
| A deliberately wrong mask | The same file, loaded while the bundled figure is open (its `vertexCount` is 36, the figure has 1,267,974) |
| A non-STL file | Any `.png` or `.json` — used to prove drag & drop ignores it |

## Coverage matrix

| Guide section | Items |
| --- | --- |
| [Getting started](help.html#start) | L1–L8, U1–U2 |
| [Top bar](help.html#topbar) | L1–L8 |
| [Features](help.html#features) | F1–F6 |
| [Paint](help.html#paint) | P1–P19 |
| [Cleaning up the model](help.html#cleanup) | P19 (shells, face picking, removal, the bed) |
| [Mask](help.html#mask) | M1–M9 |
| [Paint stencil](help.html#stencil) | S1–S13 (S13 covers the multi-piece export) |
| [Model & view](help.html#view) | V1–V5 |
| [Export / import](help.html#export) | X1–X11 |
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
line reads `no model loaded`; the Mask panel reads `No model loaded.`; the stencil panel reads
`No stencil built yet.` with **Build stencil** and **Export stencil STL** disabled; the status bar
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
mask is created — the Mask panel's paint stats read `0 of 1,267,974 vertices painted (0%)`. Load
takes roughly 0.3 s, almost all of it the pick acceleration structure (BVH). The console has no
errors.
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
1. Paint something so the viewport has visible colour.
2. Turn on the stencil **Preview** and **Show seams** if you want them in the image.
3. Press **Screenshot**.

**Expected** A PNG downloads named `<model>-mask-view.png`, showing the viewport exactly as
rendered — paint overlay, preview and seam lines included.
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
1. Load the example model and paint the eyes.
2. Load a different STL (any other file will do).

**Expected** The painting is gone and the stats read 0 painted: the mask is per vertex and only
means anything for the model it was painted on.
**Guide** [Top bar](help.html#topbar)
**Automated** `test/ui-wiring.test.mjs` (the load path builds a fresh `MaskLayer`).
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

# B. Features (the palette)

#### F1 · Add a feature

**Steps**
1. Pick a colour in the swatch, type a name, press **Enter** (or **Add**).
2. Add a second one.

**Expected** Each feature is appended with the next free id (1, 2, …; id 0 is reserved for
"unpainted") and becomes the current feature, so the next brush stroke uses it. Ids are never
reused inside a session — an exported JSON keeps pointing at the right features.
**Guide** [Features](help.html#features)
**Automated** `test/painting.test.mjs` (feature list and ids), `test/help.test.mjs` (the default
palette quoted in the guide matches the code).
**Result** ☐ pass ☐ fail — notes:

#### F2 · Empty name

**Steps**
1. Leave the name box empty and add a feature.

**Expected** It is called `Feature N`.
**Guide** [Features](help.html#features)
**Automated** `test/help.test.mjs` (the importer's fallback name is the documented one).
**Result** ☐ pass ☐ fail — notes:

#### F3 · Selecting and counting

**Steps**
1. Paint something with feature 1, then something with feature 2.
2. Click the feature rows, then press `1`…`9`.

**Expected** The clicked/pressed feature becomes current (the tools paint with it), and each row
shows how many vertices currently carry it. Those counts update as you paint, erase and clear.
**Guide** [Features](help.html#features)
**Automated** `test/painting.test.mjs`, `test/parts.test.mjs` (per-feature vertex counts).
**Result** ☐ pass ☐ fail — notes:

#### F4 · Hide and show a feature

**Steps**
1. Paint two overlapping features.
2. Press the `◉` / `◌` button on one of them.
3. Build a stencil while one feature is hidden.

**Expected** Only the display changes: the row goes dim, the feature's paint disappears from the
viewport, and *nothing else* changes — the paint count, the exported files and the stencil
window are all unaffected. The built stencil is identical with the feature hidden or shown.
**Guide** [Features](help.html#features)
**Automated** `test/painting.test.mjs` — hiding is not an edit and does not touch the ids; the
colour buffer test pins alpha 0 for hidden vertices.
**Result** ☐ pass ☐ fail — notes:

#### F5 · Remove a feature

**Steps**
1. Paint a feature, then press its `✕`.
2. `Ctrl`+`Z`.

**Expected** It asks first when the feature has paint. Confirming removes the feature *and*
clears its paint in one undo step; undo brings both back (provided nothing else was painted in
between). An unpainted feature is removed without asking.
**Guide** [Features](help.html#features)
**Automated** `test/painting.test.mjs` (clear-clear paths and their undo/redo).
**Result** ☐ pass ☐ fail — notes:

#### F6 · Features do not change the window

**Steps**
1. Paint one area with feature 1 and a neighbouring area with feature 2.
2. Build the stencil.

**Expected** The window is everything painted, whatever feature it belongs to. Two features
painted side by side become a single window joined at the seam. Features exist to see, count and
clear areas separately — nothing more.
**Guide** [Features](help.html#features)
**Automated** `test/stencil.test.mjs` — "two far-apart features" case; `test/parts.test.mjs`
(two panels composed with `Shift`-click build one window).
**Result** ☐ pass ☐ fail — notes:

---

# C. Paint

#### P1 · Brush stroke is one edit

**Steps**
1. Press `B`. Drag a long stroke across the torso.
2. Note the painted count in the Mask panel.
3. Press **Undo**, then **Redo**.

**Expected** The whole drag, however many stamps it contained, is one undo step. Undo removes
all of it (the count returns to what it was before the stroke); redo restores the identical
vertices, not a re-painted approximation.
**Guide** [Paint](help.html#paint)
**Automated** `test/painting.test.mjs` — a 9-stamp stroke paints 10,127 vertices as one history
step; undo leaves zero difference and redo restores the same ids.
**Result** ☐ pass ☐ fail — notes:

#### P2 · Fast strokes stay smooth

**Steps**
1. With the brush, drag quickly across a large area.

**Expected** A continuous painted band with no gaps and no blotchy over-painting. Stamps are
sub-sampled by their on-screen size while dragging.
**Guide** [Paint](help.html#paint-tools)
**Automated** `test/painting.test.mjs` (the stroke path is the app's own sampler).
**Result** ☐ pass ☐ fail — notes:

#### P3 · Brush radius

**Steps**
1. Move the **Brush radius** slider; watch the ring in the viewport.
2. Press `[` and `]` several times.

**Expected** The ring grows/shrinks with the slider (0.2–16 units, one step 0.1) and the `[`/`]`
keys nudge it by 0.4. On load the radius is derived from the model's diagonal — 3.2 units on
the bundled figure.
**Guide** [Paint](help.html#paint-radius)
**Automated** `test/ui-wiring.test.mjs` (the slider and the keys are wired to the same state).
**Result** ☐ pass ☐ fail — notes:

#### P4 · The brush can reach the far side of a thin part

**Steps**
1. Zoom onto a thin area (an ear, a fin) and paint with a wide brush from one side.
2. Orbit and look at the other side.

**Expected** Paint appears on the far side too — a brush stamp is a sphere. This is documented
behaviour, not a defect: use **Part** or **Region fill** when it matters.
**Guide** [Paint](help.html#paint-tools)
**Automated** `test/painting.test.mjs` (`paintSphere` semantics).
**Result** ☐ pass ☐ fail — notes:

#### P5 · Mirror across X

**Steps**
1. Turn on **Mirror across X plane**.
2. Paint one eye with the brush; then fill one cheek; then click one foot with **Part**.
3. Turn it off and paint again.

**Expected** The mirrored stroke/fill/panel appears about the plane `x =` the number beside it
(default: the model's centre). All three tools honour it. With it off, only the painted side
changes.
**Guide** [Paint](help.html#paint-radius)
**Automated** `test/parts.test.mjs` and `test/painting.test.mjs` use the same mirrored point
path; the asymmetry caveat (the fill's mirrored run has no seed normal) is documented.
**Result** ☐ pass ☐ fail — notes:

#### P6 · Region fill stops at seams

**Steps**
1. Press `F`, click a large smooth area (a shirt front).
2. Then click right on a crease and lower the **Seam angle**.

**Expected** The fill covers the connected surface and stops where the surface turns more than
the seam angle — it does not run over the whole model. Lowering the angle makes the filled area
smaller; raising it lets the fill spread further.
**Guide** [Paint](help.html#paint-tools)
**Automated** `test/parts.test.mjs` (the same crease rule drives segmentation).
**Result** ☐ pass ☐ fail — notes:

#### P7 · Region fill budget

**Steps**
1. Set **Max vertices** to its minimum (1000).
2. Fill a large area.

**Expected** The fill stops at the budget and the status bar says it was truncated rather than
silently under-filling.
**Guide** [Paint](help.html#paint-radius)
**Automated** `test/ui-wiring.test.mjs` (the field is wired); truncation message is UI.
**Result** ☐ pass ☐ fail — notes:

#### P8 · Part click paints a whole panel

**Steps**
1. Press `P`, click the figure's head.

**Expected** The whole seam-bounded panel under the cursor is painted with the current feature,
in one undo step. Nothing else changes. "Under the cursor" is literal: the ray is resolved to the
triangle the cursor is on, in the model's own face order (the order the panels are cut in), not
the pick acceleration structure's own ordering — compare the panel named in the status bar with
the one the seams around the click suggest. On the bundled model at the default 8° seam angle
the biggest panel is 42.8% of the mesh, so a click that lands on a large panel is still a large
part of the figure — the panel list under the seam controls (P10) is how you get a detail that
is behind the surface instead.
**Guide** [Paint → Seam parts](help.html#paint-parts)
**Automated** `test/parts.test.mjs` — a clicked panel paints exactly its vertices (59,136 in
that run) as one undo step, and a real raycast through a real camera, sampled over the whole
viewport, reports the triangle under the cursor every time (1,560/1,560 hits) while the picker's
raw BVH index fails that test on all of them. `test/ui-wiring.test.mjs` pins the translation and
that the mesh order is read before the BVH is built.
**Result** ☐ pass ☐ fail — notes:

#### P9 · Part modifiers

**Steps**
1. With **Part**, click one panel, then `Shift`-click another, then `Alt`-click (or
   `Ctrl`-click) one of them.

**Expected** A plain click *replaces* the current feature's paint with that panel;
`Shift`-click adds a second panel; `Alt`/`Ctrl`-click removes one. These clicks are not treated
as "not painting" — Part is the one tool that reacts to a modifier click.
**Guide** [Paint → Seam parts](help.html#paint-parts)
**Automated** `test/ui-wiring.test.mjs` — the modifier guard is pinned by name and exempts the
Part tool, so an Alt-click cannot be swallowed before the tool sees it.
**Result** ☐ pass ☐ fail — notes:

#### P10 · The panel list

**Steps**
1. Click a thin detail (an eyebrow), a couple of pixels off.
2. Read the list that appears under the seam controls.
3. Click a row in the list.
4. Press **Hide this list**, then click again elsewhere.

**Expected** The list names the panels with surface within a brush radius of the click, nearest
first, each with its face count, its percentage of the mesh and its distance. The panel you
actually hit is excluded. It also finds panels *hidden behind* the surface you hit. Clicking a
row selects that panel with the current feature, exactly as if you had hit it. The list is
hidden until a Part click and is dismissible.
**Guide** [Paint → The panel list](help.html#paint-candidates)
**Automated** `test/parts.test.mjs` — the query on a cube with known distances (0.62 to the four
nearer faces, 1.03 to the opposite one; a 0.7 radius returns exactly those four, nearest first),
and on the real model (the opening panel is 42.8%, the smallest 0.021%, the thin panel a
near-miss lands on is in the list). `test/ui-wiring.test.mjs` checks the wiring.
**Result** ☐ pass ☐ fail — notes:

#### P11 · Seam angle and Show seams

**Steps**
1. Turn on **Show seams** — the first time, expect a short pause.
2. Move the **Seam angle** slider from 8° to 25°, watching the line under it.
3. Move it back to 8° (the default — the **Portrait** preset lights up again).

**Expected** Yellow seam lines appear where a click will stop. The hint line reports how many
parts that angle produces, how many are worth clicking (1,000+ faces) and how many slivers were
merged. Roughly: 5° → 35 parts (largest 21%), 8° → 26 (43%), 12° → 21 (48%), 25° → 14 (52%),
35° → 12 — too coarse to click. Segmentation takes about 0.4 s and is cached per model and
angle, so returning to 8° is instant.
**Guide** [Paint → Seam parts](help.html#paint-parts)
**Automated** `test/parts.test.mjs` — every face lands in exactly one part, sizes match, the
largest comes first, the default 8° gives 26 parts with 10 of them ≥ 5,000 faces, and the
sliver merge turns 7,550 raw parts into 26.
**Result** ☐ pass ☐ fail — notes:

#### P12 · Seam angle presets

**Steps**
1. With the model loaded, press **Face details 5°** under the seam slider.
2. Watch the slider, the number beside **Seam angle**, the status bar and the button row.
3. With **Part**, click an eye, then an eyebrow: each should be its own panel.
4. Press **Portrait 8°**, then **Body parts 12°**, then **Broad shapes 25°**, clicking the same
detail after each.
5. Drag the slider to 15° by hand.

**Expected** Each press moves the slider, re-cuts the model and lights up that button only. The
status bar reports the cut, e.g. `Face details: seams at 5° cut the model into 35 panels, the
biggest 87,175 faces (21%) — click one with the Part tool.` After **Face details** the same click
selects a much smaller panel than after **Broad shapes**; at **Body parts** (12°) an eyebrow
click selects the 48% panel and the status bar says so and names the smaller panel instead.
Dragging the slider by hand dims all four buttons, and the four angles match the measured table
in the guide.
**Guide** [Paint → Seam parts](help.html#paint-parts)
**Automated** `test/help.test.mjs` checks the preset buttons, the `SEAM_PRESETS` list in
`js/main.js` and the guide's table all name the same four labels and angles, and that the
default angle agrees in `js/parts.js`, the slider markup and the guide. `test/ui-wiring.test.mjs`
checks the buttons call `setSeamAngle`.
**Result** ☐ pass ☐ fail — notes:

#### P13 · Pick previews before the click

**Steps**
1. Press `I`. Move the cursor over a painted area, then over bare geometry, then off the model.

**Expected** The ring takes the colour of the feature under the cursor; over bare geometry it is
grey. The cursor line reads `Pick: Eyes (click to paint with it)` or `Pick: nothing painted`.
No click has happened yet, and nothing has been painted.
**Guide** [Paint → Pick](help.html#paint-tools)
**Automated** `test/ui-wiring.test.mjs` — the hover preview and the click call the same function,
so the ring cannot promise one feature and the click deliver another.
**Result** ☐ pass ☐ fail — notes:

#### P14 · Pick click semantics

**Steps**
1. Paint an eye with feature 3. Switch to feature 1. Press `I`, click the eye.
2. Press `I` again and `Shift`-click two different painted areas in a row.
3. Press `I` and click bare, unpainted geometry; then click off the model entirely.

**Expected** The click makes the picked feature current and the status bar names it with its
vertex count (`Picked "Eyes" (3,892 vertices)…`), so picking the feature you already had is still
visible. Control **returns to the paint tool you were using**, so your next drag paints. With
`Shift` you stay on Pick. The empty cases are distinguished: *nothing painted here* (that
feature is painted elsewhere) versus *nothing painted anywhere nearby*, and a click that misses
the model says so. Picking is not an edit — it adds nothing to the undo history.
**Guide** [Paint → Pick](help.html#paint-tools)
**Automated** `test/painting.test.mjs` — the vote finds the feature the brush just painted
(3,307 vertices voting), reports nothing off the model and nothing away from the paint, prefers
the patch painted on top, falls back when it is erased, and agrees with **Clear all**.
**Result** ☐ pass ☐ fail — notes:

#### P15 · Erase

**Steps**
1. Paint a long stroke.
2. Press `E` and drag across its middle.
3. `Ctrl`+`Z`, then `Ctrl`+`Shift`+`Z`.

**Expected** Erase paints "unpainted", so only the swept part goes; the rest of the stroke
survives. Undo restores exactly the erased vertices; redo erases them again.
**Guide** [Paint → Tools](help.html#paint-tools)
**Automated** `test/painting.test.mjs` — erasing 4 stamps over a 10,127-vertex stroke leaves
4,633; undo restores the erased vertices, redo removes them again.
**Result** ☐ pass ☐ fail — notes:

#### P16 · Undo, redo and the history cap

**Steps**
1. Perform a stroke, a fill, a Part click, a **Clear feature**, a **Clear all** and an
   **Invert mask**, undoing each immediately.
2. Undo a **Clear all** and press **Redo**.
3. Make more than 40 edits and keep pressing **Undo**.

**Expected** Each action is exactly one step and comes back unchanged. Redo after a clear or an
invert *reapplies the change* rather than restoring the state before it. History holds 40 steps;
undoing past the cap simply stops. Painting something new clears the redo stack.
**Guide** [Paint](help.html#paint-radius)
**Automated** `test/painting.test.mjs` — undo/redo of clear, clear-feature and invert, plus the
redo-after-snapshot paths; the cap is exercised.
**Result** ☐ pass ☐ fail — notes:

#### P17 · Navigate

**Steps**
1. Press **Navigate: off** so it reads **Navigate: on** and left-drag in the viewport.
2. Turn it off again and hold `Space` while left-dragging.
3. Release `Space`.

**Expected** With Navigate on, the left button orbits any tool. With it off, holding `Space`
orbits without leaving the paint tool, and releasing `Space` returns to painting.
**Guide** [Paint](help.html#paint-radius)
**Automated** `test/ui-wiring.test.mjs` (the toggle is wired to the same navigation state).
**Result** ☐ pass ☐ fail — notes:

#### P18 · Box select — the rubber band

**Steps**
1. Reload, load the example model, keep the default feature, press **X** (or the **Box select**
   button) and drag a rectangle across the middle of the body.
2. Read the status bar, then press **Undo** and **Ctrl+Shift+Z**.
3. Drag a rectangle over the *head* only, from the Front view, and turn the model to the Back to
   see what was taken.
4. Tick **Mirror across X plane**, drag a box over one side of the face, and look at the other
   side.
5. Hold `Alt` (or `Ctrl`) and drag a box over part of what you just painted.
6. Start a drag and press `Esc` before releasing. Then drag a rectangle over the empty background.
7. Orbit so the figure is seen from above, and drag the *same* rectangle as in step 1.

**Expected** Every vertex under the rectangle that faces the camera turns the current feature's
colour, in one undo step — `Ctrl+Z` takes the whole box back and redo puts it back exactly. The
status bar names the numbers: `Box select: 433,903 vertices painted as “Eyes” — 433,903 of the
930,758 in the rectangle face the camera (496,855 face away and were left alone).` The vertices
that face away are **not** painted (step 3: the back of the head stays bare when the box covers the
face), because a screen rectangle covers the far side of a closed part too.
With mirroring on (step 4) the box is taken again on the other side of the plane, and the status
bar adds `plus N mirrored across X`; `Alt`/`Ctrl`-drag (step 5) **releases** paint under the
rectangle instead; `Esc` (step 6) cancels a drag before it is released and a box over the background
reports `nothing under the rectangle — drag it over the model` rather than looking dead. Step 7 is
the point of a screen-space selection: the same rectangle over a different camera angle takes
different vertices, and the status counts change with it.
**Guide** [Paint → Box select](help.html#paint-box)
**Automated** `test/boxselect.test.mjs` — the transform and the facing rule on a vertex cloud whose
screen positions are computed by three.js itself (12 rectangles, vertex for vertex), the composed
matrix against three.js' own multiply, the behind-the-camera and mirrored-away cases, and on the
bundled figure through the app's own camera and model group: 433,903 of 930,758 under a
middle-of-the-body box in 29 ms, every sampled vertex three.js puts inside it taken, every taken
vertex projecting inside it, and the selection painting the mask as one undo step with undo and
redo restoring the exact count. `test/ui-wiring.test.mjs` pins the tool, the key, the overlay, the
drag path, the indices handed to the inverse transform, the modifier exemption and the status
wording — the browser half (drawing, releasing, hovering) is what this item tests by hand.
**Result** ☐ pass ☐ fail — notes:

---

#### P19 · Cleaning up the model — the models in the file, and the bed

**Steps**
1. Reload and load an STL that holds more than one model (a figure plus a base, or two figures
   exported together). If you only have single-model files, load the example model twice into one
   file with any tool that appends triangles — or load the example and read the "one model" half
   of this item.
2. Press **S** (or the **Select models** button) and wait for the weld. Read the list under the
   panel heading, then click **Count models** and read the status bar.
3. Click the model you want to keep, then **Select none**. Now click **Select all** and click the
   model you want to keep a second time.
4. Press **Remove picked** once and read the status bar; press it again within four seconds.
5. Look at the grid, the model line and the Mask panel's paint stats.
6. Press **Restore removed**.
7. Press **Shift+S** (or the **Select faces** button), hover over the model, then click a face,
   Shift-click two more and Alt-click one off. Check the white tint under the cursor and the yellow
   tint of the pick.
8. Turn on **Show seams** with the pick still on faces, and remove a handful of faces from a flat
   area (leave more than a few hundred faces in the model).
9. Load a model, paint something, pick a model and remove it, then press **Ctrl+Z** twice.

**Expected** Step 1–2: the panel lists every model in the file, biggest first, each with its face
count, its share of the file and its own size, and the status bar reports the same numbers — this
is where a file with a hidden second model is discovered. Step 3: a click picks the model under the
cursor (a second click unpicks it), **Select all** then picks the whole file and clicking a model
again takes it back off the pick, which is the point of selecting everything. Only one of the two
buttons is lit at a time, and pressing **Select faces** lights that one instead and moves the pick
to single triangles. Step 4: the button
reads **Click again to remove** for four seconds and the removal goes ahead on the second click —
the model disappears from the viewport, the status bar reports the faces taken out and
`The bed is under the surviving model's lowest point (0.00)`, and the survivors are re-measured and
re-framed. Step 5: the surviving model stands **on** the grid — if it was previously standing on
top of the model you removed, it now drops onto the plate, and the grid is drawn on its feet rather
than a fraction of its height below them (the reported `2% of the model's height` gap is gone). The
painted vertices are still painted. Step 6: the removed model comes back, still unpainted, and the
bed goes back under the lowest point of everything. Step 7: the face under the cursor is **tinted
white** before the click and the picked faces are **tinted yellow** — a single picked face is
visible at a glance, which is what the edges-only version got wrong (it showed three hairlines that
z-fight with the surface they lie on, so a working pick looked like a dead tool) — Shift adds and
Alt takes one off, and the status bar counts the pick face by face. On a one-model file nothing is
tinted while hovering in the models scope, and the panel says why. Step 8: the removal is exact — the region you
picked is gone, the rest of the surface is untouched. Step 9: the paint stays where it was painted
(after the removal the painted vertices are still on the same part of the surface) and **Ctrl+Z**
still undoes the paint, because the history was renumbered with the geometry.
**Guide** [Cleaning up the model](help.html#cleanup) (and [Model & view](help.html#view) for the bed
and centring)
**Automated** `test/select.test.mjs` — the shell rule on a soup whose models are known by
construction (two boxes are two models, a shared corner is not a shared surface, a degenerate face
joins nothing, bounds and sizes per model), the filter and the corner map triangle for triangle,
the paint carried across a removal corner by corner, the undo history renumbered and still undoing
what it used to, the highlight of one picked face being a filled triangle (the visible half of the
fix above — edges alone were invisible), the whole highlight path executed for real — drawn,
replaced with its geometry and material freed, cleared, and refused above the limit (this is the
path that used to throw on every load, see L8) — and a pick too big to draw being refused rather
than drawn, and on the bundled figure: a copy written 30 units below it lifts the figure off
the bed by 30 (the reported bug, measured), removing it puts the lowest point back at 0, and the bed
is drawn on the model's own lowest point instead of 2% of its height below it.
`test/ui-wiring.test.mjs` pins the tool, its key, the panel, the buttons, the scope menu, the
modifier exemption and the status wording; `test/help.test.mjs` keeps this item and the guide in
step with the app. The browser half — clicking, the outlines, the loading messages — is what this
item tests by hand.
**Result** ☐ pass ☐ fail — notes:

---

# D. Mask

#### M1 · Mask opacity

**Steps**
1. Paint something solid-coloured.
2. Drag **Mask opacity** from 100% down to 0% and back.

**Expected** The paint fades and lets the model's own shading through as the value drops — the
layer's colours never change, only how strongly the overlay is blended. At 100% (the default)
the paint hides the model under it.
**Guide** [Mask](help.html#mask)
**Automated** `test/painting.test.mjs` (the colour buffer itself is unchanged by opacity).
**Result** ☐ pass ☐ fail — notes:

#### M2 · The view toggles

**Steps**
1. Paint something, then toggle each control below in turn.
2. After each, check the Mask panel's paint stats line.

**Expected**

| Control | Expected result | Result |
| --- | --- | --- |
| **Show mask layer** | The whole paint layer disappears and returns. The stats line does not change. | ☐ pass ☐ fail |
| **Ghost shell (dim unpainted area)** | The unpainted surface becomes a faint translucent shell, so painted regions stand out in context. Mask and exports unchanged. | ☐ pass ☐ fail |
| **Show base model** | The original mesh shows/hides. Off is the cleanest way to look at the mask alone (keep the grid on for scale). | ☐ pass ☐ fail |
| **Show ground grid** | The ground plane appears/disappears; it is sized from the model's bounding box, which makes window sizes easy to judge. | ☐ pass ☐ fail |
| **Wireframe** | The model draws as triangles — the quickest way to see whether the mesh is fine enough for the mask edge you want. | ☐ pass ☐ fail |

**Guide** [Mask](help.html#mask)
**Automated** `test/painting.test.mjs` — the colour buffer's alpha is what these toggles change,
and the tests pin painted = 1, hidden/cleared = 0.
**Result** ☐ pass ☐ fail — notes:

#### M3 · Hide all paint

**Steps**
1. With paint on the model, press **Hide all paint**, then press it again.
2. Clear the mask and press it once more.

**Expected** The first click hides every feature at once; the second shows them again (it
checks whether anything is visible). With nothing painted it says so instead of doing nothing.
A view setting: the mask is untouched.
**Guide** [Mask](help.html#mask)
**Automated** `test/ui-wiring.test.mjs` (wiring and the action's existence).
**Result** ☐ pass ☐ fail — notes:

#### M4 · Invert mask

**Steps**
1. Paint one eye with **Part**, note the painted count.
2. Press **Invert mask** (or `Shift`+`I`).
3. `Ctrl`+`Z`, then `Ctrl`+`Shift`+`Z`.

**Expected** Every painted vertex is released and every unpainted vertex takes the *current*
feature: the two counts mirror each other exactly (before: N painted of M; after: M−N painted).
One undo step; redo re-applies the inversion. A multi-feature mask collapses onto the current
feature — this is a single-selection invert, as the guide says.
**Guide** [Mask](help.html#mask)
**Automated** `test/painting.test.mjs` — invert in both directions with exactly mirrored counts,
its undo and its redo.
**Result** ☐ pass ☐ fail — notes:

#### M5 · Clear feature

**Steps**
1. Paint two features.
2. Select one and press **Clear feature**.
3. Select the other and hover the button before clicking it.

**Expected** Only the selected feature's paint goes. Hovering shows a tooltip with how many
vertices it would clear; with nothing painted for that feature the button is disabled and the
click reports `Nothing painted for “Eyes” — nothing to clear`. One undo step.
**Guide** [Mask](help.html#mask)
**Automated** `test/painting.test.mjs` (clear-feature restores the exact previous ids).
**Result** ☐ pass ☐ fail — notes:

#### M6 · Clear all

**Steps**
1. Paint several features.
2. Press **Clear all** once and pause; press it again inside the four-second window. Do it with a
   built stencil in hand as well as without one.
3. `Ctrl`+`Z`.

**Expected** The first click arms the button (**Click again to clear**); the second wipes the
whole mask and the status bar reports the vertex count (`Mask cleared (4,633 vertices). Ctrl+Z
brings it back.`). It never uses a browser confirm dialog — those are silently blocked inside
some embedded browser views — so an armed-then-abandoned click just disarms. Undo restores the
exact previous mask. With a built stencil in hand the same message adds that the shell is still
in the viewport and names **Discard stencil** (S12) — clearing the paint does not clear a build.
**Guide** [Mask](help.html#mask)
**Automated** `test/painting.test.mjs` — Clear all is one undoable step and redo re-clears.
**Result** ☐ pass ☐ fail — notes:

#### M7 · Paint stats

**Steps**
1. Paint, erase, clear and invert, watching the bottom line of the Mask panel.

**Expected** It reads `N of M vertices painted (x.x% of the mask)`, where M is the model's vertex
count (three per triangle — 1,267,974 for the bundled model). These are the numbers the mask
JSON and the stencil build start from, so it must track every edit.
**Guide** [Mask](help.html#mask)
**Automated** `test/painting.test.mjs`, `test/app-path.test.mjs` (the same counts are asserted
in the exported JSON).
**Result** ☐ pass ☐ fail — notes:

#### M8 · Trim windows out of the mask

**Steps**
1. Load the example model and paint a generous blob on the chest with the brush (or one panel with
   **Part**).
2. Add two stray dabs: drop the brush radius and click twice well away from the blob — once on a
   limb, once near the head.
3. Press **List windows** and read the status bar.
4. Press **Trim windows**, then `Ctrl`+`Z`, then `Ctrl`+`Shift`+`Z`, then **Trim windows** again.

**Expected** The list reports how many painted windows there are (blob + 2 dabs = 3), the size of
each, and how many a trim would release at the threshold in the panel — 2% of the model's
diagonal by default, about 2.6 units on the bundled figure, where the dabs are ~1.9 units across
and the blob ~27. The trim releases exactly the dabs: the blob keeps its own colour and counts, the
status bar names how many windows went, how many vertices were released, what share of the mask
that was and how many windows are left, and the paint stats drop by exactly that count. One undo
step — `Ctrl`+`Z` puts every released vertex back and `Ctrl`+`Shift`+`Z` trims again — and the
second trim reports that there is nothing to trim. Set the threshold to 99 and trim: it is now
honoured (it used to be cut to 50 in silence), and with the dabs gone the message names the
percentage that would release the next window rather than reporting a bare zero. Set 100 and trim
in a fresh mask with the blob and the dabs: every window but the largest goes and the status bar
says the largest was spared, so a threshold set too high can shrink a mask to its main region but
never wipe it out. With a built stencil in hand the message also says the shell is now stale —
build again to match the trimmed mask.
**Guide** [Mask](help.html#mask)
**Automated** `test/cleanup.test.mjs` — islands on a made-up mesh with a known answer and on the
bundled figure, the released set being exactly the dabs, one undo step with undo and redo, the
idempotent second trim, the largest-island rule and the 0–100 threshold range.
**Result** ☐ pass ☐ fail — notes:

#### M9 · Remove one window by name (the case a threshold cannot reach)

**Steps**
1. Reload the page, load the example model, and press **Part** (`P`). Click a panel on the face or
   the chest, then `Shift`-click the panel **next to it** — two selections, one window.
2. Press **List windows**. Read the header and the rows.
3. Press **Remove** on that window, then `Ctrl`+`Z`.
4. Press **List windows** again, then **Keep only** on a row, then `Ctrl`+`Z`.
5. With the list open, paint one more dab on the model, and look at the list.
6. In a fresh mask (reload), paint a blob and a small dab well apart, open **List windows** and
   press **Remove** on the **first** row (the big blob).

**Expected** Step 2 lists **one** window: panels that touch weld into a single painted region, so
the header says one painter window, its size in units and as a share of the model, the features it
is painted with (both), and it says in those words that no size threshold can split it — Step 4 of
M8 confirmed that the trim releases nothing here at 2%, 50% or 99%. Each row carries **Remove**
and **Keep only**; **Keep only** is disabled while there is a single window (there is nothing else
to release). **Remove** releases exactly that window — the status bar names the vertex count and
what share of the mask it was, the paint stats drop by that count, and **one** `Ctrl`+`Z` puts all
of it back. **Keep only** releases every other window and leaves the one named, also one undo
step. Step 5: the list is hidden the moment the mask changes — the rows name the vertices behind
them — and **List windows** rebuilds it from the mask in hand. Step 6: the blob goes and the dab
stays, which **Trim windows** can never do (it always keeps the largest), and the list shrinks to
the one remaining window with its numbers updated.
**Guide** [Mask](help.html#mask)
**Automated** `test/cleanup.test.mjs` — `maskWindows()` on a made-up mesh with known file-vertex
lists, per-window feature counts, both panels' vertices in one window on the bundled figure, the
removal of the largest window (which the trim's rule forbids) and Keep-only; `test/ui-wiring.test.mjs`
pins the wiring, the disabled button and the list being hidden as soon as the mask changes.
**Result** ☐ pass ☐ fail — notes:

---

# E. Paint stencil (STL)

#### S1 · Build the stencil

**Steps**
1. Paint one eye generously (a brush blob is fine).
2. Press **Build stencil**. Read the result panel.

**Expected** The build succeeds and reports: triangle count, how many pieces, **how many
windows** (one per separate painted area — paint the eye and the eyebrow as two areas and this
reads 2), the reach used, the wall thickness range achieved, the standoff, the bounding box,
whether it is watertight, the measured clearance, per-stage timings, and any warnings. First
build also welds the model (~0.4 s, cached); the build itself takes 0.7–1.5 s with the widening
option on. Warnings are not decoration — they are the conditions under which the part will not do
what you expect.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/stencil.test.mjs` — ten painted cases checked for two-triangles-per-edge,
outward winding, positive volume, an open window, mask material in the ring, one piece or an
honest warning. `test/app-path.test.mjs` builds with the panel's own defaults.
**Result** ☐ pass ☐ fail — notes:

#### S2 · Repainting after a build

**Steps**
1. Build a stencil.
2. Paint somewhere else without rebuilding — and then press **Export stencil STL**.

**Expected** The panel says the mask has been repainted since this was built and points at both
ways out — build again, or **Discard stencil** — because the app never hands you a silently
stale part. Repainting does not invalidate the geometry you already have. Pressing **Build
stencil** again reuses the cached weld, so the rebuild is fast. Exporting, on the other hand,
never writes a stale part: it builds again first (S9), so the file matches the mask on screen even
if you skip the manual build.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/app-path.test.mjs` (a second build reuses the cached topology).
**Result** ☐ pass ☐ fail — notes:

#### S3 · Preview draws under the paint

**Steps**
1. Build a stencil, leave **Preview** on.
2. Paint over part of the shell and clear another part, keeping the preview on.
3. Turn **Preview** off.

**Expected** The shell is semi-transparent and double-sided, and you can orbit around it. It
draws **under** the paint layer, so painted areas keep their exact colours and stay fully
visible; with the preview off you are looking at the mask alone.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/ui-wiring.test.mjs` pins the preview's render order relative to the paint
layer; `test/painting.test.mjs` pins painted alpha = 1, which is what makes the paint win.
**Result** ☐ pass ☐ fail — notes:

#### S4 · Reach

**Steps**
1. Build with **Reach** at a small value, then at a large one.

**Expected** Reach is how far the mask material extends from the window boundary *across the
surface*. Default is ~11.5% of the model's diagonal (15 mm on the bundled figure). Small reach
gives a band around the window; large reach wraps the figure. Triangle count and build time both
grow with it.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/stencil.test.mjs` (the band is measured from the paint field).
**Result** ☐ pass ☐ fail — notes:

#### S5 · Wall

**Steps**
1. Build at the default **Wall** (1.19 mm) and note the reported wall range.
2. Raise it and rebuild.

**Expected** The sheet away from the window is the wall thickness; the window edge is
deliberately thinner (~0.4 mm, half the wall) so a brush meets a thin lip instead of a wall and
paint cannot wick under it. The result panel reports the wall range it achieved.
**Guide** [Paint stencil](help.html#stencil)
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
**Guide** [Paint stencil → Clearance](help.html#stencil)
**Automated** `test/app-path.test.mjs` cross-checks the reported clearance against an
independent measurement of every inner vertex; `node test/clearance.mjs 0.1 0.2 0.3` prints the
distribution for any standoff.
**Result** ☐ pass ☐ fail — notes:

#### S7 · Window inlay

**Steps**
1. Build at the default **Window inlay** (0.35 mm), then rebuild with 0.

**Expected** Inlay is mask material overlapping the painted side of the boundary, so brush
strokes cannot creep under the window edge. Raising it makes the window slightly smaller than
the painted area and the edge more forgiving; 0 puts the window exactly on the painted boundary.
On top of the inlay there is always a small inset, because the distance field is smoothed so the
cut is not ragged.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/stencil.test.mjs` — the "narrow cover" and "dot smaller than the inlay"
cases cover both ends.
**Result** ☐ pass ☐ fail — notes:

#### S8 · Widen the reach until the mask is one piece

**Steps**
1. Paint one big panel with **Part** (about half the figure). Leave **Widen the reach…** on and
   build — note the time and the reported piece count and reach.
2. Turn it off and build again.

**Expected** With it on, the reach is grown automatically (up to six times, in 25% steps) until
the shell is one piece, or the limit is reached — this is the main reason a build can take
several seconds (up to ~6 builds, 8.8 s on the measured run). With it off you get a band around
the panel: one pass, far less material, much faster (about 110,676 triangles in 749 ms versus
644,876). If it still comes out in pieces, the panel says so.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/parts.test.mjs` — a part-sized window builds and the shell covers the band
around it (2525/2525 probes) with nothing on the far side (14186/14186 bare).
**Result** ☐ pass ☐ fail — notes:

#### S9 · Export stencil STL, and the save that must match the screen

**Steps**
1. Before building anything, look at **Export stencil STL**.
2. Build successfully, press it, and check the downloaded file's size.
3. Now Shift-click two more panels (or paint another area), leave the build alone, and press
   **Export stencil STL** again. Compare the two files: window count in the result panel, and the
   STL sizes.
4. Press **Build stencil** and export once more; compare with step 3.

**Expected** Disabled until a build has succeeded (and left disabled after a refused build). It
writes a binary STL named `<model>-paint-stencil.stl` whose size is exactly
`84 + 50 × triangles` bytes.
The second export must contain **every** window, not just the ones from the last build: the app
notices the paint has moved on, builds again first (the status bar says so while it works), and
reports `… N windows in M pieces — rebuilt from the current mask first…`. Its file is therefore
bigger than the first one and matches what step 4 writes. Before this was fixed the second export
was a byte-for-byte copy of the first, under a fresh timestamp — the reported bug. If that
rebuild is rejected, nothing is written and the status bar says why rather than leaving an older
part to be saved.
**Guide** [Paint stencil](help.html#stencil)
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
your printer expects Z up. The painted area is a hole, not a thin wall.
**Guide** [Paint stencil → Stencil STL](help.html#stl)
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
**Guide** [Paint stencil → Clearance](help.html#stencil)
**Automated** this *is* the tool; `test/app-path.test.mjs` checks the same numbers from the app
path.
**Result** ☐ pass ☐ fail — notes:

#### S12 · Discard a built stencil

**Steps**
1. Build a stencil, then press **Discard stencil**.
2. Clear the mask with **Clear all** (Mask panel) while a build is in hand, and read the status
   bar.

**Expected** Discarding removes the shell from the viewport, clears the result panel back to
"No stencil built yet.", disables **Export stencil STL** and says how many triangles went; the
button is only enabled while a build exists (a refused build, a discarded one and a fresh model
all leave it disabled). The mask keeps its paint — a build is a snapshot of the paint, so
keeping the shell after clearing is allowed, and the status bar says the shell is still there
and names this button. Before this control existed the only way to remove a shell was to load
the model again.
**Guide** [Paint stencil](help.html#stencil)
**Automated** `test/ui-wiring.test.mjs` — the button exists, its handler is `discardStencil`, and
that function clears the preview, drops the result and disables the export.
**Result** ☐ pass ☐ fail — notes:

#### S13 · The exported part sits on the bed — every piece of it

**Steps**
1. Load the example model, paint a face window (the eyes are the quickest), build the stencil and
   read the result panel's size line.
2. Leave **Sit the exported part on the bed (Z = 0)** ticked and press **Export stencil STL**.
   Read the status bar.
3. Open the file in a slicer: it must land flat on the plate with no dragging, and with no
   `Split to objects` needed.
4. Untick the box, export again, and compare the two files in the slicer next to the figure.
5. Tick it, load a model that already sits on its own Z 0 (or a **Z up** CAD part), and export:
   the status bar should say nothing moved.
6. The multi-piece case, which is the one the option used to leave hovering. Turn **Widen the
   reach until the mask is one piece** off, set **Reach (mm)** to 8, paint one window high on the
   figure (the head) and one low down (the feet), and build — the result panel must say
   **2 pieces**. Export with the box ticked and read the status bar, then import the file into the
   slicer.
7. Repeat step 6 with the box unticked and compare the two files in the slicer.

**Expected** With the box ticked the written file's **lowest vertex is exactly Z 0** — the status
bar says `sat on the bed: moved down 41.00 mm so the part's lowest Z is 0 (X and Y untouched)` for
the example face mask, which in model coordinates has its lowest point at Z 41.0 and therefore
floats 41 mm in the air in a slicer. The part is otherwise identical: same triangles, same size,
still one watertight piece, and X/Y unchanged, so it still lines up with the figure. **Only the
written copy moves** — the mask, the panels, the preview and the result panel are untouched (paint
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
**Guide** [Paint stencil](help.html#stencil), [Stencil STL format](help.html#stl)
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

# F. Model & view

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
the model loads with. Painting works from any angle, but remember the brush only reaches what
you can see.
**Guide** [Model & view](help.html#view)
**Automated** not automated — camera framing.
**Result** ☐ pass ☐ fail — notes:

#### V3 · Navigation

**Steps**
1. Right-drag, middle-drag and wheel in the viewport.
2. Hold `Space` and left-drag.
3. On a touch screen: one finger over the model, then two fingers.

**Expected** Right-drag orbits, middle-drag pans, the wheel zooms. `Space` + left-drag orbits
without disarming the paint tool. One finger paints; two fingers pan and zoom.
**Guide** [Model & view](help.html#view)
**Automated** not automated — pointer and touch handling.
**Result** ☐ pass ☐ fail — notes:

#### V4 · Status bar

**Steps**
1. Paint, export, import, and provoke a no-op (erase where nothing is painted).
2. Move the cursor over the model and off it.

**Expected** The left side reports what just happened — what was painted, how many vertices,
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
puts it. Either way the grid is sized from the model's own bounding box and painting behaves the
same. It is a view transform, like the up axis: no coordinate the mask or an export is written in
changes, so masks imported before or after still line up with the original STL. The bundled figure
is authored about 10 units off in x and 42 in y; the offset reported is −10.5, 42.1, −26.4.
**Guide** [Model & view](help.html#view)
**Automated** `test/cleanup.test.mjs` (the offset arithmetic on real boxes, and that measuring it
leaves the model's coordinates untouched); `test/ui-wiring.test.mjs` pins that centring writes only
`group.position`.
**Result** ☐ pass ☐ fail — notes:

---

# G. Export / import

#### X1 · Save mask (JSON)

**Steps**
1. With nothing painted, press **Save mask (JSON)**.
2. Paint something and press it again.

**Expected** With an empty mask it refuses politely in the status bar instead of writing an
empty file. With paint it downloads `<model>-mask.json` and the status bar reports the painted
vertex count, the feature count and the file size, and points at **Open mask (JSON)**. This is the
session file: it holds the windows you have marked up *now*, including this round's Shift-clicked
panels, and it is the only format that can be loaded back in.
**Guide** [Export / import](help.html#export)
**Automated** `test/app-path.test.mjs` — export → import of the mask this suite paints
(6,814 vertices) is exact, vertex for vertex and id for id.
**Result** ☐ pass ☐ fail — notes:

#### X2 · Mask JSON fields

**Steps**
1. Export a mask with two features.
2. Open the file in a text editor and compare it with the schema table in the guide.

**Expected** `format: "stl-mask"`, `version: 1`, `model`, `unit: "model units"`,
`vertexCount` equal to the model's vertex count (1,267,974), `features` with `id`/`name`/`color`,
`paintedVertices` equal to half the length of `painted`, and `painted` as a flat
`[vertexIndex, featureId]` pair list holding only painted vertices. Id 0 never appears in the
list. Sizes scale with the paint: 82,127 painted vertices is a 0.79 MB file. A mask saved by the
app also carries `stencil` with the build settings that were in the panel (`coverRadius`, `wall`,
`standoff`, `overhang`, `growIfSplit`); the field is optional, and a file without it still loads.
**Guide** [Export / import → Mask JSON](help.html#mask-json)
**Automated** `test/app-path.test.mjs` asserts each field; `test/help.test.mjs` proves the
embedded sample in the guide parses with the fields the importer reads.
**Result** ☐ pass ☐ fail — notes:

#### X3 · Round trip is exact

**Steps**
1. Paint several features; note each feature's vertex count in the palette.
2. **Save mask (JSON)**, then **Clear all**.
3. **Open mask (JSON)…** and pick the file you just saved.

**Expected** Every feature's count returns to exactly what it was, and the status bar reports the
loaded vertex count, any new features, that the build settings were restored, and that
Shift-clicking more panels is the next step.
**Guide** [Export / import → Import mask JSON](help.html#import-json)
**Automated** `test/app-path.test.mjs` — the imported mask reproduces every vertex and id.
**Result** ☐ pass ☐ fail — notes:

#### X11 · Save your place, reload it and add more windows

**Steps**
1. Load the example model, pick a feature, mark up two panels with **Part** (Shift-click the
   second) and press **Save mask (JSON)**.
2. Reload the page (or load another model and come back), then **Load example model** again.
3. Press **Open mask (JSON)…** and pick the file. Then Shift-click a third panel, press **Build
   stencil**, and export.

**Expected** The reloaded mask has both windows exactly where they were (status bar: painted
vertex count, `build settings restored`, and the next step). The third panel paints onto the
loaded mask rather than replacing it, and the build reports **3 windows** — including the ones
from the previous session — so the exported STL has all three. This is the flow the file format is
for: the mask JSON is the thing you save to keep working, and the stencil export rebuilds from it
rather than serving a stale build (S9).
**Guide** [Export / import → Import mask JSON](help.html#import-json)
**Automated** `test/app-path.test.mjs` — a saved session files the build settings, reopens with
every vertex and id intact, and a window added after the reload reaches the build (3 → 4 windows
on the bundled model).
**Result** ☐ pass ☐ fail — notes:

#### X4 · Importing merges palettes by id

**Steps**
1. Note your current palette.
2. Import a mask whose features you do not have (the guide's sample adds two).
3. Import it again.

**Expected** Features you lack are added; features you already have keep *your* colour and name.
Nothing is removed, so two files with different palettes give you the union. Importing the same
file twice adds no duplicates.
**Guide** [Export / import → Import mask JSON](help.html#import-json)
**Automated** partially — `test/help.test.mjs` proves the sample carries the ids the importer
reads; the merge itself is in `js/main.js` and is covered by `test/ui-wiring.test.mjs` wiring
checks only.
**Result** ☐ pass ☐ fail — notes:

#### X5 · Vertex-count mismatch warns

**Steps**
1. With the bundled figure open, import the guide's 36-vertex sample (`vertexCount: 36`).

**Expected** The import is **not** blocked, but the status bar warns that the mask was painted
on 36 vertices while this model has 1,267,974, so the indices land on the wrong vertices. A mask
from a slightly re-exported mesh is often close enough to be a starting point, which is why it
is a warning and not a refusal.
**Guide** [Export / import → Import mask JSON](help.html#import-json)
**Automated** `test/app-path.test.mjs` — the importer exposes both numbers, so this comparison
cannot silently disappear.
**Result** ☐ pass ☐ fail — notes:

#### X6 · A bad file is refused without damage

**Steps**
1. Paint something.
2. Try to import a JSON file that is not a mask (e.g. `{}` or a random document), then a file
   that is not JSON at all.

**Expected** The status bar shows the reason (`Not an STL mask file…`, `Mask file has no
"painted" vertex list.`, or a JSON parse error). Your current painting is left exactly as it was;
nothing is half-applied.
**Guide** [Export / import → Import mask JSON](help.html#import-json)
**Automated** `test/help.test.mjs` (the format/`painted` validation the guide describes is the
one in `js/io.js`).
**Result** ☐ pass ☐ fail — notes:

#### X7 · Import is one undo step

**Steps**
1. Paint a mask; export it; clear all; import it.
2. Press `Ctrl`+`Z`.

**Expected** One undo returns the mask to what it was before the import (empty). Features the
import added to the palette stay in the palette — the undo covers the paint, not the palette.
**Guide** [Export / import → Import mask JSON](help.html#import-json)
**Automated** `test/painting.test.mjs` (the load path's history semantics).
**Result** ☐ pass ☐ fail — notes:

#### X8 · Painted shell PLY

**Steps**
1. Paint a patch that includes triangles whose neighbours are unpainted.
2. Press **Painted shell PLY** and inspect the header of the downloaded file, or open it in
   MeshLab/Blender/CloudCompare.

**Expected** `binary_little_endian 1.0` with the vertex and face counts in the header and the
documented property list (x, y, z as floats; red, green, blue, alpha as uchar; faces as
`list uchar uint`). Only triangles whose *three* vertices are all painted are written, and the
vertices are repacked onto their own list, so the file is the painted shell rather than the whole
model. Per-vertex colour matches the palette; alpha is 255 where painted and 0 where hidden or
unpainted. Byte size is `header + 16 × vertices + 13 × faces`, and the app reports both counts
and the file size after export. It is a zero-thickness display artefact, not a printable part.
**Guide** [Export / import → Painted shell PLY](help.html#ply)
**Automated** `test/help.test.mjs` proves the guide's layout matches `js/io.js`'s writer
exports; the byte-level layout is otherwise manual.
**Result** ☐ pass ☐ fail — notes:

#### X9 · The guide's sample loads

**Steps**
1. Copy the *Ready to import* JSON block from the guide (each code block has a **Copy** button).
2. Paste it into `example-mask.json`.
3. **Open mask (JSON)…** and pick it.

**Expected** The block is valid JSON and imports without an error. On a model with 36 vertices
the four listed vertices come back painted — the first three with feature 1, the fourth with
feature 2 — and on the bundled figure it imports with the vertex-count warning from X5.
**Guide** [Export / import → Mask JSON](help.html#mask-json)
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

# H. Keyboard, mouse and the guide

#### K1 · Every binding

**Steps**
1. Press each key below, in a loaded, painted session, and compare with the expected result.

**Expected**

| Key | Action | Expected result | Result |
| --- | --- | --- | --- |
| `B` / `F` / `P` / `E` / `I` | Tool | The matching tool button becomes active and the cursor line names it. | ☐ pass ☐ fail |
| `1`…`9` | Feature | The nth feature becomes current. | ☐ pass ☐ fail |
| `M` | Mirror | The **Mirror across X plane** checkbox toggles. | ☐ pass ☐ fail |
| `[` / `]` | Brush size | Radius changes by 0.4 and the ring resizes. | ☐ pass ☐ fail |
| `Space` (hold) | Orbit | Left-drag orbits without leaving the paint tool. | ☐ pass ☐ fail |
| `Ctrl`+`Z` | Undo | The last edit is taken back. | ☐ pass ☐ fail |
| `Ctrl`+`Shift`+`Z` | Redo | The undone edit is re-applied. | ☐ pass ☐ fail |
| `Shift`+`I` | Invert | The mask inverts; `I` alone is still Pick. | ☐ pass ☐ fail |
| `Shift`+click (Part) | Add panel | The clicked panel is added to the current feature. | ☐ pass ☐ fail |
| `Shift`+click (Pick) | Sample | The feature is picked and Pick stays active. | ☐ pass ☐ fail |
| `Alt`+click (Part) | Remove panel | The clicked panel leaves the paint. | ☐ pass ☐ fail |
| `?` or `F1` | Guide | The guide opens in a new tab. | ☐ pass ☐ fail |
| right-drag / middle-drag / wheel | Navigate | Orbit / pan / zoom. | ☐ pass ☐ fail |
| drop an `.stl` | Load | The model loads (see L4). | ☐ pass ☐ fail |

**Guide** [Keyboard & mouse](help.html#shortcuts)
**Automated** `test/ui-wiring.test.mjs` — the modifier guard exempts the Part tool, `Shift`+`I`
is separated from plain `I`, and the picker's `Shift`-click behaviour is pinned.
**Result** ☐ pass ☐ fail — notes:

#### K2 · Typing is safe

**Steps**
1. Click into the **New feature name** box (or a number field) and type `b`, `f`, `p`, `e`, `i`,
   `m`, `1`, `[`, `?`.

**Expected** The characters are typed. No tool switches, no feature changes, no brush resize and
no guide tab — shortcuts are ignored while a text or number field has focus.
**Guide** [Keyboard & mouse](help.html#shortcuts)
**Automated** `test/ui-wiring.test.mjs` (the key handler checks the focused element).
**Result** ☐ pass ☐ fail — notes:

#### U1 · Launching the guide

**Steps**
1. Press the **Guide** button in the top bar.
2. Press `?` on a machine with a keyboard, then `F1`.
3. Press the small `?` next to each panel heading — Features, Paint, Mask, Paint stencil,
   Model & view, Export / import.
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

# I. Non-functional

#### N1 · Nothing leaves the page

**Steps**
1. Open the browser's network panel, clear it, and use the app: load, paint, build the stencil,
   export every format.
2. Run a session with the developer tools set to offline after the page has loaded (keep the
   vendored files cached).

**Expected** Requests only for the app's own files — `index.html`, `css/`, `js/`, `vendor/`, and
the `.stl` when you load the example. No analytics, no telemetry, no upload of the model or the
mask; parsing, painting, segmentation and the stencil build all run in the page.
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
| Brush stamp | sub-millisecond (dragging feels continuous) | | ☐ pass ☐ fail |
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
| Resolution comes from the mesh | Turn on **Wireframe** and paint on a coarse mesh | The window edge is blocky, no finer than the triangles | ☐ pass ☐ fail |
| The window insets | Paint a patch, build, and compare the window with the paint | Mask material covers a thin sliver of what you painted | ☐ pass ☐ fail |
| Clearance at creases is zero | Build at 0.3 mm standoff and read the minimum | The minimum barely improves; a few spots still touch | ☐ pass ☐ fail |
| Undercuts | Build a shell that wraps the whole figure | It builds, but cannot be placed on a rigid print | ☐ pass ☐ fail |
| One piece is preferred, not guaranteed | Paint two far-apart areas with widening off | More than one shell, reported in plain words | ☐ pass ☐ fail |
| A click selects the panel it hits | Click two pixels off a thin panel | The big panel is painted and the list appears (P10) | ☐ pass ☐ fail |
| A hidden panel cannot be clicked | Aim at a detail that is behind another surface | The panel in front is painted; the hidden one is only reachable from the list (P10) | ☐ pass ☐ fail |

**Guide** [How it works](help.html#howitworks)
**Automated** `test/stencil.test.mjs` (the "must fail" cases — nothing painted, everything
painted, a dot smaller than the inlay) and `test/parts.test.mjs` (panel sizes, the near-miss
list, and that every raycast reports the triangle under the cursor in the model's face order,
which is the order the panels are cut in).
**Result** ☐ pass ☐ fail — notes:

#### N4 · The automated suites

**Steps**
1. `npm ci` (only needed to restore the vendored library copies; the app itself needs no
   install), then `npm test`.
2. Confirm the exit status is 0 and read the per-suite summaries.

**Expected** Eight suites pass: `stencil.test.mjs` (131 checks), `app-path.test.mjs`,
`painting.test.mjs`, `parts.test.mjs`, `cleanup.test.mjs` (47 checks), `boxselect.test.mjs`
(23 checks), `ui-wiring.test.mjs` and `help.test.mjs` (215 checks).
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
- A **sliver of painted area stays covered** by mask material: the window edge is smoothed and
  inset on purpose, and **Window inlay** is the deliberate part of that overlap.
- A **click on a thin panel can select the big panel behind it** — the ray really did hit the
  big panel, so that is the panel you get. The panel list and `Alt`-click are the workaround; a
  two-pixel target cannot be made easy to hit. A panel that is *hidden behind* the surface is
  only reachable from that list.
- A **brush stamp is a sphere**, so it can paint the far side of a thin part. Use **Part** or
  **Region fill**.
- **Box select leaves the surface facing away** unpainted, and says so in the status bar. A screen
  rectangle covers the back of a closed figure as well, and painting it would be a surprise; with
  the figure turned, the same rectangle takes the other surface instead.
- A **hidden feature** still counts, still exports and still becomes part of the window — hiding
  is view-only.
- The stencil is **not** part of the undo history. Repainting after a build leaves the old part
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
| Items run | ___ of 79 |
| Passes / failures / blocked | ___ / ___ / ___ |
| Blocking failures | |
| Notes | |

**Failure report template** — one per failed item:

```
Item:            P10
Model:           Sprunki Mercuy.stl (422,658 triangles)
Steps:           clicked the left eyebrow, 2 px inside its edge
Expected:        eyebrow panel selected
Observed:        panel 1 (48.3%) painted; eyebrow stayed bare
Status bar:      Painted part 1 — 204,113 vertices
Console:         (first error, if any)
Reproduced:      yes / no / intermittent
```
