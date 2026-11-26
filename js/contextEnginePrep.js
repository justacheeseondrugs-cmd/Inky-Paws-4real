// contextEnginePrep.js — Interfaz unificada y reutilizable que prepara TODOS los
// subsistemas de Inky Soul (Hitos 1–4) para ser consumidos directamente por el
// Context Engine unificado en el Hito 5, sin crear un segundo pipeline paralelo.
//
// Subsistemas expuestos:
// - Writing DNA aprobado (4 ámbitos + anti-patrones + aprendizaje editorial aprobado)
// - Overrides de historia y escena
// - Perfiles universales y overlays (Character Lab)
// - Configuración de universo e invariantes (universeResolver)
// - Conocimiento epistémico temporal (knowledgeLedger)
// - Continuidad emocional y relacional cualitativa (relationshipStates)
// - Recuperación jerárquica de memoria a largo plazo (BM25 + 6 capas)
// - Referencias filtradas por rol y línea temporal (factual vs STYLE_ONLY)
// - Brief de capítulo aprobado (chapterBriefs)

import { db } from './db.js';
import { sortMainTimelineChapters } from './timeline.js';
import { getStoryConfig } from './storyConfigSchema.js';
import { resolveUniverseConfiguration, normalizeRoomGuestInvitations } from './universeResolver.js';
import { listKnowledgeFacts, listRelationshipStates } from './knowledgeLedger.js';
import { listArcSummaries, assembleHierarchicalMemory } from './hierarchicalMemory.js';
import { syncPersistedChapterIndex, syncPersistedDocumentIndex } from './lexicalIndex.js';
import {
  getWritingDnaProfile,
  listEditorialFeedback,
  resolveWritingDna,
} from './writingDna.js';
import { retrieveRoleSeparatedReferences } from './referenceRoles.js';
import { listChapterBriefs, selectEligibleChapterBrief } from './creativeChat.js';

function cleanStr(v) {
  return String(v ?? '').trim();
}

/**
 * Resuelve UNA única posición narrativa canónica (capítulo, escena, checkpoint y línea temporal)
 * ANTES de consultar Writing DNA, universo, conocimiento epistémico, memoria, overlays,
 * referencias y Brief de Capítulo.
 *
 * Invariante crítico de reescritura histórica:
 * Cuando `isHistoricalRewrite === true`, JAMÁS usa `storyConfig.checkpointId` (que refleja el
 * estado más reciente de la historia) para evitar filtrar llegadas, secretos o checkpoints
 * futuros hacia un capítulo anterior.
 */
export function resolveCanonicalNarrativeTarget({
  storyConfig = null,
  chapters = [],
  targetChapterId = null,
  targetChapterOrder = null,
  targetSceneId = null,
  targetSceneOrder = null,
  currentCheckpoint = '',
  fandom = '',
} = {}) {
  const effectiveFandom = cleanStr(fandom || storyConfig?.fandom || 'neutral');
  const allChapters = Array.isArray(chapters) ? chapters.filter(Boolean) : [];
  const mainChapters = sortMainTimelineChapters(allChapters);
  const latestMainOrder = mainChapters.reduce((acc, ch) => Math.max(acc, Number(ch.order ?? 0)), 0);

  const reqChapterId = cleanStr(targetChapterId || '') || null;
  const targetChapter = reqChapterId ? (allChapters.find((c) => c.id === reqChapterId) || null) : null;

  let resolvedChapterOrder;
  const hasExplicitOrder = targetChapterOrder !== null && targetChapterOrder !== undefined && targetChapterOrder !== '' && Number.isFinite(Number(targetChapterOrder));
  if (hasExplicitOrder) {
    resolvedChapterOrder = Math.floor(Number(targetChapterOrder));
  } else if (targetChapter && Number.isFinite(Number(targetChapter.order))) {
    resolvedChapterOrder = Math.floor(Number(targetChapter.order));
  } else {
    resolvedChapterOrder = latestMainOrder + 1;
  }

  const isHistoricalRewrite = Boolean(
    mainChapters.length > 0 && (
      (targetChapter && resolvedChapterOrder <= latestMainOrder) ||
      (hasExplicitOrder && resolvedChapterOrder <= latestMainOrder)
    )
  );

  const explicitCheckpoint = cleanStr(currentCheckpoint || '');
  let checkpointId = '';
  if (explicitCheckpoint) {
    checkpointId = explicitCheckpoint;
  } else if (isHistoricalRewrite) {
    // Usar el checkpoint registrado del capítulo objetivo (o vacío si no tenía), NUNCA el checkpoint actual/futuro de la historia
    checkpointId = cleanStr(targetChapter?.checkpointId || '');
  } else {
    checkpointId = cleanStr(storyConfig?.checkpointId || '');
  }

  const activeTimelineId = cleanStr(
    targetChapter?.timelineId ||
    storyConfig?.timelineId ||
    (checkpointId === 's3_alternate'
      ? 'pts_iii_part_1_alternate'
      : (effectiveFandom === 'power_to_strive' ? 'pts_i_ii_original' : ''))
  );

  const resolvedSceneOrder = targetSceneOrder !== null && targetSceneOrder !== undefined && targetSceneOrder !== '' && Number.isFinite(Number(targetSceneOrder))
    ? Math.floor(Number(targetSceneOrder))
    : null;

  return {
    targetChapterId: reqChapterId,
    targetChapterOrder: resolvedChapterOrder,
    targetSceneId: cleanStr(targetSceneId || '') || null,
    targetSceneOrder: resolvedSceneOrder,
    checkpointId,
    activeTimelineId,
    isHistoricalRewrite,
    latestMainChapterOrder: latestMainOrder,
  };
}

