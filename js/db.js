// db.js — capa de persistencia. Toda la app pasa por aquí para leer/escribir.
// No contiene lógica de negocio ni de IA: sólo CRUD sobre IndexedDB.

export const DB_NAME = 'pts-studio';
export const DB_VERSION = 3;

export const V1_STORE_NAMES = [
  'chapters',
  'characters',
  'documents',
  'docChunks',
  'memoryEntries',
  'lockedFacts',
  'canonNotes',
  'settings',
  'generationState',
];

export const V2_STORE_NAMES = [
  ...V1_STORE_NAMES,
  'universalCharacters',
  'characterOverlays',
  'storyConfigs',
  'storyPresets',
  'knowledgeFacts',
  'usageLog',
];

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
  universalCharacters: 'id',
  characterOverlays: 'id',
  storyConfigs: 'id',
  storyPresets: 'id',
  knowledgeFacts: 'id',
  usageLog: 'id',
  arcSummaries: 'id',
  relationshipStates: 'id',
  lexicalIndexes: 'id',
};

export const STORE_NAMES = Object.keys(STORES);

const STORE_INDEXES = {
  docChunks: [
    ['by_project', 'projectId'],
    ['by_document', 'documentId'],
  ],
  memoryEntries: [
    ['by_project', 'projectId'],
    ['by_chapter', 'chapterId'],
    ['by_project_chapter', ['projectId', 'chapterId']],
    ['by_project_created', ['projectId', 'createdAt']],
  ],
  chapters: [
    ['by_project', 'projectId'],
    ['by_project_order', ['projectId', 'order']],
    ['by_project_updated', ['projectId', 'updatedAt']],
  ],
  characters: [
    ['by_project', 'projectId'],
    ['by_project_name', ['projectId', 'name']],
  ],
  documents: [
    ['by_project', 'projectId'],
    ['by_project_priority', ['projectId', 'priority']],
  ],
  lockedFacts: [
    ['by_project', 'projectId'],
  ],
  canonNotes: [
    ['by_project', 'projectId'],
  ],
  generationState: [
    ['by_project', 'projectId'],
  ],
  universalCharacters: [
    ['by_fandom', 'fandom'],
    ['by_category', 'category'],
    ['by_name', 'name'],
  ],
  characterOverlays: [
    ['by_base_character', 'baseCharacterId'],
    ['by_fandom', 'fandom'],
  ],
  storyConfigs: [
    ['by_fandom', 'fandom'],
  ],
  storyPresets: [
    ['by_fandom', 'fandom'],
  ],
  knowledgeFacts: [
    ['by_project', 'projectId'],
    ['by_project_checkpoint', ['projectId', 'firstEffectiveCheckpoint']],
    ['by_project_source_chapter', ['projectId', 'sourceChapterId']],
  ],
  usageLog: [
    ['by_created', 'createdAt'],
  ],
  arcSummaries: [
    ['by_project', 'projectId'],
    ['by_project_order', ['projectId', 'arcOrder']],
  ],
  relationshipStates: [
    ['by_project', 'projectId'],
    ['by_project_pair', ['projectId', 'pairKey']],
  ],
  lexicalIndexes: [
    ['by_project', 'projectId'],
    ['by_project_kind', ['projectId', 'kind']],
  ],
};

// Los proyectos comparten proveedor de IA, pero NUNCA capítulos ni referencias.
// Los registros heredados de v1 sin projectId pertenecen a ORIGINAL y reciben
// backfill no destructivo en la migración v1->v2/v3 para ser visibles en índices compuestos.
const ORIGINAL_PROJECT = 'original';
const SCOPED_STORES = new Set([
  'chapters',
  'characters',
  'documents',
  'docChunks',
  'memoryEntries',
  'lockedFacts',
  'canonNotes',
  'generationState',
  'knowledgeFacts',
  'arcSummaries',
  'relationshipStates',
  'lexicalIndexes',
]);
const SYNCED_ENTITY_STORES = new Set([
  'chapters',
  'characters',
  'documents',
  'docChunks',
  'memoryEntries',
  'lockedFacts',
  'canonNotes',
  'generationState',
  'universalCharacters',
  'characterOverlays',
  'storyConfigs',
  'storyPresets',
  'knowledgeFacts',
  'arcSummaries',
  'relationshipStates',
]);
export const DERIVED_STORES = new Set(['lexicalIndexes']);
export const V3_REQUIRED_STORE_NAMES = STORE_NAMES.filter((name) => !DERIVED_STORES.has(name));
const ACTIVE_KEY = 'pts_active_project_v1';
let memoryActiveProject = null;

