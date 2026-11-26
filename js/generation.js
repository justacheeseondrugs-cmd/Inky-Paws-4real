// generation.js — Motor de generación de capítulos (Capítulo completo y Por bloques)
// conectado 100% al Motor de Contexto Unificado (`js/contextEngine.js`) e Inky Wallet
// (`js/inkyWallet.js`).
//
// Invariantes preservados:
// - El estado de generación (`generationState`) se persiste en IndexedDB tras cada bloque
//   exitoso, nunca antes; el texto generado siempre comienza como BORRADOR (`awaiting_review`)
//   hasta aprobación explícita de la autora.
// - Cuarentena estricta ante personajes prohibidos o salida truncada (nunca descarta texto
//   ya pagado ni lo auto-incorpora al capítulo).
// - Verificación de frescura del Context Inspector (`expectedSnapshotHash`) y bloqueo duro
//   ante contradicciones críticas de universo (`!bundle.canGenerate`).
// - Control de presupuesto por generación (`checkGenerationBudget`), límite de tokens de
//   salida por solicitud y registro local en `usageLog` (sin claves API).
// - CERO llamadas silenciosas en segundo plano, CERO reintentos pagados silenciosos y
//   CERO fallback silencioso de modelo.

import { db } from './db.js';
import { getProviderForRole, getModelOutputLimit } from './providers/index.js';
import { wordCount, contentFingerprint } from './utils.js';
import { markChapterMemoriesStale } from './memoryEngine.js';
import { assembleOperationContext } from './contextEngine.js';
import { markChapterBriefConsumed } from './creativeChat.js';
import { getWalletConfig, checkGenerationBudget, recordUsageEvent, getCumulativeChargeFromUsage } from './inkyWallet.js';

const DEFAULT_BLOCK_WORDS = 900;
let inFlightCount = 0;

export function hasInFlightGeneration() {
  return inFlightCount > 0;
}

