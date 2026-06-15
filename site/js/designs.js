// designs.js — design catalog assembled from the generated manifest.
// GENERATED is produced by another build step (designs.generated.js).

import { GENERATED } from './designs.generated.js';

/** Selectable "main" colors the user can pick to recolor a design. */
export const MAIN_COLORS = [
  { id: 'pink', name: 'ורוד', hex: '#E5197D' },
  { id: 'magenta', name: 'מגנטה', hex: '#D6249F' },
  { id: 'violet', name: 'סגול', hex: '#7A3FF2' },
  { id: 'blue', name: 'כחול', hex: '#2D7FF9' },
  { id: 'teal', name: 'טורקיז', hex: '#0FB5AE' },
  { id: 'green', name: 'ירוק', hex: '#1FAE72' },
  { id: 'orange', name: 'כתום', hex: '#F76707' },
  { id: 'red', name: 'אדום', hex: '#E03131' },
];

/** Human-friendly (Hebrew) names per design id. */
const META = {
  birthday: { name: 'יום הולדת' },
  birthday2: { name: 'יום הולדת קלאסי' },
  kids: { name: 'יום הולדת לילדים' },
  marriage: { name: 'חתונה / נישואין' },
  bachelorette: { name: 'מסיבת רווקות' },
};

/** Full design list: id, display name, anchors, product SVGs. */
export const DESIGNS = Object.entries(GENERATED).map(([id, g]) => ({
  id,
  name: (META[id] || {}).name || id,
  anchors: g.anchors,
  products: g.products,
}));
