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
  const SHEETS_ENDPOINT = "PEGAR_AQUI_URL_EXEC";
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

    // Panel de estadísticas
    renderDashboard();

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
      .map(row => {
        // Normaliza fecha: acepta YYYY-MM-DD, DD/MM/YYYY o vacío
        const rawFecha = String(row.fecha_estado ?? row.fecha ?? "").trim();
        let fecha = null;
        if (rawFecha) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(rawFecha)) {
            fecha = rawFecha; // ya es YYYY-MM-DD
          } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawFecha)) {
            const [d, m, y] = rawFecha.split('/');
            fecha = `${y}-${m}-${d}`;
          }
        }
        return {
          dane:           String(row.dane          ?? "").trim().padStart(5, "0"),
          ubicacion:      String(row.ubicacion     ?? "").trim(),
          municipio_mapa: String(row.municipio_mapa?? "").trim(),
          departamento:   String(row.departamento  ?? "").trim(),
          estado:         String(row.estado        ?? "").trim(),
          region:         String(row.region        ?? "").trim(),
          macroregion:    String(row.macroregion   ?? "").trim(),
          fecha_estado:   fecha
        };
      })
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


  /* ─── PANEL DE ESTADÍSTICAS ─────────────────────────────────────────────── */

  function renderDashboard() {
    const grid    = document.getElementById('dashGrid');
    const updated = document.getElementById('dash-updated');
    if (!grid) return;

    const total_colombia = 1122; // municipios oficiales DANE
    const total_con_dato = allFeatures.length;

    // Conteos por estado
    const counts = { Emancipada: 0, 'En proceso': 0, 'Nueva ciudad': 0 };
    allFeatures.forEach(f => { if (counts[f.properties.estado] !== undefined) counts[f.properties.estado]++; });

    // Conteos por departamento
    const deptMap = {};
    allFeatures.forEach(f => {
      const d = toTitleCase(f.properties.departamento || 'Sin departamento');
      if (!deptMap[d]) deptMap[d] = { total: 0, Emancipada: 0, 'En proceso': 0, 'Nueva ciudad': 0 };
      deptMap[d].total++;
      if (counts[f.properties.estado] !== undefined) deptMap[d][f.properties.estado]++;
    });

    // Total municipios por departamento en el GeoJSON base
    const deptTotalMap = {};
    allGeoFeatures.forEach(f => {
      const d = toTitleCase(f.properties.departamento || 'Sin departamento');
      deptTotalMap[d] = (deptTotalMap[d] || 0) + 1;
    });

    const pct = (n, t) => t > 0 ? Math.round(n / t * 100) : 0;
    const pctEmanc  = pct(counts.Emancipada,    total_colombia);
    const pctProceso= pct(counts['En proceso'],  total_colombia);
    const pctNueva  = pct(counts['Nueva ciudad'],total_colombia);
    const pctTotal  = pct(total_con_dato,        total_colombia);

    // Departamentos ordenados por % emancipado
    const deptRows = Object.entries(deptMap)
      .map(([name, c]) => ({
        name,
        total: c.total,
        emanc: c.Emancipada,
        pct:   pct(c.Emancipada, deptTotalMap[name] || c.total)
      }))
      .sort((a, b) => b.pct - a.pct);

    // Top 5 departamentos más emancipados
    const top5 = deptRows.filter(d => d.emanc > 0).slice(0, 5);
    const maxEmanc = top5.length ? top5[0].emanc : 1;

    // Departamentos con al menos 1 municipio emancipado
    const deptConEmanc = deptRows.filter(d => d.emanc > 0).length;

    // ── Donut SVG ──────────────────────────────────────────────────────
    function donutSVG(slices) {
      // slices: [{pct, color}]
      const r = 38, cx = 48, cy = 48, stroke = 13;
      const circ = 2 * Math.PI * r;
      let offset = 0;
      let paths = '';
      slices.forEach(s => {
        const len = circ * s.pct / 100;
        paths += `<circle cx="${cx}" cy="${cy}" r="${r}"
          fill="none" stroke="${s.color}" stroke-width="${stroke}"
          stroke-dasharray="${len} ${circ - len}"
          stroke-dashoffset="${-offset}"
          transform="rotate(-90 ${cx} ${cy})" />`;
        offset += len;
      });
      const rem = circ * (100 - slices.reduce((a,s)=>a+s.pct,0)) / 100;
      if (rem > 0) {
        paths += `<circle cx="${cx}" cy="${cy}" r="${r}"
          fill="none" stroke="#eef1f6" stroke-width="${stroke}"
          stroke-dasharray="${rem} ${circ - rem}"
          stroke-dashoffset="${-offset}"
          transform="rotate(-90 ${cx} ${cy})" />`;
      }
      return `<svg viewBox="0 0 96 96" width="96" height="96">${paths}
        <text x="48" y="52" text-anchor="middle" font-size="15" font-weight="700"
          fill="#132238" font-family="DM Serif Display,serif">${pctTotal}%</text>
      </svg>`;
    }

    // ── Cards ──────────────────────────────────────────────────────────
    const cards = [

      // Card 1: Cobertura total
      `<div class="dash-card" style="--accent:var(--yellow)">
        <div class="dc-label">Cobertura total de Colombia</div>
        <div class="dc-value">${pctTotal}<span>%</span></div>
        <div class="dc-sub">
          <strong>${total_con_dato}</strong> de <strong>${total_colombia}</strong> municipios tienen registro activo.
        </div>
        <div class="dc-bar-wrap"><div class="dc-bar" style="width:${pctTotal}%;background:var(--yellow)"></div></div>
      </div>`,

      // Card 2: Distribución por estado (donut)
      `<div class="dash-card" style="--accent:#c8d8ea">
        <div class="dc-label">Distribución por estado</div>
        <div class="dc-donut-wrap">
          ${donutSVG([
            { pct: pctEmanc,   color: '#F2D46B' },
            { pct: pctProceso, color: '#4A90E2' },
            { pct: pctNueva,   color: '#D64541' }
          ])}
          <ul class="dc-donut-legend">
            <li><span class="dc-dot" style="background:#F2D46B"></span>
              <span>Emancipadas <strong>${counts.Emancipada}</strong> (${pctEmanc}%)</span></li>
            <li><span class="dc-dot" style="background:#4A90E2"></span>
              <span>Por emancipar <strong>${counts['En proceso']}</strong> (${pctProceso}%)</span></li>
            <li><span class="dc-dot" style="background:#D64541"></span>
              <span>Por conquistar <strong>${counts['Nueva ciudad']}</strong> (${pctNueva}%)</span></li>
          </ul>
        </div>
      </div>`,

      // Card 3: Departamentos con presencia
      `<div class="dash-card" style="--accent:var(--blue)">
        <div class="dc-label">Alcance departamental</div>
        <div class="dc-value">${deptConEmanc}<span> dep.</span></div>
        <div class="dc-sub">
          tienen al menos <strong>1 iglesia emancipada</strong>
          de <strong>${Object.keys(deptMap).length}</strong> con registro.
        </div>
        <div class="dc-bar-wrap"><div class="dc-bar"
          style="width:${pct(deptConEmanc,33)}%;background:var(--blue)"></div></div>
      </div>`,

      // Card 4: Top 5 departamentos
      `<div class="dash-card" style="--accent:var(--yellow); grid-column:span 1;">
        <div class="dc-label">Top departamentos — Emancipadas</div>
        <div class="dc-top-list">
          ${top5.map((d, i) => `
            <div class="dc-top-item">
              <div class="dc-top-rank">${i+1}</div>
              <div class="dc-top-info">
                <div class="dc-top-name">${escapeHtml(d.name)}</div>
                <div class="dc-top-dept">${d.emanc} municipio${d.emanc!==1?'s':''} emancipado${d.emanc!==1?'s':''}</div>
              </div>
              <div class="dc-top-bar-wrap">
                <div class="dc-top-bar" style="width:${Math.round(d.emanc/maxEmanc*100)}%;background:var(--yellow)"></div>
              </div>
            </div>`).join('')}
          ${top5.length === 0 ? '<p class="muted" style="margin:0">Sin datos aún.</p>' : ''}
        </div>
      </div>`,

      // Card 5: Cobertura por departamento
      `<div class="dash-card" style="--accent:var(--yellow); grid-column:span 2;">
        <div class="dc-label">% Emancipadas por departamento (sobre total municipios del GeoJSON)</div>
        <div class="dc-dept-grid">
          ${deptRows.filter(d=>d.emanc>0).map(d => `
            <div class="dc-dept-row">
              <div class="dc-dept-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
              <div class="dc-dept-bar-wrap">
                <div class="dc-dept-bar" style="width:${d.pct}%"></div>
              </div>
              <div class="dc-dept-pct">${d.pct}%</div>
            </div>`).join('')}
          ${deptRows.filter(d=>d.emanc>0).length === 0
            ? '<p class="muted" style="margin:0">Sin municipios emancipados aún.</p>' : ''}
        </div>
      </div>`,

    ];

    // ── Card 6: Tendencia (solo si hay datos con fecha) ─────────────────
    const rowsConFecha = sheetRows.filter(r => r.fecha_estado);
    if (rowsConFecha.length > 0) {
      cards.push(buildTrendCard(rowsConFecha));
    } else {
      cards.push(`<div class="dash-card" style="--accent:#c8d8ea; grid-column:span 1;">
        <div class="dc-label">Evolución en el tiempo</div>
        <div class="dc-sub" style="margin-top:8px;">
          Agrega la columna <strong>fecha_estado</strong> (formato <code>YYYY-MM-DD</code>) en Google Sheets
          para activar las gráficas de tendencia y comparación entre períodos.
        </div>
        <div class="dc-cta" style="margin-top:14px;">
          📋 Una fila por cada cambio de estado de un municipio, con su fecha.
          El panel calculará automáticamente deltas y tendencias.
        </div>
      </div>`);
    }

    grid.innerHTML = cards.join('');

    // Animar barras al entrar en viewport
    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.querySelectorAll('.dc-bar,.dc-top-bar,.dc-dept-bar').forEach(bar => {
            bar.style.transition = 'width .9s cubic-bezier(.16,1,.3,1)';
          });
          observer.unobserve(e.target);
        }
      });
    }, { threshold: 0.2 });
    grid.querySelectorAll('.dash-card').forEach(c => observer.observe(c));

    // Bind selector de rango (si existe la card de tendencia)
    const rangeSelect = document.getElementById('trendRange');
    if (rangeSelect) {
      rangeSelect.addEventListener('change', () => {
        const card = document.getElementById('trendCard');
        if (card) card.outerHTML = buildTrendCard(rowsConFecha);
        bindTrendSelector(rowsConFecha);
      });
    }

    // Timestamp
    if (updated) {
      const now = new Date();
      updated.textContent = `Actualizado: ${now.toLocaleDateString('es-CO',{day:'2-digit',month:'long',year:'numeric'})}`;
    }
  }

  /* ── Tendencia ──────────────────────────────────────────────────────── */

  // Fecha de inicio del registro (guardada en localStorage la primera vez que carga con datos)
  function getBaselineDate() {
    const stored = localStorage.getItem('colportaje_baseline_date');
    if (stored) return stored;
    // Primera vez: guarda hoy como línea base
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('colportaje_baseline_date', today);
    return today;
  }

  function buildTrendCard(rowsConFecha) {
    const rangeVal   = document.getElementById('trendRange')?.value ?? '1';
    const months     = parseInt(rangeVal, 10);
    const STATUS_COLOR = { Emancipada:'#F2D46B', 'En proceso':'#4A90E2', 'Nueva ciudad':'#D64541', '(nuevo)':'#aaa' };
    const rangeLabel = { '1':'1 mes', '3':'3 meses', '6':'6 meses', '12':'1 año' }[rangeVal] ?? `${rangeVal} meses`;

    const now    = new Date();
    const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - months);

    // ── Snapshot: estado más reciente de cada DANE antes de una fecha dada ──
    function snapshotAt(rows, before) {
      const map = new Map();
      rows
        .filter(r => new Date(r.fecha_estado) <= before)
        .sort((a,b) => a.fecha_estado.localeCompare(b.fecha_estado))
        .forEach(r => map.set(r.dane, r));
      return map;
    }

    function countByEstado(snap) {
      const c = { Emancipada: 0, 'En proceso': 0, 'Nueva ciudad': 0, total: 0 };
      snap.forEach(r => { if (c[r.estado] !== undefined) { c[r.estado]++; c.total++; } });
      return c;
    }

    const snapNow  = snapshotAt(rowsConFecha, now);
    const snapPrev = snapshotAt(rowsConFecha, cutoff);
    const cNow     = countByEstado(snapNow);
    const cPrev    = countByEstado(snapPrev);
    const hasPrev  = snapPrev.size > 0;

    // Cambios dentro del período seleccionado
    const cambios = [];
    snapNow.forEach((rNow, dane) => {
      const rPrev = snapPrev.get(dane);
      const enPeriodo = new Date(rNow.fecha_estado) > cutoff;
      if (enPeriodo && (!rPrev || rPrev.estado !== rNow.estado)) {
        cambios.push({
          municipio:    rNow.ubicacion || rNow.municipio_mapa || dane,
          departamento: rNow.departamento || '',
          de:           rPrev?.estado ?? '(nuevo)',
          a:            rNow.estado,
          fecha:        rNow.fecha_estado
        });
      }
    });
    cambios.sort((a,b) => b.fecha.localeCompare(a.fecha));

    function delta(now, prev) {
      if (!hasPrev) return `<span class="td-neutral">—</span>`;
      const d = now - prev;
      if (d === 0) return `<span class="td-neutral">sin cambio</span>`;
      return d > 0 ? `<span class="td-up">+${d}</span>` : `<span class="td-down">${d}</span>`;
    }

    const fmtDate = iso => { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; };
    const baselineDate = getBaselineDate();

    // ── Mensaje de estado del historial ──
    const oldestFecha = rowsConFecha.reduce((min, r) => r.fecha_estado < min ? r.fecha_estado : min, rowsConFecha[0].fecha_estado);
    const diasDeHistorial = Math.floor((now - new Date(oldestFecha)) / 86400000);
    const diasParaComparar = months * 30;
    const pctListo = Math.min(100, Math.round(diasDeHistorial / diasParaComparar * 100));
    const tieneComparacion = diasDeHistorial >= diasParaComparar;

    return `<div class="dash-card trend-card" id="trendCard" style="--accent:var(--blue); grid-column:span 3;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
        <div class="dc-label" style="margin:0;">Evolución en el tiempo</div>
        <select id="trendRange" class="trend-select">
          <option value="1"  ${rangeVal==='1'?'selected':''}>Último mes vs mes anterior</option>
          <option value="3"  ${rangeVal==='3'?'selected':''}>Últimos 3 meses vs 3 anteriores</option>
          <option value="6"  ${rangeVal==='6'?'selected':''}>Últimos 6 meses vs 6 anteriores</option>
          <option value="12" ${rangeVal==='12'?'selected':''}>Último año vs año anterior</option>
        </select>
      </div>

      ${!tieneComparacion ? `
      <div class="trend-onboarding">
        <div class="trend-ob-title">📅 Acumulando historial desde ${fmtDate(baselineDate)}</div>
        <p class="trend-ob-desc">
          Cuando haya <strong>${rangeLabel}</strong> de datos registrados, aparecerá aquí la comparación automática
          contra el período anterior. Por ahora puedes ver el estado actual.
        </p>
        <div class="dc-bar-wrap" style="margin:12px 0 4px;">
          <div class="dc-bar" style="width:${pctListo}%;background:var(--blue);transition:width .9s cubic-bezier(.16,1,.3,1)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);">
          <span>Inicio: ${fmtDate(oldestFecha)}</span>
          <span>${pctListo}% del período acumulado (${diasDeHistorial} día${diasDeHistorial!==1?'s':''})</span>
          <span>Meta: ${rangeLabel}</span>
        </div>
      </div>` : ''}

      <div class="trend-grid" style="margin-top:${!tieneComparacion?'16px':'0'};">
        ${['Emancipada','En proceso','Nueva ciudad'].map(est => `
          <div class="trend-stat">
            <div class="trend-swatch" style="background:${STATUS_COLOR[est]}"></div>
            <div class="trend-label">${est==='Emancipada'?'Emancipadas':est==='En proceso'?'Por emancipar':'Por conquistar'}</div>
            <div class="trend-value">${cNow[est]}</div>
            <div class="trend-delta">
              ${tieneComparacion ? delta(cNow[est], cPrev[est]) + ' en ' + rangeLabel
                : `<span class="td-neutral">línea base: ${cNow[est]}</span>`}
            </div>
          </div>`).join('')}
        <div class="trend-stat">
          <div class="trend-swatch" style="background:var(--text);opacity:.3"></div>
          <div class="trend-label">Total registrados</div>
          <div class="trend-value">${cNow.total}</div>
          <div class="trend-delta">
            ${tieneComparacion ? delta(cNow.total, cPrev.total) + ' en ' + rangeLabel
              : `<span class="td-neutral">línea base: ${cNow.total}</span>`}
          </div>
        </div>
      </div>

      ${cambios.length > 0 ? `
      <div style="margin-top:20px;">
        <div class="dc-label" style="margin-bottom:10px;">
          Cambios en los últimos ${rangeLabel}
          <span style="font-weight:400;text-transform:none;letter-spacing:0;">(${cambios.length} municipio${cambios.length!==1?'s':''})</span>
        </div>
        <div class="cambios-list">
          ${cambios.slice(0,10).map(c => `
            <div class="cambio-row">
              <div class="cambio-fecha">${fmtDate(c.fecha)}</div>
              <div class="cambio-info">
                <strong>${escapeHtml(c.municipio)}</strong>
                <span class="cambio-dept">${escapeHtml(c.departamento)}</span>
              </div>
              <div class="cambio-estados">
                <span class="cambio-badge" style="background:${STATUS_COLOR[c.de]}22;color:${c.de==='#F2D46B'?'#7a5c00':STATUS_COLOR[c.de]};border:1px solid ${STATUS_COLOR[c.de]}44">
                  ${escapeHtml(c.de)}
                </span>
                <span class="cambio-arrow">→</span>
                <span class="cambio-badge" style="background:${STATUS_COLOR[c.a]}22;color:${STATUS_COLOR[c.a]==='#F2D46B'?'#7a5c00':STATUS_COLOR[c.a]};border:1px solid ${STATUS_COLOR[c.a]}44">
                  ${escapeHtml(c.a)}
                </span>
              </div>
            </div>`).join('')}
          ${cambios.length > 10 ? `<p class="muted" style="text-align:center;margin:8px 0 0;">
            +${cambios.length-10} cambios más en este período</p>` : ''}
        </div>
      </div>` : tieneComparacion ? `
      <p class="muted" style="margin-top:14px;">Sin cambios de estado en los últimos ${rangeLabel}.</p>` : ''}

      <div class="trend-instrucciones">
        <strong>¿Cómo registrar un cambio?</strong> En Google Sheets, agrega una fila nueva con el municipio,
        su nuevo estado y la fecha de hoy en la columna <code>fecha_estado</code> (formato <code>YYYY-MM-DD</code>).
        No borres la fila anterior — el historial se construye acumulando filas.
      </div>
    </div>`;
  }

  function bindTrendSelector(rowsConFecha) {
    const sel = document.getElementById('trendRange');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const card = document.getElementById('trendCard');
      if (!card) return;
      card.outerHTML = buildTrendCard(rowsConFecha);
      bindTrendSelector(rowsConFecha);
    });
  }

  function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

})();
