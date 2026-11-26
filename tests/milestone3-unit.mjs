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
  appendBeliefTransitionToFact,
  resolveEpistemicStateAtPoint,
  normalizeRelationshipState,
  appendRelationshipTransitionToState,
  resolveRelationshipsAtPoint,
} from '../js/knowledgeLedger.js';
import {
  buildChapterLexicalIndex,
  buildDocumentLexicalIndex,
  isDocumentLexicalIndexFresh,
  updateChapterLexicalIndexIncremental,
  searchLexicalIndex,
} from '../js/lexicalIndex.js';
import {
  compressArcWindow,
  assembleHierarchicalMemory,
} from '../js/hierarchicalMemory.js';
import { wordCount } from '../js/utils.js';

// 1. IndexedDB v3+ additive schema & v1/v2/v3 backup compatibility
{
  assert.equal(DB_NAME, 'pts-studio');
  assert.ok(DB_VERSION >= 3);
  assert.equal(V1_STORE_NAMES.length, 9);
  assert.equal(V2_STORE_NAMES.length, 15);
  assert.ok(STORE_NAMES.length >= 18);
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
  for (const s of [...V2_STORE_NAMES, 'arcSummaries', 'relationshipStates', 'lexicalIndexes']) v3Full[s] = [];
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
  assert.equal(arc1.isCompressedSummary, true);
  assert.equal(arc1.lossless, false);
  assert.ok(arc1.preservedSecrets.some((s) => s.factId === 'kf-ch7-oath' && s.truth.includes('silver pocket watch')), 'Arc compression must preserve Chapter 7 secret with provenance');
  assert.ok(arc1.preservedPromises.some((p) => p.text.includes('Silver pocket watch') && p.status === 'open'), 'Arc compression must preserve Chapter 7 open promise');
  assert.ok(!arc1.preservedSecrets.some((s) => s.truth.includes('Outdated claim')), 'Stale facts must NOT be compressed into authoritative arc summaries');

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

  // Verify REAL serialized model payload budget (distinct from Inspector diagnostics)!
  const realSerializedChars = JSON.stringify(assembled.modelPayload).length;
  assert.equal(assembled.budget.actualSerializedChars, realSerializedChars);
  assert.ok(realSerializedChars <= 24000, `Serialized modelPayload exceeded 24,000 char budget: ${realSerializedChars}`);
  assert.ok(assembled.explainability.some((e) => e.chapterOrder === 7 && e.whyRetrieved.includes('BM25')));
  assert.equal('explainability' in assembled.modelPayload, false, 'Inspector explainability must stay separate from modelPayload');

  console.log(
    `BENCHMARK (500k+ words): chapters=100, words=${totalWords.toLocaleString('en-US')}, ` +
    `passages=${chIndex.totalDocs}, bm25BuildMs=${buildMs}, incremental1ChMs=${incMs}, ` +
    `ch100RecallMs=${assembled.stats.retrievalMs}, serializedModelChars=${realSerializedChars}/${assembled.budget.maxTotalChars} ` +
    `(~${assembled.budget.estimatedTokens} est. tokens)`
  );
}

