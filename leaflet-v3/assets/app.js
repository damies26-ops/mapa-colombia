const SHEETS_ENDPOINT = "PEGAR_AQUI_URL_EXEC";

// Capa oficial DANE - Municipios (ID 9)
const DANE_URL = "https://geoportal.dane.gov.co/mparcgis/rest/services/Divipola/Cache_DivipolaEntidadesTerritorialesCP/MapServer/9/query?where=1%3D1&outFields=COD_MPIO,NOM_MPIO,NOM_DPTO&returnGeometry=true&f=geojson";

const STATUS_META = {
  "Emancipada": { color: "#F2D46B", label: "Iglesias emancipadas" },
  "En proceso": { color: "#4A90E2", label: "Iglesias por emancipar" },
  "Nueva ciudad": { color: "#D64541", label: "Por conquistar" }
};

const map = L.map("map").setView([4.5, -74], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let geoLayer = null;
let sheetRows = [];
let filteredStatuses = new Set(Object.keys(STATUS_META));
let allFeatures = [];
let unmatchedRows = [];

init();

async function init() {
  try {
    const [geoData, sheetsPayload] = await Promise.all([
      fetch(DANE_URL, { cache: "no-cache" }).then(r => {
        if (!r.ok) throw new Error("No fue posible cargar la capa DANE.");
        return r.json();
      }),
      fetch(SHEETS_ENDPOINT, { cache: "no-cache" }).then(r => {
        if (!r.ok) throw new Error("No fue posible cargar Google Sheets.");
        return r.json();
      })
    ]);

    sheetRows = normalizeSheetRows(sheetsPayload);
    allFeatures = mergeGeoWithSheets(geoData.features || [], sheetRows);
    renderMap();
    fitIfNeeded();
  } catch (error) {
    console.error(error);
    alert("Error cargando la V3: " + (error.message || error));
  }
}

function normalizeSheetRows(payload) {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.rows) ? payload.rows : []);

  return rows
    .map(row => ({
      dane: String(row.dane ?? "").trim().padStart(5, "0"),
      ubicacion: String(row.ubicacion ?? "").trim(),
      municipio_mapa: String(row.municipio_mapa ?? "").trim(),
      departamento: String(row.departamento ?? "").trim(),
      estado: String(row.estado ?? "").trim(),
      region: String(row.region ?? "").trim(),
      macroregion: String(row.macroregion ?? "").trim()
    }))
    .filter(row => row.dane && STATUS_META[row.estado]);
}

function mergeGeoWithSheets(features, rows) {
  const rowsByDane = new Map();
  rows.forEach(row => {
    if (!rowsByDane.has(row.dane)) rowsByDane.set(row.dane, []);
    rowsByDane.get(row.dane).push(row);
  });

  const daneInGeo = new Set();
  const merged = [];

  for (const feature of features) {
    const props = feature.properties || {};
    const dane = String(props.COD_MPIO ?? props.cod_mpio ?? "").trim().padStart(5, "0");
    const municipio = props.NOM_MPIO || props.nom_mpio || "";
    const departamento = props.NOM_DPTO || props.nom_dpto || "";

    if (!dane) continue;
    daneInGeo.add(dane);

    const rowsForFeature = rowsByDane.get(dane);
    if (!rowsForFeature || rowsForFeature.length === 0) continue;

    const estado = rowsForFeature[0].estado;

    merged.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        dane,
        municipio,
        departamento,
        estado,
        color: STATUS_META[estado].color,
        records: rowsForFeature
      }
    });
  }

  unmatchedRows = rows
    .filter(row => !daneInGeo.has(row.dane))
    .map(row => ({
      name: row.ubicacion || row.municipio_mapa || row.dane,
      detail: `${row.departamento || "Sin departamento"} · ${row.estado} · DANE ${row.dane}`
    }));

  return merged;
}

function renderMap() {
  if (geoLayer) {
    map.removeLayer(geoLayer);
  }

  const visibleFeatures = allFeatures.filter(f => filteredStatuses.has(f.properties.estado));

  geoLayer = L.geoJSON(visibleFeatures, {
    style: feature => ({
      color: "#6f7c89",
      weight: 1,
      fillColor: feature.properties.color || "#cccccc",
      fillOpacity: 0.8
    }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      const recordsHtml = (p.records || []).map((r, i) => `
        <div style="margin-top:6px;">
          <strong>Registro ${i + 1}</strong><br>
          Ubicación: ${escapeHtml(r.ubicacion || p.municipio)}<br>
          Estado: ${escapeHtml(r.estado)}<br>
          Región: ${escapeHtml(r.region || "—")}<br>
          Macroregión: ${escapeHtml(r.macroregion || "—")}<br>
          DANE: ${escapeHtml(r.dane)}
        </div>
      `).join("");

      layer.bindPopup(`
        <div>
          <strong>${escapeHtml(p.municipio)}</strong><br>
          ${escapeHtml(p.departamento)}<br>
          Estado: ${escapeHtml(p.estado)}
          ${recordsHtml}
        </div>
      `);
    }
  }).addTo(map);

  renderLegend(visibleFeatures);
}

function renderLegend(visibleFeatures) {
  let legend = document.getElementById("legend");
  if (!legend) return;

  const counts = {
    "Emancipada": 0,
    "En proceso": 0,
    "Nueva ciudad": 0
  };

  visibleFeatures.forEach(f => {
    if (counts[f.properties.estado] !== undefined) counts[f.properties.estado]++;
  });

  legend.innerHTML = Object.entries(STATUS_META).map(([status, meta]) => `
    <div style="margin-bottom:6px; cursor:pointer; opacity:${filteredStatuses.has(status) ? 1 : 0.5}" data-status="${status}">
      <span style="display:inline-block;width:12px;height:12px;background:${meta.color};margin-right:6px;"></span>
      ${meta.label}: <strong>${counts[status] || 0}</strong>
    </div>
  `).join("") + `
    <div style="margin-top:10px;"><strong>Municipios con dato:</strong> ${visibleFeatures.length}</div>
    <div><strong>Registros Sheets:</strong> ${sheetRows.length}</div>
    <div><strong>No ubicados:</strong> ${unmatchedRows.length}</div>
  `;

  legend.querySelectorAll("[data-status]").forEach(el => {
    el.addEventListener("click", () => {
      const status = el.dataset.status;
      if (filteredStatuses.has(status)) {
        if (filteredStatuses.size === 1) return;
        filteredStatuses.delete(status);
      } else {
        filteredStatuses.add(status);
      }
      renderMap();
    });
  });
}

function fitIfNeeded() {
  if (!geoLayer) return;
  const bounds = geoLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[char]));
}
