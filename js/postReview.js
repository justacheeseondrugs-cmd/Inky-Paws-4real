// postReview.js — Revisión post-generación (estructural determinista 0-tokens vs
// revisión editorial semántica probabilística opcional), co-escritura por posición,
// y extracción de continuidad propuesta y editable tras la aprobación de la autora.
//
// Invariantes no negociables:
// - Distingue con claridad absoluta entre:
//   (a) Comprobación estructural determinista (0 tokens; NO es garantía semántica).
//   (b) Revisión editorial semántica opcional por IA (probabilística; SOLO bajo orden explícita).
// - La extracción de continuidad JAMÁS se ejecuta automáticamente sobre borradores sin aprobar
//   ni guarda cambios en canon/hechos/relaciones sin inspección y aprobación explícita.

import { db } from './db.js';
import { wordCount, contentFingerprint } from './utils.js';
import { assembleOperationContext } from './contextEngine.js';
import { getProviderForRole } from './providers/index.js';
import { getWalletConfig, checkGenerationBudget, recordUsageEvent } from './inkyWallet.js';
import { parseMemoryResponse, saveContinuityMemoryEntry } from './memoryEngine.js';
import {
  normalizeKnowledgeFact,
  appendBeliefTransitionToFact,
  makeCharacterVersionKey,
  listKnowledgeFacts,
  listRelationshipStates,
  normalizeRelationshipState,
  makeRelationshipPairKey,
} from './knowledgeLedger.js';
import { findForbiddenCastLeaks } from './generation.js';

