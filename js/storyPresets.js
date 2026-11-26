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

function normalizeTemplateGuestEntries(rawList, fandom) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    if (typeof item === 'string') {
      const id = extractLogicalId(item);
      if (!id) continue;
      if (fandom === PTS_FANDOM && id !== 'joseph') continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    } else if (isPlainObject(item)) {
      const id = extractLogicalId(item.characterId || item.id || '');
      if (!id) continue;
      if (fandom === PTS_FANDOM && id !== 'joseph') continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const rawOrder = item.effectiveChapterOrder !== undefined && item.effectiveChapterOrder !== null && item.effectiveChapterOrder !== ''
        ? Number(item.effectiveChapterOrder)
        : null;
      out.push({
        characterId: id,
        effectiveCheckpoint: cleanString(item.effectiveCheckpoint || ''),
        effectiveChapterOrder: Number.isFinite(rawOrder) && rawOrder > 0 ? Math.floor(rawOrder) : null,
        invitedAt: item.invitedAt ? cleanString(item.invitedAt) : null,
        authorizedBy: cleanString(item.authorizedBy || 'author'),
        note: cleanString(item.note || ''),
      });
    }
  }
  return out;
}

function stableComparable(value) {
  if (Array.isArray(value)) return value.map(stableComparable);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k === 'historyNote') continue; // Las notas privadas de historia no forman parte de la comparación de plantillas
      out[k] = stableComparable(value[k]);
    }
    return out;
  }
  return value;
}

function stripPrivateHistoryFromRelationships(relMap) {
  const cleaned = {};
  for (const [k, v] of Object.entries(relMap || {})) {
    if (isPlainObject(v)) {
      const copy = structuredClone(v);
      if ('historyNote' in copy) copy.historyNote = '';
      cleaned[k] = copy;
    } else {
      cleaned[k] = structuredClone(v);
    }
  }
  return cleaned;
}

