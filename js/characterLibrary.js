// characterLibrary.js — Biblioteca universal de personajes, overlays reutilizables,
// importador validado de la Master Character Bible v1.1 y resolvedor determinista.
//
// Reglas clave:
// - Los perfiles universales están separados del estado propio de cada historia.
// - Guardar una plantilla de personaje opcional u overlay en la biblioteca NUNCA
//   la activa en una historia ni muta el perfil universal base.
// - Los rasgos de Violet para Levi son un overlay genérico vacío y desactivado
//   por defecto: jamás se inventan rasgos no aprobados por la autora.

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
  const id = cleanString(input.id || existing?.id);
  const name = cleanString(input.name || existing?.name);
  if (!id) throw new Error('El personaje universal requiere un identificador estable (id).');
  if (!name) throw new Error(`El personaje universal "${id}" requiere un nombre.`);

  const category = ['core', 'optional', 'facilitator', 'custom'].includes(input.category)
    ? input.category
    : (existing?.category || 'custom');
  const defaultEnabled = category === 'optional'
    ? false
    : (typeof input.defaultEnabled === 'boolean' ? input.defaultEnabled : (existing?.defaultEnabled ?? true));

  const now = new Date().toISOString();
  const prevHistory = Array.isArray(existing?.revisionHistory) ? existing.revisionHistory : [];
  const nextRevision = (Number.isInteger(existing?.revision) ? existing.revision : 0) + 1;

  const normalized = {
    id,
    name,
    aliases: cleanStringArray(input.aliases !== undefined ? input.aliases : existing?.aliases),
    pronouns: cleanString(input.pronouns !== undefined ? input.pronouns : existing?.pronouns),
    role: cleanString(input.role !== undefined ? input.role : existing?.role),
    fandom: cleanString(input.fandom !== undefined ? input.fandom : (existing?.fandom || 'neutral')) || 'neutral',
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
  return normalized;
}

export function normalizeCharacterOverlay(input, { existing = null, markAuthorEdited = false, revisionNote = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El overlay de personaje debe ser un objeto.');
  const id = cleanString(input.id || existing?.id);
  const name = cleanString(input.name || existing?.name);
  const baseCharacterId = cleanString(input.baseCharacterId || existing?.baseCharacterId);
  if (!id) throw new Error('El overlay requiere un identificador estable (id).');
  if (!name) throw new Error(`El overlay "${id}" requiere un nombre.`);
  if (!baseCharacterId) throw new Error(`El overlay "${id}" requiere un baseCharacterId.`);

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
    id,
    name,
    description: cleanString(input.description !== undefined ? input.description : existing?.description),
    baseCharacterId,
    fandom: cleanString(input.fandom !== undefined ? input.fandom : (existing?.fandom || 'neutral')) || 'neutral',
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
  for (const groupName of ['core_characters', 'optional_characters']) {
    const list = bible[groupName] || [];
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (!isPlainObject(ch)) throw new Error(`Entrada inválida en "${groupName}" (posición ${i + 1}).`);
      const id = cleanString(ch.id);
      const name = cleanString(ch.name);
      if (!id || !name) throw new Error(`Falta "id" o "name" en "${groupName}" (posición ${i + 1}).`);
      if (seenCharIds.has(id)) throw new Error(`Identificador de personaje duplicado "${id}" en la Biblia Maestra.`);
      seenCharIds.add(id);
    }
  }

  const seenOverlayIds = new Set();
  for (let i = 0; i < (bible.optional_character_overlays || []).length; i++) {
    const ov = bible.optional_character_overlays[i];
    if (!isPlainObject(ov)) throw new Error(`Overlay inválido en posición ${i + 1}.`);
    const id = cleanString(ov.id);
    const baseId = cleanString(ov.character_id || ov.baseCharacterId);
    if (!id || !baseId) throw new Error(`Overlay sin "id" o "character_id" en posición ${i + 1}.`);
    if (seenOverlayIds.has(id)) throw new Error(`Identificador de overlay duplicado "${id}".`);
    seenOverlayIds.add(id);
  }

  const seenPresetIds = new Set();
  for (let i = 0; i < (bible.story_presets || []).length; i++) {
    const preset = bible.story_presets[i];
    if (!isPlainObject(preset)) throw new Error(`Preset inválido en posición ${i + 1}.`);
    const id = cleanString(preset.id);
    const name = cleanString(preset.name);
    if (!id || !name) throw new Error(`Preset sin "id" o "name" en posición ${i + 1}.`);
    if (seenPresetIds.has(id)) throw new Error(`Identificador de preset duplicado "${id}".`);
    seenPresetIds.add(id);
  }

  return {
    schema: bible.schema,
    schemaVersion: Number(bible.schema_version),
    contentVersion: cleanString(bible.content_version || '1.0'),
    title: cleanString(bible.title || 'Master Character Bible'),
    coreCount: bible.core_characters.length,
    optionalCount: (bible.optional_characters || []).length,
    overlayCount: (bible.optional_character_overlays || []).length,
    presetCount: (bible.story_presets || []).length,
  };
}