function cleanString(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 1. Comprobación estructural determinista (0 tokens).
 * Explícitamente etiquetada como verificación determinista/estructural (no garantía semántica).
 */
export function runDeterministicProsePreflight(draftText, {
  forbiddenCast = '',
  isPowerToStrive = false,
  reactionMode = false,
  truncated = false,
  finishReason = null,
  targetWords = null,
} = {}) {
  const text = String(draftText || '').trim();
  const words = wordCount(text);
  const findings = [];

  const forbiddenLeaks = findForbiddenCastLeaks(text, forbiddenCast);
  if (forbiddenLeaks.length) {
    findings.push({
      code: 'forbidden_cast_leak',
      severity: 'critical',
      message: `Se detectaron nombres explícitamente prohibidos: ${forbiddenLeaks.join(', ')}.`,
      evidence: forbiddenLeaks,
    });
  }

  if (truncated) {
    findings.push({
      code: 'provider_truncated_output',
      severity: 'warning',
      message: `La respuesta alcanzó el límite de salida (${finishReason || 'length'}) y puede estar cortada.`,
    });
  }

  // Comprobación heurística/estructural para Anya en sala en historias PtS
  if (isPowerToStrive && reactionMode) {
    const anyaRoomRx = /\banya\b[^.!?\n]{0,80}\b(entered the room|stepped into the room|sat in the room|in the watching room|entr[oó] a la sala|en la sala de reacciones)\b/i;
    if (anyaRoomRx.test(text)) {
      findings.push({
        code: 'heuristic_anya_room_presence_warning',
        severity: 'warning',
        message: 'Aviso heurístico: el borrador menciona a Anya entrando o sentándose en la sala de reacciones (en Power to Strive Anya solo aparece en pantalla o escenas exteriores). Revisa ese pasaje.',
      });
    }
  }

  if (words < 50) {
    findings.push({
      code: 'very_short_draft',
      severity: 'warning',
      message: `El borrador tiene solo ${words} palabras.`,
    });
  } else if (targetWords && words < Math.round(Number(targetWords) * 0.45)) {
    findings.push({
      code: 'below_target_length',
      severity: 'info',
      message: `El borrador (${words} palabras) está bastante por debajo de la extensión orientativa (${targetWords} palabras).`,
    });
  }

  // Verificar puntuación de cierre abrupta
  if (text.length > 40 && !/[.!?…"”»')\]\u2026]$/.test(text)) {
    findings.push({
      code: 'abrupt_final_sentence',
      severity: 'warning',
      message: 'El borrador parece terminar a mitad de frase sin puntuación de cierre.',
    });
  }

  return {
    assessmentType: 'deterministic_structural_not_semantic_guarantee',
    assessmentLabel: 'Comprobación estructural determinista (0 tokens · no sustituye lectura ni juicio semántico)',
    wordCount: words,
    ok: !findings.some((f) => f.severity === 'critical'),
    findings,
  };
}

/**
 * 2. Revisión editorial semántica opcional por IA (explícitamente iniciada por la autora).
 * Etiquetada honestamente como evaluación probabilística.
 */
export async function runSemanticEditorialReview(draftText, {
  projectId = '',
  targetChapterId = null,
  targetChapterOrder = null,
  chapterTitle = '',
  provider: customProvider = null,
  signal = null,
} = {}) {
  const text = cleanString(draftText);
  if (wordCount(text) < 20) {
    return { ok: false, error: 'El borrador es demasiado corto para una revisión editorial semántica.' };
  }
  const pid = projectId || db.getActiveProjectId();
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'auxiliary');

  const bundle = await assembleOperationContext({
    projectId: pid,
    operation: 'editorial_review',
    role: 'auxiliary',
    targetChapterId,
    targetChapterOrder,
    chapterTitle,
    draftText: text,
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.auxiliaryModel,
    walletConfig,
  });

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd: 0,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
  });
  if (!budget.allowed) {
    return { ok: false, errorType: 'budget_blocked', reason: budget.reason, error: budget.message };
  }

  const maxOutputTokens = bundle.modelBound.maxOutputTokens;
  const result = await provider.generate({
    systemPrompt: bundle.modelBound.systemPrompt,
    userPrompt: bundle.modelBound.userPrompt,
    maxOutputTokens,
    temperature: 0.2,
    reasoningEffort: bundle.modelBound.reasoningEffort || '',
    signal,
  });

  await recordUsageEvent({
    projectId: pid,
    operation: 'editorial_review',
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

  if (!result.ok) {
    return { ok: false, errorType: result.errorType || 'http', error: result.errorMessage || 'No se pudo completar la revisión editorial.' };
  }

  let parsed = null;
  try {
    const m = String(result.text || '').match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { }

  return {
    ok: true,
    assessmentType: 'probabilistic_ai_editorial_review',
    assessmentLabel: 'Revisión editorial semántica por IA (evaluación probabilística — la autora decide)',
    overallNotes: cleanString(parsed?.overallNotes || result.text || ''),
    invariantFlags: Array.isArray(parsed?.invariantFlags) ? parsed.invariantFlags : [],
    voiceAndCraftNotes: Array.isArray(parsed?.voiceAndCraftNotes) ? parsed.voiceAndCraftNotes : [],
    epistemicLeakRisks: Array.isArray(parsed?.epistemicLeakRisks) ? parsed.epistemicLeakRisks : [],
    snapshotHash: bundle.snapshotHash,
    usage: result.usage || null,
  };
}

/**
 * 3. Propuesta de actualización de continuidad DESPUÉS de que la autora aprueba el capítulo.
 * Nunca guarda automáticamente: devuelve un objeto editable con resumen de capítulo,
 * nuevos hechos propuestos, transiciones de conocimiento, cambios relacionales, secretos,
 * promesas, hilos abiertos y cambios emocionales.
 */
export async function proposePostApprovalContinuity(chapter, {
  projectId = '',
  provider: customProvider = null,
  signal = null,
} = {}) {
  if (!chapter || !cleanString(chapter.content)) {
    return { ok: false, error: 'El capítulo no tiene texto guardado para extraer continuidad.' };
  }
  const pid = projectId || chapter.projectId || db.getActiveProjectId();
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'auxiliary');

  const bundle = await assembleOperationContext({
    projectId: pid,
    operation: 'continuity_extraction',
    role: 'auxiliary',
    targetChapterId: chapter.id,
    targetChapterOrder: chapter.order ?? null,
    chapterTitle: chapter.title || '',
    chapterText: chapter.content || '',
    documentIds: [], // Nunca extraer hechos de documentos de referencia
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.auxiliaryModel,
    walletConfig,
  });

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd: 0,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
  });
  if (!budget.allowed) {
    return { ok: false, errorType: 'budget_blocked', reason: budget.reason, error: budget.message };
  }

  const maxOutputTokens = bundle.modelBound.maxOutputTokens;
  const result = await provider.generate({
    systemPrompt: bundle.modelBound.systemPrompt,
    userPrompt: bundle.modelBound.userPrompt,
    maxOutputTokens,
    temperature: 0.25,
    reasoningEffort: bundle.modelBound.reasoningEffort || '',
    signal,
  });

  await recordUsageEvent({
    projectId: pid,
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

  if (!result.ok) {
    return { ok: false, errorType: result.errorType || 'http', error: result.errorMessage || 'No se pudo proponer la continuidad.' };
  }

  const summaryFields = parseMemoryResponse(result.text);
  let jsonObj = null;
  try {
    const m = String(result.text || '').match(/\{[\s\S]*\}/);
    if (m) jsonObj = JSON.parse(m[0]);
  } catch { }

  const proposedFacts = Array.isArray(jsonObj?.PROPOSED_FACTS)
    ? jsonObj.PROPOSED_FACTS.filter(isPlainObject).map((f, idx) => ({
        proposalItemId: `fact_${idx + 1}`,
        selected: true,
        title: cleanString(f.title || ''),
        truth: cleanString(f.truth || ''),
        isSecret: Boolean(f.isSecret),
        layer: cleanString(f.layer || 'room') || 'room',
      })).filter((f) => f.title && f.truth)
    : [];

  const proposedKnowledgeTransitions = Array.isArray(jsonObj?.PROPOSED_KNOWLEDGE_TRANSITIONS)
    ? jsonObj.PROPOSED_KNOWLEDGE_TRANSITIONS.filter(isPlainObject).map((k, idx) => ({
        proposalItemId: `know_${idx + 1}`,
        selected: true,
        characterId: cleanString(k.characterId || ''),
        characterVersion: cleanString(k.characterVersion || 'room') || 'room',
        factTitle: cleanString(k.factTitle || ''),
        state: ['knows', 'suspects', 'believes_false', 'unknown'].includes(k.state) ? k.state : 'knows',
        beliefText: cleanString(k.beliefText || ''),
        evidence: cleanString(k.evidence || ''),
      })).filter((k) => k.characterId && k.factTitle)
    : [];

  const proposedRelationshipUpdates = Array.isArray(jsonObj?.PROPOSED_RELATIONSHIP_UPDATES)
    ? jsonObj.PROPOSED_RELATIONSHIP_UPDATES.filter(isPlainObject).map((r, idx) => ({
        proposalItemId: `rel_${idx + 1}`,
        selected: true,
        participants: Array.isArray(r.participants) ? r.participants.map(cleanString).filter(Boolean) : [],
        shift: cleanString(r.shift || ''),
        promise: cleanString(r.promise || ''),
      })).filter((r) => r.participants.length >= 2 && (r.shift || r.promise))
    : [];

  const emotionalShifts = Array.isArray(jsonObj?.EMOTIONAL_SHIFTS)
    ? jsonObj.EMOTIONAL_SHIFTS.map(cleanString).filter(Boolean)
    : [];

  return {
    ok: true,
    staged: true,
    persisted: false,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterOrder: chapter.order ?? null,
    chapterRevision: contentFingerprint(chapter.content),
    summaryFields,
    proposedFacts,
    proposedKnowledgeTransitions,
    proposedRelationshipUpdates,
    emotionalShifts,
    snapshotHash: bundle.snapshotHash,
    usage: result.usage || null,
  };
}

/**
 * Persiste ÚNICAMENTE los elementos de continuidad inspeccionados, editados y
 * aprobados por la autora (memoria de capítulo + hechos + transiciones epistémicas + relaciones).
 */
export async function applyApprovedContinuityProposal(chapter, editedProposal, { projectId = '' } = {}) {
  const pid = projectId || chapter?.projectId || db.getActiveProjectId();
  const scope = { projectId: pid };
  const rev = contentFingerprint(chapter?.content || '');
  const chOrder = Number.isFinite(Number(chapter?.order)) ? Number(chapter.order) : 1;

  let savedMemory = null;
  if (editedProposal?.summaryFields && Object.values(editedProposal.summaryFields).some((v) => cleanString(v))) {
    savedMemory = await saveContinuityMemoryEntry(chapter, editedProposal.summaryFields, scope);
  }

  const [existingFacts, existingRels] = await Promise.all([
    listKnowledgeFacts(scope),
    listRelationshipStates(scope),
  ]);
  const workingFacts = (existingFacts || []).map((f) => structuredClone(f));
  const workingRels = (existingRels || []).map((r) => structuredClone(r));
  const modifiedFactIds = new Set();
  const modifiedRelIds = new Set();

  for (const item of (editedProposal?.proposedFacts || [])) {
    if (item.selected === false || !cleanString(item.truth)) continue;
    const titleKey = cleanString(item.title).toLowerCase();
    let idx = workingFacts.findIndex((f) => cleanString(f.title).toLowerCase() === titleKey);
    if (idx < 0) {
      const fact = normalizeKnowledgeFact({
        title: cleanString(item.title),
        truth: cleanString(item.truth),
        truthStatus: 'author_established_truth',
        claimCategory: 'author_established_truth',
        scope: 'world_fact',
        layer: item.layer || 'room',
        isSecret: Boolean(item.isSecret),
        sourceChapterId: chapter.id,
        sourceChapterRevision: rev,
        firstEffectiveChapterOrder: chOrder,
      }, scope);
      workingFacts.push(fact);
      idx = workingFacts.length - 1;
      modifiedFactIds.add(fact.id);
    } else {
      workingFacts[idx] = normalizeKnowledgeFact({ ...workingFacts[idx], truth: cleanString(item.truth), isSecret: Boolean(item.isSecret) }, { existing: workingFacts[idx], projectId: pid });
      modifiedFactIds.add(workingFacts[idx].id);
    }
  }

  for (const k of (editedProposal?.proposedKnowledgeTransitions || [])) {
    if (k.selected === false || !cleanString(k.characterId) || !cleanString(k.factTitle)) continue;
    const titleKey = cleanString(k.factTitle).toLowerCase();
    let idx = workingFacts.findIndex((f) => cleanString(f.title).toLowerCase() === titleKey);
    if (idx < 0) {
      const unresolved = k.state === 'believes_false';
      const fact = normalizeKnowledgeFact({
        title: cleanString(k.factTitle),
        truth: unresolved ? '[Verdad objetiva sin confirmar — requiere confirmación de la autora]' : cleanString(k.beliefText || k.factTitle),
        truthStatus: unresolved ? 'unresolved_author_confirmation_required' : 'author_established_truth',
        requiresAuthorTruthConfirmation: unresolved,
        claimCategory: unresolved ? 'character_belief' : 'author_established_truth',
        sourceChapterId: chapter.id,
        sourceChapterRevision: rev,
        firstEffectiveChapterOrder: chOrder,
      }, scope);
      workingFacts.push(fact);
      idx = workingFacts.length - 1;
    }
    const charKey = makeCharacterVersionKey(k.characterId, k.characterVersion || 'room');
    const updated = appendBeliefTransitionToFact(workingFacts[idx], charKey, {
      state: k.state || 'knows',
      beliefText: cleanString(k.beliefText || ''),
      evidence: cleanString(k.evidence || `Cap. ${chOrder}`),
      sourceChapterId: chapter.id,
      sourceChapterRevision: rev,
      effectiveChapterOrder: chOrder,
    });
    workingFacts[idx] = normalizeKnowledgeFact(updated, { existing: workingFacts[idx], projectId: pid });
    modifiedFactIds.add(workingFacts[idx].id);
  }

  for (const r of (editedProposal?.proposedRelationshipUpdates || [])) {
    if (r.selected === false || !Array.isArray(r.participants) || r.participants.length < 2) continue;
    const pairKey = makeRelationshipPairKey(r.participants[0], r.participants[1]);
    let idx = workingRels.findIndex((x) => x.pairKey === pairKey);
    const promises = r.promise
      ? [{ text: cleanString(r.promise), status: 'open', chapterOrder: chOrder, sourceChapterId: chapter.id }]
      : [];
    if (idx < 0) {
      const rel = normalizeRelationshipState({
        participants: r.participants.slice(0, 2),
        behaviorChanges: r.shift ? [cleanString(r.shift)] : [],
        promises,
        sourceChapterId: chapter.id,
        sourceChapterRevision: rev,
        effectiveChapterOrder: chOrder,
      }, scope);
      workingRels.push(rel);
      idx = workingRels.length - 1;
    } else {
      const cur = workingRels[idx];
      const next = normalizeRelationshipState({
        ...cur,
        behaviorChanges: [...(cur.behaviorChanges || []), ...(r.shift ? [cleanString(r.shift)] : [])],
        promises: [...(cur.promises || []), ...promises],
        sourceChapterId: chapter.id,
        sourceChapterRevision: rev,
        effectiveChapterOrder: chOrder,
      }, { existing: cur, projectId: pid });
      workingRels[idx] = next;
    }
    modifiedRelIds.add(workingRels[idx].id);
  }

  const factsToSave = workingFacts.filter((f) => modifiedFactIds.has(f.id));
  const relsToSave = workingRels.filter((r) => modifiedRelIds.has(r.id));
  const stores = [];
  if (factsToSave.length) stores.push('knowledgeFacts');
  if (relsToSave.length) stores.push('relationshipStates');

  if (stores.length) {
    await db.runAtomicTransaction(stores, 'readwrite', ({ stores: txStores }) => {
      if (txStores.knowledgeFacts) {
        for (const f of factsToSave) txStores.knowledgeFacts.put({ ...f, projectId: pid });
      }
      if (txStores.relationshipStates) {
        for (const r of relsToSave) txStores.relationshipStates.put({ ...r, projectId: pid });
      }
    });
  }

  return {
    ok: true,
    savedMemory,
    savedFactsCount: factsToSave.length,
    savedRelationshipsCount: relsToSave.length,
  };
}

/**
 * 4. Co-escritura: continúa el manuscrito exactamente desde la posición elegida por la autora.
 * Devuelve el texto generado como borrador candidato (nunca sobrescribe automáticamente).
 */
export async function continueFromAuthorPosition(chapter, {
  cursorOffset = null,
  continuationInstruction = '',
  blockTargetWords = 900,
  generationIntent = 'continue',
  projectId = '',
  provider: customProvider = null,
  signal = null,
} = {}) {
  const fullText = String(chapter?.content || '');
  const splitPos = cursorOffset !== null && cursorOffset !== undefined && Number.isFinite(Number(cursorOffset))
    ? Math.max(0, Math.min(fullText.length, Math.floor(Number(cursorOffset))))
    : fullText.length;

  const textBeforeCursor = fullText.slice(0, splitPos);
  const textAfterCursor = fullText.slice(splitPos);
  const baseContentHash = contentFingerprint(fullText);
  const pid = projectId || chapter?.projectId || db.getActiveProjectId();
  const [settings, walletConfig] = await Promise.all([
    db.get('settings', 'main'),
    getWalletConfig(),
  ]);
  const provider = customProvider || getProviderForRole(settings, walletConfig, 'primary');

  const bundle = await assembleOperationContext({
    projectId: pid,
    operation: 'continuation',
    role: 'primary',
    targetChapterId: chapter?.id || null,
    targetChapterOrder: chapter?.order ?? null,
    chapterTitle: chapter?.title || '',
    chapterSoFar: textBeforeCursor,
    wordsSoFar: wordCount(textBeforeCursor),
    blockTargetWords,
    generationIntent,
    continuationInstruction,
    providerId: provider.name,
    modelId: provider.config?.model || walletConfig.primaryModel,
    walletConfig,
  });

  if (!bundle.canGenerate) {
    const msg = (bundle.inspectorOnly.criticalBlockers || []).map((b) => b.message).join(' | ');
    return { ok: false, errorType: 'critical_contradiction', error: `Continuación bloqueada por contradicciones críticas: ${msg}` };
  }

  const budget = checkGenerationBudget({
    estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
    spentSoFarUsd: 0,
    maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
    allowUnknownCostOverride: walletConfig.allowUnknownCostOverride === true,
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

  await recordUsageEvent({
    projectId: pid,
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

  if (!result.ok) {
    return { ok: false, errorType: result.errorType || 'http', error: result.errorMessage || 'No se pudo generar la continuación.' };
  }

  const inserted = cleanString(result.text);
  const sepBefore = textBeforeCursor && !textBeforeCursor.endsWith('\n') ? '\n\n' : '';
  const sepAfter = textAfterCursor && !textAfterCursor.startsWith('\n') ? '\n\n' : '';
  const mergedContent = textBeforeCursor + sepBefore + inserted + (textAfterCursor ? sepAfter + textAfterCursor : '');

  return {
    ok: true,
    insertedProse: inserted,
    mergedContent,
    cursorOffset: splitPos,
    baseContentHash,
    snapshotHash: bundle.snapshotHash,
    usage: result.usage || null,
  };
}
