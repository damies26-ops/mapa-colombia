const SHEETS_ENDPOINT = "PEGAR_AQUI_URL_EXEC";

// 🔥 capa oficial DANE (GeoJSON)
const DANE_URL = "https://geoportal.dane.gov.co/mparcgis/rest/services/Divipola/Cache_DivipolaEntidadesTerritorialesCP/MapServer/9/query?where=1=1&outFields=*&f=geojson";

const STATUS_META = {
  "Emancipada": { color: "#F2D46B" },
  "En proceso": { color: "#4A90E2" },
  "Nueva ciudad": { color: "#D64541" }
};

const map = L.map('map').setView([4.5, -74], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

let geoLayer;
let sheetDataMap = {};

init();

async function init() {
  const [geoData, sheetData] = await Promise.all([
    fetch(DANE_URL).then(r => r.json()),
    fetch(SHEETS_ENDPOINT).then(r => r.json())
  ]);

  processSheet(sheetData);
  drawMap(geoData);
  renderLegend();
}

function processSheet(data) {
  const rows = Array.isArray(data) ? data : data.rows;

  rows.forEach(r => {
    const dane = String(r.dane).padStart(5, "0");
    sheetDataMap[dane] = r;
  });
}

function drawMap(geoData) {

  geoLayer = L.geoJSON(geoData, {
    style: feature => {

      const dane = String(feature.properties.CODIGO_DANE || feature.properties.DANE).padStart(5, "0");
      const sheet = sheetDataMap[dane];

      if (!sheet) {
        return {
          color: "#ccc",
          weight: 1,
          fillColor: "#eee",
          fillOpacity: 0.3
        };
      }

      return {
        color: "#666",
        weight: 1,
        fillColor: STATUS_META[sheet.estado]?.color || "#999",
        fillOpacity: 0.8
      };
    },

    onEachFeature: (feature, layer) => {

      const dane = String(feature.properties.CODIGO_DANE || feature.properties.DANE).padStart(5, "0");
      const sheet = sheetDataMap[dane];

      if (sheet) {
        layer.bindPopup(`
          <b>${feature.properties.NOMBRE || sheet.municipio_mapa}</b><br>
          ${sheet.departamento}<br>
          Estado: ${sheet.estado}
        `);
      }

    }

  }).addTo(map);

}
