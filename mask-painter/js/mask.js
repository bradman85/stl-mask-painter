import { SELECTION_COLOR, SELECTION_ID, hexToRgb } from './selection.js';

// Unselected vertices keep the model's neutral tone (and alpha 0), so the tint is invisible where
// nothing is selected even on a renderer that ignores vertex alpha.
const UNSELECTED_RGB = [0.72, 0.74, 0.78];

/**
 * The selection, drawn on the model.
 *
 * This used to be a paint layer: a feature id per vertex, a colour lookup table, a spatial grid so
 * a brush stamp was cheap, and its own undo history. All of that existed to support painting the
 * model in colours. The app does not paint any more — it *selects*, and what it selects is a set of
 * triangles (see `selection.js`) — so what is left here is the drawing half: write the selection
 * into the overlay geometry's colour attribute, and hand the panel honest counts.
 *
 * The ids array stays, because it is what the stencil builder, the window analysis and both
 * exports read: `ids[i] !== 0` means corner `i` of the file's soup is inside the window. It is
 * *derived* — `setSelection()` is the only thing that writes it, from the faces the user selected —
 * which is what makes "the stencil is built from the selection" true by construction rather than by
 * remembering to copy one into the other.
 */
export class SelectionTint {
  constructor(geometry) {
    this.geometry = geometry;
    this.position = geometry.attributes.position;
    this.vertexCount = this.position.count;
    this.ids = new Int16Array(this.vertexCount);
    this.colors = new Float32Array(this.vertexCount * 4);
    this.backdrop = false;
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
    this._rgb = hexToRgb(SELECTION_COLOR);
    this.refreshColors();
  }

  // ------------------------------------------------------------- colouring

  _writeVertex(i) {
    const o4 = i * 4;
    if (this.ids[i] === 0) {
      const a = this.backdrop ? 0.16 : 0;
      this.colors[o4] = UNSELECTED_RGB[0];
      this.colors[o4 + 1] = UNSELECTED_RGB[1];
      this.colors[o4 + 2] = UNSELECTED_RGB[2];
      this.colors[o4 + 3] = a;
    } else {
      this.colors[o4] = this._rgb.r;
      this.colors[o4 + 1] = this._rgb.g;
      this.colors[o4 + 2] = this._rgb.b;
      this.colors[o4 + 3] = 1;
    }
    if (i < this._dirtyMin) this._dirtyMin = i;
    if (i > this._dirtyMax) this._dirtyMax = i;
  }

  refreshColors() {
    for (let i = 0; i < this.vertexCount; i += 1) this._writeVertex(i);
  }

  /**
   * Shows the selection: `painted[i]` is 1 for a corner inside the window.
   *
   * Returns how many corners are now inside it, so the caller does not have to count again.
   */
  setSelection(painted) {
    let count = 0;
    for (let i = 0; i < this.vertexCount; i += 1) {
      const id = i < painted.length && painted[i] ? SELECTION_ID : 0;
      if (id) count += 1;
      if (this.ids[i] !== id) {
        this.ids[i] = id;
        this._writeVertex(i);
      }
    }
    // A shorter array than the model leaves the tail unselected, and it has to be cleared too.
    for (let i = painted.length; i < this.vertexCount; i += 1) {
      if (this.ids[i] !== 0) {
        this.ids[i] = 0;
        this._writeVertex(i);
      }
    }
    return count;
  }

  /** Everything unselected. */
  clear() {
    this.setSelection(new Uint8Array(0));
  }

  /**
   * The colour the selection is drawn in. A preference, so it can be changed while a model is in
   * hand; only the selected corners carry it, so the buffer is not rewritten wholesale.
   * Returns true when something changed (the caller then flushes).
   */
  setColor(hex) {
    const rgb = hexToRgb(hex);
    if (rgb.r === this._rgb.r && rgb.g === this._rgb.g && rgb.b === this._rgb.b) return false;
    this._rgb = rgb;
    for (let i = 0; i < this.vertexCount; i += 1) if (this.ids[i] !== 0) this._writeVertex(i);
    return true;
  }

  setBackdrop(on) {
    const next = !!on;
    if (next === this.backdrop) return;
    this.backdrop = next;
    this.refreshColors();
  }

  /** Uploads only the range of the colour buffer that changed. */
  flush() {
    const attr = this.geometry.attributes.color;
    if (!attr) return;
    if (this._dirtyMax < this._dirtyMin) return;
    const start = this._dirtyMin * 4;
    const count = (this._dirtyMax - this._dirtyMin + 1) * 4;
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
    attr.needsUpdate = true;
    if (typeof attr.addUpdateRange === 'function') {
      attr.addUpdateRange(start, count);
    }
  }

  // ----------------------------------------------------------- reporting

  /** How much of the model is selected: corners in the window, out of all of them. */
  stats() {
    let painted = 0;
    for (let i = 0; i < this.vertexCount; i += 1) if (this.ids[i] !== 0) painted += 1;
    return { painted, total: this.vertexCount };
  }

  // --------------------------------------------------------- persistence

  /** The window as flat `[corner, id, …]` pairs — the mask file's own shape. */
  paintedPairs() {
    const out = [];
    for (let i = 0; i < this.vertexCount; i += 1) {
      if (this.ids[i] !== 0) out.push(i, this.ids[i]);
    }
    return out;
  }

  /**
   * Reads a saved window back in.
   *
   * The loader calls this and then re-derives the selection from it (`facesFromPainted`), so a file
   * saved by the old palette version — several ids, brushed by hand — comes back as one selection
   * covering the same faces. Only the corner flags survive that trip, deliberately: there is no
   * second colour to come back to.
   */
  loadPairs(pairs) {
    this.ids.fill(0);
    for (let k = 0; k + 1 < pairs.length; k += 2) {
      const i = pairs[k];
      const id = pairs[k + 1];
      if (i >= 0 && i < this.vertexCount && id > 0) this.ids[i] = SELECTION_ID;
    }
    this.refreshColors();
  }
}
