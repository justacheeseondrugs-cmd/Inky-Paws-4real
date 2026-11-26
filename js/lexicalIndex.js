// lexicalIndex.js — Índice léxico BM25 persistido en IndexedDB (0 tokens, sin embeddings
// ni bases vectoriales de pago), diseñado para escalar a 100+ capítulos y 500,000+ palabras.
//
// Reglas fundamentales:
// - Solo indexa capítulos de la línea principal (`isMainTimelineChapter`): los capítulos
//   alternativos NUNCA contaminan el índice de continuidad principal.
// - Guarda la revisión (`contentFingerprint`) de cada capítulo fuente para actualizaciones
//   incrementales y trazabilidad exacta.
// - Soporta búsqueda léxica BM25 (EN + ES), búsqueda exacta por número de capítulo
//   (p.ej. "capítulo 7" / "chapter 7"), filtrado cronológico estricto (`maxChapterOrder`)
//   y explicación determinista de cada resultado (`matchedTerms`, `bm25Score`, `whyRetrieved`).

import { db } from './db.js';
import { isMainTimelineChapter } from './timeline.js';
import { contentFingerprint } from './utils.js';

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
  const text = String(query || '');
  const m = text.match(/\b(?:cap[íi]tulo|cap\.?|chapter|ch\.?)\s*#?\s*(\d{1,4})\b/i);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export function segmentChapterPassages(chapter, { targetChars = TARGET_PASSAGE_CHARS } = {}) {
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
  return passages.map((text, passageIndex) => ({
    docId: `${chapter.id}#p${passageIndex}`,
    chapterId: chapter.id,
    chapterOrder: order,
    chapterTitle: String(chapter.title || `Capítulo ${order}`),
    chapterRevision: rev,
    passageIndex,
    text,
    excerpt: text.length <= EXCERPT_MAX_CHARS ? text : `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…`,
  }));
}

