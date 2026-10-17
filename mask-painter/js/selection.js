/**
 * selection.js — the one selection this app has.
 *
 * The tool used to have two kinds of mark on the model: *paint*, which the brush and the region
 * fill wrote per vertex and which the stencil was built from, and a *pick*, which the Select tool
 * wrote per face and which nothing downstream could use. They did not talk to each other — pick a
 * panel's worth of faces and "Build stencil" said there was nothing painted, which is exactly the
 * complaint — and the paint was only ever a way of saying "these triangles", so it was a second
 * copy of the same idea, in a different shape, in a different colour.
 *
 * There is now one kind of mark, and it is a **set of triangles**:
 *
 *   - `Part` adds the faces of a seam-bounded panel (or takes them off, with Alt).
 *   - `Select faces` adds or removes single triangles, by click or by dragging a box.
 *   - Both write the same array, so what one selects the other sees and can build on: pick the
 *     head with Part, then take the eyes off it a few triangles at a time. Nothing clears the
 *     selection when the tool changes, because a selection is not a tool's private state.
 *   - `Build stencil` builds from all of it. There is nothing else to do first: a selection *is*
 *     the window the shell is made around.
 *
 * The stencil itself is vertex-based (`buildStencil` wants a flag per corner of the file's soup),
 * so the bridge is `paintedFromFaces`: the three corners of every selected triangle. That is the
 * only place the two representations meet.
 *
 * Dependency-free on purpose: the same code runs in the page and under Node in
 * test/selection.test.mjs, which is where the arithmetic of adding, removing and inverting is
 * checked.
 */

/** The mask id a selected corner carries. Ids are a stencil detail: there is only ever one. */
export const SELECTION_ID = 1;

// The saved-file format carries a feature id per painted corner, and files exist from when those
// ids were a palette. The format keeps its range and its 0-means-nothing rule; nothing in the app
// reads a second id any more.
export const UNPAINTED_ID = 0;
export const MAX_FEATURE_ID = 32000;

/** The one colour a selection is drawn in. Paint used to have a palette; a selection does not. */
export const SELECTION_COLOR = '#ffc94d';

/** `#rrggbb` to linear-ish 0..1 floats, for a vertex colour buffer. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 0.5, g: 0.5, b: 0.5 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * An empty selection over a model of `faceCount` triangles.
 *
 * `faces[t]` is 1 when triangle `t` is selected. Faces, not vertices, because that is the unit a
 * user points at — a triangle is what the cursor is over, what a seam separates, and what a box
 * covers — and because a vertex-based mark cannot say "this triangle" about the triangle that
 * shares a corner with it.
 */
export function createSelection(faceCount) {
  return { faceCount: Math.max(0, faceCount | 0), faces: new Uint8Array(Math.max(0, faceCount | 0)) };
}

/** How many triangles are selected — the number every status line and the panel quote. */
export function countSelected(sel) {
  if (!sel) return 0;
  let n = 0;
  for (let t = 0; t < sel.faces.length; t += 1) if (sel.faces[t]) n += 1;
  return n;
}

/** Is this triangle selected? */
export function isSelected(sel, face) {
  return !!sel && face >= 0 && face < sel.faces.length && !!sel.faces[face];
}

/**
 * One widget's worth of faces applied to the selection: replace, add or remove.
 *
 * A plain gesture *replaces* rather than toggling each face it covers — toggling forty thousand
 * triangles one at a time is not a selection anybody can reason about, and "what I just pointed
 * at is the selection now" is what a click and a rubber band both mean everywhere else. Shift adds,
 * Alt removes, in every tool, so the two selection gestures are the same two gestures.
 */
export function applyFaces(sel, wanted, { add = false, remove = false } = {}) {
  if (!sel) return 0;
  let changed = 0;
  const n = Math.min(sel.faces.length, wanted.length);
  for (let t = 0; t < sel.faces.length; t += 1) {
    const want = remove
      ? t < n && wanted[t]
        ? 0
        : sel.faces[t]
      : add
        ? t < n && wanted[t]
          ? 1
          : sel.faces[t]
        : t < n && wanted[t]
          ? 1
          : 0;
    if (sel.faces[t] !== want) {
      sel.faces[t] = want;
      changed += 1;
    }
  }
  return changed;
}

/**
 * How many faces the same gesture *would* change, without touching anything.
 *
 * Used to skip an undo entry for a gesture that selects what is already selected: Ctrl+Z stepping
 * through clicks that did nothing is how an undo button starts to look broken.
 */
export function countChanges(sel, wanted, { add = false, remove = false } = {}) {
  if (!sel) return 0;
  const n = Math.min(sel.faces.length, wanted.length);
  let changed = 0;
  for (let t = 0; t < sel.faces.length; t += 1) {
    const want = remove
      ? t < n && wanted[t]
        ? 0
        : sel.faces[t]
      : add
        ? t < n && wanted[t]
          ? 1
          : sel.faces[t]
        : t < n && wanted[t]
          ? 1
          : 0;
    if (sel.faces[t] !== want) changed += 1;
  }
  return changed;
}

/** Every triangle, or none of them. Returns the new count. */
export function setAll(sel, on) {
  if (!sel) return 0;
  sel.faces.fill(on ? 1 : 0);
  return on ? sel.faces.length : 0;
}

