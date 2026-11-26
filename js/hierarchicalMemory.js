// hierarchicalMemory.js — Arquitectura jerárquica de memoria a largo plazo (6 capas)
// escalable a 100+ capítulos y 500,000+ palabras con presupuesto real serializado,
// trazabilidad explicable (0 tokens) y aislamiento temporal estricto.
//
// Capas:
//   A) Estado inmediato de escena (cierre del capítulo anterior + estado físico/lugar/tiempo)
//   B) Continuidad de capítulos recientes (últimos capítulos aprobados de línea principal)
//   C) Memorias episódicas históricas y pasajes recuperados vía BM25 (capítulos antiguos + referencias)
//   D) Conocimiento epistémico individual temporal y estado emocional/relacional cualitativo
//   E) Resúmenes de arcos narrativos elegibles (jamás inyecta arcos con contenido futuro)
//   F) Canon permanente (hechos bloqueados, canon revelado/privado) e hilos sin resolver
//
// Invariantes:
// - Solo usa capítulos de la línea principal (nunca capítulos alternativos).
// - Respeta prólogos, capítulos heredados con igual `order` y numeración irregular vía `chaptersBefore`.
// - Nunca inyecta un resumen de arco que abarque capítulos futuros (`endChapterOrder >= targetChapterOrder`):
//   lo excluye o construye una vista histórica acotada usando únicamente evidencia elegible.
// - Contabiliza el presupuesto real del payload serializado destinado al modelo (`modelPayload`),
//   manteniendo aparte los diagnósticos del Inspector (`inspectorDiagnostics`).
// - NUNCA trunca silenciosamente reglas críticas, secretos ni restricciones de divulgación:
//   si el contexto esencial supera el presupuesto, emite advertencia y sugerencias explícitas.

import { db } from './db.js';
import {
  isMainTimelineChapter,
  sortMainTimelineChapters,
  chaptersBefore,
  memoriesForChapters,
} from './timeline.js';
import { contentFingerprint, wordCount } from './utils.js';
import {
  resolveEpistemicStateAtPoint,
  resolveRelationshipsAtPoint,
  parseCharacterVersionKey,
} from './knowledgeLedger.js';
import {
  buildChapterLexicalIndex,
  buildDocumentLexicalIndex,
  isChapterLexicalIndexFresh,
  isDocumentLexicalIndexFresh,
  searchLexicalIndex,
  tokenizeForBm25,
} from './lexicalIndex.js';
import { partitionStoryReferences } from './referenceRoles.js';

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

function clip(text, maxChars) {
  const s = cleanString(text);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function serializedLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value || '').length;
  }
}

// ---------------------------------------------------------------------------
// Resúmenes de arcos narrativos (`arcSummaries`) con procedencia completa de
// secretos, promesas y relaciones (sin confundir compresión con resumen sin pérdida).
// ---------------------------------------------------------------------------

function normalizeProvenanceSecret(item) {
  if (typeof item === 'string') {
    const text = cleanString(item);
    return text ? { factId: null, title: text.slice(0, 72), truth: text, scope: 'world_fact', authorOnly: false, layer: 'global', knownBy: [], suspectedBy: [], believesFalseBy: [], unknownTo: [], disclosureConstraints: [], characterVersions: [], evidenceLinks: [] } : null;
  }
  if (!isPlainObject(item)) return null;
  const truth = cleanString(item.truth || item.text || '');
  if (!truth) return null;
  const scope = cleanString(item.scope || 'world_fact');
  return {
    factId: cleanString(item.factId || item.id || '') || null,
    title: cleanString(item.title || truth.slice(0, 72)),
    truth,
    scope,
    authorOnly: Boolean(item.authorOnly ?? (scope === 'private_author')),
    layer: cleanString(item.layer || 'global'),
    sourceChapterId: cleanString(item.sourceChapterId || '') || null,
    sourceChapterRevision: cleanString(item.sourceChapterRevision || ''),
    firstEffectiveChapterOrder: item.firstEffectiveChapterOrder ?? null,
    firstEffectiveCheckpoint: cleanString(item.firstEffectiveCheckpoint || ''),
    knownBy: cleanStringArray(item.knownBy || []),
    suspectedBy: cleanStringArray(item.suspectedBy || []),
    believesFalseBy: cleanStringArray(item.believesFalseBy || []),
    unknownTo: cleanStringArray(item.unknownTo || []),
    disclosureConstraints: cleanStringArray(item.disclosureConstraints || []),
    characterVersions: cleanStringArray(item.characterVersions || []),
    evidenceLinks: Array.isArray(item.evidenceLinks) ? structuredClone(item.evidenceLinks) : [],
  };
}

function normalizeProvenancePromise(item) {
  if (typeof item === 'string') {
    const text = cleanString(item);
    return text ? { relationshipId: null, pairKey: '', text, status: 'open', chapterOrder: null, sourceChapterId: null, evidenceLinks: [] } : null;
  }
  if (!isPlainObject(item) || !cleanString(item.text)) return null;
  return {
    relationshipId: cleanString(item.relationshipId || '') || null,
    pairKey: cleanString(item.pairKey || ''),
    relationshipLabel: cleanString(item.relationshipLabel || ''),
    text: cleanString(item.text),
    madeBy: cleanString(item.madeBy || ''),
    madeTo: cleanString(item.madeTo || ''),
    status: ['open', 'kept', 'broken'].includes(item.status) ? item.status : 'open',
    chapterOrder: item.chapterOrder ?? null,
    sourceChapterId: cleanString(item.sourceChapterId || '') || null,
    evidenceLinks: Array.isArray(item.evidenceLinks) ? structuredClone(item.evidenceLinks) : [],
  };
}

function normalizeProvenanceRelationshipShift(item) {
  if (typeof item === 'string') {
    const text = cleanString(item);
    return text ? { relationshipId: null, pairKey: '', summary: text, sourceChapterId: null, sourceChapterRevision: '', effectiveChapterOrder: null, evidenceLinks: [] } : null;
  }
  if (!isPlainObject(item)) return null;
  const summary = cleanString(item.summary || item.text || '');
  if (!summary) return null;
  return {
    relationshipId: cleanString(item.relationshipId || '') || null,
    pairKey: cleanString(item.pairKey || ''),
    participants: cleanStringArray(item.participants || []),
    summary,
    sourceChapterId: cleanString(item.sourceChapterId || '') || null,
    sourceChapterRevision: cleanString(item.sourceChapterRevision || ''),
    effectiveChapterOrder: item.effectiveChapterOrder ?? null,
    evidenceLinks: Array.isArray(item.evidenceLinks) ? structuredClone(item.evidenceLinks) : [],
  };
}

