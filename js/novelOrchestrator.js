// novelOrchestrator.js — Novel Mode (Generación Orquestada por escenas/actos)
// para capítulos largos de 3,000 / 5,000 / 7,000 palabras o extensión personalizada.
//
// Invariantes no negociables:
// - Usa el Motor de Contexto Unificado (`js/contextEngine.js`) en cada paso.
// - Divulga ANTES de iniciar: número máximo de solicitudes, tokens estimados,
//   costo total estimado (o `costo desconocido`) y límite de gasto autorizado.
// - Pasa un traspaso continuo de estado de escena (POV, ubicación física, posiciones,
//   impulso emocional, contexto de diálogo, tensión sin resolver y cola exacta) para
//   producir UN capítulo continuo, nunca cuentos cortos independientes ni resúmenes.
// - Persiste cada bloque borrador completado en IndexedDB ANTES de iniciar el siguiente.
// - Soporta pausa, reanudación y cancelación en cualquier momento.
// - Se detiene automáticamente al alcanzar el límite autorizado de solicitudes o gasto.
// - CERO reintentos pagados silenciosos y CERO fallback silencioso de modelo.

import { db } from './db.js';
import { wordCount } from './utils.js';
import { assembleOperationContext } from './contextEngine.js';
import { getProviderForRole, getModelOutputLimit } from './providers/index.js';
import {
  getWalletConfig,
  checkGenerationBudget,
  calculateConservativeRequestCost,
  estimateTokensFromText,
  estimateOutputTokensForWords,
  recordUsageEvent,
  getCumulativeChargeFromUsage,
} from './inkyWallet.js';

function cleanString(value) {
  return String(value ?? '').trim();
}

/**
 * Construye un plan ligero y editable de escenas/actos a partir de la extensión objetivo
 * (3,000 / 5,000 / 7,000 / personalizado), el `scenePlan` de la autora o el Brief aprobado.
 */
export function buildDefaultOrchestrationPlan({
  targetWords = 5000,
  instructions = '',
  scenePlan = [],
  requiredEnding = '',
  approvedBrief = null,
} = {}) {
  const totalWords = Math.max(800, Math.floor(Number(targetWords) || 5000));
  const rawBeats = Array.isArray(scenePlan) && scenePlan.length
    ? scenePlan.map(cleanString).filter(Boolean)
    : [];

  let desiredSteps;
  if (totalWords <= 3200) desiredSteps = 2;
  else if (totalWords <= 5500) desiredSteps = 3;
  else if (totalWords <= 7800) desiredSteps = 4;
  else desiredSteps = Math.min(8, Math.ceil(totalWords / 1800));

  const steps = [];
  if (rawBeats.length) {
    const stepCount = Math.min(desiredSteps, Math.max(2, rawBeats.length));
    const perStep = Math.ceil(rawBeats.length / stepCount);
    for (let i = 0; i < stepCount; i += 1) {
      const slice = rawBeats.slice(i * perStep, (i + 1) * perStep);
      if (!slice.length) continue;
      steps.push({
        id: `step_${i + 1}`,
        title: `Escena / Tramo ${i + 1}`,
        focus: slice.join(' → '),
        targetWords: Math.round(totalWords / stepCount),
        status: 'pending',
      });
    }
  } else {
    const defaultArcLabels = desiredSteps === 2
      ? [
          'Apertura inmersiva, establecimiento de escena y desarrollo de la tensión central',
          requiredEnding
            ? `Escalada orgánica, consecuencias emocionales y llegada al cierre: ${requiredEnding}`
            : 'Escalada orgánica, consecuencias emocionales y cierre natural del capítulo',
        ]
      : desiredSteps === 3
        ? [
            'Apertura inmersiva y anclaje de POV, lugar, voces y situación inmediata',
            'Desarrollo intermedio: diálogo con subtexto, reacciones vivas y profundización del conflicto',
            requiredEnding
              ? `Clímax emocional, resonancia en la sala/escena y cierre pedido: ${requiredEnding}`
              : 'Clímax emocional, resonancia entre personajes y cierre natural del capítulo',
          ]
        : [
            'Apertura inmersiva y continuidad exacta con la escena anterior',
            'Primera escalada: fricciones, humor/subtexto y evolución de dinámicas',
            'Nudo dramático: complicación principal y consecuencias interpersonales',
            requiredEnding
              ? `Resolución del arco del capítulo y cierre pedido: ${requiredEnding}`
              : 'Resolución del arco del capítulo y cierre resonante sin forzar cliffhanger',
          ];

    for (let i = 0; i < desiredSteps; i += 1) {
      const label = defaultArcLabels[i] || `Desarrollo continuo — tramo ${i + 1}`;
      steps.push({
        id: `step_${i + 1}`,
        title: `Tramo ${i + 1}`,
        focus: approvedBrief?.objective && i === 0 ? `${label} (${approvedBrief.objective.slice(0, 140)})` : label,
        targetWords: Math.round(totalWords / desiredSteps),
        status: 'pending',
      });
    }
  }

  // Ajustar el último tramo para que sume exactamente totalWords
  if (steps.length) {
    const sumBeforeLast = steps.slice(0, -1).reduce((a, s) => a + s.targetWords, 0);
    steps[steps.length - 1].targetWords = Math.max(400, totalWords - sumBeforeLast);
  }
  return steps;
}

