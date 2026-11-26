// generation.js — motor de generación de capítulos por bloques.
//
// Diseño para poder recuperarse tras cerrar la web, detener la generación o
// un error: el estado de generación (generationState) se guarda en
// IndexedDB DESPUÉS de cada bloque exitoso, nunca antes. Si el bloque en
// curso se pierde (la pestaña se cierra a mitad de una llamada a la API),
// al reanudar se retoma pidiendo el siguiente bloque a partir del último
// texto ya guardado — es decir, la recuperación es exacta a nivel de bloque,
// no a mitad de frase, porque no usamos streaming (streaming complicaría
// mucho la recuperación fiable sin un backend propio).

import { db } from './db.js';
import { getProvider, getModelOutputLimit } from './providers/index.js';
import { assembleSystemPrompt, assembleSystemPromptParts } from './canonGuard.js';
import { getRelevantChunks } from './retrieval.js';
import { wordCount } from './utils.js';
import { chaptersBefore, memoriesForChapters } from './timeline.js';
import { REACTION_ROOM_GUIDANCE, REACTION_ROOM_ENDING_GUIDANCE } from './reactionGuidance.js';
import { getRelevantStoryExcerpts, getPreviousChapterEnding } from './storyRecall.js';
import { getAuthorBrain, buildAuthorGuidance, authorBriefJsonInstruction, parseAuthorBrief } from './authorBrain.js';
import { buildSmartContextQuery, selectSmartMemories, canonQueryBoost } from './smartContext.js';
import { filterCharactersByAllowedCast } from './characterMatch.js';

const DEFAULT_BLOCK_WORDS = 900;
const STORY_CONTEXT_CHAR_CAP = 55000; // Hasta aproximadamente 7k palabras.
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
  return all.filter((g) => ['in_progress','awaiting_review','review_target_reached'].includes(g.status) || g.status?.startsWith('paused_'))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

export async function startOrResumeGeneration({ chapterId, chapterTitle, instructions, targetWords, requiredEnding = '', scenePlan = [], sceneIndex, allowedCast = '', roomCast = '', onscreenCast = '', forbiddenCast = '', documentIds = [], reactionMode = true, blockNotes = '', generationIntent = 'continue', generationMode = 'blocks', projectId = '', signal, onProgress, shouldStop }) {
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
      pendingText: '',
      pendingWarnings: [],
      accumulatedText: '',
      wordsSoFar: 0,
      blocksDone: 0,
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
    await db.put('generationState', state, scope);
  }

  return runGenerationLoop(state, onProgress, shouldStop, { signal });
}

