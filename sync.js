// MediStock - Sincronización entre dispositivos (Cloudflare / Netlify / local)
const SYNC_URL = "/api/sync";
const LOCAL_REV_KEY = "medistock_data_rev";
let syncTimer = null;
let syncing = false;

/** Marca que hubo un cambio real en este dispositivo (no al solo exportar). */
function touchLocalData() {
  const ts = new Date().toISOString();
  try { localStorage.setItem(LOCAL_REV_KEY, ts); } catch (e) {}
  return ts;
}

function getLocalDataRev() {
  try {
    return localStorage.getItem(LOCAL_REV_KEY) || "1970-01-01T00:00:00.000Z";
  } catch (e) {
    return "1970-01-01T00:00:00.000Z";
  }
}


async function exportAllData() {
  const [users, medicamentos, lotes, movimientos, materiales, lotesMaterial, movimientosMaterial, laboratorio, vacunas, kits] = await Promise.all([
    getUsers(),
    getMedicamentos(),
    getAllLotes(),
    getAllMovimientos(),
    getMateriales(),
    getAllLotesMaterial(),
    getAllMovimientosMaterial(),
    getExtraItems('laboratorio'),
    getExtraItems('vacunas'),
    getKits(),
  ]);
  return {
    version: 4,
    updatedAt: getLocalDataRev(),
    users,
    medicamentos,
    lotes,
    movimientos,
    materiales,
    lotesMaterial,
    movimientosMaterial,
    laboratorio,
    vacunas,
    kits,
  };
}

async function clearStore(storeName) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function putAll(storeName, items) {
  if (!items || !items.length) return;
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function importAllData(data) {
  if (!data) return false;
  await clearStore("users");
  await clearStore("medicamentos");
  await clearStore("lotes");
  await clearStore("movimientos");
  try { await clearStore("materiales"); } catch (e) {}
  try { await clearStore("lotesMaterial"); } catch (e) {}
  try { await clearStore("movimientosMaterial"); } catch (e) {}
  await putAll("users", data.users || []);
  await putAll("medicamentos", data.medicamentos || []);
  await putAll("lotes", data.lotes || []);
  await putAll("movimientos", data.movimientos || []);
  await putAll("materiales", data.materiales || []);
  await putAll("lotesMaterial", data.lotesMaterial || []);
  await putAll("movimientosMaterial", data.movimientosMaterial || []);
  try { await clearStore("laboratorio"); } catch (e) {}
  try { await clearStore("vacunas"); } catch (e) {}
  await putAll("laboratorio", data.laboratorio || []);
  await putAll("vacunas", data.vacunas || []);
  try { await clearStore("kits"); } catch (e) {}
  await putAll("kits", data.kits || []);
  return true;
}

async function pushToCloud() {
  if (!navigator.onLine) return { ok: false, offline: true };
  try {
    const payload = await exportAllData();
    const res = await fetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 503 || json.localOnly) {
        updateSyncStatus(false, "nube-no-config");
        return { ok: false, error: "Nube no configurada (KV). Datos solo en este dispositivo.", localOnly: true };
      }
      throw new Error(json.error || ("HTTP " + res.status));
    }
    localStorage.setItem("medistock_last_sync", json.syncedAt || new Date().toISOString());
    updateSyncStatus(true);
    return { ok: true };
  } catch (e) {
    console.warn("pushToCloud failed", e);
    updateSyncStatus(false);
    return { ok: false, error: e.message };
  }
}

