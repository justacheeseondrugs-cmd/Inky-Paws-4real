import { db } from './db.js';
import { getProviderForRole, getModelOutputLimit } from './providers/index.js';
import { isLikelyInvalidProse } from './providers/base.js';
import { wordCount, contentFingerprint } from './utils.js';
import { assembleOperationContext } from './contextEngine.js';
import { getWalletConfig, checkGenerationBudget, recordUsageEvent, getCumulativeChargeFromUsage } from './inkyWallet.js';

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

export async function generateContinuityMemory(chapter, { signal, stageOnly = false, provider: customProvider = null, spentSoFarUsd = 0, hasPriorUnknownCost = false } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId };
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'auxiliary');
  const bundle = await assembleOperationContext({
    projectId,
    operation: 'continuity_extraction',
    role: 'auxiliary',
    targetChapterId: chapter?.id || null,
    targetChapterOrder: chapter?.order ?? null,
    chapterTitle: chapter?.title || '',
    chapterText: chapter?.content || '',
    documentIds: [], // La memoria resume el manuscrito real, nunca historias de referencia
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.auxiliaryModel,
    walletConfig,
  });

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
    hasPriorUnknownCost,
  });
  if (!budget.allowed) {
    return { ok: false, errorType: 'budget_blocked', reason: budget.reason, error: budget.message };
  }

  const maxOutputTokens = bundle.modelBound.maxOutputTokens;
  const result = await provider.generate({
    systemPrompt: bundle.modelBound.systemPrompt,
    userPrompt: bundle.modelBound.userPrompt,
    maxOutputTokens,
    temperature: 0.3,
    reasoningEffort: bundle.modelBound.reasoningEffort || '',
    signal,
  });

  await recordUsageEvent({
    projectId,
    operation: 'continuity_extraction',
    provider: provider.name,
    model: provider.config?.model || bundle.modelBound.modelId,
    role: 'auxiliary',
    status: result.ok ? 'ok' : (result.errorType || 'error'),
    errorType: result.errorType || null,
    estimatedInputTokens: bundle.modelBound.estimatedInputTokens,
    estimatedOutputTokens: bundle.modelBound.estimatedOutputTokens,
    authorizedMaxOutputTokens: maxOutputTokens,
    conservativeEstimatedCostUsd: bundle.modelBound.costEstimate?.costUsd ?? null,
    providerUsage: result.usage || null,
    walletConfig,
  });

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
      rawText: result.text,
      usage: result.usage || null,
      snapshotHash: bundle.snapshotHash,
    };
  }
  const saved = await saveContinuityMemoryEntry(chapter, fields, { projectId });
  return { ok: true, entry: saved, usage: result.usage || null, snapshotHash: bundle.snapshotHash };
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