function buildInvertedFromDocs(rawDocs, { id, projectId, kind, chapterRevisions = {} }) {
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
    schemaVersion: 1,
    totalDocs: docs.length,
    avgdl: docs.length ? totalLength / docs.length : 0,
    chapterRevisions,
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
  const mainChapters = (chapters || [])
    .filter((ch) => isMainTimelineChapter(ch) && String(ch.content || '').trim())
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const rawDocs = [];
  const chapterRevisions = {};
  for (const ch of mainChapters) {
    const rev = contentFingerprint(ch.content);
    chapterRevisions[ch.id] = {
      rev,
      order: Number.isFinite(Number(ch.order)) ? Number(ch.order) : 0,
      title: String(ch.title || ''),
    };
    const passages = segmentChapterPassages(ch);
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
 * Actualiza incrementalmente un índice existente si solo cambiaron algunos capítulos,
 * evitando retokenizar los capítulos sin cambios.
 */
export function updateChapterLexicalIndexIncremental(existingIndex, chapters, { projectId = '' } = {}) {
  const effectiveProject = projectId || existingIndex?.projectId || db.getActiveProjectId();
  const mainChapters = (chapters || [])
    .filter((ch) => isMainTimelineChapter(ch) && String(ch.content || '').trim())
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!existingIndex || !Array.isArray(existingIndex.docs) || !existingIndex.chapterRevisions) {
    return { index: buildChapterLexicalIndex(mainChapters, { projectId: effectiveProject }), rebuilt: true, changedChapterIds: mainChapters.map((c) => c.id) };
  }

  const prevRevs = existingIndex.chapterRevisions;
  const nextRevs = {};
  const changedIds = new Set();
  const currentIds = new Set();

  for (const ch of mainChapters) {
    currentIds.add(ch.id);
    const rev = contentFingerprint(ch.content);
    const order = Number.isFinite(Number(ch.order)) ? Number(ch.order) : 0;
    const title = String(ch.title || '');
    nextRevs[ch.id] = { rev, order, title };
    const prev = prevRevs[ch.id];
    if (!prev || prev.rev !== rev || prev.order !== order || prev.title !== title) {
      changedIds.add(ch.id);
    }
  }
  const removedIds = new Set(Object.keys(prevRevs).filter((id) => !currentIds.has(id)));

  if (changedIds.size === 0 && removedIds.size === 0) {
    return { index: existingIndex, rebuilt: false, changedChapterIds: [] };
  }

  // Reconstrucción incremental eficiente: conservar postings intactos para docs no modificados
  const oldDocs = existingIndex.docs;
  const oldPostings = existingIndex.postings || {};
  const keptOldIdxToNewIdx = new Map();
  const newDocs = [];

  for (let i = 0; i < oldDocs.length; i += 1) {
    const d = oldDocs[i];
    if (removedIds.has(d.chapterId) || changedIds.has(d.chapterId)) continue;
    keptOldIdxToNewIdx.set(i, newDocs.length);
    newDocs.push(d);
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

  // Tokenizar únicamente los capítulos nuevos o modificados
  for (const ch of mainChapters) {
    if (!changedIds.has(ch.id)) continue;
    const passages = segmentChapterPassages(ch);
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
      schemaVersion: 1,
      totalDocs: newDocs.length,
      avgdl: newDocs.length ? totalLength / newDocs.length : 0,
      chapterRevisions: nextRevs,
      docs: newDocs,
      df,
      postings,
      updatedAt: new Date().toISOString(),
    },
    rebuilt: true,
    changedChapterIds: [...changedIds, ...removedIds],
  };
}

/**
 * Construye un índice BM25 sobre fragmentos de documentos de referencia (`docChunks`).
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
  });
}

/**
 * Consulta BM25 determinista y explicable con soporte para:
 * - Filtrado cronológico estricto (`maxChapterOrder`: excluye capítulos >= maxChapterOrder).
 * - Exclusión de un capítulo específico (`excludeChapterId`).
 * - Búsqueda exacta por número de capítulo (`exactChapterNumber` o detectado en `query`).
 * - Filtrado por tipo de documento (`excludeDocTypes`, p.ej. excluir `STYLE_ONLY` en memoria factual).
 */
export function searchLexicalIndex(index, query, {
  topK = 8,
  maxChapterOrder = null,
  excludeChapterId = null,
  exactChapterNumber = null,
  excludeDocTypes = [],
  chaptersById = null,
  maxPerChapter = 2,
} = {}) {
  if (!index || !Array.isArray(index.docs) || !index.docs.length) return [];
  const N = index.totalDocs || index.docs.length;
  const avgdl = index.avgdl || 1;
  const excludeTypesSet = new Set(excludeDocTypes || []);
  const explicitChNum = exactChapterNumber !== null && exactChapterNumber !== undefined
    ? Number(exactChapterNumber)
    : extractExactChapterNumber(query);

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
      if (!doc) continue;
      if (excludeChapterId && doc.chapterId === excludeChapterId) continue;
      if (maxChapterOrder !== null && doc.chapterOrder !== null && doc.chapterOrder >= maxChapterOrder) continue;
      if (doc.docType && excludeTypesSet.has(doc.docType)) continue;

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

  // Búsqueda exacta por número de capítulo (respetando maxChapterOrder)
  const exactHits = new Set();
  if (explicitChNum !== null && Number.isFinite(explicitChNum)) {
    for (let docIdx = 0; docIdx < index.docs.length; docIdx += 1) {
      const doc = index.docs[docIdx];
      if (!doc || doc.chapterOrder !== explicitChNum) continue;
      if (excludeChapterId && doc.chapterId === excludeChapterId) continue;
      if (maxChapterOrder !== null && doc.chapterOrder >= maxChapterOrder) continue;
      exactHits.add(docIdx);
      scores.set(docIdx, (scores.get(docIdx) || 0) + 6.0);
    }
  }

  const ranked = [...scores.entries()]
    .map(([docIdx, score]) => {
      const doc = index.docs[docIdx];
      const matchedTerms = matchedByDoc.get(docIdx) || [];
      const exactChapterHit = exactHits.has(docIdx);
      const whyParts = [];
      if (exactChapterHit) whyParts.push(`coincidencia exacta con capítulo ${doc.chapterOrder}`);
      if (matchedTerms.length) whyParts.push(`términos BM25: [${matchedTerms.join(', ')}]`);
      return {
        docId: doc.docId,
        chapterId: doc.chapterId,
        chapterOrder: doc.chapterOrder,
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
    .sort((a, b) => b.bm25Score - a.bm25Score || (a.chapterOrder ?? 0) - (b.chapterOrder ?? 0));

  // Evitar que un único capítulo acapare todos los resultados
  const perChapter = new Map();
  const out = [];
  const passageCache = new Map();
  for (const hit of ranked) {
    const groupKey = hit.chapterId || hit.documentId || hit.docId;
    const count = perChapter.get(groupKey) || 0;
    if (count >= maxPerChapter) continue;
    perChapter.set(groupKey, count + 1);

    // Enriquecer extracto con el texto real centrado ÚNICAMENTE para los topK finales
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

/**
 * Sincroniza y persiste en IndexedDB el índice léxico BM25 de capítulos de una historia.
 */
export async function syncPersistedChapterIndex({ projectId = '', chapters = null } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const scope = { projectId: effectiveProject };
  const allChapters = chapters || await db.getAll('chapters', scope);
  const existing = await db.get('lexicalIndexes', `${effectiveProject}::chapters`, scope);
  const { index, rebuilt, changedChapterIds } = updateChapterLexicalIndexIncremental(existing, allChapters, { projectId: effectiveProject });
  if (rebuilt || !existing) {
    await db.put('lexicalIndexes', index, scope);
  }
  return { index, rebuilt, changedChapterIds };
}

export async function syncPersistedDocumentIndex({ projectId = '', documents = null, docChunks = null } = {}) {
  const effectiveProject = projectId || db.getActiveProjectId();
  const scope = { projectId: effectiveProject };
  const [docs, chunks] = await Promise.all([
    documents ? Promise.resolve(documents) : db.getAll('documents', scope),
    docChunks ? Promise.resolve(docChunks) : db.getAll('docChunks', scope),
  ]);
  const index = buildDocumentLexicalIndex(docs, chunks, { projectId: effectiveProject });
  await db.put('lexicalIndexes', index, scope);
  return { index };
}
