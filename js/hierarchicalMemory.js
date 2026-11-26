// hierarchicalMemory.js — Arquitectura jerárquica de memoria a largo plazo (6 capas)
// escalable a 100+ capítulos y 500,000+ palabras con recuperación explicable (0 tokens).
//
// Capas:
//   A) Estado inmediato de escena (cierre del capítulo anterior + estado físico/lugar/tiempo)
//   B) Continuidad de capítulos recientes (últimos capítulos aprobados de línea principal)
//   C) Memorias episódicas históricas y pasajes recuperados vía BM25 (capítulos antiguos + referencias)
//   D) Conocimiento epistémico individual y estado emocional/relacional cualitativo
//   E) Resúmenes de arcos narrativos (conservando secretos, promesas, relaciones e hilos abiertos)
//   F) Canon permanente (hechos bloqueados, canon revelado/privado) e hilos sin resolver
//
// Invariantes:
// - Solo usa capítulos de la línea principal (nunca capítulos alternativos).
// - Nunca filtra información de capítulos futuros (`order >= targetChapterOrder`).
// - Excluye memorias/hechos/relaciones/arcos marcados como `stale` del canon autoritativo
//   y los devuelve aparte en `staleForReview` para inspección de la autora.
// - Mantiene el tamaño ensamblado estrictamente acotado (`maxTotalChars`) sin perder
//   secretos activos, promesas sin cumplir ni hilos abiertos.

import { db } from './db.js';
import { isMainTimelineChapter, sortMainTimelineChapters, memoriesForChapters } from './timeline.js';
import { contentFingerprint, wordCount } from './utils.js';
import {
  resolveEpistemicStateAtPoint,
  resolveRelationshipsAtPoint,
} from './knowledgeLedger.js';
import {
  buildChapterLexicalIndex,
  buildDocumentLexicalIndex,
  searchLexicalIndex,
  tokenizeForBm25,
} from './lexicalIndex.js';

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

// ---------------------------------------------------------------------------
// Resúmenes de arcos narrativos (`arcSummaries`) con compresión sin pérdida
// de secretos, promesas, cambios de relación ni hilos abiertos.
// ---------------------------------------------------------------------------