export async function runGenerationLoop(state, onProgress, shouldStop, { signal } = {}) {
  return trackInFlight(async () => {
  const scope = { projectId: state.projectId || db.getActiveProjectId() };
  const settings = (await db.get('settings', 'main')) || {};
  const blockWords = settings.blockWordSize || DEFAULT_BLOCK_WORDS;
  const provider = getProvider(settings);

  const [lockedFacts, allCharacters, allMemoryEntries, canonNotes, allDocuments, allChunks, allChapters] = await Promise.all([
    db.getAll('lockedFacts', scope),
    db.getAll('characters', scope),
    db.getAll('memoryEntries', scope),
    db.getAll('canonNotes', scope),
    db.getAll('documents', scope),
    db.getAll('docChunks', scope),
    db.getAll('chapters', scope),
  ]);

  // A single API call produces one PENDING block. Never auto-append it:
  // the author must approve or edit each block before a follow-up API request.
  {
    const remaining = Math.max(1,state.targetWords - state.wordsSoFar);
    const intent = state.generationIntent || 'continue';
    const generationMode = state.generationMode || 'blocks';
    const fullChapterMode = generationMode === 'full_chapter';
    const normalBlockTarget = fullChapterMode
      ? remaining
      : Math.min(blockWords, Math.max(remaining, Math.round(blockWords * .65)));
    // "Add an ending" still lands the current unit instead of forcing another
    // full-size request, even when Full chapter mode is selected.
    const thisBlockTarget = intent === 'ending'
      ? Math.min(700, Math.max(250, Math.round(Math.min(blockWords, remaining) * .55)))
      : normalBlockTarget;
    const isFirstBlock = state.blocksDone === 0;
    const isLastStretch = fullChapterMode || remaining <= blockWords;

    const characters = filterCharactersByAllowedCast(allCharacters,state.allowedCast);
    const priorChapters = chaptersBefore(allChapters,state.chapterId);
    const allActiveMemoryEntries = memoriesForChapters(allMemoryEntries,priorChapters);
    const smartQuery = buildSmartContextQuery({
      instructions:state.instructions,
      allowedCast:state.allowedCast,
      requiredEnding:state.requiredEnding,
      scenePlan:state.scenePlan,
      blockNotes:state.blockNotes,
      liveText:state.accumulatedText,
    });
    const memorySelection = selectSmartMemories(allActiveMemoryEntries,smartQuery);
    const memoryEntries = memorySelection.selected;
    const canonBoost = canonQueryBoost(canonNotes,smartQuery);
    const mainPreviousChapters = priorChapters;
    const continuityQuery = [
      smartQuery,
      canonBoost,
      memoryEntries.slice(-2).map((m) => [m.events,m.openThreads,m.whoKnowsWhat].filter(Boolean).join(' ')).join(' ')
    ].filter(Boolean).join(' ');
    const storyExcerpts = getRelevantStoryExcerpts(mainPreviousChapters, continuityQuery, {
      excludeChapterId: state.chapterId,
      maxExcerpts: 5,
      maxPerChapter: 2,
    });
    const previousEnding = getPreviousChapterEnding(mainPreviousChapters, state.chapterId, 4200);
    const documents = allDocuments.filter((d) =>
      Array.isArray(state.documentIds) ? state.documentIds.includes(d.id) : true);
    const queryText = continuityQuery;
    const safeDocuments = documents.filter((d) => d.type !== 'STYLE_ONLY');
    const retrievedChunks = getRelevantChunks(safeDocuments, allChunks, queryText, { context: 'chapter_generation' });
    // STYLE_ONLY source prose may contain foreign plot/character names. Never
    // send that source text into a scene-generation request.
    for (const doc of documents.filter((d) => d.type === 'STYLE_ONLY' && d.active !== false)) {
      retrievedChunks.push({ documentId:doc.id, document:doc,
        text:'Style notes supplied by author: '+(doc.useOnlyFor || 'novel-like rhythm and narration')+
        '. Do not import any plot, character, relationship, dialogue or event from this file.' });
    }

    const authorBrain = await getAuthorBrain(scope.projectId);
    if (isFirstBlock && !state.authorBrief && authorBrain.prepEnabled !== false) {
      onProgress?.({ phase:'preflight', state });
      try {
        const prepParts = assembleSystemPromptParts({
          lockedFacts,
          chapterInstructions: state.instructions,
          characters,
          memoryEntries,
          canonNotes,
          recentChapterExcerpt: previousEnding.text,
          storyExcerpts,
          retrievedChunks: [],
          extraGuidance: authorBriefJsonInstruction(),
        });
        const prepResult = await provider.generate({
          systemPrompt:[prepParts.stablePrompt,prepParts.dynamicPrompt].filter(Boolean).join('\n\n---\n\n'),
          cacheStrategy:'off',
          userPrompt:[
            'Prepare the editorial brief for this chapter before prose is written.',
            'TITLE: '+state.chapterTitle,
            'TARGET: approximately '+state.targetWords+' words',
            'SCENE PLAN:\n'+((state.scenePlan || []).map((beat,i)=>(i+1)+'. '+beat).join('\n') || '(none supplied)'),
            state.requiredEnding ? 'REQUIRED ENDING: '+state.requiredEnding : '',
            state.reactionMode ? 'REACTION ROOM CAST (physically present viewers): '+(state.roomCast || '(not specified)') : '',
            'ONSCREEN CAST FOR THIS CHAPTER: '+(state.onscreenCast || '(none explicitly listed)'),
            'ALLOWED CAST ACROSS BOTH SETTINGS: '+(state.allowedCast || '(none)'),
            state.reactionMode ? 'This is a reaction-room chapter: keep reaction-room viewers physically separate from onscreen characters unless the story explicitly establishes the same character in both settings.' : ''
          ].filter(Boolean).join('\n\n'),
          maxOutputTokens:1200,
          temperature:0.2,
          signal,
        });
        if (prepResult.errorType === 'aborted') {
          state.status = state.wordsSoFar ? 'paused_manual' : 'paused_error';
          state.lastError = { type: 'aborted', message: prepResult.errorMessage || 'Generación cancelada.', at: new Date().toISOString() };
          state.updatedAt = new Date().toISOString();
          await db.put('generationState', state, scope);
          onProgress?.({ phase: 'error', state, error: prepResult });
          return state;
        }
        const parsed = prepResult.ok ? parseAuthorBrief(prepResult.text) : null;
        if (parsed) {
          state.authorBrief = parsed;
          state.updatedAt = new Date().toISOString();
          await db.put('generationState', state, scope);
        }
      } catch {
        // Pre-flight is an optional quality layer; never block the actual chapter.
      }
    }
    const authorGuidance = buildAuthorGuidance({
      brain: authorBrain,
      characters,
      scenePlan: state.scenePlan || [],
      requiredEnding: state.requiredEnding || '',
      authorBrief: state.authorBrief || null,
    });

    // No cortar el texto anterior a 1.400 caracteres: cada llamada debe ver
    // lo escrito en este mismo capítulo para no reiniciar escenas ya narradas.
    const chapterSoFar = state.accumulatedText.slice(-STORY_CONTEXT_CHAR_CAP);
    const progress = state.wordsSoFar / Math.max(state.targetWords, 1);
    const narrativePosition = fullChapterMode && isFirstBlock
      ? 'FULL CHAPTER: write the complete chapter in this single response. Pace the opening, middle, escalation and ending as ONE continuous arc. Do not stop after an intermediate reveal or treat each listed beat as a separate mini-scene. Carry unfinished questions, jokes, tension and emotional consequences forward across the whole chapter.'
      : fullChapterMode
        ? 'FULL CHAPTER CONTINUATION: the previous full-chapter attempt ended short. Continue seamlessly from the exact last line and finish the remaining arc and required ending without recap.'
        : isFirstBlock
          ? 'FIRST BLOCK: establish the initial scene; do not rush to the climax.'
          : isLastStretch || progress >= .82
            ? 'FINAL STRETCH: stop expanding the setup. Move directly toward the author-requested final scene and execute it fully. Close immediately after the specified cliffhanger.'
            : progress >= .60
              ? 'LATE MIDDLE: complete the ongoing conversation and make tangible progress toward the closing scene. No new subplot, character introductions or recaps.'
              : 'MIDDLE: continue from the precise last action and develop the NEXT unique event. Never replay a previous arrival, conversation or scream.';

    const intentGuidance = intent === 'ending'
      ? 'ADD AN ENDING: Continue seamlessly from the current prose and write only enough to give THIS CURRENT BLOCK/SCENE a satisfying stopping point. Resolve the immediate conversational or emotional beat, but keep larger story threads alive. Do not start a new scene, time-skip, recap, or invent an unrelated twist merely to manufacture an ending. Finish on a strong final line, image, reaction, realization, question, or organic hook. This does NOT mean end the whole story.'
      : intent === 'keep-going'
        ? 'KEEP GOING: Stay inside the exact current moment and scene. Deepen the interaction, reactions, body language, dialogue, interiority or immediate consequence before moving on. Do not time-skip, jump to the next planned scene, or rush to resolve the beat.'
        : intent === 'surprise'
          ? 'SURPRISE ME: Choose the most organic interesting next development from tensions and information already present. Surprise through character consequence, a revealing observation, a question, a mistake, a reaction or a plausible interruption—not a random new character, unrelated subplot, deus ex machina or canon-breaking twist.'
          : 'CONTINUE: Advance naturally from the exact final line. Do not recap or restart.';

    const extraGuidance = [
      'This request is ONE continuous chapter, NOT a fresh chapter per API call. All events in CHAPTER_SO_FAR have ALREADY HAPPENED. Return ONLY the next new prose, never a repeat or rephrasing.',
      state.reactionMode ? REACTION_ROOM_GUIDANCE : 'Write only the narrative requested by the author.',
      authorGuidance,
      'References contain background, not a new scene plan. Do not introduce unrelated characters, places or plotlines just because a reference mentions them. The author instructions and chapter-so-far control the current episode.',
      'Word count is a flexible target, not a reason to end before the author-requested final event. Pace the setup to leave time for the entire climax and cliffhanger.',
      state.reactionMode ? 'REACTION ROOM CAST — physically present viewers: '+(state.roomCast || '(not specified)')+'. Keep these people in the room unless an approved event changes the room roster.' : '',
      'ONSCREEN CAST FOR THIS CHAPTER: '+(state.onscreenCast || '(none explicitly listed)')+'. These names may appear in the future footage when the chapter plan requires them.',
      'ALLOWED NAMED CAST ACROSS BOTH SETTINGS: '+(state.allowedCast || '(none; ask the author for a cast)')+'. Do not introduce ANY other named person from a reference or another AU. Unnamed extras may appear only when the chapter instruction requires them. A name being allowed does NOT move that person between the reaction room and the onscreen episode.',
      state.forbiddenCast ? 'EXPLICITLY FORBIDDEN PEOPLE/CHARACTERS: '+state.forbiddenCast+'. These names must never appear in the NEW prose.' : '',
      Array.isArray(state.scenePlan) && state.scenePlan.length
        ? (fullChapterMode
          ? 'ORDERED STORY PLAN FOR THE WHOLE CHAPTER (each beat happens once, flowing naturally into the next):\n'+state.scenePlan.map((beat,i) => (i+1)+'. '+beat).join('\n')+'\nTreat this as one arc, not a checklist. Earlier beats may keep affecting dialogue and tension long after the story has moved forward.'
          : 'ORDERED STORY PLAN (each beat happens once):\n'+state.scenePlan.map((beat,i) => (i+1)+'. '+beat).join('\n')+'\nFOCUS FOR THIS BLOCK: scene '+(Math.min(state.scenePlan.length-1,Math.max(0,state.sceneIndex || 0))+1)+': '+state.scenePlan[Math.min(state.scenePlan.length-1,Math.max(0,state.sceneIndex || 0))]+'. Progress from here toward the later scenes, never jump backward.')
        : '',
      state.blockNotes ? 'AUTHOR CORRECTION FOR THIS BLOCK (obey exactly, never repeat an earlier bad draft): '+state.blockNotes : '',
      intentGuidance,
      narrativePosition,
      state.requiredEnding ? 'MANDATORY FINAL SCENE / LAST IMAGE: ' + state.requiredEnding + ' Complete the entire event before ending; do not stop at the first distant hint of it.' : '',
      isFirstBlock
        ? (fullChapterMode && intent !== 'ending'
          ? 'Write the COMPLETE chapter "' + state.chapterTitle + '" now, targeting approximately ' + thisBlockTarget + ' words in this one response. Reach the required ending before you stop. Do not stop at 1,500-2,000 words merely because a major reveal has landed.'
          : 'Write the FIRST approximately ' + thisBlockTarget + ' words of "' + state.chapterTitle + '".' + (intent === 'ending' ? ' Give this opening block a natural stopping point without pretending the whole story is over.' : ' Do not end the chapter in this block.'))
        : 'Write ONLY the NEXT approximately ' + thisBlockTarget + ' words from the last sentence. ' + (intent === 'ending' ? 'Land the current beat and stop cleanly.' : (isLastStretch ? 'Finish the remaining chapter arc and required ending.' : 'Keep moving toward the specified ending.')),
    ].filter(Boolean).join('\n\n');

    const promptParts = assembleSystemPromptParts({
      lockedFacts,
      chapterInstructions: state.instructions,
      characters,
      memoryEntries,
      canonNotes,
      recentChapterExcerpt: previousEnding.text,
      storyExcerpts,
      retrievedChunks,
      extraGuidance,
    });
    const systemPrompt = [promptParts.stablePrompt, promptParts.dynamicPrompt].filter(Boolean).join('\n\n---\n\n');

    const userPrompt = isFirstBlock
      ? (fullChapterMode && intent !== 'ending'
        ? 'BEGIN AND COMPLETE THE CHAPTER. Write the entire cohesive English novel chapter in this single response, from opening through ending hook. Target approximately ' + state.targetWords + ' words. Do not stop at an intermediate beat, do not ask to continue, and do not output an outline or commentary.'
        : 'BEGIN CHAPTER. Follow the author scene order and write ONLY the opening block as English novel prose.')
      : [
          'EXACT CHAPTER ALREADY WRITTEN. Do not rewrite, summarize, reproduce or restart any part:',
          '<CHAPTER_SO_FAR>',
          chapterSoFar,
          '</CHAPTER_SO_FAR>',
          'The chapter currently has ' + state.wordsSoFar + ' of approximately ' + state.targetWords + ' words. Begin the NEXT paragraph after the final sentence above, with no heading and no recap.',
          state.requiredEnding ? 'The author-required event to reach before ending is: ' + state.requiredEnding : '',
          intentGuidance,
          narrativePosition,
          'Return ONLY new prose continuing from the final line of CHAPTER_SO_FAR.',
        ].filter(Boolean).join('\n\n');

    onProgress?.({ phase: 'requesting', state });

    const modelOutputLimit = getModelOutputLimit(provider.name, provider.config?.model || '');
    const result = await provider.generate({
      systemPrompt,
      stableSystemPrompt: promptParts.stablePrompt,
      dynamicSystemPrompt: promptParts.dynamicPrompt,
      cacheStrategy: 'reuse',
      cacheKey: 'inky-paws:' + String(state.chapterId || '').slice(0, 50),
      userPrompt,
      maxOutputTokens: Math.min(modelOutputLimit, Math.round(thisBlockTarget * 3.6) + (fullChapterMode ? 1800 : 700)),
      temperature: 1.0,
      signal,
    });

    if (!result.ok) {
      state.lastError = { type: result.errorType, message: result.errorMessage, at: new Date().toISOString() };
      if (result.errorType === 'quota') {
        state.status = 'paused_quota';
      } else if (result.errorType === 'network') {
        state.status = 'paused_network';
      } else if (result.errorType === 'busy') {
        state.status = 'paused_busy';
      } else if (result.errorType === 'aborted') {
        state.status = 'paused_manual';
      } else {
        state.status = 'paused_error';
      }
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state, scope);
      onProgress?.({ phase: 'error', state, error: result });
      return state;
    }

    // Guardar el bloque candidato por separado, para leer y EDITAR antes de
    // que se incorpore a la historia. Si contiene personajes prohibidos o se
    // cortó por límite de tokens, se guarda en cuarentena (nunca se descarta
    // contenido ya pagado ni se auto-incorpora al capítulo).
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
    onProgress?.({ phase:'block_ready',state });
    return state;
  }

  return state;
  });
}


