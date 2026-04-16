(() => {
  const WIDTH = 1000;
  const HEIGHT = 1400;
  const STATUS_META = {
    "Emancipada": { color: "#F2D46B", label: "Iglesias emancipadas" },
    "En proceso": { color: "#4A90E2", label: "Iglesias por emancipar" },
    "Nueva ciudad": { color: "#D64541", label: "Por conquistar" }
  };
  const STORAGE_KEY = "mapa_colombia_active_filters_v1";
  const ACTIVE_DEFAULT = ["Emancipada", "En proceso", "Nueva ciudad"];
  const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbzShr_GWx8LPk_-R04YV3LbVjGY_FB0UE_89YW9SPJRluqMVEFAwVmqQ5E9zvyewC9DlA/exec";

  let municipalities = [];
  let muniByCode = {};
  let unmatched = [];
  let pathsMarkup = "";
  let active = loadActiveFilters();
  let selectedCode = null;
  let svgRoot = null;

  const loadingBanner = document.getElementById("loadingBanner");
  const errorBanner = document.getElementById("errorBanner");
  const detailPanel = document.getElementById("detailPanel");
  const datalist = document.getElementById("municipios");
  const unmatchedList = document.getElementById("unmatchedList");

  const map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: -0.2,
    maxZoom: 5,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    attributionControl: false
  });

  const bounds = [[0, 0], [HEIGHT, WIDTH]];
  let overlay = null;

  init().catch(showError);

  async function init() {
    const requests = [
      fetch("./data/municipalities.json", { cache: "no-cache" }),
      fetch("./data/unmatched.json", { cache: "no-cache" }),
      fetch("./data/map-paths.html", { cache: "no-cache" })
    ];

    if (SHEETS_ENDPOINT && !SHEETS_ENDPOINT.includes("PEGAR_AQUI_URL_EXEC")) {
      requests.push(fetch(SHEETS_ENDPOINT, { cache: "no-cache" }));
    }

    const responses = await Promise.all(requests);
    const [municipalitiesResp, unmatchedResp, pathsResp, sheetsResp] = responses;

    if (!municipalitiesResp.ok || !unmatchedResp.ok || !pathsResp.ok) {
      throw new Error("No fue posible cargar uno o más archivos base del mapa.");
    }

    const baseMunicipalities = await municipalitiesResp.json();
    const baseUnmatched = await unmatchedResp.json();
    pathsMarkup = await pathsResp.text();

    let finalMunicipalities = baseMunicipalities;
    let finalUnmatched = baseUnmatched;

    if (sheetsResp && sheetsResp.ok) {
      const sheetsPayload = await sheetsResp.json();
      const sheetRows = normalizeSheetRows(sheetsPayload);

      if (sheetRows.length > 0) {
        const merged = mergeBaseWithSheetRows(baseMunicipalities, baseUnmatched, sheetRows);
        finalMunicipalities = merged.municipalities;
        finalUnmatched = merged.unmatched;
      }
    }

    municipalities = finalMunicipalities;
    unmatched = finalUnmatched;
    muniByCode = Object.fromEntries(municipalities.map(m => [String(m.code), m]));

    renderUnmatched();
    hydrateDatalist();
    initMap();
    bindUi();
    loadingBanner.classList.add("hidden");
    document.body.classList.remove("loading");
  }

  function initMap() {
    overlay = L.svgOverlay(createSvg(), bounds, { interactive: true, opacity: 1 }).addTo(map);
    map.fitBounds(bounds, { padding: [10, 10] });
    L.control.attribution({ prefix: false }).addTo(map);
    map.on("zoomend moveend", updateStyles);
    map.on("click", () => renderDetail(null));

    updateCounts();
    updateStyles();
  }

  function bindUi() {
    document.getElementById("zoomIn").addEventListener("click", () => map.zoomIn(0.5));
    document.getElementById("zoomOut").addEventListener("click", () => map.zoomOut(0.5));
    document.getElementById("fitAll").addEventListener("click", resetView);
    document.getElementById("searchBtn").addEventListener("click", searchAndFocus);
    document.getElementById("searchInput").addEventListener("keydown", event => {
      if (event.key === "Enter") searchAndFocus();
    });
    document.getElementById("resetBtn").addEventListener("click", () => {
      active = new Set(ACTIVE_DEFAULT);
      persistActiveFilters();
      document.getElementById("searchInput").value = "";
      resetView();
      updateStyles();
    });

    document.querySelectorAll(".filter-btn[data-status]").forEach(btn => {
      btn.classList.toggle("active", active.has(btn.dataset.status));
      btn.addEventListener("click", () => {
        const status = btn.dataset.status;
        if (active.has(status)) {
          if (active.size === 1) return;
          active.delete(status);
        } else {
          active.add(status);
        }
        if (selectedCode && !active.has(muniByCode[selectedCode]?.status)) selectedCode = null;
        persistActiveFilters();
        updateStyles();
        renderDetail(selectedCode ? muniByCode[selectedCode] : null);
      });
    });
  }

  function createSvg() {
    const svgMarkup = `
      <svg class="map-svg" id="embeddedSvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">
        <g id="paths">${pathsMarkup}</g>
        <g id="labels">
          ${municipalities.map(item => `<text id="label-${item.code}" class="muni-label" x="${item.label[0]}" y="${item.label[1]}">${escapeHtml(item.municipio)}</text>`).join("")}
        </g>
      </svg>
    `;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = svgMarkup.trim();
    svgRoot = wrapper.firstChild;
    bindSvgInteractions(svgRoot);
    return svgRoot;
  }

  function bindSvgInteractions(svg) {
    svg.querySelectorAll(".muni").forEach(path => {
      path.addEventListener("click", event => {
        const code = path.dataset.code;
        const item = muniByCode[code];
        if (!item || !active.has(item.status)) return;
        event.stopPropagation();
        renderDetail(item);
        fitMunicipality(item);
      });
    });
  }

  function renderUnmatched() {
    unmatchedList.innerHTML = unmatched.map(item => (
      `<li><strong>${escapeHtml(item.name)}</strong> <span>— ${escapeHtml(item.detail)}</span></li>`
    )).join("");
  }

  function hydrateDatalist() {
    datalist.innerHTML = "";
    municipalities
      .slice()
      .sort((a, b) => a.municipio.localeCompare(b.municipio, "es"))
      .forEach(item => {
        const option = document.createElement("option");
        option.value = `${item.municipio} - ${item.departamento}`;
        datalist.appendChild(option);
      });
  }

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function statusColor(status) {
    return STATUS_META[status]?.color || "#eef2f7";
  }

  function statusLabel(status) {
    return STATUS_META[status]?.label || status || "Sin dato";
  }

  function normalizeSheetRows(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.rows)
        ? payload.rows
        : [];

    return rows
      .map(row => ({
        dane: String(row.dane ?? "").trim(),
        ubicacion: String(row.ubicacion ?? "").trim(),
        municipio_mapa: String(row.municipio_mapa ?? "").trim(),
        departamento: String(row.departamento ?? "").trim(),
        estado: String(row.estado ?? "").trim(),
        region: String(row.region ?? "").trim(),
        macroregion: String(row.macroregion ?? "").trim()
      }))
      .filter(row => row.dane && ACTIVE_DEFAULT.includes(row.estado));
  }

  function mergeBaseWithSheetRows(baseMunicipalities, baseUnmatched, sheetRows) {
    const rowsByCode = new Map();
    sheetRows.forEach(row => {
      const code = String(row.dane).trim();
      if (!rowsByCode.has(code)) rowsByCode.set(code, []);
      rowsByCode.get(code).push(row);
    });

    const municipalitiesMerged = baseMunicipalities.map(baseItem => {
      const code = String(baseItem.code).trim();
      const rows = rowsByCode.get(code);

      if (!rows || rows.length === 0) {
        return baseItem;
      }

      const status = rows[0].estado;

      return {
        ...baseItem,
        status,
        color: statusColor(status),
        records: rows.map(row => ({
          ubicacion: row.ubicacion || baseItem.municipio,
          municipio_mapa: row.municipio_mapa || baseItem.municipio,
          departamento: row.departamento || baseItem.departamento,
          estado: row.estado || status,
          region: row.region || "",
          macroregion: row.macroregion || "",
          dane: row.dane || code
        }))
      };
    });

    const knownCodes = new Set(baseMunicipalities.map(m => String(m.code).trim()));

    const newUnmatchedFromSheet = sheetRows
      .filter(row => !knownCodes.has(String(row.dane).trim()))
      .map(row => ({
        name: row.ubicacion || row.municipio_mapa || row.dane,
        detail: `${row.departamento || "Sin departamento"} · ${row.estado || "Sin estado"} · DANE ${row.dane}`
      }));

    return {
      municipalities: municipalitiesMerged,
      unmatched: [...baseUnmatched, ...newUnmatchedFromSheet]
    };
  }

  function updateCounts() {
    document.getElementById("count-emancipada").textContent = municipalities.filter(m => m.status === "Emancipada").length;
    document.getElementById("count-proceso").textContent = municipalities.filter(m => m.status === "En proceso").length;
    document.getElementById("count-nueva").textContent = municipalities.filter(m => m.status === "Nueva ciudad").length;
    document.getElementById("count-municipios").textContent = municipalities.length;
    document.getElementById("count-registros").textContent = municipalities.reduce((sum, m) => sum + (m.records?.length || 0), 0);
    const unmatchedEl = document.getElementById("count-unmatched");
    if (unmatchedEl) unmatchedEl.textContent = unmatched.length;
  }

  function updateStyles() {
    if (!svgRoot) return;

    svgRoot.querySelectorAll(".muni").forEach(path => {
      const item = muniByCode[path.dataset.code];
      if (!item) {
        path.setAttribute("fill", "#eef2f7");
        path.setAttribute("stroke", "#cfd7df");
        path.style.opacity = 1;
        path.classList.remove("selected");
        return;
      }
      const visible = active.has(item.status);
      path.setAttribute("fill", visible ? (item.color || statusColor(item.status)) : "#e9eef4");
      path.setAttribute("stroke", visible ? "#6f7c89" : "#cfd7df");
      path.style.opacity = visible ? "1" : "0.55";
      path.classList.toggle("selected", selectedCode === item.code);
    });

    svgRoot.querySelectorAll(".muni-label").forEach(label => {
      const code = label.id.replace("label-", "");
      const item = muniByCode[code];
      if (!item) return;
      const zoom = map.getZoom();
      const allActive = active.size === ACTIVE_DEFAULT.length;
      const show = active.has(item.status) && (
        selectedCode === item.code ||
        (!allActive && zoom >= 0.4) ||
        (allActive && zoom >= 1.6)
      );
      label.style.display = show ? "block" : "none";
    });

    document.querySelectorAll(".filter-btn[data-status]").forEach(btn => {
      btn.classList.toggle("active", active.has(btn.dataset.status));
    });

    updateCounts();
  }

  function renderDetail(item) {
    if (!item) {
      selectedCode = null;
      detailPanel.innerHTML = `<h2>Detalle del municipio</h2><p class="muted">Toca un municipio coloreado en el mapa para ver su información.</p>`;
      updateStyles();
      return;
    }

    selectedCode = item.code;
    const records = item.records?.length
      ? item.records
      : [{
          ubicacion: item.municipio,
          municipio_mapa: item.municipio,
          departamento: item.departamento,
          estado: item.status,
          region: "",
          macroregion: "",
          dane: item.code
        }];

    const recordsHtml = records.map((record, index) => `
      <div class="record">
        <h3>Registro ${index + 1} · ${escapeHtml(record.ubicacion || item.municipio)}</h3>
        <p><strong>Municipio:</strong> ${escapeHtml(item.municipio)}</p>
        <p><strong>Departamento:</strong> ${escapeHtml(item.departamento)}</p>
        <p><strong>Estado:</strong> ${escapeHtml(statusLabel(record.estado))}</p>
        <p><strong>Región PAC:</strong> ${escapeHtml(record.region || "—")}</p>
        <p><strong>Macroregión:</strong> ${escapeHtml(record.macroregion || "—")}</p>
        <p><strong>Código DANE:</strong> ${escapeHtml(record.dane || item.code)}</p>
      </div>
    `).join("");

    detailPanel.innerHTML = `
      <h2>Detalle del municipio</h2>
      <div class="detail-title">
        <span class="detail-dot" style="background:${statusColor(item.status)}"></span>
        <div>
          <div><strong>${escapeHtml(item.municipio)}</strong></div>
          <div class="muted">${escapeHtml(item.departamento)} · ${escapeHtml(statusLabel(item.status))}</div>
        </div>
      </div>
      <div class="detail-list">${recordsHtml}</div>
    `;
    updateStyles();
  }

  function fitMunicipality(item) {
    const [x1, y1, x2, y2] = item.bbox;
    const municipalityBounds = [[y1, x1], [y2, x2]];
    map.fitBounds(municipalityBounds, { padding: [40, 40], maxZoom: 4 });
  }

  function findMunicipality(query) {
    const q = normalize(query);
    if (!q) return null;

    const exact = municipalities.find(item => {
      return normalize(`${item.municipio} - ${item.departamento}`) === q ||
        normalize(item.municipio) === q ||
        normalize(item.departamento) === q;
    });
    if (exact) return exact;

    return municipalities.find(item => normalize(`${item.municipio} ${item.departamento}`).includes(q));
  }

  function searchAndFocus() {
    const input = document.getElementById("searchInput");
    const item = findMunicipality(input.value);
    if (!item) {
      window.alert("No encontré ese municipio o departamento dentro de los municipios con dato.");
      return;
    }
    if (!active.has(item.status)) active.add(item.status);
    persistActiveFilters();
    renderDetail(item);
    fitMunicipality(item);
    updateStyles();
  }

  function resetView() {
    selectedCode = null;
    renderDetail(null);
    map.fitBounds(bounds, { padding: [10, 10] });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"]/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;"
    }[char]));
  }

  function loadActiveFilters() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set(ACTIVE_DEFAULT);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return new Set(ACTIVE_DEFAULT);
      return new Set(parsed.filter(status => ACTIVE_DEFAULT.includes(status)));
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
    errorBanner.textContent = `Error al cargar el mapa: ${error.message || error}`;
    errorBanner.classList.remove("hidden");
    document.body.classList.remove("loading");
  }
})();
