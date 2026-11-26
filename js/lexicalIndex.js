// lexicalIndex.js — Índice léxico BM25 persistido en IndexedDB (0 tokens, sin embeddings
// ni bases vectoriales de pago), diseñado para escalar a 100+ capítulos y 500,000+ palabras.
//
// Reglas fundamentales:
// - Solo indexa capítulos de la línea principal (`isMainTimelineChapter`): los capítulos
//   alternativos NUNCA contaminan el índice de continuidad principal.
// - Reutiliza la lógica exacta de numeración por título y prólogo de `storyRecall.js`
//   (español e inglés, números saltados, capítulos renombrados o reordenados).
// - Valida revisiones de capítulos y firmas de documentos antes de consumir un índice
//   persistido: los documentos inactivos, modificados o eliminados nunca se sirven desde
//   un índice obsoleto.
// - Los índices son datos derivados y reconstruibles desde las fuentes aprobadas.

import { db } from './db.js';
import { isMainTimelineChapter, sortMainTimelineChapters } from './timeline.js';
import { contentFingerprint } from './utils.js';
import {
  requestedChapterNumbers,
  isPrologueTitle,
  chapterNumberFromTitle,
  requestsPrologue,
} from './storyRecall.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const TARGET_PASSAGE_CHARS = 1500;
const EXCERPT_MAX_CHARS = 420;

const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'were', 'was', 'are', 'but',
  'not', 'you', 'your', 'his', 'her', 'she', 'him', 'they', 'them', 'their', 'what', 'when',
  'where', 'which', 'who', 'will', 'would', 'could', 'should', 'into', 'onto', 'over', 'under',
  'about', 'after', 'before', 'then', 'than', 'there', 'here', 'been', 'being', 'had', 'has',
  'did', 'does', 'doing', 'done', 'just', 'only', 'also', 'very', 'more', 'most', 'some',
  'such', 'like', 'back', 'down', 'out', 'off', 'all', 'any', 'each', 'few', 'own', 'same',
  'too', 'can', 'now', 'still', 'even', 'much', 'through', 'while', 'because', 'until',
  // Spanish
  'los', 'las', 'una', 'uno', 'unos', 'unas', 'del', 'con', 'por', 'para', 'como', 'pero',
  'mas', 'más', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'donde', 'cuando', 'quien', 'cual',
  'que', 'qué', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel',
  'ella', 'ellos', 'ellas', 'nosotros', 'ustedes', 'todo', 'toda', 'todos', 'todas', 'muy',
  'tambien', 'también', 'solo', 'sólo', 'habia', 'había', 'estaba', 'estaban', 'fueron',
  'eran', 'tiene', 'tienen', 'tenia', 'tenía', 'puede', 'pueden', 'hacer', 'hacia', 'hizo',
  'algo', 'nada', 'otro', 'otra', 'otros', 'otras', 'cada', 'mismo', 'misma', 'porque',
  'aunque', 'mientras', 'despues', 'después', 'antes', 'ahora', 'aqui', 'aquí', 'alli', 'allí',
]);

export function tokenizeForBm25(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  const rawTokens = normalized.split(/\s+/);
  const out = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i];
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

export function extractExactChapterNumber(query) {
  const nums = [...requestedChapterNumbers(query)];
  return nums.length ? nums[0] : null;
}

/**
 * Anota los capítulos de la línea principal con numeración consciente de prólogos y
 * títulos explícitos (EN/ES), igual que `storyRecall.js`.
 */
export function annotateMainChaptersNumbering(chapters) {
  const ordered = sortMainTimelineChapters(chapters).filter((ch) => String(ch?.content || '').trim());
  let numberedPos = 0;
  const annotated = ordered.map((chapter, timelineRank) => {
    const prologue = isPrologueTitle(chapter.title);
    const titleNum = chapterNumberFromTitle(chapter.title);
    if (!prologue) numberedPos += 1;
    return {
      chapter,
      timelineRank,
      isPrologue: prologue,
      titleChapterNumber: titleNum,
      fallbackChapterNumber: prologue ? null : numberedPos,
    };
  });
  return annotated;
}

