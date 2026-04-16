// ===============================
// CONFIG
// ===============================
const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbzShr_GWx8LPk_-R04YV3LbVjGY_FB0UE_89YW9SPJRluqMVEFAwVmqQ5E9zvyewC9DlA/exec";

// ===============================
// COLORES POR ESTADO
// ===============================
const COLORS = {
  "Emancipada": "#2ecc71",
  "En proceso": "#f1c40f",
  "Nueva ciudad": "#3498db",
  "default": "#bdc3c7"
};

// ===============================
// MAPA
// ===============================
const map = L.map('map').setView([4.5, -74], 6);

// BASE MAP
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18
}).addTo(map);

// ===============================
// CARGAR GEO BASE
// ===============================
let geoLayer;

// ===============================
// FUNCION PRINCIPAL
// ===============================
async function initMap() {

  // 1. Cargar municipios base
  const baseResponse = await fetch('data/municipalities.json');
  const baseData = await baseResponse.json();

  // 2. Cargar estados desde Google Sheets
  const sheetResponse = await fetch(SHEETS_ENDPOINT);
  const sheetData = await sheetResponse.json();

  // 3. Convertir a diccionario por DANE
  const estadoMap = {};
  sheetData.forEach(row => {
    estadoMap[row.dane] = row;
  });

  // 4. Aplicar estados
  baseData.features.forEach(f => {
    const dane = f.properties.dane;
    const match = estadoMap[dane];

    if (match) {
      f.properties.estado = match.estado;
      f.properties.detalle = match.ubicacion;
    } else {
      f.properties.estado = "default";
    }
  });

  // 5. Pintar mapa
  geoLayer = L.geoJSON(baseData, {
    style: feature => ({
      color: "#555",
      weight: 1,
      fillColor: COLORS[feature.properties.estado] || COLORS.default,
      fillOpacity: 0.7
    }),
    onEachFeature: (feature, layer) => {
      layer.bindPopup(`
        <b>${feature.properties.name}</b><br>
        Estado: ${feature.properties.estado}
      `);
    }
  }).addTo(map);
}

// ===============================
// INIT
// ===============================
initMap();
