// Feature palette: a "feature" is a named region of the model, painted in its own
// colour on the mask overlay. Id 0 is reserved for "unpainted".

export const MAX_FEATURE_ID = 32000;
export const UNPAINTED_ID = 0;

// Ids are stable so an exported mask stays readable if the palette is reordered.
export const DEFAULT_FEATURES = [
  { id: 1, name: 'Eyes', color: '#4ea1ff' },
  { id: 2, name: 'Pupils', color: '#111820' },
  { id: 3, name: 'Mouth', color: '#ff4d6d' },
  { id: 4, name: 'Cheeks', color: '#ff8fb1' },
  { id: 5, name: 'Ears', color: '#b06bff' },
  { id: 6, name: 'Head', color: '#ffd23f' },
  { id: 7, name: 'Body', color: '#3ddc84' },
  { id: 8, name: 'Arms', color: '#2fd0c5' },
  { id: 9, name: 'Legs', color: '#ff9f45' },
  { id: 10, name: 'Markings', color: '#ff6bd6' },
];

export function createFeatureList() {
  return DEFAULT_FEATURES.map((f) => ({ ...f }));
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 0.5, g: 0.5, b: 0.5 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function nextFeatureId(features) {
  let id = 1;
  const used = new Set(features.map((f) => f.id));
  while (used.has(id) && id < MAX_FEATURE_ID) id += 1;
  return id;
}
