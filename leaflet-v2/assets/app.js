// ===============================
// CONFIG
// ===============================
const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbzShr_GWx8LPk_-R04YV3LbVjGY_FB0UE_89YW9SPJRluqMVEFAwVmqQ5E9zvyewC9DlA/exec";

// ===============================
// COLORES
// ===============================
function statusColor(status) {
  switch (status) {
    case "Emancipada": return "#2ecc71";
    case "En proceso": return "#f1c40f";
    case "Nueva ciudad": return "#3498db";
    default: return "#bdc3c7";
  }
}

// ===============================
// MAPA BASE
// ===============================
const map = L.map('map').setView([4.5, -74], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18
}).addTo(map);

// ===============================
// CARGA BASE + SHEETS
// ===============================
async function loadData() {
  try {
    const [baseRes, sheetRes] = await Promise.all([
      fetch('data/municipalities.json'),
      fetch(SHEETS_ENDPOINT)
    ]);

    const base = await baseRes.json();
    const sheet = await sheetRes.json();

    const rows = sheet.rows || sheet; // soporta ambos formatos

    const sheetMap = new Map();
    rows.forEach(r => {
      if (r.dane) {
        sheetMap.set(String(r.dane).trim(), r);
      }
    });

    let matched = 0;

    base.forEach(m => {
      const code = String(m.code).trim();
      const match = sheetMap.get(code);

      if (match) {
        matched++;
        m.status = match.estado;
        m.color = statusColor(match.estado);
      } else {
        m.color = m.color || statusColor(m.status);
      }
    });

    console.log("Matches:", matched);

    drawMap(base);

  } catch (err) {
    console.error("Error cargando datos:", err);
  }
}

// ===============================
// DIBUJAR MAPA
// ===============================
function drawMap(data) {

  fetch('data/map-paths.html')
    .then(res => res.text())
    .then(svgText => {

      const parser = new DOMParser();
      const doc = parser.parseFromString(svgText, "text/html");
      const paths = doc.querySelectorAll("path");

      paths.forEach(path => {
        const code = path.getAttribute("data-code");

        const match = data.find(d => String(d.code) === String(code));

        if (match) {
          path.setAttribute("fill", match.color || "#ccc");

          path.addEventListener("click", () => {
            alert(`${match.municipio}\nEstado: ${match.status || "Sin estado"}`);
          });
        }
      });

      const container = document.getElementById("map");
      container.innerHTML = "";
      container.appendChild(doc.body.firstChild);

    });
}

// ===============================
// INIT
// ===============================
loadData();
