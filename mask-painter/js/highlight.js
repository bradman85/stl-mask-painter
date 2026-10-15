/**
 * highlight.js — the tint a pick (and the face under the cursor) is drawn with.
 *
 * A pick has to be visible. Drawing the picked faces as *edges* was the first attempt and it was
 * invisible: three hairlines lying exactly on the surface they trace z-fight with the triangle they
 * belong to, so on a model of any size a single picked face showed nothing at all and a working
 * tool looked dead. The fill is what makes a pick visible; the boundary only says where the picked
 * faces stop. The other extreme is a whole-model pick, where edges alone turn the model into a
 * wireframe, which is not what "this model is picked" should look like either.
 *
 * The parent (`parent`) is passed in rather than reached for, and clearing is its own function with
 * no options to read: the first version of this code took the colours as a destructured third
 * argument and was also used to *clear* the highlight with two arguments, which threw
 * `Cannot destructure property 'color' of 'undefined'` on the first load of every session — the
 * loading overlay then sat on "Preparing mask layer…" for ever. Both halves are structural now:
 * clearing cannot read an option, and the options have defaults.
 */

import * as THREE from 'three';
import { highlightArrays } from './select.js';

/**
 * Above this many picked faces the tint is not drawn and the panel reports the count instead.
 *
 * The cost is a filled triangle per picked face (nine floats) plus its three boundary edges
 * (eighteen), rebuilt whenever the pick changes — 150,000 faces is about 16 MB of buffers and tens
 * of milliseconds, which a box drag over a large part of a model reaches and a whole-model pick
 * (422,658 faces on the bundled figure) does not. The number was 60,000 until selecting by box
 * became a gesture of the Select tool: dragging a box over the figure's body picks 68,000 faces,
 * and a pick that draws nothing at all is indistinguishable from a tool that did nothing.
 */
export const HIGHLIGHT_FACE_LIMIT = 150000;

function bufferGeometry(array) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
  return geometry;
}

/**
 * The tinted fill and the boundary of a `0/1` face mask, as two geometries.
 *
 * `positions` is the soup the mask indexes (three floats per corner, three corners per face) and
 * `faceCountInHand` is how many faces that mask covers; the mask itself may be longer, which is why
 * it is allowed to be (`min` is not taken here).
 */
export function buildHighlight(positions, faceMask, { limit = HIGHLIGHT_FACE_LIMIT } = {}) {
  const data = highlightArrays(positions, faceMask, { limit });
  if (!data) return null;
  return { fill: bufferGeometry(data.fill), edges: bufferGeometry(data.edges), picked: data.faces };
}

/** Takes a highlight out of the scene and frees it. Safe with `null`, and safe to call twice. */
export function clearHighlight(parent, group) {
  if (!group) return null;
  parent.remove(group);
  for (const child of group.children || []) {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
  return null;
}

/**
 * Draws `faceMask` (a `0/1` array over the faces in hand) into `parent`, replacing `existing`.
 *
 * Returns the new group, or `null` when there is nothing to draw — an empty mask, a mask above the
 * limit, or no mask at all. `existing` is always released first, so this is also the way to replace
 * a highlight with a different one.
 */
export function drawHighlight(
  parent,
  positions,
  existing,
  faceMask,
  { color = 0xffffff, fillOpacity = 0.4, lineOpacity = 0.9, order = 2, limit = HIGHLIGHT_FACE_LIMIT } = {},
) {
  clearHighlight(parent, existing);
  if (!faceMask) return null;
  const data = buildHighlight(positions, faceMask, { limit });
  if (!data) return null;

  // In front of the surface the faces belong to, so the tint is not swallowed by it, but still
  // depth-tested: a pick on the far side of the model stays behind the model.
  const offset = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
  const fill = new THREE.Mesh(
    data.fill,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: fillOpacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      ...offset,
    }),
  );
  const edges = new THREE.LineSegments(
    data.edges,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: lineOpacity, depthWrite: false, ...offset }),
  );
  fill.renderOrder = order;
  edges.renderOrder = order + 1;
  fill.name = 'pick-fill';
  edges.name = 'pick-edges';

  const group = new THREE.Group();
  group.name = 'pick-highlight';
  group.add(fill, edges);
  parent.add(group);
  return group;
}