// 7. PART A Finding #1: Append-only historical character beliefs (Hange Ch5 -> Ch12 -> Ch20 -> Ch24),
//    scene-level transitions, temporal relationship snapshots & promise status transitions
{
  let fact = normalizeKnowledgeFact({
    id: 'kf-hange-arc',
    projectId: 'story-temporal',
    title: 'Relación secreta Eruri',
    truth: 'Erwin and Levi are secretly in love.',
    scope: 'world_fact',
    layer: 'room',
    isSecret: true,
    firstEffectiveChapterOrder: 1,
    disclosureConstraints: ['Must remain secret from cadets'],
  });
  fact = appendBeliefTransitionToFact(fact, 'hange@room', {
    state: 'suspects',
    beliefText: 'Suspects Erwin and Levi share a private bond',
    evidence: 'Ch 5 silent tea exchange',
    effectiveChapterOrder: 5,
    sceneOrder: 2,
    sourceChapterId: 't-ch5',
  });
  fact = appendBeliefTransitionToFact(fact, 'hange@room', {
    state: 'believes_false',
    beliefText: 'Believes they are merely plotting an undercover transfer',
    evidence: 'Ch 12 misleading cover story',
    effectiveChapterOrder: 12,
    sceneOrder: 1,
    sourceChapterId: 't-ch12',
  });
  fact = appendBeliefTransitionToFact(fact, 'hange@room', {
    state: 'knows',
    beliefText: 'Discovered Erwin and Levi are secretly together',
    evidence: 'Ch 20 hallway conversation',
    effectiveChapterOrder: 20,
    sceneOrder: 1,
    sourceChapterId: 't-ch20',
  });
  fact = appendBeliefTransitionToFact(fact, 'hange@room', {
    state: 'knows',
    deliberatelyConcealing: true,
    concealmentNote: 'Pretends ignorance to protect them in front of the room',
    evidence: 'Ch 24 deliberate deflection',
    effectiveChapterOrder: 24,
    sceneOrder: 1,
    sourceChapterId: 't-ch24',
  });

  // Rewriting Ch 10 recovers Ch 5 suspicion (NOT Ch 20 truth and NOT empty!)
  const atCh10 = resolveEpistemicStateAtPoint({ facts: [fact], targetChapterOrder: 10, characterIds: ['hange'], characterVersion: 'room' });
  assert.equal(atCh10.characterKnowledgeMap.hange.suspects.length, 1);
  assert.equal(atCh10.characterKnowledgeMap.hange.knows.length, 0);
  assert.equal(atCh10.characterKnowledgeMap.hange.believesFalse.length, 0);

  // Scene-level precision within Ch 5: Scene 1 (before Scene 2 suspicion) -> unknown; Scene 2 -> suspects!
  const atCh5S1 = resolveEpistemicStateAtPoint({ facts: [fact], targetChapterOrder: 5, targetSceneOrder: 1, characterIds: ['hange'], characterVersion: 'room' });
  assert.equal(atCh5S1.characterKnowledgeMap.hange.suspects.length, 0);
  const atCh5S2 = resolveEpistemicStateAtPoint({ facts: [fact], targetChapterOrder: 5, targetSceneOrder: 2, characterIds: ['hange'], characterVersion: 'room' });
  assert.equal(atCh5S2.characterKnowledgeMap.hange.suspects.length, 1);

  // Rewriting Ch 15 recovers Ch 12 false belief
  const atCh15 = resolveEpistemicStateAtPoint({ facts: [fact], targetChapterOrder: 15, characterIds: ['hange'], characterVersion: 'room' });
  assert.equal(atCh15.characterKnowledgeMap.hange.believesFalse.length, 1);
  assert.equal(atCh15.characterKnowledgeMap.hange.knows.length, 0);

  // Rewriting Ch 21 recovers Ch 20 knowledge (not yet concealing)
  const atCh21 = resolveEpistemicStateAtPoint({ facts: [fact], targetChapterOrder: 21, characterIds: ['hange'], characterVersion: 'room' });
  assert.equal(atCh21.characterKnowledgeMap.hange.knows.length, 1);
  assert.equal(atCh21.characterKnowledgeMap.hange.knows[0].deliberatelyConcealing, false);

  // Writing Ch 25 recovers Ch 24 deliberate concealment
  const atCh25 = resolveEpistemicStateAtPoint({ facts: [fact], targetChapterOrder: 25, characterIds: ['hange'], characterVersion: 'room' });
  assert.equal(atCh25.characterKnowledgeMap.hange.knows[0].deliberatelyConcealing, true);

  // Temporal relationship snapshots & promise status transitions (open at Ch 7, kept at Ch 30 -> open at Ch 15!)
  let rel = normalizeRelationshipState({
    id: 'rel-hist',
    projectId: 'story-temporal',
    participants: ['erwin', 'levi'],
    relationshipStage: 'guarded_pining',
    effectiveChapterOrder: 5,
    dimensions: { trust: 'Cautious unspoken trust.' },
    promises: [{
      text: 'Leave the room together after the final reel.',
      chapterOrder: 7,
      statusHistory: [
        { status: 'open', effectiveChapterOrder: 7, sourceChapterId: 't-ch7' },
        { status: 'kept', effectiveChapterOrder: 30, sourceChapterId: 't-ch30' },
      ],
    }],
  });
  rel = appendRelationshipTransitionToState(rel, {
    effectiveChapterOrder: 22,
    relationshipStage: 'established_relationship',
    dimensions: { trust: 'Unshakable shared resolve after the Ch 22 confession.' },
    sourceChapterId: 't-ch22',
  });
  const relAt15 = resolveRelationshipsAtPoint({ relationships: [rel], targetChapterOrder: 15 });
  assert.equal(relAt15.authoritative[0].relationshipStage, 'guarded_pining');
  assert.equal(relAt15.openPromises.length, 1, 'Promise kept at Ch 30 must still be open when rewriting Ch 15');
  const relAt31 = resolveRelationshipsAtPoint({ relationships: [rel], targetChapterOrder: 31 });
  assert.equal(relAt31.authoritative[0].relationshipStage, 'established_relationship');
  assert.equal(relAt31.openPromises.length, 0, 'Promise kept at Ch 30 is no longer open at Ch 31');
}

