// Offline Milestone 3 unit tests & 500,000+ word benchmark:
// - 100 chapters / >500,000 synthetic words BM25 build, incremental update, Ch 7 promise recalled at Ch 100, bounded context & latency
// - Epistemic knowledge ledger: simultaneous secrets, false beliefs separate from canon, Eruri secrecy,
//   Joseph late arrival barrier, Room vs Screen Levi isolation, watching != living
// - Qualitative relationship continuity (rejects numeric scores)
// - Stale exclusion from authoritative canon & canonGuard
// - Alternative chapter exclusion, cross-story isolation, arc compression, v1/v2/v3 backup validation.
// Synthetic fixtures only; zero paid API calls.
// Run with: node tests/milestone3-unit.mjs
import assert from 'node:assert/strict';

import { DB_NAME, DB_VERSION, V1_STORE_NAMES, V2_STORE_NAMES, STORE_NAMES, validateBackupDump } from '../js/db.js';
import { buildContinuityBlock } from '../js/canonGuard.js';
import {
  normalizeKnowledgeFact,
  resolveEpistemicStateAtPoint,
  normalizeRelationshipState,
  resolveRelationshipsAtPoint,
} from '../js/knowledgeLedger.js';
import {
  buildChapterLexicalIndex,
  updateChapterLexicalIndexIncremental,
  searchLexicalIndex,
} from '../js/lexicalIndex.js';
import {
  compressArcWindow,
  assembleHierarchicalMemory,
} from '../js/hierarchicalMemory.js';
import { wordCount } from '../js/utils.js';

// 1. IndexedDB v3 additive schema & v1/v2/v3 backup compatibility
{
  assert.equal(DB_NAME, 'pts-studio');
  assert.equal(DB_VERSION, 3);
  assert.equal(V1_STORE_NAMES.length, 9);
  assert.equal(V2_STORE_NAMES.length, 15);
  assert.equal(STORE_NAMES.length, 18);
  for (const s of ['arcSummaries', 'relationshipStates', 'lexicalIndexes']) {
    assert.ok(STORE_NAMES.includes(s), `Missing v3 store: ${s}`);
  }

  const v1Full = { __meta: { app: 'pts-studio', version: 1 } };
  for (const s of V1_STORE_NAMES) v1Full[s] = [];
  assert.equal(validateBackupDump(v1Full).isFull, true);

  const v2Full = { __meta: { app: 'pts-studio', version: 2 } };
  for (const s of V2_STORE_NAMES) v2Full[s] = [];
  assert.equal(validateBackupDump(v2Full).isFull, true);

  const v3Full = { __meta: { app: 'pts-studio', version: 3 } };
  for (const s of STORE_NAMES) v3Full[s] = [];
  assert.equal(validateBackupDump(v3Full).isFull, true);

  const v3Partial = { __meta: { app: 'pts-studio', version: 3 } };
  for (const s of V2_STORE_NAMES) v3Partial[s] = [];
  assert.equal(validateBackupDump(v3Partial).isFull, false);
}

