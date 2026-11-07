/* Strich-Icons (V2, Kapitel 7): 24er-Raster, 2 px Strich, currentColor.
 * Die Pfade stammen aus den Entwürfen in docs/design/.
 * icon(name, size) liefert dekoratives SVG (aria-hidden). Für Icon-Buttons
 * trägt der Button selbst das aria-label.
 */
const ICON_PATHS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  calendarCheck: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M8.5 15l2.2 2.2 4.8-4.7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  more: '<circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  series: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  note: '<path d="M5 4h14v16H5z"/><path d="M9 9h6"/><path d="M9 13h6"/><path d="M9 17h3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  pencil: '<path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m17 6 3 3"/><path d="m14 9 2 2"/>',
  tags: '<circle cx="7.5" cy="7.5" r="3.5"/><circle cx="16.5" cy="7.5" r="3.5"/><circle cx="7.5" cy="16.5" r="3.5"/><circle cx="16.5" cy="16.5" r="3.5"/>',
  share: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  wifiOff: '<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5.5 12.4a10 10 0 0 1 13 0"/><path d="M9 16a5 5 0 0 1 6 0"/><path d="M3 3l18 18"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>',
};

function icon(name, size = 20, strokeWidth = 2) {
  const paths = ICON_PATHS[name] || '';
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** Füllt alle Elemente mit data-icon="name" (optional data-size). */
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const size = +el.dataset.size || 20;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, size));
    el.removeAttribute('data-icon');
  });
}