export function findForbiddenCastLeaks(text, forbiddenCast) {
  const source = String(text || '');
  if (!source) return [];
  const forbidden = String(forbiddenCast || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leaks = [];
  for (const name of forbidden) {
    const rx = new RegExp('(?<![\\p{L}\\p{N}_])' + escaped(name) + '(?![\\p{L}\\p{N}_])', 'iu');
    if (rx.test(source)) leaks.push(name);
  }
  return leaks;
}

function collectPendingWarnings({ text, forbiddenCast, truncated = false, finishReason = null }) {
  const warnings = [];
  const leaks = findForbiddenCastLeaks(text, forbiddenCast);
  if (leaks.length) {
    warnings.push({
      type: 'forbidden_cast',
      leaks,
      message: 'Este borrador incluye personajes prohibidos (' + leaks.join(', ') + '). Se guardó en cuarentena para no perder texto: edita o elimina esos nombres antes de aprobar, o descarta el bloque.',
    });
  }
  if (truncated) {
    warnings.push({
      type: 'truncated',
      finishReason: finishReason || 'length',
      message: 'La respuesta alcanzó el límite de tokens de salida y pudo quedar incompleta. Revisa el final y usa «Add an ending» o edítalo antes de aprobar.',
    });
  }
  return warnings;
}

async function trackInFlight(fn) {
  inFlightCount += 1;
  try {
    return await fn();
  } finally {
    inFlightCount = Math.max(0, inFlightCount - 1);
  }
}

export async function getActiveGenerationState(opts) {
  const all = await db.getAll('generationState', opts);
  return all.filter((g) => ['in_progress', 'awaiting_review', 'review_target_reached'].includes(g.status) || g.status?.startsWith('paused_'))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

export async function startOrResumeGeneration({
  chapterId,
  chapterTitle,
  instructions,
  targetWords,
  requiredEnding = '',
  scenePlan = [],
  sceneIndex,
  allowedCast = '',
  roomCast = '',
  onscreenCast = '',
  forbiddenCast = '',
  documentIds = null,
  reactionMode = true,
  blockNotes = '',
  generationIntent = 'continue',
  generationMode = 'full_chapter',
  activeBriefId = null,
  targetSceneId = null,
  characterVersion = 'room',
  expectedSnapshotHash = null,
  projectId = '',
  provider = null,
  signal,
  onProgress,
  shouldStop,
}) {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  let state = await db.get('generationState', chapterId, scope);
  if (!state) {
    state = {
      id: chapterId,
      chapterId,
      projectId: scope.projectId,
      chapterTitle,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      sceneIndex: 0,
      allowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      documentIds,
      reactionMode,
      blockNotes,
      generationIntent,
      generationMode,
      activeBriefId,
      targetSceneId,
      characterVersion,
      pendingText: '',
      pendingWarnings: [],
      accumulatedText: '',
      wordsSoFar: 0,
      blocksDone: 0,
      estimatedSpentUsd: 0,
      actualSpentUsd: 0,
      status: 'in_progress',
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.put('generationState', state, scope);
  } else {
    if (state.status === 'awaiting_review') return state;
    state.projectId = state.projectId || scope.projectId;
    state.status = 'in_progress';
    state.instructions = instructions || state.instructions;
    if (roomCast) state.roomCast = roomCast;
    if (onscreenCast) state.onscreenCast = onscreenCast;
    if (allowedCast) state.allowedCast = allowedCast;
    if (Number.isInteger(sceneIndex)) state.sceneIndex = sceneIndex;
    state.blockNotes = blockNotes || '';
    state.generationIntent = generationIntent || 'continue';
    state.generationMode = generationMode || state.generationMode || 'blocks';
    if (activeBriefId !== null) state.activeBriefId = activeBriefId;
    await db.put('generationState', state, scope);
  }

  return runGenerationLoop(state, onProgress, shouldStop, { signal, provider, expectedSnapshotHash });
}

export async function runGenerationLoop(state, onProgress, shouldStop, { signal, provider: customProvider = null, expectedSnapshotHash = null } = {}) {
  return trackInFlight(async () => {
    const scope = { projectId: state.projectId || db.getActiveProjectId() };
    const [settings, walletConfig] = await Promise.all([
      db.get('settings', 'main'),
      getWalletConfig(),
    ]);
    const safeSettings = settings || {};
    const blockWords = safeSettings.blockWordSize || DEFAULT_BLOCK_WORDS;
    const provider = customProvider || getProviderForRole(safeSettings, walletConfig, 'primary');

    const remaining = Math.max(1, (state.targetWords || 5000) - (state.wordsSoFar || 0));
    const intent = state.generationIntent || 'continue';
    const generationMode = state.generationMode || 'blocks';
    const fullChapterMode = generationMode === 'full_chapter';
    const normalBlockTarget = fullChapterMode
      ? remaining
      : Math.min(blockWords, Math.max(remaining, Math.round(blockWords * 0.65)));
    const thisBlockTarget = intent === 'ending'
      ? Math.min(700, Math.max(250, Math.round(Math.min(blockWords, remaining) * 0.55)))
      : normalBlockTarget;

    const operation = fullChapterMode ? 'full_chapter' : 'manual_block';

    // Ensamblar contexto ÚNICAMENTE a través del Motor de Contexto Unificado
    const bundle = await assembleOperationContext({
      projectId: scope.projectId,
      operation,
      role: 'primary',
      targetChapterId: state.chapterId || null,
      targetSceneId: state.targetSceneId || null,
      characterVersion: state.characterVersion || 'room',
      activeBriefId: state.activeBriefId || null,
      documentIds: Array.isArray(state.documentIds) ? state.documentIds : null,
      chapterTitle: state.chapterTitle,
      instructions: state.instructions,
      targetWords: state.targetWords,
      blockTargetWords: thisBlockTarget,
      requiredEnding: state.requiredEnding,
      scenePlan: state.scenePlan || [],
      allowedCast: state.allowedCast || '',
      roomCast: state.roomCast || '',
      onscreenCast: state.onscreenCast || '',
      forbiddenCast: state.forbiddenCast || '',
      reactionMode: state.reactionMode !== false,
      blockNotes: state.blockNotes || '',
      generationIntent: intent,
      chapterSoFar: state.accumulatedText || '',
      wordsSoFar: state.wordsSoFar || 0,
      providerId: provider.name,
      modelId: provider.config?.model || walletConfig.primaryModel,
      walletConfig,
    });

    // 1. Verificar frescura si la autora hizo preview previo en Context Inspector
    if (expectedSnapshotHash && bundle.snapshotHash !== expectedSnapshotHash) {
      state.status = 'paused_error';
      state.lastError = {
        type: 'stale_preview',
        message: 'Los datos de la historia cambiaron después de previsualizar el contexto. Refresca «👀 Ver contexto» antes de generar.',
        at: new Date().toISOString(),
      };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state });
      return state;
    }

    // 2. Bloqueo duro ante contradicciones críticas del universo / PtS
    if (!bundle.canGenerate) {
      const details = (bundle.inspectorOnly.criticalBlockers || []).map((b) => b.message || b.title).join(' | ');
      state.status = 'paused_error';
      state.lastError = {
        type: 'critical_contradiction',
        message: `Generación bloqueada por contradicciones críticas: ${details}`,
        criticalBlockers: bundle.inspectorOnly.criticalBlockers,
        at: new Date().toISOString(),
      };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state });
      return state;
    }

    // 3. Control acumulativo de límite estimado local (Inky Wallet)
    const spentSoFar = (state.actualSpentUsd || 0) + (state.estimatedSpentUsd || 0);
    const budgetCheck = checkGenerationBudget({
      estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
      spentSoFarUsd: spentSoFar,
      maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
      allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
      hasPriorUnknownCost: (state.unknownCostCalls || 0) > 0,
    });
    if (!budgetCheck.allowed) {
      state.status = 'paused_budget';
      state.lastError = {
        type: 'budget_blocked',
        reason: budgetCheck.reason,
        message: budgetCheck.message,
        at: new Date().toISOString(),
      };
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state });
      return state;
    }

    onProgress?.({ phase: 'requesting', state, contextBundle: bundle });

    // El límite enviado al proveedor SIEMPRE coincide exactamente con el del Context Inspector
    const maxOutputTokens = bundle.modelBound.maxOutputTokens;

    const result = await provider.generate({
      systemPrompt: bundle.modelBound.systemPrompt,
      stableSystemPrompt: bundle.modelBound.stablePrompt,
      dynamicSystemPrompt: bundle.modelBound.dynamicPrompt,
      cacheStrategy: bundle.modelBound.cacheStrategy || 'reuse',
      cacheKey: 'inky-paws:' + String(state.chapterId || '').slice(0, 50),
      userPrompt: bundle.modelBound.userPrompt,
      maxOutputTokens,
      temperature: 1.0,
      reasoningEffort: bundle.modelBound.reasoningEffort || '',
      signal,
    });

    const usageRec = await recordUsageEvent({
      projectId: scope.projectId,
      operation,
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
    if (charge.unknown) {
      state.unknownCostCalls = (state.unknownCostCalls || 0) + 1;
    } else if (charge.source === 'actual') {
      state.actualSpentUsd = Number(((state.actualSpentUsd || 0) + charge.knownUsd).toFixed(6));
    } else {
      state.estimatedSpentUsd = Number(((state.estimatedSpentUsd || 0) + charge.knownUsd).toFixed(6));
    }
    state.lastSnapshotHash = bundle.snapshotHash;
    state.lastUsage = usageRec;

    if (!result.ok) {
      state.lastError = { type: result.errorType, message: result.errorMessage, at: new Date().toISOString() };
      if (result.errorType === 'quota') state.status = 'paused_quota';
      else if (result.errorType === 'network') state.status = 'paused_network';
      else if (result.errorType === 'busy') state.status = 'paused_busy';
      else if (result.errorType === 'aborted') state.status = 'paused_manual';
      else state.status = 'paused_error';
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state, error: result });
      return state;
    }

    const candidate = String(result.text || '').trim();
    const warnings = collectPendingWarnings({
      text: candidate,
      forbiddenCast: state.forbiddenCast,
      truncated: result.truncated === true,
      finishReason: result.finishReason || null,
    });
    state.pendingText = candidate;
    state.previousPendingText = '';
    state.pendingWarnings = warnings;
    state.status = 'awaiting_review';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    await db.put('generationState', state, scope);
    onProgress?.({ phase: 'block_ready', state, contextBundle: bundle });
    return state;
  });
}

