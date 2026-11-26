// storyConfigSchema.js — Esquema de configuración de historia por fandom/universo
// y flujo de propuestas conversacionales con soporte para adiciones, correcciones
// y eliminaciones explícitas (Requirement B & C).
//
// Principio fundamental:
// - Una idea o propuesta sugerida en el chat NUNCA es canon activo hasta que la
//   autora la aprueba explícitamente.
// - Se distingue estrictamente un campo omitido (`undefined`: no cambiar) de un
//   valor intencionalmente vacío (`[]`, `{}`, `null`: limpiar/reemplazar).

import { db } from './db.js';
import { normalizeFandomNamespace, extractLogicalId } from './characterLibrary.js';

export const PROPOSAL_STATUSES = new Set(['proposed', 'approved', 'rejected']);

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

function normalizeOverlayEntry(item) {
  if (!isPlainObject(item) || !cleanString(item.overlayId || item.overlayLogicalId)) return null;
  const overlayId = cleanString(item.overlayId || item.overlayLogicalId);
  return {
    overlayId,
    overlayLogicalId: extractLogicalId(item.overlayLogicalId || overlayId),
    characterId: extractLogicalId(item.characterId || ''),
    scope: ['story', 'character_version', 'scene'].includes(item.scope) ? item.scope : 'story',
    characterVersion: cleanString(item.characterVersion || 'default'),
    sceneId: item.sceneId ? cleanString(item.sceneId) : null,
    enabled: item.enabled !== false,
  };
}

function normalizeCastPatch(rawOp) {
  if (!isPlainObject(rawOp)) return null;
  const patch = {};
  if (rawOp.set !== undefined) patch.set = cleanStringArray(rawOp.set);
  if (rawOp.add !== undefined) patch.add = cleanStringArray(rawOp.add);
  if (rawOp.remove !== undefined) patch.remove = cleanStringArray(rawOp.remove);
  return Object.keys(patch).length ? patch : null;
}

