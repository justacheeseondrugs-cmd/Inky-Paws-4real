// modelTestPack.js — Constructor de vista previa exacta del Context Inspector y
// exportación portátil de prueba (0 tokens), delegando 100% en el Motor de Contexto
// Unificado (`js/contextEngine.js`) para garantizar que el preview y la solicitud
// enviada al proveedor utilicen exactamente la misma instantánea (`snapshotHash`).

import { db } from './db.js';
import { assembleOperationContext } from './contextEngine.js';
import { analyzeContextGuard } from './contextGuard.js';
import { combineCast, formatCast } from './storyCast.js';

function safeName(value) {
  return String(value || 'chapter')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'chapter';
}

export async function buildModelTestPack({
  projectId = '',
  chapterId = '',
  chapterTitle = '',
  instructions = '',
  targetWords = 5000,
  requiredEnding = '',
  scenePlan = [],
  allowedCast = '',
  roomCast = '',
  onscreenCast = '',
  forbiddenCast = '',
  documentIds = null,
  reactionMode = true,
  generationMode = 'full_chapter',
  activeBriefId = null,
  targetChapterOrder = null,
  targetSceneId = null,
  characterVersion = 'room',
} = {}) {
  const pid = projectId || db.getActiveProjectId();
  const scope = { projectId: pid };
  const effectiveAllowedCast = allowedCast || formatCast(combineCast(roomCast, onscreenCast));

  const operation = generationMode === 'novel_orchestrated'
    ? 'novel_orchestrated'
    : (generationMode === 'blocks' ? 'manual_block' : 'full_chapter');

  const [bundle, lockedFacts, canonNotes, allCharacters, allDocuments] = await Promise.all([
    assembleOperationContext({
      projectId: pid,
      operation,
      targetChapterId: chapterId || null,
      targetChapterOrder,
      targetSceneId,
      characterVersion,
      activeBriefId,
      documentIds,
      chapterTitle,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast: effectiveAllowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      reactionMode,
    }),
    db.getAll('lockedFacts', scope),
    db.getAll('canonNotes', scope),
    db.getAll('characters', scope),
    db.getAll('documents', scope),
  ]);

  const selectedDocuments = Array.isArray(documentIds)
    ? allDocuments.filter((d) => documentIds.includes(d.id))
    : allDocuments.filter((d) => d.active !== false);

  const guardPreflight = analyzeContextGuard({
    lockedFacts,
    canonNotes,
    allCharacters,
    allowedCast: effectiveAllowedCast,
    onscreenCast,
    instructions,
    scenePlan,
    reactionMode,
    selectedDocuments,
  });

  // Unificar bloqueadores críticos del Motor de Contexto Unificado (universeResolver + PtS invariants)
  // con las alertas estructurales de Context Guard sin duplicar códigos.
  const mergedIssues = [...(bundle.inspectorOnly.criticalBlockers || [])];
  const seenCodes = new Set(mergedIssues.map((x) => `${x.code}:${x.message}`));
  for (const issue of (guardPreflight.issues || [])) {
    const k = `${issue.code || ''}:${issue.message || ''}`;
    if (!seenCodes.has(k)) {
      seenCodes.add(k);
      mergedIssues.push(issue);
    }
  }
  const criticalCount = mergedIssues.filter((i) => i.level === 'critical').length;
  const warningCount = mergedIssues.filter((i) => i.level === 'warning').length;
  const infoCount = mergedIssues.filter((i) => i.level === 'info').length;
  const preflight = {
    issues: mergedIssues,
    criticalCount,
    warningCount,
    infoCount,
    ok: criticalCount === 0 && bundle.canGenerate,
  };

  const { modelBound, inspectorOnly, snapshot } = bundle;
  const layers = snapshot?.memory?.modelPayload?.layers || {};
  const recentMems = layers.B_recent_continuity?.recentMemories || [];
  const histMems = layers.C_historical_episodic?.historicalMemories || [];
  const combinedMemories = [...recentMems, ...histMems];
  const resolvedChars = snapshot?.universe?.resolvedCharacters || [];
  const factualRefs = inspectorOnly.referencesSummary?.factualChunks || [];
  const histPassages = inspectorOnly.memorySummary?.historicalPassages || [];

  const inspector = {
    snapshotHash: bundle.snapshotHash,
    canGenerate: preflight.ok,
    blockedByCriticalIssues: !preflight.ok,
    chapterTitle,
    targetWords,
    generationMode,
    operation,
    sourceProvider: modelBound.providerId,
    sourceModel: modelBound.modelId,
    reasoningEffort: modelBound.reasoningEffort,
    modelCapabilityWarning: modelBound.modelCapabilityWarning,
    preflight,
    narrativeTarget: inspectorOnly.narrativeTarget,
    universeSummary: inspectorOnly.universeSummary,
    writingDnaSummary: inspectorOnly.writingDnaSummary,
    epistemicSummary: inspectorOnly.epistemicSummary,
    referencesSummary: inspectorOnly.referencesSummary,
    memorySummary: inspectorOnly.memorySummary,
    approvedChapterBrief: inspectorOnly.approvedChapterBrief,
    characters: resolvedChars.map((c) => ({ id: c.id || c.logicalId, name: c.name || c.logicalId || 'Sin nombre' })),
    smartContextVersion: 'unified-context-engine-m5',
    memoryTotal: combinedMemories.length,
    memoryOmitted: 0,
    memories: combinedMemories.map((m) => ({
      chapterTitle: m.chapterTitle || `Cap. ${m.chapterOrder ?? ''}`,
      reason: 'memoria jerárquica',
      score: 1,
    })),
    lockedFacts: (layers.F_permanent_canon?.lockedFacts || []).map((f) => f.text),
    revealedCanonNotes: (layers.F_permanent_canon?.revealedCanon || []).map((n) => n.text),
    privateCanonNotes: (layers.F_permanent_canon?.privateAuthorCanon || []).map((n) => n.text),
    canonNotes: [
      ...(layers.F_permanent_canon?.revealedCanon || []).map((n) => n.text),
      ...(layers.F_permanent_canon?.privateAuthorCanon || []).map((n) => n.text),
    ],
    canonRanking: [],
    roomCast: roomCast || (inspectorOnly.universeSummary?.allowedRoomCast || []).join(', '),
    onscreenCast: onscreenCast || '',
    allowedCast: effectiveAllowedCast,
    documents: selectedDocuments.map((d) => ({
      id: d.id,
      filename: d.filename || 'Documento',
      type: d.role || d.type || 'WORLD_BUILDING',
      timelineId: d.timelineId || 'shared_active',
      useOnlyFor: d.useOnlyFor || '',
    })),
    retrievedChunks: factualRefs.map((chunk) => ({
      documentId: chunk.documentId,
      filename: chunk.filename || 'Documento',
      type: chunk.role || 'WORLD_BUILDING',
      text: String(chunk.text || '').trim(),
      score: Number.isFinite(Number(chunk.score)) ? Number(chunk.score) : null,
    })),
    storyExcerpts: histPassages.map((item) => ({
      chapterId: item.chapterId,
      chapterTitle: item.chapterTitle || 'capítulo anterior',
      text: String(item.excerpt || '').trim(),
      score: Number.isFinite(Number(item.bm25Score)) ? Number(item.bm25Score) : null,
    })),
    previousEnding: String(layers.A_immediate_scene?.previousEndingExcerpt || '').trim(),
    systemPrompt: modelBound.systemPrompt,
    stablePrompt: modelBound.stablePrompt,
    dynamicPrompt: modelBound.dynamicPrompt,
    userPrompt: modelBound.userPrompt,
    approxInputTokens: modelBound.estimatedInputTokens,
    approxOutputTokens: modelBound.estimatedOutputTokens,
    maxOutputTokens: modelBound.maxOutputTokens,
    costEstimate: modelBound.costEstimate,
    diagnosticsExcludedFromModelRequest: true,
  };

  const markdown = [
    '# Inky Paws — Unified Context Engine Pack (Milestone 5)',
    '',
    '> Local exact preview of the model-bound request. Zero API keys or Inspector-only diagnostics are included in the model payload.',
    '',
    '## Context Metadata',
    '',
    `- Snapshot hash: \`${bundle.snapshotHash}\``,
    `- Operation: ${operation} (${generationMode})`,
    `- Chapter: ${chapterTitle} (target order: ${inspectorOnly.narrativeTarget?.targetChapterOrder ?? 'next'})`,
    `- Target words: ~${targetWords}`,
    `- Provider / model: ${modelBound.providerId} / ${modelBound.modelId}${modelBound.reasoningEffort ? ` (reasoning: ${modelBound.reasoningEffort})` : ''}`,
    `- Estimated tokens: ~${modelBound.estimatedInputTokens} input / ~${modelBound.estimatedOutputTokens} output (cap ${modelBound.maxOutputTokens})`,
    `- Estimated cost: ${modelBound.costEstimate?.displayCost || 'costo desconocido'}`,
    `- Universe: ${inspectorOnly.universeSummary?.fandom || 'neutral'} · checkpoint: ${inspectorOnly.universeSummary?.checkpointId || '(none)'}`,
    `- Critical blockers: ${preflight.criticalCount} (${preflight.ok ? 'READY' : 'BLOCKED'})`,
    '',
    '---',
    '',
    '# SYSTEM PROMPT (EXACT MODEL-BOUND)',
    '',
    modelBound.systemPrompt,
    '',
    '---',
    '',
    '# USER PROMPT (EXACT MODEL-BOUND)',
    '',
    modelBound.userPrompt,
  ].join('\n');

  return {
    markdown,
    inspector,
    contextBundle: bundle,
    snapshotHash: bundle.snapshotHash,
    canGenerate: preflight.ok,
    filename: 'Inky-Paws-Context-Pack-' + safeName(chapterTitle) + '.md',
    stats: {
      characters: resolvedChars.length,
      memories: combinedMemories.length,
      documents: selectedDocuments.length,
      retrievedChunks: factualRefs.length,
    },
  };
}