function dispatchDbEvent(name, detail = {}) {
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { }
  }
}

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

function backfillMissingProjectId(store) {
  const cursorReq = store.openCursor();
  cursorReq.onsuccess = (ev) => {
    const cursor = ev.target.result;
    if (!cursor) return;
    const val = cursor.value;
    if (val && typeof val === 'object' && !val.projectId) {
      cursor.update({ ...val, projectId: ORIGINAL_PROJECT });
    }
    cursor.continue();
  };
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let wasBlocked = false;
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      const upgradeTx = e.target.transaction;
      for (const [name, keyPath] of Object.entries(STORES)) {
        const existed = database.objectStoreNames.contains(name);
        const store = existed
          ? upgradeTx.objectStore(name)
          : database.createObjectStore(name, { keyPath });
        for (const [idxName, idxKeyPath] of (STORE_INDEXES[name] || [])) {
          if (!store.indexNames.contains(idxName)) {
            store.createIndex(idxName, idxKeyPath, { unique: false });
          }
        }
        // Asegurar que registros heredados de v1 sin projectId sean indexados en
        // by_project y en los índices compuestos (p.ej. by_project_order) sin alterar datos.
        if (existed && SCOPED_STORES.has(name)) {
          backfillMissingProjectId(store);
        }
      }
    };
    req.onsuccess = () => {
      const database = req.result;
      if (wasBlocked) {
        dispatchDbEvent('inky-db-unblocked', { dbName: DB_NAME, version: database.version });
      }
      database.onversionchange = () => {
        database.close();
        dbPromise = null;
        dispatchDbEvent('inky-db-versionchange', { dbName: DB_NAME });
      };
      resolve(database);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      wasBlocked = true;
      dispatchDbEvent('inky-db-blocked', {
        dbName: DB_NAME,
        targetVersion: DB_VERSION,
        message: 'Hay otra pestaña abierta de Inky Paws con una versión anterior. Cierra las demás pestañas de Inky Paws para completar la actualización sin perder tus datos.',
      });
    };
  });
  return dbPromise;
}

