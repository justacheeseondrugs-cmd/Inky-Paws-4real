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
import { listChapterBriefs } from './creativeChat.js';

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

  // 1. Writing DNA aprobado (4 ámbitos)
  const writingDna = resolveWritingDna({
    globalProfile: globalDna,
    fandomProfile: fandomDna,
    storyProfile: storyDna,
    chapterSceneOverride: chapterSceneDnaOverride,
    editorialFeedback,
    fandom,
    projectId: pid,
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
      sceneId,
      currentCheckpoint: storyConfig?.checkpointId || '',
      chapterOrder: targetChapterOrder,
    },
  });

  // 3. Brief de capítulo aprobado (si existe)
  const approvedBrief = activeBriefId
    ? briefs.find((b) => b.id === activeBriefId) || null
    : (briefs.find((b) => b.status === 'approved' || b.status === 'transferred') || null);

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
    targetChapterOrder,
    targetSceneOrder,
    targetChapterId,
    currentCheckpoint: storyConfig?.checkpointId || '',
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

  // 5. Referencias filtradas por rol y línea temporal (factual vs STYLE_ONLY)
  const activeTimelineId = storyConfig?.timelineId || (
    storyConfig?.checkpointId === 's3_alternate' ? 'pts_iii_part_1_alternate' : (fandom === 'power_to_strive' ? 'pts_i_ii_original' : '')
  );
  const references = retrieveRoleSeparatedReferences({
    documents,
    docChunks,
    query: effectiveQuery,
    activeTimelineId,
    context: 'chapter_generation',
  });

  return {
    schemaVersion: 1,
    projectId: pid,
    fandom,
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
        'Perfiles de oficio STYLE_ONLY y filtrado estricto por 6 roles y línea temporal (referenceRoles.js)',
        'Auditoría semántica post-generación sobre semanticReviewPayload',
      ],
    },
  };
}