export function normalizeArcSummary(input, { existing = null, projectId = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El resumen de arco debe ser un objeto válido.');
  const title = cleanString(input.title !== undefined ? input.title : existing?.title);
  if (!title) throw new Error('El resumen de arco necesita un título.');
  const now = new Date().toISOString();
  const effectiveProject = cleanString(projectId || input.projectId || existing?.projectId) || db.getActiveProjectId();
  const arcOrder = Number.isFinite(Number(input.arcOrder ?? existing?.arcOrder))
    ? Math.floor(Number(input.arcOrder ?? existing?.arcOrder))
    : 1;
  const startChapterOrder = input.startChapterOrder !== undefined && input.startChapterOrder !== null && input.startChapterOrder !== ''
    ? Math.floor(Number(input.startChapterOrder))
    : (existing?.startChapterOrder ?? null);
  const endChapterOrder = input.endChapterOrder !== undefined && input.endChapterOrder !== null && input.endChapterOrder !== ''
    ? Math.floor(Number(input.endChapterOrder))
    : (existing?.endChapterOrder ?? null);

  const rawSecrets = input.preservedSecrets !== undefined ? input.preservedSecrets : existing?.preservedSecrets;
  const rawPromises = input.preservedPromises !== undefined ? input.preservedPromises : existing?.preservedPromises;
  const rawShifts = input.relationshipShifts !== undefined ? input.relationshipShifts : existing?.relationshipShifts;

  return {
    id: cleanString(input.id || existing?.id) || db.uid(),
    projectId: effectiveProject,
    arcOrder,
    title,
    startChapterOrder,
    endChapterOrder,
    summary: cleanString(input.summary !== undefined ? input.summary : existing?.summary),
    isCompressedSummary: true,
    lossless: false,
    compressionNote: cleanString(
      input.compressionNote ||
      existing?.compressionNote ||
      'Resumen comprimido con prioridad a secretos, promesas, relaciones y enlaces a evidencia primaria; no sustituye los capítulos originales.'
    ),
    preservedSecrets: (Array.isArray(rawSecrets) ? rawSecrets : []).map(normalizeProvenanceSecret).filter(Boolean),
    preservedPromises: (Array.isArray(rawPromises) ? rawPromises : []).map(normalizeProvenancePromise).filter(Boolean),
    relationshipShifts: (Array.isArray(rawShifts) ? rawShifts : []).map(normalizeProvenanceRelationshipShift).filter(Boolean),
    openThreads: cleanStringArray(input.openThreads !== undefined ? input.openThreads : existing?.openThreads),
    sourceChapterIds: cleanStringArray(input.sourceChapterIds !== undefined ? input.sourceChapterIds : existing?.sourceChapterIds),
    sourceRevisions: isPlainObject(input.sourceRevisions)
      ? structuredClone(input.sourceRevisions)
      : (isPlainObject(existing?.sourceRevisions) ? structuredClone(existing.sourceRevisions) : {}),
    stale: typeof input.stale === 'boolean' ? input.stale : Boolean(existing?.stale ?? false),
    staleReason: cleanString(input.staleReason !== undefined ? input.staleReason : existing?.staleReason),
    staleAt: input.staleAt !== undefined ? input.staleAt : (existing?.staleAt || null),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

export async function listArcSummaries({ projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const all = await db.getAll('arcSummaries', scope);
  return (all || [])
    .filter((a) => !a.deletedAt)
    .sort((a, b) => (a.arcOrder ?? 0) - (b.arcOrder ?? 0) || (a.startChapterOrder ?? 0) - (b.startChapterOrder ?? 0));
}

export async function saveArcSummary(input, { projectId = '' } = {}) {
  const effectiveProject = projectId || input?.projectId || db.getActiveProjectId();
  const scope = { projectId: effectiveProject };
  const existing = input?.id ? await db.get('arcSummaries', input.id, scope) : null;
  const normalized = normalizeArcSummary(input, { existing, projectId: effectiveProject });
  return db.put('arcSummaries', normalized, scope);
}

export async function deleteArcSummary(id, { projectId = '' } = {}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  return db.del('arcSummaries', id, scope);
}

/**
 * Comprime una ventana de capítulos en un resumen de arco (0 tokens) preservando
 * procedencia completa de secretos (factId, revisión, capa, versión, quién sabe/sospecha/desconoce,
 * restricciones de divulgación y etiqueta `authorOnly` para verdades privadas del autor),
 * promesas abiertas y cambios relacionales con vínculos a la evidencia original.
 */
export function compressArcWindow({
  projectId = '',
  arcOrder = 1,
  title = '',
  startChapterOrder = 1,
  endChapterOrder = 10,
  chapters = [],
  memoryEntries = [],
  knowledgeFacts = [],
  relationships = [],
} = {}) {
  const mainChapters = sortMainTimelineChapters(chapters).filter((ch) => {
    const ord = Number(ch.order ?? 0);
    return ord >= startChapterOrder && ord <= endChapterOrder;
  });
  const chIds = new Set(mainChapters.map((c) => c.id));
  const sourceRevisions = {};
  for (const ch of mainChapters) {
    sourceRevisions[ch.id] = contentFingerprint(ch.content || '');
  }

  const windowMemories = memoriesForChapters(memoryEntries, mainChapters).filter((m) => !m.stale);
  const summaryParts = [];
  const relationshipShifts = [];
  const openThreads = [];

  for (const m of windowMemories) {
    if (m.events) summaryParts.push(`${m.chapterTitle || 'Cap.'}: ${clip(m.events, 220)}`);
    if (m.relationshipChanges) {
      relationshipShifts.push({
        relationshipId: null,
        pairKey: '',
        participants: [],
        summary: `${m.chapterTitle || 'Cap.'}: ${clip(m.relationshipChanges, 220)}`,
        sourceChapterId: m.chapterId || null,
        sourceChapterRevision: m.sourceChapterRevision || sourceRevisions[m.chapterId] || '',
        effectiveChapterOrder: m.chapterOrder ?? null,
        evidenceLinks: [{ chapterId: m.chapterId, memoryId: m.id }],
      });
    }
    if (m.openThreads) openThreads.push(`${m.chapterTitle || 'Cap.'}: ${clip(m.openThreads, 220)}`);
  }
  if (!summaryParts.length && mainChapters.length) {
    for (const ch of mainChapters) {
      summaryParts.push(`${ch.title || `Cap. ${ch.order}`}: ${clip(ch.content || '', 180)}`);
    }
  }

  // Preservar procedencia epistémica completa (nunca convertir `private_author` en conocimiento de personajes)
  const preservedSecrets = [];
  for (const fact of (knowledgeFacts || [])) {
    if (!fact || fact.deletedAt || fact.stale || fact.disputed) continue;
    const ord = fact.firstEffectiveChapterOrder;
    const inRange = (ord !== null && ord !== undefined && ord >= startChapterOrder && ord <= endChapterOrder) ||
      (fact.sourceChapterId && chIds.has(fact.sourceChapterId));
    if (!inRange || !(fact.isSecret || fact.scope === 'private_author')) continue;

    const knownBy = [];
    const suspectedBy = [];
    const believesFalseBy = [];
    const unknownTo = [];
    const characterVersions = new Set();
    const evidenceLinks = [];

    if (fact.sourceChapterId) {
      evidenceLinks.push({
        type: 'source_chapter',
        chapterId: fact.sourceChapterId,
        chapterRevision: fact.sourceChapterRevision || sourceRevisions[fact.sourceChapterId] || '',
        sourceRef: fact.sourceRef || '',
      });
    }

    // Evaluar estado de cada personaje al cierre de la ventana (`endChapterOrder`)
    const histMap = fact.beliefHistoryByCharacter || {};
    const fallbackMap = fact.beliefsByCharacter || {};
    const keys = new Set([...Object.keys(histMap), ...Object.keys(fallbackMap)]);
    for (const key of keys) {
      const parsed = parseCharacterVersionKey(key);
      if (parsed.characterVersion !== 'any') characterVersions.add(parsed.characterVersion);
      const list = Array.isArray(histMap[key])
        ? histMap[key].filter((b) => !b.stale && (b.effectiveChapterOrder === null || b.effectiveChapterOrder <= endChapterOrder))
        : (fallbackMap[key] ? [fallbackMap[key]] : []);
      const active = list[list.length - 1];
      if (!active) continue;
      if (active.state === 'knows') knownBy.push(key);
      else if (active.state === 'suspects') suspectedBy.push(key);
      else if (active.state === 'believes_false') believesFalseBy.push(key);
      else if (active.state === 'unknown') unknownTo.push(key);
      if (active.evidence || active.sourceChapterId) {
        evidenceLinks.push({
          type: 'character_belief',
          characterKey: key,
          state: active.state,
          chapterId: active.sourceChapterId || null,
          chapterOrder: active.effectiveChapterOrder ?? null,
          evidence: active.evidence || '',
        });
      }
    }

    preservedSecrets.push({
      factId: fact.id,
      title: fact.title,
      truth: fact.truth,
      scope: fact.scope,
      authorOnly: fact.scope === 'private_author',
      layer: fact.layer,
      sourceChapterId: fact.sourceChapterId || null,
      sourceChapterRevision: fact.sourceChapterRevision || (fact.sourceChapterId ? sourceRevisions[fact.sourceChapterId] || '' : ''),
      firstEffectiveChapterOrder: fact.firstEffectiveChapterOrder ?? null,
      firstEffectiveCheckpoint: fact.firstEffectiveCheckpoint || '',
      knownBy,
      suspectedBy,
      believesFalseBy,
      unknownTo,
      disclosureConstraints: cleanStringArray(fact.disclosureConstraints || []),
      characterVersions: [...characterVersions],
      evidenceLinks,
    });
  }

  const preservedPromises = [];
  const resolvedRels = resolveRelationshipsAtPoint({
    relationships,
    targetChapterOrder: endChapterOrder,
    chapters,
  }).authoritative;

  for (const rel of resolvedRels) {
    for (const p of (rel.promises || [])) {
      const inRange = (p.chapterOrder !== null && p.chapterOrder >= startChapterOrder && p.chapterOrder <= endChapterOrder) ||
        (p.sourceChapterId && chIds.has(p.sourceChapterId));
      if (inRange) {
        preservedPromises.push({
          relationshipId: rel.id,
          pairKey: rel.pairKey,
          relationshipLabel: rel.label,
          text: p.text,
          madeBy: p.madeBy || '',
          madeTo: p.madeTo || '',
          status: p.status,
          chapterOrder: p.chapterOrder ?? null,
          sourceChapterId: p.sourceChapterId || null,
          evidenceLinks: rel.evidenceRefs || [],
        });
      }
    }
    for (const s of (rel.privateSecrets || [])) {
      const inRange = (s.chapterOrder !== null && s.chapterOrder >= startChapterOrder && s.chapterOrder <= endChapterOrder) ||
        (s.sourceChapterId && chIds.has(s.sourceChapterId));
      if (inRange) {
        preservedSecrets.push({
          factId: `rel_secret:${rel.id}`,
          title: `Secreto compartido (${rel.label})`,
          truth: s.text,
          scope: 'world_fact',
          authorOnly: false,
          layer: 'room',
          sourceChapterId: s.sourceChapterId || rel.sourceChapterId || null,
          sourceChapterRevision: rel.sourceChapterRevision || '',
          firstEffectiveChapterOrder: s.chapterOrder ?? null,
          firstEffectiveCheckpoint: '',
          knownBy: s.heldBy || [],
          suspectedBy: [],
          believesFalseBy: [],
          unknownTo: s.hiddenFrom || [],
          disclosureConstraints: ['Secreto privado de relación'],
          characterVersions: [],
          evidenceLinks: rel.evidenceRefs || [],
        });
      }
    }
    if ((rel.sourceChapterId && chIds.has(rel.sourceChapterId)) || (rel.activeSnapshotChapterOrder !== null && rel.activeSnapshotChapterOrder >= startChapterOrder && rel.activeSnapshotChapterOrder <= endChapterOrder)) {
      if (rel.behaviorChanges?.length) {
        relationshipShifts.push({
          relationshipId: rel.id,
          pairKey: rel.pairKey,
          participants: rel.participants || [],
          summary: `${rel.label}: ${rel.behaviorChanges.join('; ')}`,
          sourceChapterId: rel.sourceChapterId || null,
          sourceChapterRevision: rel.sourceChapterRevision || '',
          effectiveChapterOrder: rel.activeSnapshotChapterOrder ?? rel.effectiveChapterOrder ?? null,
          evidenceLinks: rel.evidenceRefs || [],
        });
      }
    }
  }

  const autoTitle = cleanString(title) || `Arco ${arcOrder} (Caps. ${startChapterOrder}–${endChapterOrder})`;
  return normalizeArcSummary({
    projectId: projectId || db.getActiveProjectId(),
    arcOrder,
    title: autoTitle,
    startChapterOrder,
    endChapterOrder,
    summary: clip(summaryParts.join(' | '), 1800),
    preservedSecrets,
    preservedPromises,
    relationshipShifts,
    openThreads,
    sourceChapterIds: [...chIds],
    sourceRevisions,
    stale: false,
  });
}

// ---------------------------------------------------------------------------
// Ensamblador jerárquico con presupuesto REAL serializado (`modelPayload`) y
// diagnósticos separados para el Inspector (`inspectorDiagnostics`).
// ---------------------------------------------------------------------------

function scoreMemoryRelevance(memory, queryTokens) {
  if (!queryTokens.length) return { score: 0, matchedTerms: [] };
  const haystack = [
    memory.chapterTitle,
    memory.events,
    memory.relationshipChanges,
    memory.newFacts,
    memory.whoKnowsWhat,
    memory.physicalState,
    memory.currentLocationTime,
    memory.openThreads,
  ].filter(Boolean).join(' ');
  const memTokens = new Set(tokenizeForBm25(haystack));
  const matchedTerms = [];
  for (const tok of queryTokens) {
    if (memTokens.has(tok)) matchedTerms.push(tok);
  }
  return { score: matchedTerms.length, matchedTerms };
}

function areArcRevisionsFresh(arc, chaptersById) {
  if (!arc?.sourceRevisions || !Object.keys(arc.sourceRevisions).length) return true;
  for (const [chId, expectedRev] of Object.entries(arc.sourceRevisions)) {
    const ch = chaptersById.get(chId);
    if (!ch) return false;
    if (expectedRev && contentFingerprint(ch.content || '') !== expectedRev) return false;
  }
  return true;
}

export function assembleHierarchicalMemory({
  projectId = '',
  targetChapterOrder = null,
  targetSceneOrder = null,
  targetChapterId = null,
  currentCheckpoint = '',
  activeTimelineId = '',
  fandom = '',
  query = '',
  characterVersion = 'room',
  activeCharacterIds = [],
  josephArrivalOrder = null,
  chapters = [],
  memoryEntries = [],
  knowledgeFacts = [],
  relationships = [],
  arcSummaries = [],
  lockedFacts = [],
  canonNotes = [],
  documents = [],
  docChunks = [],
  chapterLexicalIndex = null,
  documentLexicalIndex = null,
  maxTotalChars = 24000,
  recentChapterCount = 3,
  maxHistoricalPassages = 5,
  maxDocPassages = 3,
} = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const effectiveProject = cleanString(projectId) || 'original';
  const budgetCap = Math.max(2000, Number(maxTotalChars) || 24000);

  // 1. Aislar estrictamente capítulos de ESTA historia y de la LÍNEA PRINCIPAL
  //    respetando prólogos, capítulos con igual `order` y numeración irregular.
  const allScopedChapters = (chapters || []).filter((ch) => ch && (ch.projectId || 'original') === effectiveProject);
  const alternativeExcludedCount = allScopedChapters.filter((ch) => !isMainTimelineChapter(ch)).length;
  const mainChapters = sortMainTimelineChapters(allScopedChapters);

  let priorMainChapters;
  let effectiveTargetOrder = targetChapterOrder;
  if (targetChapterId) {
    const targetObj = allScopedChapters.find((c) => c.id === targetChapterId);
    if (targetObj && (effectiveTargetOrder === null || effectiveTargetOrder === undefined)) {
      effectiveTargetOrder = Number(targetObj.order ?? 0);
    }
    priorMainChapters = chaptersBefore(allScopedChapters, targetChapterId);
  } else {
    if (effectiveTargetOrder === null || effectiveTargetOrder === undefined) {
      const maxOrder = mainChapters.reduce((acc, ch) => Math.max(acc, Number(ch.order ?? 0)), 0);
      effectiveTargetOrder = maxOrder + 1;
    }
    priorMainChapters = mainChapters.filter((ch) =>
      Number(ch.order ?? 0) < effectiveTargetOrder && String(ch.content || '').trim().length > 0
    );
  }

  const eligibleChapterIds = new Set(priorMainChapters.map((ch) => ch.id));
  const futureChaptersExcluded = mainChapters.filter((ch) => !eligibleChapterIds.has(ch.id) && ch.id !== targetChapterId && String(ch.content || '').trim().length > 0).length;
  const chaptersById = new Map(priorMainChapters.map((ch) => [ch.id, ch]));

  let totalCorpusWords = 0;
  for (const ch of priorMainChapters) {
    totalCorpusWords += Number.isFinite(Number(ch.wordCount)) ? Number(ch.wordCount) : wordCount(ch.content || '');
  }

  // 2. Separar memorias activas (revisión válida, no stale) vs stale para revisión
  const orderedMemories = memoriesForChapters(memoryEntries, priorMainChapters);
  const staleMemories = [];
  const activeMemories = [];
  for (const m of orderedMemories) {
    const ch = chaptersById.get(m.chapterId);
    const revMismatch = Boolean(m.sourceChapterRevision && ch && contentFingerprint(ch.content || '') !== m.sourceChapterRevision);
    if (m.stale === true || revMismatch) {
      staleMemories.push(revMismatch && !m.stale ? { ...m, stale: true, staleReason: 'source_revision_mismatch' } : m);
    } else {
      activeMemories.push(m);
    }
  }

  // 3. Resolver conocimiento epistémico temporal y relaciones cualitativas (pasando `allScopedChapters` para excluir alternativas)
  const epistemic = resolveEpistemicStateAtPoint({
    facts: (knowledgeFacts || []).filter((f) => (f.projectId || 'original') === effectiveProject),
    targetChapterOrder: effectiveTargetOrder,
    targetSceneOrder,
    currentCheckpoint,
    characterIds: activeCharacterIds,
    characterVersion,
    josephArrivalOrder,
    chapters: allScopedChapters,
  });
  const relState = resolveRelationshipsAtPoint({
    relationships: (relationships || []).filter((r) => (r.projectId || 'original') === effectiveProject),
    targetChapterOrder: effectiveTargetOrder,
    targetSceneOrder,
    currentCheckpoint,
    chapters: allScopedChapters,
  });

  // 4. Resúmenes de arcos narrativos: NUNCA inyectar un arco que abarque capítulos >= targetChapterOrder!
  const scopedArcs = (arcSummaries || [])
    .filter((a) => a && !a.deletedAt && (a.projectId || 'original') === effectiveProject)
    .sort((a, b) => (a.arcOrder ?? 0) - (b.arcOrder ?? 0));
  const staleArcs = [];
  const eligibleArcs = [];
  const futureContainingArcsExcluded = [];
  const ambiguousArcsExcluded = [];

  for (const arc of scopedArcs) {
    if (arc.startChapterOrder === null || arc.startChapterOrder === undefined || arc.endChapterOrder === null || arc.endChapterOrder === undefined) {
      ambiguousArcsExcluded.push({ id: arc.id, title: arc.title, reason: 'missing_arc_chapter_bounds' });
      continue;
    }
    if (arc.startChapterOrder >= effectiveTargetOrder) {
      futureContainingArcsExcluded.push({ id: arc.id, title: arc.title, range: `${arc.startChapterOrder}-${arc.endChapterOrder}`, reason: 'entirely_future_arc' });
      continue;
    }
    if (arc.endChapterOrder >= effectiveTargetOrder) {
      // El arco contiene capítulos futuros (p.ej. 1-20 al reescribir Cap. 7):
      // JAMÁS inyectar el resumen completo sin filtrar; construir vista histórica acotada SOLO con evidencia elegible!
      futureContainingArcsExcluded.push({
        id: arc.id,
        title: arc.title,
        range: `${arc.startChapterOrder}-${arc.endChapterOrder}`,
        reason: 'contains_future_chapters_replaced_with_bounded_historical_view',
      });
      const eligibleSliceEnd = effectiveTargetOrder - 1;
      if (eligibleSliceEnd >= arc.startChapterOrder && priorMainChapters.some((ch) => Number(ch.order ?? 0) >= arc.startChapterOrder && Number(ch.order ?? 0) <= eligibleSliceEnd)) {
        const boundedView = compressArcWindow({
          projectId: effectiveProject,
          arcOrder: arc.arcOrder,
          title: `${arc.title} (vista histórica acotada Caps. ${arc.startChapterOrder}–${eligibleSliceEnd})`,
          startChapterOrder: arc.startChapterOrder,
          endChapterOrder: eligibleSliceEnd,
          chapters: priorMainChapters,
          memoryEntries: activeMemories,
          knowledgeFacts: [...epistemic.authoritativeCanon, ...epistemic.privateAuthorTruths],
          relationships: relState.authoritative,
        });
        boundedView.synthesizedHistoricalSlice = true;
        eligibleArcs.push(boundedView);
      }
      continue;
    }
    if (arc.stale === true || !areArcRevisionsFresh(arc, chaptersById)) {
      staleArcs.push(arc.stale ? arc : { ...arc, stale: true, staleReason: 'source_revision_mismatch' });
      continue;
    }
    eligibleArcs.push(arc);
  }

  // 5. Validar frescura de índices BM25 antes de consumirlos; reconstruir si las revisiones no coinciden
  let chIndex = chapterLexicalIndex;
  const chIndexFresh = Boolean(chIndex && isChapterLexicalIndexFresh(chIndex, allScopedChapters));
  if (!chIndexFresh) {
    chIndex = buildChapterLexicalIndex(priorMainChapters, { projectId: effectiveProject });
  }
  const bm25Hits = query
    ? searchLexicalIndex(chIndex, query, {
        topK: maxHistoricalPassages,
        eligibleChapterIds,
        excludeChapterId: targetChapterId,
        chaptersById,
        maxPerChapter: 2,
      })
    : [];

  const partitionedRefs = partitionStoryReferences(documents, { activeTimelineId, fandom });
  const eligibleDocumentIds = new Set(partitionedRefs.factualDocuments.map((d) => d.id));
  let docHits = [];
  if (query && eligibleDocumentIds.size > 0 && (documentLexicalIndex || (partitionedRefs.factualDocuments.length && docChunks?.length))) {
    let dIdx = documentLexicalIndex;
    const dIdxFresh = Boolean(dIdx && isDocumentLexicalIndexFresh(dIdx, documents, docChunks));
    if (!dIdxFresh) {
      dIdx = buildDocumentLexicalIndex(partitionedRefs.factualDocuments, docChunks, { projectId: effectiveProject });
    }
    docHits = searchLexicalIndex(dIdx, query, {
      topK: maxDocPassages,
      eligibleDocumentIds,
      excludeDocTypes: ['STYLE_ONLY'],
      maxPerChapter: 2,
    });
  }

  // 6. Construir el PAYLOAD REAL destinado al modelo (`modelPayload`) con presupuesto serializado real
  //    y separado de `inspectorDiagnostics`.
  const explainability = [];
  const budgetWarnings = [];
  const budgetSuggestions = [];

  // --- BLOQUE ESENCIAL NO TRUNCABLE: hechos bloqueados, restricciones de divulgación, secretos críticos, promesas abiertas ---
  const scopedLockedFacts = (lockedFacts || [])
    .filter((f) => f && (f.projectId || 'original') === effectiveProject)
    .map((lf) => ({ id: lf.id, text: cleanString(lf.text) }))
    .filter((lf) => lf.text);

  for (const lf of scopedLockedFacts) {
    explainability.push({
      layer: 'F_permanent_canon',
      sourceType: 'locked_fact',
      title: 'Hecho bloqueado',
      chapterOrder: null,
      revision: '',
      score: 100,
      matchedTerms: [],
      whyRetrieved: 'Hecho bloqueado permanente (esencial; nunca se trunca silenciosamente).',
    });
  }

  const criticalSecretRules = [...epistemic.authoritativeCanon, ...epistemic.privateAuthorTruths]
    .filter((f) => f.isSecret || f.scope === 'private_author' || (f.disclosureConstraints && f.disclosureConstraints.length))
    .map((f) => ({
      factId: f.id,
      title: f.title,
      truth: f.truth,
      scope: f.scope,
      authorOnly: f.scope === 'private_author',
      layer: f.layer,
      disclosureConstraints: f.disclosureConstraints || [],
    }));

  const openPromises = relState.openPromises.map((p) => ({
    kind: 'open_promise',
    relationshipId: p.relationshipId || null,
    chapterOrder: p.chapterOrder,
    label: p.relationshipLabel,
    text: p.text,
  }));
  for (const p of openPromises) {
    explainability.push({
      layer: 'F_permanent_canon',
      sourceType: 'open_promise',
      title: `Promesa abierta (${p.label})`,
      chapterOrder: p.chapterOrder,
      revision: '',
      score: 90,
      matchedTerms: [],
      whyRetrieved: 'Promesa aún abierta en continuidad relacional (esencial; nunca se descarta al comprimir).',
    });
  }

  const modelPayload = {
    projectId: effectiveProject,
    targetChapterOrder: effectiveTargetOrder,
    targetSceneOrder: targetSceneOrder ?? null,
    currentCheckpoint: cleanString(currentCheckpoint),
    characterVersion: epistemic.characterVersion,
    layers: {
      F_permanent_canon: {
        lockedFacts: scopedLockedFacts,
        criticalSecretRules,
        revealedCanon: [],
        privateAuthorCanon: [],
        openThreads: [...openPromises],
      },
      A_immediate_scene: {
        previousChapterId: null,
        previousChapterOrder: null,
        previousChapterTitle: '',
        previousEndingExcerpt: '',
        physicalState: '',
        currentLocationTime: '',
      },
      B_recent_continuity: { recentMemories: [] },
      C_historical_episodic: {
        historicalMemories: [],
        historicalPassages: [],
        referencePassages: [],
      },
      D_character_epistemic_and_relationships: {
        characterVersion: epistemic.characterVersion,
        authoritativeFacts: [],
        characterKnowledgeMap: {},
        relationships: [],
      },
      E_arc_summaries: { arcSummaries: [] },
    },
  };

  const essentialChars = serializedLength(modelPayload);
  const canFit = (candidateFn) => {
    candidateFn();
    return serializedLength(modelPayload) <= budgetCap;
  };

  const tryPush = (arr, item) => {
    arr.push(item);
    if (serializedLength(modelPayload) > budgetCap) {
      arr.pop();
      return false;
    }
    return true;
  };

  if (essentialChars > budgetCap) {
    budgetWarnings.push({
      code: 'essential_context_exceeds_budget',
      level: 'warning',
      essentialChars,
      budgetCapChars: budgetCap,
      message: `El contexto esencial no truncable (${essentialChars.toLocaleString('es-ES')} caracteres) supera el presupuesto configurado (${budgetCap.toLocaleString('es-ES')} caracteres). No se truncó ninguna regla crítica, secreto ni restricción de divulgación.`,
    });
    budgetSuggestions.push(
      'Archiva o marca como cumplidas las promesas y secretos ya resueltos.',
      'Aumenta el presupuesto de contexto para un modelo con ventana más amplia.',
      'Consolida hechos bloqueados redundantes en reglas más concisas.'
    );
  }

  // --- Capa F opcional: canon revelado, notas privadas del autor e hilos de memorias ---
  const revealedCanon = (canonNotes || []).filter((n) => n && n.visibility === 'revealed' && (n.projectId || 'original') === effectiveProject);
  const privateCanon = (canonNotes || []).filter((n) => n && n.visibility !== 'revealed' && (n.projectId || 'original') === effectiveProject);
  for (const n of revealedCanon) {
    tryPush(modelPayload.layers.F_permanent_canon.revealedCanon, { id: n.id, text: clip(n.text, 400) });
  }
  for (const n of privateCanon) {
    tryPush(modelPayload.layers.F_permanent_canon.privateAuthorCanon, { id: n.id, text: clip(n.text, 400), authorOnly: true });
  }
  for (const m of activeMemories.slice(-8)) {
    if (cleanString(m.openThreads)) {
      tryPush(modelPayload.layers.F_permanent_canon.openThreads, {
        kind: 'memory_open_thread',
        chapterOrder: m.chapterOrder,
        label: m.chapterTitle || `Cap. ${m.chapterOrder}`,
        text: clip(m.openThreads, 240),
      });
    }
  }

  // --- Capa A: Estado inmediato de escena ---
  const prevChapter = priorMainChapters.length ? priorMainChapters[priorMainChapters.length - 1] : null;
  const latestMemory = activeMemories.length ? activeMemories[activeMemories.length - 1] : null;
  if (prevChapter) {
    modelPayload.layers.A_immediate_scene.previousChapterId = prevChapter.id;
    modelPayload.layers.A_immediate_scene.previousChapterOrder = prevChapter.order ?? null;
    modelPayload.layers.A_immediate_scene.previousChapterTitle = prevChapter.title || '';
    const candidateEnding = String(prevChapter.content || '').slice(-1800);
    const remainingForEnding = Math.max(0, budgetCap - serializedLength(modelPayload) - 400);
    if (remainingForEnding > 120) {
      modelPayload.layers.A_immediate_scene.previousEndingExcerpt = candidateEnding.slice(-Math.min(candidateEnding.length, remainingForEnding));
    }
    explainability.push({
      layer: 'A_immediate_scene',
      sourceType: 'previous_chapter_ending',
      title: prevChapter.title || `Cap. ${prevChapter.order}`,
      chapterOrder: prevChapter.order,
      revision: contentFingerprint(prevChapter.content || ''),
      score: 95,
      matchedTerms: [],
      whyRetrieved: 'Cierre del capítulo inmediatamente anterior en la línea principal.',
    });
  }
  if (latestMemory?.physicalState && serializedLength(modelPayload) + 320 < budgetCap) {
    modelPayload.layers.A_immediate_scene.physicalState = clip(latestMemory.physicalState, 300);
  }
  if (latestMemory?.currentLocationTime && serializedLength(modelPayload) + 240 < budgetCap) {
    modelPayload.layers.A_immediate_scene.currentLocationTime = clip(latestMemory.currentLocationTime, 220);
  }

  // --- Capa D: Conocimiento epistémico individual compacto + relaciones cualitativas (contabilizados en el presupuesto real!) ---
  const queryTokens = [...new Set(tokenizeForBm25(query))];
  const rankedFacts = epistemic.authoritativeCanon.map((f) => {
    const fTokens = new Set(tokenizeForBm25(`${f.title} ${f.truth} ${f.sourceRef}`));
    const matched = queryTokens.filter((t) => fTokens.has(t));
    return { fact: f, matched, score: matched.length + (f.isSecret ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || (a.fact.firstEffectiveChapterOrder ?? 0) - (b.fact.firstEffectiveChapterOrder ?? 0));

  for (const item of rankedFacts.slice(0, 12)) {
    const compactFact = {
      id: item.fact.id,
      title: item.fact.title,
      truth: clip(item.fact.truth, 320),
      scope: item.fact.scope,
      layer: item.fact.layer,
      firstEffectiveChapterOrder: item.fact.firstEffectiveChapterOrder,
      disclosureConstraints: item.fact.disclosureConstraints,
    };
    if (tryPush(modelPayload.layers.D_character_epistemic_and_relationships.authoritativeFacts, compactFact)) {
      explainability.push({
        layer: 'D_character_epistemic_and_relationships',
        sourceType: 'knowledge_fact',
        title: item.fact.title,
        chapterOrder: item.fact.firstEffectiveChapterOrder,
        revision: item.fact.sourceChapterRevision || '',
        score: item.score,
        matchedTerms: item.matched,
        whyRetrieved: item.matched.length
          ? `Hecho epistémico activo coincidente en [${item.matched.join(', ')}] (capa=${item.fact.layer}).`
          : `Hecho epistémico activo relevante en este punto narrativo (capa=${item.fact.layer}).`,
      });
    }
  }

  for (const [cid, bucket] of Object.entries(epistemic.characterKnowledgeMap)) {
    const compactBucket = {
      characterId: cid,
      characterVersion: bucket.characterVersion,
      knows: bucket.knows.map((k) => ({
        factId: k.factId,
        title: k.title,
        beliefText: clip(k.beliefText, 200),
        experienceMode: k.experienceMode,
        deliberatelyConcealing: k.deliberatelyConcealing,
      })),
      suspects: bucket.suspects.map((s) => ({ factId: s.factId, title: s.title, beliefText: clip(s.beliefText, 180) })),
      believesFalse: bucket.believesFalse.map((b) => ({ factId: b.factId, title: b.title, beliefText: clip(b.beliefText, 180) })),
      blockedByLateArrival: bucket.blockedByLateArrival.map((b) => ({ factId: b.factId, title: b.title })),
    };
    modelPayload.layers.D_character_epistemic_and_relationships.characterKnowledgeMap[cid] = compactBucket;
    if (serializedLength(modelPayload) > budgetCap) {
      delete modelPayload.layers.D_character_epistemic_and_relationships.characterKnowledgeMap[cid];
      budgetWarnings.push({
        code: 'optional_epistemic_trimmed',
        level: 'info',
        message: `El mapa epistémico detallado de «${cid}» se omitió por límite de presupuesto serializado (${budgetCap} chars).`,
      });
    }
  }

  for (const rel of relState.authoritative.slice(0, 10)) {
    const compactRel = {
      id: rel.id,
      pairKey: rel.pairKey,
      label: rel.label,
      relationshipStage: rel.relationshipStage,
      dimensions: rel.dimensions,
      unresolvedDisagreements: rel.unresolvedDisagreements,
      behaviorChanges: rel.behaviorChanges,
      promises: rel.promises.map((p) => ({ text: p.text, status: p.status, chapterOrder: p.chapterOrder })),
    };
    if (tryPush(modelPayload.layers.D_character_epistemic_and_relationships.relationships, compactRel)) {
      explainability.push({
        layer: 'D_character_epistemic_and_relationships',
        sourceType: 'relationship_state',
        title: rel.label,
        chapterOrder: rel.activeSnapshotChapterOrder ?? rel.effectiveChapterOrder,
        revision: rel.sourceChapterRevision || '',
        score: 50,
        matchedTerms: [],
        whyRetrieved: `Estado emocional/relacional cualitativo vigente (${rel.relationshipStage || 'activo'}).`,
      });
    }
  }

  // --- Capa B: Continuidad de capítulos recientes ---
  const recentIds = new Set();
  for (const m of activeMemories.slice(-recentChapterCount)) {
    const ch = chaptersById.get(m.chapterId);
    const chOrder = ch?.order ?? m.chapterOrder ?? null;
    const compactMem = {
      id: m.id,
      chapterId: m.chapterId,
      chapterOrder: chOrder,
      chapterTitle: m.chapterTitle,
      events: clip(m.events || '', 480),
      relationshipChanges: clip(m.relationshipChanges || '', 300),
      whoKnowsWhat: clip(m.whoKnowsWhat || '', 300),
      openThreads: clip(m.openThreads || '', 240),
    };
    if (tryPush(modelPayload.layers.B_recent_continuity.recentMemories, compactMem)) {
      recentIds.add(m.chapterId);
      explainability.push({
        layer: 'B_recent_continuity',
        sourceType: 'chapter_memory',
        title: m.chapterTitle || `Cap. ${chOrder}`,
        chapterOrder: chOrder,
        revision: m.sourceChapterRevision || '',
        score: 85,
        matchedTerms: [],
        whyRetrieved: `Memoria reciente de los últimos ${recentChapterCount} capítulos principales.`,
      });
    }
  }

  // --- Capa C: Pasajes BM25 históricos, memorias episódicas antiguas y referencias ---
  for (const hit of bm25Hits) {
    const compactHit = {
      chapterId: hit.chapterId,
      chapterOrder: hit.chapterOrder,
      titleChapterNumber: hit.titleChapterNumber ?? null,
      chapterTitle: hit.chapterTitle,
      chapterRevision: hit.chapterRevision,
      excerpt: clip(hit.excerpt, 420),
      bm25Score: hit.bm25Score,
      matchedTerms: hit.matchedTerms,
      whyRetrieved: hit.whyRetrieved,
    };
    if (tryPush(modelPayload.layers.C_historical_episodic.historicalPassages, compactHit)) {
      explainability.push({
        layer: 'C_historical_episodic',
        sourceType: 'bm25_chapter_passage',
        title: `${hit.chapterTitle} (Cap. ${hit.titleChapterNumber ?? hit.chapterOrder})`,
        chapterOrder: hit.chapterOrder,
        revision: hit.chapterRevision,
        score: hit.bm25Score,
        matchedTerms: hit.matchedTerms,
        whyRetrieved: `Pasaje del manuscrito recuperado por BM25 (${hit.whyRetrieved}).`,
      });
    }
  }

  const olderMemories = activeMemories.filter((m) => !recentIds.has(m.chapterId));
  const scoredOlderMemories = olderMemories
    .map((m, idx) => {
      const ch = chaptersById.get(m.chapterId);
      const chOrder = ch?.order ?? m.chapterOrder ?? idx + 1;
      const rel = scoreMemoryRelevance(m, queryTokens);
      const isFoundation = idx < 2;
      return { m, chOrder, score: rel.score + (isFoundation ? 1.5 : 0), matchedTerms: rel.matchedTerms, isFoundation };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chOrder - b.chOrder)
    .slice(0, 6);

  for (const item of scoredOlderMemories) {
    const compactHist = {
      id: item.m.id,
      chapterId: item.m.chapterId,
      chapterOrder: item.chOrder,
      chapterTitle: item.m.chapterTitle,
      events: clip(item.m.events || '', 360),
      whoKnowsWhat: clip(item.m.whoKnowsWhat || '', 260),
      openThreads: clip(item.m.openThreads || '', 220),
    };
    if (tryPush(modelPayload.layers.C_historical_episodic.historicalMemories, compactHist)) {
      const why = item.matchedTerms.length
        ? `Memoria histórica coincidente por términos [${item.matchedTerms.join(', ')}]${item.isFoundation ? ' + capítulo fundacional' : ''}.`
        : 'Memoria fundacional de los primeros capítulos.';
      explainability.push({
        layer: 'C_historical_episodic',
        sourceType: 'historical_memory',
        title: item.m.chapterTitle || `Cap. ${item.chOrder}`,
        chapterOrder: item.chOrder,
        revision: item.m.sourceChapterRevision || '',
        score: Number(item.score.toFixed(2)),
        matchedTerms: item.matchedTerms,
        whyRetrieved: why,
      });
    }
  }

  for (const hit of docHits) {
    const compactDoc = {
      documentId: hit.documentId,
      filename: hit.filename,
      docType: hit.docType,
      excerpt: clip(hit.excerpt, 360),
      bm25Score: hit.bm25Score,
    };
    if (tryPush(modelPayload.layers.C_historical_episodic.referencePassages, compactDoc)) {
      explainability.push({
        layer: 'C_historical_episodic',
        sourceType: 'bm25_reference_chunk',
        title: `${hit.filename} [${hit.docType}]`,
        chapterOrder: null,
        revision: '',
        score: hit.bm25Score,
        matchedTerms: hit.matchedTerms,
        whyRetrieved: `Fragmento de referencia recuperado por BM25 (${hit.whyRetrieved}).`,
      });
    }
  }

  // --- Capa E: Resúmenes de arcos narrativos elegibles (solo pasados o vista histórica acotada!) ---
  for (const arc of eligibleArcs.slice(0, 8)) {
    const compactArc = {
      id: arc.id,
      arcOrder: arc.arcOrder,
      title: arc.title,
      startChapterOrder: arc.startChapterOrder,
      endChapterOrder: arc.endChapterOrder,
      synthesizedHistoricalSlice: Boolean(arc.synthesizedHistoricalSlice),
      isCompressedSummary: true,
      lossless: false,
      summary: clip(arc.summary, 480),
      preservedSecrets: (arc.preservedSecrets || []).map((s) => ({
        factId: s.factId,
        title: s.title,
        scope: s.scope,
        authorOnly: s.authorOnly,
        knownBy: s.knownBy,
        suspectedBy: s.suspectedBy,
        disclosureConstraints: s.disclosureConstraints,
      })),
      preservedPromises: (arc.preservedPromises || []).map((p) => ({ text: p.text, status: p.status, chapterOrder: p.chapterOrder })),
      openThreads: (arc.openThreads || []).slice(0, 6),
    };
    if (tryPush(modelPayload.layers.E_arc_summaries.arcSummaries, compactArc)) {
      explainability.push({
        layer: 'E_arc_summaries',
        sourceType: arc.synthesizedHistoricalSlice ? 'arc_historical_slice' : 'arc_summary',
        title: arc.title,
        chapterOrder: arc.endChapterOrder,
        revision: '',
        score: 40,
        matchedTerms: [],
        whyRetrieved: arc.synthesizedHistoricalSlice
          ? `Vista histórica acotada del arco (solo Caps. ${arc.startChapterOrder}–${arc.endChapterOrder}; contenido futuro excluido).`
          : `Resumen comprimido del arco (Caps. ${arc.startChapterOrder}–${arc.endChapterOrder}) con procedencia de secretos y promesas.`,
      });
    }
  }

  const actualSerializedChars = serializedLength(modelPayload);
  const estimatedTokens = Math.ceil(actualSerializedChars / 4);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const staleForReview = {
    memories: staleMemories,
    knowledgeFacts: epistemic.staleOrDisputedForReview,
    relationships: relState.staleForReview,
    arcSummaries: staleArcs,
    totalCount: staleMemories.length + epistemic.staleOrDisputedForReview.length + relState.staleForReview.length + staleArcs.length,
  };

  const budget = {
    maxTotalChars: budgetCap,
    actualSerializedChars,
    essentialChars,
    estimatedTokens,
    tokenEstimateNote: 'Estimación aproximada por caracteres (~4 chars/token); el conteo exacto por proveedor se integrará en el Hito 5.',
    overBudget: actualSerializedChars > budgetCap,
    warnings: budgetWarnings,
    suggestions: budgetSuggestions,
  };

  const inspectorDiagnostics = {
    explainability,
    staleForReview,
    futureContainingArcsExcluded,
    ambiguousTemporalExcluded: [
      ...epistemic.ambiguousTemporalExcluded,
      ...ambiguousArcsExcluded,
    ],
    alternativeSourcesExcluded: epistemic.alternativeExcluded,
    excludedReferencesByTimeline: partitionedRefs.excludedByTimeline,
    excludedReferencesByFandom: partitionedRefs.excludedByFandom,
    excludedStyleOnlyCount: partitionedRefs.styleOnlyDocuments.length,
    chapterIndexValidatedFresh: chIndexFresh,
  };

  return {
    projectId: effectiveProject,
    targetChapterOrder: effectiveTargetOrder,
    targetSceneOrder: targetSceneOrder ?? null,
    currentCheckpoint: cleanString(currentCheckpoint),
    characterVersion: epistemic.characterVersion,
    // Payload limpio y estrictamente presupuestado destinado al modelo en Hito 5:
    modelPayload,
    budget,
    // Diagnósticos exclusivos del Inspector (NO se envían al modelo):
    inspectorDiagnostics,
    // Alias de conveniencia para UI existente:
    layers: modelPayload.layers,
    explainability,
    staleForReview,
    stats: {
      totalChaptersIndexed: chIndex.totalDocs ? Object.keys(chIndex.chapterRevisions || {}).length : priorMainChapters.length,
      totalPassagesIndexed: chIndex.totalDocs || 0,
      totalCorpusWords,
      assembledChars: actualSerializedChars,
      essentialChars,
      approxTokens: estimatedTokens,
      budgetCapChars: budgetCap,
      overBudget: budget.overBudget,
      retrievalMs: Number((t1 - t0).toFixed(2)),
      futureExcludedCount: futureChaptersExcluded + epistemic.futureExcludedCount + futureContainingArcsExcluded.length,
      alternativeExcludedCount: alternativeExcludedCount + epistemic.alternativeExcludedCount,
      ambiguousExcludedCount: epistemic.ambiguousTemporalExcludedCount + ambiguousArcsExcluded.length,
      staleExcludedCount: staleForReview.totalCount,
    },
    engineIntegrationStatus: {
      connectedToGeneration: [
        'Hechos bloqueados y canon revelado/privado (canonGuard)',
        'Memorias de continuidad filtradas cronológicamente y excluyendo stale del canon autoritativo',
        'Aislamiento de capítulos alternativos y propagación atómica stale sin llamadas de pago',
      ],
      persistedAndInspectableAwaitingMilestone5PromptWiring: [
        'Libro epistémico temporal (knowledgeFacts + beliefHistoryByCharacter)',
        'Estado emocional/relacional cualitativo con historial (relationshipStates)',
        'Resúmenes de arcos narrativos con procedencia (arcSummaries)',
        'Índice léxico BM25 persistido y payload serializado de 6 capas (listo para Context Engine del Hito 5)',
      ],
    },
  };
}
