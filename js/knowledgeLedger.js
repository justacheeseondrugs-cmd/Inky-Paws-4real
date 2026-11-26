// knowledgeLedger.js — Libro epistémico temporal (append-only) de conocimiento,
// secretos, falsas creencias, ocultamiento deliberado, aislamiento espacial/temporal
// (sala vs pantalla vs exterior vs flashback) y continuidad emocional/relacional
// cualitativa con historial por capítulo y escena (sin puntuaciones numéricas).
//
// Invariantes fundamentales:
// 1. La verdad objetiva (`truth`) y las creencias individuales (`beliefHistoryByCharacter`)
//    son estrictamente independientes: una falsa creencia JAMÁS altera el canon objetivo.
// 2. Cada transición de creencia se añade al historial temporal (`append-only`), nunca
//    borra estados anteriores: reescribir el Cap. 10 recupera la sospecha de Hange del
//    Cap. 5 y NO su descubrimiento posterior del Cap. 20 ni un estado vacío.
// 3. Misma temporalidad para relaciones (`stateHistory`), promesas (`statusHistory`),
//    evolución emocional e historial de divulgación (`disclosureHistory`), con orden por
//    capítulo, escena (`sceneOrder`) y checkpoint.
// 4. Metadatos temporales ambiguos o faltantes en hechos/transiciones ligados a eventos
//    NO se autorizan silenciosamente para capítulos pasados.
// 5. Fuentes provenientes de capítulos alternativos (`branchRole === 'alternative'`)
//    nunca se promueven a conocimiento de la línea principal.

import { db } from './db.js';
import { extractLogicalId } from './characterLibrary.js';
import { PTS_CHECKPOINT_ORDER } from './universeResolver.js';

export const EPISTEMIC_STATES = new Set([
  'unknown',
  'suspects',
  'knows',
  'believes_false',
  'disputed',
]);

export const KNOWLEDGE_SCOPES = new Set([
  'world_fact',
  'private_author',
  'revealed_canon',
  'room_event',
  'screen_event',
  'outside_event',
  'flashback_event',
]);

export const SPATIAL_LAYERS = new Set([
  'global',
  'room',
  'screen',
  'outside',
  'flashback',
]);

export const CHARACTER_VERSIONS = new Set([
  'any',
  'room',
  'screen',
  'outside',
  'flashback',
]);

export const QUALITATIVE_DIMENSIONS = [
  'trust',
  'affection',
  'romanticTension',
  'resentment',
  'grief',
  'embarrassment',
  'loyalty',
  'fear',
];

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

