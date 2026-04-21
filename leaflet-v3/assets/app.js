const SHEETS_ENDPOINT = "PEGAR_AQUI_URL_EXEC";

const map = L.map('map').setView([4.5, -74], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

async function loadData(){
  try {
    const sheet = await fetch(SHEETS_ENDPOINT).then(r=>r.json());
    console.log("Datos Sheets:", sheet);
  } catch(e) {
    console.error("Error cargando Sheets", e);
  }
}

loadData();
