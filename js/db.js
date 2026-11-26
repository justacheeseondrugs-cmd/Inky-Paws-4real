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
let memoryActiveProject = null;

function readStorage(storage, key) {
  try { return storage?.getItem(key) || null; } catch { return null; }
}
function writeStorage(storage, key, value) {
  try { storage?.setItem(key, value); } catch { }
}

export function getActiveProjectId() {
  if (typeof sessionStorage !== 'undefined') {
    const tabProject = readStorage(sessionStorage, ACTIVE_KEY);
    if (tabProject) return tabProject;
  }
  if (typeof localStorage !== 'undefined') {
    const shared = readStorage(localStorage, ACTIVE_KEY);
    if (shared) {
      if (typeof sessionStorage !== 'undefined') writeStorage(sessionStorage, ACTIVE_KEY, shared);
      return shared;
    }
  }
  return memoryActiveProject || ORIGINAL_PROJECT;
}

export function setActiveProjectId(id) {
  const next = id || ORIGINAL_PROJECT;
  memoryActiveProject = next;
  if (typeof sessionStorage !== 'undefined') writeStorage(sessionStorage, ACTIVE_KEY, next);
  if (typeof localStorage !== 'undefined') writeStorage(localStorage, ACTIVE_KEY, next);
}

function resolveScope(opts) {
  return opts?.projectId || getActiveProjectId();
}

function belongs(store, value, projectId = getActiveProjectId()) {
  return !SCOPED_STORES.has(store) || !!value && (value.projectId || ORIGINAL_PROJECT) === projectId;
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

async function getAll(storeName, opts) {
  const scope = resolveScope(opts);
  const records = await rawGetAll(storeName);
  return SCOPED_STORES.has(storeName) ? records.filter((record) => belongs(storeName, record, scope)) : records;
}

async function getByIndex(storeName, indexName, value, opts) {
  const scope = resolveScope(opts);
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).getAll(value);
    req.onsuccess = () => resolve((req.result || []).filter((record) => belongs(storeName, record, scope)));
    req.onerror = () => reject(req.error);
  });
}

async function get(storeName, id, opts) {
  const scope = resolveScope(opts);
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(belongs(storeName, req.result, scope) ? req.result : null);
    req.onerror = () => reject(req.error);
  });
}

async function put(storeName, obj, opts) {
  const scope = resolveScope(opts);
  if (SCOPED_STORES.has(storeName)) {
    if (obj.projectId && obj.projectId !== scope) throw new Error('Este registro pertenece a otra historia.');
    if (!obj.projectId) obj.projectId = scope;
  }
  const hadExplicitId = typeof obj.id === 'string' && !!obj.id.trim();
  if (!obj.id) obj.id = uid();
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    let customError = null;
    transaction.oncomplete = () => resolve(obj);
    transaction.onerror = () => reject(customError || transaction.error);
    transaction.onabort = () => reject(customError || transaction.error || new Error('No se pudo guardar el registro.'));

    if (SCOPED_STORES.has(storeName) && hadExplicitId) {
      const checkReq = store.get(obj.id);
      checkReq.onsuccess = () => {
        const existing = checkReq.result;
        if (existing && (existing.projectId || ORIGINAL_PROJECT) !== scope) {
          customError = new Error('Colisión de ID: ya existe un registro con este identificador en otra historia.');
          try { transaction.abort(); } catch { }
          return;
        }
        store.put(obj);
      };
    } else {
      store.put(obj);
    }
  });
}