async function pullFromCloud() {
  if (!navigator.onLine) return { ok: false, offline: true };
  try {
    const res = await fetch(SYNC_URL, { method: "GET" });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 503 || (data && data.localOnly)) {
        updateSyncStatus(false, "nube-no-config");
        return { ok: false, error: "Nube no configurada (KV)", localOnly: true };
      }
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }
    if (!data || (!data.medicamentos && !data.users)) return { ok: true, empty: true };

    const local = await exportAllData();
    const remoteTime = new Date(data.updatedAt || 0).getTime();
    const localTime = new Date(getLocalDataRev()).getTime();

    const localMovs = (local.movimientos || []).length + (local.movimientosMaterial || []).length;
    const remoteMovs = (data.movimientos || []).length + (data.movimientosMaterial || []).length;
    const localMeds = (local.medicamentos || []).length;
    const remoteMeds = (data.medicamentos || []).length;

    // Vacío de verdad (sin catálogo ni movimientos)
    const localEmpty = localMeds === 0 && localMovs === 0;

    // Preferir nube si: está vacía local, o la nube es más nueva, o la nube tiene más actividad
    const preferRemote =
      localEmpty ||
      remoteTime > localTime ||
      (remoteTime === localTime && remoteMovs > localMovs) ||
      (localMovs === 0 && remoteMovs > 0);

    if (preferRemote) {
      await importAllData(data);
      // Alinear revisión local con la de la nube (no es un cambio local nuevo)
      try { localStorage.setItem(LOCAL_REV_KEY, data.updatedAt || new Date().toISOString()); } catch (e) {}
      localStorage.setItem("medistock_last_sync", data.updatedAt || new Date().toISOString());
      updateSyncStatus(true);
      return { ok: true, imported: true };
    }

    // Este dispositivo tiene cambios más nuevos → subir
    if (localTime > remoteTime) {
      await pushToCloud();
      return { ok: true, pushed: true };
    }

    updateSyncStatus(true);
    return { ok: true, upToDate: true };
  } catch (e) {
    console.warn("pullFromCloud failed", e);
    updateSyncStatus(false);
    return { ok: false, error: e.message };
  }
}

function scheduleSync() {
  touchLocalData();
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (syncing) return;
    syncing = true;
    await pushToCloud();
    syncing = false;
  }, 800);
}

function updateSyncStatus(ok, reason) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  const last = localStorage.getItem("medistock_last_sync");
  if (!navigator.onLine) {
    el.textContent = "📴 Sin conexión (datos locales)";
    el.style.color = "#d97706";
    return;
  }
  if (reason === "nube-no-config") {
    el.textContent = "⚠️ Nube no activa (solo este móvil)";
    el.style.color = "#d97706";
    return;
  }
  if (ok) {
    el.textContent = last
      ? "☁️ Sincronizado " + new Date(last).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : "☁️ Conectado";
    el.style.color = "#16a34a";
  } else {
    el.textContent = "⚠️ Error de sincronización";
    el.style.color = "#dc2626";
  }
}

async function manualSync() {
  showToast("Sincronizando...");
  syncing = true;
  try {
    const pull = await pullFromCloud();
    if (pull.imported) {
      showToast("Datos actualizados desde la nube");
      if (typeof loadDashboard === "function") loadDashboard();
      if (typeof loadInventario === "function") loadInventario();
      if (typeof loadCargoList === "function") loadCargoList();
    } else if (pull.pushed) {
      showToast("Datos guardados en la nube");
    } else if (pull.upToDate) {
      // Forzar subida por si el usuario pulsó ☁️ tras editar
      const push = await pushToCloud();
      if (push.ok) showToast("Datos guardados en la nube");
      else if (push.offline) showToast("Sin conexión: datos solo en este dispositivo");
      else showToast("No se pudo subir: " + (push.error || ""));
    } else if (pull.offline) {
      showToast("Sin conexión: datos solo en este dispositivo");
    } else if (pull.localOnly) {
      showToast("Nube no configurada (KV)");
    } else {
      const push = await pushToCloud();
      if (push.ok) showToast("Datos guardados en la nube");
      else showToast("No se pudo sincronizar: " + (push.error || pull.error || ""));
    }
  } finally {
    syncing = false;
  }
}

window.addEventListener("online", () => {
  updateSyncStatus(true);
  scheduleSync();
});
window.addEventListener("offline", () => updateSyncStatus(false));


async function exportBackupFile() {
  const data = await exportAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "medistock-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
  showToast("Copia de seguridad descargada");
}

function importBackupFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.medicamentos && !data.users) {
        showToast("Archivo no válido");
        return;
      }
      if (!confirm("¿Importar esta copia? Se reemplazarán los datos de este dispositivo.")) return;
      await importAllData(data);
      showToast("Copia importada");
      if (typeof loadDashboard === "function") loadDashboard();
      if (typeof loadInventario === "function") loadInventario();
      scheduleSync();
    } catch (err) {
      showToast("Error al importar: " + err.message);
    }
  };
  input.click();
}