export async function rewriteChapter(chapter, rewriteInstructions, { signal, provider: customProvider = null, targetSceneId = null, spentSoFarUsd = 0, hasPriorUnknownCost = false } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'primary');
  const originalWords = wordCount(chapter.content);
  const baseContentHash = contentFingerprint(chapter.content);
  const baseUpdatedAt = String(chapter.updatedAt || '');
  const plan = getRewriteOutputPlan(chapter.content, provider.config?.model || '', provider.name);

  const bundle = await assembleOperationContext({
    projectId,
    operation: 'chapter_rewrite',
    role: 'primary',
    targetChapterId: chapter?.id || null,
    targetChapterOrder: chapter?.order ?? null,
    targetSceneId,
    chapterTitle: chapter?.title || '',
    originalChapterText: chapter?.content || '',
    requestedMaxOutputTokens: plan.maxOutputTokens,
    rewriteInstructions,
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.primaryModel,
    walletConfig,
  });

  if (!bundle.canGenerate) {
    const msg = (bundle.inspectorOnly.criticalBlockers || []).map((b) => b.message).join(' | ');
    return { ok: false, errorType: 'critical_contradiction', error: `Reescritura bloqueada por contradicciones críticas de universo: ${msg}`, criticalBlockers: bundle.inspectorOnly.criticalBlockers };
  }

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
    hasPriorUnknownCost,
  });
  if (!budget.allowed) {
    return { ok: false, errorType: 'budget_blocked', reason: budget.reason, error: budget.message };
  }

  const maxOutputTokens = bundle.modelBound.maxOutputTokens;
  const result = await provider.generate({
    systemPrompt: bundle.modelBound.systemPrompt,
    stableSystemPrompt: bundle.modelBound.stablePrompt,
    dynamicSystemPrompt: bundle.modelBound.dynamicPrompt,
    userPrompt: bundle.modelBound.userPrompt,
    maxOutputTokens,
    temperature: 1.0,
    reasoningEffort: bundle.modelBound.reasoningEffort || '',
    signal,
  });

  const usageRec = await recordUsageEvent({
    projectId,
    operation: 'chapter_rewrite',
    provider: provider.name,
    model: provider.config?.model || bundle.modelBound.modelId,
    role: 'primary',
    status: result.ok ? 'ok' : (result.errorType || 'error'),
    errorType: result.errorType || null,
    estimatedInputTokens: bundle.modelBound.estimatedInputTokens,
    estimatedOutputTokens: bundle.modelBound.estimatedOutputTokens,
    authorizedMaxOutputTokens: maxOutputTokens,
    conservativeEstimatedCostUsd: bundle.modelBound.costEstimate?.costUsd ?? null,
    providerUsage: result.usage || null,
    walletConfig,
  });

  const charge = getCumulativeChargeFromUsage(usageRec, bundle.modelBound.costEstimate?.costUsd ?? null);
  const nextSpentUsd = charge.unknown ? spentSoFarUsd : Number((spentSoFarUsd + charge.knownUsd).toFixed(6));
  const nextHasUnknown = Boolean(hasPriorUnknownCost || charge.unknown);

  if (!result.ok) {
    return {
      ok: false,
      errorType: result.errorType || 'http',
      error: result.errorMessage || 'La reescritura falló; no se guardó ningún cambio.',
      cumulativeSpentUsd: nextSpentUsd,
      hasPriorUnknownCost: nextHasUnknown,
    };
  }
  const rewritten = String(result.text || '').trim();
  if (isLikelyInvalidProse(rewritten)) {
    return { ok: false, error: 'La reescritura no devolvió prosa válida; no se guardó ningún cambio.', cumulativeSpentUsd: nextSpentUsd, hasPriorUnknownCost: nextHasUnknown };
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
    snapshotHash: bundle.snapshotHash,
    usage: result.usage || null,
    cumulativeSpentUsd: nextSpentUsd,
    hasPriorUnknownCost: nextHasUnknown,
  };
}

