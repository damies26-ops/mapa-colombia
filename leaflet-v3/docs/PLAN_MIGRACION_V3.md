# PLAN DE MIGRACIÓN V3 CORREGIDA

## Qué corregí
- Incluí el GeoJSON corregido con coordenadas en orden `[longitud, latitud]`.
- Cambié el fondo base a uno neutro (`Carto light_nolabels`) para evitar la sensación de desfase entre cartografías.
- El `app.js` quedó alineado con el nuevo `index.html`.

## Qué debes hacer
1. Sube la carpeta `leaflet-v3` completa.
2. En `assets/app.js`, reemplaza `PEGAR_AQUI_URL_EXEC` por tu URL real de Apps Script.
3. Publica y valida en `/leaflet-v3/`.

## Nota
La geometría ahora está correctamente sobre Colombia. Si visualmente alguna línea parece no coincidir con carreteras o detalles del fondo, eso es normal entre cartografías distintas. Por eso se dejó un fondo neutro.
