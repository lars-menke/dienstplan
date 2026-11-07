// Link der Apps-Script-Schnittstelle (endet auf /exec).
// Zu finden im Sheet-Menü: 🚒 Feuerwehr Kalender-Sync → „Link der App-Schnittstelle anzeigen“.
window.DIENSTPLAN_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzrO_CjqgOpPwGQgJtEvUQIhEkSapRiOLsc5OquNfPnMDTpJISbaIAaJckh4z4fU7em/exec',

  // Vorlagen für „Neuer Termin“ (V2, Kapitel 8.5) – nur die Beta nutzt sie.
  // title = Titel-Anfang, category = Name aus dem Blatt „Categories“.
  // Gibt es die Kategorie nicht (mehr), bleibt sie im Formular leer.
  TEMPLATES: [
    { label: 'Übungsdienst', title: 'Übungsdienst: ', start: '19:30', end: '21:30', location: 'Feuerwehrhaus', category: 'Übung' },
    { label: 'Gruppendienst', title: 'Gruppendienst: ', start: '09:00', end: '12:00', location: 'Feuerwehrhaus', category: 'Ausbildung' },
    { label: 'Besprechung', title: 'Besprechung: ', start: '19:00', end: '', location: 'Schulungsraum', category: 'Besprechung' },
    { label: 'Leer', title: '', start: '19:00', end: '21:00', location: '', category: '' },
  ],
};
