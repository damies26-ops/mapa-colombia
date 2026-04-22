(() => {
  const STATUS_META = {
    "Emancipada": { color: "#F2D46B", label: "Iglesias emancipadas", short: "Emancipadas" },
    "En proceso": { color: "#4A90E2", label: "Iglesias por emancipar", short: "Por emancipar" },
    "Nueva ciudad": { color: "#D64541", label: "Por conquistar", short: "Por conquistar" }
  };
  const ACTIVE_DEFAULT = ["Emancipada", "En proceso", "Nueva ciudad"];
  const STORAGE_KEY = "mapa_colombia_v3_active_filters";
  const SHEETS_ENDPOINT = "PEGAR_AQUI_URL_EXEC";
  const GEOJSON_URL = "./data/colombia-municipios.geojson";

  let active = loadActiveFilters();
  let selectedDane = null;
  let geoLayer = null;
  let labelLayer = null;
  let allFeatures = [];
  let sheetRows = [];
  let unmatchedRows = [];

  const loadingBanner = document.getElementById("loadingBanner");
  const errorBanner = document.getElementById("errorBanner");
  const detailPanel = document.getElementById("detailPanel");
  const datalist = document.getElementById("municipios");
  const unmatchedList = document.getElementById("unmatchedList");
  const legendContainer = document.getElementById("legendContainer");

  const map = L.map("map", { zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false }).setView([4.5, -74], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 18 }).addTo(map);
  init().catch(showError);

  async function init() {
    const requests = [fetch(GEOJSON_URL, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("No fue posible cargar ./data/colombia-municipios.geojson"); return r.json(); })];
    if (SHEETS_ENDPOINT && !SHEETS_ENDPOINT.includes("PEGAR_AQUI_URL_EXEC")) {
      requests.push(fetch(SHEETS_ENDPOINT, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("No fue posible cargar Google Sheets"); return r.json(); }));
    } else {
      requests.push(Promise.resolve([]));
    }
    const [geojson, sheetsPayload] = await Promise.all(requests);
    if (!geojson || !Array.isArray(geojson.features)) throw new Error("El GeoJSON local no es válido o no contiene features.");
    if (geojson.features.length === 0) throw new Error("El archivo colombia-municipios.geojson está vacío. Debes reemplazar el archivo de muestra por la capa completa.");
    sheetRows = normalizeSheetRows(sheetsPayload);
    const merged = mergeGeoWithSheets(geojson.features, sheetRows);
    allFeatures = merged.features;
    unmatchedRows = merged.unmatched;
    renderUnmatched();
    hydrateDatalist();
    bindUi();
    renderMap();
    loadingBanner.classList.add("hidden");
    document.body.classList.remove("loading");
  }

  function bindUi() {
    document.getElementById("zoomIn").addEventListener("click", () => map.zoomIn(0.5));
    document.getElementById("zoomOut").addEventListener("click", () => map.zoomOut(0.5));
    document.getElementById("fitAll").addEventListener("click", fitAllVisible);
    document.getElementById("searchBtn").addEventListener("click", searchAndFocus);
    document.getElementById("searchInput").addEventListener("keydown", event => { if (event.key === "Enter") searchAndFocus(); });
    document.getElementById("resetBtn").addEventListener("click", () => {
      active = new Set(ACTIVE_DEFAULT); selectedDane = null; persistActiveFilters(); document.getElementById("searchInput").value = ""; renderDetail(null); renderMap();
    });
    document.querySelectorAll(".filter-btn[data-status]").forEach(btn => {
      btn.classList.toggle("active", active.has(btn.dataset.status));
      btn.addEventListener("click", () => {
        const status = btn.dataset.status;
        if (active.has(status)) { if (active.size === 1) return; active.delete(status); } else { active.add(status); }
        if (selectedDane) {
          const current = allFeatures.find(f => f.properties.dane === selectedDane);
          if (current && !active.has(current.properties.estado)) selectedDane = null;
        }
        persistActiveFilters(); renderMap(); renderDetail(selectedDane ? allFeatures.find(f => f.properties.dane === selectedDane) : null);
      });
    });
    map.on("zoomend", updateLabels);
    map.on("click", () => { selectedDane = null; renderDetail(null); renderMap(); });
  }

  function normalizeSheetRows(payload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.rows) ? payload.rows : []);
    return rows.map(row => ({
      dane: String(row.dane ?? "").trim().padStart(5, "0"),
      ubicacion: String(row.ubicacion ?? "").trim(),
      municipio_mapa: String(row.municipio_mapa ?? "").trim(),
      departamento: String(row.departamento ?? "").trim(),
      estado: String(row.estado ?? "").trim(),
      region: String(row.region ?? "").trim(),
      macroregion: String(row.macroregion ?? "").trim()
    })).filter(row => row.dane && ACTIVE_DEFAULT.includes(row.estado));
  }

  function mergeGeoWithSheets(features, rows) {
    const rowsByDane = new Map();
    rows.forEach(row => { if (!rowsByDane.has(row.dane)) rowsByDane.set(row.dane, []); rowsByDane.get(row.dane).push(row); });
    const geoDaneSet = new Set();
    const mergedFeatures = [];
    for (const feature of features) {
      const props = feature.properties || {};
      const dane = String(props.COD_MPIO ?? props.CODIGO_DANE ?? props.DANE ?? props.dane ?? props.codigo ?? "").trim().padStart(5, "0");
      if (!dane) continue;
      geoDaneSet.add(dane);
      const rowsForDane = rowsByDane.get(dane);
      if (!rowsForDane || rowsForDane.length === 0) continue;
      const municipio = props.NOM_MPIO || props.municipio || props.name || rowsForDane[0].municipio_mapa || rowsForDane[0].ubicacion || dane;
      const departamento = props.NOM_DPTO || props.departamento || rowsForDane[0].departamento || "";
      const estado = rowsForDane[0].estado;
      mergedFeatures.push({ type: "Feature", geometry: feature.geometry, properties: { dane, municipio, departamento, estado, color: STATUS_META[estado].color, records: rowsForDane } });
    }
    const unmatched = rows.filter(row => !geoDaneSet.has(row.dane)).map(row => ({ name: row.ubicacion || row.municipio_mapa || row.dane, detail: `${row.departamento || "Sin departamento"} · ${row.estado} · DANE ${row.dane}` }));
    return { features: mergedFeatures, unmatched };
  }

  function renderMap() {
    const visibleFeatures = allFeatures.filter(f => active.has(f.properties.estado));
    if (geoLayer) map.removeLayer(geoLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    geoLayer = L.geoJSON(visibleFeatures, {
      style: feature => ({ color: selectedDane === feature.properties.dane ? "#243447" : "#6f7c89", weight: selectedDane === feature.properties.dane ? 2 : 1, fillColor: feature.properties.color, fillOpacity: active.has(feature.properties.estado) ? 0.82 : 0.25 }),
      onEachFeature: (feature, layer) => {
        layer.on("click", event => { L.DomEvent.stopPropagation(event); selectedDane = feature.properties.dane; renderDetail(feature); fitFeature(layer); renderMap(); });
        layer.bindPopup(buildPopupHtml(feature.properties));
      }
    }).addTo(map);
    labelLayer = L.layerGroup(buildLabels(visibleFeatures)).addTo(map);
    renderLegend(visibleFeatures); updateCounts(visibleFeatures); updateFilterButtons(); updateLabels();
    if (visibleFeatures.length > 0 && !selectedDane) fitAllVisible();
  }

  function buildLabels(features) {
    return features.map(feature => {
      const center = featureCenter(feature); if (!center) return null;
      return L.marker(center, { interactive: false, icon: L.divIcon({ className: "v3-label", html: escapeHtml(feature.properties.municipio) }) });
    }).filter(Boolean);
  }

  function updateLabels() {
    if (!labelLayer) return; const zoom = map.getZoom(); const show = zoom >= 8 || !!selectedDane;
    labelLayer.eachLayer(layer => { const el = layer.getElement(); if (el) el.style.display = show ? "block" : "none"; });
  }

  function renderLegend(visibleFeatures) {
    if (!legendContainer) return;
    const counts = {}; ACTIVE_DEFAULT.forEach(status => counts[status] = 0); visibleFeatures.forEach(f => { if (counts[f.properties.estado] !== undefined) counts[f.properties.estado] += 1; });
    legendContainer.innerHTML = ACTIVE_DEFAULT.map(status => `<div class="legend-item" data-legend-status="${escapeHtml(status)}" style="opacity:${active.has(status) ? 1 : 0.5}"><div class="legend-left"><span class="swatch" style="background:${STATUS_META[status].color}"></span><span>${escapeHtml(STATUS_META[status].label)}</span></div><strong>${counts[status] || 0}</strong></div>`).join("");
    legendContainer.querySelectorAll("[data-legend-status]").forEach(item => { item.addEventListener("click", () => { const status = item.dataset.legendStatus; const btn = document.querySelector(`.filter-btn[data-status="${status}"]`); if (btn) btn.click(); }); });
  }

  function updateCounts(visibleFeatures) {
    document.getElementById("count-municipios").textContent = visibleFeatures.length;
    document.getElementById("count-registros").textContent = sheetRows.length;
    document.getElementById("count-unmatched").textContent = unmatchedRows.length;
  }

  function updateFilterButtons() {
    document.querySelectorAll(".filter-btn[data-status]").forEach(btn => { const status = btn.dataset.status; btn.classList.toggle("active", active.has(status)); btn.disabled = !allFeatures.some(f => f.properties.estado === status); });
  }

  function renderDetail(feature) {
    if (!feature) { detailPanel.innerHTML = `<h2>Detalle del municipio</h2><p class="muted">Toca un municipio coloreado en el mapa para ver su información.</p>`; return; }
    const p = feature.properties;
    const recordsHtml = (p.records || []).map((record, index) => `<div class="record"><h3>Registro ${index + 1} · ${escapeHtml(record.ubicacion || p.municipio)}</h3><p><strong>Municipio:</strong> ${escapeHtml(p.municipio)}</p><p><strong>Departamento:</strong> ${escapeHtml(p.departamento)}</p><p><strong>Estado:</strong> ${escapeHtml(record.estado)}</p><p><strong>Región PAC:</strong> ${escapeHtml(record.region || "—")}</p><p><strong>Macroregión:</strong> ${escapeHtml(record.macroregion || "—")}</p><p><strong>Código DANE:</strong> ${escapeHtml(record.dane || p.dane)}</p></div>`).join("");
    detailPanel.innerHTML = `<h2>Detalle del municipio</h2><div class="detail-title"><span class="detail-dot" style="background:${STATUS_META[p.estado]?.color || "#ccc"}"></span><div><div><strong>${escapeHtml(p.municipio)}</strong></div><div class="muted">${escapeHtml(p.departamento)} · ${escapeHtml(p.estado)}</div></div></div><div class="detail-list">${recordsHtml}</div>`;
  }

  function renderUnmatched() {
    unmatchedList.innerHTML = unmatchedRows.length ? unmatchedRows.map(item => `<li><strong>${escapeHtml(item.name)}</strong> <span>— ${escapeHtml(item.detail)}</span></li>`).join("") : `<li><span class="muted">No hay registros no ubicados.</span></li>`;
  }

  function hydrateDatalist() {
    datalist.innerHTML = "";
    allFeatures.slice().sort((a, b) => a.properties.municipio.localeCompare(b.properties.municipio, "es")).forEach(feature => { const option = document.createElement("option"); option.value = `${feature.properties.municipio} - ${feature.properties.departamento}`; datalist.appendChild(option); });
  }

  function searchAndFocus() {
    const q = normalize(document.getElementById("searchInput").value); if (!q) return;
    const found = allFeatures.find(feature => { const p = feature.properties; return normalize(`${p.municipio} - ${p.departamento}`) === q || normalize(p.municipio) === q || normalize(p.departamento) === q || normalize(`${p.municipio} ${p.departamento}`).includes(q); });
    if (!found) { window.alert("No encontré ese municipio o departamento dentro de los municipios con dato."); return; }
    if (!active.has(found.properties.estado)) { active.add(found.properties.estado); persistActiveFilters(); }
    selectedDane = found.properties.dane; renderDetail(found); renderMap();
    const bounds = featureBounds(found); if (bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  }

  function fitAllVisible() { if (!geoLayer) return; const bounds = geoLayer.getBounds(); if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 10 }); }
  function fitFeature(layer) { const bounds = layer.getBounds(); if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 }); }
  function featureBounds(feature) { const temp = L.geoJSON(feature); const bounds = temp.getBounds(); return bounds.isValid() ? bounds : null; }
  function featureCenter(feature) { const bounds = featureBounds(feature); return bounds ? bounds.getCenter() : null; }
  function buildPopupHtml(p) { const recordsHtml = (p.records || []).map((r, i) => `<div style="margin-top:6px;"><strong>Registro ${i + 1}</strong><br>Ubicación: ${escapeHtml(r.ubicacion || p.municipio)}<br>Estado: ${escapeHtml(r.estado)}<br>Región: ${escapeHtml(r.region || "—")}<br>Macroregión: ${escapeHtml(r.macroregion || "—")}<br>DANE: ${escapeHtml(r.dane)}</div>`).join(""); return `<div><strong>${escapeHtml(p.municipio)}</strong><br>${escapeHtml(p.departamento)}<br>Estado: ${escapeHtml(p.estado)}${recordsHtml}</div>`; }
  function normalize(value) { return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])); }
  function loadActiveFilters() { try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return new Set(ACTIVE_DEFAULT); const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.length === 0) return new Set(ACTIVE_DEFAULT); return new Set(parsed.filter(status => ACTIVE_DEFAULT.includes(status))); } catch { return new Set(ACTIVE_DEFAULT); } }
  function persistActiveFilters() { localStorage.setItem(STORAGE_KEY, JSON.stringify([...active])); }
  function showError(error) { console.error(error); loadingBanner.classList.add("hidden"); errorBanner.textContent = `Error cargando la V3: ${error.message || error}`; errorBanner.classList.remove("hidden"); document.body.classList.remove("loading"); }
})();