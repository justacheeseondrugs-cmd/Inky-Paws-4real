import { db } from './db.js';
import { getProvider } from './providers/index.js';
import { assembleSystemPrompt } from './canonGuard.js';
import { getRelevantChunks } from './retrieval.js';
import { isLikelyInvalidProse } from './providers/base.js';
import { chaptersBefore, memoriesForChapters } from './timeline.js';
import { selectSmartMemories, canonQueryBoost } from './smartContext.js';
import { getRelevantStoryExcerpts, getPreviousChapterEnding } from './storyRecall.js';
import { wordCount } from './utils.js';

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

export function computeRewriteMaxOutputTokens(originalText, model = '') {
  const originalWords = wordCount(originalText);
  const reasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|gemini-2\.5|gemini-3)/i.test(String(model || ''));
  const proseBudget = Math.max(4000, Math.round(originalWords * 3.8) + 2000);
  return Math.min(120000, proseBudget + (reasoningModel ? 3200 : 0));
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

export async function generateContinuityMemory(chapter, { signal } = {}) {
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
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: reasoningModel ? 4800 : 1400, temperature: 0.3, signal });
  if (!result.ok) return { ok: false, error: result.errorMessage || 'No se pudo generar la memoria de continuidad.' };
  const fields = parseMemoryResponse(result.text);
  if (!Object.values(fields).some((value) => String(value || '').trim())) {
    return { ok: false, error: 'La IA no devolvió un resumen de continuidad reconocible. No se ha guardado una memoria vacía.' };
  }
  // Rehacer una memoria sustituye la anterior del MISMO capítulo, sin duplicarla.
  const previous = await db.getByIndex('memoryEntries', 'by_chapter', chapter.id, scope);
  const entry = {
    id: previous[0]?.id || db.uid(),
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    projectId,
    ...fields,
    createdAt: new Date().toISOString(),
  };
  const saved = await db.put('memoryEntries', entry, scope);
  for (const duplicate of previous.slice(1)) await db.del('memoryEntries', duplicate.id, scope);
  return { ok: true, entry: saved };
}

export async function rewriteChapter(chapter, rewriteInstructions, { signal } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId };
  const settings = (await db.get('settings', 'main')) || {};
  const provider = getProvider(settings);
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
  const originalWords = wordCount(chapter.content);
  const maxOutputTokens = computeRewriteMaxOutputTokens(chapter.content, provider.config?.model || '');
  const systemPrompt = assembleSystemPrompt({
    lockedFacts,
    chapterInstructions: `Vas a REESCRIBIR un capítulo existente según instrucciones del autor. Instrucciones de reescritura: ${rewriteInstructions}`,
    characters, memoryEntries: selectedMemories, canonNotes, recentChapterExcerpt: previousEnding.text, storyExcerpts, retrievedChunks,
    extraGuidance: `Devuelve el capítulo reescrito COMPLETO (~${Math.max(originalWords, 300)} palabras), en prosa, sin omitir escenas no modificadas ni añadir comentarios meta o explicaciones fuera del propio texto narrativo.`,
  });
  const userPrompt = `CAPÍTULO ORIGINAL (${originalWords} palabras):\n\n${chapter.content}\n\n---\n\nReescribe este capítulo completo aplicando las instrucciones indicadas, conservando intactas las escenas que no se pidió cambiar.`;
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens, temperature: 1.0, signal });
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
  const rewrittenWords = wordCount(rewritten);
  const providerTruncated = result.truncated === true || ['length', 'MAX_TOKENS', 'max_output_tokens'].includes(String(result.finishReason || ''));
  const suspiciouslyShort = originalWords >= 600 &&
    rewrittenWords < Math.round(originalWords * 0.45) &&
    !SHORTEN_REQUEST_RX.test(String(rewriteInstructions || ''));
  const warnings = [];
  if (providerTruncated) {
    warnings.push('El proveedor indicó que la respuesta alcanzó el límite de salida y quedó incompleta.');
  }
  if (suspiciouslyShort) {
    warnings.push(`El borrador reescrito (${rewrittenWords} palabras) es mucho más corto que el original (${originalWords} palabras) y podría faltar parte del capítulo.`);
  }
  return {
    ok: true,
    text: rewritten,
    originalWords,
    rewrittenWords,
    truncated: providerTruncated,
    suspiciouslyShort,
    incomplete: providerTruncated || suspiciouslyShort,
    finishReason: result.finishReason || null,
    warnings,
  };
}
