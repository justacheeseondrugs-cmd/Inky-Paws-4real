// storyPresets.js — Biblioteca reutilizable, editable y duplicable de presets de historia.
//
// Reglas clave:
// - Los presets son PLANTILLAS de configuración: nunca contienen capítulos,
//   eventos del manuscrito, memorias ni canon heredado automáticamente.
// - Crear múltiples historias desde el mismo preset produce continuidades
//   completamente independientes.
// - Los fandoms no relacionados y la ficción original usan el namespace "neutral"
//   y NUNCA heredan reglas de Power to Strive.

import { db } from './db.js';
import {
  normalizeFandomNamespace,
  extractLogicalId,
  makeNamespacedId,
} from './characterLibrary.js';
import { createDefaultStoryConfig, saveStoryConfig } from './storyConfigSchema.js';

export const PTS_FANDOM = 'power_to_strive';
export const NEUTRAL_FANDOM = 'neutral';

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

export function getBuiltinPresets() {
  return [
    {
      id: makeNamespacedId(PTS_FANDOM, 'classic_eruri'),
      logicalId: 'classic_eruri',
      name: 'Classic Eruri',
      fandom: PTS_FANDOM,
      isBuiltin: true,
      isTemplate: true,
      reactionMode: true,
      checkpointId: 'before_first_screen',
      enabledOptionalCharacters: [],
      roomGuestInvitations: [],
      relationshipStates: {
        eruri: {
          state: 'mutual_pining',
          publiclyKnown: false,
          knownBy: ['erwin'],
          suspectedBy: [],
          historyNote: '',
        },
      },
      josephMarriage: false,
      anyaRoomEntry: false,
      authorizedOverlays: [],
      notes: 'Los 12 espectadores originales + Candy facilitadora. Levi estándar por defecto; sin Joseph, sin Anya y sin rasgos Violet.',
    },
    {
      id: makeNamespacedId(PTS_FANDOM, 'violet_au'),
      logicalId: 'violet_au',
      name: 'Violet AU',
      fandom: PTS_FANDOM,
      isBuiltin: true,
      isTemplate: true,
      reactionMode: true,
      checkpointId: 'before_first_screen',
      enabledOptionalCharacters: [],
      roomGuestInvitations: [],
      relationshipStates: {
        eruri: {
          state: 'mutual_pining',
          publiclyKnown: false,
          knownBy: ['erwin'],
          suspectedBy: [],
          historyNote: '',
        },
      },
      josephMarriage: false,
      anyaRoomEntry: false,
      authorizedOverlays: [
        {
          overlayId: makeNamespacedId(PTS_FANDOM, 'levi_violet_traits'),
          overlayLogicalId: 'levi_violet_traits',
          characterId: 'levi',
          scope: 'story',
          characterVersion: 'all',
          sceneId: null,
          enabled: true,
        },
      ],
      notes: 'Autoriza el overlay opcional Violet Traits para Levi (vacío hasta que definas tus rasgos en Character Lab). No activa Joseph ni Anya.',
    },
    {
      id: makeNamespacedId(PTS_FANDOM, 'joseph_au'),
      logicalId: 'joseph_au',
      name: 'Joseph AU',
      fandom: PTS_FANDOM,
      isBuiltin: true,
      isTemplate: true,
      reactionMode: true,
      checkpointId: 'before_first_screen',
      enabledOptionalCharacters: ['joseph'],
      roomGuestInvitations: [],
      relationshipStates: {
        eruri: {
          state: 'mutual_pining',
          publiclyKnown: false,
          knownBy: ['erwin'],
          suspectedBy: [],
          historyNote: '',
        },
      },
      josephMarriage: false,
      anyaRoomEntry: false,
      authorizedOverlays: [],
      notes: 'Habilita a Joseph fuera de la sala. NO lo invita automáticamente a la sala, NO activa matrimonio ni habilita a Anya.',
    },
    {
      id: makeNamespacedId(PTS_FANDOM, 'joseph_anya_family_au'),
      logicalId: 'joseph_anya_family_au',
      name: 'Joseph and Anya Family AU',
      fandom: PTS_FANDOM,
      isBuiltin: true,
      isTemplate: true,
      reactionMode: true,
      checkpointId: 'before_first_screen',
      enabledOptionalCharacters: ['joseph', 'anya'],
      roomGuestInvitations: [],
      relationshipStates: {
        eruri: {
          state: 'former_lovers',
          publiclyKnown: false,
          knownBy: ['erwin', 'levi'],
          suspectedBy: [],
          historyNote: 'Definir historia exacta por la autora; no se asume matrimonio ni conocimiento público.',
        },
      },
      josephMarriage: false,
      anyaRoomEntry: false,
      authorizedOverlays: [],
      notes: 'Habilita a Joseph y Anya como personajes opcionales. Anya puede aparecer en pantalla o escenas exteriores, NUNCA en la sala. Joseph requiere invitación explícita.',
    },
    {
      id: makeNamespacedId(PTS_FANDOM, 'custom_au'),
      logicalId: 'custom_au',
      name: 'Custom AU (Power to Strive)',
      fandom: PTS_FANDOM,
      isBuiltin: true,
      isTemplate: true,
      reactionMode: true,
      checkpointId: 'before_first_screen',
      enabledOptionalCharacters: [],
      roomGuestInvitations: [],
      relationshipStates: {
        eruri: {
          state: 'custom',
          customLabel: '',
          publiclyKnown: false,
          knownBy: [],
          suspectedBy: [],
          historyNote: '',
        },
      },
      josephMarriage: false,
      anyaRoomEntry: false,
      authorizedOverlays: [],
      notes: 'Plantilla personalizable que conserva los invariantes de Power to Strive y te deja combinar cualquier ajuste compatible.',
    },
    {
      id: makeNamespacedId(NEUTRAL_FANDOM, 'original_neutral'),
      logicalId: 'original_neutral',
      name: 'Ficción original / Otro fandom (neutral)',
      fandom: NEUTRAL_FANDOM,
      isBuiltin: true,
      isTemplate: true,
      reactionMode: false,
      checkpointId: '',
      enabledOptionalCharacters: [],
      roomGuestInvitations: [],
      relationshipStates: {},
      josephMarriage: false,
      anyaRoomEntry: false,
      authorizedOverlays: [],
      notes: 'Sin reglas heredadas de Power to Strive, sin Eruri automático y sin reparto preestablecido. Ideal para otros fandoms, crossovers o novelas originales.',
    },
  ];
}