function resetConnection() {
  dbPromise = null;
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
  if (SCOPED_STORES.has(storeName)) {
    const store = await tx(storeName);
    if (store.indexNames.contains('by_project')) {
      const indexed = await new Promise((resolve, reject) => {
        const req = store.index('by_project').getAll(scope);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      if (scope !== ORIGINAL_PROJECT) return indexed;
      // Seguridad extra por si un registro v1 llegara sin projectId vía importación antigua.
      const all = await rawGetAll(storeName);
      return all.filter((record) => belongs(storeName, record, scope));
    }
  }
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

async function getByProjectIndex(storeName, indexName, opts) {
  const scope = resolveScope(opts);
  const store = await tx(storeName);
  const range = indexName === 'by_project'
    ? IDBKeyRange.only(scope)
    : IDBKeyRange.bound([scope], [scope, []]);
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).getAll(range);
    req.onsuccess = () => resolve(req.result || []);
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

function stampSyncFields(storeName, obj, existing) {
  if (!SYNCED_ENTITY_STORES.has(storeName)) return obj;
  const now = new Date().toISOString();
  const prevRev = Number.isInteger(existing?.revision) ? existing.revision : 0;
  const nextRev = prevRev + 1;
  obj.revision = nextRev;
  obj.syncUpdatedAt = now;
  if (obj.deletedAt === undefined) obj.deletedAt = null;
  obj.dirty = true;
  return obj;
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

    if (hadExplicitId && (SCOPED_STORES.has(storeName) || SYNCED_ENTITY_STORES.has(storeName))) {
      const checkReq = store.get(obj.id);
      checkReq.onsuccess = () => {
        const existing = checkReq.result;
        if (SCOPED_STORES.has(storeName) && existing && (existing.projectId || ORIGINAL_PROJECT) !== scope) {
          customError = new Error('Colisión de ID: ya existe un registro con este identificador en otra historia.');
          try { transaction.abort(); } catch { }
          return;
        }
        stampSyncFields(storeName, obj, existing);
        store.put(obj);
      };
    } else {
      stampSyncFields(storeName, obj, null);
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
  } else if (storeName === 'universalCharacters') {
    if (item.name !== undefined && typeof item.name !== 'string') throw new Error(`Nombre inválido en personaje universal (posición ${pos}).`);
    if (item.antiPatterns !== undefined && !Array.isArray(item.antiPatterns)) throw new Error(`antiPatterns inválido en personaje universal (posición ${pos}).`);
    if (item.defaultEnabled !== undefined && typeof item.defaultEnabled !== 'boolean') throw new Error(`defaultEnabled inválido en personaje universal (posición ${pos}).`);
  } else if (storeName === 'characterOverlays') {
    if (typeof item.baseCharacterId !== 'string' || !item.baseCharacterId.trim()) throw new Error(`baseCharacterId inválido en overlay (posición ${pos}).`);
    if (item.characterizationChanges !== undefined && !Array.isArray(item.characterizationChanges)) throw new Error(`characterizationChanges inválido en overlay (posición ${pos}).`);
    if (item.defaultEnabled !== undefined && typeof item.defaultEnabled !== 'boolean') throw new Error(`defaultEnabled inválido en overlay (posición ${pos}).`);
  } else if (storeName === 'storyConfigs') {
    if (item.fandom !== undefined && typeof item.fandom !== 'string') throw new Error(`fandom inválido en configuración de historia (posición ${pos}).`);
    if (item.proposals !== undefined && !Array.isArray(item.proposals)) throw new Error(`proposals inválido en configuración de historia (posición ${pos}).`);
  } else if (storeName === 'storyPresets') {
    if (item.name !== undefined && typeof item.name !== 'string') throw new Error(`Nombre inválido en preset de historia (posición ${pos}).`);
    if (item.fandom !== undefined && typeof item.fandom !== 'string') throw new Error(`fandom inválido en preset de historia (posición ${pos}).`);
  } else if (storeName === 'knowledgeFacts') {
    if (item.truth !== undefined && typeof item.truth !== 'string') throw new Error(`truth inválido en hecho de conocimiento (posición ${pos}).`);
    if (item.statusByCharacter !== undefined && !isPlainObject(item.statusByCharacter)) throw new Error(`statusByCharacter inválido en hecho de conocimiento (posición ${pos}).`);
    if (item.beliefsByCharacter !== undefined && !isPlainObject(item.beliefsByCharacter)) throw new Error(`beliefsByCharacter inválido en hecho de conocimiento (posición ${pos}).`);
  } else if (storeName === 'usageLog') {
    if (item.provider !== undefined && typeof item.provider !== 'string') throw new Error(`provider inválido en registro de uso (posición ${pos}).`);
  } else if (storeName === 'arcSummaries') {
    if (item.title !== undefined && typeof item.title !== 'string') throw new Error(`title inválido en resumen de arco (posición ${pos}).`);
    if (item.summary !== undefined && typeof item.summary !== 'string') throw new Error(`summary inválido en resumen de arco (posición ${pos}).`);
    if (item.arcOrder !== undefined && !Number.isFinite(Number(item.arcOrder))) throw new Error(`arcOrder inválido en resumen de arco (posición ${pos}).`);
  } else if (storeName === 'relationshipStates') {
    if (typeof item.pairKey !== 'string' || !item.pairKey.trim()) throw new Error(`pairKey inválido en estado relacional (posición ${pos}).`);
    if (item.participants !== undefined && !Array.isArray(item.participants)) throw new Error(`participants inválido en estado relacional (posición ${pos}).`);
    if (item.dimensions !== undefined && !isPlainObject(item.dimensions)) throw new Error(`dimensions inválido en estado relacional (posición ${pos}).`);
  } else if (storeName === 'lexicalIndexes') {
    if (typeof item.kind !== 'string' || !item.kind.trim()) throw new Error(`kind inválido en índice léxico (posición ${pos}).`);
  }
}

export function validateBackupDump(dump) {
  if (!isPlainObject(dump)) {
    throw new Error('El archivo no contiene una copia de seguridad válida.');
  }
  const meta = dump.__meta;
  let declaredVersion = null;
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
      declaredVersion = ver;
    }
  }
  const allStoreNames = Object.keys(STORES);
  const v1Set = new Set(V1_STORE_NAMES);
  const v2Set = new Set(V2_STORE_NAMES);
  const targetStores = [];
  const missingAllStores = [];
  for (const name of allStoreNames) {
    if (!(name in dump) || dump[name] === undefined) {
      missingAllStores.push(name);
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
  const hasAnyV2Store = targetStores.some((name) => !v1Set.has(name));
  const hasAnyV3Store = targetStores.some((name) => !v2Set.has(name));
  const inferredVersion = declaredVersion ?? (hasAnyV3Store ? 3 : (hasAnyV2Store ? 2 : 1));
  // Los índices derivados (`lexicalIndexes`) son opcionales en copias v3 porque se
  // reconstruyen de forma determinista a partir de capítulos y documentos aprobados.
  const expectedFullStores = inferredVersion === 1
    ? V1_STORE_NAMES
    : (inferredVersion === 2 ? V2_STORE_NAMES : V3_REQUIRED_STORE_NAMES);
  const targetSet = new Set(targetStores);
  const missingStores = expectedFullStores.filter((name) => !targetSet.has(name));
  const isFull = missingStores.length === 0 && meta?.backupKind !== 'partial';
  return {
    targetStores,
    missingStores,
    isFull,
    backupKind: isFull ? 'full' : 'partial',
    version: inferredVersion,
    schemaVersion: inferredVersion,
    includesDerivedIndexes: targetSet.has('lexicalIndexes'),
  };
}

async function exportAll({ includeDerivedIndexes = false } = {}) {
  const dump = {};
  const exportedStores = [];
  for (const name of Object.keys(STORES)) {
    if (!includeDerivedIndexes && DERIVED_STORES.has(name)) continue;
    const records = await rawGetAll(name);
    dump[name] = name === 'settings'
      ? records.map(sanitizeSettingsForBackup)
      : records;
    exportedStores.push(name);
  }
  dump.__meta = {
    app: 'pts-studio',
    backupKind: 'full',
    exportedAt: new Date().toISOString(),
    version: DB_VERSION,
    schemaVersion: DB_VERSION,
    storeNames: exportedStores,
    apiKeysExcluded: true,
    derivedIndexesExcluded: !includeDerivedIndexes,
  };
  return dump;
}

async function runAtomicTransaction(storeNames, mode, executor) {
  const names = [...new Set(Array.isArray(storeNames) ? storeNames : [storeNames])];
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(names, mode || 'readwrite');
    let resultValue;
    let customError = null;
    transaction.oncomplete = () => resolve(resultValue);
    transaction.onerror = () => reject(customError || transaction.error || new Error('La transacción en IndexedDB falló.'));
    transaction.onabort = () => reject(customError || transaction.error || new Error('La transacción en IndexedDB fue abortada.'));

    const stores = {};
    for (const name of names) stores[name] = transaction.objectStore(name);
    try {
      const maybePromise = executor({ transaction, stores, setResult: (v) => { resultValue = v; } });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((val) => {
          if (val !== undefined) resultValue = val;
        }).catch((err) => {
          customError = err;
          try { transaction.abort(); } catch { }
        });
      } else if (maybePromise !== undefined) {
        resultValue = maybePromise;
      }
    } catch (err) {
      customError = err;
      try { transaction.abort(); } catch { }
    }
  });
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
  const txStores = [...new Set([...targetStores, ...(!merge ? [...DERIVED_STORES] : [])])];

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(txStores, 'readwrite');
    let customError = null;
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(customError || transaction.error || new Error('No se pudo completar la importación.'));
    transaction.onabort = () => reject(customError || transaction.error || new Error('La importación fue abortada; tus datos previos permanecen intactos.'));

    const writeAll = () => {
      try {
        // Limpiar índices derivados obsoletos en restauración completa si la copia no los trae
        if (!merge) {
          for (const derived of DERIVED_STORES) {
            if (!targetStores.includes(derived)) {
              transaction.objectStore(derived).clear();
            }
          }
        }
        for (const name of targetStores) {
          const store = transaction.objectStore(name);
          if (!merge) store.clear();
          let hasMainSettings = false;

          for (const obj of dump[name]) {
            let safeObj = { ...obj };
            if (SCOPED_STORES.has(name) && !safeObj.projectId) {
              safeObj.projectId = ORIGINAL_PROJECT;
            }
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

export const db = {
  openDb,
  resetConnection,
  runAtomicTransaction,
  getAll,
  getByIndex,
  getByProjectIndex,
  get,
  put,
  del,
  clearStore,
  uid,
  exportAll,
  importAll,
  validateBackupDump,
  getActiveProjectId,
  setActiveProjectId,
};
