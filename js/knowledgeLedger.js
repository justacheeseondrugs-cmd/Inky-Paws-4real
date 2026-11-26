// knowledgeLedger.js — Libro epistémico de conocimiento, secretos, falsas creencias,
// aislamiento espacial/temporal (sala vs pantalla vs exterior vs flashback) y
// continuidad emocional/relacional cualitativa (sin puntuaciones numéricas).
//
// Invariantes fundamentales del Hito 3:
// 1. La verdad objetiva del canon (`truth`) y las creencias individuales (`beliefsByCharacter`)
//    son entidades estrictamente separadas: una falsa creencia de un personaje JAMÁS se
//    convierte en verdad canónica.
// 2. Cada personaje actualiza sus creencias de forma independiente cuando llega evidencia.
// 3. El conocimiento se resuelve estrictamente en el punto narrativo (capítulo/checkpoint)
//    y capa espacial/versión (`room`, `screen`, `outside`, `flashback`):
//    - Sin filtración de spoilers futuros.
//    - Ver un evento en pantalla NO equivale a haberlo vivido (`watched_not_lived`).
//    - Levi de la sala (`levi@room`) y Levi de la pantalla (`levi@screen`) jamás comparten
//      automáticamente experiencias, recuerdos ni relaciones.
//    - Un invitado tardío (p.ej. Joseph al llegar en el capítulo N) no hereda episodios
//      vistos antes de su llegada salvo evidencia explícita posterior.
// 4. Hechos o relaciones marcados como `stale` o `disputed` tras editar un capítulo
//    se excluyen del canon autoritativo actual pero se conservan íntegros para revisión.

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

function toPositiveOrder(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

/**
 * Construye una clave canónica de personaje + versión espacial opcional.
 * Ejemplos: `makeCharacterVersionKey('levi', 'screen')` -> `'levi@screen'`,
 *           `makeCharacterVersionKey('levi', 'any')` -> `'levi'`.
 */
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
  if (typeof rawBelief === 'string') {
    const state = EPISTEMIC_STATES.has(rawBelief) ? rawBelief : 'unknown';
    return {
      characterId: parsed.characterId,
      characterVersion: parsed.characterVersion,
      state,
      beliefText: '',
      evidence: '',
      source: '',
      learnedAtCheckpoint: '',
      learnedAtChapterOrder: null,
      concealedBy: [],
      updatedAt: new Date().toISOString(),
    };
  }
  if (!isPlainObject(rawBelief)) return null;
  const cid = extractLogicalId(rawBelief.characterId || parsed.characterId);
  if (!cid) return null;
  const rawVer = cleanString(rawBelief.characterVersion || parsed.characterVersion || 'any').toLowerCase();
  const characterVersion = CHARACTER_VERSIONS.has(rawVer) ? rawVer : 'any';
  const rawState = cleanString(rawBelief.state || 'unknown');
  const state = EPISTEMIC_STATES.has(rawState) ? rawState : 'unknown';
  return {
    characterId: cid,
    characterVersion,
    state,
    beliefText: cleanString(rawBelief.beliefText || ''),
    evidence: cleanString(rawBelief.evidence || ''),
    source: cleanString(rawBelief.source || ''),
    learnedAtCheckpoint: cleanString(rawBelief.learnedAtCheckpoint || ''),
    learnedAtChapterOrder: toPositiveOrder(rawBelief.learnedAtChapterOrder),
    concealedBy: cleanStringArray(rawBelief.concealedBy || []).map(extractLogicalId),
    updatedAt: rawBelief.updatedAt || new Date().toISOString(),
  };
}