// 2. Simultaneous secrets with distinct audiences, false beliefs separate from canon, Eruri secrecy
{
  const eruriSecret = normalizeKnowledgeFact({
    id: 'fact-eruri',
    projectId: 'story-main',
    title: 'Relación secreta Eruri',
    truth: 'Erwin and Levi are secretly committed partners.',
    scope: 'world_fact',
    layer: 'room',
    isSecret: true,
    firstEffectiveChapterOrder: 1,
    disclosureConstraints: ['Never casually disclosed to the room'],
    beliefsByCharacter: {
      erwin: { state: 'knows', evidence: 'Direct mutual commitment', learnedAtChapterOrder: 1 },
      levi: { state: 'knows', evidence: 'Direct mutual commitment', learnedAtChapterOrder: 1 },
      hange: { state: 'suspects', beliefText: 'Suspects deep unspoken devotion between Erwin and Levi', evidence: 'Noticed silent glances during pause', learnedAtChapterOrder: 4 },
      eren: { state: 'believes_false', beliefText: 'Believes Erwin and Levi only share strict military respect and nothing personal', evidence: 'Levi dismissed rumors bluntly', learnedAtChapterOrder: 3 },
      mikasa: { state: 'unknown' },
    },
  });

  const hangeYmirSecret = normalizeKnowledgeFact({
    id: 'fact-compass',
    projectId: 'story-main',
    title: 'Brújula rota en el vestíbulo',
    truth: 'Hange and Ymir hid a cracked brass compass found behind the projector.',
    scope: 'room_event',
    layer: 'room',
    isSecret: true,
    firstEffectiveChapterOrder: 6,
    beliefsByCharacter: {
      hange: { state: 'knows', evidence: 'Found it behind the wall', learnedAtChapterOrder: 6 },
      ymir: { state: 'knows', evidence: 'Helped conceal it', learnedAtChapterOrder: 6 },
    },
  });

  const privateAuthorTruth = normalizeKnowledgeFact({
    id: 'fact-author-private',
    projectId: 'story-main',
    title: 'Identidad real del relojero',
    truth: 'The silent watchmaker from the prologue is secretly connected to the third screen arc.',
    scope: 'private_author',
    layer: 'global',
    isSecret: true,
    firstEffectiveChapterOrder: 1,
  });

  const futureFact = normalizeKnowledgeFact({
    id: 'fact-future-ch45',
    projectId: 'story-main',
    title: 'Revelación del capítulo 45',
    truth: 'At Chapter 45 the basement ledger is opened.',
    scope: 'revealed_canon',
    layer: 'screen',
    firstEffectiveChapterOrder: 45,
    beliefsByCharacter: {
      armin: { state: 'knows', evidence: 'Watched Chapter 45 footage', learnedAtChapterOrder: 45 },
    },
  });

  const resolvedAtCh10 = resolveEpistemicStateAtPoint({
    facts: [eruriSecret, hangeYmirSecret, privateAuthorTruth, futureFact],
    targetChapterOrder: 10,
    characterIds: ['erwin', 'levi', 'hange', 'ymir', 'eren', 'mikasa', 'armin'],
    characterVersion: 'room',
  });

  // Objective canon keeps true fact; future Ch 45 excluded; private author kept separate!
  assert.equal(resolvedAtCh10.futureExcludedCount, 1);
  assert.equal(resolvedAtCh10.privateAuthorTruths.length, 1);
  assert.ok(resolvedAtCh10.authoritativeCanon.some((f) => f.id === 'fact-eruri' && f.truth.includes('secretly committed')));
  assert.ok(!resolvedAtCh10.authoritativeCanon.some((f) => f.id === 'fact-future-ch45'));

  // Distinct audiences
  assert.ok(resolvedAtCh10.characterKnowledgeMap.erwin.knows.some((k) => k.factId === 'fact-eruri'));
  assert.ok(resolvedAtCh10.characterKnowledgeMap.hange.suspects.some((k) => k.factId === 'fact-eruri'));
  assert.ok(resolvedAtCh10.characterKnowledgeMap.hange.knows.some((k) => k.factId === 'fact-compass'));
  assert.ok(resolvedAtCh10.characterKnowledgeMap.ymir.knows.some((k) => k.factId === 'fact-compass'));
  assert.ok(!resolvedAtCh10.characterKnowledgeMap.erwin.knows.some((k) => k.factId === 'fact-compass'));

  // False belief stays separate from objective canon!
  const erenFalse = resolvedAtCh10.characterKnowledgeMap.eren.believesFalse.find((b) => b.factId === 'fact-eruri');
  assert.ok(erenFalse, 'Eren must hold the false belief separately');
  assert.ok(erenFalse.beliefText.includes('strict military respect'));
  assert.ok(erenFalse.objectiveTruth.includes('secretly committed'));

  // Mikasa does not know Eruri; nobody knows private author truth
  assert.ok(resolvedAtCh10.characterKnowledgeMap.mikasa.unknownSecrets.some((u) => u.factId === 'fact-eruri'));
  assert.ok(resolvedAtCh10.characterKnowledgeMap.armin.unknownSecrets.some((u) => u.factId === 'fact-author-private'));
}

