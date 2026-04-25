(() => {
  /* ─── CONFIGURACIÓN ──────────────────────────────────────────────────────── */
  const STATUS_META = {
    "Emancipada":  { color: "#F2D46B", label: "Iglesias emancipadas" },
    "En proceso":  { color: "#4A90E2", label: "Iglesias por emancipar" },
    "Nueva ciudad":{ color: "#D64541", label: "Por conquistar" }
  };
  const ACTIVE_DEFAULT  = ["Emancipada", "En proceso", "Nueva ciudad"];
  const STORAGE_KEY     = "mapa_colombia_v3_active_filters";
  const GEOJSON_URL     = "./data/colombia-municipios.geojson";

  // ── PEGA AQUÍ TU URL DE APPS SCRIPT (o deja vacío para modo solo-GeoJSON) ──
  const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbzShr_GWx8LPk_-R04YV3LbVjGY_FB0UE_89YW9SPJRluqMVEFAwVmqQ5E9zvyewC9DlA/exec";
  // ─────────────────────────────────────────────────────────────────────────

  /* ─── ESTADO ─────────────────────────────────────────────────────────────── */
  let active       = loadActiveFilters();
  let selectedDane = null;
  let geoLayer     = null;
  let labelLayer   = null;
  let allGeoFeatures  = [];   // TODOS los municipios del GeoJSON (base gris)
  let allFeatures     = [];   // Solo los municipios con dato de Sheets (coloreados)
  let sheetRows       = [];
  let unmatchedRows   = [];

  /* ─── DOM ────────────────────────────────────────────────────────────────── */
  const loadingBanner   = document.getElementById("loadingBanner");
  const errorBanner     = document.getElementById("errorBanner");
  const detailPanel     = document.getElementById("detailPanel");
  const datalist        = document.getElementById("municipios");
  const unmatchedList   = document.getElementById("unmatchedList");
  const legendContainer = document.getElementById("legendContainer");

  /* ─── MAPA ───────────────────────────────────────────────────────────────── */
  const map = L.map("map", {
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    attributionControl: false
  }).setView([4.5, -74], 6);

  // Fondo neutro sin etiquetas para que los colores propios no compitan
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    maxZoom: 18
  }).addTo(map);

  /* ─── ARRANQUE ───────────────────────────────────────────────────────────── */
  init().catch(showError);

  async function init() {
    // 1. Siempre carga el GeoJSON local
    const geoPromise = fetch(GEOJSON_URL, { cache: "no-cache" })
      .then(r => {
        if (!r.ok) throw new Error("No fue posible cargar ./data/colombia-municipios.geojson");
        return r.json();
      });

    // 2. Intenta cargar Google Sheets solo si la URL es real
    const sheetsPromise = (SHEETS_ENDPOINT && !SHEETS_ENDPOINT.includes("PEGAR_AQUI_URL_EXEC"))
      ? fetch(SHEETS_ENDPOINT, { cache: "no-cache" }).then(r => {
          if (!r.ok) throw new Error("No fue posible cargar Google Sheets");
          return r.json();
        })
      : Promise.resolve([]);

    const [geojson, sheetsPayload] = await Promise.all([geoPromise, sheetsPromise]);

    if (!geojson?.features?.length) {
      throw new Error("El GeoJSON local no es válido o está vacío.");
    }

    // FIX 1 ── Guarda TODOS los polígonos del GeoJSON para pintar el fondo gris
    allGeoFeatures = geojson.features;

    sheetRows = normalizeSheetRows(sheetsPayload);
    const merged = mergeGeoWithSheets(geojson.features, sheetRows);
    allFeatures   = merged.features;
    unmatchedRows = merged.unmatched;

    renderUnmatched();
    hydrateDatalist();
    bindUi();

    // FIX 2 ── Renderiza el mapa con todos los polígonos grises + coloreados encima
    renderMap();

    loadingBanner.classList.add("hidden");
    document.body.classList.remove("loading");
  }

  /* ─── UI ─────────────────────────────────────────────────────────────────── */
  function bindUi() {
    document.getElementById("zoomIn") .addEventListener("click", () => map.zoomIn(0.5));
    document.getElementById("zoomOut").addEventListener("click", () => map.zoomOut(0.5));
    document.getElementById("fitAll") .addEventListener("click", fitAllVisible);

    document.getElementById("searchBtn").addEventListener("click", searchAndFocus);
    document.getElementById("searchInput").addEventListener("keydown", e => {
      if (e.key === "Enter") searchAndFocus();
    });

    document.getElementById("resetBtn").addEventListener("click", () => {
      active = new Set(ACTIVE_DEFAULT);
      selectedDane = null;
      persistActiveFilters();
      document.getElementById("searchInput").value = "";
      renderDetail(null);
      renderMap();
    });

    document.querySelectorAll(".filter-btn[data-status]").forEach(btn => {
      btn.classList.toggle("active", active.has(btn.dataset.status));
      btn.addEventListener("click", () => {
        const status = btn.dataset.status;
        if (active.has(status)) {
          if (active.size === 1) return; // Siempre al menos uno activo
          active.delete(status);
        } else {
          active.add(status);
        }
        // Deseleccionar si el estado activo fue eliminado del filtro
        if (selectedDane) {
          const current = allFeatures.find(f => f.properties.dane === selectedDane);
          if (current && !active.has(current.properties.estado)) selectedDane = null;
        }
        persistActiveFilters();
        renderMap();
        renderDetail(selectedDane
          ? allFeatures.find(f => f.properties.dane === selectedDane) ?? null
          : null
        );
      });
    });

    map.on("zoomend", updateLabels);
    map.on("click",   () => { selectedDane = null; renderDetail(null); renderMap(); });
  }

  /* ─── DATOS ──────────────────────────────────────────────────────────────── */
  function normalizeSheetRows(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.rows) ? payload.rows : []);

    return rows
      .map(row => ({
        dane:           String(row.dane          ?? "").trim().padStart(5, "0"),
        ubicacion:      String(row.ubicacion     ?? "").trim(),
        municipio_mapa: String(row.municipio_mapa?? "").trim(),
        departamento:   String(row.departamento  ?? "").trim(),
        estado:         String(row.estado        ?? "").trim(),
        region:         String(row.region        ?? "").trim(),
        macroregion:    String(row.macroregion   ?? "").trim()
      }))
      .filter(row => row.dane && ACTIVE_DEFAULT.includes(row.estado));
  }

  function mergeGeoWithSheets(features, rows) {
    const rowsByDane = new Map();
    rows.forEach(row => {
      if (!rowsByDane.has(row.dane)) rowsByDane.set(row.dane, []);
      rowsByDane.get(row.dane).push(row);
    });

    const geoDaneSet    = new Set();
    const mergedFeatures = [];

    for (const feature of features) {
      const props = feature.properties || {};
      // FIX 3 ── Normalización robusta del código DANE del GeoJSON
      const raw  = String(
        props.dane         ??
        props.DANE         ??
        props.COD_MPIO     ??
        props.CODIGO_DANE  ??
        props.codigo       ??
        ""
      ).trim();
      const dane = raw.padStart(5, "0");
      if (!dane || dane === "00000") continue;

      geoDaneSet.add(dane);
      const rowsForDane = rowsByDane.get(dane);
      if (!rowsForDane?.length) continue;

      const municipio   = props.municipio || props.NOM_MPIO || props.name
                          || rowsForDane[0].municipio_mapa || rowsForDane[0].ubicacion || dane;
      const departamento= props.departamento || props.NOM_DPTO || rowsForDane[0].departamento || "";
      const estado      = rowsForDane[0].estado;

      mergedFeatures.push({
        type:     "Feature",
        geometry: feature.geometry,
        properties: {
          dane, municipio, departamento, estado,
          color:   STATUS_META[estado].color,
          records: rowsForDane
        }
      });
    }

    const unmatched = rows
      .filter(row => !geoDaneSet.has(row.dane))
      .map(row => ({
        name:   row.ubicacion || row.municipio_mapa || row.dane,
        detail: `${row.departamento || "Sin departamento"} · ${row.estado} · DANE ${row.dane}`
      }));

    return { features: mergedFeatures, unmatched };
  }

  /* ─── RENDERIZADO DEL MAPA ───────────────────────────────────────────────── */
  function renderMap() {
    const visibleFeatures = allFeatures.filter(f => active.has(f.properties.estado));

    // Conjunto de DANE con dato para excluirlos de la capa base gris
    const daneConDato = new Set(allFeatures.map(f => f.properties.dane));

    if (geoLayer)   map.removeLayer(geoLayer);
    if (labelLayer) map.removeLayer(labelLayer);

    // ── Capa 1: todos los municipios en gris (fondo de referencia) ───────────
    // FIX 4 ── SIEMPRE muestra todos los polígonos de Colombia en gris
    //           aunque no haya datos de Sheets conectados
    const baseLayer = L.geoJSON(allGeoFeatures, {
      style: feature => {
        const dane = normDane(feature.properties);
        const isColored = daneConDato.has(dane);
        return {
          color:       isColored ? "transparent" : "#b0bcc8",
          weight:      isColored ? 0 : 0.5,
          fillColor:   "#dde4ec",
          fillOpacity: isColored ? 0 : 0.45
        };
      },
      // Sin interacción en la capa base
      interactive: false
    }).addTo(map);

    // ── Capa 2: municipios con dato de Sheets (coloreados, interactivos) ─────
    geoLayer = L.geoJSON(visibleFeatures, {
      style: feature => ({
        color:       selectedDane === feature.properties.dane ? "#243447" : "#6f7c89",
        weight:      selectedDane === feature.properties.dane ? 2 : 1,
        fillColor:   feature.properties.color,
        fillOpacity: 0.85
      }),
      onEachFeature: (feature, layer) => {
        layer.on("click", event => {
          L.DomEvent.stopPropagation(event);
          selectedDane = feature.properties.dane;
          renderDetail(feature);
          fitFeature(layer);
          renderMap();
        });
        layer.bindPopup(buildPopupHtml(feature.properties));
      }
    }).addTo(map);

    // ── Capa 3: etiquetas ────────────────────────────────────────────────────
    labelLayer = L.layerGroup(buildLabels(visibleFeatures)).addTo(map);

    renderLegend(visibleFeatures);
    updateCounts(visibleFeatures);
    updateFilterButtons();
    updateLabels();

    // FIX 5 ── Ajuste de vista inicial:
    //   • Si hay municipios coloreados -> ajusta a ellos
    //   • Si no hay datos (solo modo GeoJSON) -> ajusta a todos los polígonos
    if (visibleFeatures.length > 0 && !selectedDane) {
      fitAllVisible();
    } else if (allFeatures.length === 0 && !selectedDane) {
      // Sin Sheets: ajusta a todos los polígonos base
      const bounds = L.geoJSON(allGeoFeatures).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 7 });
    }
  }

  /* ─── ETIQUETAS ──────────────────────────────────────────────────────────── */
  function buildLabels(features) {
    return features
      .map(feature => {
        const center = featureCenter(feature);
        if (!center) return null;
        return L.marker(center, {
          interactive: false,
          icon: L.divIcon({
            className: "v3-label",
            html: escapeHtml(feature.properties.municipio)
          })
        });
      })
      .filter(Boolean);
  }

  function updateLabels() {
    if (!labelLayer) return;
    const zoom = map.getZoom();
    // FIX 6 ── Umbral de zoom ajustado: 7 en desktop, 9 en móvil
    const isMobile   = window.innerWidth < 768;
    const threshold  = isMobile ? 9 : 7;
    const show       = zoom >= threshold || !!selectedDane;
    labelLayer.eachLayer(layer => {
      const el = layer.getElement();
      if (el) el.style.display = show ? "block" : "none";
    });
  }

  /* ─── LEYENDA Y ESTADÍSTICAS ─────────────────────────────────────────────── */
  function renderLegend(visibleFeatures) {
    const counts = {};
    ACTIVE_DEFAULT.forEach(s => counts[s] = 0);
    visibleFeatures.forEach(f => counts[f.properties.estado]++);

    legendContainer.innerHTML = ACTIVE_DEFAULT.map(status => `
      <div class="legend-item" data-legend-status="${escapeHtml(status)}"
           style="opacity:${active.has(status) ? 1 : 0.5}">
        <div class="legend-left">
          <span class="swatch" style="background:${STATUS_META[status].color}"></span>
          <span>${escapeHtml(STATUS_META[status].label)}</span>
        </div>
        <strong>${counts[status] || 0}</strong>
      </div>
    `).join("");

    legendContainer.querySelectorAll("[data-legend-status]").forEach(item => {
      item.addEventListener("click", () => {
        const btn = document.querySelector(
          `.filter-btn[data-status="${CSS.escape(item.dataset.legendStatus)}"]`
        );
        if (btn) btn.click();
      });
    });
  }

  function updateCounts(visibleFeatures) {
    document.getElementById("count-municipios").textContent = visibleFeatures.length;
    document.getElementById("count-registros") .textContent = sheetRows.length;
    document.getElementById("count-unmatched") .textContent = unmatchedRows.length;
  }

  function updateFilterButtons() {
    document.querySelectorAll(".filter-btn[data-status]").forEach(btn => {
      const status = btn.dataset.status;
      btn.classList.toggle("active", active.has(status));
      btn.disabled = !allFeatures.some(f => f.properties.estado === status);
    });
  }

  /* ─── PANEL DE DETALLE ───────────────────────────────────────────────────── */
  function renderDetail(feature) {
    if (!feature) {
      detailPanel.innerHTML = `
        <h2>Detalle del municipio</h2>
        <p class="muted">Toca un municipio coloreado en el mapa para ver su información.</p>`;
      return;
    }
    const p = feature.properties;
    const recordsHtml = (p.records || []).map((rec, i) => `
      <div class="record">
        <h3>Registro ${i + 1} · ${escapeHtml(rec.ubicacion || p.municipio)}</h3>
        <p><strong>Municipio:</strong> ${escapeHtml(p.municipio)}</p>
        <p><strong>Departamento:</strong> ${escapeHtml(p.departamento)}</p>
        <p><strong>Estado:</strong> ${escapeHtml(rec.estado)}</p>
        <p><strong>Región PAC:</strong> ${escapeHtml(rec.region || "—")}</p>
        <p><strong>Macroregión:</strong> ${escapeHtml(rec.macroregion || "—")}</p>
        <p><strong>Código DANE:</strong> ${escapeHtml(rec.dane || p.dane)}</p>
      </div>`
    ).join("");

    detailPanel.innerHTML = `
      <h2>Detalle del municipio</h2>
      <div class="detail-title">
        <span class="detail-dot" style="background:${STATUS_META[p.estado]?.color || "#ccc"}"></span>
        <div>
          <div><strong>${escapeHtml(p.municipio)}</strong></div>
          <div class="muted">${escapeHtml(p.departamento)} · ${escapeHtml(p.estado)}</div>
        </div>
      </div>
      <div class="detail-list">${recordsHtml}</div>`;
  }

  /* ─── LISTA NO UBICADOS ──────────────────────────────────────────────────── */
  function renderUnmatched() {
    unmatchedList.innerHTML = unmatchedRows.length
      ? unmatchedRows.map(item =>
          `<li><strong>${escapeHtml(item.name)}</strong> <span>— ${escapeHtml(item.detail)}</span></li>`
        ).join("")
      : `<li><span class="muted">No hay registros no ubicados.</span></li>`;
  }

  /* ─── BÚSQUEDA ───────────────────────────────────────────────────────────── */
  function hydrateDatalist() {
    datalist.innerHTML = "";
    allFeatures
      .slice()
      .sort((a, b) => a.properties.municipio.localeCompare(b.properties.municipio, "es"))
      .forEach(feature => {
        const option = document.createElement("option");
        option.value = `${feature.properties.municipio} - ${feature.properties.departamento}`;
        datalist.appendChild(option);
      });
  }

  function searchAndFocus() {
    const q = normalize(document.getElementById("searchInput").value);
    if (!q) return;

    const found = allFeatures.find(feature => {
      const p = feature.properties;
      return (
        normalize(`${p.municipio} - ${p.departamento}`) === q ||
        normalize(p.municipio) === q ||
        normalize(p.departamento) === q ||
        normalize(`${p.municipio} ${p.departamento}`).includes(q)
      );
    });

    if (!found) {
      window.alert("No encontré ese municipio dentro de los municipios con dato.");
      return;
    }

    if (!active.has(found.properties.estado)) {
      active.add(found.properties.estado);
      persistActiveFilters();
    }
    selectedDane = found.properties.dane;
    renderDetail(found);
    renderMap();

    const bounds = featureBounds(found);
    if (bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  }

  /* ─── HELPERS DE VIEWPORT ────────────────────────────────────────────────── */
  function fitAllVisible() {
    if (!geoLayer) return;
    const bounds = geoLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 10 });
  }

  function fitFeature(layer) {
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  }

  function featureBounds(feature) {
    const temp   = L.geoJSON(feature);
    const bounds = temp.getBounds();
    return bounds.isValid() ? bounds : null;
  }

  function featureCenter(feature) {
    const bounds = featureBounds(feature);
    return bounds ? bounds.getCenter() : null;
  }

  /* ─── POPUP ──────────────────────────────────────────────────────────────── */
  function buildPopupHtml(p) {
    const recordsHtml = (p.records || []).map((r, i) => `
      <div style="margin-top:6px;">
        <strong>Registro ${i + 1}</strong><br>
        Ubicación: ${escapeHtml(r.ubicacion || p.municipio)}<br>
        Estado: ${escapeHtml(r.estado)}<br>
        Región: ${escapeHtml(r.region || "—")}<br>
        Macroregión: ${escapeHtml(r.macroregion || "—")}<br>
        DANE: ${escapeHtml(r.dane)}
      </div>`
    ).join("");
    return `<div>
      <strong>${escapeHtml(p.municipio)}</strong><br>
      ${escapeHtml(p.departamento)}<br>
      Estado: ${escapeHtml(p.estado)}
      ${recordsHtml}
    </div>`;
  }

  /* ─── UTILIDADES ─────────────────────────────────────────────────────────── */
  // FIX 7 ── Helper centralizado para extraer el DANE de cualquier GeoJSON
  function normDane(props) {
    const raw = String(
      props.dane        ??
      props.DANE        ??
      props.COD_MPIO    ??
      props.CODIGO_DANE ??
      props.codigo      ??
      ""
    ).trim();
    return raw.padStart(5, "0");
  }

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
    }[char]));
  }

  function loadActiveFilters() {
    try {
      const raw    = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set(ACTIVE_DEFAULT);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return new Set(ACTIVE_DEFAULT);
      return new Set(parsed.filter(s => ACTIVE_DEFAULT.includes(s)));
    } catch {
      return new Set(ACTIVE_DEFAULT);
    }
  }

  function persistActiveFilters() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...active]));
  }

  function showError(error) {
    console.error(error);
    loadingBanner.classList.add("hidden");
    errorBanner.textContent = `Error: ${error.message || error}`;
    errorBanner.classList.remove("hidden");
    document.body.classList.remove("loading");
  }
})();