function inferPronouns(ch) {
  const id = cleanString(ch.id).toLowerCase();
  const core = cleanString(ch.core).toLowerCase();
  if (ch.pronouns) return cleanString(ch.pronouns);
  if (id === 'hange' || core.includes('they/them')) return 'they/them';
  if (['petra', 'mikasa', 'sasha', 'ymir', 'historia', 'anya'].includes(id)) return 'she/her';
  if (['erwin', 'levi', 'eren', 'armin', 'jean', 'connie', 'joseph'].includes(id)) return 'he/him';
  return '';
}

function mapBibleCharacter(ch, category, bibleMeta, fandom = 'power_to_strive') {
  const aliases = [];
  if (cleanString(ch.id) === 'historia') aliases.push('Christa Lenz', 'Krista Lenz', 'Christa', 'Historia');
  if (cleanString(ch.id) === 'hange') aliases.push('Hanji Zoë', 'Hange', 'Hanji');
  if (cleanString(ch.id) === 'levi') aliases.push('Levi', 'Captain Levi');
  if (cleanString(ch.id) === 'erwin') aliases.push('Erwin', 'Commander Erwin');
  if (cleanString(ch.id) === 'joseph') aliases.push('Joseph');

  const payload = {
    id: cleanString(ch.id),
    name: cleanString(ch.name),
    aliases,
    pronouns: inferPronouns(ch),
    role: cleanString(ch.role),
    fandom,
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

function mapBibleOverlay(ov, bibleMeta, fandom = 'power_to_strive') {
  const id = cleanString(ov.id);
  const baseCharacterId = cleanString(ov.character_id || ov.baseCharacterId);
  const friendlyName = cleanString(ov.name) || (id === 'levi_violet_traits' ? 'Violet Traits (Levi · Opt-in)' : id);
  // IMPORTANTE: Nunca inventar rasgos de Violet. Si la Biblia no trae rasgos explícitos,
  // characterizationChanges queda vacío ([]) para que la autora los configure en Inky Paws.
  const payload = {
    id,
    name: friendlyName,
    description: cleanString(ov.description || ov.traits_source || 'Overlay opcional configurable por la autora.'),
    baseCharacterId,
    fandom,
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

function mapBiblePreset(preset, bibleMeta, fandom = 'power_to_strive') {
  const payload = {
    id: cleanString(preset.id),
    name: cleanString(preset.name),
    fandom,
    isTemplate: true,
    enabledOptionalCharacters: cleanStringArray(preset.enabled_optional || []),
    roomGuestIds: cleanStringArray(preset.room_guest_ids || []),
    eruriState: cleanString(preset.eruri_state || 'mutual_attachment_unspoken'),
    josephMarriage: preset.joseph_marriage === true,
    josephMarriagePolicy: typeof preset.joseph_marriage === 'string' ? cleanString(preset.joseph_marriage) : '',
    anyaRoomEntry: false, // Invariante no negociable
    authorizedOverlays: cleanStringArray(preset.enabled_character_overlays || []).map((overlayId) => ({
      overlayId,
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

export function mapMasterCharacterBibleV1(bible, { fandom = 'power_to_strive' } = {}) {
  const meta = validateMasterCharacterBible(bible);
  const universalCharacters = [
    ...bible.core_characters.map((ch) => mapBibleCharacter(ch, 'core', meta, fandom)),
    ...(bible.optional_characters || []).map((ch) => mapBibleCharacter(ch, 'optional', meta, fandom)),
  ];
  const characterOverlays = (bible.optional_character_overlays || []).map((ov) => mapBibleOverlay(ov, meta, fandom));
  const storyPresets = (bible.story_presets || []).map((preset) => mapBiblePreset(preset, meta, fandom));
  return {
    metadata: {
      ...meta,
      fandom,
      hardConstraints: { ...bible.rules.hard_constraints },
      checkpoints: Array.isArray(bible.checkpoints) ? bible.checkpoints.map((cp) => ({ ...cp })) : [],
      craftGuidelines: Array.isArray(bible.craft_guidelines) ? bible.craft_guidelines.map((g) => ({ ...g })) : [],
      sceneVoiceRouting: isPlainObject(bible.scene_voice_routing) ? { ...bible.scene_voice_routing } : {},
    },
    universalCharacters,
    characterOverlays,
    storyPresets,
  };
}

export async function importMasterCharacterBible(bible, {
  fandom = 'power_to_strive',
  overwriteAuthorEdited = false,
  selectedOverwriteIds = [],
} = {}) {
  const mapped = mapMasterCharacterBibleV1(bible, { fandom });
  const overwriteSet = new Set(cleanStringArray(selectedOverwriteIds));

  const [existingChars, existingOverlays, existingPresets] = await Promise.all([
    db.getAll('universalCharacters'),
    db.getAll('characterOverlays'),
    db.getAll('storyPresets'),
  ]);
  const charById = new Map((existingChars || []).map((c) => [c.id, c]));
  const overlayById = new Map((existingOverlays || []).map((o) => [o.id, o]));
  const presetById = new Map((existingPresets || []).map((p) => [p.id, p]));

  const summary = {
    ok: true,
    schema: mapped.metadata.schema,
    schemaVersion: mapped.metadata.schemaVersion,
    contentVersion: mapped.metadata.contentVersion,
    characters: { created: 0, updated: 0, unchanged: 0, protectedAuthorEdited: [] },
    overlays: { created: 0, updated: 0, unchanged: 0, protectedAuthorEdited: [] },
    presets: { created: 0, updated: 0, unchanged: 0, protectedAuthorEdited: [] },
    protectedAuthorEdited: [],
  };

  for (const incoming of mapped.universalCharacters) {
    const existing = charById.get(incoming.id) || null;
    if (!existing) {
      const record = normalizeUniversalCharacter(incoming, {
        markAuthorEdited: false,
        revisionNote: `Importado de ${mapped.metadata.title} v${mapped.metadata.contentVersion}`,
      });
      await db.put('universalCharacters', record);
      summary.characters.created += 1;
      continue;
    }
    if (existing.authorEdited && !overwriteAuthorEdited && !overwriteSet.has(incoming.id)) {
      const entry = { store: 'universalCharacters', id: incoming.id, name: existing.name, reason: 'author_edited' };
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
    await db.put('universalCharacters', updated);
    summary.characters.updated += 1;
  }

  for (const incoming of mapped.characterOverlays) {
    const existing = overlayById.get(incoming.id) || null;
    if (!existing) {
      const record = normalizeCharacterOverlay(incoming, {
        markAuthorEdited: false,
        revisionNote: `Plantilla importada de ${mapped.metadata.title} v${mapped.metadata.contentVersion}`,
      });
      await db.put('characterOverlays', record);
      summary.overlays.created += 1;
      continue;
    }
    if (existing.authorEdited && !overwriteAuthorEdited && !overwriteSet.has(incoming.id)) {
      const entry = { store: 'characterOverlays', id: incoming.id, name: existing.name, reason: 'author_edited' };
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
    await db.put('characterOverlays', updated);
    summary.overlays.updated += 1;
  }

  for (const incoming of mapped.storyPresets) {
    const existing = presetById.get(incoming.id) || null;
    const now = new Date().toISOString();
    if (!existing) {
      await db.put('storyPresets', { ...incoming, authorEdited: false, createdAt: now, updatedAt: now });
      summary.presets.created += 1;
      continue;
    }
    if (existing.authorEdited && !overwriteAuthorEdited && !overwriteSet.has(incoming.id)) {
      const entry = { store: 'storyPresets', id: incoming.id, name: existing.name, reason: 'author_edited' };
      summary.presets.protectedAuthorEdited.push(entry);
      summary.protectedAuthorEdited.push(entry);
      continue;
    }
    if (existing.importedHash === incoming.importedHash && !existing.authorEdited) {
      summary.presets.unchanged += 1;
      continue;
    }
    await db.put('storyPresets', {
      ...existing,
      ...incoming,
      authorEdited: false,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    });
    summary.presets.updated += 1;
  }

  // Persistir metadatos de la biblioteca sin modificar historias existentes.
  await db.put('settings', {
    id: `master-bible-meta:${fandom}`,
    fandom,
    ...mapped.metadata,
    lastImportedAt: new Date().toISOString(),
  });

  return summary;
}

// ---- CRUD de Biblioteca Universal y Overlays ----

export async function listUniversalCharacters({ fandom = '', category = '' } = {}) {
  const all = await db.getAll('universalCharacters');
  return (all || [])
    .filter((c) => !c.deletedAt)
    .filter((c) => !fandom || c.fandom === fandom)
    .filter((c) => !category || c.category === category)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveUniversalCharacter(data, { authorEdited = true, revisionNote = '' } = {}) {
  const id = cleanString(data?.id) || db.uid();
  const existing = await db.get('universalCharacters', id);
  const normalized = normalizeUniversalCharacter(
    { ...data, id },
    { existing, markAuthorEdited: authorEdited, revisionNote }
  );
  return db.put('universalCharacters', normalized);
}

export async function listCharacterOverlays({ baseCharacterId = '', fandom = '' } = {}) {
  const all = await db.getAll('characterOverlays');
  return (all || [])
    .filter((o) => !o.deletedAt)
    .filter((o) => !baseCharacterId || o.baseCharacterId === baseCharacterId)
    .filter((o) => !fandom || o.fandom === fandom)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveCharacterOverlay(data, { authorEdited = true, revisionNote = '' } = {}) {
  const id = cleanString(data?.id) || db.uid();
  const existing = await db.get('characterOverlays', id);
  const normalized = normalizeCharacterOverlay(
    { ...data, id },
    { existing, markAuthorEdited: authorEdited, revisionNote }
  );
  return db.put('characterOverlays', normalized);
}

export async function deleteCharacterOverlay(id) {
  return db.del('characterOverlays', id);
}

export async function cloneCharacterOverlay(id, newName = '') {
  const source = await db.get('characterOverlays', id);
  if (!source) throw new Error('No se encontró el overlay a duplicar.');
  const copy = {
    ...source,
    id: db.uid(),
    name: cleanString(newName) || `${source.name} (copia)`,
    defaultEnabled: false,
    authorEdited: true,
    importedHash: '',
    revisionHistory: [],
  };
  return saveCharacterOverlay(copy, { authorEdited: true, revisionNote: `Duplicado de "${source.name}"` });
}

// ---- Resolvedor Determinista de Personajes y Overlays (0 tokens) ----

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
  if ((a.conflictsWith || []).includes(b.id) || (b.conflictsWith || []).includes(a.id)) {
    return 'explicit_conflicts_with';
  }
  if (a.conflictGroup && b.conflictGroup && a.conflictGroup === b.conflictGroup) {
    return `conflict_group:${a.conflictGroup}`;
  }
  // Si ambos definen cambios explícitos de caracterización y alguno pide decisión de autora,
  // evitar mezclarlos silenciosamente.
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
  const baseId = cleanString(universalProfile?.id || storyCharacter?.universalCharacterId || storyCharacter?.id);
  const name = cleanString(storyCharacter?.name || universalProfile?.name || baseId);
  const overlayById = new Map((overlays || []).map((o) => [o.id, o]));

  // Clonar inmutablemente las bases para garantizar cero mutación
  const baseProfile = universalProfile ? structuredClone(universalProfile) : null;
  const storyState = storyCharacter ? structuredClone(storyCharacter) : null;

  const warnings = [];
  const conflicts = [];
  const unconfiguredOverlays = [];
  const candidateConfigured = [];

  for (const activation of (activations || [])) {
    const overlay = overlayById.get(activation?.overlayId);
    if (!overlay || overlay.baseCharacterId !== baseId) continue;
    if (!activationMatchesContext(activation, overlay, context)) continue;

    if (!isOverlayConfigured(overlay)) {
      const info = {
        overlayId: overlay.id,
        overlayName: overlay.name,
        scope: activation.scope || overlay.defaultScope,
        characterVersion: activation.characterVersion || context?.characterVersion || 'default',
        sceneId: activation.sceneId || null,
      };
      unconfiguredOverlays.push(info);
      warnings.push({
        type: 'overlay_unconfigured',
        overlayId: overlay.id,
        characterId: baseId,
        message: `El overlay «${overlay.name}» está autorizado para ${name}, pero todavía no tiene rasgos definidos. Se conserva la caracterización estándar sin inventar rasgos.`,
      });
      continue;
    }
    candidateConfigured.push({ overlay: structuredClone(overlay), activation: structuredClone(activation) });
  }

  // Detección de conflictos entre overlays activos configurados
  const blockedIds = new Set();
  const approvedWinners = isPlainObject(context?.approvedConflictWinners) ? context.approvedConflictWinners : {};
  for (let i = 0; i < candidateConfigured.length; i++) {
    for (let j = i + 1; j < candidateConfigured.length; j++) {
      const a = candidateConfigured[i].overlay;
      const b = candidateConfigured[j].overlay;
      const reason = overlaysConflict(a, b);
      if (!reason) continue;
      const pairKey = [a.id, b.id].sort().join('::');
      const winnerId = cleanString(approvedWinners[pairKey] || approvedWinners[baseId]);
      if (winnerId === a.id) {
        blockedIds.add(b.id);
        continue;
      }
      if (winnerId === b.id) {
        blockedIds.add(a.id);
        continue;
      }
      // Conflicto sin decisión explícita de la autora: no mezclar silenciosamente.
      blockedIds.add(a.id);
      blockedIds.add(b.id);
      conflicts.push({
        type: 'overlay_conflict',
        pairKey,
        characterId: baseId,
        characterName: name,
        overlayIds: [a.id, b.id],
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
    id: baseId,
    name,
    pronouns: cleanString(storyState?.pronouns || baseProfile?.pronouns),
    role: cleanString(storyState?.role || baseProfile?.role),
    fandom: cleanString(baseProfile?.fandom || context?.fandom || 'neutral'),
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
    id: baseId,
    name,
    isStandardDefault: appliedEntries.length === 0,
    appliedOverlays: appliedEntries.map(({ overlay, activation }) => ({
      overlayId: overlay.id,
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
  const fandom = cleanString(storyConfig?.fandom || context?.fandom || 'neutral');
  const enabledOptional = new Set(cleanStringArray(storyConfig?.enabledOptionalCharacters || []));
  const activations = Array.isArray(storyConfig?.overlayActivations) ? storyConfig.overlayActivations : [];
  const activeUniversalById = new Map();
  const inactiveOptionalCharacters = [];

  for (const u of (universalCharacters || [])) {
    if (u.deletedAt) continue;
    // No contaminar historias de otros fandoms con personajes universales de Power to Strive.
    if (fandom !== 'neutral' && u.fandom && u.fandom !== 'neutral' && u.fandom !== fandom) continue;
    if (fandom === 'neutral' && u.fandom && u.fandom !== 'neutral') continue;

    if (u.category === 'optional' && !enabledOptional.has(u.id)) {
      inactiveOptionalCharacters.push({ id: u.id, name: u.name, role: u.role, fandom: u.fandom });
      continue;
    }
    activeUniversalById.set(u.id, u);
  }

  const storyByUniversalId = new Map();
  const standaloneStoryChars = [];
  for (const sc of (storyCharacters || [])) {
    if (sc.active === false) continue;
    if (sc.universalCharacterId && activeUniversalById.has(sc.universalCharacterId)) {
      storyByUniversalId.set(sc.universalCharacterId, sc);
    } else if (activeUniversalById.has(sc.id)) {
      storyByUniversalId.set(sc.id, sc);
    } else {
      standaloneStoryChars.push(sc);
    }
  }

  const resolvedCharacters = [];
  const allConflicts = [];
  const allWarnings = [];
  const activeOverlays = [];
  const unconfiguredOverlays = [];

  for (const [uid, uProfile] of activeUniversalById.entries()) {
    const resolved = resolveCharacterProfile({
      universalProfile: uProfile,
      storyCharacter: storyByUniversalId.get(uid) || null,
      overlays,
      activations,
      context: { ...context, fandom },
    });
    resolvedCharacters.push(resolved);
    allConflicts.push(...resolved.conflicts);
    allWarnings.push(...resolved.warnings);
    activeOverlays.push(...resolved.appliedOverlays.map((a) => ({ ...a, characterId: uid, characterName: resolved.name })));
    unconfiguredOverlays.push(...resolved.unconfiguredOverlays.map((u) => ({ ...u, characterId: uid, characterName: resolved.name })));
  }

  for (const sc of standaloneStoryChars) {
    const resolved = resolveCharacterProfile({
      universalProfile: null,
      storyCharacter: sc,
      overlays,
      activations,
      context: { ...context, fandom },
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