// 8. PART A Finding #2: Future-containing arc exclusion/slicing, alternative sources, prologues, equal-order, ambiguous metadata
{
  const timelineChapters = [
    { id: 'p0', projectId: 's-leak', order: 0, title: 'Prologue: Before the Screen', content: 'Prologue lantern glow before chapter one.', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'c1a', projectId: 's-leak', order: 1, title: 'Chapter 1', content: 'Early legacy chapter one first.', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'c1b', projectId: 's-leak', order: 1, title: 'Chapter 2', content: 'Equal-order legacy chapter two.', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'c7', projectId: 's-leak', order: 7, title: 'Chapter 7', content: 'Chapter seven current target being rewritten.', createdAt: '2026-01-07T00:00:00Z' },
    { id: 'c7-alt', projectId: 's-leak', order: 7, title: 'Chapter 7 Alt', content: 'Alternative branch content.', branchRole: 'alternative', createdAt: '2026-01-07T01:00:00Z' },
    { id: 'c18', projectId: 's-leak', order: 18, title: 'Chapter 18', content: 'FUTURE_SPOILER_BETRAYAL_CH18 happened in chapter 18.', createdAt: '2026-01-18T00:00:00Z' },
  ];
  const spanningArc = {
    id: 'arc-1-20',
    projectId: 's-leak',
    arcOrder: 1,
    title: 'Arc I (Caps 1-20)',
    startChapterOrder: 1,
    endChapterOrder: 20,
    summary: 'Includes FUTURE_SPOILER_BETRAYAL_CH18 from Chapter 18!',
    preservedSecrets: [],
    preservedPromises: [],
    openThreads: ['FUTURE_SPOILER_BETRAYAL_CH18'],
    sourceChapterIds: ['c1a', 'c18'],
  };
  const altFact = normalizeKnowledgeFact({
    id: 'kf-alt-only',
    projectId: 's-leak',
    title: 'Fact from alternative chapter',
    truth: 'ALT_FACT_MUST_NEVER_LEAK',
    scope: 'room_event',
    sourceChapterId: 'c7-alt',
    firstEffectiveChapterOrder: 2,
  });
  const ambiguousEventFact = normalizeKnowledgeFact({
    id: 'kf-ambiguous',
    projectId: 's-leak',
    title: 'Event without temporal anchor',
    truth: 'AMBIGUOUS_EVENT_WITHOUT_ORDER',
    scope: 'room_event',
    firstEffectiveChapterOrder: null,
    firstEffectiveCheckpoint: '',
  });

  const rewriteCh7 = assembleHierarchicalMemory({
    projectId: 's-leak',
    targetChapterId: 'c7',
    targetChapterOrder: 7,
    query: 'lantern glow betrayal',
    chapters: timelineChapters,
    arcSummaries: [spanningArc],
    knowledgeFacts: [altFact, ambiguousEventFact],
  });
  const serialized = JSON.stringify(rewriteCh7.modelPayload);
  assert.ok(!serialized.includes('FUTURE_SPOILER_BETRAYAL_CH18'), 'Arc spanning 1-20 must NEVER leak Ch 18 spoiler when rewriting Ch 7!');
  assert.ok(!serialized.includes('ALT_FACT_MUST_NEVER_LEAK'), 'Fact sourced from alternative chapter must NEVER enter main timeline!');
  assert.ok(!serialized.includes('AMBIGUOUS_EVENT_WITHOUT_ORDER'), 'Event fact missing temporal anchor must NOT silently authorize for Ch 7!');
  assert.equal(rewriteCh7.inspectorDiagnostics.futureContainingArcsExcluded.length, 1);
  assert.equal(rewriteCh7.inspectorDiagnostics.ambiguousTemporalExcluded.length, 1);
  assert.equal(rewriteCh7.inspectorDiagnostics.alternativeSourcesExcluded.length, 1);
  // Prologue & equal-order chapters before c7 remain accessible!
  assert.ok(rewriteCh7.layers.C_historical_episodic.historicalPassages.some((p) => p.chapterId === 'p0'), 'Prologue must remain retrievable!');
}