async function del(storeName, id, opts) {
  const scope = resolveScope(opts);
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    let deleted = false;
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('No se pudo eliminar el registro.'));

    if (SCOPED_STORES.has(storeName)) {
      const checkReq = store.get(id);
      checkReq.onsuccess = () => {
        const existing = checkReq.result;
        if (!existing || (existing.projectId || ORIGINAL_PROJECT) !== scope) {
          deleted = false;
          return;
        }
        deleted = true;
        store.delete(id);
      };
    } else {
      deleted = true;
      store.delete(id);
    }
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
const SUPPORTED_MIN_VERSION = 1;
const SUPPORTED_MAX_VERSION = DB_VERSION;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateStoreRecord(storeName, item, pos) {
  if (!isPlainObject(item)) {
    throw new Error(`Registro inválido en "${storeName}" (posición ${pos}).`);
  }
  if (typeof item.id !== 'string' || !item.id.trim()) {
    throw new Error(`Falta un identificador válido en "${storeName}" (posición ${pos}).`);
  }
  if (SCOPED_STORES.has(storeName) && item.projectId !== undefined) {
    if (typeof item.projectId !== 'string' || !item.projectId.trim()) {
      throw new Error(`projectId inválido en "${storeName}" (posición ${pos}).`);
    }
  }
  if (storeName === 'chapters') {
    if (item.title !== undefined && typeof item.title !== 'string') throw new Error(`Título de capítulo inválido (posición ${pos}).`);
    if (item.content !== undefined && typeof item.content !== 'string') throw new Error(`Contenido de capítulo inválido (posición ${pos}).`);
    if (item.versions !== undefined && !Array.isArray(item.versions)) throw new Error(`Historial de versiones inválido en capítulo (posición ${pos}).`);
    if (item.order !== undefined && !Number.isFinite(Number(item.order))) throw new Error(`Orden de capítulo inválido (posición ${pos}).`);
    if (item.wordCount !== undefined && !Number.isFinite(Number(item.wordCount))) throw new Error(`Conteo de palabras inválido en capítulo (posición ${pos}).`);
  } else if (storeName === 'characters') {
    if (item.name !== undefined && typeof item.name !== 'string') throw new Error(`Nombre de personaje inválido (posición ${pos}).`);
    if (item.active !== undefined && typeof item.active !== 'boolean') throw new Error(`Estado activo inválido en personaje (posición ${pos}).`);
  } else if (storeName === 'documents') {
    if (item.filename !== undefined && typeof item.filename !== 'string') throw new Error(`Nombre de documento inválido (posición ${pos}).`);
    if (item.priority !== undefined && !Number.isFinite(Number(item.priority))) throw new Error(`Prioridad de documento inválida (posición ${pos}).`);
    if (item.wordCount !== undefined && !Number.isFinite(Number(item.wordCount))) throw new Error(`Conteo de palabras inválido en documento (posición ${pos}).`);
  } else if (storeName === 'docChunks') {
    if (typeof item.documentId !== 'string' || !item.documentId.trim()) throw new Error(`documentId inválido en fragmento (posición ${pos}).`);
    if (item.text !== undefined && typeof item.text !== 'string') throw new Error(`Texto inválido en fragmento (posición ${pos}).`);
    if (item.index !== undefined && !Number.isFinite(Number(item.index))) throw new Error(`Índice inválido en fragmento (posición ${pos}).`);
  } else if (storeName === 'memoryEntries') {
    if (typeof item.chapterId !== 'string' || !item.chapterId.trim()) throw new Error(`chapterId inválido en memoria (posición ${pos}).`);
  } else if (storeName === 'lockedFacts' || storeName === 'canonNotes') {
    if (typeof item.text !== 'string') throw new Error(`Texto inválido en "${storeName}" (posición ${pos}).`);
  } else if (storeName === 'settings') {
    if (item.id === 'workspaces' && item.items !== undefined && !Array.isArray(item.items)) {
      throw new Error('La lista de historias (workspaces) en ajustes tiene un formato inválido.');
    }
    if (item.id === 'main' && item.apiKeys !== undefined && !isPlainObject(item.apiKeys)) {
      throw new Error('El campo apiKeys en ajustes tiene un formato inválido.');
    }
  }
}

