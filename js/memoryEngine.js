import { db } from './db.js';
import { getProvider, getModelOutputLimit } from './providers/index.js';
import { assembleSystemPrompt } from './canonGuard.js';
import { getRelevantChunks } from './retrieval.js';
import { isLikelyInvalidProse } from './providers/base.js';
import { chaptersBefore, memoriesForChapters } from './timeline.js';
import { selectSmartMemories, canonQueryBoost } from './smartContext.js';
import { getRelevantStoryExcerpts, getPreviousChapterEnding } from './storyRecall.js';
import { wordCount, contentFingerprint } from './utils.js';

const MEMORY_FIELDS = [
  ['EVENTS', 'events'],
  ['RELATIONSHIP_CHANGES', 'relationshipChanges'],
  ['NEW_FACTS', 'newFacts'],
  ['WHO_KNOWS_WHAT', 'whoKnowsWhat'],
  ['PHYSICAL_STATE', 'physicalState'],
  ['CURRENT_LOCATION_TIME', 'currentLocationTime'],
  ['OPEN_THREADS', 'openThreads'],
];

const SHORTEN_REQUEST_RX = /\b(acort\w*|resum\w*|recort\w*|condens\w*|reduc\w*|breve|shorter|shorten\w*|trim\w*|condens\w*|cut\b|brief)\b/i;

export function getRewriteOutputPlan(originalText, model = '', providerId = '') {
  const originalWords = wordCount(originalText);
  const reasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|gemini-2\.5|gemini-3)/i.test(String(model || ''));
  const proseBudget = Math.max(3200, Math.round(originalWords * 3.6) + 1600);
  const desiredTokens = proseBudget + (reasoningModel ? 3200 : 0);
  const modelMaxOutput = getModelOutputLimit(providerId, model);
  const maxOutputTokens = Math.min(modelMaxOutput, desiredTokens);
  return {
    maxOutputTokens,
    modelMaxOutput,
    desiredTokens,
    mayNeedContinuation: desiredTokens > modelMaxOutput,
  };
}

export function computeRewriteMaxOutputTokens(originalText, model = '', providerId = '') {
  return getRewriteOutputPlan(originalText, model, providerId).maxOutputTokens;
}

function normalizeMemoryValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => normalizeMemoryValue(item)).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => {
        const text = normalizeMemoryValue(v);
        return text ? `${k}: ${text}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return String(value).trim();
}

export function parseMemoryResponse(text) {
  const raw = String(text || '');
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      const out = {};
      for (const [key, field] of MEMORY_FIELDS) {
        const val = obj[key] !== undefined ? obj[key] : obj[field];
        out[field] = normalizeMemoryValue(val);
      }
      return out;
    }
  } catch { }
  const out = {};
  for (const [key, field] of MEMORY_FIELDS) {
    const rx = new RegExp(key.replace(/_/g, '[ _]?') + '\\s*[:\\-]\\s*(.+?)(?=\\n[A-Z_ ]+\\s*[:\\-]|$)', 'is');
    const m = raw.match(rx);
    out[field] = m ? m[1].trim() : '';
  }
  return out;
}

export async function markChapterMemoriesStale(chapterId, { projectId = '', reason = 'edited', chapterRevision = '' } = {}) {
  if (!chapterId) return { memoryEntries: 0, knowledgeFacts: 0, relationshipStates: 0, arcSummaries: 0, lexicalIndexInvalidated: false, total: 0 };
  const targetProjectId = projectId || db.getActiveProjectId();
  const now = new Date().toISOString();
  const safeReason = reason || 'edited';

  const idbReq = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const belongsToProject = (rec) => !!rec && (rec.projectId || 'original') === targetProjectId;
  const stampRevision = (rec) => ({
    ...rec,
    revision: (Number.isInteger(rec.revision) ? rec.revision : 0) + 1,
    syncUpdatedAt: now,
    dirty: true,
  });

  // Transacción atómica multi-store: jamás deja memorias, hechos, relaciones,
  // arcos o índices léxicos a medias ni silencia errores de persistencia.
  return db.runAtomicTransaction(
    ['memoryEntries', 'knowledgeFacts', 'relationshipStates', 'arcSummaries', 'lexicalIndexes'],
    'readwrite',
    async ({ stores }) => {
      const [allMem, allFacts, allRels, allArcs] = await Promise.all([
        idbReq(stores.memoryEntries.index('by_chapter').getAll(chapterId)),
        idbReq(stores.knowledgeFacts.index('by_project').getAll(targetProjectId)),
        idbReq(stores.relationshipStates.index('by_project').getAll(targetProjectId)),
        idbReq(stores.arcSummaries.index('by_project').getAll(targetProjectId)),
      ]);

      let staleMemCount = 0;
      let staleFactCount = 0;
      let staleRelCount = 0;
      let staleArcCount = 0;

      // 1. Memorias de continuidad del capítulo (conservando contenido previo intacto)
      for (const entry of (allMem || [])) {
        if (!belongsToProject(entry)) continue;
        stores.memoryEntries.put(stampRevision({
          ...entry,
          stale: true,
          staleReason: safeReason,
          staleAt: now,
          latestChapterRevision: chapterRevision || entry.latestChapterRevision || '',
        }));
        staleMemCount += 1;
      }

      // 2. Hechos epistémicos: invalidar tanto si el hecho se originó en `chapterId`
      //    COMO si alguna transición de creencia o divulgación se aprendió en `chapterId`!
      for (const fact of (allFacts || [])) {
        if (!fact || fact.deletedAt || !belongsToProject(fact)) continue;
        const factOriginatedHere = fact.sourceChapterId === chapterId;
        let beliefAffected = false;
        let nextBeliefHistory = fact.beliefHistoryByCharacter ? structuredClone(fact.beliefHistoryByCharacter) : null;
        let nextBeliefs = fact.beliefsByCharacter ? structuredClone(fact.beliefsByCharacter) : null;

        if (nextBeliefHistory) {
          for (const [charKey, list] of Object.entries(nextBeliefHistory)) {
            if (!Array.isArray(list)) continue;
            nextBeliefHistory[charKey] = list.map((tr) => {
              if (tr && (tr.sourceChapterId === chapterId || tr.learnedAtChapterId === chapterId)) {
                beliefAffected = true;
                return { ...tr, stale: true, staleReason: safeReason };
              }
              return tr;
            });
          }
        }
        if (nextBeliefs) {
          for (const [charKey, b] of Object.entries(nextBeliefs)) {
            if (b && (b.sourceChapterId === chapterId || b.learnedAtChapterId === chapterId)) {
              beliefAffected = true;
              nextBeliefs[charKey] = { ...b, stale: true, staleReason: safeReason };
            }
          }
        }
        let disclosureAffected = false;
        let nextDisclosures = Array.isArray(fact.disclosureHistory)
          ? fact.disclosureHistory.map((d) => {
              if (d && d.sourceChapterId === chapterId) {
                disclosureAffected = true;
                return { ...d, stale: true };
              }
              return d;
            })
          : fact.disclosureHistory;

        if (factOriginatedHere || beliefAffected || disclosureAffected) {
          stores.knowledgeFacts.put(stampRevision({
            ...fact,
            ...(nextBeliefHistory ? { beliefHistoryByCharacter: nextBeliefHistory } : {}),
            ...(nextBeliefs ? { beliefsByCharacter: nextBeliefs } : {}),
            ...(nextDisclosures !== undefined ? { disclosureHistory: nextDisclosures } : {}),
            stale: true,
            disputed: true,
            staleReason: factOriginatedHere ? safeReason : `belief_or_disclosure_source_${safeReason}`,
            staleAt: now,
            previousTruthSnapshot: fact.previousTruthSnapshot || fact.truth || '',
            latestChapterRevision: chapterRevision || fact.latestChapterRevision || '',
          }));
          staleFactCount += 1;
        }
      }

      // 3. Estados relacionales cualitativos (incluyendo snapshots temporales, promesas y evidencia)
      for (const rel of (allRels || [])) {
        if (!rel || rel.deletedAt || !belongsToProject(rel)) continue;
        const histAffected = Array.isArray(rel.stateHistory) && rel.stateHistory.some((s) => s?.sourceChapterId === chapterId);
        const refsChapter = rel.sourceChapterId === chapterId ||
          histAffected ||
          (rel.evidenceRefs || []).some((e) => e?.chapterId === chapterId) ||
          (rel.promises || []).some((p) => p?.sourceChapterId === chapterId || (p?.statusHistory || []).some((h) => h?.sourceChapterId === chapterId)) ||
          (rel.sharedMemories || []).some((m) => m?.sourceChapterId === chapterId) ||
          (rel.privateSecrets || []).some((s) => s?.sourceChapterId === chapterId);
        if (refsChapter) {
          const nextHistory = Array.isArray(rel.stateHistory)
            ? rel.stateHistory.map((s) => (s?.sourceChapterId === chapterId ? { ...s, stale: true, staleReason: safeReason } : s))
            : rel.stateHistory;
          stores.relationshipStates.put(stampRevision({
            ...rel,
            ...(nextHistory !== undefined ? { stateHistory: nextHistory } : {}),
            stale: true,
            staleReason: safeReason,
            staleAt: now,
            latestChapterRevision: chapterRevision || rel.latestChapterRevision || '',
          }));
          staleRelCount += 1;
        }
      }

      // 4. Resúmenes de arcos narrativos que incluyen este capítulo
      for (const arc of (allArcs || [])) {
        if (!arc || arc.deletedAt || !belongsToProject(arc)) continue;
        if (Array.isArray(arc.sourceChapterIds) && arc.sourceChapterIds.includes(chapterId)) {
          stores.arcSummaries.put(stampRevision({
            ...arc,
            stale: true,
            staleReason: safeReason,
            staleAt: now,
          }));
          staleArcCount += 1;
        }
      }

      // 5. Invalidar el índice léxico derivado de capítulos de esta historia en la MISMA transacción
      stores.lexicalIndexes.delete(`${targetProjectId}::chapters`);

      return {
        memoryEntries: staleMemCount,
        knowledgeFacts: staleFactCount,
        relationshipStates: staleRelCount,
        arcSummaries: staleArcCount,
        lexicalIndexInvalidated: true,
        total: staleMemCount + staleFactCount + staleRelCount + staleArcCount,
      };
    }
  );
}

export async function saveContinuityMemoryEntry(chapter, fields, { projectId = '' } = {}) {
  const targetProjectId = projectId || chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId: targetProjectId };
  const normalized = {};
  for (const [, field] of MEMORY_FIELDS) {
    normalized[field] = normalizeMemoryValue(fields?.[field]);
  }
  if (!Object.values(normalized).some((value) => String(value || '').trim())) {
    throw new Error('No se puede guardar una memoria de continuidad vacía.');
  }
  const previous = await db.getByIndex('memoryEntries', 'by_chapter', chapter.id, scope);
  const revision = contentFingerprint(chapter.content);
  const entry = {
    id: previous[0]?.id || db.uid(),
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    projectId: targetProjectId,
    ...normalized,
    stale: false,
    staleReason: '',
    staleAt: null,
    sourceChapterRevision: revision,
    latestChapterRevision: revision,
    createdAt: new Date().toISOString(),
  };
  const saved = await db.put('memoryEntries', entry, scope);
  for (const duplicate of previous.slice(1)) await db.del('memoryEntries', duplicate.id, scope);
  return saved;
}

export async function generateContinuityMemory(chapter, { signal, stageOnly = false } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId };
  const settings = (await db.get('settings', 'main')) || {};
  const provider = getProvider(settings);
  const [lockedFacts, characters, canonNotes] = await Promise.all([
    db.getAll('lockedFacts', scope), db.getAll('characters', scope), db.getAll('canonNotes', scope),
  ]);
  // La memoria DEBE resumir el manuscrito real, no historias de referencia.
  // No enviar documentos STYLE_ONLY ni otros textos al extractor: así no se
  // introducen personajes o sucesos ajenos en una continuidad aprobada.
  const retrievedChunks = [];
  const systemPrompt = assembleSystemPrompt({
    lockedFacts,
    chapterInstructions: 'Analiza el capítulo completo proporcionado por el usuario y extrae, con precisión y sin inventar nada que no esté implícito en el texto, un resumen de continuidad estructurado.',
    characters, memoryEntries: [], canonNotes, recentChapterExcerpt: '', retrievedChunks,
    extraGuidance: `Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto fuera del JSON) con estas claves exactas: EVENTS, RELATIONSHIP_CHANGES, NEW_FACTS, WHO_KNOWS_WHAT, PHYSICAL_STATE, CURRENT_LOCATION_TIME, OPEN_THREADS. Cada valor debe ser breve pero concreto. Prioriza nombres, relaciones, secretos revelados, quién sabe o NO sabe algo, apodos, promesas, bromas recurrentes, preguntas aún abiertas y hechos que un capítulo futuro podría contradecir. No sustituyas hechos por interpretaciones temáticas. Si una categoría no aplica, usa un string vacío.`,
  });
  const userPrompt = `CAPÍTULO A ANALIZAR ("${chapter.title}"):\n\n${chapter.content}`;
  // En modelos de razonamiento, max_completion_tokens incluye también los
  // tokens de razonamiento; 900 puede agotarse antes de devolver el JSON.
  const reasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|gemini-2\.5|gemini-3)/i.test(provider.config?.model || '');
  const modelLimit = getModelOutputLimit(provider.name, provider.config?.model || '');
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: Math.min(modelLimit, reasoningModel ? 4800 : 1400), temperature: 0.3, signal });
  if (!result.ok) return { ok: false, error: result.errorMessage || 'No se pudo generar la memoria de continuidad.' };
  const fields = parseMemoryResponse(result.text);
  if (!Object.values(fields).some((value) => String(value || '').trim())) {
    return { ok: false, error: 'La IA no devolvió un resumen de continuidad reconocible. No se ha guardado una memoria vacía.' };
  }
  const previous = await db.getByIndex('memoryEntries', 'by_chapter', chapter.id, scope);
  if (stageOnly) {
    const revision = contentFingerprint(chapter.content);
    return {
      ok: true,
      staged: true,
      existingEntry: previous[0] || null,
      proposedEntry: {
        id: previous[0]?.id || '',
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        projectId,
        ...fields,
        stale: false,
        staleReason: '',
        staleAt: null,
        sourceChapterRevision: revision,
        latestChapterRevision: revision,
      },
      fields,
    };
  }
  // Rehacer una memoria sustituye la anterior del MISMO capítulo, sin duplicarla.
  const saved = await saveContinuityMemoryEntry(chapter, fields, { projectId });
  return { ok: true, entry: saved };
}

async function buildRewriteContext(chapter, rewriteInstructions, scope) {
  const [lockedFacts, characters, memoryEntries, canonNotes, documents, allChunks, chapters] = await Promise.all([
    db.getAll('lockedFacts', scope), db.getAll('characters', scope), db.getAll('memoryEntries', scope),
    db.getAll('canonNotes', scope), db.getAll('documents', scope), db.getAll('docChunks', scope),
    db.getAll('chapters', scope),
  ]);
  const priorChapters = chaptersBefore(chapters, chapter.id);
  const priorMemories = memoriesForChapters(memoryEntries, priorChapters);
  const queryBase = [rewriteInstructions, chapter.title, String(chapter.content || '').slice(0, 3500)].filter(Boolean).join(' ');
  const selectedMemories = selectSmartMemories(priorMemories, queryBase).selected;
  const continuityQuery = [
    queryBase,
    canonQueryBoost(canonNotes, queryBase),
    selectedMemories.slice(-2).map((m) => [m.events, m.openThreads, m.whoKnowsWhat].filter(Boolean).join(' ')).join(' '),
  ].filter(Boolean).join(' ');
  const storyExcerpts = getRelevantStoryExcerpts(priorChapters, continuityQuery, {
    excludeChapterId: chapter.id,
    maxExcerpts: 4,
    maxPerChapter: 2,
  });
  const previousEnding = getPreviousChapterEnding(priorChapters, chapter.id, 3200);
  const retrievedChunks = getRelevantChunks(documents.filter((d) => d.type !== 'STYLE_ONLY'), allChunks, continuityQuery, { context: 'rewrite' });
  return { lockedFacts, characters, selectedMemories, canonNotes, previousEnding, storyExcerpts, retrievedChunks };
}

function evaluateRewriteResult(rewritten, originalWords, rewriteInstructions, providerResult, plan) {
  const rewrittenWords = wordCount(rewritten);
  const providerTruncated = providerResult.truncated === true || ['length', 'MAX_TOKENS', 'max_output_tokens'].includes(String(providerResult.finishReason || ''));
  const suspiciouslyShort = originalWords >= 600 &&
    rewrittenWords < Math.round(originalWords * 0.45) &&
    !SHORTEN_REQUEST_RX.test(String(rewriteInstructions || ''));
  const warnings = [];
  if (providerTruncated) {
    warnings.push(`El proveedor alcanzó su límite de salida (${plan.modelMaxOutput} tokens) y la respuesta quedó incompleta. Usa «Continuar reescritura» para completarla sin perder este texto.`);
  }
  if (suspiciouslyShort) {
    warnings.push(`El borrador reescrito (${rewrittenWords} palabras) es mucho más corto que el original (${originalWords} palabras) y podría faltar parte del capítulo.`);
  }
  return {
    rewrittenWords,
    providerTruncated,
    suspiciouslyShort,
    incomplete: providerTruncated || suspiciouslyShort,
    warnings,
  };
}

export async function rewriteChapter(chapter, rewriteInstructions, { signal } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId };
  const settings = (await db.get('settings', 'main')) || {};
  const provider = getProvider(settings);
  const ctx = await buildRewriteContext(chapter, rewriteInstructions, scope);
  const originalWords = wordCount(chapter.content);
  const baseContentHash = contentFingerprint(chapter.content);
  const baseUpdatedAt = String(chapter.updatedAt || '');
  const plan = getRewriteOutputPlan(chapter.content, provider.config?.model || '', provider.name);
  const systemPrompt = assembleSystemPrompt({
    lockedFacts: ctx.lockedFacts,
    chapterInstructions: `Vas a REESCRIBIR un capítulo existente según instrucciones del autor. Instrucciones de reescritura: ${rewriteInstructions}`,
    characters: ctx.characters,
    memoryEntries: ctx.selectedMemories,
    canonNotes: ctx.canonNotes,
    recentChapterExcerpt: ctx.previousEnding.text,
    storyExcerpts: ctx.storyExcerpts,
    retrievedChunks: ctx.retrievedChunks,
    extraGuidance: `Devuelve el capítulo reescrito COMPLETO (~${Math.max(originalWords, 300)} palabras), en prosa, sin omitir escenas no modificadas ni añadir comentarios meta o explicaciones fuera del propio texto narrativo.`,
  });
  const userPrompt = `CAPÍTULO ORIGINAL (${originalWords} palabras):\n\n${chapter.content}\n\n---\n\nReescribe este capítulo completo aplicando las instrucciones indicadas, conservando intactas las escenas que no se pidió cambiar.`;
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: plan.maxOutputTokens, temperature: 1.0, signal });
  if (!result.ok) {
    return {
      ok: false,
      errorType: result.errorType || 'http',
      error: result.errorMessage || 'La reescritura falló; no se guardó ningún cambio.',
    };
  }
  const rewritten = String(result.text || '').trim();
  if (isLikelyInvalidProse(rewritten)) {
    return { ok: false, error: 'La reescritura no devolvió prosa válida; no se guardó ningún cambio.' };
  }
  const check = evaluateRewriteResult(rewritten, originalWords, rewriteInstructions, result, plan);
  return {
    ok: true,
    text: rewritten,
    originalWords,
    rewrittenWords: check.rewrittenWords,
    truncated: check.providerTruncated,
    suspiciouslyShort: check.suspiciouslyShort,
    incomplete: check.incomplete,
    finishReason: result.finishReason || null,
    warnings: check.warnings,
    modelMaxOutput: plan.modelMaxOutput,
    mayNeedContinuation: plan.mayNeedContinuation,
    baseContentHash,
    baseUpdatedAt,
  };
}

export async function continueRewriteDraft(chapter, rewriteInstructions, draftSoFar, { signal } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId };
  const existingDraft = String(draftSoFar || '').trim();
  if (wordCount(existingDraft) < 15) {
    return { ok: false, error: 'No hay suficiente borrador previo para continuar la reescritura.' };
  }
  const settings = (await db.get('settings', 'main')) || {};
  const provider = getProvider(settings);
  const ctx = await buildRewriteContext(chapter, rewriteInstructions, scope);
  const originalWords = wordCount(chapter.content);
  const remainingWords = Math.max(400, originalWords - wordCount(existingDraft) + 300);
  const plan = getRewriteOutputPlan('w '.repeat(remainingWords), provider.config?.model || '', provider.name);
  const systemPrompt = assembleSystemPrompt({
    lockedFacts: ctx.lockedFacts,
    chapterInstructions: `Vas a CONTINUAR una reescritura incompleta de un capítulo existente. Instrucciones originales de reescritura: ${rewriteInstructions}`,
    characters: ctx.characters,
    memoryEntries: ctx.selectedMemories,
    canonNotes: ctx.canonNotes,
    recentChapterExcerpt: ctx.previousEnding.text,
    storyExcerpts: ctx.storyExcerpts,
    retrievedChunks: ctx.retrievedChunks,
    extraGuidance: 'Devuelve ÚNICAMENTE la continuación que falta desde la última palabra/frase de <REWRITE_SO_FAR> hasta completar el final del capítulo original. No repitas párrafos ya reescritos, ni añadas encabezados o comentarios.',
  });
  const userPrompt = [
    `CAPÍTULO ORIGINAL COMPLETO (${originalWords} palabras):`,
    '<ORIGINAL_CHAPTER>',
    chapter.content,
    '</ORIGINAL_CHAPTER>',
    'PARTE YA REESCRITA (NO repetir; continuar exactamente desde el final):',
    '<REWRITE_SO_FAR>',
    existingDraft.slice(-55000),
    '</REWRITE_SO_FAR>',
    'Continúa la reescritura exactamente donde se cortó y completa el resto del capítulo.',
  ].join('\n\n');

  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: plan.maxOutputTokens, temperature: 1.0, signal });
  if (!result.ok) {
    return {
      ok: false,
      errorType: result.errorType || 'http',
      error: result.errorMessage || 'No se pudo continuar la reescritura.',
    };
  }
  const addition = String(result.text || '').trim();
  if (isLikelyInvalidProse(addition)) {
    return { ok: false, error: 'La continuación no devolvió prosa válida; tu borrador parcial sigue intacto.' };
  }
  const combined = existingDraft + '\n\n' + addition;
  const check = evaluateRewriteResult(combined, originalWords, rewriteInstructions, result, plan);
  return {
    ok: true,
    text: combined,
    addition,
    originalWords,
    rewrittenWords: check.rewrittenWords,
    truncated: check.providerTruncated,
    suspiciouslyShort: check.suspiciouslyShort,
    incomplete: check.incomplete,
    finishReason: result.finishReason || null,
    warnings: check.warnings,
    modelMaxOutput: plan.modelMaxOutput,
    mayNeedContinuation: plan.mayNeedContinuation,
  };
}