/** The complement of the selection. Returns the new count. */
export function invertSelection(sel) {
  if (!sel) return 0;
  let n = 0;
  for (let t = 0; t < sel.faces.length; t += 1) {
    const on = sel.faces[t] ? 0 : 1;
    sel.faces[t] = on;
    if (on) n += 1;
  }
  return n;
}

/**
 * The triangle a soup vertex belongs to: corner `i` is a corner of face `floor(i / 3)`.
 *
 * The file's soup repeats every vertex once per triangle, so this is exact — which is what lets a
 * seam panel (a list of vertices) and a selection (a set of faces) be the same statement.
 */
export function faceOfCorner(corner) {
  return Math.floor(corner / 3);
}

/**
 * The selection as the stencil wants it: one flag per corner of the soup.
 *
 * `painted[t * 3 + k]` is 1 when triangle `t` is selected, so every corner of a selected face is
 * marked. Mesh vertices are *not* welded here on purpose — the stencil builder welds the surface
 * itself, and a corner is a corner either way.
 */
export function paintedFromFaces(sel, out = null) {
  const faceCount = sel ? sel.faces.length : 0;
  const painted = out && out.length === faceCount * 3 ? out : new Uint8Array(faceCount * 3);
  painted.fill(0);
  if (!sel) return painted;
  for (let t = 0; t < faceCount; t += 1) {
    if (!sel.faces[t]) continue;
    painted[t * 3] = 1;
    painted[t * 3 + 1] = 1;
    painted[t * 3 + 2] = 1;
  }
  return painted;
}

/** The faces a list of soup vertices lands on — how a seam panel becomes part of the selection. */
export function facesFromVertices(indices, faceCount, out = null) {
  const faces = out && out.length === faceCount ? out : new Uint8Array(faceCount);
  faces.fill(0);
  for (let i = 0; i < indices.length; i += 1) {
    const t = faceOfCorner(indices[i]);
    if (t >= 0 && t < faceCount) faces[t] = 1;
  }
  return faces;
}

/**
 * The faces a loaded mask touches: any triangle with at least one painted corner.
 *
 * A saved mask is per vertex (it always was — an STL has no UVs, so the brush wrote vertices), and
 * a selection is per face, so the two only meet by inclusion. Taking every face that touches paint
 * is the reading that keeps a saved window whole: tightening it to "all three corners painted"
 * would drop the rim of a brushed window and open a gap in the stencil nobody asked for.
 */
export function facesFromPainted(painted, faceCount, out = null) {
  const faces = out && out.length === faceCount ? out : new Uint8Array(faceCount);
  faces.fill(0);
  const n = Math.min(faceCount, Math.floor(painted.length / 3));
  for (let t = 0; t < n; t += 1) {
    if (painted[t * 3] || painted[t * 3 + 1] || painted[t * 3 + 2]) faces[t] = 1;
  }
  return faces;
}

/** The same selection for a soup that was cut: `faceMap[i]` is the old face of new face `i`. */
export function remapSelection(sel, faceMap, newCount) {
  const out = createSelection(newCount);
  if (!sel) return out;
  for (let i = 0; i < newCount && i < faceMap.length; i += 1) {
    const old = faceMap[i];
    if (old >= 0 && old < sel.faces.length && sel.faces[old]) out.faces[i] = 1;
  }
  return out;
}

/**
 * Undo/redo for the selection.
 *
 * Kept here rather than in the mask layer because the selection is now the thing being edited:
 * painting had its own history of vertex-id snapshots, and with the paint gone a history that
 * remembered *ids* could be undone into a mask the selection does not describe — two answers to
 * the same question. A snapshot is the face array, which is a quarter the size of the id array it
 * replaces.
 */
export class SelectionHistory {
  constructor({ limit = 40 } = {}) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Forget both stacks. A new model is a new selection: an undo entry from the file that was in
   * hand before would otherwise be applied to the faces of the file in hand now, which silently
   * selects the wrong triangles — or, after a reload, the ones the user just asked to start over
   * from.
   */
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Remember the selection as it is *before* the edit about to happen. */
  remember(sel) {
    if (!sel) return;
    this.undoStack.push(sel.faces.slice());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    // A fresh edit is a new branch: what was undone is not what redo should put back.
    this.redoStack.length = 0;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo(sel) {
    if (!this.undoStack.length) return false;
    this.redoStack.push(sel.faces.slice());
    sel.faces.set(this.undoStack.pop());
    return true;
  }

  redo(sel) {
    if (!this.redoStack.length) return false;
    this.undoStack.push(sel.faces.slice());
    sel.faces.set(this.redoStack.pop());
    return true;
  }

  /**
   * Renumber both stacks for a soup that was cut.
   *
   * A removal shifts every face index; a history left alone would undo the wrong triangles,
   * silently, and only on the next Ctrl+Z.
   */
  remap(faceMap, faceCount) {
    const one = (snapshot) => {
      const out = new Uint8Array(faceCount);
      for (let i = 0; i < faceCount && i < faceMap.length; i += 1) {
        const old = faceMap[i];
        if (old >= 0 && old < snapshot.length) out[i] = snapshot[old];
      }
      return out;
    };
    this.undoStack = this.undoStack.map(one);
    this.redoStack = this.redoStack.map(one);
  }
}