export async function extendPendingBlockWithEnding(chapterId, editedText, endingStyle = 'natural', { projectId = '', signal, provider: customProvider = null } = {}) {
  return trackInFlight(async () => {
    const scope = { projectId: projectId || db.getActiveProjectId() };
    const state = await db.get('generationState', chapterId, scope);
    if (!state || state.status !== 'awaiting_review') throw new Error('No hay un bloque pendiente para completar.');
    const pending = String(editedText || state.pendingText || '').trim();
    if (wordCount(pending) < 15) throw new Error('El bloque es demasiado corto para añadirle un final.');

    const [settings, walletConfig] = await Promise.all([
      db.get('settings', 'main'),
      getWalletConfig(),
    ]);
    const safeSettings = settings || {};
    const blockWords = safeSettings.blockWordSize || DEFAULT_BLOCK_WORDS;
    const provider = customProvider || getProviderForRole(safeSettings, walletConfig, 'primary');
    const endingWords = Math.min(600, Math.max(250, Math.round(blockWords * 0.5)));
    const fullText = [state.accumulatedText, pending].filter(Boolean).join('\n\n');

    const bundle = await assembleOperationContext({
      projectId: scope.projectId,
      operation: 'continuation',
      role: 'primary',
      targetChapterId: state.chapterId || null,
      activeBriefId: state.activeBriefId || null,
      documentIds: Array.isArray(state.documentIds) ? state.documentIds : null,
      chapterTitle: state.chapterTitle,
      instructions: state.instructions,
      requiredEnding: state.requiredEnding,
      allowedCast: state.allowedCast || '',
      roomCast: state.roomCast || '',
      onscreenCast: state.onscreenCast || '',
      forbiddenCast: state.forbiddenCast || '',
      reactionMode: state.reactionMode !== false,
      generationIntent: 'ending',
      blockTargetWords: endingWords,
      chapterSoFar: fullText,
      wordsSoFar: wordCount(fullText),
      continuationInstruction: `Add an organic ending (style=${endingStyle}) without restarting or recapping.`,
      providerId: provider.name,
      modelId: provider.config?.model || walletConfig.primaryModel,
      walletConfig,
    });

    if (!bundle.canGenerate) {
      throw new Error('Bloqueado por contradicciones críticas de universo.');
    }

    const spentSoFar = (state.actualSpentUsd || 0) + (state.estimatedSpentUsd || 0);
    const budgetCheck = checkGenerationBudget({
      estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
      spentSoFarUsd: spentSoFar,
      maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
      allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
      hasPriorUnknownCost: (state.unknownCostCalls || 0) > 0,
    });
    if (!budgetCheck.allowed) {
      throw new Error(budgetCheck.message);
    }

    const maxOutputTokens = bundle.modelBound.maxOutputTokens;
    const result = await provider.generate({
      systemPrompt: bundle.modelBound.systemPrompt,
      cacheStrategy: 'off',
      userPrompt: bundle.modelBound.userPrompt,
      maxOutputTokens,
      temperature: 0.95,
      reasoningEffort: bundle.modelBound.reasoningEffort || '',
      signal,
    });

    const usageRec = await recordUsageEvent({
      projectId: scope.projectId,
      operation: 'continuation',
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
    if (charge.unknown) {
      state.unknownCostCalls = (state.unknownCostCalls || 0) + 1;
    } else if (charge.source === 'actual') {
      state.actualSpentUsd = Number(((state.actualSpentUsd || 0) + charge.knownUsd).toFixed(6));
    } else {
      state.estimatedSpentUsd = Number(((state.estimatedSpentUsd || 0) + charge.knownUsd).toFixed(6));
    }
    state.lastUsage = usageRec;

    if (!result.ok) {
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      throw new Error(result.errorMessage || 'No se pudo generar el final.');
    }

    const addition = String(result.text || '').trim();
    if (wordCount(addition) < 8) {
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      throw new Error('La IA devolvió un final demasiado corto. No se modificó el bloque.');
    }
    const combined = pending + '\n\n' + addition;
    state.previousPendingText = pending;
    state.pendingText = combined;
    state.pendingWarnings = collectPendingWarnings({
      text: combined,
      forbiddenCast: state.forbiddenCast,
      truncated: result.truncated === true,
      finishReason: result.finishReason || null,
    });
    state.status = 'awaiting_review';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    await db.put('generationState', state, scope);
    return state;
  });
}

export async function polishPendingBlock(chapterId, editedText, { projectId = '', signal, provider: customProvider = null } = {}) {
  return trackInFlight(async () => {
    const scope = { projectId: projectId || db.getActiveProjectId() };
    const state = await db.get('generationState', chapterId, scope);
    if (!state || state.status !== 'awaiting_review') throw new Error('No hay un borrador pendiente para editar.');
    const draft = String(editedText || state.pendingText || '').trim();
    if (wordCount(draft) < 80) throw new Error('El borrador es demasiado corto para un Editor Pass.');

    const [settings, walletConfig] = await Promise.all([
      db.get('settings', 'main'),
      getWalletConfig(),
    ]);
    const provider = customProvider || getProviderForRole(settings || {}, walletConfig, 'primary');

    const bundle = await assembleOperationContext({
      projectId: scope.projectId,
      operation: 'chapter_rewrite',
      role: 'primary',
      targetChapterId: state.chapterId || null,
      activeBriefId: state.activeBriefId || null,
      documentIds: Array.isArray(state.documentIds) ? state.documentIds : null,
      chapterTitle: state.chapterTitle,
      instructions: state.instructions,
      allowedCast: state.allowedCast || '',
      roomCast: state.roomCast || '',
      onscreenCast: state.onscreenCast || '',
      forbiddenCast: state.forbiddenCast || '',
      reactionMode: state.reactionMode !== false,
      originalChapterText: draft,
      requestedMaxOutputTokens: Math.round(wordCount(draft) * 4.0) + 1600,
      rewriteInstructions: 'EDITOR PASS: polish prose rhythm, voices, subtext, and ensemble collision while preserving the exact events, POV, factual content, and ending. Remove redundant emotional explanation.',
      providerId: provider.name,
      modelId: provider.config?.model || walletConfig.primaryModel,
      walletConfig,
    });

    if (!bundle.canGenerate) {
      throw new Error('Bloqueado por contradicciones críticas de universo.');
    }

    const spentSoFar = (state.actualSpentUsd || 0) + (state.estimatedSpentUsd || 0);
    const budgetCheck = checkGenerationBudget({
      estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
      spentSoFarUsd: spentSoFar,
      maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
      allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
      hasPriorUnknownCost: (state.unknownCostCalls || 0) > 0,
    });
    if (!budgetCheck.allowed) {
      throw new Error(budgetCheck.message);
    }

    const maxOutputTokens = bundle.modelBound.maxOutputTokens;
    const result = await provider.generate({
      systemPrompt: bundle.modelBound.systemPrompt,
      cacheStrategy: 'off',
      userPrompt: bundle.modelBound.userPrompt,
      maxOutputTokens,
      temperature: 0.85,
      reasoningEffort: bundle.modelBound.reasoningEffort || '',
      signal,
    });

    const usageRec = await recordUsageEvent({
      projectId: scope.projectId,
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
    if (charge.unknown) {
      state.unknownCostCalls = (state.unknownCostCalls || 0) + 1;
    } else if (charge.source === 'actual') {
      state.actualSpentUsd = Number(((state.actualSpentUsd || 0) + charge.knownUsd).toFixed(6));
    } else {
      state.estimatedSpentUsd = Number(((state.estimatedSpentUsd || 0) + charge.knownUsd).toFixed(6));
    }
    state.lastUsage = usageRec;

    if (!result.ok) {
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      throw new Error(result.errorMessage || 'No se pudo completar el Editor Pass.');
    }

    const revised = String(result.text || '').trim();
    if (wordCount(revised) < 60) {
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      throw new Error('El Editor Pass devolvió un texto demasiado corto. No se modificó el borrador.');
    }
    state.previousPendingText = draft;
    state.pendingText = revised;
    state.pendingWarnings = collectPendingWarnings({
      text: revised,
      forbiddenCast: state.forbiddenCast,
      truncated: result.truncated === true,
      finishReason: result.finishReason || null,
    });
    state.updatedAt = new Date().toISOString();
    await db.put('generationState', state, scope);
    return state;
  });
}

export async function approvePendingBlock(chapterId, editedText, opts) {
  const scope = { projectId: opts?.projectId || db.getActiveProjectId() };
  const state = await db.get('generationState', chapterId, scope);
  if (!state || state.status !== 'awaiting_review') throw new Error('No hay un bloque pendiente de aprobación.');
  const content = String(editedText || '').trim();
  if (wordCount(content) < 15) throw new Error('El bloque es demasiado corto; revísalo antes de guardarlo.');
  const remainingLeaks = findForbiddenCastLeaks(content, state.forbiddenCast);
  if (remainingLeaks.length) {
    throw new Error('El borrador todavía incluye personajes prohibidos (' + remainingLeaks.join(', ') + '). Edítalos o elimínalos antes de aprobar.');
  }

  // En Novel Mode el `pendingText` ya contiene el borrador completo acumulado de todos los tramos
  if (state.generationMode === 'novel_orchestrated') {
    state.accumulatedText = content;
  } else {
    state.accumulatedText += (state.accumulatedText ? '\n\n' : '') + content;
  }
  state.wordsSoFar = wordCount(state.accumulatedText);
  state.blocksDone = state.generationMode === 'novel_orchestrated' ? Math.max(1, state.blocksDone || 1) : (state.blocksDone + 1);
  state.pendingText = '';
  state.previousPendingText = '';
  state.pendingWarnings = [];
  state.status = state.wordsSoFar >= state.targetWords ? 'review_target_reached' : 'paused_review';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState', state, scope);
  const chapter = await db.get('chapters', chapterId, scope);
  if (chapter) {
    if (chapter.content && chapter.content !== state.accumulatedText) {
      chapter.versions = [...(chapter.versions || []), {
        content: chapter.content,
        wordCount: chapter.wordCount || wordCount(chapter.content),
        savedAt: state.updatedAt,
        note: 'Versión anterior antes de aprobar bloque',
      }].slice(-12);
    }
    chapter.content = state.accumulatedText;
    chapter.wordCount = state.wordsSoFar;
    chapter.updatedAt = state.updatedAt;
    await db.put('chapters', chapter, scope);
    await markChapterMemoriesStale(chapterId, {
      projectId: scope.projectId,
      reason: 'block_approved',
      chapterRevision: contentFingerprint(chapter.content),
    });
  }
  return state;
}

export async function rejectPendingBlock(chapterId, opts) {
  const scope = { projectId: opts?.projectId || db.getActiveProjectId() };
  const state = await db.get('generationState', chapterId, scope);
  if (!state || state.status !== 'awaiting_review') return null;
  state.pendingText = '';
  state.previousPendingText = '';
  state.pendingWarnings = [];
  state.status = 'paused_review';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState', state, scope);
  return state;
}

export async function finishReviewedChapter(chapterId, opts) {
  const scope = { projectId: opts?.projectId || db.getActiveProjectId() };
  const state = await db.get('generationState', chapterId, scope);
  if (!state || !state.wordsSoFar || state.pendingText) throw new Error('Primero aprueba el bloque pendiente.');
  state.status = 'completed';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState', state, scope);
  const chapter = await db.get('chapters', chapterId, scope);
  if (chapter) {
    chapter.status = 'finished';
    chapter.updatedAt = state.updatedAt;
    await db.put('chapters', chapter, scope);
  }
  if (state.activeBriefId) {
    await markChapterBriefConsumed(scope.projectId, state.activeBriefId, { chapterId }).catch(() => {});
  }
  return state;
}

export async function discardGeneration(chapterId, opts) {
  const scope = { projectId: opts?.projectId || db.getActiveProjectId() };
  await db.del('generationState', chapterId, scope);
}
