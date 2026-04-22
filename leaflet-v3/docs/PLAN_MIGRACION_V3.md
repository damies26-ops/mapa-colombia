# PLAN DE MIGRACIÓN V3

## Qué incluye este paquete
- index.html completo con panel lateral, búsqueda, detalle, leyenda, filtros y lista de no ubicados
- assets/app.js listo para cruzar Google Sheets contra un GeoJSON local completo
- data/colombia-municipios.geojson de muestra (vacío) para que reemplaces con la capa completa

## Importante
Esta V3 ya no consulta la capa DANE en vivo desde el navegador. Usa un archivo local en ./data/colombia-municipios.geojson.

## Pasos
1. Sube la carpeta leaflet-v3 completa al repo.
2. En assets/app.js reemplaza SHEETS_ENDPOINT por tu URL real de Apps Script.
3. Reemplaza data/colombia-municipios.geojson por la capa completa real de municipios.
4. Abre la ruta /leaflet-v3/ y valida municipios viejos, nuevos y no ubicados.