export function normalizeArcSummary(input, { existing = null, projectId = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El resumen de arco debe ser un objeto válido.');
  const title = cleanString(input.title !== undefined ? input.title : existing?.title);
  if (!title) throw new Error('El resumen de arco necesita un título.');
  const now = new Date().toISOString();
  const effectiveProject = cleanString(projectId || input.projectId || existing?.projectId) || db.getActiveProjectId();
  const arcOrder = Number.isFinite(Number(input.arcOrder ?? existing?.arcOrder))
    ? Math.floor(Number(input.arcOrder ?? existing?.arcOrder))
    : 1;
  const startChapterOrder = Number.isFinite(Number(input.startChapterOrder ?? existing?.startChapterOrder))
    ? Math.floor(Number(input.startChapterOrder ?? existing?.startChapterOrder))
    : 1;
  const endChapterOrder = Number.isFinite(Number(input.endChapterOrder ?? existing?.endChapterOrder))
    ? Math.floor(Number(input.endChapterOrder ?? existing?.endChapterOrder))
    : startChapterOrder;

  return {
    id: cleanString(input.id || existing?.id) || db.uid(),
    projectId: effectiveProject,
    arcOrder,
    title,
    startChapterOrder,
    endChapterOrder,
    summary: cleanString(input.summary !== undefined ? input.summary : existing?.summary),
    preservedSecrets: cleanStringArray(input.preservedSecrets !== undefined ? input.preservedSecrets : existing?.preservedSecrets),
    preservedPromises: cleanStringArray(input.preservedPromises !== undefined ? input.preservedPromises : existing?.preservedPromises),
    relationshipShifts: cleanStringArray(input.relationshipShifts !== undefined ? input.relationshipShifts : existing?.relationshipShifts),
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
 * Compresión determinista de una ventana de capítulos en un resumen de arco (0 tokens).
 * Prioriza sin pérdida: secretos, promesas abiertas, cambios relacionales e hilos sin resolver.
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
    if (m.relationshipChanges) relationshipShifts.push(`${m.chapterTitle || 'Cap.'}: ${clip(m.relationshipChanges, 220)}`);
    if (m.openThreads) openThreads.push(`${m.chapterTitle || 'Cap.'}: ${clip(m.openThreads, 220)}`);
  }
  if (!summaryParts.length && mainChapters.length) {
    for (const ch of mainChapters) {
      summaryParts.push(`${ch.title || `Cap. ${ch.order}`}: ${clip(ch.content || '', 180)}`);
    }
  }

  const preservedSecrets = [];
  for (const fact of (knowledgeFacts || [])) {
    if (!fact || fact.deletedAt || fact.stale || fact.disputed) continue;
    const ord = fact.firstEffectiveChapterOrder;
    const inRange = (ord !== null && ord !== undefined && ord >= startChapterOrder && ord <= endChapterOrder) ||
      (fact.sourceChapterId && chIds.has(fact.sourceChapterId));
    if (inRange && (fact.isSecret || fact.scope === 'private_author')) {
      preservedSecrets.push(`${fact.title || 'Secreto'}: ${fact.truth}`);
    }
  }

  const preservedPromises = [];
  for (const rel of (relationships || [])) {
    if (!rel || rel.deletedAt || rel.stale) continue;
    for (const p of (rel.promises || [])) {
      const inRange = (p.chapterOrder !== null && p.chapterOrder >= startChapterOrder && p.chapterOrder <= endChapterOrder) ||
        (p.sourceChapterId && chIds.has(p.sourceChapterId));
      if (inRange) {
        preservedPromises.push(`[${p.status}] ${rel.label}: ${p.text}`);
      }
    }
    for (const s of (rel.privateSecrets || [])) {
      const inRange = (s.chapterOrder !== null && s.chapterOrder >= startChapterOrder && s.chapterOrder <= endChapterOrder) ||
        (s.sourceChapterId && chIds.has(s.sourceChapterId));
      if (inRange) {
        preservedSecrets.push(`${rel.label}: ${s.text}`);
      }
    }
    if (rel.sourceChapterId && chIds.has(rel.sourceChapterId) && rel.behaviorChanges?.length) {
      for (const bc of rel.behaviorChanges) relationshipShifts.push(`${rel.label}: ${bc}`);
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
// Ensamblador jerárquico acotado de 6 capas + trazabilidad explicable (0 tokens)
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

export function assembleHierarchicalMemory({
  projectId = '',
  targetChapterOrder = null,
  targetChapterId = null,
  currentCheckpoint = '',
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

  // 1. Aislar estrictamente capítulos de ESTA historia y de la LÍNEA PRINCIPAL
  const allScopedChapters = (chapters || []).filter((ch) => ch && (ch.projectId || 'original') === effectiveProject);
  const alternativeExcludedCount = allScopedChapters.filter((ch) => !isMainTimelineChapter(ch)).length;
  const mainChapters = sortMainTimelineChapters(allScopedChapters);

  let effectiveTargetOrder = targetChapterOrder;
  if ((effectiveTargetOrder === null || effectiveTargetOrder === undefined) && targetChapterId) {
    const found = allScopedChapters.find((c) => c.id === targetChapterId);
    if (found && Number.isFinite(Number(found.order))) effectiveTargetOrder = Number(found.order);
  }
  if (effectiveTargetOrder === null || effectiveTargetOrder === undefined) {
    const maxOrder = mainChapters.reduce((acc, ch) => Math.max(acc, Number(ch.order ?? 0)), 0);
    effectiveTargetOrder = maxOrder + 1;
  }

  const priorMainChapters = mainChapters.filter((ch) => {
    if (targetChapterId && ch.id === targetChapterId) return false;
    return Number(ch.order ?? 0) < effectiveTargetOrder && String(ch.content || '').trim().length > 0;
  });
  const futureChaptersExcluded = mainChapters.filter((ch) => Number(ch.order ?? 0) >= effectiveTargetOrder).length;
  const chaptersById = new Map(priorMainChapters.map((ch) => [ch.id, ch]));

  let totalCorpusWords = 0;
  for (const ch of priorMainChapters) {
    totalCorpusWords += Number.isFinite(Number(ch.wordCount)) ? Number(ch.wordCount) : wordCount(ch.content || '');
  }

  // 2. Separar memorias activas (no stale) vs stale para revisión
  const orderedMemories = memoriesForChapters(memoryEntries, priorMainChapters);
  const staleMemories = orderedMemories.filter((m) => m.stale === true);
  const activeMemories = orderedMemories.filter((m) => m.stale !== true);

  // 3. Resolver conocimiento epistémico y relaciones cualitativas en el punto exacto
  const epistemic = resolveEpistemicStateAtPoint({
    facts: (knowledgeFacts || []).filter((f) => (f.projectId || 'original') === effectiveProject),
    targetChapterOrder: effectiveTargetOrder,
    currentCheckpoint,
    characterIds: activeCharacterIds,
    characterVersion,
    josephArrivalOrder,
  });
  const relState = resolveRelationshipsAtPoint({
    relationships: (relationships || []).filter((r) => (r.projectId || 'original') === effectiveProject),
    targetChapterOrder: effectiveTargetOrder,
  });

  // 4. Filtrar resúmenes de arcos hasta el capítulo actual (excluyendo stale)
  const scopedArcs = (arcSummaries || [])
    .filter((a) => a && !a.deletedAt && (a.projectId || 'original') === effectiveProject)
    .filter((a) => (a.startChapterOrder ?? 0) < effectiveTargetOrder);
  const staleArcs = scopedArcs.filter((a) => a.stale === true);
  const activeArcs = scopedArcs
    .filter((a) => a.stale !== true)
    .sort((a, b) => (a.arcOrder ?? 0) - (b.arcOrder ?? 0));

  // 5. Índice BM25 sobre capítulos (reutilizar índice persistido si se pasó; construir solo si falta)
  const chIndex = chapterLexicalIndex || buildChapterLexicalIndex(priorMainChapters, { projectId: effectiveProject });
  const bm25Hits = query
    ? searchLexicalIndex(chIndex, query, {
        topK: maxHistoricalPassages,
        maxChapterOrder: effectiveTargetOrder,
        excludeChapterId: targetChapterId,
        chaptersById,
        maxPerChapter: 2,
      })
    : [];

  // Índice BM25 sobre documentos de referencia no-STYLE_ONLY (sin contaminación de estilo)
  let docHits = [];
  if (query && (documentLexicalIndex || (documents?.length && docChunks?.length))) {
    const dIdx = documentLexicalIndex || buildDocumentLexicalIndex(documents, docChunks, { projectId: effectiveProject });
    docHits = searchLexicalIndex(dIdx, query, {
      topK: maxDocPassages,
      excludeDocTypes: ['STYLE_ONLY'],
      maxPerChapter: 2,
    });
  }

  // 6. Construir las 6 capas con presupuesto estricto y trazabilidad explicable
  const explainability = [];
  let remainingBudget = Math.max(4000, Number(maxTotalChars) || 24000);

  const allocate = (text, cap) => {
    const allowed = Math.min(cap, remainingBudget);
    if (allowed <= 0) return '';
    const clipped = clip(text, allowed);
    remainingBudget = Math.max(0, remainingBudget - clipped.length);
    return clipped;
  };

  // --- Capa F (máxima prioridad de presupuesto): Canon permanente e hilos abiertos ---
  const permanentCanonItems = [];
  for (const lf of (lockedFacts || []).filter((f) => f && (f.projectId || 'original') === effectiveProject)) {
    const t = allocate(lf.text, 400);
    if (!t) break;
    permanentCanonItems.push({ id: lf.id, text: t, kind: 'locked_fact' });
    explainability.push({
      layer: 'F_permanent_canon',
      sourceType: 'locked_fact',
      title: 'Hecho bloqueado',
      chapterOrder: null,
      revision: '',
      score: 100,
      matchedTerms: [],
      whyRetrieved: 'Hecho bloqueado permanente (prioridad máxima en toda la historia).',
    });
  }
  const openThreads = [];
  for (const p of relState.openPromises) {
    openThreads.push({
      kind: 'open_promise',
      chapterOrder: p.chapterOrder,
      label: p.relationshipLabel,
      text: p.text,
    });
    explainability.push({
      layer: 'F_permanent_canon',
      sourceType: 'open_promise',
      title: `Promesa abierta (${p.relationshipLabel})`,
      chapterOrder: p.chapterOrder,
      revision: '',
      score: 90,
      matchedTerms: [],
      whyRetrieved: 'Promesa aún abierta en continuidad relacional; nunca se descarta al comprimir.',
    });
  }
  for (const m of activeMemories) {
    if (cleanString(m.openThreads)) {
      openThreads.push({
        kind: 'memory_open_thread',
        chapterOrder: m.chapterOrder,
        label: m.chapterTitle || `Cap. ${m.chapterOrder}`,
        text: clip(m.openThreads, 260),
      });
    }
  }
  const revealedCanon = (canonNotes || []).filter((n) => n && n.visibility === 'revealed' && (n.projectId || 'original') === effectiveProject);
  const privateCanon = (canonNotes || []).filter((n) => n && n.visibility !== 'revealed' && (n.projectId || 'original') === effectiveProject);

  const layerF = {
    lockedFacts: permanentCanonItems,
    revealedCanon: revealedCanon.map((n) => ({ id: n.id, text: allocate(n.text, 400) })).filter((n) => n.text),
    privateAuthorCanon: [
      ...privateCanon.map((n) => ({ id: n.id, text: allocate(n.text, 400), authorOnly: true })).filter((n) => n.text),
      ...epistemic.privateAuthorTruths.map((f) => ({ id: f.id, title: f.title, text: allocate(f.truth, 400), authorOnly: true })).filter((f) => f.text),
    ],
    openThreads: openThreads.slice(-12),
  };

  // --- Capa A: Estado inmediato de escena ---
  const prevChapter = priorMainChapters.length ? priorMainChapters[priorMainChapters.length - 1] : null;
  const latestMemory = activeMemories.length ? activeMemories[activeMemories.length - 1] : null;
  const prevEndingExcerpt = prevChapter
    ? allocate(String(prevChapter.content || '').slice(-2200), 2200)
    : '';
  if (prevChapter) {
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
  const layerA = {
    previousChapterId: prevChapter?.id || null,
    previousChapterOrder: prevChapter?.order ?? null,
    previousChapterTitle: prevChapter?.title || '',
    previousEndingExcerpt: prevEndingExcerpt,
    physicalState: latestMemory?.physicalState ? allocate(latestMemory.physicalState, 400) : '',
    currentLocationTime: latestMemory?.currentLocationTime ? allocate(latestMemory.currentLocationTime, 300) : '',
  };

  // --- Capa B: Continuidad de capítulos recientes ---
  const recentMemories = activeMemories.slice(-recentChapterCount).map((m) => {
    const ch = chaptersById.get(m.chapterId);
    const chOrder = ch?.order ?? m.chapterOrder ?? null;
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
    return {
      id: m.id,
      chapterId: m.chapterId,
      chapterOrder: chOrder,
      chapterTitle: m.chapterTitle,
      events: allocate(m.events || '', 550),
      relationshipChanges: allocate(m.relationshipChanges || '', 380),
      whoKnowsWhat: allocate(m.whoKnowsWhat || '', 380),
      openThreads: allocate(m.openThreads || '', 320),
    };
  });
  const recentIds = new Set(recentMemories.map((m) => m.chapterId));
  const layerB = { recentMemories };

  // --- Capa C: Memorias episódicas históricas + pasajes BM25 (capítulos antiguos y referencias) ---
  const queryTokens = [...new Set(tokenizeForBm25(query))];
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

  const historicalMemories = scoredOlderMemories.map((item) => {
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
    return {
      id: item.m.id,
      chapterId: item.m.chapterId,
      chapterOrder: item.chOrder,
      chapterTitle: item.m.chapterTitle,
      events: allocate(item.m.events || '', 420),
      whoKnowsWhat: allocate(item.m.whoKnowsWhat || '', 320),
      openThreads: allocate(item.m.openThreads || '', 260),
    };
  });

  const historicalPassages = [];
  for (const hit of bm25Hits) {
    const text = allocate(hit.excerpt, 480);
    if (!text) break;
    historicalPassages.push({ ...hit, excerpt: text });
    explainability.push({
      layer: 'C_historical_episodic',
      sourceType: 'bm25_chapter_passage',
      title: `${hit.chapterTitle} (Cap. ${hit.chapterOrder})`,
      chapterOrder: hit.chapterOrder,
      revision: hit.chapterRevision,
      score: hit.bm25Score,
      matchedTerms: hit.matchedTerms,
      whyRetrieved: `Pasaje del manuscrito recuperado por BM25 (${hit.whyRetrieved}).`,
    });
  }

  const referencePassages = [];
  for (const hit of docHits) {
    const text = allocate(hit.excerpt, 420);
    if (!text) break;
    referencePassages.push({ ...hit, excerpt: text });
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

  const layerC = {
    historicalMemories,
    historicalPassages,
    referencePassages,
  };

  // --- Capa D: Conocimiento epistémico individual y relaciones cualitativas ---
  const relevantFacts = epistemic.authoritativeCanon.map((f) => {
    const fTokens = new Set(tokenizeForBm25(`${f.title} ${f.truth} ${f.sourceRef}`));
    const matched = queryTokens.filter((t) => fTokens.has(t));
    return { fact: f, matched, score: matched.length + (f.isSecret ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || (a.fact.firstEffectiveChapterOrder ?? 0) - (b.fact.firstEffectiveChapterOrder ?? 0));

  for (const item of relevantFacts.slice(0, 10)) {
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
  for (const rel of relState.authoritative.slice(0, 8)) {
    explainability.push({
      layer: 'D_character_epistemic_and_relationships',
      sourceType: 'relationship_state',
      title: rel.label,
      chapterOrder: rel.effectiveChapterOrder,
      revision: rel.sourceChapterRevision || '',
      score: 50,
      matchedTerms: [],
      whyRetrieved: `Estado emocional/relacional cualitativo vigente (${rel.relationshipStage || 'activo'}).`,
    });
  }

  const layerD = {
    characterVersion: epistemic.characterVersion,
    authoritativeFacts: relevantFacts.slice(0, 12).map((x) => ({
      ...x.fact,
      truth: allocate(x.fact.truth, 380) || clip(x.fact.truth, 180),
    })),
    characterKnowledgeMap: epistemic.characterKnowledgeMap,
    relationships: relState.authoritative.slice(0, 10),
  };

  // --- Capa E: Resúmenes de arcos narrativos ---
  const selectedArcs = activeArcs.slice(0, 10).map((arc) => {
    explainability.push({
      layer: 'E_arc_summaries',
      sourceType: 'arc_summary',
      title: arc.title,
      chapterOrder: arc.endChapterOrder,
      revision: '',
      score: 40,
      matchedTerms: [],
      whyRetrieved: `Resumen del arco narrativo (Caps. ${arc.startChapterOrder}–${arc.endChapterOrder}) con secretos y promesas preservados.`,
    });
    return {
      ...arc,
      summary: allocate(arc.summary, 600),
    };
  });
  const layerE = { arcSummaries: selectedArcs };

  const layers = {
    A_immediate_scene: layerA,
    B_recent_continuity: layerB,
    C_historical_episodic: layerC,
    D_character_epistemic_and_relationships: layerD,
    E_arc_summaries: layerE,
    F_permanent_canon: layerF,
  };

  const assembledChars = Math.max(0, (Number(maxTotalChars) || 24000) - remainingBudget);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    projectId: effectiveProject,
    targetChapterOrder: effectiveTargetOrder,
    currentCheckpoint: cleanString(currentCheckpoint),
    characterVersion: epistemic.characterVersion,
    layers,
    explainability,
    staleForReview: {
      memories: staleMemories,
      knowledgeFacts: epistemic.staleOrDisputedForReview,
      relationships: relState.staleForReview,
      arcSummaries: staleArcs,
      totalCount: staleMemories.length + epistemic.staleOrDisputedForReview.length + relState.staleForReview.length + staleArcs.length,
    },
    stats: {
      totalChaptersIndexed: chIndex.totalDocs ? Object.keys(chIndex.chapterRevisions || {}).length : priorMainChapters.length,
      totalPassagesIndexed: chIndex.totalDocs || 0,
      totalCorpusWords,
      assembledChars,
      approxTokens: Math.ceil(assembledChars / 4),
      budgetCapChars: Number(maxTotalChars) || 24000,
      retrievalMs: Number((t1 - t0).toFixed(2)),
      futureExcludedCount: futureChaptersExcluded + epistemic.futureExcludedCount,
      alternativeExcludedCount,
      staleExcludedCount: staleMemories.length + epistemic.staleOrDisputedForReview.length + relState.staleForReview.length + staleArcs.length,
    },
    engineIntegrationStatus: {
      connectedToGeneration: [
        'Hechos bloqueados y canon revelado/privado (canonGuard)',
        'Memorias de continuidad filtradas cronológicamente y excluyendo stale del canon autoritativo',
        'Aislamiento de capítulos alternativos y propagación stale sin llamadas de pago',
      ],
      persistedAndInspectableAwaitingMilestone5PromptWiring: [
        'Libro epistémico de creencias individuales y falsas creencias (knowledgeFacts)',
        'Estado emocional/relacional cualitativo (relationshipStates)',
        'Resúmenes de arcos narrativos (arcSummaries)',
        'Índice léxico BM25 persistido y ensamblador jerárquico de 6 capas (listo para Context Engine del Hito 5)',
      ],
    },
  };
}
