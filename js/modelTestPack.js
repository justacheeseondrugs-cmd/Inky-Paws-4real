import { db } from './db.js';
import { assembleSystemPromptParts } from './canonGuard.js?v=20260928-long-memory-v1';
import { getRelevantChunks } from './retrieval.js';
import { activeChapterIds } from './timeline.js?v=20260928-chapter-variants-v1';
import { REACTION_ROOM_GUIDANCE } from './reactionGuidance.js?v=20260928-reaction-chaos-v1';
import { getRelevantStoryExcerpts, getPreviousChapterEnding } from './storyRecall.js?v=20260928-long-memory-v1';
import { getAuthorBrain, buildAuthorGuidance } from './authorBrain.js?v=20260928-ownership-guard-v1';

function safeName(value) {
  return String(value || 'chapter')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'chapter';
}

function firstRequestGuidance({
  chapterTitle,
  targetWords,
  requiredEnding,
  scenePlan,
  allowedCast,
  forbiddenCast,
  reactionMode,
  generationMode,
}) {
  const fullChapterMode = generationMode === 'full_chapter';
  const narrativePosition = fullChapterMode
    ? 'FULL CHAPTER: write the complete chapter in this single response. Pace the opening, middle, escalation and ending as ONE continuous arc. Do not stop after an intermediate reveal or treat each listed beat as a separate mini-scene. Carry unfinished questions, jokes, tension and emotional consequences forward across the whole chapter.'
    : 'FIRST BLOCK: establish the initial scene; do not rush to the climax.';

  return [
    'This request is ONE continuous chapter, NOT a fresh chapter per API call. Return ONLY new prose, never a repeat or rephrasing.',
    reactionMode
      ? REACTION_ROOM_GUIDANCE
      : 'Write only the narrative requested by the author.',
    'References contain background, not a new scene plan. Do not introduce unrelated characters, places or plotlines just because a reference mentions them. The author instructions control the current episode.',
    'Word count is a flexible target, not a reason to end before the author-requested final event. Pace the setup to leave time for the entire climax and cliffhanger.',
    'ALLOWED NAMED CAST FOR THIS CHAPTER: ' + (allowedCast || '(none)') + '. Do not introduce ANY other named person from a reference or another AU. Unnamed extras may appear only when the chapter instruction requires them.',
    forbiddenCast ? 'EXPLICITLY FORBIDDEN PEOPLE/CHARACTERS: ' + forbiddenCast + '. These names must never appear in the prose.' : '',
    Array.isArray(scenePlan) && scenePlan.length
      ? (fullChapterMode
        ? 'ORDERED STORY PLAN FOR THE WHOLE CHAPTER (each beat happens once, flowing naturally into the next):\n' + scenePlan.map((beat, i) => (i + 1) + '. ' + beat).join('\n') + '\nTreat this as one arc, not a checklist. Earlier beats may keep affecting dialogue and tension long after the story has moved forward.'
        : 'ORDERED STORY PLAN (each beat happens once):\n' + scenePlan.map((beat, i) => (i + 1) + '. ' + beat).join('\n') + '\nFOCUS FOR THIS BLOCK: scene 1. Progress from here toward the later scenes, never jump backward.')
      : '',
    'CONTINUE: Advance naturally. Do not recap or restart.',
    narrativePosition,
    requiredEnding ? 'MANDATORY FINAL SCENE / LAST IMAGE: ' + requiredEnding + ' Complete the entire event before ending; do not stop at the first distant hint of it.' : '',
    fullChapterMode
      ? 'Write the COMPLETE chapter "' + chapterTitle + '" now, targeting approximately ' + targetWords + ' words in this one response. Reach the required ending before you stop. Do not stop at 1,500-2,000 words merely because a major reveal has landed.'
      : 'Write the FIRST approximately ' + Math.min(targetWords, 1000) + ' words of "' + chapterTitle + '". Do not end the chapter in this block.',
  ].filter(Boolean).join('\n\n');
}

