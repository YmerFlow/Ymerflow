// matplotlib "tab10" categorical palette, copied natively here — gladly-plot
// ships only continuous colorscales, no qualitative/categorical colormap.
export const TAB10 = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

// Map each distinct mime type to a tab10 color. Mimes are sorted alphabetically
// before assignment, so a given mime always gets the same color within a project
// (and the assignment is stable regardless of which datasets happen to load first).
export function buildMimeColorMap(mimeTypes) {
  const sorted = [...new Set((mimeTypes || []).filter(Boolean))].sort();
  const map = new Map();
  sorted.forEach((mime, i) => map.set(mime, TAB10[i % TAB10.length]));
  return map;
}

// Readable text color (black/white) over a given hex background, by relative luminance.
export function contrastText(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}