export function segmentChapterPassages(chapter, {
  targetChars = TARGET_PASSAGE_CHARS,
  isPrologue = null,
  titleChapterNumber = undefined,
  fallbackChapterNumber = null,
  timelineRank = null,
} = {}) {
  const content = String(chapter?.content || '').trim();
  if (!content) return [];
  const paragraphs = content.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const passages = [];
  let buf = '';

  const flush = () => {
    const trimmed = buf.trim();
    if (!trimmed) return;
    passages.push(trimmed);
    buf = '';
  };

  for (const para of paragraphs) {
    if (para.length > targetChars * 1.4) {
      flush();
      for (let i = 0; i < para.length; i += targetChars) {
        passages.push(para.slice(i, i + targetChars).trim());
      }
      continue;
    }
    if (buf && (buf.length + para.length + 2) > targetChars) {
      flush();
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();

  const rev = contentFingerprint(content);
  const order = Number.isFinite(Number(chapter.order)) ? Number(chapter.order) : 0;
  const resolvedPrologue = isPrologue !== null ? Boolean(isPrologue) : isPrologueTitle(chapter.title);
  const resolvedTitleNum = titleChapterNumber !== undefined ? titleChapterNumber : chapterNumberFromTitle(chapter.title);

  return passages.map((text, passageIndex) => ({
    docId: `${chapter.id}#p${passageIndex}`,
    chapterId: chapter.id,
    chapterOrder: order,
    timelineRank,
    isPrologue: resolvedPrologue,
    titleChapterNumber: resolvedTitleNum,
    fallbackChapterNumber,
    chapterTitle: String(chapter.title || `Capítulo ${order}`),
    chapterRevision: rev,
    passageIndex,
    text,
    excerpt: text.length <= EXCERPT_MAX_CHARS ? text : `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…`,
  }));
}

function buildInvertedFromDocs(rawDocs, { id, projectId, kind, chapterRevisions = {}, documentSignatures = {} }) {
  const docs = [];
  const postingsMap = new Map();
  let totalLength = 0;

  for (let docIdx = 0; docIdx < rawDocs.length; docIdx += 1) {
    const item = rawDocs[docIdx];
    const tokens = tokenizeForBm25(`${item.chapterTitle || item.filename || ''} ${item.text || ''}`);
    const dl = tokens.length;
    totalLength += dl;

    const tfMap = new Map();
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      tfMap.set(t, (tfMap.get(t) || 0) + 1);
    }

    for (const [term, tf] of tfMap.entries()) {
      let arr = postingsMap.get(term);
      if (!arr) {
        arr = [];
        postingsMap.set(term, arr);
      }
      arr.push(docIdx, tf);
    }

    docs.push({
      docId: item.docId,
      chapterId: item.chapterId || null,
      chapterOrder: item.chapterOrder ?? null,
      timelineRank: item.timelineRank ?? null,
      isPrologue: Boolean(item.isPrologue),
      titleChapterNumber: item.titleChapterNumber ?? null,
      fallbackChapterNumber: item.fallbackChapterNumber ?? null,
      chapterTitle: item.chapterTitle || '',
      chapterRevision: item.chapterRevision || '',
      documentId: item.documentId || null,
      filename: item.filename || '',
      docType: item.docType || '',
      passageIndex: item.passageIndex ?? 0,
      dl,
      excerpt: item.excerpt || '',
    });
  }

  const df = {};
  const postings = {};
  for (const [term, arr] of postingsMap.entries()) {
    df[term] = arr.length / 2;
    postings[term] = arr;
  }

  return {
    id,
    projectId,
    kind,
    schemaVersion: 2,
    totalDocs: docs.length,
    avgdl: docs.length ? totalLength / docs.length : 0,
    chapterRevisions,
    documentSignatures,
    docs,
    df,
    postings,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Construye un índice BM25 en memoria para los capítulos de la línea principal.
 * Excluye estrictamente capítulos alternativos (`branchRole === 'alternative'`).
 */
export function buildChapterLexicalIndex(chapters, { projectId = '' } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const annotated = annotateMainChaptersNumbering(chapters);

  const rawDocs = [];
  const chapterRevisions = {};
  for (const entry of annotated) {
    const ch = entry.chapter;
    const rev = contentFingerprint(ch.content);
    chapterRevisions[ch.id] = {
      rev,
      order: Number.isFinite(Number(ch.order)) ? Number(ch.order) : 0,
      timelineRank: entry.timelineRank,
      title: String(ch.title || ''),
      isPrologue: entry.isPrologue,
      titleChapterNumber: entry.titleChapterNumber,
      fallbackChapterNumber: entry.fallbackChapterNumber,
    };
    const passages = segmentChapterPassages(ch, {
      isPrologue: entry.isPrologue,
      titleChapterNumber: entry.titleChapterNumber,
      fallbackChapterNumber: entry.fallbackChapterNumber,
      timelineRank: entry.timelineRank,
    });
    for (const p of passages) rawDocs.push(p);
  }

  return buildInvertedFromDocs(rawDocs, {
    id: `${effectiveProject}::chapters`,
    projectId: effectiveProject,
    kind: 'chapters',
    chapterRevisions,
  });
}

/**
 * Valida si un índice persistido de capítulos coincide exactamente con las revisiones,
 * títulos, orden y membresía de la línea principal actual.
 */
export function isChapterLexicalIndexFresh(existingIndex, chapters) {
  if (!existingIndex || existingIndex.schemaVersion !== 2 || !existingIndex.chapterRevisions) return false;
  const annotated = annotateMainChaptersNumbering(chapters);
  const prevRevs = existingIndex.chapterRevisions;
  if (Object.keys(prevRevs).length !== annotated.length) return false;
  for (const entry of annotated) {
    const ch = entry.chapter;
    const prev = prevRevs[ch.id];
    if (!prev) return false;
    const rev = contentFingerprint(ch.content);
    const order = Number.isFinite(Number(ch.order)) ? Number(ch.order) : 0;
    if (
      prev.rev !== rev ||
      prev.order !== order ||
      prev.timelineRank !== entry.timelineRank ||
      prev.title !== String(ch.title || '') ||
      prev.titleChapterNumber !== entry.titleChapterNumber ||
      prev.fallbackChapterNumber !== entry.fallbackChapterNumber
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Actualiza incrementalmente un índice existente cuando cambian algunos capítulos,
 * evitando retokenizar capítulos sin cambios mientras mantiene metadatos de orden y
 * numeración exactamente sincronizados.
 */
export function updateChapterLexicalIndexIncremental(existingIndex, chapters, { projectId = '' } = {}) {
  const effectiveProject = projectId || existingIndex?.projectId || db.getActiveProjectId();
  const annotated = annotateMainChaptersNumbering(chapters);

  if (!existingIndex || existingIndex.schemaVersion !== 2 || !Array.isArray(existingIndex.docs) || !existingIndex.chapterRevisions) {
    return { index: buildChapterLexicalIndex(chapters, { projectId: effectiveProject }), rebuilt: true, changedChapterIds: annotated.map((a) => a.chapter.id) };
  }

  const prevRevs = existingIndex.chapterRevisions;
  const nextRevs = {};
  const annotatedById = new Map();
  const contentChangedIds = new Set();
  const metaChangedIds = new Set();
  const currentIds = new Set();

  for (const entry of annotated) {
    const ch = entry.chapter;
    currentIds.add(ch.id);
    annotatedById.set(ch.id, entry);
    const rev = contentFingerprint(ch.content);
    const order = Number.isFinite(Number(ch.order)) ? Number(ch.order) : 0;
    const title = String(ch.title || '');
    nextRevs[ch.id] = {
      rev,
      order,
      timelineRank: entry.timelineRank,
      title,
      isPrologue: entry.isPrologue,
      titleChapterNumber: entry.titleChapterNumber,
      fallbackChapterNumber: entry.fallbackChapterNumber,
    };
    const prev = prevRevs[ch.id];
    if (!prev || prev.rev !== rev || prev.title !== title) {
      contentChangedIds.add(ch.id);
    } else if (
      prev.order !== order ||
      prev.timelineRank !== entry.timelineRank ||
      prev.titleChapterNumber !== entry.titleChapterNumber ||
      prev.fallbackChapterNumber !== entry.fallbackChapterNumber
    ) {
      metaChangedIds.add(ch.id);
    }
  }
  const removedIds = new Set(Object.keys(prevRevs).filter((id) => !currentIds.has(id)));

  if (contentChangedIds.size === 0 && metaChangedIds.size === 0 && removedIds.size === 0) {
    return { index: existingIndex, rebuilt: false, changedChapterIds: [] };
  }

  const oldDocs = existingIndex.docs;
  const oldPostings = existingIndex.postings || {};
  const keptOldIdxToNewIdx = new Map();
  const newDocs = [];

  for (let i = 0; i < oldDocs.length; i += 1) {
    const d = oldDocs[i];
    if (removedIds.has(d.chapterId) || contentChangedIds.has(d.chapterId)) continue;
    keptOldIdxToNewIdx.set(i, newDocs.length);
    const meta = annotatedById.get(d.chapterId);
    newDocs.push(meta ? {
      ...d,
      chapterOrder: Number.isFinite(Number(meta.chapter.order)) ? Number(meta.chapter.order) : 0,
      timelineRank: meta.timelineRank,
      isPrologue: meta.isPrologue,
      titleChapterNumber: meta.titleChapterNumber,
      fallbackChapterNumber: meta.fallbackChapterNumber,
    } : d);
  }

  const nextPostingsMap = new Map();
  for (const [term, arr] of Object.entries(oldPostings)) {
    const filtered = [];
    for (let j = 0; j < arr.length; j += 2) {
      const mappedIdx = keptOldIdxToNewIdx.get(arr[j]);
      if (mappedIdx !== undefined) {
        filtered.push(mappedIdx, arr[j + 1]);
      }
    }
    if (filtered.length) nextPostingsMap.set(term, filtered);
  }

  // Tokenizar únicamente los capítulos cuyo contenido o título cambió
  for (const entry of annotated) {
    const ch = entry.chapter;
    if (!contentChangedIds.has(ch.id)) continue;
    const passages = segmentChapterPassages(ch, {
      isPrologue: entry.isPrologue,
      titleChapterNumber: entry.titleChapterNumber,
      fallbackChapterNumber: entry.fallbackChapterNumber,
      timelineRank: entry.timelineRank,
    });
    for (const item of passages) {
      const docIdx = newDocs.length;
      const tokens = tokenizeForBm25(`${item.chapterTitle} ${item.text}`);
      const tfMap = new Map();
      for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i];
        tfMap.set(t, (tfMap.get(t) || 0) + 1);
      }
      for (const [term, tf] of tfMap.entries()) {
        let arr = nextPostingsMap.get(term);
        if (!arr) {
          arr = [];
          nextPostingsMap.set(term, arr);
        }
        arr.push(docIdx, tf);
      }
      newDocs.push({
        docId: item.docId,
        chapterId: item.chapterId,
        chapterOrder: item.chapterOrder,
        timelineRank: item.timelineRank,
        isPrologue: item.isPrologue,
        titleChapterNumber: item.titleChapterNumber,
        fallbackChapterNumber: item.fallbackChapterNumber,
        chapterTitle: item.chapterTitle,
        chapterRevision: item.chapterRevision,
        documentId: null,
        filename: '',
        docType: '',
        passageIndex: item.passageIndex,
        dl: tokens.length,
        excerpt: item.excerpt,
      });
    }
  }

  let totalLength = 0;
  for (let i = 0; i < newDocs.length; i += 1) totalLength += newDocs[i].dl;
  const df = {};
  const postings = {};
  for (const [term, arr] of nextPostingsMap.entries()) {
    df[term] = arr.length / 2;
    postings[term] = arr;
  }

  return {
    index: {
      id: `${effectiveProject}::chapters`,
      projectId: effectiveProject,
      kind: 'chapters',
      schemaVersion: 2,
      totalDocs: newDocs.length,
      avgdl: newDocs.length ? totalLength / newDocs.length : 0,
      chapterRevisions: nextRevs,
      documentSignatures: {},
      docs: newDocs,
      df,
      postings,
      updatedAt: new Date().toISOString(),
    },
    rebuilt: true,
    changedChapterIds: [...new Set([...contentChangedIds, ...metaChangedIds, ...removedIds])],
  };
}

function computeDocumentSignatures(documents, docChunks) {
  const chunksByDoc = new Map();
  for (const c of (docChunks || [])) {
    if (!c?.documentId) continue;
    (chunksByDoc.get(c.documentId) || chunksByDoc.set(c.documentId, []).get(c.documentId)).push(c);
  }
  const sigs = {};
  for (const doc of (documents || [])) {
    if (!doc?.id || doc.active === false) continue;
    const chunks = (chunksByDoc.get(doc.id) || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const joined = chunks.map((c) => `${c.id}:${contentFingerprint(c.text || '')}`).join('|');
    sigs[doc.id] = {
      filename: String(doc.filename || ''),
      type: String(doc.type || 'REFERENCE'),
      active: doc.active !== false,
      chunkCount: chunks.length,
      chunkHash: contentFingerprint(joined),
    };
  }
  return sigs;
}

export function isDocumentLexicalIndexFresh(existingIndex, documents, docChunks) {
  if (!existingIndex || existingIndex.schemaVersion !== 2 || !existingIndex.documentSignatures) return false;
  const currentSigs = computeDocumentSignatures(documents, docChunks);
  const prevSigs = existingIndex.documentSignatures;
  const curKeys = Object.keys(currentSigs);
  if (curKeys.length !== Object.keys(prevSigs).length) return false;
  for (const id of curKeys) {
    const cur = currentSigs[id];
    const prev = prevSigs[id];
    if (!prev || prev.filename !== cur.filename || prev.type !== cur.type || prev.active !== cur.active || prev.chunkCount !== cur.chunkCount || prev.chunkHash !== cur.chunkHash) {
      return false;
    }
  }
  return true;
}

/**
 * Construye un índice BM25 únicamente sobre documentos ACTIVOS y sus fragmentos actuales.
 */
export function buildDocumentLexicalIndex(documents, docChunks, { projectId = '' } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const docMap = new Map((documents || []).filter((d) => d && d.active !== false).map((d) => [d.id, d]));
  const rawDocs = [];
  for (const chunk of (docChunks || [])) {
    const doc = docMap.get(chunk.documentId);
    if (!doc) continue;
    const text = String(chunk.text || '').trim();
    if (!text) continue;
    rawDocs.push({
      docId: chunk.id,
      documentId: doc.id,
      filename: doc.filename || 'documento',
      docType: doc.type || 'REFERENCE',
      passageIndex: chunk.index ?? 0,
      text,
      excerpt: text.length <= EXCERPT_MAX_CHARS ? text : `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…`,
    });
  }
  return buildInvertedFromDocs(rawDocs, {
    id: `${effectiveProject}::documents`,
    projectId: effectiveProject,
    kind: 'documents',
    documentSignatures: computeDocumentSignatures(documents, docChunks),
  });
}

/**
 * Consulta BM25 determinista y explicable con soporte para:
 * - Filtrado cronológico estricto (`eligibleChapterIds` o `maxChapterOrder`).
 * - Búsqueda exacta consciente de prólogos y numeración real de títulos (EN/ES),
 *   evitando el fallo off-by-one o por números saltados/reordenados.
 * - Filtrado por tipo de documento (`excludeDocTypes`, `includeDocTypes`).
 */
export function searchLexicalIndex(index, query, {
  topK = 8,
  maxChapterOrder = null,
  eligibleChapterIds = null,
  excludeChapterId = null,
  exactChapterNumber = null,
  excludeDocTypes = [],
  includeDocTypes = null,
  chaptersById = null,
  maxPerChapter = 2,
} = {}) {
  if (!index || !Array.isArray(index.docs) || !index.docs.length) return [];
  const N = index.totalDocs || index.docs.length;
  const avgdl = index.avgdl || 1;
  const excludeTypesSet = new Set(excludeDocTypes || []);
  const includeTypesSet = Array.isArray(includeDocTypes) && includeDocTypes.length ? new Set(includeDocTypes) : null;
  const eligibleSet = eligibleChapterIds instanceof Set
    ? eligibleChapterIds
    : (Array.isArray(eligibleChapterIds) ? new Set(eligibleChapterIds) : null);

  const requestedNums = new Set(requestedChapterNumbers(query));
  if (exactChapterNumber !== null && exactChapterNumber !== undefined && Number.isFinite(Number(exactChapterNumber))) {
    requestedNums.add(Number(exactChapterNumber));
  }
  const wantsPrologue = requestsPrologue(query);

  // Recopilar qué números explícitos de título existen en el índice (misma lógica que storyRecall.js)
  const explicitTitleNums = new Set();
  for (let i = 0; i < index.docs.length; i += 1) {
    const d = index.docs[i];
    if (d?.titleChapterNumber !== null && d?.titleChapterNumber !== undefined) {
      explicitTitleNums.add(d.titleChapterNumber);
    }
  }

  const isDocAllowed = (doc) => {
    if (!doc) return false;
    if (excludeChapterId && doc.chapterId === excludeChapterId) return false;
    if (eligibleSet && doc.chapterId && !eligibleSet.has(doc.chapterId)) return false;
    if (!eligibleSet && maxChapterOrder !== null && doc.chapterOrder !== null && doc.chapterOrder >= maxChapterOrder) return false;
    if (doc.docType && excludeTypesSet.has(doc.docType)) return false;
    if (includeTypesSet && doc.docType && !includeTypesSet.has(doc.docType)) return false;
    return true;
  };

  const queryTerms = [...new Set(tokenizeForBm25(query))];
  const scores = new Map();
  const matchedByDoc = new Map();

  for (let t = 0; t < queryTerms.length; t += 1) {
    const term = queryTerms[t];
    const posting = index.postings?.[term];
    if (!posting || !posting.length) continue;
    const dfVal = index.df?.[term] || (posting.length / 2);
    const idf = Math.log(1 + (N - dfVal + 0.5) / (dfVal + 0.5));

    for (let j = 0; j < posting.length; j += 2) {
      const docIdx = posting[j];
      const tf = posting[j + 1];
      const doc = index.docs[docIdx];
      if (!isDocAllowed(doc)) continue;

      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * ((doc.dl || 1) / avgdl));
      const contribution = idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
      scores.set(docIdx, (scores.get(docIdx) || 0) + contribution);
      let terms = matchedByDoc.get(docIdx);
      if (!terms) {
        terms = [];
        matchedByDoc.set(docIdx, terms);
      }
      terms.push(term);
    }
  }

  // Búsqueda exacta consciente de prólogos y títulos reales (EN/ES)
  const exactHits = new Set();
  if (requestedNums.size > 0 || wantsPrologue) {
    for (let docIdx = 0; docIdx < index.docs.length; docIdx += 1) {
      const doc = index.docs[docIdx];
      if (!isDocAllowed(doc) || !doc.chapterId) continue;
      const matchesPrologue = wantsPrologue && doc.isPrologue === true;
      const matchesTitleNum = doc.titleChapterNumber !== null && doc.titleChapterNumber !== undefined && requestedNums.has(doc.titleChapterNumber);
      const matchesFallback = (doc.titleChapterNumber === null || doc.titleChapterNumber === undefined) &&
        doc.fallbackChapterNumber !== null && doc.fallbackChapterNumber !== undefined &&
        requestedNums.has(doc.fallbackChapterNumber) &&
        !explicitTitleNums.has(doc.fallbackChapterNumber);

      if (matchesPrologue || matchesTitleNum || matchesFallback) {
        exactHits.add(docIdx);
        scores.set(docIdx, (scores.get(docIdx) || 0) + 12.0);
      }
    }
  }

  const ranked = [...scores.entries()]
    .map(([docIdx, score]) => {
      const doc = index.docs[docIdx];
      const matchedTerms = matchedByDoc.get(docIdx) || [];
      const exactChapterHit = exactHits.has(docIdx);
      const whyParts = [];
      if (exactChapterHit) {
        whyParts.push(doc.isPrologue
          ? 'coincidencia exacta con prólogo'
          : `coincidencia exacta con capítulo ${doc.titleChapterNumber ?? doc.fallbackChapterNumber ?? doc.chapterOrder}`);
      }
      if (matchedTerms.length) whyParts.push(`términos BM25: [${matchedTerms.join(', ')}]`);
      return {
        docId: doc.docId,
        chapterId: doc.chapterId,
        chapterOrder: doc.chapterOrder,
        titleChapterNumber: doc.titleChapterNumber,
        isPrologue: doc.isPrologue,
        chapterTitle: doc.chapterTitle,
        chapterRevision: doc.chapterRevision,
        documentId: doc.documentId,
        filename: doc.filename,
        docType: doc.docType,
        passageIndex: doc.passageIndex,
        excerpt: doc.excerpt,
        bm25Score: Number(score.toFixed(4)),
        matchedTerms,
        exactChapterHit,
        whyRetrieved: whyParts.join(' · ') || 'relevancia léxica',
      };
    })
    .sort((a, b) => Number(b.exactChapterHit) - Number(a.exactChapterHit) || b.bm25Score - a.bm25Score || (a.chapterOrder ?? 0) - (b.chapterOrder ?? 0));

  const perChapter = new Map();
  const out = [];
  const passageCache = new Map();
  for (const hit of ranked) {
    const groupKey = hit.chapterId || hit.documentId || hit.docId;
    const count = perChapter.get(groupKey) || 0;
    if (count >= maxPerChapter) continue;
    perChapter.set(groupKey, count + 1);

    // Enriquecer extracto centrado ÚNICAMENTE para los topK finales
    if (chaptersById && hit.chapterId && chaptersById.has(hit.chapterId) && hit.matchedTerms.length) {
      let passages = passageCache.get(hit.chapterId);
      if (!passages) {
        passages = segmentChapterPassages(chaptersById.get(hit.chapterId));
        passageCache.set(hit.chapterId, passages);
      }
      const fullPassage = passages[hit.passageIndex]?.text || '';
      if (fullPassage) {
        const lower = fullPassage.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const firstIdx = lower.indexOf(hit.matchedTerms[0]);
        if (firstIdx >= 0 && fullPassage.length > EXCERPT_MAX_CHARS) {
          const start = Math.max(0, firstIdx - 110);
          const slice = fullPassage.slice(start, start + EXCERPT_MAX_CHARS).trim();
          hit.excerpt = `${start > 0 ? '…' : ''}${slice}${start + EXCERPT_MAX_CHARS < fullPassage.length ? '…' : ''}`;
        }
      }
    }

    out.push(hit);
    if (out.length >= topK) break;
  }
  return out;
}

export async function invalidatePersistedLexicalIndex({ projectId = '', kind = 'all' } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const scope = { projectId: effectiveProject };
  if (kind === 'all' || kind === 'chapters') {
    await db.del('lexicalIndexes', `${effectiveProject}::chapters`, scope);
  }
  if (kind === 'all' || kind === 'documents') {
    await db.del('lexicalIndexes', `${effectiveProject}::documents`, scope);
  }
}

export async function syncPersistedChapterIndex({ projectId = '', chapters = null, forceRebuild = false } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const scope = { projectId: effectiveProject };
  const allChapters = chapters || await db.getAll('chapters', scope);
  const existing = forceRebuild ? null : await db.get('lexicalIndexes', `${effectiveProject}::chapters`, scope);
  const { index, rebuilt, changedChapterIds } = updateChapterLexicalIndexIncremental(existing, allChapters, { projectId: effectiveProject });
  if (rebuilt || !existing) {
    await db.put('lexicalIndexes', index, scope);
  }
  return { index, rebuilt, changedChapterIds };
}

export async function syncPersistedDocumentIndex({ projectId = '', documents = null, docChunks = null, forceRebuild = false } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const scope = { projectId: effectiveProject };
  const [docs, chunks] = await Promise.all([
    documents ? Promise.resolve(documents) : db.getAll('documents', scope),
    docChunks ? Promise.resolve(docChunks) : db.getAll('docChunks', scope),
  ]);
  const existing = forceRebuild ? null : await db.get('lexicalIndexes', `${effectiveProject}::documents`, scope);
  if (existing && isDocumentLexicalIndexFresh(existing, docs, chunks)) {
    return { index: existing, rebuilt: false };
  }
  const index = buildDocumentLexicalIndex(docs, chunks, { projectId: effectiveProject });
  await db.put('lexicalIndexes', index, scope);
  return { index, rebuilt: true };
}