export async function buildModelTestPack({
  chapterTitle,
  instructions,
  targetWords,
  requiredEnding = '',
  scenePlan = [],
  allowedCast = '',
  forbiddenCast = '',
  documentIds = [],
  reactionMode = true,
  generationMode = 'full_chapter',
}) {
  const [settings, lockedFacts, allCharacters, allMemoryEntries, canonNotes, allDocuments, allChunks, allChapters] = await Promise.all([
    db.get('settings', 'main'),
    db.getAll('lockedFacts'),
    db.getAll('characters'),
    db.getAll('memoryEntries'),
    db.getAll('canonNotes'),
    db.getAll('documents'),
    db.getAll('docChunks'),
    db.getAll('chapters'),
  ]);

  const permittedNames = String(allowedCast || '').split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const characters = allCharacters.filter((c) => permittedNames.includes(String(c.name || '').trim().toLowerCase()) && c.active !== false);

  const activeIds = activeChapterIds(allChapters);
  const memoryEntries = allMemoryEntries
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .filter((m) => m.chapterId && activeIds.has(m.chapterId));

  const mainChapters = allChapters
    .filter((chapter) => activeIds.has(chapter.id) && String(chapter.content || '').trim())
    .slice()
    .sort((a,b) => (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const continuityQuery = [
    instructions,
    allowedCast,
    requiredEnding,
    Array.isArray(scenePlan) ? scenePlan.join(' ') : '',
    memoryEntries.slice(-2).map((m) => [m.events,m.openThreads,m.whoKnowsWhat].filter(Boolean).join(' ')).join(' ')
  ].filter(Boolean).join(' ');
  const storyExcerpts = getRelevantStoryExcerpts(mainChapters, continuityQuery, {
    maxExcerpts:5,
    maxPerChapter:2,
  });
  const previousEnding = getPreviousChapterEnding(mainChapters, '', 4200);

  const documents = allDocuments.filter((d) => Array.isArray(documentIds) ? documentIds.includes(d.id) : true);
  const queryText = [instructions, allowedCast, memoryEntries.slice(-2).map((m) => m.events).join(' ')].join(' ');
  const safeDocuments = documents.filter((d) => d.type !== 'STYLE_ONLY');
  const retrievedChunks = getRelevantChunks(safeDocuments, allChunks, queryText, { context: 'chapter_generation' });

  for (const doc of documents.filter((d) => d.type === 'STYLE_ONLY' && d.active !== false)) {
    retrievedChunks.push({
      documentId: doc.id,
      document: doc,
      text: 'Style notes supplied by author: ' + (doc.useOnlyFor || 'novel-like rhythm and narration') +
        '. Do not import any plot, character, relationship, dialogue or event from this file.',
    });
  }

  const authorBrain = await getAuthorBrain();
  const authorGuidance = buildAuthorGuidance({
    brain:authorBrain,
    characters,
    scenePlan,
    requiredEnding,
    authorBrief:null,
  });
  const extraGuidance = [
    firstRequestGuidance({
      chapterTitle,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast,
      forbiddenCast,
      reactionMode,
      generationMode,
    }),
    authorGuidance,
  ].filter(Boolean).join('\n\n');

  const promptParts = assembleSystemPromptParts({
    lockedFacts,
    chapterInstructions: instructions,
    characters,
    memoryEntries,
    canonNotes,
    recentChapterExcerpt: previousEnding.text,
    storyExcerpts,
    retrievedChunks,
    extraGuidance,
  });

  const userPrompt = generationMode === 'full_chapter'
    ? 'BEGIN AND COMPLETE THE CHAPTER. Write the entire cohesive English novel chapter in this single response, from opening through ending hook. Target approximately ' + targetWords + ' words. Do not stop at an intermediate beat, do not ask to continue, and do not output an outline or commentary.'
    : 'BEGIN CHAPTER. Follow the author scene order and write ONLY the opening block as English novel prose.';

  const selectedDocNames = documents.map((d) => d.filename).filter(Boolean);
  const memoryTitles = memoryEntries.slice(-4).map((m) => m.chapterTitle || 'sin título');
  const sourceModel = settings?.models?.[settings?.provider] || '(modelo no guardado)';

  const markdown = [
    '# Inky Paws — AI Model Test Pack',
    '',
    '> Portable lore/context snapshot generated locally by Inky Paws. No API keys are included.',
    '> For a fair comparison, paste this entire file into the other model and ask it to follow SYSTEM CONTEXT first, then USER REQUEST.',
    '',
    '## Test metadata',
    '',
    '- Chapter: ' + chapterTitle,
    '- Target: ~' + targetWords + ' words',
    '- Paws source provider: ' + (settings?.provider || 'unknown'),
    '- Paws source model: ' + sourceModel,
    '- Writing mode: ' + generationMode,
    '- Selected character sheets: ' + (characters.map((c) => c.name).join(', ') || '(none)'),
    '- Continuity memories included by Paws: ' + (memoryTitles.join(' → ') || '(none)'),
    '- Selected documents: ' + (selectedDocNames.join(', ') || '(none)'),
    '- Direct prior-chapter excerpts recalled: ' + storyExcerpts.length,
    '- Inky author brain: Writing DNA + learned feedback + relationship chemistry + local pressure map',
    '',
    '---',
    '',
    '# SYSTEM CONTEXT',
    '',
    promptParts.stablePrompt,
    '',
    promptParts.dynamicPrompt ? '---\n\n' + promptParts.dynamicPrompt : '',
    '',
    '---',
    '',
    '# USER REQUEST',
    '',
    userPrompt,
    '',
    '---',
    '',
    '## Fair-comparison note',
    '',
    'Do not invent knowledge outside this pack. Locked facts outrank all later material. Treat continuity memories as prior events, character sheets as current characterization/knowledge, and reference-document fragments only for their stated permitted purpose.',
  ].filter((v) => v !== '').join('\n\n');

  return {
    markdown,
    filename: 'Inky-Paws-Model-Test-' + safeName(chapterTitle) + '.md',
    stats: {
      characters: characters.length,
      memories: memoryTitles.length,
      documents: selectedDocNames.length,
      retrievedChunks: retrievedChunks.length,
    },
  };
}