function inferLayerFromScope(scope) {
  if (scope === 'room_event') return 'room';
  if (scope === 'screen_event') return 'screen';
  if (scope === 'outside_event') return 'outside';
  if (scope === 'flashback_event') return 'flashback';
  return 'global';
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

  // Combinar `beliefsByCharacter` y compatibilidad con `statusByCharacter` heredado
  const beliefsByCharacter = {};
  const rawBeliefs = isPlainObject(input.beliefsByCharacter)
    ? input.beliefsByCharacter
    : (isPlainObject(existing?.beliefsByCharacter) ? existing.beliefsByCharacter : {});

  for (const [k, val] of Object.entries(rawBeliefs)) {
    const norm = normalizeBeliefEntry(k, val);
    if (!norm) continue;
    const canonicalKey = makeCharacterVersionKey(norm.characterId, norm.characterVersion);
    beliefsByCharacter[canonicalKey] = norm;
  }

  if (isPlainObject(input.statusByCharacter)) {
    for (const [k, st] of Object.entries(input.statusByCharacter)) {
      const key = makeCharacterVersionKey(k);
      if (!key || beliefsByCharacter[key]) continue;
      const norm = normalizeBeliefEntry(key, st);
      if (norm) beliefsByCharacter[key] = norm;
    }
  }

  const statusByCharacter = {};
  for (const [k, entry] of Object.entries(beliefsByCharacter)) {
    statusByCharacter[k] = entry.state;
  }

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
      ? toPositiveOrder(input.firstEffectiveChapterOrder)
      : (existing?.firstEffectiveChapterOrder ?? null),
    disclosureConstraints: cleanStringArray(
      input.disclosureConstraints !== undefined ? input.disclosureConstraints : existing?.disclosureConstraints
    ),
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
 * Actualiza de forma independiente la creencia de un único personaje (y versión opcional)
 * sobre un hecho existente. JAMÁS altera `fact.truth` ni las creencias de otros personajes.
 */
export async function updateCharacterBelief(factId, characterKey, beliefPatch, { projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const existing = await db.get('knowledgeFacts', factId, scope);
  if (!existing) throw new Error('No se encontró el hecho epistémico indicado.');
  const canonicalKey = makeCharacterVersionKey(characterKey, beliefPatch?.characterVersion || 'any');
  const prevEntry = existing.beliefsByCharacter?.[canonicalKey] || null;
  const nextEntry = normalizeBeliefEntry(canonicalKey, {
    ...(prevEntry || {}),
    ...(isPlainObject(beliefPatch) ? beliefPatch : { state: beliefPatch }),
    updatedAt: new Date().toISOString(),
  });
  const nextBeliefs = {
    ...(existing.beliefsByCharacter || {}),
    [canonicalKey]: nextEntry,
  };
  return saveKnowledgeFact({
    ...existing,
    beliefsByCharacter: nextBeliefs,
  }, scope);
}

function isEffectiveAtPoint(fact, { targetChapterOrder = null, currentCheckpoint = '' } = {}) {
  const factOrder = toPositiveOrder(fact?.firstEffectiveChapterOrder);
  const tgtOrder = toPositiveOrder(targetChapterOrder);
  if (factOrder !== null && tgtOrder !== null && factOrder > tgtOrder) {
    return false;
  }
  const factCp = cleanString(fact?.firstEffectiveCheckpoint);
  const curCp = cleanString(currentCheckpoint);
  if (
    factCp && curCp &&
    Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, factCp) &&
    Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, curCp)
  ) {
    if (PTS_CHECKPOINT_ORDER[factCp] > PTS_CHECKPOINT_ORDER[curCp]) {
      return false;
    }
  }
  return true;
}

function isBeliefEffectiveAtPoint(belief, { targetChapterOrder = null, currentCheckpoint = '' } = {}) {
  if (!belief) return false;
  const learnedOrder = toPositiveOrder(belief.learnedAtChapterOrder);
  const tgtOrder = toPositiveOrder(targetChapterOrder);
  if (learnedOrder !== null && tgtOrder !== null && learnedOrder > tgtOrder) {
    return false;
  }
  const learnedCp = cleanString(belief.learnedAtCheckpoint);
  const curCp = cleanString(currentCheckpoint);
  if (
    learnedCp && curCp &&
    Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, learnedCp) &&
    Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, curCp)
  ) {
    if (PTS_CHECKPOINT_ORDER[learnedCp] > PTS_CHECKPOINT_ORDER[curCp]) {
      return false;
    }
  }
  return true;
}

/**
 * Resuelve el estado epistémico completo en un punto temporal/espacial exacto.
 *
 * Garantías:
 * - Excluye hechos futuros (`firstEffectiveChapterOrder > targetChapterOrder`).
 * - Excluye hechos marcados como `stale` o `disputed` del canon autoritativo actual,
 *   devolviéndolos en `staleOrDisputedForReview` sin borrarlos.
 * - Mantiene `privateAuthorTruths` estrictamente separados del conocimiento de los personajes.
 * - Aísla versiones espaciales (`levi@room` vs `levi@screen`): una entrada etiquetada
 *   con `@screen` NUNCA se filtra al resolver `characterVersion = 'room'` y viceversa.
 * - Para eventos de pantalla (`layer === 'screen'`), un espectador en `room` que lo conoce
 *   recibe `experienceMode: 'watched_not_lived'` (ver en pantalla != haberlo vivido).
 * - Si `josephArrivalOrder` está definido, Joseph NO hereda eventos `room_event`/`screen_event`
 *   anteriores a su llegada salvo que exista evidencia explícita aprendida en `>= josephArrivalOrder`.
 */