function toOrder(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

function compareTemporalPoint(a, b) {
  const ordA = toOrder(a?.effectiveChapterOrder ?? a?.learnedAtChapterOrder);
  const ordB = toOrder(b?.effectiveChapterOrder ?? b?.learnedAtChapterOrder);
  if (ordA !== ordB) {
    if (ordA === null) return -1;
    if (ordB === null) return 1;
    return ordA - ordB;
  }
  const scA = toOrder(a?.sceneOrder);
  const scB = toOrder(b?.sceneOrder);
  if (scA !== scB) {
    if (scA === null) return -1;
    if (scB === null) return 1;
    return scA - scB;
  }
  const cpA = PTS_CHECKPOINT_ORDER[cleanString(a?.effectiveCheckpoint ?? a?.learnedAtCheckpoint)] ?? -1;
  const cpB = PTS_CHECKPOINT_ORDER[cleanString(b?.effectiveCheckpoint ?? b?.learnedAtCheckpoint)] ?? -1;
  if (cpA !== cpB) return cpA - cpB;
  return String(a?.recordedAt || a?.updatedAt || '').localeCompare(String(b?.recordedAt || b?.updatedAt || ''));
}

export function makeCharacterVersionKey(characterId, characterVersion = 'any') {
  const raw = cleanString(characterId);
  if (!raw) return '';
  const [basePart, embeddedVersion] = raw.split('@');
  const baseId = extractLogicalId(basePart);
  const ver = cleanString(characterVersion && characterVersion !== 'any' ? characterVersion : (embeddedVersion || 'any')).toLowerCase();
  const safeVer = CHARACTER_VERSIONS.has(ver) ? ver : 'any';
  return safeVer === 'any' ? baseId : `${baseId}@${safeVer}`;
}

export function parseCharacterVersionKey(key) {
  const raw = cleanString(key);
  const [basePart, verPart] = raw.split('@');
  const characterId = extractLogicalId(basePart || '');
  const version = cleanString(verPart || 'any').toLowerCase();
  return {
    characterId,
    characterVersion: CHARACTER_VERSIONS.has(version) ? version : 'any',
  };
}

export function normalizeBeliefEntry(characterKey, rawBelief) {
  const parsed = parseCharacterVersionKey(characterKey);
  const now = new Date().toISOString();
  if (typeof rawBelief === 'string') {
    const state = EPISTEMIC_STATES.has(rawBelief) ? rawBelief : 'unknown';
    return {
      transitionId: db.uid(),
      characterId: parsed.characterId,
      characterVersion: parsed.characterVersion,
      state,
      deliberatelyConcealing: false,
      concealmentNote: '',
      beliefText: '',
      evidence: '',
      source: '',
      sourceChapterId: null,
      sourceChapterRevision: '',
      learnedAtCheckpoint: '',
      effectiveCheckpoint: '',
      learnedAtChapterOrder: null,
      effectiveChapterOrder: null,
      sceneOrder: null,
      concealedBy: [],
      stale: false,
      staleReason: '',
      recordedAt: now,
      updatedAt: now,
    };
  }
  if (!isPlainObject(rawBelief)) return null;
  const cid = extractLogicalId(rawBelief.characterId || parsed.characterId);
  if (!cid) return null;
  const rawVer = cleanString(rawBelief.characterVersion || parsed.characterVersion || 'any').toLowerCase();
  const characterVersion = CHARACTER_VERSIONS.has(rawVer) ? rawVer : 'any';
  const rawState = cleanString(rawBelief.state || 'unknown');
  const state = EPISTEMIC_STATES.has(rawState) ? rawState : 'unknown';
  const effOrder = toOrder(rawBelief.effectiveChapterOrder !== undefined ? rawBelief.effectiveChapterOrder : rawBelief.learnedAtChapterOrder);
  const effCheckpoint = cleanString(rawBelief.effectiveCheckpoint !== undefined ? rawBelief.effectiveCheckpoint : rawBelief.learnedAtCheckpoint);
  return {
    transitionId: cleanString(rawBelief.transitionId || '') || db.uid(),
    characterId: cid,
    characterVersion,
    state,
    deliberatelyConcealing: Boolean(rawBelief.deliberatelyConcealing),
    concealmentNote: cleanString(rawBelief.concealmentNote || ''),
    beliefText: cleanString(rawBelief.beliefText || ''),
    evidence: cleanString(rawBelief.evidence || ''),
    source: cleanString(rawBelief.source || ''),
    sourceChapterId: cleanString(rawBelief.sourceChapterId || rawBelief.learnedAtChapterId || '') || null,
    sourceChapterRevision: cleanString(rawBelief.sourceChapterRevision || ''),
    learnedAtCheckpoint: effCheckpoint,
    effectiveCheckpoint: effCheckpoint,
    learnedAtChapterOrder: effOrder,
    effectiveChapterOrder: effOrder,
    sceneOrder: toOrder(rawBelief.sceneOrder),
    concealedBy: cleanStringArray(rawBelief.concealedBy || []).map(extractLogicalId),
    stale: Boolean(rawBelief.stale),
    staleReason: cleanString(rawBelief.staleReason || ''),
    recordedAt: rawBelief.recordedAt || rawBelief.updatedAt || now,
    updatedAt: rawBelief.updatedAt || now,
  };
}

function inferLayerFromScope(scope) {
  if (scope === 'room_event') return 'room';
  if (scope === 'screen_event') return 'screen';
  if (scope === 'outside_event') return 'outside';
  if (scope === 'flashback_event') return 'flashback';
  return 'global';
}

function normalizeDisclosureEntry(entry) {
  if (!isPlainObject(entry)) return null;
  return {
    id: cleanString(entry.id || '') || db.uid(),
    action: ['disclosed', 'concealed', 'partial_hint', 'denied'].includes(entry.action) ? entry.action : 'disclosed',
    byCharacterId: extractLogicalId(entry.byCharacterId || entry.by || ''),
    toCharacterIds: cleanStringArray(entry.toCharacterIds || entry.to || []).map(extractLogicalId),
    effectiveChapterOrder: toOrder(entry.effectiveChapterOrder ?? entry.chapterOrder),
    sceneOrder: toOrder(entry.sceneOrder),
    effectiveCheckpoint: cleanString(entry.effectiveCheckpoint || ''),
    sourceChapterId: cleanString(entry.sourceChapterId || '') || null,
    sourceChapterRevision: cleanString(entry.sourceChapterRevision || ''),
    note: cleanString(entry.note || ''),
    stale: Boolean(entry.stale),
    recordedAt: entry.recordedAt || new Date().toISOString(),
  };
}

export function normalizeKnowledgeFact(input, { existing = null, projectId = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El hecho epistémico debe ser un objeto válido.');
  const truth = cleanString(input.truth !== undefined ? input.truth : existing?.truth);
  if (!truth) throw new Error('El hecho epistémico necesita una verdad objetiva (`truth`).');

  const rawScope = cleanString(input.scope !== undefined ? input.scope : (existing?.scope || 'world_fact'));
  const scope = KNOWLEDGE_SCOPES.has(rawScope) ? rawScope : 'world_fact';
  const rawLayer = cleanString(input.layer !== undefined ? input.layer : (existing?.layer || inferLayerFromScope(scope)));
  const layer = SPATIAL_LAYERS.has(rawLayer) ? rawLayer : inferLayerFromScope(scope);
  const now = new Date().toISOString();

  // Reconstruir historial append-only `beliefHistoryByCharacter` preservando compatibilidad con `beliefsByCharacter`
  const beliefHistoryByCharacter = {};
  const sourceHistory = isPlainObject(input.beliefHistoryByCharacter)
    ? input.beliefHistoryByCharacter
    : (isPlainObject(existing?.beliefHistoryByCharacter) ? existing.beliefHistoryByCharacter : {});

  for (const [k, list] of Object.entries(sourceHistory)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const norm = normalizeBeliefEntry(k, item);
      if (!norm) continue;
      const canonicalKey = makeCharacterVersionKey(norm.characterId, norm.characterVersion);
      (beliefHistoryByCharacter[canonicalKey] ||= []).push(norm);
    }
  }

  // Sembrar desde `beliefsByCharacter` si se pasó un snapshot inicial o una entrada que aún no está en el historial
  const rawBeliefs = isPlainObject(input.beliefsByCharacter)
    ? input.beliefsByCharacter
    : (isPlainObject(existing?.beliefsByCharacter) ? existing.beliefsByCharacter : {});

  for (const [k, val] of Object.entries(rawBeliefs)) {
    const norm = normalizeBeliefEntry(k, val);
    if (!norm) continue;
    const canonicalKey = makeCharacterVersionKey(norm.characterId, norm.characterVersion);
    const list = (beliefHistoryByCharacter[canonicalKey] ||= []);
    const alreadyPresent = list.some((t) =>
      t.transitionId === norm.transitionId ||
      (
        t.state === norm.state &&
        t.effectiveChapterOrder === norm.effectiveChapterOrder &&
        t.sceneOrder === norm.sceneOrder &&
        t.beliefText === norm.beliefText &&
        t.deliberatelyConcealing === norm.deliberatelyConcealing
      )
    );
    if (!alreadyPresent) list.push(norm);
  }

  if (isPlainObject(input.statusByCharacter)) {
    for (const [k, st] of Object.entries(input.statusByCharacter)) {
      const key = makeCharacterVersionKey(k);
      if (!key || beliefHistoryByCharacter[key]?.length) continue;
      const norm = normalizeBeliefEntry(key, st);
      if (norm) beliefHistoryByCharacter[key] = [norm];
    }
  }

  // Ordenar cada historial cronológicamente y derivar snapshots compatibles (`beliefsByCharacter`, `statusByCharacter`)
  const beliefsByCharacter = {};
  const statusByCharacter = {};
  for (const [k, list] of Object.entries(beliefHistoryByCharacter)) {
    list.sort(compareTemporalPoint);
    const latest = list[list.length - 1];
    if (latest) {
      beliefsByCharacter[k] = latest;
      statusByCharacter[k] = latest.state;
    }
  }

  const rawDisclosureHistory = Array.isArray(input.disclosureHistory)
    ? input.disclosureHistory
    : (Array.isArray(existing?.disclosureHistory) ? existing.disclosureHistory : []);
  const disclosureHistory = rawDisclosureHistory.map(normalizeDisclosureEntry).filter(Boolean).sort(compareTemporalPoint);

  const effectiveProjectId = cleanString(projectId || input.projectId || existing?.projectId) || db.getActiveProjectId();
  return {
    id: cleanString(input.id || existing?.id) || db.uid(),
    projectId: effectiveProjectId,
    title: cleanString(input.title !== undefined ? input.title : (existing?.title || truth.slice(0, 72))),
    truth,
    scope,
    layer,
    isSecret: typeof input.isSecret === 'boolean'
      ? input.isSecret
      : (existing?.isSecret ?? (scope === 'private_author')),
    sourceType: cleanString(input.sourceType !== undefined ? input.sourceType : (existing?.sourceType || 'author_note')),
    sourceRef: cleanString(input.sourceRef !== undefined ? input.sourceRef : existing?.sourceRef),
    sourceChapterId: cleanString(input.sourceChapterId !== undefined ? input.sourceChapterId : existing?.sourceChapterId) || null,
    sourceChapterRevision: cleanString(input.sourceChapterRevision !== undefined ? input.sourceChapterRevision : existing?.sourceChapterRevision),
    firstEffectiveCheckpoint: cleanString(input.firstEffectiveCheckpoint !== undefined ? input.firstEffectiveCheckpoint : existing?.firstEffectiveCheckpoint),
    firstEffectiveChapterOrder: input.firstEffectiveChapterOrder !== undefined
      ? toOrder(input.firstEffectiveChapterOrder)
      : (existing?.firstEffectiveChapterOrder ?? null),
    firstEffectiveSceneOrder: input.firstEffectiveSceneOrder !== undefined
      ? toOrder(input.firstEffectiveSceneOrder)
      : (existing?.firstEffectiveSceneOrder ?? null),
    disclosureConstraints: cleanStringArray(
      input.disclosureConstraints !== undefined ? input.disclosureConstraints : existing?.disclosureConstraints
    ),
    disclosureHistory,
    beliefHistoryByCharacter,
    beliefsByCharacter,
    statusByCharacter,
    stale: typeof input.stale === 'boolean' ? input.stale : Boolean(existing?.stale ?? false),
    disputed: typeof input.disputed === 'boolean' ? input.disputed : Boolean(existing?.disputed ?? false),
    staleReason: cleanString(input.staleReason !== undefined ? input.staleReason : existing?.staleReason),
    staleAt: input.staleAt !== undefined ? input.staleAt : (existing?.staleAt || null),
    previousTruthSnapshot: cleanString(input.previousTruthSnapshot !== undefined ? input.previousTruthSnapshot : existing?.previousTruthSnapshot),
    lastReviewedRevision: cleanString(input.lastReviewedRevision !== undefined ? input.lastReviewedRevision : existing?.lastReviewedRevision),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

export async function listKnowledgeFacts({ projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const all = await db.getAll('knowledgeFacts', scope);
  return (all || [])
    .filter((f) => !f.deletedAt)
    .sort((a, b) => {
      const ordA = a.firstEffectiveChapterOrder ?? 999999;
      const ordB = b.firstEffectiveChapterOrder ?? 999999;
      if (ordA !== ordB) return ordA - ordB;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
}

export async function saveKnowledgeFact(input, { projectId = '' } = {}) {
  const targetProjectId = projectId || input?.projectId || db.getActiveProjectId();
  const scope = { projectId: targetProjectId };
  const existing = input?.id ? await db.get('knowledgeFacts', input.id, scope) : null;
  const normalized = normalizeKnowledgeFact(input, { existing, projectId: targetProjectId });
  return db.put('knowledgeFacts', normalized, scope);
}

export async function deleteKnowledgeFact(factId, { projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  return db.del('knowledgeFacts', factId, scope);
}

/**
 * Añade (append-only) una transición temporal de creencia para un personaje/versión.
 * Preserva íntegro todo el historial previo (p.ej. Cap. 5 sospecha -> Cap. 12 falsa
 * creencia -> Cap. 20 verdad -> Cap. 24 ocultamiento deliberado) y JAMÁS altera `truth`.
 */
export function appendBeliefTransitionToFact(fact, characterKey, beliefPatch) {
  const normalizedFact = fact?.beliefHistoryByCharacter ? structuredClone(fact) : normalizeKnowledgeFact(fact);
  const canonicalKey = makeCharacterVersionKey(characterKey, beliefPatch?.characterVersion || 'any');
  const nextEntry = normalizeBeliefEntry(canonicalKey, {
    ...(isPlainObject(beliefPatch) ? beliefPatch : { state: beliefPatch }),
    transitionId: (isPlainObject(beliefPatch) && beliefPatch.transitionId) ? beliefPatch.transitionId : db.uid(),
    recordedAt: (isPlainObject(beliefPatch) && beliefPatch.recordedAt) ? beliefPatch.recordedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const history = [...(normalizedFact.beliefHistoryByCharacter[canonicalKey] || []), nextEntry].sort(compareTemporalPoint);
  normalizedFact.beliefHistoryByCharacter[canonicalKey] = history;
  normalizedFact.beliefsByCharacter[canonicalKey] = history[history.length - 1];
  normalizedFact.statusByCharacter[canonicalKey] = history[history.length - 1].state;
  normalizedFact.updatedAt = new Date().toISOString();
  return normalizedFact;
}

export async function updateCharacterBelief(factId, characterKey, beliefPatch, { projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const existing = await db.get('knowledgeFacts', factId, scope);
  if (!existing) throw new Error('No se encontró el hecho epistémico indicado.');
  const updated = appendBeliefTransitionToFact(existing, characterKey, beliefPatch);
  return saveKnowledgeFact(updated, scope);
}

function isSourceAlternativeChapter(sourceChapterId, chapterStatusById) {
  if (!sourceChapterId || !chapterStatusById) return false;
  const info = chapterStatusById.get(sourceChapterId);
  return Boolean(info && info.isAlternative);
}

function resolveEffectiveOrder(explicitOrder, sourceChapterId, chapterStatusById) {
  const ord = toOrder(explicitOrder);
  if (ord !== null) return ord;
  if (sourceChapterId && chapterStatusById?.has(sourceChapterId)) {
    return toOrder(chapterStatusById.get(sourceChapterId).order);
  }
  return null;
}

function checkPointEligibility({
  explicitOrder,
  explicitSceneOrder,
  explicitCheckpoint,
  sourceChapterId,
  scope = 'world_fact',
  targetChapterOrder = null,
  targetSceneOrder = null,
  currentCheckpoint = '',
  chapterStatusById = null,
} = {}) {
  if (isSourceAlternativeChapter(sourceChapterId, chapterStatusById)) {
    return { eligible: false, reason: 'alternative_chapter_source' };
  }
  const effOrder = resolveEffectiveOrder(explicitOrder, sourceChapterId, chapterStatusById);
  const tgtOrder = toOrder(targetChapterOrder);
  const effScene = toOrder(explicitSceneOrder);
  const tgtScene = toOrder(targetSceneOrder);
  const effCp = cleanString(explicitCheckpoint);
  const curCp = cleanString(currentCheckpoint);

  // Metadatos temporales ambiguos en eventos narrativos cuando consultamos un punto histórico:
  // nunca autorizar silenciosamente información sin ubicación temporal verificable.
  const isEventScoped = ['room_event', 'screen_event', 'outside_event', 'flashback_event', 'revealed_canon'].includes(scope);
  if (tgtOrder !== null && effOrder === null && !effCp && isEventScoped) {
    return { eligible: false, reason: 'ambiguous_temporal_metadata' };
  }

  if (effOrder !== null && tgtOrder !== null) {
    if (effOrder > tgtOrder) return { eligible: false, reason: 'future_chapter' };
    if (effOrder === tgtOrder && effScene !== null && tgtScene !== null && effScene > tgtScene) {
      return { eligible: false, reason: 'future_scene' };
    }
  }
  if (
    effCp && curCp &&
    Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, effCp) &&
    Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, curCp)
  ) {
    if (PTS_CHECKPOINT_ORDER[effCp] > PTS_CHECKPOINT_ORDER[curCp]) {
      return { eligible: false, reason: 'future_checkpoint' };
    }
  }
  return { eligible: true, effOrder };
}

/**
 * Resuelve el estado epistémico temporal/espacial exacto en `(targetChapterOrder, targetSceneOrder, currentCheckpoint)`.
 *
 * - Usa el historial append-only `beliefHistoryByCharacter` para recuperar exactamente el
 *   último estado vigente en ese momento (p.ej. al reescribir Cap. 10 recupera la sospecha
 *   de Hange del Cap. 5, no su conocimiento posterior del Cap. 20).
 * - Excluye fuentes de capítulos alternativos, hechos futuros, hechos `stale`/`disputed` y
 *   eventos con metadatos temporales ambiguos.
 * - Mantiene aislamiento estricto Room vs Screen (`levi@room` != `levi@screen`) y barrera de
 *   llegada tardía de Joseph.
 */
export function resolveEpistemicStateAtPoint({
  facts = [],
  targetChapterOrder = null,
  targetSceneOrder = null,
  currentCheckpoint = '',
  characterIds = [],
  characterVersion = 'room',
  josephArrivalOrder = null,
  chapters = null,
} = {}) {
  const version = CHARACTER_VERSIONS.has(cleanString(characterVersion).toLowerCase())
    ? cleanString(characterVersion).toLowerCase()
    : 'room';

  let chapterStatusById = null;
  if (Array.isArray(chapters)) {
    chapterStatusById = new Map();
    for (const ch of chapters) {
      if (!ch?.id) continue;
      chapterStatusById.set(ch.id, {
        order: toOrder(ch.order),
        isAlternative: ch.branchRole === 'alternative',
      });
    }
  }

  const authoritativeCanon = [];
  const privateAuthorTruths = [];
  const staleOrDisputedForReview = [];
  const futureExcluded = [];
  const alternativeExcluded = [];
  const ambiguousTemporalExcluded = [];
  const characterKnowledgeMap = {};

  const targetChars = new Set((characterIds || []).map((c) => parseCharacterVersionKey(c).characterId).filter(Boolean));
  for (const fact of (facts || [])) {
    if (!fact || fact.deletedAt) continue;
    const histKeys = Object.keys(fact.beliefHistoryByCharacter || {});
    const snapKeys = Object.keys(fact.beliefsByCharacter || {});
    for (const key of [...histKeys, ...snapKeys]) {
      const parsed = parseCharacterVersionKey(key);
      if (parsed.characterId) targetChars.add(parsed.characterId);
    }
  }
  for (const cid of targetChars) {
    characterKnowledgeMap[cid] = {
      characterId: cid,
      characterVersion: version,
      knows: [],
      suspects: [],
      believesFalse: [],
      disputed: [],
      unknownSecrets: [],
      blockedByLateArrival: [],
    };
  }

  for (const rawFact of (facts || [])) {
    if (!rawFact || rawFact.deletedAt) continue;
    const fact = rawFact.beliefHistoryByCharacter ? rawFact : normalizeKnowledgeFact(rawFact);

    const elig = checkPointEligibility({
      explicitOrder: fact.firstEffectiveChapterOrder,
      explicitSceneOrder: fact.firstEffectiveSceneOrder,
      explicitCheckpoint: fact.firstEffectiveCheckpoint,
      sourceChapterId: fact.sourceChapterId,
      scope: fact.scope,
      targetChapterOrder,
      targetSceneOrder,
      currentCheckpoint,
      chapterStatusById,
    });

    if (!elig.eligible) {
      if (elig.reason === 'alternative_chapter_source') {
        alternativeExcluded.push({ id: fact.id, title: fact.title, sourceChapterId: fact.sourceChapterId });
      } else if (elig.reason === 'ambiguous_temporal_metadata') {
        ambiguousTemporalExcluded.push({ id: fact.id, title: fact.title, reason: elig.reason });
      } else {
        futureExcluded.push({ id: fact.id, title: fact.title, firstEffectiveChapterOrder: fact.firstEffectiveChapterOrder, reason: elig.reason });
      }
      continue;
    }

    if (fact.stale || fact.disputed) {
      staleOrDisputedForReview.push(fact);
      continue;
    }

    const activeDisclosureHistory = (fact.disclosureHistory || []).filter((d) =>
      !d.stale && checkPointEligibility({
        explicitOrder: d.effectiveChapterOrder,
        explicitSceneOrder: d.sceneOrder,
        explicitCheckpoint: d.effectiveCheckpoint,
        sourceChapterId: d.sourceChapterId,
        scope: 'room_event',
        targetChapterOrder,
        targetSceneOrder,
        currentCheckpoint,
        chapterStatusById,
      }).eligible
    );

    const factView = { ...fact, disclosureHistory: activeDisclosureHistory };
    if (fact.scope === 'private_author') {
      privateAuthorTruths.push(factView);
    } else {
      authoritativeCanon.push(factView);
    }

    const histMap = fact.beliefHistoryByCharacter || {};
    for (const cid of targetChars) {
      const bucket = characterKnowledgeMap[cid];
      const versionedKey = version !== 'any' ? `${cid}@${version}` : cid;
      const versionSpecificList = Array.isArray(histMap[versionedKey]) ? histMap[versionedKey] : [];
      const genericList = Array.isArray(histMap[cid])
        ? histMap[cid].filter((b) => b.characterVersion === 'any')
        : [];

      // Combinar solo historial aplicable a esta versión (nunca cruzar @screen <-> @room)
      const combinedHistory = [...versionSpecificList, ...genericList]
        .filter((b) => !b.stale)
        .filter((b) => checkPointEligibility({
          explicitOrder: b.effectiveChapterOrder,
          explicitSceneOrder: b.sceneOrder,
          explicitCheckpoint: b.effectiveCheckpoint,
          sourceChapterId: b.sourceChapterId,
          scope: b.effectiveChapterOrder === null && !b.effectiveCheckpoint && !b.sourceChapterId ? 'world_fact' : 'room_event',
          targetChapterOrder,
          targetSceneOrder,
          currentCheckpoint,
          chapterStatusById,
        }).eligible)
        .sort(compareTemporalPoint);

      // Seleccionar el último estado vigente en el punto solicitado
      const candidateBelief = combinedHistory.length ? combinedHistory[combinedHistory.length - 1] : null;

      const factOrder = elig.effOrder;
      const arrivalOrder = toOrder(josephArrivalOrder);
      const isBeforeJosephArrival = cid === 'joseph' &&
        arrivalOrder !== null &&
        factOrder !== null &&
        factOrder < arrivalOrder &&
        (fact.scope === 'screen_event' || fact.scope === 'room_event' || fact.layer === 'room' || fact.layer === 'screen');

      if (isBeforeJosephArrival) {
        const learnedOrder = resolveEffectiveOrder(candidateBelief?.effectiveChapterOrder, candidateBelief?.sourceChapterId, chapterStatusById);
        const explicitlyBriefedAfterArrival = Boolean(
          candidateBelief &&
          candidateBelief.state !== 'unknown' &&
          learnedOrder !== null &&
          learnedOrder >= arrivalOrder &&
          cleanString(candidateBelief.evidence)
        );
        if (!explicitlyBriefedAfterArrival) {
          bucket.blockedByLateArrival.push({
            factId: fact.id,
            title: fact.title,
            firstEffectiveChapterOrder: factOrder,
            reason: `Ocurrió/se proyectó antes de la llegada de Joseph (cap. ${arrivalOrder}) sin evidencia explícita posterior.`,
          });
          bucket.unknownSecrets.push({
            factId: fact.id,
            title: fact.title,
            state: 'unknown',
            reason: 'late_arrival_barrier',
          });
          continue;
        }
      }

      if (!candidateBelief) {
        if (fact.isSecret || fact.scope === 'private_author') {
          const hadLaterTransition = [...versionSpecificList, ...genericList].length > 0;
          bucket.unknownSecrets.push({
            factId: fact.id,
            title: fact.title,
            state: 'unknown',
            reason: hadLaterTransition ? 'learned_later_than_target' : 'no_evidence',
          });
        }
        continue;
      }

      const experienceMode = fact.layer === 'screen' && version === 'room'
        ? 'watched_not_lived'
        : (fact.layer === version ? 'lived_direct' : 'indirect');

      const item = {
        factId: fact.id,
        transitionId: candidateBelief.transitionId,
        title: fact.title,
        layer: fact.layer,
        scope: fact.scope,
        state: candidateBelief.state,
        deliberatelyConcealing: Boolean(candidateBelief.deliberatelyConcealing),
        concealmentNote: candidateBelief.concealmentNote || '',
        beliefText: candidateBelief.beliefText || (candidateBelief.state === 'knows' ? fact.truth : ''),
        objectiveTruth: fact.truth,
        evidence: candidateBelief.evidence,
        source: candidateBelief.source || fact.sourceRef,
        sourceChapterId: candidateBelief.sourceChapterId || fact.sourceChapterId,
        sourceChapterRevision: candidateBelief.sourceChapterRevision || fact.sourceChapterRevision,
        learnedAtChapterOrder: candidateBelief.effectiveChapterOrder,
        sceneOrder: candidateBelief.sceneOrder,
        learnedAtCheckpoint: candidateBelief.effectiveCheckpoint,
        disclosureConstraints: fact.disclosureConstraints,
        experienceMode,
        priorTransitionsCount: Math.max(0, combinedHistory.length - 1),
      };

      if (candidateBelief.state === 'knows') bucket.knows.push(item);
      else if (candidateBelief.state === 'suspects') bucket.suspects.push(item);
      else if (candidateBelief.state === 'believes_false') bucket.believesFalse.push(item);
      else if (candidateBelief.state === 'disputed') bucket.disputed.push(item);
      else if (fact.isSecret || fact.scope === 'private_author') {
        bucket.unknownSecrets.push({ factId: fact.id, title: fact.title, state: 'unknown', reason: 'explicit_unknown' });
      }
    }
  }

  return {
    targetChapterOrder: toOrder(targetChapterOrder),
    targetSceneOrder: toOrder(targetSceneOrder),
    currentCheckpoint: cleanString(currentCheckpoint),
    characterVersion: version,
    authoritativeCanon,
    privateAuthorTruths,
    characterKnowledgeMap,
    staleOrDisputedForReview,
    futureExcludedCount: futureExcluded.length,
    futureExcluded,
    alternativeExcludedCount: alternativeExcluded.length,
    alternativeExcluded,
    ambiguousTemporalExcludedCount: ambiguousTemporalExcluded.length,
    ambiguousTemporalExcluded,
  };
}

// ---------------------------------------------------------------------------
// Continuidad emocional y relacional CUALITATIVA con historial temporal
// ---------------------------------------------------------------------------

export function makeRelationshipPairKey(participants = []) {
  const ids = cleanStringArray(participants).map(extractLogicalId).filter(Boolean).sort();
  return ids.join('+');
}

function normalizeQualitativeDimensions(rawDims) {
  const dimensions = {};
  for (const dim of QUALITATIVE_DIMENSIONS) {
    const val = rawDims?.[dim];
    if (typeof val === 'number') {
      throw new Error(`La dimensión emocional «${dim}» debe ser cualitativa (texto narrativo), nunca una puntuación numérica.`);
    }
    dimensions[dim] = cleanString(val || '');
  }
  return dimensions;
}

function normalizeRelationshipSnapshot(rawSnap) {
  if (!isPlainObject(rawSnap)) return null;
  const now = new Date().toISOString();
  return {
    snapshotId: cleanString(rawSnap.snapshotId || '') || db.uid(),
    effectiveChapterOrder: toOrder(rawSnap.effectiveChapterOrder ?? rawSnap.chapterOrder),
    sceneOrder: toOrder(rawSnap.sceneOrder),
    effectiveCheckpoint: cleanString(rawSnap.effectiveCheckpoint || ''),
    relationshipStage: cleanString(rawSnap.relationshipStage || ''),
    dimensions: normalizeQualitativeDimensions(rawSnap.dimensions || {}),
    unresolvedDisagreements: cleanStringArray(rawSnap.unresolvedDisagreements || []),
    behaviorChanges: cleanStringArray(rawSnap.behaviorChanges || []),
    sourceChapterId: cleanString(rawSnap.sourceChapterId || '') || null,
    sourceChapterRevision: cleanString(rawSnap.sourceChapterRevision || ''),
    evidenceNote: cleanString(rawSnap.evidenceNote || ''),
    stale: Boolean(rawSnap.stale),
    staleReason: cleanString(rawSnap.staleReason || ''),
    recordedAt: rawSnap.recordedAt || now,
  };
}

export function normalizeRelationshipState(input, { existing = null, projectId = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El estado relacional debe ser un objeto válido.');
  const participants = cleanStringArray(
    input.participants !== undefined ? input.participants : existing?.participants
  ).map(extractLogicalId);
  const pairKey = cleanString(input.pairKey || existing?.pairKey || makeRelationshipPairKey(participants));
  if (!pairKey) throw new Error('El estado relacional necesita al menos dos participantes o un `pairKey`.');

  const rawDims = isPlainObject(input.dimensions) ? input.dimensions : (existing?.dimensions || {});
  const dimensions = normalizeQualitativeDimensions(rawDims);

  const normalizePromise = (p) => {
    if (typeof p === 'string') {
      const text = cleanString(p);
      return text ? { text, madeBy: '', madeTo: '', chapterOrder: null, sceneOrder: null, sourceChapterId: null, status: 'open', statusHistory: [] } : null;
    }
    if (!isPlainObject(p) || !cleanString(p.text)) return null;
    const status = ['open', 'kept', 'broken'].includes(p.status) ? p.status : 'open';
    const chOrder = toOrder(p.chapterOrder);
    const rawHist = Array.isArray(p.statusHistory) ? p.statusHistory : [];
    const statusHistory = rawHist
      .filter(isPlainObject)
      .map((h) => ({
        status: ['open', 'kept', 'broken'].includes(h.status) ? h.status : 'open',
        effectiveChapterOrder: toOrder(h.effectiveChapterOrder ?? h.chapterOrder),
        sceneOrder: toOrder(h.sceneOrder),
        sourceChapterId: cleanString(h.sourceChapterId || '') || null,
        evidence: cleanString(h.evidence || ''),
        stale: Boolean(h.stale),
        recordedAt: h.recordedAt || new Date().toISOString(),
      }))
      .sort(compareTemporalPoint);
    if (!statusHistory.length) {
      statusHistory.push({
        status,
        effectiveChapterOrder: chOrder,
        sceneOrder: toOrder(p.sceneOrder),
        sourceChapterId: cleanString(p.sourceChapterId || '') || null,
        evidence: cleanString(p.evidence || ''),
        stale: false,
        recordedAt: new Date().toISOString(),
      });
    }
    return {
      text: cleanString(p.text),
      madeBy: extractLogicalId(p.madeBy || ''),
      madeTo: extractLogicalId(p.madeTo || ''),
      chapterOrder: chOrder,
      sceneOrder: toOrder(p.sceneOrder),
      sourceChapterId: cleanString(p.sourceChapterId || '') || null,
      status: statusHistory[statusHistory.length - 1].status,
      statusHistory,
    };
  };

  const normalizeMemoryItem = (m) => {
    if (typeof m === 'string') {
      const text = cleanString(m);
      return text ? { text, chapterOrder: null, sceneOrder: null, sourceChapterId: null } : null;
    }
    if (!isPlainObject(m) || !cleanString(m.text)) return null;
    return {
      text: cleanString(m.text),
      chapterOrder: toOrder(m.chapterOrder),
      sceneOrder: toOrder(m.sceneOrder),
      sourceChapterId: cleanString(m.sourceChapterId || '') || null,
    };
  };

  const normalizePrivateSecret = (s) => {
    if (typeof s === 'string') {
      const text = cleanString(s);
      return text ? { text, heldBy: [], hiddenFrom: [], chapterOrder: null, sceneOrder: null, sourceChapterId: null } : null;
    }
    if (!isPlainObject(s) || !cleanString(s.text)) return null;
    return {
      text: cleanString(s.text),
      heldBy: cleanStringArray(s.heldBy || []).map(extractLogicalId),
      hiddenFrom: cleanStringArray(s.hiddenFrom || []).map(extractLogicalId),
      chapterOrder: toOrder(s.chapterOrder),
      sceneOrder: toOrder(s.sceneOrder),
      sourceChapterId: cleanString(s.sourceChapterId || '') || null,
    };
  };

  const normalizeEvidenceRef = (e) => {
    if (!isPlainObject(e)) return null;
    return {
      chapterId: cleanString(e.chapterId || '') || null,
      chapterOrder: toOrder(e.chapterOrder),
      quoteOrNote: cleanString(e.quoteOrNote || e.note || ''),
      chapterRevision: cleanString(e.chapterRevision || ''),
    };
  };

  const now = new Date().toISOString();
  const effectiveProjectId = cleanString(projectId || input.projectId || existing?.projectId) || db.getActiveProjectId();
  const effOrder = input.effectiveChapterOrder !== undefined
    ? toOrder(input.effectiveChapterOrder)
    : (existing?.effectiveChapterOrder ?? null);

  const rawHistory = Array.isArray(input.stateHistory)
    ? input.stateHistory
    : (Array.isArray(existing?.stateHistory) ? existing.stateHistory : []);
  const stateHistory = rawHistory.map(normalizeRelationshipSnapshot).filter(Boolean).sort(compareTemporalPoint);

  // Asegurar que el estado inicial quede registrado en `stateHistory` si estaba vacío
  const stage = cleanString(input.relationshipStage !== undefined ? input.relationshipStage : (existing?.relationshipStage || ''));
  const disagreements = cleanStringArray(input.unresolvedDisagreements !== undefined ? input.unresolvedDisagreements : existing?.unresolvedDisagreements);
  const behaviors = cleanStringArray(input.behaviorChanges !== undefined ? input.behaviorChanges : existing?.behaviorChanges);
  if (!stateHistory.length) {
    stateHistory.push(normalizeRelationshipSnapshot({
      effectiveChapterOrder: effOrder,
      sceneOrder: toOrder(input.sceneOrder ?? existing?.sceneOrder),
      effectiveCheckpoint: cleanString(input.effectiveCheckpoint || existing?.effectiveCheckpoint || ''),
      relationshipStage: stage,
      dimensions,
      unresolvedDisagreements: disagreements,
      behaviorChanges: behaviors,
      sourceChapterId: cleanString(input.sourceChapterId !== undefined ? input.sourceChapterId : existing?.sourceChapterId) || null,
      sourceChapterRevision: cleanString(input.sourceChapterRevision !== undefined ? input.sourceChapterRevision : existing?.sourceChapterRevision),
      recordedAt: existing?.createdAt || input.createdAt || now,
    }));
  }

  const latestSnap = stateHistory[stateHistory.length - 1];
  return {
    id: cleanString(input.id || existing?.id) || db.uid(),
    projectId: effectiveProjectId,
    pairKey,
    participants: participants.length ? participants : pairKey.split('+').filter(Boolean),
    label: cleanString(input.label !== undefined ? input.label : (existing?.label || pairKey.replace(/\+/g, ' & '))),
    relationshipStage: stage || latestSnap?.relationshipStage || '',
    dimensions: Object.values(dimensions).some(Boolean) ? dimensions : (latestSnap?.dimensions || dimensions),
    unresolvedDisagreements: disagreements.length ? disagreements : (latestSnap?.unresolvedDisagreements || []),
    promises: (Array.isArray(input.promises) ? input.promises : (existing?.promises || [])).map(normalizePromise).filter(Boolean),
    sharedMemories: (Array.isArray(input.sharedMemories) ? input.sharedMemories : (existing?.sharedMemories || [])).map(normalizeMemoryItem).filter(Boolean),
    privateSecrets: (Array.isArray(input.privateSecrets) ? input.privateSecrets : (existing?.privateSecrets || [])).map(normalizePrivateSecret).filter(Boolean),
    behaviorChanges: behaviors.length ? behaviors : (latestSnap?.behaviorChanges || []),
    evidenceRefs: (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : (existing?.evidenceRefs || [])).map(normalizeEvidenceRef).filter(Boolean),
    stateHistory,
    effectiveChapterOrder: effOrder,
    sourceChapterId: cleanString(input.sourceChapterId !== undefined ? input.sourceChapterId : existing?.sourceChapterId) || null,
    sourceChapterRevision: cleanString(input.sourceChapterRevision !== undefined ? input.sourceChapterRevision : existing?.sourceChapterRevision),
    stale: typeof input.stale === 'boolean' ? input.stale : Boolean(existing?.stale ?? false),
    staleReason: cleanString(input.staleReason !== undefined ? input.staleReason : existing?.staleReason),
    staleAt: input.staleAt !== undefined ? input.staleAt : (existing?.staleAt || null),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

/**
 * Añade (append-only) una transición emocional/relacional cualitativa sin sobrescribir
 * snapshots de capítulos anteriores.
 */
export function appendRelationshipTransitionToState(relState, transitionPatch) {
  const normalized = relState?.stateHistory ? structuredClone(relState) : normalizeRelationshipState(relState);
  const snap = normalizeRelationshipSnapshot(transitionPatch);
  if (!snap) throw new Error('Transición relacional inválida.');
  normalized.stateHistory = [...(normalized.stateHistory || []), snap].sort(compareTemporalPoint);
  const latest = normalized.stateHistory[normalized.stateHistory.length - 1];
  normalized.relationshipStage = latest.relationshipStage || normalized.relationshipStage;
  normalized.dimensions = latest.dimensions;
  normalized.unresolvedDisagreements = latest.unresolvedDisagreements;
  normalized.behaviorChanges = latest.behaviorChanges;
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

export async function appendRelationshipTransition(id, transitionPatch, { projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const existing = await db.get('relationshipStates', id, scope);
  if (!existing) throw new Error('No se encontró el estado relacional.');
  const updated = appendRelationshipTransitionToState(existing, transitionPatch);
  return saveRelationshipState(updated, scope);
}

export async function listRelationshipStates({ projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const all = await db.getAll('relationshipStates', scope);
  return (all || [])
    .filter((r) => !r.deletedAt)
    .sort((a, b) => String(a.label || a.pairKey).localeCompare(String(b.label || b.pairKey)));
}

export async function saveRelationshipState(input, { projectId = '' } = {}) {
  const targetProjectId = projectId || input?.projectId || db.getActiveProjectId();
  const scope = { projectId: targetProjectId };
  const existing = input?.id ? await db.get('relationshipStates', input.id, scope) : null;
  const normalized = normalizeRelationshipState(input, { existing, projectId: targetProjectId });
  return db.put('relationshipStates', normalized, scope);
}

export async function deleteRelationshipState(id, { projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  return db.del('relationshipStates', id, scope);
}

/**
 * Resuelve estados relacionales cualitativos estrictamente hasta `(targetChapterOrder, targetSceneOrder)`:
 * - Selecciona el último snapshot elegible en `stateHistory` (jamás filtra cambios futuros).
 * - Resuelve el estado temporal de cada promesa desde `statusHistory` (una promesa cumplida en
 *   Cap. 30 sigue siendo `open` al reescribir Cap. 15).
 * - Excluye fuentes de capítulos alternativos y separa registros `stale` para revisión.
 */
export function resolveRelationshipsAtPoint({
  relationships = [],
  targetChapterOrder = null,
  targetSceneOrder = null,
  currentCheckpoint = '',
  chapters = null,
} = {}) {
  let chapterStatusById = null;
  if (Array.isArray(chapters)) {
    chapterStatusById = new Map();
    for (const ch of chapters) {
      if (!ch?.id) continue;
      chapterStatusById.set(ch.id, {
        order: toOrder(ch.order),
        isAlternative: ch.branchRole === 'alternative',
      });
    }
  }

  const tgtOrder = toOrder(targetChapterOrder);
  const authoritative = [];
  const staleForReview = [];
  const openPromises = [];
  const activeSecrets = [];

  for (const raw of (relationships || [])) {
    if (!raw || raw.deletedAt) continue;
    const rel = raw.stateHistory ? raw : normalizeRelationshipState(raw);
    if (isSourceAlternativeChapter(rel.sourceChapterId, chapterStatusById)) continue;
    if (rel.stale) {
      staleForReview.push(rel);
      continue;
    }

    const eligibleSnapshots = (rel.stateHistory || [])
      .filter((s) => !s.stale)
      .filter((s) => checkPointEligibility({
        explicitOrder: s.effectiveChapterOrder,
        explicitSceneOrder: s.sceneOrder,
        explicitCheckpoint: s.effectiveCheckpoint,
        sourceChapterId: s.sourceChapterId,
        scope: 'world_fact',
        targetChapterOrder: tgtOrder,
        targetSceneOrder,
        currentCheckpoint,
        chapterStatusById,
      }).eligible)
      .sort(compareTemporalPoint);

    if (!eligibleSnapshots.length) continue;
    const activeSnap = eligibleSnapshots[eligibleSnapshots.length - 1];

    const filteredPromises = [];
    for (const p of (rel.promises || [])) {
      if (isSourceAlternativeChapter(p.sourceChapterId, chapterStatusById)) continue;
      const pOrder = resolveEffectiveOrder(p.chapterOrder, p.sourceChapterId, chapterStatusById);
      if (pOrder !== null && tgtOrder !== null && pOrder > tgtOrder) continue;
      if (pOrder === null && tgtOrder !== null && p.sourceChapterId) continue;
      const eligibleStatus = (p.statusHistory || [])
        .filter((h) => !h.stale && checkPointEligibility({
          explicitOrder: h.effectiveChapterOrder,
          explicitSceneOrder: h.sceneOrder,
          sourceChapterId: h.sourceChapterId,
          scope: 'world_fact',
          targetChapterOrder: tgtOrder,
          targetSceneOrder,
          currentCheckpoint,
          chapterStatusById,
        }).eligible)
        .sort(compareTemporalPoint);
      const resolvedStatus = eligibleStatus.length ? eligibleStatus[eligibleStatus.length - 1].status : p.status;
      filteredPromises.push({ ...p, status: resolvedStatus });
    }

    const filteredMemories = (rel.sharedMemories || []).filter((m) => {
      if (isSourceAlternativeChapter(m.sourceChapterId, chapterStatusById)) return false;
      const mOrder = resolveEffectiveOrder(m.chapterOrder, m.sourceChapterId, chapterStatusById);
      return mOrder === null || tgtOrder === null || mOrder <= tgtOrder;
    });

    const filteredSecrets = (rel.privateSecrets || []).filter((s) => {
      if (isSourceAlternativeChapter(s.sourceChapterId, chapterStatusById)) return false;
      const sOrder = resolveEffectiveOrder(s.chapterOrder, s.sourceChapterId, chapterStatusById);
      return sOrder === null || tgtOrder === null || sOrder <= tgtOrder;
    });

    const view = {
      ...rel,
      relationshipStage: activeSnap.relationshipStage || rel.relationshipStage,
      dimensions: activeSnap.dimensions,
      unresolvedDisagreements: activeSnap.unresolvedDisagreements,
      behaviorChanges: activeSnap.behaviorChanges,
      activeSnapshotId: activeSnap.snapshotId,
      activeSnapshotChapterOrder: activeSnap.effectiveChapterOrder,
      promises: filteredPromises,
      sharedMemories: filteredMemories,
      privateSecrets: filteredSecrets,
    };
    authoritative.push(view);

    for (const p of filteredPromises) {
      if (p.status === 'open') openPromises.push({ ...p, relationshipId: rel.id, pairKey: rel.pairKey, relationshipLabel: rel.label });
    }
    for (const s of filteredSecrets) {
      activeSecrets.push({ ...s, relationshipId: rel.id, pairKey: rel.pairKey, relationshipLabel: rel.label });
    }
  }

  return {
    authoritative,
    staleForReview,
    openPromises,
    activeSecrets,
  };
}
