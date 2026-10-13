# STL Mask Painter

Load a 3D model (STL), lay a paintable mask over it, and paint named features onto the
surface with a brush, a region flood fill, and an eyedropper. The mask can be painted in
solid colours, hidden per feature, undone/redone, and exported as JSON (re-importable) or
as a binary PLY of the painted shell.

The bundled example is [`Sprunki Mercuy.stl`](../Sprunki%20Mercuy.stl) — 422,658 triangles,
1,267,974 vertices — and it loads, orients and becomes paintable in about 0.3 s.

## Run it

ES modules and `fetch` mean the app has to be served over HTTP (opening `index.html` from
disk with `file://` will not work). The included server serves the **parent** directory so
the example model next to the app folder is reachable:

```bash
node serve.mjs          # http://127.0.0.1:8137/mask-painter/index.html
node serve.mjs 9000     # pick another port
```

Alternatively use any static server rooted at the repository folder, or drop an `.stl`
onto the viewport — the app does not need the example model to be useful.

Three.js and three-mesh-bvh are vendored under `vendor/`, so no install is needed to run.
`npm install` only restores the packages used to refresh those vendored copies.

## Tools

| Tool | What it does | Shortcut |
| --- | --- | --- |
| Brush | Paints the selected feature into every vertex inside the brush radius | `B` |
| Region fill | Flood-fills the connected surface from the clicked point, stopping where the surface turns more than the angle limit | `F` |
| Erase | Paints "unpainted" back into the mask | `E` |
| Pick | Selects whichever feature is painted under the cursor | `I` |

- **Features** are a palette of named colours (Eyes, Pupils, Mouth, …). Add your own; each
  row shows how many vertices it owns, and can be hidden or cleared individually.
  `1`…`9` select the first nine features.
- **Brush radius** `[` / `]`, suitable default derived from the model's size.
- **Mirror across X** paints the mirrored point too (plane defaults to the model's centre).
- **Mask opacity**, **ghost shell** (dim unpainted area to see the mask in context),
  base-model visibility, wireframe, ground grid.
- **Up axis** — Y-up is right for character models, Z-up for CAD/printer meshes.
- **Views**: Front / Back / Left / Right / Top / Home.
- **Undo / redo** with `Ctrl+Z` / `Ctrl+Shift+Z`; a stroke, a fill, a clear and a palette
  removal are each one step.
- Right-drag orbits, middle-drag pans, wheel zooms. Hold `Space` (or use the **Navigate**
  button) to orbit with the left button while painting tools stay armed.

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

## Export / import

- **Mask JSON** — `format: "stl-mask"`, the palette and a flat `[vertexIndex, featureId, …]`
  list. Re-import merges features into the palette and warns if the vertex count differs.
- **Painted shell PLY** — binary little-endian PLY containing only triangles whose three
  vertices are painted, with `red/green/blue/alpha` properties, so it opens in MeshLab,
  Blender, CloudCompare and friends.
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
  js/io.js          mask JSON + binary PLY writers, import parsing
  serve.mjs         tiny static server for the app + neighbouring models
  vendor/           three.module.js, OrbitControls, STLLoader, three-mesh-bvh
```

`window.maskPainter` exposes `{ state, viewer, mask, io, paintAt, loadFromURL, … }` for
console poking and scripted checks.

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
- JSON round trip: 82,127 painted vertices export and re-import identically, per-feature
  counts included.
- PLY: byte size matches the declared vertex/face counts, no malformed faces, indices in range.
- failure paths: a missing model reports `HTTP 404` in the status bar and leaves the
  current model intact.

## Limitations

- The mask is per vertex, so brush resolution is limited by the model's tessellation; a
  coarse mesh gives blocky edges.
- Exported masks are only meaningful for the model they were painted on (imports warn on a
  vertex-count mismatch; there is no UV/space independent mapping).
- Painting intentionally blocks left-drag orbit — switch on **Navigate** (or hold `Space`).
- Region fill can bleed across a thin gap if the surface angle limit is high; lower the
  angle limit for tight areas.
