// db.js — capa de persistencia. Toda la app pasa por aquí para leer/escribir.
// No contiene lógica de negocio ni de IA: sólo CRUD sobre IndexedDB.

const DB_NAME = 'pts-studio';
const DB_VERSION = 1;

const STORES = {
  chapters: 'id',
  characters: 'id',
  documents: 'id',
  docChunks: 'id',
  memoryEntries: 'id',
  lockedFacts: 'id',
  canonNotes: 'id',
  settings: 'id',
  generationState: 'id',
};

// Los proyectos comparten proveedor de IA, pero NUNCA capítulos ni referencias.
// Los registros anteriores no llevan projectId: pertenecen a ORIGINAL y no se migran.
const ORIGINAL_PROJECT = 'original';
const SCOPED_STORES = new Set(['chapters','characters','documents','docChunks','memoryEntries','lockedFacts','canonNotes','generationState']);
const ACTIVE_KEY = 'pts_active_project_v1';
export function getActiveProjectId() { return localStorage.getItem(ACTIVE_KEY) || ORIGINAL_PROJECT; }
export function setActiveProjectId(id) { localStorage.setItem(ACTIVE_KEY, id || ORIGINAL_PROJECT); }
function belongs(store, value) {
  return !SCOPED_STORES.has(store) || !!value && (value.projectId || ORIGINAL_PROJECT) === getActiveProjectId();
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'docChunks') store.createIndex('by_document', 'documentId', { unique: false });
          if (name === 'memoryEntries') store.createIndex('by_chapter', 'chapterId', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

async function rawGetAll(storeName) {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(storeName) {
  const records = await rawGetAll(storeName);
  return SCOPED_STORES.has(storeName) ? records.filter((record) => belongs(storeName,record)) : records;
}

async function getByIndex(storeName, indexName, value) {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).getAll(value);
    req.onsuccess = () => resolve((req.result || []).filter((record) => belongs(storeName,record)));
    req.onerror = () => reject(req.error);
  });
}

async function get(storeName, id) {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(belongs(storeName,req.result) ? req.result : null);
    req.onerror = () => reject(req.error);
  });
}

async function put(storeName, obj) {
  if (SCOPED_STORES.has(storeName)) {
    if (obj.projectId && obj.projectId !== getActiveProjectId()) throw new Error('Este registro pertenece a otra historia.');
    if (!obj.projectId) obj.projectId = getActiveProjectId();
  }
  if (!obj.id) obj.id = uid();
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(obj);
    req.onsuccess = () => resolve(obj);
    req.onerror = () => reject(req.error);
  });
}

async function del(storeName, id) {
  if (SCOPED_STORES.has(storeName) && !(await get(storeName,id))) return false;
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function clearStore(storeName) {
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// ---- Export / import completo (backup) ----
// Las credenciales API son deliberadamente LOCALES y nunca forman parte de una copia.
function sanitizeSettingsForBackup(record) {
  if (!record || typeof record !== 'object') return record;
  const safe = { ...record };
  if ('apiKeys' in safe) safe.apiKeys = {};
  if ('apiKey' in safe) delete safe.apiKey;
  return safe;
}

const ALLOWED_BACKUP_APPS = new Set(['pts-studio', 'inky-paws']);

export function validateBackupDump(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
    throw new Error('El archivo no contiene una copia de seguridad válida.');
  }
  const meta = dump.__meta;
  if (meta !== undefined) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new Error('Los metadatos de la copia de seguridad no son válidos.');
    }
    if (meta.app && !ALLOWED_BACKUP_APPS.has(String(meta.app))) {
      throw new Error('Este archivo no corresponde a una copia de seguridad de Inky Paws.');
    }
  }
  const storeNames = Object.keys(STORES);
  const targetStores = [];
  for (const name of storeNames) {
    if (!(name in dump) || dump[name] === undefined) continue;
    if (!Array.isArray(dump[name])) {
      throw new Error(`El almacén "${name}" tiene un formato inválido en la copia de seguridad.`);
    }
    for (let i = 0; i < dump[name].length; i++) {
      const item = dump[name][i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Registro inválido en "${name}" (posición ${i + 1}).`);
      }
      if (typeof item.id !== 'string' || !item.id.trim()) {
        throw new Error(`Falta un identificador válido en "${name}" (posición ${i + 1}).`);
      }
    }
    targetStores.push(name);
  }
  if (!targetStores.length) {
    throw new Error('La copia de seguridad no contiene ningún almacén de datos reconocible.');
  }
  return { targetStores };
}

async function exportAll() {
  const dump = {};
  for (const name of Object.keys(STORES)) {
    const records = await rawGetAll(name);
    dump[name] = name === 'settings'
      ? records.map(sanitizeSettingsForBackup)
      : records;
  }
  dump.__meta = {
    app: 'pts-studio',
    exportedAt: new Date().toISOString(),
    version: DB_VERSION,
    apiKeysExcluded: true
  };
  return dump;
}

async function importAll(dump, { merge = false } = {}) {
  // Validar estructura COMPLETA antes de tocar IndexedDB: una copia inválida
  // nunca debe borrar ni modificar datos existentes.
  const { targetStores } = validateBackupDump(dump);

  // Nunca aceptar credenciales desde un archivo importado.
  // Conserva únicamente las claves que ya estaban en ESTE navegador.
  const localMain = await get('settings', 'main').catch(() => null);
  const localApiKeys = { ...(localMain?.apiKeys || {}) };
  const database = await openDb();

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(targetStores, 'readwrite');
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo completar la importación.'));
    transaction.onabort = () => reject(transaction.error || new Error('La importación fue abortada; tus datos previos permanecen intactos.'));

    try {
      for (const name of targetStores) {
        const store = transaction.objectStore(name);
        if (!merge) store.clear();
        let hasMainSettings = false;

        for (const obj of dump[name]) {
          let safeObj = { ...obj };
          if (name === 'settings') {
            safeObj = sanitizeSettingsForBackup(safeObj);
            if (safeObj.id === 'main') {
              hasMainSettings = true;
              safeObj = { ...safeObj, apiKeys: { ...localApiKeys } };
            }
          }
          store.put(safeObj);
        }

        // Backup raro/antiguo sin settings.main: no perder las claves locales existentes.
        if (name === 'settings' && !hasMainSettings && localMain) {
          store.put({ ...localMain, apiKeys: { ...localApiKeys } });
        }
      }
    } catch (err) {
      try { transaction.abort(); } catch { }
      reject(err);
    }
  });

  return true;
}

export const db = { openDb, getAll, getByIndex, get, put, del, clearStore, uid, exportAll, importAll, validateBackupDump, getActiveProjectId, setActiveProjectId };