export async function continueRewriteDraft(chapter, rewriteInstructions, draftSoFar, { signal, provider: customProvider = null, spentSoFarUsd = 0, hasPriorUnknownCost = false } = {}) {
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const existingDraft = String(draftSoFar || '').trim();
  if (wordCount(existingDraft) < 15) {
    return { ok: false, error: 'No hay suficiente borrador previo para continuar la reescritura.' };
  }
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'primary');
  const originalWords = wordCount(chapter.content);
  const remainingWords = Math.max(400, originalWords - wordCount(existingDraft) + 300);
  const plan = getRewriteOutputPlan('w '.repeat(remainingWords), provider.config?.model || '', provider.name);

  const bundle = await assembleOperationContext({
    projectId,
    operation: 'chapter_rewrite',
    role: 'primary',
    targetChapterId: chapter?.id || null,
    targetChapterOrder: chapter?.order ?? null,
    chapterTitle: chapter?.title || '',
    originalChapterText: chapter?.content || '',
    rewriteDraftSoFar: existingDraft,
    requestedMaxOutputTokens: plan.maxOutputTokens,
    rewriteInstructions,
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.primaryModel,
    walletConfig,
  });

  if (!bundle.canGenerate) {
    const msg = (bundle.inspectorOnly.criticalBlockers || []).map((b) => b.message).join(' | ');
    return { ok: false, errorType: 'critical_contradiction', error: `Continuación de reescritura bloqueada: ${msg}` };
  }

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
    hasPriorUnknownCost,
  });
  if (!budget.allowed) {
    return { ok: false, errorType: 'budget_blocked', reason: budget.reason, error: budget.message };
  }

  const maxOutputTokens = bundle.modelBound.maxOutputTokens;
  const result = await provider.generate({
    systemPrompt: bundle.modelBound.systemPrompt,
    userPrompt: bundle.modelBound.userPrompt,
    maxOutputTokens,
    temperature: 1.0,
    reasoningEffort: bundle.modelBound.reasoningEffort || '',
    signal,
  });

  const usageRec = await recordUsageEvent({
    projectId,
    operation: 'chapter_rewrite',
    provider: provider.name,
    model: provider.config?.model || bundle.modelBound.modelId,
    role: 'primary',
    status: result.ok ? 'ok' : (result.errorType || 'error'),
    errorType: result.errorType || null,
    estimatedInputTokens: bundle.modelBound.estimatedInputTokens,
    estimatedOutputTokens: bundle.modelBound.estimatedOutputTokens,
    authorizedMaxOutputTokens: maxOutputTokens,
    conservativeEstimatedCostUsd: bundle.modelBound.costEstimate?.costUsd ?? null,
    providerUsage: result.usage || null,
    walletConfig,
  });

  const charge = getCumulativeChargeFromUsage(usageRec, bundle.modelBound.costEstimate?.costUsd ?? null);
  const nextSpentUsd = charge.unknown ? spentSoFarUsd : Number((spentSoFarUsd + charge.knownUsd).toFixed(6));
  const nextHasUnknown = Boolean(hasPriorUnknownCost || charge.unknown);

  if (!result.ok) {
    return {
      ok: false,
      errorType: result.errorType || 'http',
      error: result.errorMessage || 'No se pudo continuar la reescritura.',
      cumulativeSpentUsd: nextSpentUsd,
      hasPriorUnknownCost: nextHasUnknown,
    };
  }
  const addition = String(result.text || '').trim();
  if (isLikelyInvalidProse(addition)) {
    return { ok: false, error: 'La continuación no devolvió prosa válida; tu borrador parcial sigue intacto.', cumulativeSpentUsd: nextSpentUsd, hasPriorUnknownCost: nextHasUnknown };
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
    snapshotHash: bundle.snapshotHash,
    usage: result.usage || null,
    cumulativeSpentUsd: nextSpentUsd,
    hasPriorUnknownCost: nextHasUnknown,
  };
}

/**
 * Co-escritura: reescribe ÚNICAMENTE el pasaje seleccionado `[startOffset, endOffset]`
 * preservando el texto anterior y posterior exactamente intactos, con control de revisión
 * (`baseContentHash`) contra ediciones concurrentes.
 */