// 3. Room vs Screen Levi isolation & watching != living + Joseph late arrival barrier
{
  const screenTraumaFact = normalizeKnowledgeFact({
    id: 'fact-screen-ep4',
    projectId: 'story-main',
    title: 'Escena de pantalla en episodio 4',
    truth: 'Screen Levi survived the subterranean flood alone in the footage shown at Chapter 4.',
    scope: 'screen_event',
    layer: 'screen',
    firstEffectiveChapterOrder: 4,
    beliefsByCharacter: {
      'levi@screen': { state: 'knows', beliefText: 'Lived through the flood directly', evidence: 'Direct physical survival', learnedAtChapterOrder: 4 },
      'levi@room': { state: 'knows', beliefText: 'Watched his screen counterpart endure the flood', evidence: 'Watched Episode 4 in the room', learnedAtChapterOrder: 4 },
      erwin: { state: 'knows', evidence: 'Watched Episode 4 in the room', learnedAtChapterOrder: 4 },
    },
  });

  const screenOnlyPrivateFact = normalizeKnowledgeFact({
    id: 'fact-screen-levi-private',
    projectId: 'story-main',
    title: 'Pensamiento privado de Screen Levi',
    truth: 'Screen Levi kept a folded letter inside his coat lining never shown to the room.',
    scope: 'screen_event',
    layer: 'screen',
    isSecret: true,
    firstEffectiveChapterOrder: 5,
    beliefsByCharacter: {
      'levi@screen': { state: 'knows', evidence: 'Placed it there himself', learnedAtChapterOrder: 5 },
    },
  });

  // Resolve for ROOM version at Chapter 12 with Joseph having arrived at Chapter 10
  const roomCh12 = resolveEpistemicStateAtPoint({
    facts: [screenTraumaFact, screenOnlyPrivateFact],
    targetChapterOrder: 12,
    characterIds: ['levi', 'erwin', 'joseph'],
    characterVersion: 'room',
    josephArrivalOrder: 10,
  });

  // Room Levi watched Ep 4 (`watched_not_lived`), and does NOT automatically know Screen Levi's private letter!
  const roomLeviEp4 = roomCh12.characterKnowledgeMap.levi.knows.find((k) => k.factId === 'fact-screen-ep4');
  assert.ok(roomLeviEp4);
  assert.equal(roomLeviEp4.experienceMode, 'watched_not_lived', 'Watching screen footage in room must be marked watched_not_lived');
  assert.ok(!roomCh12.characterKnowledgeMap.levi.knows.some((k) => k.factId === 'fact-screen-levi-private'), 'Screen Levi knowledge must NEVER auto-leak to Room Levi');

  // Screen Levi DOES know his private letter and has lived_direct mode!
  const screenCh12 = resolveEpistemicStateAtPoint({
    facts: [screenTraumaFact, screenOnlyPrivateFact],
    targetChapterOrder: 12,
    characterIds: ['levi'],
    characterVersion: 'screen',
  });
  const screenLeviPrivate = screenCh12.characterKnowledgeMap.levi.knows.find((k) => k.factId === 'fact-screen-levi-private');
  assert.ok(screenLeviPrivate);
  assert.equal(screenLeviPrivate.experienceMode, 'lived_direct');

  // Joseph arrived at Ch 10 -> Ep 4 (Ch 4) is BLOCKED by late arrival barrier until explicitly told!
  assert.ok(roomCh12.characterKnowledgeMap.joseph.blockedByLateArrival.some((b) => b.factId === 'fact-screen-ep4'));
  assert.ok(!roomCh12.characterKnowledgeMap.joseph.knows.some((k) => k.factId === 'fact-screen-ep4'));

  // Now Erwin briefs Joseph at Ch 12 with explicit evidence -> Joseph learns it cleanly at Ch 12 (still unknown at Ch 11!)
  const briefedFact = normalizeKnowledgeFact({
    ...screenTraumaFact,
    beliefsByCharacter: {
      ...screenTraumaFact.beliefsByCharacter,
      joseph: { state: 'knows', evidence: 'Erwin summarized Episode 4 to Joseph during break', learnedAtChapterOrder: 12 },
    },
  });
  const roomCh11 = resolveEpistemicStateAtPoint({
    facts: [briefedFact],
    targetChapterOrder: 11,
    characterIds: ['joseph'],
    characterVersion: 'room',
    josephArrivalOrder: 10,
  });
  assert.ok(!roomCh11.characterKnowledgeMap.joseph.knows.some((k) => k.factId === 'fact-screen-ep4'), 'Before briefing at Ch 12, Joseph still must not know Ep 4');
  const roomCh12Briefed = resolveEpistemicStateAtPoint({
    facts: [briefedFact],
    targetChapterOrder: 12,
    characterIds: ['joseph'],
    characterVersion: 'room',
    josephArrivalOrder: 10,
  });
  assert.ok(roomCh12Briefed.characterKnowledgeMap.joseph.knows.some((k) => k.factId === 'fact-screen-ep4'));
}