export function validateBackupDump(dump) {
  if (!isPlainObject(dump)) {
    throw new Error('El archivo no contiene una copia de seguridad válida.');
  }
  const meta = dump.__meta;
  if (meta !== undefined) {
    if (!isPlainObject(meta)) {
      throw new Error('Los metadatos de la copia de seguridad no son válidos.');
    }
    if (meta.app && !ALLOWED_BACKUP_APPS.has(String(meta.app))) {
      throw new Error('Este archivo no corresponde a una copia de seguridad de Inky Paws.');
    }
    if (meta.version !== undefined) {
      const ver = Number(meta.version);
      if (!Number.isInteger(ver) || ver < SUPPORTED_MIN_VERSION || ver > SUPPORTED_MAX_VERSION) {
        throw new Error(`Versión de esquema no compatible (${String(meta.version)}). Esta versión de Inky Paws admite hasta la versión ${SUPPORTED_MAX_VERSION}.`);
      }
    }
  }
  const allStoreNames = Object.keys(STORES);
  const targetStores = [];
  const missingStores = [];
  for (const name of allStoreNames) {
    if (!(name in dump) || dump[name] === undefined) {
      missingStores.push(name);
      continue;
    }
    if (!Array.isArray(dump[name])) {
      throw new Error(`El almacén "${name}" tiene un formato inválido en la copia de seguridad.`);
    }
    const seenIds = new Set();
    for (let i = 0; i < dump[name].length; i++) {
      const item = dump[name][i];
      validateStoreRecord(name, item, i + 1);
      if (seenIds.has(item.id)) {
        throw new Error(`Identificador duplicado "${item.id}" en "${name}" (posición ${i + 1}).`);
      }
      seenIds.add(item.id);
    }
    targetStores.push(name);
  }
  if (!targetStores.length) {
    throw new Error('La copia de seguridad no contiene ningún almacén de datos reconocible.');
  }
  const isFull = missingStores.length === 0 && meta?.backupKind !== 'partial';
  return {
    targetStores,
    missingStores,
    isFull,
    backupKind: isFull ? 'full' : 'partial',
    version: meta?.version ?? DB_VERSION,
  };
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
    backupKind: 'full',
    exportedAt: new Date().toISOString(),
    version: DB_VERSION,
    apiKeysExcluded: true
  };
  return dump;
}

async function importAll(dump, { merge = false, allowPartial = false, targetProjectId = null } = {}) {
  // Validar estructura COMPLETA antes de tocar IndexedDB: una copia inválida
  // nunca debe borrar ni modificar datos existentes.
  const validation = validateBackupDump(dump);
  const { targetStores, isFull } = validation;

  if (!merge && !isFull && !allowPartial) {
    throw new Error('Este archivo es una importación parcial (faltan almacenes). No puede reemplazar toda la base de datos; impórtalo en modo combinación (merge) o usa una copia completa.');
  }
  if (targetProjectId) {
    for (const name of targetStores) {
      if (!SCOPED_STORES.has(name)) continue;
      for (const obj of dump[name]) {
        const recordScope = obj.projectId || ORIGINAL_PROJECT;
        if (recordScope !== targetProjectId) {
          throw new Error(`El registro "${obj.id}" en "${name}" pertenece a otra historia ("${recordScope}") y no puede importarse en "${targetProjectId}".`);
        }
      }
    }
  }

  // Nunca aceptar credenciales desde un archivo importado.
  // Conserva únicamente las claves que ya estaban en ESTE navegador.
  const localMain = await get('settings', 'main').catch(() => null);
  const localApiKeys = { ...(localMain?.apiKeys || {}) };
  const database = await openDb();

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(targetStores, 'readwrite');
    let customError = null;
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(customError || transaction.error || new Error('No se pudo completar la importación.'));
    transaction.onabort = () => reject(customError || transaction.error || new Error('La importación fue abortada; tus datos previos permanecen intactos.'));

    const writeAll = () => {
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
        customError = err;
        try { transaction.abort(); } catch { }
      }
    };

    // En modo combinación (merge), verificar dentro de la MISMA transacción
    // que ningún ID entrante sobrescriba un registro de otra historia.
    const scopedTargets = merge ? targetStores.filter((name) => SCOPED_STORES.has(name)) : [];
    if (!scopedTargets.length) {
      writeAll();
      return;
    }

    let remaining = scopedTargets.length;
    let failed = false;
    for (const name of scopedTargets) {
      const store = transaction.objectStore(name);
      const req = store.getAll();
      req.onsuccess = () => {
        if (failed) return;
        const ownerById = new Map((req.result || []).map((rec) => [rec.id, rec.projectId || ORIGINAL_PROJECT]));
        for (const incoming of dump[name]) {
          const existingOwner = ownerById.get(incoming.id);
          const incomingOwner = incoming.projectId || ORIGINAL_PROJECT;
          if (existingOwner !== undefined && existingOwner !== incomingOwner) {
            failed = true;
            customError = new Error(`Colisión entre historias: el registro "${incoming.id}" en "${name}" pertenece a "${existingOwner}" y no puede ser sobrescrito por "${incomingOwner}".`);
            try { transaction.abort(); } catch { }
            return;
          }
        }
        remaining -= 1;
        if (remaining === 0) writeAll();
      };
    }
  });

  return validation;
}

export const db = { openDb, getAll, getByIndex, get, put, del, clearStore, uid, exportAll, importAll, validateBackupDump, getActiveProjectId, setActiveProjectId };