// 9. PART A Finding #3: Prologue-aware & title-number-aware exact chapter recall (EN/ES, skipped, renamed, reordered)
{
  const irregularChapters = [
    { id: 'ic-pro', projectId: 's-num', order: 0, title: 'Prólogo: Antes del silencio', content: 'Prologue opening scene in the rain.', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'ic-1', projectId: 's-num', order: 1, title: 'Chapter 1: Arrival', content: 'First numbered chapter arrival.', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'ic-2', projectId: 's-num', order: 2, title: 'Capítulo 2: Té de la tarde', content: 'Second numbered chapter tea.', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'ic-7', projectId: 's-num', order: 3, title: 'Chapter 7: The Seventh Key', content: 'Actual Chapter Seven secret cellar key.', createdAt: '2026-01-04T00:00:00Z' },
    { id: 'ic-8', projectId: 's-num', order: 4, title: 'Capítulo 10: Reordenado', content: 'Tenth chapter title.', createdAt: '2026-01-05T00:00:00Z' },
    { id: 'ic-9', projectId: 's-num', order: 5, title: 'Untitled Interlude', content: 'Interlude without number.', createdAt: '2026-01-06T00:00:00Z' },
    { id: 'ic-10', projectId: 's-num', order: 6, title: 'Chapter 12: Twelfth Hour', content: 'This is the 7th internal record but NOT Chapter 7!', createdAt: '2026-01-07T00:00:00Z' },
  ];
  const idx = buildChapterLexicalIndex(irregularChapters, { projectId: 's-num' });

  const hitEn = searchLexicalIndex(idx, 'chapter 7', { topK: 3 });
  assert.equal(hitEn[0]?.chapterId, 'ic-7', 'English "chapter 7" must return actual Chapter 7, NOT the 7th internal record!');
  assert.equal(hitEn[0]?.exactChapterHit, true);

  const hitEs = searchLexicalIndex(idx, 'capítulo 7', { topK: 3 });
  assert.equal(hitEs[0]?.chapterId, 'ic-7', 'Spanish "capítulo 7" must return actual Chapter 7!');

  const hitPrologue = searchLexicalIndex(idx, 'prólogo', { topK: 3 });
  assert.equal(hitPrologue[0]?.chapterId, 'ic-pro', 'Spanish "prólogo" must retrieve the prologue!');

  const hitCh10 = searchLexicalIndex(idx, 'cap. 10', { topK: 3 });
  assert.equal(hitCh10[0]?.chapterId, 'ic-8', 'Skipped/reordered "cap. 10" must match Capítulo 10 by title number!');
}

// 10. PART A Finding #4: Essential context over-budget warning without silently truncating critical rules/secrets
{
  const manyLocked = Array.from({ length: 25 }, (_, i) => ({
    id: `lf-big-${i}`,
    projectId: 's-budget',
    text: `CRITICAL LOCKED RULE #${i + 1}: Do not violate this non-negotiable canon invariant under any circumstances whatsoever in any scene.`,
  }));
  const criticalSecret = normalizeKnowledgeFact({
    id: 'kf-crit',
    projectId: 's-budget',
    title: 'Critical Secret',
    truth: 'Must never be silently truncated even under tight budget.',
    scope: 'private_author',
    isSecret: true,
    firstEffectiveChapterOrder: 1,
    disclosureConstraints: ['Never reveal before Act III'],
  });
  const tight = assembleHierarchicalMemory({
    projectId: 's-budget',
    targetChapterOrder: 5,
    lockedFacts: manyLocked,
    knowledgeFacts: [criticalSecret],
    maxTotalChars: 2000,
  });
  assert.equal(tight.budget.overBudget, true);
  assert.ok(tight.budget.warnings.some((w) => w.code === 'essential_context_exceeds_budget'));
  assert.ok(tight.budget.suggestions.length >= 2);
  assert.equal(tight.modelPayload.layers.F_permanent_canon.lockedFacts.length, 25, 'Locked facts must NEVER be silently truncated');
  assert.equal(tight.modelPayload.layers.F_permanent_canon.criticalSecretRules.length, 1, 'Critical secrets & disclosure constraints must NEVER be silently truncated');
}