export async function rewriteSelectedPassage(chapter, {
  startOffset = 0,
  endOffset = 0,
  rewriteInstructions = '',
  targetSceneId = null,
  spentSoFarUsd = 0,
  hasPriorUnknownCost = false,
  signal,
  provider: customProvider = null,
} = {}) {
  const fullText = String(chapter?.content || '');
  const s = Math.max(0, Math.min(fullText.length, Math.floor(Number(startOffset) || 0)));
  const e = Math.max(s, Math.min(fullText.length, Math.floor(Number(endOffset) || 0)));
  const selectedPassage = fullText.slice(s, e);
  if (!selectedPassage.trim()) {
    return { ok: false, error: 'Selecciona primero un pasaje con texto para reescribirlo.' };
  }

  const surroundingBefore = fullText.slice(0, s);
  const surroundingAfter = fullText.slice(e);
  const baseContentHash = contentFingerprint(fullText);
  const projectId = chapter?.projectId || db.getActiveProjectId();
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'primary');

  const bundle = await assembleOperationContext({
    projectId,
    operation: 'passage_rewrite',
    role: 'primary',
    targetChapterId: chapter?.id || null,
    targetChapterOrder: chapter?.order ?? null,
    targetSceneId,
    chapterTitle: chapter?.title || '',
    selectedPassage,
    surroundingBefore,
    surroundingAfter,
    rewriteInstructions,
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.primaryModel,
    walletConfig,
  });

  if (!bundle.canGenerate) {
    const msg = (bundle.inspectorOnly.criticalBlockers || []).map((b) => b.message).join(' | ');
    return { ok: false, errorType: 'critical_contradiction', error: `Reescritura de pasaje bloqueada por contradicciones críticas: ${msg}` };
  }

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
    hasPriorUnknownCost,
  });
  if (!budget.allowed) {
    return { ok: false, errorType: 'budget_blocked', reason: budget.reason, error: budget.message };
  }

  const maxOutputTokens = bundle.modelBound.maxOutputTokens;
  const result = await provider.generate({
    systemPrompt: bundle.modelBound.systemPrompt,
    userPrompt: bundle.modelBound.userPrompt,
    maxOutputTokens,
    temperature: 0.9,
    reasoningEffort: bundle.modelBound.reasoningEffort || '',
    signal,
  });

  await recordUsageEvent({
    projectId,
    operation: 'passage_rewrite',
    provider: provider.name,
    model: provider.config?.model || bundle.modelBound.modelId,
    role: 'primary',
    status: result.ok ? 'ok' : (result.errorType || 'error'),
    errorType: result.errorType || null,
    estimatedInputTokens: bundle.modelBound.estimatedInputTokens,
    estimatedOutputTokens: bundle.modelBound.estimatedOutputTokens,
    authorizedMaxOutputTokens: maxOutputTokens,
    conservativeEstimatedCostUsd: bundle.modelBound.costEstimate?.costUsd ?? null,
    providerUsage: result.usage || null,
    walletConfig,
  });

  if (!result.ok) {
    return { ok: false, errorType: result.errorType || 'http', error: result.errorMessage || 'No se pudo reescribir el pasaje.' };
  }
  const replacement = String(result.text || '').trim();
  if (!replacement) {
    return { ok: false, error: 'El modelo devolvió un reemplazo vacío; el pasaje original no cambió.' };
  }

  const mergedContent = surroundingBefore + replacement + surroundingAfter;
  return {
    ok: true,
    originalPassage: selectedPassage,
    replacementPassage: replacement,
    surroundingBefore,
    surroundingAfter,
    mergedContent,
    startOffset: s,
    endOffset: e,
    baseContentHash,
    snapshotHash: bundle.snapshotHash,
    usage: result.usage || null,
  };
}

/**
 * Aplica de forma segura un reemplazo de pasaje verificando que el capítulo
 * no cambió de forma concurrente desde `baseContentHash`.
 */
export async function applySafePassageReplacement(chapterId, {
  mergedContent,
  baseContentHash,
  projectId = '',
  saveAsAlternativeOnConflict = false,
} = {}) {
  const pid = projectId || db.getActiveProjectId();
  const scope = { projectId: pid };
  const current = await db.get('chapters', chapterId, scope);
  if (!current) throw new Error('No se encontró el capítulo.');
  const currentHash = contentFingerprint(current.content || '');
  if (baseContentHash && currentHash !== baseContentHash) {
    if (!saveAsAlternativeOnConflict) {
      return {
        ok: false,
        conflict: true,
        currentHash,
        baseContentHash,
        message: 'El capítulo cambió mientras se reescribía el pasaje. No se sobrescribió el texto para proteger tus ediciones; guarda como alternativa o vuelve a aplicar.',
      };
    }
    const alt = {
      ...structuredClone(current),
      id: db.uid(),
      title: `${current.title} (alternativa de co-escritura)`,
      content: mergedContent,
      wordCount: wordCount(mergedContent),
      branchRole: 'alternative',
      branchGroupId: current.branchGroupId || current.id,
      variantLabel: 'Alternativa · conflicto resuelto',
      updatedAt: new Date().toISOString(),
    };
    await db.put('chapters', alt, scope);
    return { ok: true, savedAsAlternative: true, chapter: alt };
  }

  const versions = [...(current.versions || []), {
    content: current.content,
    wordCount: current.wordCount || wordCount(current.content || ''),
    savedAt: new Date().toISOString(),
    note: 'Antes de reescritura de pasaje (co-escritura)',
  }].slice(-12);

  const updated = {
    ...current,
    content: mergedContent,
    wordCount: wordCount(mergedContent),
    versions,
    updatedAt: new Date().toISOString(),
  };
  await db.put('chapters', updated, scope);
  await markChapterMemoriesStale(chapterId, {
    projectId: pid,
    reason: 'passage_rewritten',
    chapterRevision: contentFingerprint(updated.content),
  });
  return { ok: true, conflict: false, chapter: updated };
}