export function createDefaultStoryConfig(projectId, { fandom = 'neutral', presetId = null } = {}) {
  const now = new Date().toISOString();
  return {
    id: cleanString(projectId) || db.getActiveProjectId(),
    projectId: cleanString(projectId) || db.getActiveProjectId(),
    fandom: normalizeFandomNamespace(fandom || 'neutral'),
    presetId: presetId ? cleanString(presetId) : null,
    universeName: '',
    premise: '',
    checkpointId: '',
    reactionMode: false,
    relationshipStates: {},
    enabledOptionalCharacters: [],
    roomGuestInvitations: [],
    casts: {
      room: [],
      screen: [],
      outside: [],
    },
    overlayActivations: [],
    approvedConflictWinners: {},
    privateAuthorKnowledge: [],
    storyRules: [],
    proposals: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function validateConfigProposal(input) {
  if (!isPlainObject(input)) {
    throw new Error('La propuesta de configuración debe ser un objeto válido.');
  }
  const id = cleanString(input.id) || db.uid();
  const status = cleanString(input.status || 'proposed');
  if (!PROPOSAL_STATUSES.has(status)) {
    throw new Error(`Estado de propuesta inválido ("${status}").`);
  }

  // Operaciones explícitas sobre personajes opcionales (enable / disable / set)
  const optionalCharacterOps = {};
  if (isPlainObject(input.optionalCharacterOps)) {
    if (input.optionalCharacterOps.set !== undefined) {
      optionalCharacterOps.set = cleanStringArray(input.optionalCharacterOps.set).map(extractLogicalId);
    }
    if (input.optionalCharacterOps.enable !== undefined) {
      optionalCharacterOps.enable = cleanStringArray(input.optionalCharacterOps.enable).map(extractLogicalId);
    }
    if (input.optionalCharacterOps.disable !== undefined) {
      optionalCharacterOps.disable = cleanStringArray(input.optionalCharacterOps.disable).map(extractLogicalId);
    }
  } else if (input.enabledOptionalCharacters !== undefined) {
    // Compatibilidad: [] explícito limpia cuando replaceOptionalCharacters === true,
    // o habilita los elementos indicados.
    if (input.replaceOptionalCharacters === true || input.enabledOptionalCharacters === null) {
      optionalCharacterOps.set = cleanStringArray(input.enabledOptionalCharacters || []).map(extractLogicalId);
    } else {
      optionalCharacterOps.enable = cleanStringArray(input.enabledOptionalCharacters).map(extractLogicalId);
    }
  }

  // Operaciones explícitas sobre invitaciones a sala (p.ej. invitar o revocar a Joseph)
  const guestInvitationOps = {};
  if (isPlainObject(input.guestInvitationOps)) {
    if (input.guestInvitationOps.set !== undefined) {
      guestInvitationOps.set = cleanStringArray(input.guestInvitationOps.set).map(extractLogicalId);
    }
    if (input.guestInvitationOps.invite !== undefined) {
      guestInvitationOps.invite = cleanStringArray(input.guestInvitationOps.invite).map(extractLogicalId);
    }
    if (input.guestInvitationOps.revoke !== undefined) {
      guestInvitationOps.revoke = cleanStringArray(input.guestInvitationOps.revoke).map(extractLogicalId);
    }
  }

  // Operaciones explícitas sobre casts: distinguir omitido (undefined) de [] (limpiar cast!)
  const castOps = {};
  if (isPlainObject(input.castOps)) {
    for (const layer of ['room', 'screen', 'outside']) {
      const patch = normalizeCastPatch(input.castOps[layer]);
      if (patch) castOps[layer] = patch;
    }
  }
  const casts = {};
  if (isPlainObject(input.casts)) {
    for (const layer of ['room', 'screen', 'outside']) {
      if (Object.prototype.hasOwnProperty.call(input.casts, layer) && input.casts[layer] !== undefined) {
        casts[layer] = cleanStringArray(input.casts[layer] || []);
        if (!castOps[layer]) castOps[layer] = { set: casts[layer] };
      }
    }
  }

  // Operaciones explícitas sobre overlays (add / disable / remove / set)
  const overlayOps = {};
  if (isPlainObject(input.overlayOps)) {
    if (input.overlayOps.set !== undefined) {
      overlayOps.set = (Array.isArray(input.overlayOps.set) ? input.overlayOps.set : []).map(normalizeOverlayEntry).filter(Boolean);
    }
    if (input.overlayOps.add !== undefined) {
      overlayOps.add = (Array.isArray(input.overlayOps.add) ? input.overlayOps.add : []).map(normalizeOverlayEntry).filter(Boolean);
    }
    if (input.overlayOps.disable !== undefined) {
      overlayOps.disable = cleanStringArray(input.overlayOps.disable);
    }
    if (input.overlayOps.remove !== undefined) {
      overlayOps.remove = cleanStringArray(input.overlayOps.remove);
    }
  } else if (input.characterOverlays !== undefined) {
    const normalized = (Array.isArray(input.characterOverlays) ? input.characterOverlays : []).map(normalizeOverlayEntry).filter(Boolean);
    if (input.replaceOverlays === true || (Array.isArray(input.characterOverlays) && input.characterOverlays.length === 0)) {
      overlayOps.set = normalized;
    } else if (normalized.length) {
      overlayOps.add = normalized;
    }
  }

  // Operaciones explícitas sobre relaciones (set / remove; null en relationshipStates elimina clave)
  const relationshipOps = {};
  if (isPlainObject(input.relationshipOps)) {
    if (isPlainObject(input.relationshipOps.set)) relationshipOps.set = structuredClone(input.relationshipOps.set);
    if (Array.isArray(input.relationshipOps.remove)) relationshipOps.remove = cleanStringArray(input.relationshipOps.remove);
  }
  if (isPlainObject(input.relationshipStates)) {
    const setMap = { ...(relationshipOps.set || {}) };
    const removeList = [...(relationshipOps.remove || [])];
    for (const [k, v] of Object.entries(input.relationshipStates)) {
      const key = cleanString(k);
      if (!key) continue;
      if (v === null || v === '') removeList.push(key);
      else setMap[key] = structuredClone(v);
    }
    if (Object.keys(setMap).length) relationshipOps.set = setMap;
    if (removeList.length) relationshipOps.remove = cleanStringArray(removeList);
  }

  const now = new Date().toISOString();
  return {
    id,
    status,
    sourceMessage: cleanString(input.sourceMessage || ''),
    fandom: input.fandom !== undefined ? normalizeFandomNamespace(input.fandom) : undefined,
    universe: input.universe !== undefined ? cleanString(input.universe) : undefined,
    relationshipStates: isPlainObject(input.relationshipStates) ? structuredClone(input.relationshipStates) : undefined,
    relationshipOps,
    enabledOptionalCharacters: input.enabledOptionalCharacters !== undefined
      ? cleanStringArray(input.enabledOptionalCharacters || []).map(extractLogicalId)
      : undefined,
    optionalCharacterOps,
    guestInvitationOps,
    casts: Object.keys(casts).length ? casts : undefined,
    castOps,
    characterOverlays: input.characterOverlays !== undefined
      ? (Array.isArray(input.characterOverlays) ? input.characterOverlays : []).map(normalizeOverlayEntry).filter(Boolean)
      : undefined,
    overlayOps,
    privateAuthorCanon: input.privateAuthorCanon !== undefined ? cleanStringArray(input.privateAuthorCanon) : undefined,
    individualKnowledge: Array.isArray(input.individualKnowledge)
      ? input.individualKnowledge.filter(isPlainObject).map((k) => ({
          characterId: extractLogicalId(k.characterId || k.character || ''),
          fact: cleanString(k.fact || ''),
          state: ['unknown', 'suspects', 'knows', 'disputed'].includes(k.state) ? k.state : 'suspects',
          evidence: cleanString(k.evidence || ''),
        })).filter((k) => k.characterId && k.fact)
      : [],
    proposedEvents: cleanStringArray(input.proposedEvents || []),
    unresolvedAmbiguities: cleanStringArray(input.unresolvedAmbiguities || []),
    decisionNote: cleanString(input.decisionNote || ''),
    createdAt: input.createdAt || now,
    decidedAt: input.decidedAt || null,
  };
}

export async function getStoryConfig(projectId) {
  const id = cleanString(projectId) || db.getActiveProjectId();
  const stored = await db.get('storyConfigs', id);
  return stored || null;
}

export async function saveStoryConfig(config) {
  if (!isPlainObject(config)) throw new Error('Configuración de historia inválida.');
  const id = cleanString(config.id || config.projectId) || db.getActiveProjectId();
  const existing = await db.get('storyConfigs', id);
  const base = existing || createDefaultStoryConfig(id, { fandom: config.fandom || 'neutral' });
  const now = new Date().toISOString();
  const merged = {
    ...base,
    ...config,
    id,
    projectId: id,
    fandom: normalizeFandomNamespace(config.fandom !== undefined ? config.fandom : base.fandom),
    updatedAt: now,
  };
  return db.put('storyConfigs', merged);
}

export async function stageConfigProposal(projectId, proposalInput) {
  const id = cleanString(projectId) || db.getActiveProjectId();
  const existing = (await db.get('storyConfigs', id)) || createDefaultStoryConfig(id);
  const proposal = validateConfigProposal({ ...proposalInput, status: 'proposed', decidedAt: null });
  const proposals = [...(existing.proposals || []).filter((p) => p.id !== proposal.id), proposal];
  const saved = await saveStoryConfig({ ...existing, proposals });
  return { config: saved, proposal };
}

function applyStringSetOps(currentList, ops) {
  if (!isPlainObject(ops)) return [...(currentList || [])];
  let next = ops.set !== undefined ? [...ops.set] : [...(currentList || [])];
  if (Array.isArray(ops.add)) {
    for (const item of ops.add) {
      if (!next.includes(item)) next.push(item);
    }
  }
  if (Array.isArray(ops.enable)) {
    for (const item of ops.enable) {
      if (!next.includes(item)) next.push(item);
    }
  }
  if (Array.isArray(ops.invite)) {
    for (const item of ops.invite) {
      if (!next.includes(item)) next.push(item);
    }
  }
  const toRemove = new Set([
    ...(ops.remove || []),
    ...(ops.disable || []),
    ...(ops.revoke || []),
  ].map((s) => s.toLowerCase()));
  if (toRemove.size) {
    next = next.filter((item) => !toRemove.has(String(item).toLowerCase()));
  }
  return next;
}

function applyOverlayOps(currentList, ops) {
  if (!isPlainObject(ops)) return [...(currentList || [])];
  let next = ops.set !== undefined ? structuredClone(ops.set) : structuredClone(currentList || []);
  for (const ov of (ops.add || [])) {
    const idx = next.findIndex((x) =>
      (x.overlayId === ov.overlayId || extractLogicalId(x.overlayId) === extractLogicalId(ov.overlayId)) &&
      x.scope === ov.scope &&
      x.characterVersion === ov.characterVersion &&
      x.sceneId === ov.sceneId
    );
    if (idx >= 0) next[idx] = { ...next[idx], ...ov };
    else next.push(ov);
  }
  if (Array.isArray(ops.disable) && ops.disable.length) {
    const disableSet = new Set(ops.disable.flatMap((id) => [id, extractLogicalId(id)]));
    next = next.map((x) => (
      disableSet.has(x.overlayId) || disableSet.has(extractLogicalId(x.overlayId))
        ? { ...x, enabled: false }
        : x
    ));
  }
  if (Array.isArray(ops.remove) && ops.remove.length) {
    const removeSet = new Set(ops.remove.flatMap((id) => [id, extractLogicalId(id)]));
    next = next.filter((x) => !removeSet.has(x.overlayId) && !removeSet.has(extractLogicalId(x.overlayId)));
  }
  return next;
}

export async function approveConfigProposal(projectId, proposalId, { decisionNote = '' } = {}) {
  const id = cleanString(projectId) || db.getActiveProjectId();
  const existing = await db.get('storyConfigs', id);
  if (!existing) throw new Error('No existe configuración de historia para esta propuesta.');
  const target = (existing.proposals || []).find((p) => p.id === proposalId);
  if (!target) throw new Error('No se encontró la propuesta indicada.');
  if (target.status !== 'proposed') throw new Error(`La propuesta ya fue resuelta (${target.status}).`);

  const now = new Date().toISOString();
  const updatedProposals = existing.proposals.map((p) =>
    p.id === proposalId ? { ...p, status: 'approved', decisionNote: cleanString(decisionNote), decidedAt: now } : p
  );

  // Relaciones: cambiar o eliminar claves explícitamente
  const nextRelationships = structuredClone(existing.relationshipStates || {});
  if (isPlainObject(target.relationshipOps?.set)) {
    for (const [k, v] of Object.entries(target.relationshipOps.set)) {
      nextRelationships[k] = structuredClone(v);
    }
  }
  for (const keyToRemove of (target.relationshipOps?.remove || [])) {
    delete nextRelationships[keyToRemove];
  }

  // Personajes opcionales e invitaciones (enable / disable / set / revoke)
  const nextOptional = applyStringSetOps(existing.enabledOptionalCharacters || [], target.optionalCharacterOps);
  let nextInvitations = applyStringSetOps(existing.roomGuestInvitations || [], target.guestInvitationOps);
  // Si se desactiva un personaje opcional, también revocar su invitación pendiente a la sala.
  const disabledOptional = new Set(target.optionalCharacterOps?.disable || []);
  if (disabledOptional.size) {
    nextInvitations = nextInvitations.filter((gid) => !disabledOptional.has(extractLogicalId(gid)));
  }

  // Casts: aplicar add / remove / set (incluyendo limpieza con [])
  const nextCasts = {
    room: applyStringSetOps(existing.casts?.room || [], target.castOps?.room),
    screen: applyStringSetOps(existing.casts?.screen || [], target.castOps?.screen),
    outside: applyStringSetOps(existing.casts?.outside || [], target.castOps?.outside),
  };

  // Overlays: aplicar add / disable / remove / set
  const nextOverlays = applyOverlayOps(existing.overlayActivations || [], target.overlayOps);

  // Canon privado propuesto (si fue incluido)
  const nextPrivate = target.privateAuthorCanon !== undefined
    ? Array.from(new Set([...(existing.privateAuthorKnowledge || []), ...target.privateAuthorCanon]))
    : (existing.privateAuthorKnowledge || []);

  const nextConfig = {
    ...existing,
    fandom: target.fandom !== undefined ? target.fandom : existing.fandom,
    universeName: target.universe !== undefined ? target.universe : existing.universeName,
    relationshipStates: nextRelationships,
    enabledOptionalCharacters: nextOptional,
    roomGuestInvitations: nextInvitations,
    casts: nextCasts,
    overlayActivations: nextOverlays,
    privateAuthorKnowledge: nextPrivate,
    proposals: updatedProposals,
  };
  const saved = await saveStoryConfig(nextConfig);
  return { config: saved, approvedProposal: updatedProposals.find((p) => p.id === proposalId) };
}

export async function rejectConfigProposal(projectId, proposalId, { decisionNote = '' } = {}) {
  const id = cleanString(projectId) || db.getActiveProjectId();
  const existing = await db.get('storyConfigs', id);
  if (!existing) throw new Error('No existe configuración de historia para esta propuesta.');
  const target = (existing.proposals || []).find((p) => p.id === proposalId);
  if (!target) throw new Error('No se encontró la propuesta indicada.');
  const now = new Date().toISOString();
  const updatedProposals = existing.proposals.map((p) =>
    p.id === proposalId ? { ...p, status: 'rejected', decisionNote: cleanString(decisionNote), decidedAt: now } : p
  );
  const saved = await saveStoryConfig({ ...existing, proposals: updatedProposals });
  return { config: saved, rejectedProposal: updatedProposals.find((p) => p.id === proposalId) };
}