/**
 * Extrae el traspaso continuo de estado de escena desde el borrador acumulado
 * para evitar reinicios de atmósfera, resúmenes artificiales o cortes bruscos.
 */
export function extractSceneStateHandoff(accumulatedText, {
  pov = '',
  physicalLocation = '',
  characterPositions = '',
  emotionalMomentum = '',
  unresolvedTension = '',
} = {}) {
  const text = cleanString(accumulatedText);
  const paragraphs = text ? text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : [];
  const lastParagraph = paragraphs[paragraphs.length - 1] || '';
  const prevParagraph = paragraphs[paragraphs.length - 2] || '';
  const dialogueTail = [prevParagraph, lastParagraph]
    .filter((p) => /["“”«»—]/.test(p))
    .join(' / ')
    .slice(-420);

  return {
    pov: cleanString(pov) || 'Preserve exact POV and narrative distance from the final paragraphs.',
    physicalLocation: cleanString(physicalLocation) || 'Preserve exact physical setting and room/screen positioning from the final paragraphs.',
    characterPositions: cleanString(characterPositions) || 'Keep every character in their exact current physical posture and position.',
    emotionalMomentum: cleanString(emotionalMomentum) || 'Carry the live emotional tension directly forward without resetting atmosphere or summarizing.',
    dialogueContext: dialogueTail || 'Continue directly from the last narrative beat without recap.',
    unresolvedTension: cleanString(unresolvedTension) || 'Keep active questions, subtext, and immediate consequences alive.',
    exactEndingTail: lastParagraph.slice(-500),
  };
}

/**
 * Divulgación previa (0 tokens) del presupuesto máximo de Novel Mode antes de autorizar
 * la generación orquestada: número máximo de solicitudes, tokens estimados, costo estimado
 * (o `costo desconocido`) y límite configurado en Inky Wallet.
 */
export async function previewOrchestrationBudget({
  projectId = '',
  chapterId = null,
  chapterTitle = '',
  instructions = '',
  targetWords = 5000,
  requiredEnding = '',
  scenePlan = [],
  orchestrationPlan = null,
  allowedCast = '',
  roomCast = '',
  onscreenCast = '',
  forbiddenCast = '',
  documentIds = null,
  reactionMode = true,
  activeBriefId = null,
  walletConfig: overrideWallet = null,
} = {}) {
  const pid = projectId || db.getActiveProjectId();
  const walletConfig = overrideWallet || await getWalletConfig();
  const plan = Array.isArray(orchestrationPlan) && orchestrationPlan.length
    ? orchestrationPlan
    : buildDefaultOrchestrationPlan({ targetWords, instructions, scenePlan, requiredEnding });

  const firstStepBundle = await assembleOperationContext({
    projectId: pid,
    operation: 'novel_orchestrated',
    role: 'primary',
    targetChapterId: chapterId,
    activeBriefId,
    documentIds,
    chapterTitle,
    instructions,
    targetWords,
    requiredEnding,
    scenePlan,
    allowedCast,
    roomCast,
    onscreenCast,
    forbiddenCast,
    reactionMode,
    orchestrationStep: {
      stepIndex: 0,
      totalSteps: plan.length,
      focus: plan[0]?.focus || '',
      targetWords: plan[0]?.targetWords || 1500,
      isFinalStep: plan.length === 1,
      remainingObjectives: plan.slice(1).map((s) => s.focus),
    },
    walletConfig,
  });

  const baseInputTokens = firstStepBundle.modelBound.estimatedInputTokens;
  const stablePrefixTokens = estimateTokensFromText(firstStepBundle.modelBound.stablePrompt || '');
  const modelCap = getModelOutputLimit(firstStepBundle.modelBound.providerId, firstStepBundle.modelBound.modelId);
  const walletCap = Number(walletConfig?.maxOutputTokensPerRequest) || modelCap;
  const effectiveCap = Math.min(modelCap, walletCap);

  let totalEstInputTokens = 0;
  let totalEstOutputTokens = 0;
  let totalAuthorizedOutputTokens = 0;
  let accumulatedGrowthTokens = 0;
  let cumulativeMaxCostUsd = 0;
  let anyUnknownCost = false;
  let anyFree = true;
  let pricingSource = null;
  let pricingLastUpdated = '';

  for (let i = 0; i < plan.length; i += 1) {
    const segWords = plan[i].targetWords || 1500;
    const segEstOut = estimateOutputTokensForWords(segWords);
    const segAuthOut = Math.max(256, Math.min(effectiveCap, segEstOut + 800));
    const stepInputTokens = baseInputTokens + accumulatedGrowthTokens;
    const stepCost = calculateConservativeRequestCost({
      providerId: firstStepBundle.modelBound.providerId,
      modelId: firstStepBundle.modelBound.modelId,
      inputTokens: stepInputTokens,
      authorizedMaxOutputTokens: segAuthOut,
      stablePrefixTokens,
      cacheStrategy: 'reuse',
      reasoningEffort: firstStepBundle.modelBound.reasoningEffort || '',
      walletConfig,
    });

    totalEstInputTokens += stepInputTokens;
    totalEstOutputTokens += Math.min(segAuthOut, segEstOut);
    totalAuthorizedOutputTokens += segAuthOut;
    accumulatedGrowthTokens += segAuthOut;

    if (stepCost.costStatus === 'unknown' || stepCost.costUsd === null) {
      anyUnknownCost = true;
      anyFree = false;
    } else {
      cumulativeMaxCostUsd += stepCost.costUsd;
      if (stepCost.costStatus !== 'free') anyFree = false;
      pricingSource = pricingSource || stepCost.pricingSource;
      pricingLastUpdated = pricingLastUpdated || stepCost.pricingLastUpdated;
    }
  }

  const totalCost = anyUnknownCost
    ? {
        costStatus: 'unknown',
        costUsd: null,
        displayCost: 'costo desconocido',
        basis: 'conservative_authorized_ceiling',
        authorizedMaxOutputTokensTotal: totalAuthorizedOutputTokens,
        includesReasoningTokenCeiling: true,
        pricingSource: null,
        pricingLastUpdated: null,
      }
    : {
        costStatus: anyFree ? 'free' : 'estimated',
        costUsd: Number(cumulativeMaxCostUsd.toFixed(6)),
        displayCost: anyFree ? '$0.00 (gratuito)' : `hasta $${cumulativeMaxCostUsd.toFixed(4)} USD (techo estimado)`,
        basis: 'conservative_authorized_ceiling',
        authorizedMaxOutputTokensTotal: totalAuthorizedOutputTokens,
        includesReasoningTokenCeiling: true,
        pricingSource,
        pricingLastUpdated,
      };

  const budgetCheck = checkGenerationBudget({
    estimatedAdditionalUsd: totalCost.costUsd,
    spentSoFarUsd: 0,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
  });

  return {
    canGenerate: firstStepBundle.canGenerate && budgetCheck.allowed,
    blockedByCriticalIssues: !firstStepBundle.canGenerate,
    criticalBlockers: firstStepBundle.inspectorOnly.criticalBlockers || [],
    maxRequests: plan.length,
    plan,
    providerId: firstStepBundle.modelBound.providerId,
    modelId: firstStepBundle.modelBound.modelId,
    estimatedInputTokensTotal: totalEstInputTokens,
    estimatedOutputTokensTotal: totalEstOutputTokens,
    authorizedOutputTokensTotal: totalAuthorizedOutputTokens,
    costEstimate: totalCost,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    withinBudget: budgetCheck.allowed,
    budgetReason: budgetCheck.reason,
    budgetMessage: budgetCheck.message || '',
    snapshotHash: firstStepBundle.snapshotHash,
    contextBundle: firstStepBundle,
  };
}

/**
 * Ejecuta la generación orquestada de Novel Mode paso a paso:
 * - Persiste cada bloque borrador completado en `generationState` ANTES del siguiente paso.
 * - Respeta pausa (`shouldPause`), cancelación (`signal`), límite de solicitudes (`maxRequests`)
 *   y límite de gasto (`maxGenerationSpendUsd`).
 * - Nunca sobrescribe un capítulo aprobado: todo queda en borrador hasta aprobación explícita.
 */
export async function runOrchestratedGeneration({
  projectId = '',
  chapterId,
  chapterTitle = '',
  instructions = '',
  targetWords = 5000,
  requiredEnding = '',
  scenePlan = [],
  orchestrationPlan = null,
  allowedCast = '',
  roomCast = '',
  onscreenCast = '',
  forbiddenCast = '',
  documentIds = null,
  reactionMode = true,
  activeBriefId = null,
  maxRequests = null,
  maxSpendUsd = null,
  provider: customProvider = null,
  signal = null,
  shouldPause = null,
  onProgress = null,
} = {}) {
  if (!chapterId) throw new Error('Se requiere un chapterId para ejecutar Novel Mode.');
  const pid = projectId || db.getActiveProjectId();
  const scope = { projectId: pid };
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'primary');
  const spendCap = maxSpendUsd !== null && maxSpendUsd !== undefined ? Number(maxSpendUsd) : walletConfig.maxGenerationSpendUsd;

  let state = await db.get('generationState', chapterId, scope);
  const effectivePlan = Array.isArray(state?.orchestrationPlan) && state.orchestrationPlan.length
    ? state.orchestrationPlan
    : (Array.isArray(orchestrationPlan) && orchestrationPlan.length
      ? orchestrationPlan.map((s, idx) => ({ ...s, id: s.id || `step_${idx + 1}`, status: s.status || 'pending' }))
      : buildDefaultOrchestrationPlan({ targetWords, instructions, scenePlan, requiredEnding }));

  const requestLimit = Math.max(1, Number(maxRequests) || effectivePlan.length);

  if (!state) {
    state = {
      id: chapterId,
      chapterId,
      projectId: pid,
      chapterTitle,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      documentIds,
      reactionMode,
      activeBriefId,
      generationMode: 'novel_orchestrated',
      orchestrationPlan: effectivePlan,
      orchestrationStepIndex: 0,
      orchestrationBlocks: [],
      requestsExecuted: 0,
      estimatedSpentUsd: 0,
      actualSpentUsd: 0,
      accumulatedText: '',
      pendingText: '',
      pendingWarnings: [],
      wordsSoFar: 0,
      blocksDone: 0,
      status: 'in_progress',
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.put('generationState', state, scope);
  } else {
    state.status = 'in_progress';
    state.generationMode = 'novel_orchestrated';
    state.orchestrationPlan = effectivePlan;
    state.updatedAt = new Date().toISOString();
    await db.put('generationState', state, scope);
  }

  for (let i = state.orchestrationStepIndex || 0; i < effectivePlan.length; i += 1) {
    if (signal?.aborted) {
      state.status = 'paused_manual';
      state.lastError = { type: 'aborted', message: 'Novel Mode cancelado por la autora. Todos los tramos completados siguen guardados como borrador.', at: new Date().toISOString() };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'paused', state });
      return state;
    }
    if (typeof shouldPause === 'function' && shouldPause()) {
      state.status = 'paused_manual';
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'paused', state });
      return state;
    }
    if ((state.requestsExecuted || 0) >= requestLimit) {
      state.status = 'paused_budget';
      state.lastError = { type: 'request_limit', message: `Límite autorizado de solicitudes alcanzado (${requestLimit}). Revisa el borrador acumulado antes de continuar.`, at: new Date().toISOString() };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'budget_stop', state });
      return state;
    }

    const step = effectivePlan[i];
    const handoff = state.accumulatedText
      ? extractSceneStateHandoff(state.accumulatedText, {
          pov: step.pov || '',
          physicalLocation: step.location || '',
          unresolvedTension: step.unresolvedTension || '',
        })
      : {};

    const bundle = await assembleOperationContext({
      projectId: pid,
      operation: 'novel_orchestrated',
      role: 'primary',
      targetChapterId: chapterId,
      activeBriefId: state.activeBriefId || activeBriefId,
      documentIds: state.documentIds,
      chapterTitle: state.chapterTitle,
      instructions: state.instructions,
      targetWords: state.targetWords,
      requiredEnding: state.requiredEnding,
      scenePlan: state.scenePlan,
      allowedCast: state.allowedCast,
      roomCast: state.roomCast,
      onscreenCast: state.onscreenCast,
      forbiddenCast: state.forbiddenCast,
      reactionMode: state.reactionMode,
      chapterSoFar: state.accumulatedText,
      wordsSoFar: state.wordsSoFar,
      orchestrationStep: {
        stepIndex: i,
        totalSteps: effectivePlan.length,
        focus: step.focus,
        targetWords: step.targetWords,
        isFinalStep: i === effectivePlan.length - 1,
        remainingObjectives: effectivePlan.slice(i + 1).map((s) => s.focus),
      },
      sceneHandoff: handoff,
      providerId: provider.name,
      modelId: provider.config?.model || walletConfig.primaryModel,
      walletConfig,
    });

    if (!bundle.canGenerate) {
      const msg = (bundle.inspectorOnly.criticalBlockers || []).map((b) => b.message).join(' | ');
      state.status = 'paused_error';
      state.lastError = { type: 'critical_contradiction', message: `Generación bloqueada por contradicciones críticas: ${msg}`, at: new Date().toISOString() };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state });
      return state;
    }

    const spentSoFar = (state.actualSpentUsd || 0) + (state.estimatedSpentUsd || 0);
    const budgetCheck = checkGenerationBudget({
      estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
      spentSoFarUsd: spentSoFar,
      maxGenerationSpendUsd: spendCap,
      allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
      hasPriorUnknownCost: (state.unknownCostCalls || 0) > 0,
    });
    if (!budgetCheck.allowed) {
      state.status = 'paused_budget';
      state.lastError = { type: 'budget_blocked', reason: budgetCheck.reason, message: budgetCheck.message, at: new Date().toISOString() };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'budget_stop', state });
      return state;
    }

    onProgress?.({ phase: 'requesting_step', stepIndex: i, totalSteps: effectivePlan.length, state });

    const maxOutputTokens = bundle.modelBound.maxOutputTokens;
    const result = await provider.generate({
      systemPrompt: bundle.modelBound.systemPrompt,
      stableSystemPrompt: bundle.modelBound.stablePrompt,
      dynamicSystemPrompt: bundle.modelBound.dynamicPrompt,
      cacheStrategy: bundle.modelBound.cacheStrategy || 'reuse',
      cacheKey: 'inky-paws-novel:' + String(chapterId).slice(0, 40),
      userPrompt: bundle.modelBound.userPrompt,
      maxOutputTokens,
      temperature: 1.0,
      reasoningEffort: bundle.modelBound.reasoningEffort || '',
      signal,
    });

    const usageRecord = await recordUsageEvent({
      projectId: pid,
      operation: 'novel_orchestrated',
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

    state.requestsExecuted = (state.requestsExecuted || 0) + 1;
    const charge = getCumulativeChargeFromUsage(usageRecord, bundle.modelBound.costEstimate?.costUsd ?? null);
    if (charge.unknown) {
      state.unknownCostCalls = (state.unknownCostCalls || 0) + 1;
    } else if (charge.source === 'actual') {
      state.actualSpentUsd = Number(((state.actualSpentUsd || 0) + charge.knownUsd).toFixed(6));
    } else {
      state.estimatedSpentUsd = Number(((state.estimatedSpentUsd || 0) + charge.knownUsd).toFixed(6));
    }

    if (!result.ok) {
      state.status = result.errorType === 'aborted' ? 'paused_manual' : (result.errorType === 'quota' ? 'paused_quota' : 'paused_error');
      state.lastError = { type: result.errorType || 'http', message: result.errorMessage || 'Error en tramo de Novel Mode.', at: new Date().toISOString() };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state, error: result });
      return state;
    }

    // Persistir inmediatamente el tramo completado ANTES de solicitar el siguiente
    const segmentText = cleanString(result.text);
    const blockEntry = {
      stepId: step.id,
      stepIndex: i,
      title: step.title,
      focus: step.focus,
      text: segmentText,
      words: wordCount(segmentText),
      snapshotHash: bundle.snapshotHash,
      usage: result.usage || null,
      completedAt: new Date().toISOString(),
    };
    state.orchestrationBlocks = [...(state.orchestrationBlocks || []), blockEntry];
    state.accumulatedText = [state.accumulatedText, segmentText].filter(Boolean).join('\n\n');
    state.pendingText = state.accumulatedText;
    state.wordsSoFar = wordCount(state.accumulatedText);
    state.blocksDone = state.orchestrationBlocks.length;
    effectivePlan[i] = { ...step, status: 'completed', actualWords: blockEntry.words };
    state.orchestrationPlan = effectivePlan;
    state.orchestrationStepIndex = i + 1;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    await db.put('generationState', state, scope);
    onProgress?.({ phase: 'step_completed', stepIndex: i, totalSteps: effectivePlan.length, block: blockEntry, state });
  }

  // Al terminar todos los tramos, el capítulo queda en BORRADOR (`awaiting_review`) para revisión de la autora
  state.status = 'awaiting_review';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState', state, scope);
  onProgress?.({ phase: 'completed_draft', state });
  return state;
}
