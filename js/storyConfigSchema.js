// storyConfigSchema.js — Esquema de configuración de historia por fandom/universo
// y flujo de propuestas conversacionales (Requirement B & C).
//
// Principio fundamental:
// Una idea o propuesta sugerida en el chat NUNCA es canon activo hasta que la
// autora la aprueba explícitamente. Las historias nuevas sin fandom específico
// arrancan en namespace neutral ("neutral") y nunca heredan reglas de Power to Strive.

import { db } from './db.js';

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

export function createDefaultStoryConfig(projectId, { fandom = 'neutral', presetId = null } = {}) {
  const now = new Date().toISOString();
  return {
    id: cleanString(projectId) || db.getActiveProjectId(),
    projectId: cleanString(projectId) || db.getActiveProjectId(),
    fandom: cleanString(fandom) || 'neutral',
    presetId: presetId ? cleanString(presetId) : null,
    universeName: '',
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
  const casts = isPlainObject(input.casts) ? input.casts : {};
  const overlays = Array.isArray(input.characterOverlays)
    ? input.characterOverlays
        .filter((item) => isPlainObject(item) && cleanString(item.overlayId))
        .map((item) => ({
          overlayId: cleanString(item.overlayId),
          characterId: cleanString(item.characterId || ''),
          scope: ['story', 'character_version', 'scene'].includes(item.scope) ? item.scope : 'story',
          characterVersion: cleanString(item.characterVersion || 'default'),
          sceneId: item.sceneId ? cleanString(item.sceneId) : null,
          enabled: item.enabled !== false,
        }))
    : [];

  const now = new Date().toISOString();
  return {
    id,
    status,
    sourceMessage: cleanString(input.sourceMessage || ''),
    fandom: cleanString(input.fandom || ''),
    universe: cleanString(input.universe || ''),
    relationshipStates: isPlainObject(input.relationshipStates) ? structuredClone(input.relationshipStates) : {},
    enabledOptionalCharacters: cleanStringArray(input.enabledOptionalCharacters || []),
    casts: {
      room: cleanStringArray(casts.room || []),
      screen: cleanStringArray(casts.screen || []),
      outside: cleanStringArray(casts.outside || []),
    },
    characterOverlays: overlays,
    privateAuthorCanon: cleanStringArray(input.privateAuthorCanon || []),
    individualKnowledge: Array.isArray(input.individualKnowledge)
      ? input.individualKnowledge.filter(isPlainObject).map((k) => ({
          characterId: cleanString(k.characterId || k.character || ''),
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
    updatedAt: now,
  };
  return db.put('storyConfigs', merged);
}

/**
 * Registra una propuesta conversacional en estado "proposed" sin modificar
 * la configuración activa ni el canon de la historia.
 */
export async function stageConfigProposal(projectId, proposalInput) {
  const id = cleanString(projectId) || db.getActiveProjectId();
  const existing = (await db.get('storyConfigs', id)) || createDefaultStoryConfig(id);
  const proposal = validateConfigProposal({ ...proposalInput, status: 'proposed', decidedAt: null });
  const proposals = [...(existing.proposals || []).filter((p) => p.id !== proposal.id), proposal];
  const saved = await saveStoryConfig({ ...existing, proposals });
  return { config: saved, proposal };
}

/**
 * Aprueba explícitamente una propuesta pendiente y aplica sus campos aprobados
 * a la configuración de la historia.
 */
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

  const nextOptional = Array.from(new Set([
    ...(existing.enabledOptionalCharacters || []),
    ...(target.enabledOptionalCharacters || []),
  ]));
  const nextOverlays = [...(existing.overlayActivations || [])];
  for (const ov of (target.characterOverlays || [])) {
    const idx = nextOverlays.findIndex((x) => x.overlayId === ov.overlayId && x.scope === ov.scope && x.characterVersion === ov.characterVersion && x.sceneId === ov.sceneId);
    if (idx >= 0) nextOverlays[idx] = { ...nextOverlays[idx], ...ov };
    else nextOverlays.push(ov);
  }

  const nextConfig = {
    ...existing,
    fandom: target.fandom || existing.fandom,
    universeName: target.universe || existing.universeName,
    relationshipStates: { ...(existing.relationshipStates || {}), ...(target.relationshipStates || {}) },
    enabledOptionalCharacters: nextOptional,
    casts: {
      room: target.casts?.room?.length ? target.casts.room : (existing.casts?.room || []),
      screen: target.casts?.screen?.length ? target.casts.screen : (existing.casts?.screen || []),
      outside: target.casts?.outside?.length ? target.casts.outside : (existing.casts?.outside || []),
    },
    overlayActivations: nextOverlays,
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