// 11. PART A Finding #5: Rich secret provenance in arc compression & private_author stays authorOnly
{
  const privFact = normalizeKnowledgeFact({
    id: 'kf-priv-provenance',
    projectId: 's-prov',
    title: 'Private Author Secret',
    truth: 'The hidden traitor is Commander X.',
    scope: 'private_author',
    layer: 'global',
    isSecret: true,
    sourceChapterId: 'prov-ch1',
    sourceChapterRevision: 'rev_abc',
    firstEffectiveChapterOrder: 1,
    firstEffectiveCheckpoint: 'before_first_screen',
    disclosureConstraints: ['Author-only truth; zero character knowledge'],
    beliefsByCharacter: {
      'hange@room': { state: 'suspects', evidence: 'Noticed missing seal', effectiveChapterOrder: 2 },
      'eren@room': { state: 'unknown', effectiveChapterOrder: 1 },
    },
  });
  const provArc = compressArcWindow({
    projectId: 's-prov',
    arcOrder: 1,
    startChapterOrder: 1,
    endChapterOrder: 5,
    chapters: [{ id: 'prov-ch1', projectId: 's-prov', order: 1, title: 'Chapter 1', content: 'Opening scene.' }],
    knowledgeFacts: [privFact],
  });
  const sec = provArc.preservedSecrets.find((s) => s.factId === 'kf-priv-provenance');
  assert.ok(sec);
  assert.equal(sec.authorOnly, true, 'private_author truth must stay authorOnly during arc compression');
  assert.equal(sec.scope, 'private_author');
  assert.equal(sec.sourceChapterId, 'prov-ch1');
  assert.equal(sec.sourceChapterRevision, 'rev_abc');
  assert.equal(sec.firstEffectiveCheckpoint, 'before_first_screen');
  assert.deepEqual(sec.suspectedBy, ['hange@room']);
  assert.deepEqual(sec.unknownTo, ['eren@room']);
  assert.deepEqual(sec.disclosureConstraints, ['Author-only truth; zero character knowledge']);
  assert.deepEqual(sec.characterVersions, ['room']);
  assert.ok(sec.evidenceLinks.length >= 2);
}

// 12. PART A Finding #7: Optional derived lexicalIndexes in backups + active/deleted/changed document index freshness
{
  // Full v3 backup WITHOUT lexicalIndexes is valid & FULL!
  const v3NoDerived = { __meta: { app: 'pts-studio', version: 3, derivedIndexesExcluded: true } };
  for (const s of STORE_NAMES) {
    if (s !== 'lexicalIndexes') v3NoDerived[s] = [];
  }
  const info = validateBackupDump(v3NoDerived);
  assert.equal(info.isFull, true);
  assert.equal(info.includesDerivedIndexes, false);

  // Document lexical index detects inactive / modified / deleted documents immediately!
  const docsV1 = [
    { id: 'doc-1', filename: 'Lore.txt', type: 'CANON', active: true },
    { id: 'doc-2', filename: 'Style.txt', type: 'STYLE_ONLY', active: true },
  ];
  const chunksV1 = [
    { id: 'ck-1', documentId: 'doc-1', index: 0, text: 'OBSIDIAN_CITADEL_ARCHIVE lore record.' },
    { id: 'ck-2', documentId: 'doc-2', index: 0, text: 'Violet Evergarden style cadence.' },
  ];
  const docIdx = buildDocumentLexicalIndex(docsV1, chunksV1, { projectId: 's-docs' });
  assert.equal(isDocumentLexicalIndexFresh(docIdx, docsV1, chunksV1), true);
  assert.equal(searchLexicalIndex(docIdx, 'OBSIDIAN_CITADEL_ARCHIVE', { excludeDocTypes: ['STYLE_ONLY'] }).length, 1);

  // Deactivating doc-1 invalidates freshness and rebuilt index returns 0 hits!
  const docsDeactivated = [{ ...docsV1[0], active: false }, docsV1[1]];
  assert.equal(isDocumentLexicalIndexFresh(docIdx, docsDeactivated, chunksV1), false);
  const rebuilt = buildDocumentLexicalIndex(docsDeactivated, chunksV1, { projectId: 's-docs' });
  assert.equal(searchLexicalIndex(rebuilt, 'OBSIDIAN_CITADEL_ARCHIVE', { excludeDocTypes: ['STYLE_ONLY'] }).length, 0);
}

console.log('PASS: all Milestone 3 + Part A integration review unit tests & 500,000+ word benchmark passed.');