// 4. Qualitative relationship continuity (rejects numeric affection scores!)
{
  assert.throws(() => normalizeRelationshipState({
    participants: ['erwin', 'levi'],
    dimensions: { affection: 85 },
  }), /cualitativa/i, 'Numeric affection scores must be rejected');

  const eruriRel = normalizeRelationshipState({
    id: 'rel-eruri',
    projectId: 'story-main',
    participants: ['erwin', 'levi'],
    label: 'Erwin Smith & Levi Ackerman',
    relationshipStage: 'secret_relationship',
    effectiveChapterOrder: 1,
    dimensions: {
      trust: 'Implicit battlefield trust frayed only when Erwin hides personal risk.',
      affection: 'Expressed through tea, quiet proximity, and protective attention.',
      romanticTension: 'Restrained in front of the squad; unmistakable in silence.',
      loyalty: 'Absolute but fiercely honest rather than blind.',
    },
    promises: [
      { text: 'Levi promised Erwin in Chapter 7 that they would leave the room together once the final reel ended.', madeBy: 'levi', madeTo: 'erwin', chapterOrder: 7, sourceChapterId: 'ch-7', status: 'open' },
      { text: 'Future Ch 90 vow', madeBy: 'erwin', madeTo: 'levi', chapterOrder: 90, sourceChapterId: 'ch-90', status: 'open' },
    ],
    unresolvedDisagreements: ['Erwin still withholds how far he is willing to gamble his own life.'],
    behaviorChanges: ['Levi sits within arm reach whenever Erwin goes unusually still.'],
  });

  const atCh20 = resolveRelationshipsAtPoint({ relationships: [eruriRel], targetChapterOrder: 20 });
  assert.equal(atCh20.authoritative.length, 1);
  assert.equal(atCh20.openPromises.length, 1, 'Future Ch 90 promise must be excluded at Ch 20');
  assert.ok(atCh20.openPromises[0].text.includes('Chapter 7'));
}

// 5. Stale exclusion from authoritative canonGuard & hierarchical memory
{
  const staleMem = { id: 'm1', chapterId: 'ch1', chapterTitle: 'Ch 1', events: 'OLD INVALID CLAIM', stale: true };
  const freshMem = { id: 'm2', chapterId: 'ch2', chapterTitle: 'Ch 2', events: 'VALID CURRENT EVENT', stale: false };
  const block = buildContinuityBlock([staleMem, freshMem], [], '', []);
  assert.ok(!block.includes('OLD INVALID CLAIM'), 'Stale memories must NOT enter authoritative continuity in canonGuard');
  assert.ok(block.includes('VALID CURRENT EVENT'));
}

