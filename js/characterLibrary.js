// characterLibrary.js — Biblioteca universal de personajes, overlays reutilizables,
// importador transaccional validado de la Master Character Bible v1.1 y resolvedor determinista.
//
// Reglas clave:
// - Las identidades de almacenamiento están namespaced por fandom (`${fandom}::${logicalId}`)
//   conservando el `logicalId` estable (`levi`, `levi_violet_traits`, `violet_au`) para
//   evitar colisiones entre fandoms sin perder legibilidad.
// - Importar una Biblia Maestra es atómico (una sola transacción IndexedDB) y protege
//   perfiles/overlays marcados como editados por la autora.
// - Los rasgos de Violet para Levi son un overlay genérico vacío y desactivado por defecto.

import { db } from './db.js';
import { contentFingerprint } from './utils.js';

export const MASTER_BIBLE_SCHEMA = 'inky.master_character_bible';
export const MASTER_BIBLE_SUPPORTED_VERSIONS = new Set([1]);
export const ALLOWED_OVERLAY_SCOPES = ['story', 'character_version', 'scene'];
export const ALLOWED_CHARACTER_VERSIONS = ['default', 'room', 'screen', 'outside', 'custom'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = cleanString(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function cleanStringMap(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = cleanString(k);
    const val = cleanString(v);
    if (key && val) out[key] = val;
  }
  return out;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function normalizeFandomNamespace(fandom) {
  const raw = cleanString(fandom).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return raw || 'neutral';
}

export function extractLogicalId(id) {
  const raw = cleanString(id);
  const idx = raw.indexOf('::');
  return idx >= 0 ? raw.slice(idx + 2) : raw;
}

export function makeNamespacedId(fandom, logicalId) {
  const ns = normalizeFandomNamespace(fandom);
  const logical = extractLogicalId(logicalId);
  if (!logical) return '';
  return `${ns}::${logical}`;
}

export function isOverlayConfigured(overlay) {
  if (!isPlainObject(overlay)) return false;
  if (cleanStringArray(overlay.characterizationChanges).length > 0) return true;
  if (cleanString(overlay.backstoryChanges)) return true;
  if (typeof overlay.relationshipChanges === 'string' && overlay.relationshipChanges.trim()) return true;
  if (isPlainObject(overlay.relationshipChanges) && Object.keys(cleanStringMap(overlay.relationshipChanges)).length > 0) return true;
  return false;
}

export function normalizeUniversalCharacter(input, { existing = null, markAuthorEdited = false, revisionNote = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El perfil de personaje universal debe ser un objeto.');
  const fandom = normalizeFandomNamespace(input.fandom !== undefined ? input.fandom : (existing?.fandom || 'neutral'));
  const rawLogical = cleanString(input.logicalId || extractLogicalId(input.id) || existing?.logicalId || extractLogicalId(existing?.id));
  const name = cleanString(input.name || existing?.name);
  if (!rawLogical) throw new Error('El personaje universal requiere un identificador lógico estable (id/logicalId).');
  if (!name) throw new Error(`El personaje universal "${rawLogical}" requiere un nombre.`);

  const storageId = existing?.id || (cleanString(input.id).includes('::') ? cleanString(input.id) : makeNamespacedId(fandom, rawLogical));
  const category = ['core', 'optional', 'facilitator', 'custom'].includes(input.category)
    ? input.category
    : (existing?.category || 'custom');
  const defaultEnabled = category === 'optional'
    ? false
    : (typeof input.defaultEnabled === 'boolean' ? input.defaultEnabled : (existing?.defaultEnabled ?? true));

  const now = new Date().toISOString();
  const prevHistory = Array.isArray(existing?.revisionHistory) ? existing.revisionHistory : [];
  const nextRevision = (Number.isInteger(existing?.revision) ? existing.revision : 0) + 1;

  return {
    id: storageId,
    logicalId: rawLogical,
    name,
    aliases: cleanStringArray(input.aliases !== undefined ? input.aliases : existing?.aliases),
    pronouns: cleanString(input.pronouns !== undefined ? input.pronouns : existing?.pronouns),
    role: cleanString(input.role !== undefined ? input.role : existing?.role),
    fandom,
    category,
    defaultEnabled,
    corePersonality: cleanString(input.corePersonality !== undefined ? input.corePersonality : existing?.corePersonality),
    speechPatterns: cleanString(input.speechPatterns !== undefined ? input.speechPatterns : existing?.speechPatterns),
    motivations: cleanString(input.motivations !== undefined ? input.motivations : existing?.motivations),
    emotionalDefenses: cleanString(input.emotionalDefenses !== undefined ? input.emotionalDefenses : existing?.emotionalDefenses),
    bodyLanguage: cleanString(input.bodyLanguage !== undefined ? input.bodyLanguage : existing?.bodyLanguage),
    interpersonalDynamics: input.interpersonalDynamics !== undefined
      ? cleanStringMap(input.interpersonalDynamics)
      : cleanStringMap(existing?.interpersonalDynamics),
    strengthsVulnerabilities: cleanString(input.strengthsVulnerabilities !== undefined ? input.strengthsVulnerabilities : existing?.strengthsVulnerabilities),
    publicPrivateBehavior: cleanString(input.publicPrivateBehavior !== undefined ? input.publicPrivateBehavior : existing?.publicPrivateBehavior),
    antiPatterns: cleanStringArray(input.antiPatterns !== undefined ? input.antiPatterns : existing?.antiPatterns),
    stageDevelopment: cleanString(input.stageDevelopment !== undefined ? input.stageDevelopment : existing?.stageDevelopment),
    voiceExample: cleanString(input.voiceExample !== undefined ? input.voiceExample : existing?.voiceExample),
    variantPolicy: cleanString(input.variantPolicy !== undefined ? input.variantPolicy : existing?.variantPolicy),
    sourceAttribution: isPlainObject(input.sourceAttribution)
      ? { ...input.sourceAttribution }
      : (isPlainObject(existing?.sourceAttribution) ? { ...existing.sourceAttribution } : { source: 'author' }),
    authorEdited: markAuthorEdited ? true : Boolean(input.authorEdited ?? existing?.authorEdited ?? false),
    importedHash: cleanString(input.importedHash !== undefined ? input.importedHash : existing?.importedHash),
    revisionHistory: [
      ...prevHistory.slice(-24),
      {
        revision: nextRevision,
        at: now,
        note: cleanString(revisionNote) || (markAuthorEdited ? 'Edición de autora' : 'Actualización de biblioteca'),
        source: markAuthorEdited ? 'author' : cleanString(input.sourceAttribution?.schema || 'library'),
      },
    ],
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

export function normalizeCharacterOverlay(input, { existing = null, markAuthorEdited = false, revisionNote = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El overlay de personaje debe ser un objeto.');
  const fandom = normalizeFandomNamespace(input.fandom !== undefined ? input.fandom : (existing?.fandom || 'neutral'));
  const rawLogical = cleanString(input.logicalId || extractLogicalId(input.id) || existing?.logicalId || extractLogicalId(existing?.id));
  const name = cleanString(input.name || existing?.name);
  const rawBase = cleanString(input.baseCharacterId || existing?.baseCharacterId);
  if (!rawLogical) throw new Error('El overlay requiere un identificador estable (id/logicalId).');
  if (!name) throw new Error(`El overlay "${rawLogical}" requiere un nombre.`);
  if (!rawBase) throw new Error(`El overlay "${rawLogical}" requiere un baseCharacterId.`);

  const storageId = existing?.id || (cleanString(input.id).includes('::') ? cleanString(input.id) : makeNamespacedId(fandom, rawLogical));
  const baseCharacterId = extractLogicalId(rawBase);
  const baseCharacterStorageId = rawBase.includes('::') ? rawBase : makeNamespacedId(fandom, baseCharacterId);

  const rawScopes = Array.isArray(input.allowedScopes)
    ? input.allowedScopes
    : (Array.isArray(existing?.allowedScopes) ? existing.allowedScopes : ALLOWED_OVERLAY_SCOPES);
  const allowedScopes = rawScopes.filter((s) => ALLOWED_OVERLAY_SCOPES.includes(s));
  const finalScopes = allowedScopes.length ? allowedScopes : [...ALLOWED_OVERLAY_SCOPES];
  const requestedDefaultScope = cleanString(input.defaultScope || existing?.defaultScope || finalScopes[0]);
  const defaultScope = finalScopes.includes(requestedDefaultScope) ? requestedDefaultScope : finalScopes[0];

  const priority = Number.isFinite(Number(input.priority))
    ? Number(input.priority)
    : (Number.isFinite(Number(existing?.priority)) ? Number(existing.priority) : 50);

  const conflictResolution = ['ask_author', 'priority'].includes(input.conflictResolution)
    ? input.conflictResolution
    : (existing?.conflictResolution || 'ask_author');

  const now = new Date().toISOString();
  const prevHistory = Array.isArray(existing?.revisionHistory) ? existing.revisionHistory : [];
  const nextRevision = (Number.isInteger(existing?.revision) ? existing.revision : 0) + 1;

  const relationshipChanges = input.relationshipChanges !== undefined
    ? (typeof input.relationshipChanges === 'string'
        ? cleanString(input.relationshipChanges)
        : cleanStringMap(input.relationshipChanges))
    : (existing?.relationshipChanges !== undefined ? existing.relationshipChanges : {});

  const overlay = {
    id: storageId,
    logicalId: rawLogical,
    name,
    description: cleanString(input.description !== undefined ? input.description : existing?.description),
    baseCharacterId,
    baseCharacterStorageId,
    fandom,
    characterizationChanges: cleanStringArray(
      input.characterizationChanges !== undefined ? input.characterizationChanges : existing?.characterizationChanges
    ),
    preserveCoreTraits: cleanStringArray(
      input.preserveCoreTraits !== undefined ? input.preserveCoreTraits : existing?.preserveCoreTraits
    ),
    backstoryChanges: cleanString(input.backstoryChanges !== undefined ? input.backstoryChanges : existing?.backstoryChanges),
    relationshipChanges,
    activationConditions: cleanStringArray(
      input.activationConditions !== undefined ? input.activationConditions : existing?.activationConditions
    ),
    allowedScopes: finalScopes,
    defaultScope,
    priority,
    conflictGroup: cleanString(input.conflictGroup !== undefined ? input.conflictGroup : existing?.conflictGroup),
    conflictsWith: cleanStringArray(input.conflictsWith !== undefined ? input.conflictsWith : existing?.conflictsWith),
    conflictResolution,
    // Plantilla reutilizable: SIEMPRE desactivada por defecto.
    defaultEnabled: false,
    policy: cleanString(input.policy !== undefined ? input.policy : existing?.policy),
    traitsSource: cleanString(input.traitsSource !== undefined ? input.traitsSource : existing?.traitsSource),
    sourceAttribution: isPlainObject(input.sourceAttribution)
      ? { ...input.sourceAttribution }
      : (isPlainObject(existing?.sourceAttribution) ? { ...existing.sourceAttribution } : { source: 'author' }),
    authorEdited: markAuthorEdited ? true : Boolean(input.authorEdited ?? existing?.authorEdited ?? false),
    importedHash: cleanString(input.importedHash !== undefined ? input.importedHash : existing?.importedHash),
    revisionHistory: [
      ...prevHistory.slice(-24),
      {
        revision: nextRevision,
        at: now,
        note: cleanString(revisionNote) || (markAuthorEdited ? 'Edición de autora' : 'Plantilla de overlay guardada'),
        source: markAuthorEdited ? 'author' : cleanString(input.sourceAttribution?.schema || 'library'),
      },
    ],
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  overlay.configured = isOverlayConfigured(overlay);
  return overlay;
}

export function validateMasterCharacterBible(bible) {
  if (!isPlainObject(bible)) {
    throw new Error('El archivo no contiene un objeto JSON válido de Biblia Maestra.');
  }
  if (bible.schema !== MASTER_BIBLE_SCHEMA) {
    throw new Error(`Esquema no reconocido ("${String(bible.schema || '')}"). Se esperaba "${MASTER_BIBLE_SCHEMA}".`);
  }
  if (!MASTER_BIBLE_SUPPORTED_VERSIONS.has(Number(bible.schema_version))) {
    throw new Error(`Versión de esquema de Biblia Maestra no compatible (${String(bible.schema_version)}).`);
  }
  if (!Array.isArray(bible.core_characters) || !bible.core_characters.length) {
    throw new Error('La Biblia Maestra debe incluir al menos un personaje en "core_characters".');
  }
  if (bible.optional_characters !== undefined && !Array.isArray(bible.optional_characters)) {
    throw new Error('"optional_characters" debe ser un arreglo.');
  }
  if (bible.story_presets !== undefined && !Array.isArray(bible.story_presets)) {
    throw new Error('"story_presets" debe ser un arreglo.');
  }
  if (bible.optional_character_overlays !== undefined && !Array.isArray(bible.optional_character_overlays)) {
    throw new Error('"optional_character_overlays" debe ser un arreglo.');
  }
  if (!isPlainObject(bible.rules) || !isPlainObject(bible.rules.hard_constraints)) {
    throw new Error('La Biblia Maestra requiere "rules.hard_constraints".');
  }

  const seenCharIds = new Set();
  const optionalCharIds = new Set();
  for (const groupName of ['core_characters', 'optional_characters']) {
    const list = bible[groupName] || [];
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (!isPlainObject(ch)) throw new Error(`Entrada inválida en "${groupName}" (posición ${i + 1}).`);
      const id = extractLogicalId(ch.id);
      const name = cleanString(ch.name);
      if (!id || !name) throw new Error(`Falta "id" o "name" en "${groupName}" (posición ${i + 1}).`);
      if (seenCharIds.has(id)) throw new Error(`Identificador de personaje duplicado "${id}" en la Biblia Maestra.`);
      seenCharIds.add(id);
      if (groupName === 'optional_characters') optionalCharIds.add(id);
    }
  }

  const seenOverlayIds = new Set();
  for (let i = 0; i < (bible.optional_character_overlays || []).length; i++) {
    const ov = bible.optional_character_overlays[i];
    if (!isPlainObject(ov)) throw new Error(`Overlay inválido en posición ${i + 1}.`);
    const id = extractLogicalId(ov.id);
    const baseId = extractLogicalId(ov.character_id || ov.baseCharacterId);
    if (!id || !baseId) throw new Error(`Overlay sin "id" o "character_id" en posición ${i + 1}.`);
    if (seenOverlayIds.has(id)) throw new Error(`Identificador de overlay duplicado "${id}".`);
    if (!seenCharIds.has(baseId)) {
      throw new Error(`El overlay "${id}" referencia un personaje inexistente ("${baseId}").`);
    }
    seenOverlayIds.add(id);
  }

  const seenPresetIds = new Set();
  for (let i = 0; i < (bible.story_presets || []).length; i++) {
    const preset = bible.story_presets[i];
    if (!isPlainObject(preset)) throw new Error(`Preset inválido en posición ${i + 1}.`);
    const id = extractLogicalId(preset.id);
    const name = cleanString(preset.name);
    if (!id || !name) throw new Error(`Preset sin "id" o "name" en posición ${i + 1}.`);
    if (seenPresetIds.has(id)) throw new Error(`Identificador de preset duplicado "${id}".`);
    for (const optId of cleanStringArray(preset.enabled_optional || [])) {
      if (!optionalCharIds.has(extractLogicalId(optId))) {
        throw new Error(`El preset "${id}" referencia un personaje opcional inexistente ("${optId}").`);
      }
    }
    for (const guestId of cleanStringArray(preset.room_guest_ids || [])) {
      const gid = extractLogicalId(guestId);
      if (gid === 'anya' && bible.rules?.hard_constraints?.anya_room_entry === 'never') {
        throw new Error(`El preset "${id}" viola la regla no negociable: Anya nunca puede estar en room_guest_ids.`);
      }
      if (!seenCharIds.has(gid)) {
        throw new Error(`El preset "${id}" referencia un invitado de sala inexistente ("${guestId}").`);
      }
    }
    for (const ovId of cleanStringArray(preset.enabled_character_overlays || [])) {
      if (!seenOverlayIds.has(extractLogicalId(ovId))) {
        throw new Error(`El preset "${id}" referencia un overlay inexistente ("${ovId}").`);
      }
    }
    seenPresetIds.add(id);
  }

  return {
    schema: bible.schema,
    schemaVersion: Number(bible.schema_version),
    contentVersion: cleanString(bible.content_version || '1.0'),
    title: cleanString(bible.title || 'Master Character Bible'),
    fandom: normalizeFandomNamespace(bible.fandom || 'power_to_strive'),
    coreCount: bible.core_characters.length,
    optionalCount: (bible.optional_characters || []).length,
    overlayCount: (bible.optional_character_overlays || []).length,
    presetCount: (bible.story_presets || []).length,
  };
}

function inferPronouns(ch) {
  const id = extractLogicalId(ch.id).toLowerCase();
  const core = cleanString(ch.core).toLowerCase();
  if (ch.pronouns) return cleanString(ch.pronouns);
  if (id === 'hange' || core.includes('they/them')) return 'they/them';
  if (['petra', 'mikasa', 'sasha', 'ymir', 'historia', 'anya'].includes(id)) return 'she/her';
  if (['erwin', 'levi', 'eren', 'armin', 'jean', 'connie', 'joseph'].includes(id)) return 'he/him';
  return '';
}

function mapBibleCharacter(ch, category, bibleMeta, fandom) {
  const ns = normalizeFandomNamespace(fandom);
  const logicalId = extractLogicalId(ch.id);
  const aliases = [];
  if (logicalId === 'historia') aliases.push('Christa Lenz', 'Krista Lenz', 'Christa', 'Historia');
  if (logicalId === 'hange') aliases.push('Hanji Zoë', 'Hange', 'Hanji');
  if (logicalId === 'levi') aliases.push('Levi', 'Captain Levi');
  if (logicalId === 'erwin') aliases.push('Erwin', 'Commander Erwin');
  if (logicalId === 'joseph') aliases.push('Joseph');

  const payload = {
    id: makeNamespacedId(ns, logicalId),
    logicalId,
    name: cleanString(ch.name),
    aliases,
    pronouns: inferPronouns(ch),
    role: cleanString(ch.role),
    fandom: ns,
    category,
    defaultEnabled: category !== 'optional',
    corePersonality: cleanString(ch.core),
    speechPatterns: cleanString(ch.voice),
    motivations: cleanString(ch.attention),
    emotionalDefenses: cleanString(ch.stress_response),
    bodyLanguage: cleanString(ch.body_language),
    interpersonalDynamics: cleanStringMap(ch.relationships),
    strengthsVulnerabilities: cleanString(ch.strengths_vulnerabilities || ''),
    publicPrivateBehavior: cleanString(ch.public_private_behavior || ''),
    antiPatterns: cleanStringArray(ch.avoid),
    stageDevelopment: cleanString(ch.development),
    voiceExample: cleanString(ch.original_voice_example),
    variantPolicy: cleanString(ch.variant_policy),
    sourceAttribution: {
      schema: bibleMeta.schema,
      schemaVersion: bibleMeta.schemaVersion,
      contentVersion: bibleMeta.contentVersion,
      title: bibleMeta.title,
      sources: cleanStringArray(ch.sources),
    },
  };
  payload.importedHash = contentFingerprint(stableJson(payload));
  return payload;
}

function mapBibleOverlay(ov, bibleMeta, fandom) {
  const ns = normalizeFandomNamespace(fandom);
  const logicalId = extractLogicalId(ov.id);
  const baseLogicalId = extractLogicalId(ov.character_id || ov.baseCharacterId);
  const friendlyName = cleanString(ov.name) || (logicalId === 'levi_violet_traits' ? 'Violet Traits (Levi · Opt-in)' : logicalId);
  // IMPORTANTE: Nunca inventar rasgos de Violet. Si la Biblia no trae rasgos explícitos,
  // characterizationChanges queda vacío ([]) para que la autora los configure en Inky Paws.
  const payload = {
    id: makeNamespacedId(ns, logicalId),
    logicalId,
    name: friendlyName,
    description: cleanString(ov.description || ov.traits_source || 'Overlay opcional configurable por la autora.'),
    baseCharacterId: baseLogicalId,
    baseCharacterStorageId: makeNamespacedId(ns, baseLogicalId),
    fandom: ns,
    characterizationChanges: cleanStringArray(ov.characterization_changes || ov.characterizationChanges || []),
    preserveCoreTraits: cleanStringArray(ov.preserve_core_traits || ov.preserveCoreTraits || []),
    backstoryChanges: cleanString(ov.backstory_changes || ov.backstoryChanges || ''),
    relationshipChanges: isPlainObject(ov.relationship_changes || ov.relationshipChanges)
      ? cleanStringMap(ov.relationship_changes || ov.relationshipChanges)
      : cleanString(ov.relationship_changes || ov.relationshipChanges || ''),
    activationConditions: cleanStringArray(ov.activation || ov.activationConditions || []),
    allowedScopes: cleanStringArray(ov.allowed_scopes || ov.allowedScopes || ALLOWED_OVERLAY_SCOPES),
    defaultScope: 'story',
    priority: Number.isFinite(Number(ov.priority)) ? Number(ov.priority) : 50,
    conflictGroup: cleanString(ov.conflict_group || ov.conflictGroup || ''),
    conflictsWith: cleanStringArray(ov.conflicts_with || ov.conflictsWith || []),
    conflictResolution: 'ask_author',
    defaultEnabled: false,
    policy: cleanString(ov.policy || ''),
    traitsSource: cleanString(ov.traits_source || ''),
    sourceAttribution: {
      schema: bibleMeta.schema,
      schemaVersion: bibleMeta.schemaVersion,
      contentVersion: bibleMeta.contentVersion,
      title: bibleMeta.title,
    },
  };
  payload.importedHash = contentFingerprint(stableJson(payload));
  return payload;
}

function mapBiblePreset(preset, bibleMeta, fandom) {
  const ns = normalizeFandomNamespace(fandom);
  const logicalId = extractLogicalId(preset.id);
  const payload = {
    id: makeNamespacedId(ns, logicalId),
    logicalId,
    name: cleanString(preset.name),
    fandom: ns,
    isTemplate: true,
    enabledOptionalCharacters: cleanStringArray(preset.enabled_optional || []).map(extractLogicalId),
    roomGuestIds: cleanStringArray(preset.room_guest_ids || []).map(extractLogicalId),
    eruriState: cleanString(preset.eruri_state || 'mutual_attachment_unspoken'),
    josephMarriage: preset.joseph_marriage === true,
    josephMarriagePolicy: typeof preset.joseph_marriage === 'string' ? cleanString(preset.joseph_marriage) : '',
    anyaRoomEntry: false,
    authorizedOverlays: cleanStringArray(preset.enabled_character_overlays || []).map((overlayId) => ({
      overlayId: makeNamespacedId(ns, overlayId),
      overlayLogicalId: extractLogicalId(overlayId),
      scope: 'story',
      characterVersion: 'default',
      sceneId: null,
      enabled: true,
    })),
    notes: cleanString(preset.notes || ''),
    sourceAttribution: {
      schema: bibleMeta.schema,
      schemaVersion: bibleMeta.schemaVersion,
      contentVersion: bibleMeta.contentVersion,
      title: bibleMeta.title,
    },
  };
  payload.importedHash = contentFingerprint(stableJson(payload));
  return payload;
}

export function mapMasterCharacterBibleV1(bible, { fandom = '' } = {}) {
  const meta = validateMasterCharacterBible(bible);
  const ns = normalizeFandomNamespace(fandom || bible.fandom || meta.fandom || 'power_to_strive');
  const universalCharacters = [
    ...bible.core_characters.map((ch) => mapBibleCharacter(ch, 'core', meta, ns)),
    ...(bible.optional_characters || []).map((ch) => mapBibleCharacter(ch, 'optional', meta, ns)),
  ];
  const characterOverlays = (bible.optional_character_overlays || []).map((ov) => mapBibleOverlay(ov, meta, ns));
  const storyPresets = (bible.story_presets || []).map((preset) => mapBiblePreset(preset, meta, ns));
  return {
    metadata: {
      ...meta,
      fandom: ns,
      hardConstraints: { ...bible.rules.hard_constraints },
      checkpoints: Array.isArray(bible.checkpoints) ? bible.checkpoints.map((cp) => ({ ...cp })) : [],
      craftGuidelines: Array.isArray(bible.craft_guidelines) ? bible.craft_guidelines.map((g) => ({ ...g })) : [],
      sceneVoiceRouting: isPlainObject(bible.scene_voice_routing) ? { ...bible.scene_voice_routing } : {},
      knowledgeSchema: isPlainObject(bible.knowledge_schema) ? structuredClone(bible.knowledge_schema) : null,
      acceptanceTests: Array.isArray(bible.acceptance_tests) ? bible.acceptance_tests.map((t) => ({ ...t })) : [],
    },
    universalCharacters,
    characterOverlays,
    storyPresets,
  };
}

function stampAtomicSync(record, existing) {
  const now = new Date().toISOString();
  const prevRev = Number.isInteger(existing?.revision) ? existing.revision : 0;
  return {
    ...record,
    revision: prevRev + 1,
    syncUpdatedAt: now,
    deletedAt: record.deletedAt ?? null,
    dirty: true,
  };
}

function findMatchingExisting(mapById, list, incoming) {
  if (mapById.has(incoming.id)) return mapById.get(incoming.id);
  // Compatibilidad con registros pre-namespace del mismo fandom
  return list.find((item) =>
    normalizeFandomNamespace(item.fandom) === incoming.fandom &&
    extractLogicalId(item.logicalId || item.id) === incoming.logicalId
  ) || null;
}

export async function importMasterCharacterBible(bible, {
  fandom = '',
  overwriteAuthorEdited = false,
  selectedOverwriteIds = [],
} = {}) {
  // Validar y mapear TODO antes de abrir la transacción IndexedDB.
  const mapped = mapMasterCharacterBibleV1(bible, { fandom });
  const overwriteSet = new Set(cleanStringArray(selectedOverwriteIds));
  const shouldOverwrite = (incoming, existing) =>
    overwriteAuthorEdited ||
    overwriteSet.has(incoming.id) ||
    overwriteSet.has(incoming.logicalId) ||
    (existing && overwriteSet.has(existing.id));

  const summary = {
    ok: true,
    fandom: mapped.metadata.fandom,
    schema: mapped.metadata.schema,
    schemaVersion: mapped.metadata.schemaVersion,
    contentVersion: mapped.metadata.contentVersion,
    characters: { created: 0, updated: 0, unchanged: 0, protectedAuthorEdited: [] },
    overlays: { created: 0, updated: 0, unchanged: 0, protectedAuthorEdited: [] },
    presets: { created: 0, updated: 0, unchanged: 0, protectedAuthorEdited: [] },
    protectedAuthorEdited: [],
  };

  const database = await db.openDb();
  const storeNames = ['universalCharacters', 'characterOverlays', 'storyPresets', 'settings'];

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeNames, 'readwrite');
    let customError = null;
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(customError || transaction.error || new Error('No se pudo importar la Biblia Maestra.'));
    transaction.onabort = () => reject(customError || transaction.error || new Error('Importación de Biblia Maestra abortada; la biblioteca anterior permanece intacta.'));

    const existingData = { universalCharacters: null, characterOverlays: null, storyPresets: null };
    let pendingReads = 3;

    const applyAllWrites = () => {
      try {
        const charStore = transaction.objectStore('universalCharacters');
        const ovStore = transaction.objectStore('characterOverlays');
        const presetStore = transaction.objectStore('storyPresets');
        const settingsStore = transaction.objectStore('settings');

        const charList = existingData.universalCharacters || [];
        const ovList = existingData.characterOverlays || [];
        const presetList = existingData.storyPresets || [];
        const charById = new Map(charList.map((c) => [c.id, c]));
        const ovById = new Map(ovList.map((o) => [o.id, o]));
        const presetById = new Map(presetList.map((p) => [p.id, p]));

        for (const incoming of mapped.universalCharacters) {
          const existing = findMatchingExisting(charById, charList, incoming);
          if (!existing) {
            const record = normalizeUniversalCharacter(incoming, {
              markAuthorEdited: false,
              revisionNote: `Importado de ${mapped.metadata.title} v${mapped.metadata.contentVersion}`,
            });
            charStore.put(stampAtomicSync(record, null));
            summary.characters.created += 1;
            continue;
          }
          if (existing.authorEdited && !shouldOverwrite(incoming, existing)) {
            const entry = { store: 'universalCharacters', id: existing.id, logicalId: incoming.logicalId, name: existing.name, reason: 'author_edited' };
            summary.characters.protectedAuthorEdited.push(entry);
            summary.protectedAuthorEdited.push(entry);
            continue;
          }
          if (existing.importedHash === incoming.importedHash && !existing.authorEdited) {
            summary.characters.unchanged += 1;
            continue;
          }
          const updated = normalizeUniversalCharacter(incoming, {
            existing,
            markAuthorEdited: false,
            revisionNote: `Actualizado desde ${mapped.metadata.title} v${mapped.metadata.contentVersion}`,
          });
          updated.authorEdited = false;
          charStore.put(stampAtomicSync(updated, existing));
          summary.characters.updated += 1;
        }

        for (const incoming of mapped.characterOverlays) {
          const existing = findMatchingExisting(ovById, ovList, incoming);
          if (!existing) {
            const record = normalizeCharacterOverlay(incoming, {
              markAuthorEdited: false,
              revisionNote: `Plantilla importada de ${mapped.metadata.title} v${mapped.metadata.contentVersion}`,
            });
            ovStore.put(stampAtomicSync(record, null));
            summary.overlays.created += 1;
            continue;
          }
          if (existing.authorEdited && !shouldOverwrite(incoming, existing)) {
            const entry = { store: 'characterOverlays', id: existing.id, logicalId: incoming.logicalId, name: existing.name, reason: 'author_edited' };
            summary.overlays.protectedAuthorEdited.push(entry);
            summary.protectedAuthorEdited.push(entry);
            continue;
          }
          if (existing.importedHash === incoming.importedHash && !existing.authorEdited) {
            summary.overlays.unchanged += 1;
            continue;
          }
          const updated = normalizeCharacterOverlay(incoming, {
            existing,
            markAuthorEdited: false,
            revisionNote: `Plantilla actualizada desde ${mapped.metadata.title} v${mapped.metadata.contentVersion}`,
          });
          updated.authorEdited = false;
          ovStore.put(stampAtomicSync(updated, existing));
          summary.overlays.updated += 1;
        }

        const now = new Date().toISOString();
        for (const incoming of mapped.storyPresets) {
          const existing = findMatchingExisting(presetById, presetList, incoming);
          if (!existing) {
            presetStore.put(stampAtomicSync({ ...incoming, authorEdited: false, createdAt: now, updatedAt: now }, null));
            summary.presets.created += 1;
            continue;
          }
          if (existing.authorEdited && !shouldOverwrite(incoming, existing)) {
            const entry = { store: 'storyPresets', id: existing.id, logicalId: incoming.logicalId, name: existing.name, reason: 'author_edited' };
            summary.presets.protectedAuthorEdited.push(entry);
            summary.protectedAuthorEdited.push(entry);
            continue;
          }
          if (existing.importedHash === incoming.importedHash && !existing.authorEdited) {
            summary.presets.unchanged += 1;
            continue;
          }
          presetStore.put(stampAtomicSync({
            ...existing,
            ...incoming,
            id: existing.id,
            authorEdited: false,
            createdAt: existing.createdAt || now,
            updatedAt: now,
          }, existing));
          summary.presets.updated += 1;
        }

        settingsStore.put({
          id: `master-bible-meta:${mapped.metadata.fandom}`,
          ...mapped.metadata,
          lastImportedAt: now,
        });
      } catch (err) {
        customError = err;
        try { transaction.abort(); } catch { }
      }
    };

    for (const name of ['universalCharacters', 'characterOverlays', 'storyPresets']) {
      const req = transaction.objectStore(name).getAll();
      req.onsuccess = () => {
        existingData[name] = req.result || [];
        pendingReads -= 1;
        if (pendingReads === 0) applyAllWrites();
      };
      req.onerror = () => {
        customError = req.error;
        try { transaction.abort(); } catch { }
      };
    }
  });

  return summary;
}

// ---- CRUD de Biblioteca Universal y Overlays ----

export async function listUniversalCharacters({ fandom = '', category = '' } = {}) {
  const ns = fandom ? normalizeFandomNamespace(fandom) : '';
  const all = await db.getAll('universalCharacters');
  return (all || [])
    .filter((c) => !c.deletedAt)
    .filter((c) => !ns || normalizeFandomNamespace(c.fandom) === ns)
    .filter((c) => !category || c.category === category)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveUniversalCharacter(data, { authorEdited = true, revisionNote = '' } = {}) {
  const fandom = normalizeFandomNamespace(data?.fandom || 'neutral');
  const rawId = cleanString(data?.id);
  const existing = rawId ? await db.get('universalCharacters', rawId) : null;
  const logicalId = cleanString(data?.logicalId || extractLogicalId(rawId) || existing?.logicalId || db.uid());
  const storageId = existing?.id || (rawId.includes('::') ? rawId : makeNamespacedId(fandom, logicalId));
  const existingByNs = existing || await db.get('universalCharacters', storageId);
  const normalized = normalizeUniversalCharacter(
    { ...data, id: storageId, logicalId, fandom },
    { existing: existingByNs, markAuthorEdited: authorEdited, revisionNote }
  );
  return db.put('universalCharacters', normalized);
}

export async function listCharacterOverlays({ baseCharacterId = '', fandom = '' } = {}) {
  const ns = fandom ? normalizeFandomNamespace(fandom) : '';
  const baseLogical = baseCharacterId ? extractLogicalId(baseCharacterId) : '';
  const all = await db.getAll('characterOverlays');
  return (all || [])
    .filter((o) => !o.deletedAt)
    .filter((o) => !baseLogical || extractLogicalId(o.baseCharacterId) === baseLogical || o.baseCharacterStorageId === baseCharacterId)
    .filter((o) => !ns || normalizeFandomNamespace(o.fandom) === ns)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveCharacterOverlay(data, { authorEdited = true, revisionNote = '' } = {}) {
  const fandom = normalizeFandomNamespace(data?.fandom || 'neutral');
  const rawId = cleanString(data?.id);
  const existing = rawId ? await db.get('characterOverlays', rawId) : null;
  const logicalId = cleanString(data?.logicalId || extractLogicalId(rawId) || existing?.logicalId || db.uid());
  const storageId = existing?.id || (rawId.includes('::') ? rawId : makeNamespacedId(fandom, logicalId));
  const existingByNs = existing || await db.get('characterOverlays', storageId);
  const normalized = normalizeCharacterOverlay(
    { ...data, id: storageId, logicalId, fandom },
    { existing: existingByNs, markAuthorEdited: authorEdited, revisionNote }
  );
  return db.put('characterOverlays', normalized);
}

export async function deleteCharacterOverlay(id) {
  return db.del('characterOverlays', id);
}

export async function cloneCharacterOverlay(id, newName = '') {
  const source = await db.get('characterOverlays', id);
  if (!source) throw new Error('No se encontró el overlay a duplicar.');
  const newLogical = db.uid();
  const copy = {
    ...source,
    id: makeNamespacedId(source.fandom || 'neutral', newLogical),
    logicalId: newLogical,
    name: cleanString(newName) || `${source.name} (copia)`,
    defaultEnabled: false,
    authorEdited: true,
    importedHash: '',
    revisionHistory: [],
  };
  return saveCharacterOverlay(copy, { authorEdited: true, revisionNote: `Duplicado de "${source.name}"` });
}

// ---- Resolvedor Determinista de Personajes y Overlays (0 tokens) ----

function overlayMatchesCharacter(overlay, baseStorageId, baseLogicalId, fandom) {
  if (!overlay) return false;
  const ovFandom = normalizeFandomNamespace(overlay.fandom || 'neutral');
  const targetFandom = normalizeFandomNamespace(fandom || 'neutral');
  if (ovFandom !== 'neutral' && targetFandom !== 'neutral' && ovFandom !== targetFandom) return false;
  if (targetFandom === 'neutral' && ovFandom !== 'neutral') return false;
  return (
    overlay.baseCharacterStorageId === baseStorageId ||
    extractLogicalId(overlay.baseCharacterId) === baseLogicalId ||
    overlay.baseCharacterId === baseStorageId
  );
}

function findOverlayForActivation(activation, overlays, fandom) {
  const wantedId = cleanString(activation?.overlayId || activation?.overlayLogicalId);
  if (!wantedId) return null;
  const exact = (overlays || []).find((o) => o.id === wantedId);
  if (exact) return exact;
  const targetFandom = normalizeFandomNamespace(fandom || 'neutral');
  const wantedLogical = extractLogicalId(wantedId);
  return (overlays || []).find((o) => {
    const ovFandom = normalizeFandomNamespace(o.fandom || 'neutral');
    const fandomCompatible = ovFandom === targetFandom || ovFandom === 'neutral';
    return fandomCompatible && extractLogicalId(o.logicalId || o.id) === wantedLogical;
  }) || null;
}

function activationMatchesContext(activation, overlay, context) {
  if (!activation || activation.enabled !== true) return false;
  if (!overlay) return false;
  const scope = cleanString(activation.scope || overlay.defaultScope || 'story');
  if (!ALLOWED_OVERLAY_SCOPES.includes(scope)) return false;
  if (Array.isArray(overlay.allowedScopes) && overlay.allowedScopes.length && !overlay.allowedScopes.includes(scope)) {
    return false;
  }
  const targetVersion = cleanString(context?.characterVersion || 'default');
  const targetSceneId = cleanString(context?.sceneId || '');

  if (scope === 'story') {
    if (activation.characterVersion && activation.characterVersion !== 'all' && activation.characterVersion !== targetVersion) {
      return false;
    }
    return true;
  }
  if (scope === 'character_version') {
    const allowedVersion = cleanString(activation.characterVersion || '');
    return Boolean(allowedVersion) && allowedVersion === targetVersion;
  }
  if (scope === 'scene') {
    const allowedScene = cleanString(activation.sceneId || '');
    if (!allowedScene || !targetSceneId || allowedScene !== targetSceneId) return false;
    if (activation.characterVersion && activation.characterVersion !== 'all' && activation.characterVersion !== targetVersion) {
      return false;
    }
    return true;
  }
  return false;
}

function overlaysConflict(a, b) {
  if (a.id === b.id) return false;
  const aLogical = extractLogicalId(a.logicalId || a.id);
  const bLogical = extractLogicalId(b.logicalId || b.id);
  if (
    (a.conflictsWith || []).some((x) => x === b.id || extractLogicalId(x) === bLogical) ||
    (b.conflictsWith || []).some((x) => x === a.id || extractLogicalId(x) === aLogical)
  ) {
    return 'explicit_conflicts_with';
  }
  if (a.conflictGroup && b.conflictGroup && a.conflictGroup === b.conflictGroup) {
    return `conflict_group:${a.conflictGroup}`;
  }
  const bothChangeTraits = (a.characterizationChanges?.length > 0) && (b.characterizationChanges?.length > 0);
  const asksAuthor = a.conflictResolution !== 'priority' || b.conflictResolution !== 'priority';
  if (bothChangeTraits && asksAuthor) {
    return 'competing_characterization_overlays';
  }
  return '';
}

/**
 * Resuelve el perfil efectivo de un personaje de forma 100% pura y determinista.
 * Nunca muta el perfil universal ni las plantillas de overlay.
 */
export function resolveCharacterProfile({
  universalProfile = null,
  storyCharacter = null,
  overlays = [],
  activations = [],
  context = {},
} = {}) {
  const fandom = normalizeFandomNamespace(context?.fandom || universalProfile?.fandom || 'neutral');
  const baseStorageId = cleanString(universalProfile?.id || storyCharacter?.universalCharacterId || storyCharacter?.id);
  const baseLogicalId = extractLogicalId(universalProfile?.logicalId || baseStorageId);
  const name = cleanString(storyCharacter?.name || universalProfile?.name || baseLogicalId);

  const baseProfile = universalProfile ? structuredClone(universalProfile) : null;
  const storyState = storyCharacter ? structuredClone(storyCharacter) : null;

  const warnings = [];
  const conflicts = [];
  const unconfiguredOverlays = [];
  const candidateConfigured = [];
  const seenCandidateIds = new Set();

  for (const activation of (activations || [])) {
    const overlay = findOverlayForActivation(activation, overlays, fandom);
    if (!overlay || !overlayMatchesCharacter(overlay, baseStorageId, baseLogicalId, fandom)) continue;
    if (!activationMatchesContext(activation, overlay, context)) continue;

    if (!isOverlayConfigured(overlay)) {
      const info = {
        overlayId: overlay.id,
        overlayLogicalId: overlay.logicalId || extractLogicalId(overlay.id),
        overlayName: overlay.name,
        scope: activation.scope || overlay.defaultScope,
        characterVersion: activation.characterVersion || context?.characterVersion || 'default',
        sceneId: activation.sceneId || null,
      };
      unconfiguredOverlays.push(info);
      warnings.push({
        type: 'overlay_unconfigured',
        overlayId: overlay.id,
        overlayLogicalId: info.overlayLogicalId,
        characterId: baseLogicalId,
        characterStorageId: baseStorageId,
        message: `El overlay «${overlay.name}» está autorizado para ${name}, pero todavía no tiene rasgos definidos. Se conserva la caracterización estándar sin inventar rasgos.`,
      });
      continue;
    }
    if (seenCandidateIds.has(overlay.id)) continue;
    seenCandidateIds.add(overlay.id);
    candidateConfigured.push({ overlay: structuredClone(overlay), activation: structuredClone(activation) });
  }

  const blockedIds = new Set();
  const approvedWinners = isPlainObject(context?.approvedConflictWinners) ? context.approvedConflictWinners : {};
  for (let i = 0; i < candidateConfigured.length; i++) {
    for (let j = i + 1; j < candidateConfigured.length; j++) {
      const a = candidateConfigured[i].overlay;
      const b = candidateConfigured[j].overlay;
      const reason = overlaysConflict(a, b);
      if (!reason) continue;
      const pairKey = [a.id, b.id].sort().join('::');
      const logicalPairKey = [extractLogicalId(a.logicalId || a.id), extractLogicalId(b.logicalId || b.id)].sort().join('::');
      const winnerId = cleanString(
        approvedWinners[pairKey] ||
        approvedWinners[logicalPairKey] ||
        approvedWinners[baseStorageId] ||
        approvedWinners[baseLogicalId]
      );
      const aMatchesWinner = winnerId && (winnerId === a.id || extractLogicalId(winnerId) === extractLogicalId(a.logicalId || a.id));
      const bMatchesWinner = winnerId && (winnerId === b.id || extractLogicalId(winnerId) === extractLogicalId(b.logicalId || b.id));
      if (aMatchesWinner) {
        blockedIds.add(b.id);
        continue;
      }
      if (bMatchesWinner) {
        blockedIds.add(a.id);
        continue;
      }
      blockedIds.add(a.id);
      blockedIds.add(b.id);
      conflicts.push({
        type: 'overlay_conflict',
        pairKey,
        logicalPairKey,
        characterId: baseLogicalId,
        characterStorageId: baseStorageId,
        characterName: name,
        overlayIds: [a.id, b.id],
        overlayLogicalIds: [a.logicalId || extractLogicalId(a.id), b.logicalId || extractLogicalId(b.id)],
        overlayNames: [a.name, b.name],
        reason,
        requiresAuthorDecision: true,
        message: `Conflicto de overlays para ${name}: «${a.name}» y «${b.name}» compiten en este ámbito (${reason}). Elige explícitamente cuál aplicar para evitar mezclas silenciosas.`,
      });
    }
  }

  const appliedEntries = candidateConfigured
    .filter((entry) => !blockedIds.has(entry.overlay.id))
    .sort((a, b) => (a.overlay.priority || 50) - (b.overlay.priority || 50));

  const mergedDynamics = {
    ...(baseProfile?.interpersonalDynamics || {}),
  };
  const overlayTraits = [];
  const preservedCoreTraits = [];
  const overlayBackstoryNotes = [];

  for (const { overlay } of appliedEntries) {
    for (const trait of (overlay.characterizationChanges || [])) overlayTraits.push(trait);
    for (const keep of (overlay.preserveCoreTraits || [])) preservedCoreTraits.push(keep);
    if (overlay.backstoryChanges) overlayBackstoryNotes.push(overlay.backstoryChanges);
    if (isPlainObject(overlay.relationshipChanges)) {
      for (const [k, v] of Object.entries(overlay.relationshipChanges)) {
        mergedDynamics[k] = mergedDynamics[k] ? `${mergedDynamics[k]} [Overlay ${overlay.name}: ${v}]` : v;
      }
    }
  }

  const effectiveProfile = {
    id: baseLogicalId,
    storageId: baseStorageId,
    name,
    pronouns: cleanString(storyState?.pronouns || baseProfile?.pronouns),
    role: cleanString(storyState?.role || baseProfile?.role),
    fandom,
    category: baseProfile?.category || 'custom',
    characterVersion: cleanString(context?.characterVersion || 'default'),
    sceneId: cleanString(context?.sceneId || '') || null,
    corePersonality: cleanString(storyState?.personality || baseProfile?.corePersonality),
    speechPatterns: cleanString(storyState?.speechStyle || baseProfile?.speechPatterns),
    motivations: cleanString(baseProfile?.motivations),
    emotionalDefenses: cleanString(baseProfile?.emotionalDefenses),
    bodyLanguage: cleanString(baseProfile?.bodyLanguage),
    interpersonalDynamics: mergedDynamics,
    storyRelationshipsText: cleanString(storyState?.relationships),
    chemistry: cleanString(storyState?.chemistry),
    currentKnowledge: cleanString(storyState?.currentKnowledge),
    hardRules: cleanString(storyState?.hardRules),
    antiPatterns: cleanStringArray([
      ...(baseProfile?.antiPatterns || []),
      ...(storyState?.neverDoRules ? [storyState.neverDoRules] : []),
    ]),
    stageDevelopment: cleanString(baseProfile?.stageDevelopment),
    voiceExample: cleanString(baseProfile?.voiceExample),
    overlayTraits: cleanStringArray(overlayTraits),
    preservedCoreTraits: cleanStringArray(preservedCoreTraits),
    overlayBackstoryNotes: cleanStringArray(overlayBackstoryNotes),
  };

  return {
    id: baseLogicalId,
    storageId: baseStorageId,
    name,
    isStandardDefault: appliedEntries.length === 0,
    appliedOverlays: appliedEntries.map(({ overlay, activation }) => ({
      overlayId: overlay.id,
      overlayLogicalId: overlay.logicalId || extractLogicalId(overlay.id),
      name: overlay.name,
      scope: activation.scope || overlay.defaultScope,
      characterVersion: activation.characterVersion || context?.characterVersion || 'default',
      sceneId: activation.sceneId || null,
      priority: overlay.priority,
    })),
    unconfiguredOverlays,
    warnings,
    conflicts,
    effectiveProfile,
    baseProfile,
    storyState,
  };
}

export function resolveStoryCharacterRoster({
  universalCharacters = [],
  storyCharacters = [],
  overlays = [],
  storyConfig = null,
  context = {},
} = {}) {
  const fandom = normalizeFandomNamespace(storyConfig?.fandom || context?.fandom || 'neutral');
  const enabledOptional = new Set(cleanStringArray(storyConfig?.enabledOptionalCharacters || []).map(extractLogicalId));
  const activations = Array.isArray(storyConfig?.overlayActivations) ? storyConfig.overlayActivations : [];
  const activeUniversalByLogical = new Map();
  const inactiveOptionalCharacters = [];

  for (const u of (universalCharacters || [])) {
    if (u.deletedAt) continue;
    const uFandom = normalizeFandomNamespace(u.fandom || 'neutral');
    if (fandom !== 'neutral' && uFandom !== 'neutral' && uFandom !== fandom) continue;
    if (fandom === 'neutral' && uFandom !== 'neutral') continue;

    const logical = extractLogicalId(u.logicalId || u.id);
    if (u.category === 'optional' && !enabledOptional.has(logical)) {
      inactiveOptionalCharacters.push({ id: logical, storageId: u.id, name: u.name, role: u.role, fandom: uFandom });
      continue;
    }
    activeUniversalByLogical.set(logical, u);
  }

  const storyByLogical = new Map();
  const standaloneStoryChars = [];
  for (const sc of (storyCharacters || [])) {
    if (sc.active === false) continue;
    const linkLogical = extractLogicalId(sc.universalCharacterId || sc.id);
    if (activeUniversalByLogical.has(linkLogical)) {
      storyByLogical.set(linkLogical, sc);
    } else {
      standaloneStoryChars.push(sc);
    }
  }

  const resolvedCharacters = [];
  const allConflicts = [];
  const allWarnings = [];
  const activeOverlays = [];
  const unconfiguredOverlays = [];

  for (const [logical, uProfile] of activeUniversalByLogical.entries()) {
    const resolved = resolveCharacterProfile({
      universalProfile: uProfile,
      storyCharacter: storyByLogical.get(logical) || null,
      overlays,
      activations,
      context: { ...context, fandom, approvedConflictWinners: storyConfig?.approvedConflictWinners || context?.approvedConflictWinners || {} },
    });
    resolvedCharacters.push(resolved);
    allConflicts.push(...resolved.conflicts);
    allWarnings.push(...resolved.warnings);
    activeOverlays.push(...resolved.appliedOverlays.map((a) => ({ ...a, characterId: logical, characterName: resolved.name })));
    unconfiguredOverlays.push(...resolved.unconfiguredOverlays.map((u) => ({ ...u, characterId: logical, characterName: resolved.name })));
  }

  for (const sc of standaloneStoryChars) {
    const resolved = resolveCharacterProfile({
      universalProfile: null,
      storyCharacter: sc,
      overlays,
      activations,
      context: { ...context, fandom, approvedConflictWinners: storyConfig?.approvedConflictWinners || context?.approvedConflictWinners || {} },
    });
    resolvedCharacters.push(resolved);
    allConflicts.push(...resolved.conflicts);
    allWarnings.push(...resolved.warnings);
    activeOverlays.push(...resolved.appliedOverlays.map((a) => ({ ...a, characterId: resolved.id, characterName: resolved.name })));
    unconfiguredOverlays.push(...resolved.unconfiguredOverlays.map((u) => ({ ...u, characterId: resolved.id, characterName: resolved.name })));
  }

  return {
    fandom,
    resolvedCharacters,
    inactiveOptionalCharacters,
    activeOverlays,
    unconfiguredOverlays,
    conflicts: allConflicts,
    warnings: allWarnings,
  };
}
