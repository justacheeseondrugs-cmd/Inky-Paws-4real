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
  if (!chapterId) return { memoryEntries: 0, knowledgeFacts: 0, relationshipStates: 0, arcSummaries: 0, total: 0 };
  const targetProjectId = projectId || db.getActiveProjectId();
  const scope = { projectId: targetProjectId };
  const now = new Date().toISOString();
  const safeReason = reason || 'edited';
  let staleMemCount = 0;
  let staleFactCount = 0;
  let staleRelCount = 0;
  let staleArcCount = 0;

  // 1. Memorias de continuidad del capítulo (conservando contenido previo intacto)
  const entries = await db.getByIndex('memoryEntries', 'by_chapter', chapterId, scope);
  for (const entry of entries) {
    await db.put('memoryEntries', {
      ...entry,
      stale: true,
      staleReason: safeReason,
      staleAt: now,
      latestChapterRevision: chapterRevision || entry.latestChapterRevision || '',
    }, scope);
    staleMemCount += 1;
  }

  // 2. Hechos epistémicos derivados del capítulo (marcados stale/disputed sin alterar `truth`)
  const allFacts = await db.getAll('knowledgeFacts', scope).catch(() => []);
  for (const fact of (allFacts || [])) {
    if (!fact || fact.deletedAt) continue;
    if (fact.sourceChapterId === chapterId) {
      await db.put('knowledgeFacts', {
        ...fact,
        stale: true,
        disputed: true,
        staleReason: safeReason,
        staleAt: now,
        previousTruthSnapshot: fact.previousTruthSnapshot || fact.truth || '',
        latestChapterRevision: chapterRevision || fact.latestChapterRevision || '',
      }, scope);
      staleFactCount += 1;
    }
  }

  // 3. Estados relacionales cualitativos respaldados por este capítulo
  const allRels = await db.getAll('relationshipStates', scope).catch(() => []);
  for (const rel of (allRels || [])) {
    if (!rel || rel.deletedAt) continue;
    const refsChapter = rel.sourceChapterId === chapterId ||
      (rel.evidenceRefs || []).some((e) => e?.chapterId === chapterId) ||
      (rel.promises || []).some((p) => p?.sourceChapterId === chapterId) ||
      (rel.sharedMemories || []).some((m) => m?.sourceChapterId === chapterId) ||
      (rel.privateSecrets || []).some((s) => s?.sourceChapterId === chapterId);
    if (refsChapter) {
      await db.put('relationshipStates', {
        ...rel,
        stale: true,
        staleReason: safeReason,
        staleAt: now,
        latestChapterRevision: chapterRevision || rel.latestChapterRevision || '',
      }, scope);
      staleRelCount += 1;
    }
  }

  // 4. Resúmenes de arcos narrativos que incluyen este capítulo
  const allArcs = await db.getAll('arcSummaries', scope).catch(() => []);
  for (const arc of (allArcs || [])) {
    if (!arc || arc.deletedAt) continue;
    if (Array.isArray(arc.sourceChapterIds) && arc.sourceChapterIds.includes(chapterId)) {
      await db.put('arcSummaries', {
        ...arc,
        stale: true,
        staleReason: safeReason,
        staleAt: now,
      }, scope);
      staleArcCount += 1;
    }
  }

  return {
    memoryEntries: staleMemCount,
    knowledgeFacts: staleFactCount,
    relationshipStates: staleRelCount,
    arcSummaries: staleArcCount,
    total: staleMemCount + staleFactCount + staleRelCount + staleArcCount,
  };
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
