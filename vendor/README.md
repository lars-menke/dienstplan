# Fremdbibliotheken

| Datei | Bibliothek | Version | Lizenz | Quelle |
|---|---|---|---|---|
| `xlsx.full.min.js` | SheetJS Community Edition | 0.20.3 | Apache-2.0 (`LICENSE-SheetJS.txt`) | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` → `package/dist/xlsx.full.min.js` |

SHA-256 `xlsx.full.min.js`: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`

Wird nur von `import.js` beim Öffnen einer Excel-Datei nachgeladen und steht bewusst
nicht in der Vorab-Liste des Service Workers (`sw.js`). Aktualisieren: neue Version von
cdn.sheetjs.com holen, Datei und Lizenz ersetzen, Version und Prüfsumme hier anpassen.