export async function extendPendingBlockWithEnding(chapterId, editedText, endingStyle = 'natural', { projectId = '', signal } = {}) {
  return trackInFlight(async () => {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const state = await db.get('generationState', chapterId, scope);
  if (!state || state.status !== 'awaiting_review') throw new Error('No hay un bloque pendiente para completar.');
  const pending = String(editedText || state.pendingText || '').trim();
  if (wordCount(pending) < 15) throw new Error('El bloque es demasiado corto para añadirle un final.');

  const settings = (await db.get('settings','main')) || {};
  const blockWords = settings.blockWordSize || DEFAULT_BLOCK_WORDS;
  const provider = getProvider(settings);
  const [lockedFacts, allCharacters, allMemoryEntries, canonNotes, allDocuments, allChunks, allChapters] = await Promise.all([
    db.getAll('lockedFacts', scope),
    db.getAll('characters', scope),
    db.getAll('memoryEntries', scope),
    db.getAll('canonNotes', scope),
    db.getAll('documents', scope),
    db.getAll('docChunks', scope),
    db.getAll('chapters', scope),
  ]);

  const characters = filterCharactersByAllowedCast(allCharacters,state.allowedCast);
  const priorChapters = chaptersBefore(allChapters,state.chapterId);
  const allActiveMemoryEntries = memoriesForChapters(allMemoryEntries,priorChapters);
  const smartQuery = buildSmartContextQuery({
    instructions:state.instructions,
    allowedCast:state.allowedCast,
    requiredEnding:state.requiredEnding,
    scenePlan:state.scenePlan,
    blockNotes:'ending',
    liveText:pending,
  });
  const memoryEntries = selectSmartMemories(allActiveMemoryEntries,smartQuery).selected;
  const continuityQuery = [smartQuery,canonQueryBoost(canonNotes,smartQuery)].filter(Boolean).join(' ');
  const mainPreviousChapters = priorChapters;
  const storyExcerpts = getRelevantStoryExcerpts(mainPreviousChapters, continuityQuery, { excludeChapterId:state.chapterId,maxExcerpts:4,maxPerChapter:2 });
  const previousEnding = getPreviousChapterEnding(mainPreviousChapters,state.chapterId,3200);
  const documents = allDocuments.filter((d) => Array.isArray(state.documentIds) ? state.documentIds.includes(d.id) : true);
  const queryText = continuityQuery;
  const safeDocuments = documents.filter((d) => d.type !== 'STYLE_ONLY');
  const retrievedChunks = getRelevantChunks(safeDocuments,allChunks,queryText,{context:'chapter_generation'});
  for (const doc of documents.filter((d) => d.type === 'STYLE_ONLY' && d.active !== false)) {
    retrievedChunks.push({
      documentId:doc.id,
      document:doc,
      text:'Style notes supplied by author: '+(doc.useOnlyFor || 'novel-like rhythm and narration')+
        '. Do not import any plot, character, relationship, dialogue or event from this file.'
    });
  }

  const styleInstruction = endingStyle === 'hook'
    ? 'Close the immediate beat, but make the final line an organic hook, realization, question, discovery or complication.'
    : endingStyle === 'soft'
      ? 'Use a quiet emotional landing rather than a cliffhanger.'
      : endingStyle === 'hard'
        ? 'Make the scene ending unmistakable and complete, without beginning the next scene.'
        : endingStyle === 'chapter'
          ? 'Give this chapter a substantial closing beat while preserving larger unresolved story threads.'
          : 'Choose the ending shape that best fits the prose already on the page: a final line, image, reaction, realization or gentle hook.';

  const fullText = [state.accumulatedText,pending].filter(Boolean).join('\n\n').slice(-STORY_CONTEXT_CHAR_CAP);
  const endingWords = Math.min(600,Math.max(250,Math.round(blockWords * .5)));
  const endingPromptParts = assembleSystemPromptParts({
    lockedFacts,
    chapterInstructions: state.instructions,
    characters,
    memoryEntries,
    canonNotes,
    recentChapterExcerpt:previousEnding.text,
    storyExcerpts,
    retrievedChunks,
    extraGuidance:[
      'ADD AN ENDING TO THE CURRENT TEXT. Continue from the exact final sentence; do not restart, summarize, rewrite or replace anything already written.',
      'Write only enough to bring the CURRENT BLOCK/SCENE to a natural stopping point. This does not automatically end the whole story.',
      'Resolve the immediate conversational or emotional beat while leaving larger plot threads intact. Do not begin a new scene, jump in time or introduce an unrelated plot development merely to create an ending.',
      styleInstruction,
      'Preserve the current POV, tone, pacing, characterization, dialogue rhythm and continuity.',
      state.reactionMode ? REACTION_ROOM_ENDING_GUIDANCE : '',
      state.reactionMode ? 'REACTION ROOM CAST: '+(state.roomCast || '(not specified)')+'.' : '',
      'ONSCREEN CAST: '+(state.onscreenCast || '(none explicitly listed)')+'.',
      'ALLOWED NAMED CAST FOR THIS CHAPTER: '+(state.allowedCast || '(none)')+'. Do not introduce another named person or move a person between settings without story support.',
      state.forbiddenCast ? 'EXPLICITLY FORBIDDEN PEOPLE/CHARACTERS: '+state.forbiddenCast+'. These names must not appear.' : '',
      'Target roughly '+endingWords+' additional words, but stop sooner if the prose has already landed. Do not pad the ending.'
    ].filter(Boolean).join('\n\n')
  });
  const systemPrompt = [endingPromptParts.stablePrompt, endingPromptParts.dynamicPrompt].filter(Boolean).join('\n\n---\n\n');

  const modelOutputLimit = getModelOutputLimit(provider.name, provider.config?.model || '');
  const result = await provider.generate({
    systemPrompt,
    // "Add an ending" is normally a one-off request: never pay to cache-write
    // its changing suffix/pending text. OpenAI explicit mode will do no write.
    cacheStrategy: 'off',
    userPrompt:[
      'TEXT ALREADY WRITTEN. Continue only after its final sentence:',
      '<TEXT_ALREADY_WRITTEN>',
      fullText,
      '</TEXT_ALREADY_WRITTEN>',
      'Return ONLY the new ending prose to append. No heading, preface, recap, commentary or duplicated sentences.'
    ].join('\n\n'),
    maxOutputTokens: Math.min(modelOutputLimit, Math.round(endingWords * 3.6) + 500),
    temperature:0.95,
    signal,
  });

  if (!result.ok) throw new Error(result.errorMessage || 'No se pudo generar el final.');

  const addition = String(result.text || '').trim();
  if (wordCount(addition) < 8) throw new Error('La IA devolvió un final demasiado corto. No se modificó el bloque.');
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


export async function polishPendingBlock(chapterId, editedText, { projectId = '', signal } = {}) {
  return trackInFlight(async () => {
  const scope = { projectId: projectId || db.getActiveProjectId() };
  const state = await db.get('generationState', chapterId, scope);
  if (!state || state.status !== 'awaiting_review') throw new Error('No hay un borrador pendiente para editar.');
  const draft = String(editedText || state.pendingText || '').trim();
  if (wordCount(draft) < 80) throw new Error('El borrador es demasiado corto para un Editor Pass.');

  const settings = (await db.get('settings','main')) || {};
  const provider = getProvider(settings);
  const [lockedFacts, allCharacters, allMemoryEntries, canonNotes, allDocuments, allChunks, allChapters] = await Promise.all([
    db.getAll('lockedFacts', scope),
    db.getAll('characters', scope),
    db.getAll('memoryEntries', scope),
    db.getAll('canonNotes', scope),
    db.getAll('documents', scope),
    db.getAll('docChunks', scope),
    db.getAll('chapters', scope),
  ]);

  const characters = filterCharactersByAllowedCast(allCharacters,state.allowedCast);
  const priorChapters = chaptersBefore(allChapters,state.chapterId);
  const allActiveMemoryEntries = memoriesForChapters(allMemoryEntries,priorChapters);
  const smartQuery = buildSmartContextQuery({
    instructions:state.instructions,
    allowedCast:state.allowedCast,
    requiredEnding:state.requiredEnding,
    scenePlan:state.scenePlan,
    blockNotes:'editor pass',
    liveText:draft,
  });
  const memoryEntries = selectSmartMemories(allActiveMemoryEntries,smartQuery).selected;
  const continuityQuery = [smartQuery,canonQueryBoost(canonNotes,smartQuery)].filter(Boolean).join(' ');
  const mainPreviousChapters = priorChapters;
  const storyExcerpts = getRelevantStoryExcerpts(
    mainPreviousChapters,
    continuityQuery,
    {excludeChapterId:state.chapterId,maxExcerpts:5,maxPerChapter:2}
  );
  const previousEnding = getPreviousChapterEnding(mainPreviousChapters,state.chapterId,4200);

  const documents = allDocuments.filter((d)=>Array.isArray(state.documentIds) ? state.documentIds.includes(d.id) : true);
  const safeDocuments = documents.filter((d)=>d.type !== 'STYLE_ONLY');
  const retrievedChunks = getRelevantChunks(
    safeDocuments,
    allChunks,
    continuityQuery,
    {context:'chapter_generation'}
  );
  for (const doc of documents.filter((d)=>d.type === 'STYLE_ONLY' && d.active !== false)) {
    retrievedChunks.push({
      documentId:doc.id,
      document:doc,
      text:'Style notes supplied by author: '+(doc.useOnlyFor || 'novel-like rhythm and narration')+
        '. Do not import any plot, character, relationship, dialogue or event from this file.'
    });
  }

  const authorBrain = await getAuthorBrain(scope.projectId);
  const authorGuidance = buildAuthorGuidance({
    brain:authorBrain,
    characters,
    scenePlan:state.scenePlan || [],
    requiredEnding:state.requiredEnding || '',
    authorBrief:state.authorBrief || null,
  });

  const promptParts = assembleSystemPromptParts({
    lockedFacts,
    chapterInstructions:state.instructions,
    characters,
    memoryEntries,
    canonNotes,
    recentChapterExcerpt:previousEnding.text,
    storyExcerpts,
    retrievedChunks,
    extraGuidance:[
      'EDITOR PASS — revise the supplied draft as a novelist and ruthless line editor. Return the COMPLETE revised draft only.',
      'Preserve the same events, event order, reveals, factual content, POV, scene destination and required ending. Do not add a new subplot, new named person, new reveal or different outcome.',
      'Remove AI-ish explanation after gestures, thematic summaries, repeated reactions, redundant emotional interpretation and dialogue that explains what everyone already knows.',
      'Tighten bridges, protect character-specific voices, preserve subtext, and make ensemble reactions collide naturally instead of taking orderly turns.',
      'Keep good lines and good scene business. This is an edit, not a total reinvention.',
      state.reactionMode ? REACTION_ROOM_GUIDANCE : '',
      authorGuidance,
      state.reactionMode ? 'REACTION ROOM CAST: '+(state.roomCast || '(not specified)')+'.' : '',
      'ONSCREEN CAST: '+(state.onscreenCast || '(none explicitly listed)')+'.',
      'ALLOWED NAMED CAST: '+(state.allowedCast || '(none)')+'.',
      state.forbiddenCast ? 'FORBIDDEN NAMES: '+state.forbiddenCast+'.' : '',
    ].filter(Boolean).join('\n\n')
  });

  const modelOutputLimit = getModelOutputLimit(provider.name, provider.config?.model || '');
  const result = await provider.generate({
    systemPrompt:[promptParts.stablePrompt,promptParts.dynamicPrompt].filter(Boolean).join('\n\n---\n\n'),
    cacheStrategy:'off',
    userPrompt:[
      'DRAFT TO EDIT:',
      '<DRAFT>',
      draft,
      '</DRAFT>',
      'Return only the complete edited prose. No notes, headings, explanations, change log or preface.'
    ].join('\n\n'),
    maxOutputTokens: Math.min(modelOutputLimit, Math.round(wordCount(draft) * 4.0) + 1600),
    temperature:0.85,
    signal,
  });
  if (!result.ok) throw new Error(result.errorMessage || 'No se pudo completar el Editor Pass.');

  const revised = String(result.text || '').trim();
  if (wordCount(revised) < 60) throw new Error('El Editor Pass devolvió un texto demasiado corto. No se modificó el borrador.');
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
  state.accumulatedText += (state.accumulatedText ? '\n\n' : '') + content;
  state.wordsSoFar = wordCount(state.accumulatedText);
  state.blocksDone += 1;
  state.pendingText = '';
  state.previousPendingText = '';
  state.pendingWarnings = [];
  state.status = state.wordsSoFar >= state.targetWords ? 'review_target_reached' : 'paused_review';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState', state, scope);
  const chapter = await db.get('chapters', chapterId, scope);
  if (chapter) {
    chapter.content = state.accumulatedText;
    chapter.wordCount = state.wordsSoFar;
    chapter.updatedAt = state.updatedAt;
    await db.put('chapters', chapter, scope);
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
  if (chapter) { chapter.status='finished'; chapter.updatedAt=state.updatedAt; await db.put('chapters', chapter, scope); }
  return state;
}

export async function discardGeneration(chapterId, opts) {
  const scope = { projectId: opts?.projectId || db.getActiveProjectId() };
  await db.del('generationState', chapterId, scope);
}