// 6. SCALE BENCHMARK: 100 chapters & 500,000+ synthetic words!
//    - Plant a specific promise in Chapter 7 ("silver pocket watch oath under the cedar rafters")
//    - Plant a divergent secret in an ALTERNATIVE Chapter 7 (must NEVER leak!)
//    - Plant a stale fact from an edited Chapter 12 (must go to staleForReview, NOT authoritativeCanon!)
//    - Plant chapters in another workspace Story B (must NEVER leak!)
//    - Recall the Chapter 7 promise at Chapter 100 with bounded context & measured latency!
{
  const fillerParagraphs = [
    'The viewing chamber remained hushed as rain tapped against the tall frosted panes and the lantern light flickered across worn wooden benches. Erwin folded his hands carefully while studying the shadows along the aisle, weighing every unspoken consequence without rushing his companions into reckless certainty. Across the table, Hange scribbled rapid margins across parchment sheets, murmuring questions about timelines and logistics while Petra quietly poured fresh tea for anyone whose shoulders had gone stiff from hours of watching.',
    'Eren leaned forward with restless urgency, jaw set as Armin traced careful patterns over the edge of his notebook, separating observable evidence from mere guesswork. Mikasa kept her gaze balanced between the screen and the doorway, alert to the smallest shift in breathing, while Jean muttered a dry remark that earned an exasperated snort from Sasha and a half-hearted grin from Connie. Historia sat beside Ymir near the hearth, trading quiet glances that carried more restraint than either cared to admit aloud.',
    'Levi stood near the back wall with his arms crossed, expression composed and voice stripped of unnecessary ornament whenever he cut through speculation. Candy adjusted the brass lever beside the projector reel without intruding on the debate, letting silence stretch until each spectator found their own footing amid the weight of what had just unfolded. Nobody spoke carelessly about the weeks ahead, knowing that memory in this room carried sharp edges and long echoes.',
    'Between reels, small domestic habits anchored the group against exhaustion: stacked teacups, chalk marks along the slate board, folded cloaks draped neatly over chair backs, and measured pacing along the corridor. Each conversation left subtle traces in how glances lingered, how trust bent under stress, and which truths remained locked behind guarded politeness until the right moment forced them into daylight.',
  ];
  // ~74 words per paragraph -> 72 paragraphs per chapter = ~5,360 words/chapter * 100 chapters = >530,000 words!
  const baseBody = Array.from({ length: 72 }, (_, i) => fillerParagraphs[i % fillerParagraphs.length]).join('\n\n');

  const chapters = [];
  const memoryEntries = [];
  let totalWords = 0;

  for (let i = 1; i <= 100; i += 1) {
    let content = baseBody;
    if (i === 7) {
      content += '\n\nBeneath the cedar rafters after the reel stopped, Levi pressed the dented silver pocket watch into Erwin’s palm and swore an ironbound lantern oath that neither of them would vanish into the smoke without answering for the other.';
    }
    const wc = wordCount(content);
    totalWords += wc;
    chapters.push({
      id: `ch-${i}`,
      projectId: 'epic-100',
      order: i,
      title: `Chapter ${i}: Long Chronicle Part ${i}`,
      content,
      wordCount: wc,
      branchRole: 'main',
      createdAt: `2026-01-${String(((i - 1) % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    });
    memoryEntries.push({
      id: `mem-${i}`,
      projectId: 'epic-100',
      chapterId: `ch-${i}`,
      chapterTitle: `Chapter ${i}: Long Chronicle Part ${i}`,
      events: i === 7
        ? 'Levi made the silver pocket watch lantern oath to Erwin beneath the cedar rafters.'
        : `Chapter ${i} progressed the room discussion around reel ${i}.`,
      relationshipChanges: i === 7 ? 'Erwin and Levi cemented a quiet private vow.' : '',
      openThreads: i === 7 ? 'Unfulfilled silver pocket watch oath from Chapter 7.' : '',
      stale: i === 12, // Ch 12 memory is stale!
      createdAt: `2026-01-${String(((i - 1) % 28) + 1).padStart(2, '0')}T11:00:00Z`,
    });
  }

  // Alternative Chapter 7 (divergent branch — MUST NEVER enter main continuity!)
  chapters.push({
    id: 'ch-7-alt',
    projectId: 'epic-100',
    order: 7,
    title: 'Chapter 7 (Alternative Draft)',
    content: 'ALTERNATIVE_SECRET_TOKEN_XYZ999: Levi shattered the silver pocket watch and left the room forever.',
    wordCount: 15,
    branchRole: 'alternative',
    branchGroupId: 'grp-7',
  });

  // Unrelated story workspace (Story B — MUST NEVER leak into epic-100!)
  chapters.push({
    id: 'other-ch-7',
    projectId: 'other-story-b',
    order: 7,
    title: 'Other Story Chapter 7',
    content: 'OTHER_STORY_LEAK_TOKEN_ABC777 silver pocket watch cedar rafters lantern oath.',
    wordCount: 12,
    branchRole: 'main',
  });

  assert.ok(totalWords >= 500000, `Expected >= 500,000 synthetic words, got ${totalWords}`);

  // Build BM25 index & measure exact build time
  const scopedMain = chapters.filter((c) => c.projectId === 'epic-100');
  const buildStart = performance.now();
  const chIndex = buildChapterLexicalIndex(scopedMain, { projectId: 'epic-100' });
  const buildMs = Number((performance.now() - buildStart).toFixed(2));

  // Verify alternative Chapter 7 was NEVER indexed
  const altSearch = searchLexicalIndex(chIndex, 'ALTERNATIVE_SECRET_TOKEN_XYZ999', { topK: 5 });
  assert.equal(altSearch.length, 0, 'Alternative chapter must NEVER enter BM25 lexical index');

  // Verify incremental update when 1 chapter changes is fast & surgical
  const modifiedChapters = scopedMain.map((c) =>
    c.id === 'ch-50' ? { ...c, content: `${c.content}\n\nINCREMENTAL_MARKER_CH50_UNIQUE` } : c
  );
  const incStart = performance.now();
  const incResult = updateChapterLexicalIndexIncremental(chIndex, modifiedChapters, { projectId: 'epic-100' });
  const incMs = Number((performance.now() - incStart).toFixed(2));
  assert.equal(incResult.rebuilt, true);
  assert.deepEqual(incResult.changedChapterIds, ['ch-50']);
  assert.equal(searchLexicalIndex(incResult.index, 'INCREMENTAL_MARKER_CH50_UNIQUE', { topK: 3 }).length, 1);

  // Compress Arc 1 (Chapters 1–25) -> verify lossless-priority preservation of secrets & promises!
  const ch7Fact = normalizeKnowledgeFact({
    id: 'kf-ch7-oath',
    projectId: 'epic-100',
    title: 'Juramento del reloj de plata (Cap. 7)',
    truth: 'Levi handed Erwin the dented silver pocket watch under the cedar rafters and promised neither would vanish unanswered.',
    scope: 'room_event',
    layer: 'room',
    isSecret: true,
    sourceChapterId: 'ch-7',
    firstEffectiveChapterOrder: 7,
  });
  const staleCh12Fact = normalizeKnowledgeFact({
    id: 'kf-ch12-stale',
    projectId: 'epic-100',
    title: 'Hecho desactualizado del Cap. 12',
    truth: 'Outdated claim from before Chapter 12 was rewritten.',
    scope: 'room_event',
    layer: 'room',
    sourceChapterId: 'ch-12',
    firstEffectiveChapterOrder: 12,
    stale: true,
    disputed: true,
  });
  const relEpic = normalizeRelationshipState({
    id: 'rel-epic-eruri',
    projectId: 'epic-100',
    participants: ['erwin', 'levi'],
    label: 'Erwin & Levi',
    relationshipStage: 'secret_vow',
    effectiveChapterOrder: 7,
    promises: [{ text: 'Silver pocket watch lantern oath from Chapter 7.', madeBy: 'levi', madeTo: 'erwin', chapterOrder: 7, sourceChapterId: 'ch-7', status: 'open' }],
  });

  const arc1 = compressArcWindow({
    projectId: 'epic-100',
    arcOrder: 1,
    title: 'Arc I — Cedar Rafters & Early Reels',
    startChapterOrder: 1,
    endChapterOrder: 25,
    chapters: scopedMain,
    memoryEntries,
    knowledgeFacts: [ch7Fact, staleCh12Fact],
    relationships: [relEpic],
  });
  assert.ok(arc1.preservedSecrets.some((s) => s.includes('silver pocket watch')), 'Arc compression must preserve Chapter 7 secret');
  assert.ok(arc1.preservedPromises.some((p) => p.includes('Silver pocket watch')), 'Arc compression must preserve Chapter 7 open promise');
  assert.ok(!arc1.preservedSecrets.some((s) => s.includes('Outdated claim')), 'Stale facts must NOT be compressed into authoritative arc summaries');

  // Assemble hierarchical memory at Chapter 100 recalling the Chapter 7 promise!
  const assembled = assembleHierarchicalMemory({
    projectId: 'epic-100',
    targetChapterOrder: 100,
    query: 'silver pocket watch lantern oath cedar rafters chapter 7',
    characterVersion: 'room',
    activeCharacterIds: ['erwin', 'levi', 'hange'],
    chapters,
    memoryEntries,
    knowledgeFacts: [ch7Fact, staleCh12Fact],
    relationships: [relEpic],
    arcSummaries: [arc1],
    lockedFacts: [{ id: 'lf-1', projectId: 'epic-100', text: 'Erwin and Levi never break sworn oaths lightly.' }],
    chapterLexicalIndex: chIndex,
    maxTotalChars: 24000,
  });

  // Verify Chapter 7 promise recalled at Chapter 100!
  const recalledCh7Passage = assembled.layers.C_historical_episodic.historicalPassages.find((h) => h.chapterOrder === 7);
  assert.ok(recalledCh7Passage, 'Chapter 7 silver pocket watch passage must be recalled at Chapter 100!');
  assert.ok(recalledCh7Passage.excerpt.toLowerCase().includes('silver pocket watch') || recalledCh7Passage.matchedTerms.includes('pocket'));
  assert.ok(assembled.layers.F_permanent_canon.openThreads.some((t) => t.text.includes('Silver pocket watch')));
  assert.ok(assembled.layers.E_arc_summaries.arcSummaries.length === 1);

  // Verify strict exclusions: NO alternative Ch 7, NO Story B, NO Ch 100 future chapter, NO stale Ch 12 in authoritative canon!
  assert.ok(!assembled.layers.C_historical_episodic.historicalPassages.some((h) => h.chapterId === 'ch-7-alt'));
  assert.ok(!assembled.layers.C_historical_episodic.historicalPassages.some((h) => h.chapterId === 'other-ch-7'));
  assert.ok(!assembled.layers.C_historical_episodic.historicalPassages.some((h) => h.chapterOrder >= 100));
  assert.ok(!assembled.layers.D_character_epistemic_and_relationships.authoritativeFacts.some((f) => f.id === 'kf-ch12-stale'));
  assert.equal(assembled.staleForReview.memories.length, 1);
  assert.equal(assembled.staleForReview.knowledgeFacts.length, 1);
  assert.equal(assembled.stats.alternativeExcludedCount, 1);

  // Verify bounded context size!
  assert.ok(assembled.stats.assembledChars <= 24000, `Assembled context exceeded 24,000 char budget: ${assembled.stats.assembledChars}`);
  assert.ok(assembled.explainability.some((e) => e.chapterOrder === 7 && e.whyRetrieved.includes('BM25')));

  console.log(
    `BENCHMARK (500k+ words): chapters=100, words=${totalWords.toLocaleString('en-US')}, ` +
    `passages=${chIndex.totalDocs}, bm25BuildMs=${buildMs}, incremental1ChMs=${incMs}, ` +
    `ch100RecallMs=${assembled.stats.retrievalMs}, assembledChars=${assembled.stats.assembledChars}/${assembled.stats.budgetCapChars} ` +
    `(~${assembled.stats.approxTokens} tokens)`
  );
}

console.log('PASS: all Milestone 3 offline unit tests & 500,000+ word benchmark passed (v3 schema, epistemic ledger, false beliefs, Eruri secrecy, Joseph late arrival, Room vs Screen Levi, qualitative relationships, stale exclusion, alternative exclusion, cross-story isolation, arc compression, Ch 7 -> Ch 100 BM25 recall).');