/**
 * Ensambla una instantánea determinista y gratuita (0 tokens) con las interfaces
 * unificadas que consumirá el Context Engine del Hito 5.
 * No invoca ninguna API de pago ni duplica la construcción de prompts de `canonGuard.js`.
 */
export async function assembleUnifiedContextSnapshot({
  projectId = '',
  targetChapterOrder = null,
  targetSceneOrder = null,
  targetChapterId = null,
  targetSceneId = null,
  currentCheckpoint = '',
  query = '',
  characterVersion = 'room',
  sceneId = null,
  activeBriefId = null,
  chapterSceneDnaOverride = null,
  maxMemoryChars = 24000,
} = {}) {
  const pid = projectId || db.getActiveProjectId();
  const scope = { projectId: pid };

  const [
    storyConfig,
    universalCharacters,
    storyCharacters,
    overlays,
    chapters,
    memoryEntries,
    knowledgeFacts,
    relationships,
    arcSummaries,
    lockedFacts,
    canonNotes,
    documents,
    docChunks,
    globalDna,
    storyDna,
    editorialFeedback,
    briefs,
  ] = await Promise.all([
    getStoryConfig(pid),
    db.getAll('universalCharacters'),
    db.getAll('characters', scope),
    db.getAll('characterOverlays'),
    db.getAll('chapters', scope),
    db.getAll('memoryEntries', scope),
    listKnowledgeFacts({ projectId: pid }),
    listRelationshipStates({ projectId: pid }),
    listArcSummaries({ projectId: pid }),
    db.getAll('lockedFacts', scope),
    db.getAll('canonNotes', scope),
    db.getAll('documents', scope),
    db.getAll('docChunks', scope),
    getWritingDnaProfile({ scope: 'global' }),
    getWritingDnaProfile({ scope: 'story', projectId: pid }),
    listEditorialFeedback({ projectId: pid }),
    listChapterBriefs({ projectId: pid }),
  ]);

  const fandom = storyConfig?.fandom || 'neutral';
  const fandomDna = await getWritingDnaProfile({ scope: 'fandom', fandom });

  // 0. Resolver UNA posición narrativa canónica ANTES de todos los subsistemas
  const effectiveSceneId = targetSceneId || sceneId || null;
  const narrativeTarget = resolveCanonicalNarrativeTarget({
    storyConfig,
    chapters,
    targetChapterId,
    targetChapterOrder,
    targetSceneId: effectiveSceneId,
    targetSceneOrder,
    currentCheckpoint,
    fandom,
  });

  // 1. Writing DNA aprobado (4 ámbitos con aislamiento estricto capítulo/escena)
  const writingDna = resolveWritingDna({
    globalProfile: globalDna,
    fandomProfile: fandomDna,
    storyProfile: storyDna,
    chapterSceneOverride: chapterSceneDnaOverride,
    editorialFeedback,
    fandom,
    projectId: pid,
    targetChapterId: narrativeTarget.targetChapterId,
    targetSceneId: narrativeTarget.targetSceneId,
  });

  // 2. Configuración de universo, reparto permitido, overlays y contradicciones
  const universe = resolveUniverseConfiguration({
    storyConfig,
    universalCharacters,
    storyCharacters,
    overlays,
    documents,
    context: {
      fandom,
      characterVersion,
      sceneId: narrativeTarget.targetSceneId,
      currentCheckpoint: narrativeTarget.checkpointId,
      chapterOrder: narrativeTarget.targetChapterOrder,
    },
  });

  // 3. Brief de capítulo ELEGIBLE (solo `approved`/`transferred` y compatible con capítulo objetivo)
  const approvedBrief = selectEligibleChapterBrief(briefs, {
    activeBriefId,
    targetChapterId: narrativeTarget.targetChapterId,
    targetChapterOrder: narrativeTarget.targetChapterOrder,
  });

  // 4. Recuperación jerárquica de memoria (BM25 + 6 capas + epistémico + relaciones + arcos)
  const effectiveQuery = [
    query,
    approvedBrief?.objective || '',
    ...(approvedBrief?.relevantHistoricalMemories || []),
  ].filter(Boolean).join(' ');

  const [{ index: chapterLexicalIndex }, { index: documentLexicalIndex }] = await Promise.all([
    syncPersistedChapterIndex({ projectId: pid, chapters }),
    syncPersistedDocumentIndex({ projectId: pid, documents, docChunks }),
  ]);

  const josephInvite = normalizeRoomGuestInvitations(storyConfig?.roomGuestInvitations || [])
    .find((inv) => inv.characterId === 'joseph');

  const memory = assembleHierarchicalMemory({
    projectId: pid,
    targetChapterOrder: narrativeTarget.targetChapterOrder,
    targetSceneOrder: narrativeTarget.targetSceneOrder,
    targetChapterId: narrativeTarget.targetChapterId,
    currentCheckpoint: narrativeTarget.checkpointId,
    activeTimelineId: narrativeTarget.activeTimelineId,
    fandom,
    query: effectiveQuery,
    characterVersion,
    activeCharacterIds: universe.allowedRoomCast,
    josephArrivalOrder: josephInvite?.effectiveChapterOrder ?? null,
    chapters,
    memoryEntries,
    knowledgeFacts,
    relationships,
    arcSummaries,
    lockedFacts,
    canonNotes,
    documents,
    docChunks,
    chapterLexicalIndex,
    documentLexicalIndex,
    maxTotalChars: maxMemoryChars,
  });

  // 5. Referencias filtradas por rol, fandom y línea temporal (mismo filtro que BM25)
  const references = retrieveRoleSeparatedReferences({
    documents,
    docChunks,
    query: effectiveQuery,
    activeTimelineId: narrativeTarget.activeTimelineId,
    fandom,
    context: 'chapter_generation',
  });

  return {
    schemaVersion: 2,
    projectId: pid,
    fandom,
    narrativeTarget,
    writingDna,
    universe,
    memory: {
      modelPayload: memory.modelPayload,
      budget: memory.budget,
      inspectorDiagnostics: memory.inspectorDiagnostics,
    },
    references,
    approvedChapterBrief: approvedBrief,
    integrationBoundary: {
      connectedToGenerationNow: [
        'Fichas locales de personaje (characters)',
        'Hechos bloqueados y canon revelado/privado (canonGuard)',
        'Memorias de continuidad filtradas cronológicamente y sin entradas stale',
        'Transferencia de Brief de Capítulo a la vista Escribir (planner-draft)',
        'Autor Brain heredado por historia (authorBrain.js)',
      ],
      readyForMilestone5UnifiedContextEngine: [
        'Inyección automática de Writing DNA en 4 ámbitos y anti-patrones (writingDna.js)',
        'Aplicación automática de reglas aprendidas editoriales aprobadas (editorialFeedback)',
        'Inyección de perfiles de Biblioteca Universal, overlays Character Lab e invariantes de universeResolver',
        'Inyección del payload serializado de 6 capas (epistémico temporal, relaciones cualitativas, BM25, arcos)',
        'Perfiles de oficio STYLE_ONLY y filtrado estricto por 6 roles, fandom y línea temporal (referenceRoles.js)',
        'Auditoría semántica post-generación sobre semanticReviewPayload',
      ],
    },
  };
}
