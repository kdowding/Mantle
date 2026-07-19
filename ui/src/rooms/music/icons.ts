// Static markup snippets for the player chrome, rendered via {@html}.
// ICON = unicode glyphs for small/secondary marks (carets, mini-actions);
// SVG = crisp inline icons for the transport + folder tree — currentColor
// lets the CSS drive hue/glow per state (hover, is-on, active track).

export const ICON = {
  note: '&#9835;',
  close: '&times;',
  folder: '&#9656;',
  folderOpen: '&#9662;',
  trash: '&#10005;',
  plus: '+',
  download: '&#8595;',
  rename: '&#9998;',
};

export const SVG = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="2.5" width="3" height="11" fill="currentColor"/><rect x="9" y="2.5" width="3" height="11" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3.5" width="2" height="9" fill="currentColor"/><path d="M13 3.5v9L6.5 8z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5v9L9.5 8z" fill="currentColor"/><rect x="11" y="3.5" width="2" height="9" fill="currentColor"/></svg>',
  shuffle: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h2.5l7 8H14"/><path d="M11.5 9.5 14 12l-2.5 2.5"/><path d="M2 12h2.5l7-8H14"/><path d="M11.5 6.5 14 4l-2.5-2.5"/></svg>',
  repeat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5V6a2 2 0 0 1 2-2h6.5"/><path d="M10.5 1.5 13 4l-2.5 2.5"/><path d="M12 8.5V10a2 2 0 0 1-2 2H3.5"/><path d="M5.5 14.5 3 12l2.5-2.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.6 5V12.4h12.8V6.4H7.2L5.8 5z"/></svg>',
  folderOpen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.6 5V12.4h12.8V6.4H7.2L5.8 5z"/><path d="M1.6 12.4 3.8 8.2h11L12.6 12.4z"/></svg>',
  track: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="6.5" width="1.8" height="3"/><rect x="5.1" y="3.5" width="1.8" height="9"/><rect x="8.2" y="5" width="1.8" height="6"/><rect x="11.3" y="2.5" width="1.8" height="11"/></svg>',
  cc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.6" y="3.2" width="12.8" height="9.6"/><line x1="4.2" y1="7" x2="11.8" y2="7"/><line x1="4.2" y1="9.6" x2="9" y2="9.6"/></svg>',
  prompt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M3 1.7h6l3.4 3.4V14.3H3z"/><path d="M9 1.7V5.1h3.4"/><line x1="5.2" y1="8.3" x2="10.4" y2="8.3"/><line x1="5.2" y1="10.7" x2="8.8" y2="10.7"/></svg>',
  upload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V3"/><path d="M5 6l3-3 3 3"/><path d="M3 11v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V11"/></svg>',
};