export function normalizeStoryPreset(input, { existing = null, markAuthorEdited = false } = {}) {
  if (!isPlainObject(input)) throw new Error('El preset de historia debe ser un objeto.');
  const fandom = normalizeFandomNamespace(input.fandom !== undefined ? input.fandom : (existing?.fandom || NEUTRAL_FANDOM));
  const logicalId = cleanString(input.logicalId || extractLogicalId(input.id) || existing?.logicalId || db.uid());
  const name = cleanString(input.name || existing?.name);
  if (!name) throw new Error('El preset necesita un nombre.');
  const storageId = existing?.id || (cleanString(input.id).includes('::') ? cleanString(input.id) : makeNamespacedId(fandom, logicalId));
  const now = new Date().toISOString();

  // Anya NUNCA puede estar en roomGuestInvitations en Power to Strive.
  const rawGuests = cleanStringArray(
    input.roomGuestInvitations !== undefined
      ? input.roomGuestInvitations
      : (input.roomGuestIds !== undefined ? input.roomGuestIds : existing?.roomGuestInvitations)
  ).map(extractLogicalId);
  const safeGuests = fandom === PTS_FANDOM
    ? rawGuests.filter((g) => g !== 'anya')
    : rawGuests;

  const rawOverlays = Array.isArray(input.authorizedOverlays)
    ? input.authorizedOverlays
    : (Array.isArray(existing?.authorizedOverlays) ? existing.authorizedOverlays : []);

  return {
    id: storageId,
    logicalId,
    name,
    fandom,
    isBuiltin: Boolean(input.isBuiltin ?? existing?.isBuiltin ?? false),
    isTemplate: true,
    reactionMode: typeof input.reactionMode === 'boolean' ? input.reactionMode : Boolean(existing?.reactionMode ?? (fandom === PTS_FANDOM)),
    checkpointId: cleanString(input.checkpointId !== undefined ? input.checkpointId : existing?.checkpointId),
    enabledOptionalCharacters: cleanStringArray(
      input.enabledOptionalCharacters !== undefined ? input.enabledOptionalCharacters : existing?.enabledOptionalCharacters
    ).map(extractLogicalId),
    roomGuestInvitations: safeGuests,
    relationshipStates: isPlainObject(input.relationshipStates)
      ? structuredClone(input.relationshipStates)
      : (isPlainObject(existing?.relationshipStates) ? structuredClone(existing.relationshipStates) : {}),
    josephMarriage: typeof input.josephMarriage === 'boolean' ? input.josephMarriage : Boolean(existing?.josephMarriage ?? false),
    anyaRoomEntry: false,
    authorizedOverlays: rawOverlays.map((ov) => ({
      overlayId: cleanString(ov.overlayId || makeNamespacedId(fandom, ov.overlayLogicalId || '')),
      overlayLogicalId: extractLogicalId(ov.overlayLogicalId || ov.overlayId || ''),
      characterId: extractLogicalId(ov.characterId || ''),
      scope: ['story', 'character_version', 'scene'].includes(ov.scope) ? ov.scope : 'story',
      characterVersion: cleanString(ov.characterVersion || 'all'),
      sceneId: ov.sceneId ? cleanString(ov.sceneId) : null,
      enabled: ov.enabled !== false,
    })).filter((ov) => ov.overlayId),
    notes: cleanString(input.notes !== undefined ? input.notes : existing?.notes),
    authorEdited: markAuthorEdited ? true : Boolean(input.authorEdited ?? existing?.authorEdited ?? false),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

export async function ensureBuiltinPresets() {
  const existing = await db.getAll('storyPresets');
  const byId = new Map((existing || []).map((p) => [p.id, p]));
  const created = [];
  for (const builtin of getBuiltinPresets()) {
    if (byId.has(builtin.id)) continue;
    const saved = await db.put('storyPresets', normalizeStoryPreset(builtin, { markAuthorEdited: false }));
    created.push(saved);
  }
  return created;
}

export async function listStoryPresets({ fandom = '' } = {}) {
  await ensureBuiltinPresets();
  const ns = fandom ? normalizeFandomNamespace(fandom) : '';
  const all = await db.getAll('storyPresets');
  return (all || [])
    .filter((p) => !p.deletedAt)
    .filter((p) => !ns || normalizeFandomNamespace(p.fandom) === ns)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveStoryPreset(data, { authorEdited = true } = {}) {
  const fandom = normalizeFandomNamespace(data?.fandom || NEUTRAL_FANDOM);
  const rawId = cleanString(data?.id);
  const existing = rawId ? await db.get('storyPresets', rawId) : null;
  const logicalId = cleanString(data?.logicalId || extractLogicalId(rawId) || existing?.logicalId || db.uid());
  const storageId = existing?.id || (rawId.includes('::') ? rawId : makeNamespacedId(fandom, logicalId));
  const existingByNs = existing || await db.get('storyPresets', storageId);
  const normalized = normalizeStoryPreset({ ...data, id: storageId, logicalId, fandom }, { existing: existingByNs, markAuthorEdited: authorEdited });
  return db.put('storyPresets', normalized);
}

export async function duplicateStoryPreset(presetId, newName = '') {
  const source = await db.get('storyPresets', presetId);
  if (!source) throw new Error('No se encontró el preset a duplicar.');
  const logicalId = db.uid();
  const copy = {
    ...structuredClone(source),
    id: makeNamespacedId(source.fandom || NEUTRAL_FANDOM, logicalId),
    logicalId,
    name: cleanString(newName) || `${source.name} (copia)`,
    isBuiltin: false,
    authorEdited: true,
  };
  return saveStoryPreset(copy, { authorEdited: true });
}

export async function deleteStoryPreset(presetId) {
  return db.del('storyPresets', presetId);
}

/**
 * Combina ajustes compatibles de varios presets en un nuevo preset reutilizable
 * (sin modificar los presets originales ni el canon de ninguna historia).
 */
export function combinePresetTemplates(presets, { name = 'AU combinado', fandom = '' } = {}) {
  if (!Array.isArray(presets) || !presets.length) {
    throw new Error('Selecciona al menos un preset para combinar.');
  }
  const fandoms = new Set(presets.map((p) => normalizeFandomNamespace(p.fandom || NEUTRAL_FANDOM)).filter((f) => f !== NEUTRAL_FANDOM));
  if (fandoms.size > 1 && !fandom) {
    throw new Error(`Los presets seleccionados pertenecen a fandoms distintos (${[...fandoms].join(', ')}). Especifica un fandom explícito para un crossover.`);
  }
  const resolvedFandom = normalizeFandomNamespace(fandom || [...fandoms][0] || NEUTRAL_FANDOM);
  const optionalSet = new Set();
  const guestSet = new Set();
  const overlays = [];
  const relationships = {};
  let reactionMode = false;
  let checkpointId = '';
  const notes = [];

  for (const preset of presets) {
    if (preset.reactionMode) reactionMode = true;
    if (!checkpointId && preset.checkpointId) checkpointId = preset.checkpointId;
    for (const opt of (preset.enabledOptionalCharacters || [])) optionalSet.add(extractLogicalId(opt));
    for (const g of (preset.roomGuestInvitations || [])) {
      const gl = extractLogicalId(g);
      if (resolvedFandom === PTS_FANDOM && gl === 'anya') continue;
      guestSet.add(gl);
    }
    for (const [k, v] of Object.entries(preset.relationshipStates || {})) {
      relationships[k] = structuredClone(v);
    }
    for (const ov of (preset.authorizedOverlays || [])) {
      const exists = overlays.some((x) =>
        extractLogicalId(x.overlayId) === extractLogicalId(ov.overlayId) &&
        x.scope === ov.scope &&
        x.characterVersion === ov.characterVersion &&
        x.sceneId === ov.sceneId
      );
      if (!exists) overlays.push(structuredClone(ov));
    }
    if (preset.notes) notes.push(`${preset.name}: ${preset.notes}`);
  }

  return normalizeStoryPreset({
    id: makeNamespacedId(resolvedFandom, db.uid()),
    name,
    fandom: resolvedFandom,
    isBuiltin: false,
    reactionMode,
    checkpointId,
    enabledOptionalCharacters: [...optionalSet],
    roomGuestInvitations: [...guestSet],
    relationshipStates: relationships,
    josephMarriage: false,
    anyaRoomEntry: false,
    authorizedOverlays: overlays,
    notes: notes.join(' | '),
  }, { markAuthorEdited: true });
}

/**
 * Crea una configuración de historia completamente independiente a partir de un preset.
 * Nunca copia capítulos, memorias ni continuidad de otras historias.
 */
export function buildStoryConfigFromPreset(projectId, preset, overrides = {}) {
  const fandom = normalizeFandomNamespace(overrides.fandom !== undefined ? overrides.fandom : (preset?.fandom || NEUTRAL_FANDOM));
  const base = createDefaultStoryConfig(projectId, { fandom, presetId: preset?.id || null });
  const next = {
    ...base,
    presetId: preset?.id || null,
    universeName: cleanString(overrides.universeName || preset?.name || ''),
    premise: cleanString(overrides.premise || ''),
    checkpointId: cleanString(overrides.checkpointId !== undefined ? overrides.checkpointId : (preset?.checkpointId || '')),
    reactionMode: typeof overrides.reactionMode === 'boolean' ? overrides.reactionMode : Boolean(preset?.reactionMode ?? (fandom === PTS_FANDOM)),
    enabledOptionalCharacters: cleanStringArray(
      overrides.enabledOptionalCharacters !== undefined ? overrides.enabledOptionalCharacters : (preset?.enabledOptionalCharacters || [])
    ).map(extractLogicalId),
    roomGuestInvitations: cleanStringArray(
      overrides.roomGuestInvitations !== undefined ? overrides.roomGuestInvitations : (preset?.roomGuestInvitations || [])
    ).map(extractLogicalId),
    relationshipStates: structuredClone(
      isPlainObject(overrides.relationshipStates) ? overrides.relationshipStates : (preset?.relationshipStates || {})
    ),
    overlayActivations: structuredClone(
      Array.isArray(overrides.overlayActivations) ? overrides.overlayActivations : (preset?.authorizedOverlays || [])
    ),
    casts: isPlainObject(overrides.casts)
      ? {
          room: cleanStringArray(overrides.casts.room || []),
          screen: cleanStringArray(overrides.casts.screen || []),
          outside: cleanStringArray(overrides.casts.outside || []),
        }
      : { room: [], screen: [], outside: [] },
    privateAuthorKnowledge: cleanStringArray(overrides.privateAuthorKnowledge || []),
    storyRules: cleanStringArray(overrides.storyRules || []),
  };
  return next;
}

export async function applyPresetToStory(projectId, presetId, overrides = {}) {
  await ensureBuiltinPresets();
  const preset = await db.get('storyPresets', presetId);
  if (!preset) throw new Error('No se encontró el preset seleccionado.');
  const nextConfig = buildStoryConfigFromPreset(projectId, preset, overrides);
  return saveStoryConfig(nextConfig);
}
