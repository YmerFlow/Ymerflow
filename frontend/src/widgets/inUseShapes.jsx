import React from 'react';

// The InUse editor's selection shapes, in picker order: gladly's lasso modes, each with its
// key (1 to 7), the gesture its tooltip gives, and its icon. The icons are 16 x 16 outline
// drawings in the text color, so they turn white on the active button.
const ICON = {
  width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round', 'aria-hidden': true,
  style: { display: 'block' },
};

export const SHAPES = [
  {
    mode: 'lasso', name: 'Lasso', gesture: 'Shift+drag around the gates',
    icon: (
      <svg {...ICON}>
        <ellipse cx="8.5" cy="6" rx="5.5" ry="3.5" transform="rotate(-12 8.5 6)" />
        <path d="M5.5 9 C4.6 10.4 5 11.8 6.3 12.3 C7.4 12.7 7.4 14 6.5 14.8" />
      </svg>
    ),
  },
  {
    mode: 'rectangle', name: 'Rectangle', gesture: 'Shift+drag from one corner to the opposite one',
    icon: <svg {...ICON}><rect x="2.5" y="2.5" width="11" height="11" rx="2" /></svg>,
  },
  {
    mode: 'triangle', name: 'Triangle', gesture: 'Shift+press at the apex, drag to a corner of the base',
    icon: <svg {...ICON}><path d="M8 2.5 L14 13.5 H2 Z" /></svg>,
  },
  {
    mode: 'polygon', name: 'Polygon', gesture: 'Shift+click each corner, then right-click or press Enter',
    icon: <svg {...ICON}><path d="M2.5 6.5 L8.5 2.5 L13.5 5.5 L12 13.5 L4 12.5 Z" /></svg>,
  },
  {
    mode: 'circle', name: 'Circle', gesture: 'Shift+press at the center, drag out to the radius',
    icon: <svg {...ICON}><circle cx="8" cy="8" r="5.5" /></svg>,
  },
  {
    mode: 'ellipse', name: 'Ellipse', gesture: 'Shift+click the center, the end of one axis, then the width',
    icon: <svg {...ICON}><ellipse cx="8" cy="8" rx="6.3" ry="3.4" transform="rotate(-30 8 8)" /></svg>,
  },
  {
    mode: 'band', name: 'Band', gesture: 'Shift+drag across the line, or Shift+click for a strip of the set width',
    icon: <svg {...ICON}><path d="M3 2 V14 M13 2 V14 M5 8 H11 M7 6 L5 8 L7 10 M9 6 L11 8 L9 10" /></svg>,
  },
].map((shape, i) => ({ ...shape, key: String(i + 1) }));