export function resolveEpistemicStateAtPoint({
  facts = [],
  targetChapterOrder = null,
  currentCheckpoint = '',
  characterIds = [],
  characterVersion = 'room',
  josephArrivalOrder = null,
} = {}) {
  const version = CHARACTER_VERSIONS.has(cleanString(characterVersion).toLowerCase())
    ? cleanString(characterVersion).toLowerCase()
    : 'room';
  const authoritativeCanon = [];
  const privateAuthorTruths = [];
  const staleOrDisputedForReview = [];
  const futureExcluded = [];
  const characterKnowledgeMap = {};

  // Recolectar el conjunto de personajes a resolver
  const targetChars = new Set((characterIds || []).map((c) => parseCharacterVersionKey(c).characterId).filter(Boolean));
  for (const fact of (facts || [])) {
    if (!fact || fact.deletedAt) continue;
    for (const key of Object.keys(fact.beliefsByCharacter || {})) {
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
    const fact = rawFact.beliefsByCharacter ? rawFact : normalizeKnowledgeFact(rawFact);

    if (!isEffectiveAtPoint(fact, { targetChapterOrder, currentCheckpoint })) {
      futureExcluded.push({ id: fact.id, title: fact.title, firstEffectiveChapterOrder: fact.firstEffectiveChapterOrder });
      continue;
    }

    if (fact.stale || fact.disputed) {
      staleOrDisputedForReview.push(fact);
      continue;
    }

    if (fact.scope === 'private_author') {
      privateAuthorTruths.push(fact);
    } else {
      authoritativeCanon.push(fact);
    }

    const beliefs = fact.beliefsByCharacter || {};
    for (const cid of targetChars) {
      const bucket = characterKnowledgeMap[cid];
      const versionedKey = version !== 'any' ? `${cid}@${version}` : cid;
      const versionSpecificBelief = beliefs[versionedKey] || null;
      const genericBelief = beliefs[cid] || null;

      // Aislamiento estricto de versiones:
      // Si existen creencias específicas para otra versión (ej. `levi@screen`),
      // JAMÁS se copian automáticamente a `levi@room` (y viceversa).
      const candidateBelief = versionSpecificBelief || (genericBelief && genericBelief.characterVersion === 'any' ? genericBelief : null);

      const factOrder = toPositiveOrder(fact.firstEffectiveChapterOrder);
      const arrivalOrder = toPositiveOrder(josephArrivalOrder);
      const isBeforeJosephArrival = cid === 'joseph' &&
        arrivalOrder !== null &&
        factOrder !== null &&
        factOrder < arrivalOrder &&
        (fact.scope === 'screen_event' || fact.scope === 'room_event' || fact.layer === 'room' || fact.layer === 'screen');

      if (isBeforeJosephArrival) {
        const explicitlyBriefedAfterArrival = Boolean(
          candidateBelief &&
          candidateBelief.state !== 'unknown' &&
          isBeliefEffectiveAtPoint(candidateBelief, { targetChapterOrder, currentCheckpoint }) &&
          toPositiveOrder(candidateBelief.learnedAtChapterOrder) !== null &&
          toPositiveOrder(candidateBelief.learnedAtChapterOrder) >= arrivalOrder &&
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

      if (!candidateBelief || !isBeliefEffectiveAtPoint(candidateBelief, { targetChapterOrder, currentCheckpoint })) {
        if (fact.isSecret || fact.scope === 'private_author') {
          bucket.unknownSecrets.push({
            factId: fact.id,
            title: fact.title,
            state: 'unknown',
            reason: candidateBelief ? 'learned_later_than_target' : 'no_evidence',
          });
        }
        continue;
      }

      const experienceMode = fact.layer === 'screen' && version === 'room'
        ? 'watched_not_lived'
        : (fact.layer === version ? 'lived_direct' : 'indirect');

      const item = {
        factId: fact.id,
        title: fact.title,
        layer: fact.layer,
        scope: fact.scope,
        state: candidateBelief.state,
        beliefText: candidateBelief.beliefText || (candidateBelief.state === 'knows' ? fact.truth : ''),
        objectiveTruth: fact.truth,
        evidence: candidateBelief.evidence,
        source: candidateBelief.source || fact.sourceRef,
        learnedAtChapterOrder: candidateBelief.learnedAtChapterOrder,
        learnedAtCheckpoint: candidateBelief.learnedAtCheckpoint,
        disclosureConstraints: fact.disclosureConstraints,
        experienceMode,
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
    targetChapterOrder: toPositiveOrder(targetChapterOrder),
    currentCheckpoint: cleanString(currentCheckpoint),
    characterVersion: version,
    authoritativeCanon,
    privateAuthorTruths,
    characterKnowledgeMap,
    staleOrDisputedForReview,
    futureExcludedCount: futureExcluded.length,
    futureExcluded,
  };
}

// ---------------------------------------------------------------------------
// Continuidad emocional y relacional CUALITATIVA (sin puntuaciones numéricas)
// ---------------------------------------------------------------------------

export function makeRelationshipPairKey(participants = []) {
  const ids = cleanStringArray(participants).map(extractLogicalId).filter(Boolean).sort();
  return ids.join('+');
}

export function normalizeRelationshipState(input, { existing = null, projectId = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El estado relacional debe ser un objeto válido.');
  const participants = cleanStringArray(
    input.participants !== undefined ? input.participants : existing?.participants
  ).map(extractLogicalId);
  const pairKey = cleanString(input.pairKey || existing?.pairKey || makeRelationshipPairKey(participants));
  if (!pairKey) throw new Error('El estado relacional necesita al menos dos participantes o un `pairKey`.');

  const rawDims = isPlainObject(input.dimensions) ? input.dimensions : (existing?.dimensions || {});
  const dimensions = {};
  for (const dim of QUALITATIVE_DIMENSIONS) {
    const val = rawDims[dim];
    if (typeof val === 'number') {
      throw new Error(`La dimensión emocional «${dim}» debe ser cualitativa (texto narrativo), nunca una puntuación numérica.`);
    }
    dimensions[dim] = cleanString(val || '');
  }

  const normalizePromise = (p) => {
    if (typeof p === 'string') {
      const text = cleanString(p);
      return text ? { text, madeBy: '', madeTo: '', chapterOrder: null, sourceChapterId: null, status: 'open' } : null;
    }
    if (!isPlainObject(p) || !cleanString(p.text)) return null;
    return {
      text: cleanString(p.text),
      madeBy: extractLogicalId(p.madeBy || ''),
      madeTo: extractLogicalId(p.madeTo || ''),
      chapterOrder: toPositiveOrder(p.chapterOrder),
      sourceChapterId: cleanString(p.sourceChapterId || '') || null,
      status: ['open', 'kept', 'broken'].includes(p.status) ? p.status : 'open',
    };
  };

  const normalizeMemoryItem = (m) => {
    if (typeof m === 'string') {
      const text = cleanString(m);
      return text ? { text, chapterOrder: null, sourceChapterId: null } : null;
    }
    if (!isPlainObject(m) || !cleanString(m.text)) return null;
    return {
      text: cleanString(m.text),
      chapterOrder: toPositiveOrder(m.chapterOrder),
      sourceChapterId: cleanString(m.sourceChapterId || '') || null,
    };
  };

  const normalizePrivateSecret = (s) => {
    if (typeof s === 'string') {
      const text = cleanString(s);
      return text ? { text, heldBy: [], hiddenFrom: [], chapterOrder: null, sourceChapterId: null } : null;
    }
    if (!isPlainObject(s) || !cleanString(s.text)) return null;
    return {
      text: cleanString(s.text),
      heldBy: cleanStringArray(s.heldBy || []).map(extractLogicalId),
      hiddenFrom: cleanStringArray(s.hiddenFrom || []).map(extractLogicalId),
      chapterOrder: toPositiveOrder(s.chapterOrder),
      sourceChapterId: cleanString(s.sourceChapterId || '') || null,
    };
  };

  const normalizeEvidenceRef = (e) => {
    if (!isPlainObject(e)) return null;
    return {
      chapterId: cleanString(e.chapterId || '') || null,
      chapterOrder: toPositiveOrder(e.chapterOrder),
      quoteOrNote: cleanString(e.quoteOrNote || e.note || ''),
      chapterRevision: cleanString(e.chapterRevision || ''),
    };
  };

  const now = new Date().toISOString();
  const effectiveProjectId = cleanString(projectId || input.projectId || existing?.projectId) || db.getActiveProjectId();

  return {
    id: cleanString(input.id || existing?.id) || db.uid(),
    projectId: effectiveProjectId,
    pairKey,
    participants: participants.length ? participants : pairKey.split('+').filter(Boolean),
    label: cleanString(input.label !== undefined ? input.label : (existing?.label || pairKey.replace(/\+/g, ' & '))),
    relationshipStage: cleanString(input.relationshipStage !== undefined ? input.relationshipStage : (existing?.relationshipStage || '')),
    dimensions,
    unresolvedDisagreements: cleanStringArray(
      input.unresolvedDisagreements !== undefined ? input.unresolvedDisagreements : existing?.unresolvedDisagreements
    ),
    promises: (Array.isArray(input.promises) ? input.promises : (existing?.promises || [])).map(normalizePromise).filter(Boolean),
    sharedMemories: (Array.isArray(input.sharedMemories) ? input.sharedMemories : (existing?.sharedMemories || [])).map(normalizeMemoryItem).filter(Boolean),
    privateSecrets: (Array.isArray(input.privateSecrets) ? input.privateSecrets : (existing?.privateSecrets || [])).map(normalizePrivateSecret).filter(Boolean),
    behaviorChanges: cleanStringArray(
      input.behaviorChanges !== undefined ? input.behaviorChanges : existing?.behaviorChanges
    ),
    evidenceRefs: (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : (existing?.evidenceRefs || [])).map(normalizeEvidenceRef).filter(Boolean),
    effectiveChapterOrder: input.effectiveChapterOrder !== undefined
      ? toPositiveOrder(input.effectiveChapterOrder)
      : (existing?.effectiveChapterOrder ?? null),
    sourceChapterId: cleanString(input.sourceChapterId !== undefined ? input.sourceChapterId : existing?.sourceChapterId) || null,
    sourceChapterRevision: cleanString(input.sourceChapterRevision !== undefined ? input.sourceChapterRevision : existing?.sourceChapterRevision),
    stale: typeof input.stale === 'boolean' ? input.stale : Boolean(existing?.stale ?? false),
    staleReason: cleanString(input.staleReason !== undefined ? input.staleReason : existing?.staleReason),
    staleAt: input.staleAt !== undefined ? input.staleAt : (existing?.staleAt || null),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
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
 * Filtra estados relacionales cualitativos estrictamente hasta `targetChapterOrder`,
 * separando registros `stale` para revisión y recogiendo promesas abiertas y secretos.
 */
export function resolveRelationshipsAtPoint({
  relationships = [],
  targetChapterOrder = null,
} = {}) {
  const tgtOrder = toPositiveOrder(targetChapterOrder);
  const authoritative = [];
  const staleForReview = [];
  const openPromises = [];
  const activeSecrets = [];

  for (const raw of (relationships || [])) {
    if (!raw || raw.deletedAt) continue;
    const rel = raw.dimensions ? raw : normalizeRelationshipState(raw);
    const effOrder = toPositiveOrder(rel.effectiveChapterOrder);
    if (effOrder !== null && tgtOrder !== null && effOrder > tgtOrder) continue;
    if (rel.stale) {
      staleForReview.push(rel);
      continue;
    }

    // Filtrar promesas, recuerdos y secretos con chapterOrder futuro
    const filteredPromises = (rel.promises || []).filter((p) =>
      p.chapterOrder === null || tgtOrder === null || p.chapterOrder <= tgtOrder
    );
    const filteredMemories = (rel.sharedMemories || []).filter((m) =>
      m.chapterOrder === null || tgtOrder === null || m.chapterOrder <= tgtOrder
    );
    const filteredSecrets = (rel.privateSecrets || []).filter((s) =>
      s.chapterOrder === null || tgtOrder === null || s.chapterOrder <= tgtOrder
    );

    const view = {
      ...rel,
      promises: filteredPromises,
      sharedMemories: filteredMemories,
      privateSecrets: filteredSecrets,
    };
    authoritative.push(view);

    for (const p of filteredPromises) {
      if (p.status === 'open') openPromises.push({ ...p, pairKey: rel.pairKey, relationshipLabel: rel.label });
    }
    for (const s of filteredSecrets) {
      activeSecrets.push({ ...s, pairKey: rel.pairKey, relationshipLabel: rel.label });
    }
  }

  return {
    authoritative,
    staleForReview,
    openPromises,
    activeSecrets,
  };
}