export function normalizeStoryPreset(input, { existing = null, markAuthorEdited = false } = {}) {
  if (!isPlainObject(input)) throw new Error('El preset de historia debe ser un objeto.');
  const fandom = normalizeFandomNamespace(input.fandom !== undefined ? input.fandom : (existing?.fandom || NEUTRAL_FANDOM));
  const logicalId = cleanString(input.logicalId || extractLogicalId(input.id) || existing?.logicalId || db.uid());
  const name = cleanString(input.name || existing?.name);
  if (!name) throw new Error('El preset necesita un nombre.');
  const storageId = existing?.id || (cleanString(input.id).includes('::') ? cleanString(input.id) : makeNamespacedId(fandom, logicalId));
  const now = new Date().toISOString();

  // En Power to Strive, solo Joseph puede figurar como invitación opcional en una plantilla;
  // Anya y cualquier invitado no autorizado quedan estructuralmente excluidos.
  const rawGuests = input.roomGuestInvitations !== undefined
    ? input.roomGuestInvitations
    : (input.roomGuestIds !== undefined ? input.roomGuestIds : existing?.roomGuestInvitations);
  const safeGuests = normalizeTemplateGuestEntries(rawGuests, fandom);

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
 *
 * Reglas estrictas de seguridad:
 * - NUNCA sobrescribe silenciosamente relaciones, checkpoints, reactionMode,
 *   josephMarriage ni autorizaciones de overlays contradictorias: detecta conflictos
 *   y exige resolución explícita de la autora en `resolutions`.
 * - NUNCA transfiere invitaciones a sala ni historial privado de historia (`historyNote`)
 *   al combinar plantillas reutilizables.
 */
export function combinePresetTemplates(presets, { name = 'AU combinado', fandom = '', resolutions = {} } = {}) {
  if (!Array.isArray(presets) || !presets.length) {
    throw new Error('Selecciona al menos un preset para combinar.');
  }
  const resolvedResolutions = isPlainObject(resolutions) ? resolutions : {};
  const conflicts = [];

  const nonNeutralFandoms = [...new Set(
    presets.map((p) => normalizeFandomNamespace(p.fandom || NEUTRAL_FANDOM)).filter((f) => f !== NEUTRAL_FANDOM)
  )];
  let resolvedFandom = normalizeFandomNamespace(fandom || nonNeutralFandoms[0] || NEUTRAL_FANDOM);
  if (nonNeutralFandoms.length > 1 && !fandom) {
    if (resolvedResolutions.fandom) {
      resolvedFandom = normalizeFandomNamespace(resolvedResolutions.fandom);
    } else {
      conflicts.push({
        key: 'fandom',
        field: 'fandom',
        options: nonNeutralFandoms.map((f) => ({ value: f, sourcePresets: presets.filter((p) => normalizeFandomNamespace(p.fandom) === f).map((p) => p.name) })),
        message: `Los presets pertenecen a fandoms distintos (${nonNeutralFandoms.join(', ')}). Elige explícitamente un fandom o etiqueta de crossover.`,
      });
    }
  }

  // 1. reactionMode
  const reactionValues = [...new Set(presets.map((p) => Boolean(p.reactionMode)))];
  let reactionMode = reactionValues[0] ?? (resolvedFandom === PTS_FANDOM);
  if (reactionValues.length > 1) {
    if (typeof resolvedResolutions.reactionMode === 'boolean') {
      reactionMode = resolvedResolutions.reactionMode;
    } else {
      conflicts.push({
        key: 'reactionMode',
        field: 'reactionMode',
        options: reactionValues.map((val) => ({
          value: val,
          sourcePresets: presets.filter((p) => Boolean(p.reactionMode) === val).map((p) => p.name),
        })),
        message: 'Conflicto en reactionMode (sala de reacciones activada vs desactivada). Requiere decisión explícita.',
      });
    }
  }

  // 2. checkpointId
  const checkpoints = [...new Set(presets.map((p) => cleanString(p.checkpointId)).filter(Boolean))];
  let checkpointId = checkpoints[0] || '';
  if (checkpoints.length > 1) {
    if (resolvedResolutions.checkpointId !== undefined) {
      checkpointId = cleanString(resolvedResolutions.checkpointId);
    } else {
      conflicts.push({
        key: 'checkpointId',
        field: 'checkpointId',
        options: checkpoints.map((cp) => ({
          value: cp,
          sourcePresets: presets.filter((p) => cleanString(p.checkpointId) === cp).map((p) => p.name),
        })),
        message: `Conflicto de checkpoint narrativo (${checkpoints.join(' vs ')}). Elige explícitamente el checkpoint inicial.`,
      });
    }
  }

  // 3. josephMarriage
  const marriageValues = [...new Set(presets.map((p) => Boolean(p.josephMarriage)))];
  let josephMarriage = marriageValues[0] ?? false;
  if (marriageValues.length > 1) {
    if (typeof resolvedResolutions.josephMarriage === 'boolean') {
      josephMarriage = resolvedResolutions.josephMarriage;
    } else {
      conflicts.push({
        key: 'josephMarriage',
        field: 'josephMarriage',
        options: marriageValues.map((val) => ({
          value: val,
          sourcePresets: presets.filter((p) => Boolean(p.josephMarriage) === val).map((p) => p.name),
        })),
        message: 'Conflicto en estado de matrimonio con Joseph (activado vs desactivado). Requiere decisión explícita.',
      });
    }
  }

  // 4. relationshipStates (por cada clave, nunca sobrescribir valores distintos en silencio)
  const relByKey = new Map();
  for (const preset of presets) {
    for (const [k, rawVal] of Object.entries(preset.relationshipStates || {})) {
      if (!relByKey.has(k)) relByKey.set(k, []);
      const sanitizedVal = isPlainObject(rawVal)
        ? { ...structuredClone(rawVal), ...('historyNote' in rawVal ? { historyNote: '' } : {}) }
        : structuredClone(rawVal);
      relByKey.get(k).push({
        presetName: preset.name,
        value: sanitizedVal,
        signature: JSON.stringify(stableComparable(sanitizedVal)),
      });
    }
  }
  const relationships = {};
  for (const [relKey, entries] of relByKey.entries()) {
    const distinct = [];
    const seenSig = new Set();
    for (const entry of entries) {
      if (!seenSig.has(entry.signature)) {
        seenSig.add(entry.signature);
        distinct.push(entry);
      }
    }
    if (distinct.length === 1) {
      relationships[relKey] = structuredClone(distinct[0].value);
    } else {
      const conflictKey = `relationship:${relKey}`;
      if (Object.prototype.hasOwnProperty.call(resolvedResolutions, conflictKey)) {
        const chosen = resolvedResolutions[conflictKey];
        relationships[relKey] = isPlainObject(chosen)
          ? { ...structuredClone(chosen), ...('historyNote' in chosen ? { historyNote: '' } : {}) }
          : structuredClone(chosen);
      } else {
        conflicts.push({
          key: conflictKey,
          field: `relationshipStates.${relKey}`,
          options: distinct.map((d) => ({
            value: d.value,
            sourcePresets: entries.filter((e) => e.signature === d.signature).map((e) => e.presetName),
          })),
          message: `Estados contradictorios para la relación «${relKey}» entre presets (${distinct.map((d) => d.presetName).join(' vs ')}). Requiere resolución explícita de la autora.`,
        });
      }
    }
  }

  // 5. authorizedOverlays: detectar si dos presets dan configuraciones contradictorias para el mismo overlay o mismo personaje/ámbito
  const overlayByLogicalScope = new Map();
  for (const preset of presets) {
    for (const ov of (preset.authorizedOverlays || [])) {
      const logical = extractLogicalId(ov.overlayLogicalId || ov.overlayId || '');
      if (!logical) continue;
      const scopeKey = `${logical}::${ov.scope || 'story'}::${ov.characterVersion || 'all'}::${ov.sceneId || ''}`;
      if (!overlayByLogicalScope.has(scopeKey)) overlayByLogicalScope.set(scopeKey, []);
      overlayByLogicalScope.get(scopeKey).push({
        presetName: preset.name,
        overlay: structuredClone(ov),
        enabled: ov.enabled !== false,
      });
    }
  }
  const overlays = [];
  for (const [scopeKey, entries] of overlayByLogicalScope.entries()) {
    const enabledVals = [...new Set(entries.map((e) => e.enabled))];
    if (enabledVals.length === 1) {
      overlays.push(structuredClone(entries[0].overlay));
    } else {
      const conflictKey = `overlay:${scopeKey}`;
      if (Object.prototype.hasOwnProperty.call(resolvedResolutions, conflictKey)) {
        const chosen = resolvedResolutions[conflictKey];
        if (chosen && chosen !== 'omit') {
          overlays.push(isPlainObject(chosen) ? structuredClone(chosen) : { ...structuredClone(entries[0].overlay), enabled: Boolean(chosen) });
        }
      } else {
        conflicts.push({
          key: conflictKey,
          field: 'authorizedOverlays',
          options: entries.map((e) => ({ value: e.overlay, sourcePresets: [e.presetName] })),
          message: `Autorización contradictoria del overlay «${scopeKey}» entre presets. Requiere resolución explícita.`,
        });
      }
    }
  }

  // Si existen conflictos sin resolver, NO construir un preset con sobrescrituras silenciosas.
  if (conflicts.length > 0) {
    return {
      ok: false,
      requiresAuthorResolution: true,
      conflicts,
      preset: null,
    };
  }

  const optionalSet = new Set();
  const notes = [];
  for (const preset of presets) {
    for (const opt of (preset.enabledOptionalCharacters || [])) optionalSet.add(extractLogicalId(opt));
    if (preset.notes) notes.push(`${preset.name}: ${preset.notes}`);
  }

  // Al combinar plantillas reutilizables, NUNCA transferir invitaciones a sala ni historial privado de historias.
  const combinedPreset = normalizeStoryPreset({
    id: makeNamespacedId(resolvedFandom, db.uid()),
    name,
    fandom: resolvedFandom,
    isBuiltin: false,
    reactionMode,
    checkpointId,
    enabledOptionalCharacters: [...optionalSet],
    roomGuestInvitations: [],
    relationshipStates: stripPrivateHistoryFromRelationships(relationships),
    josephMarriage,
    anyaRoomEntry: false,
    authorizedOverlays: overlays,
    notes: notes.join(' | '),
  }, { markAuthorEdited: true });

  return {
    ok: true,
    requiresAuthorResolution: false,
    conflicts: [],
    preset: combinedPreset,
  };
}

/**
 * Crea una configuración de historia completamente independiente a partir de un preset.
 * Nunca copia capítulos, memorias ni continuidad de otras historias.
 */
export function buildStoryConfigFromPreset(projectId, preset, overrides = {}) {
  const fandom = normalizeFandomNamespace(overrides.fandom !== undefined ? overrides.fandom : (preset?.fandom || NEUTRAL_FANDOM));
  const base = createDefaultStoryConfig(projectId, { fandom, presetId: preset?.id || null });
  const rawInvites = overrides.roomGuestInvitations !== undefined
    ? overrides.roomGuestInvitations
    : (preset?.roomGuestInvitations || []);
  const preservedInvites = Array.isArray(rawInvites)
    ? rawInvites.map((item) => (typeof item === 'string' ? cleanString(item) : (isPlainObject(item) ? structuredClone(item) : null))).filter(Boolean)
    : [];

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
    roomGuestInvitations: preservedInvites,
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
