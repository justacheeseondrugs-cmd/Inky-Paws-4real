// Offline Milestone 4 unit tests:
// - IndexedDB v4 schema & v1/v2/v3/v4 backup validation compatibility
// - 4-scope Writing DNA (global reused across unrelated stories, story/fandom isolated, English manuscript / Spanish UI defaults)
// - Editable literary anti-patterns (no simplistic word blacklists)
// - Standalone Global Writing DNA export/import + strict AU/plot anti-contamination guard
// - Editorial feedback before/after & mocked analyzer interface
// - 6-role Reference Library, legacy compatibility, STYLE_ONLY isolation (Violet Evergarden & The Vow never activate Violet traits),
//   and PtS I-II vs PtS III Part 1 timeline separation
// - Bounded Creative Chat retrieval (never sends entire chat history)
// - NL proposal extraction ("OKAAAAY SOOOO..."), negations, safety invariants & Chapter Brief formatting.
// Synthetic fixtures only; zero paid API calls.
// Run with: node tests/milestone4-unit.mjs
import assert from 'node:assert/strict';

import {
  DB_NAME,
  DB_VERSION,
  V1_STORE_NAMES,
  V2_STORE_NAMES,
  V3_REQUIRED_STORE_NAMES,
  V4_REQUIRED_STORE_NAMES,
  STORE_NAMES,
  validateBackupDump,
} from '../js/db.js';
import {
  DEFAULT_LITERARY_QUALITIES,
  DEFAULT_ANTI_PATTERNS,
  createDefaultGlobalWritingDna,
  normalizeWritingDnaProfile,
  exportGlobalWritingDnaProfile,
  validateGlobalWritingDnaImport,
  detectPlotOrAuSpecificContent,
  resolveWritingDna,
} from '../js/writingDna.js';
import {
  REFERENCE_ROLES,
  normalizeReferenceRole,
  partitionStoryReferences,
  retrieveRoleSeparatedReferences,
} from '../js/referenceRoles.js';
import {
  buildBoundedChatContext,
  extractConversationalProposal,
  normalizeChapterBrief,
  selectEligibleChapterBrief,
  formatChapterBriefAsInstructions,
} from '../js/creativeChat.js';
import { resolveUniverseConfiguration } from '../js/universeResolver.js';
import { assembleHierarchicalMemory } from '../js/hierarchicalMemory.js';
import { buildDocumentLexicalIndex } from '../js/lexicalIndex.js';
import { resolveCanonicalNarrativeTarget } from '../js/contextEnginePrep.js';

// 1. IndexedDB v4 additive schema & v1/v2/v3/v4 backup compatibility
{
  assert.equal(DB_NAME, 'pts-studio');
  assert.equal(DB_VERSION, 4);
  for (const s of ['writingDnaProfiles', 'editorialFeedback', 'creativeChats', 'chapterBriefs']) {
    assert.ok(STORE_NAMES.includes(s), `Missing v4 store: ${s}`);
  }
  const makeDump = (ver, stores) => {
    const d = { __meta: { app: 'pts-studio', version: ver } };
    for (const s of stores) d[s] = [];
    return d;
  };
  assert.equal(validateBackupDump(makeDump(1, V1_STORE_NAMES)).isFull, true);
  assert.equal(validateBackupDump(makeDump(2, V2_STORE_NAMES)).isFull, true);
  assert.equal(validateBackupDump(makeDump(3, V3_REQUIRED_STORE_NAMES)).isFull, true);
  assert.equal(validateBackupDump(makeDump(4, V4_REQUIRED_STORE_NAMES)).isFull, true);
  assert.equal(validateBackupDump(makeDump(4, V3_REQUIRED_STORE_NAMES)).isFull, false);
}

// 2. Global Writing DNA reused across unrelated stories, story overrides isolated, 14 anti-patterns, no word blacklists
{
  const globalDna = createDefaultGlobalWritingDna();
  assert.equal(globalDna.manuscriptLanguage, 'en');
  assert.equal(globalDna.uiLanguage, 'es');
  assert.equal(DEFAULT_LITERARY_QUALITIES.length, 12);
  assert.equal(DEFAULT_ANTI_PATTERNS.length, 14);

  const ptsFandomDna = normalizeWritingDnaProfile({
    scope: 'fandom',
    fandom: 'power_to_strive',
    literaryQualities: ['Keep reaction-room banter sharp and unhurried.'],
  });
  const storyADna = normalizeWritingDnaProfile({
    scope: 'story',
    projectId: 'story-pts-a',
    literaryQualities: ['Lean into wintry candlelit atmosphere for Story A.'],
  });
  const storyBDna = normalizeWritingDnaProfile({
    scope: 'story',
    projectId: 'story-scifi-b',
    literaryQualities: ['Crisp orbital silence and sparse technical detail.'],
  });
  const feedback = [
    { id: 'fb-g-ok', scope: 'global', status: 'approved', ruleText: 'Avoid summarizing dialogue that just happened.' },
    { id: 'fb-g-rej', scope: 'global', status: 'rejected', ruleText: 'REJECTED_RULE_MUST_NOT_APPLY' },
    { id: 'fb-a-only', scope: 'story', projectId: 'story-pts-a', status: 'approved', ruleText: 'STORY_A_ONLY_RULE' },
  ];

  const resolvedA = resolveWritingDna({
    globalProfile: globalDna,
    fandomProfile: ptsFandomDna,
    storyProfile: storyADna,
    editorialFeedback: feedback,
    fandom: 'power_to_strive',
    projectId: 'story-pts-a',
  });
  const resolvedScifi = resolveWritingDna({
    globalProfile: globalDna,
    fandomProfile: ptsFandomDna, // different fandom -> must NOT apply!
    storyProfile: storyBDna,
    editorialFeedback: feedback,
    fandom: 'starlight_original',
    projectId: 'story-scifi-b',
  });

  assert.equal(resolvedA.wordBlacklistsUsed, false);
  assert.ok(resolvedA.approvedLearnedRules.some((r) => r.id === 'fb-g-ok'));
  assert.ok(resolvedA.approvedLearnedRules.some((r) => r.id === 'fb-a-only'));
  assert.ok(!resolvedA.approvedLearnedRules.some((r) => r.id === 'fb-g-rej'), 'Rejected rules must NEVER enter Writing DNA');

  // Unrelated sci-fi story inherits global DNA + global approved rule, NEVER PtS fandom or Story A rules!
  assert.ok(resolvedScifi.literaryQualities.some((q) => q.includes('Prosa inmersiva')));
  assert.ok(resolvedScifi.approvedLearnedRules.some((r) => r.id === 'fb-g-ok'));
  assert.ok(!resolvedScifi.literaryQualities.some((q) => q.includes('reaction-room')));
  assert.ok(!resolvedScifi.approvedLearnedRules.some((r) => r.id === 'fb-a-only'));
}

// 3. AU/plot anti-contamination guard & standalone Global Writing DNA export/import
{
  assert.equal(detectPlotOrAuSpecificContent('Erwin and Levi used to date in secret.').isSpecific, true);
  assert.equal(detectPlotOrAuSpecificContent('Keep Violet traits active for Levi.').isSpecific, true);
  assert.equal(detectPlotOrAuSpecificContent('Show emotional subtext through body language before dialogue.').isSpecific, false);

  const exported = exportGlobalWritingDnaProfile(createDefaultGlobalWritingDna(), [
    { id: 'r1', scope: 'global', status: 'approved', ruleText: 'Prefer restrained interiority over melodrama.' },
    { id: 'r2', scope: 'global', status: 'approved', ruleText: 'Erwin and Levi are former lovers in Power to Strive.' }, // must be stripped!
  ]);
  assert.equal(exported.__meta.apiKeysExcluded, true);
  assert.equal(exported.__meta.storyCanonExcluded, true);
  assert.equal(exported.approvedGlobalRules.length, 1);

  const validatedImport = validateGlobalWritingDnaImport({
    ...exported,
    approvedGlobalRules: [
      ...exported.approvedGlobalRules,
      { id: 'r-sneak', scope: 'global', ruleText: 'Joseph arrives after Chapter 10 in the watching room.' },
    ],
  });
  assert.equal(validatedImport.approvedGlobalRules.length, 1);
  assert.equal(validatedImport.rejectedSpecific.length, 1, 'AU/plot rules must be rejected on global Writing DNA import');
}

// 4. Six Reference Roles, legacy mapping, STYLE_ONLY isolation (Violet Evergarden & The Vow),
//    and PtS I-II vs PtS III Part 1 timeline isolation
{
  assert.equal(REFERENCE_ROLES.length, 6);
  assert.equal(normalizeReferenceRole('CANON'), 'AU_CANON');
  assert.equal(normalizeReferenceRole('CHARACTER'), 'CHARACTER_BIBLE');
  assert.equal(normalizeReferenceRole('CONTINUITY'), 'AU_CANON');
  assert.equal(normalizeReferenceRole('REFERENCE'), 'WORLD_BUILDING');
  assert.equal(normalizeReferenceRole('STYLE_ONLY'), 'STYLE_ONLY');

  const docs = [
    { id: 'd-ve', filename: 'Violet Evergarden.txt', type: 'STYLE_ONLY', active: true, styleCraftProfile: { emotionalRestraint: 'Quiet, measured emotional resonance.', scenePacing: 'Unhurried reflective beats.' } },
    { id: 'd-vow', filename: 'The Vow.txt', type: 'STYLE_ONLY', active: true, styleCraftProfile: { atmosphere: 'Intimate domestic warmth.' } },
    { id: 'd-pts12', filename: 'PtS_I_II_Canon.md', type: 'ORIGINAL_CANON', timelineId: 'pts_i_ii_original', active: true, priority: 90 },
    { id: 'd-pts3', filename: 'PtS_III_Part1_Alt.md', type: 'AU_CANON', timelineId: 'pts_iii_part_1_alternate', active: true, priority: 95 },
    { id: 'd-off', filename: 'Inactive_Lore.txt', type: 'WORLD_BUILDING', active: false },
  ];
  const chunks = [
    { id: 'c1', documentId: 'd-ve', index: 0, text: 'Violet Evergarden wrote letters in Leiden with Gilbert.' },
    { id: 'c2', documentId: 'd-vow', index: 0, text: 'The Vow chapter dialogue sample.' },
    { id: 'c3', documentId: 'd-pts12', index: 0, text: 'Original PtS I-II watching room expedition canon.' },
    { id: 'c4', documentId: 'd-pts3', index: 0, text: 'PTS_III_ALTERNATE_EXCLUSIVE_EVENT happened in PtS III Part 1.' },
    { id: 'c5', documentId: 'd-off', index: 0, text: 'INACTIVE_DOC_TEXT must never be retrieved.' },
  ];

  // Querying inside Original PtS I-II timeline:
  const retrievedOriginal = retrieveRoleSeparatedReferences({
    documents: docs,
    docChunks: chunks,
    query: 'watching room expedition Violet Leiden PTS_III_ALTERNATE_EXCLUSIVE_EVENT INACTIVE_DOC_TEXT',
    activeTimelineId: 'pts_i_ii_original',
  });
  assert.equal(retrievedOriginal.factualChunks.length, 1);
  assert.equal(retrievedOriginal.factualChunks[0].documentId, 'd-pts12', 'Only Original PtS I-II factual doc should be retrieved');
  assert.ok(!retrievedOriginal.factualChunks.some((c) => c.documentId === 'd-ve' || c.documentId === 'd-vow'), 'STYLE_ONLY docs must NEVER supply factual chunks');
  assert.ok(!retrievedOriginal.factualChunks.some((c) => c.documentId === 'd-pts3'), 'PtS III Part 1 must stay strictly isolated from Original PtS I-II timeline');
  assert.equal(retrievedOriginal.excludedByTimeline.length, 1);
  assert.equal(retrievedOriginal.styleGuidance.length, 2);
  assert.ok(retrievedOriginal.styleGuidance.every((g) => g.activatesCharacterOverlays === false && g.prohibitVerbatimCopying === true));

  // Verify Violet Evergarden STYLE_ONLY doc NEVER activates Levi Violet traits in universeResolver
  const univ = resolveUniverseConfiguration({
    storyConfig: { fandom: 'power_to_strive', reactionMode: true, overlayActivations: [] },
    documents: docs,
  });
  assert.equal(univ.activeOverlays.length, 0);
}

// 5. Bounded Creative Chat retrieval (40 turns -> NEVER sends entire chat history!)
{
  const longHistory = [];
  for (let i = 1; i <= 40; i += 1) {
    longHistory.push({
      role: i % 2 === 1 ? 'user' : 'assistant',
      text: i === 4
        ? 'Earlier brainstorming note about the brass compass hidden behind the projector reel.'
        : `Turn ${i}: general discussion about pacing, quiet tea moments, and subtle room dynamics between scenes. `.repeat(6),
    });
  }
  const bounded = buildBoundedChatContext(longHistory, {
    query: 'What did we decide about the brass compass behind the projector?',
    maxRecentTurns: 6,
    maxSummaryChars: 1200,
    maxTotalChars: 4500,
  });
  assert.equal(bounded.totalStoredMessages, 40);
  assert.equal(bounded.recentMessages.length <= 6, true);
  assert.equal(bounded.withinBudget, true);
  assert.ok(bounded.totalChars <= 4500);
  assert.ok(bounded.relevantOlderMessages.some((m) => m.text.includes('brass compass')), 'Bounded chat must recall relevant earlier brainstorming turn without sending all 40 turns');
}

// 6. Natural-language proposal extraction ("OKAAAAY SOOOO..."), negations, safety guards & mocked AI extractor
{
  const messyMsg = 'OKAAAAY SOOOO what if Joseph knows Erwin and Levi used to date, but Hange thinks something completely different HAHAHAHA. Also no Violet traits this time!';
  const prop = await extractConversationalProposal(messyMsg, { fandom: 'power_to_strive' });
  assert.equal(prop.status, 'proposed');
  assert.equal(prop.isConditional, true);

  const kinds = prop.items.map((i) => i.kind);
  assert.ok(kinds.includes('relationship_state'), 'Should propose Eruri former_lovers history');
  assert.ok(kinds.includes('optional_character_enable'), 'Should propose Joseph activation');
  assert.ok(kinds.includes('epistemic_knowledge'), 'Should propose Joseph private knowledge');
  assert.ok(kinds.includes('epistemic_false_belief'), 'Should propose Hange false belief');
  assert.ok(kinds.includes('overlay_disable'), 'Should propose Violet overlay deactivation');
  assert.ok(kinds.includes('possible_idea'), 'Should preserve exploratory idea separately');

  // Verify hard safety invariants!
  const relItem = prop.items.find((i) => i.kind === 'relationship_state');
  assert.equal(relItem.payload.relationshipOps.set.eruri.state, 'former_lovers');
  assert.equal(relItem.payload.relationshipOps.set.eruri.publiclyKnown, false, 'Must NOT make relationship public automatically');
  assert.ok(!prop.items.some((i) => i.payload?.guestInvitationOps?.invite?.includes('joseph')), 'Must NOT auto-authorize Joseph room entry');
  assert.ok(!prop.items.some((i) => i.payload?.optionalCharacterOps?.enable?.includes('anya')), 'Must NOT auto-enable Anya');

  // Negations & Anya room-entry safety block!
  const negProp = await extractConversationalProposal('Actually forget Joseph and no Anya. Also what if Anya enters the watching room?', { fandom: 'power_to_strive' });
  assert.ok(negProp.items.some((i) => i.kind === 'optional_character_disable' && i.payload?.optionalCharacterOps?.disable?.includes('joseph')));
  assert.ok(negProp.safetyBlocks.some((b) => b.code === 'anya_room_entry_blocked'));

  // Mocked AI extractor provider interface (zero paid API calls!)
  let mockCalled = false;
  const mockedProp = await extractConversationalProposal('Try a quiet campfire talk', {
    fandom: 'power_to_strive',
    extractorProvider: {
      async extractProposal() {
        mockCalled = true;
        return {
          items: [
            { kind: 'possible_idea', label: 'Campfire scene', summary: 'Quiet talk', payload: { ideaText: 'Campfire talk' } },
            // Even if a buggy mocked provider tries to invite Anya to room, safety guard strips it!
            { kind: 'bad', label: 'Invite Anya', payload: { guestInvitationOps: { invite: ['anya'] } } },
          ],
        };
      },
    },
  });
  assert.equal(mockCalled, true);
  assert.equal(mockedProp.items.length, 1);
  assert.ok(mockedProp.safetyBlocks.some((b) => b.code === 'anya_room_invitation_stripped'));
}

// 7. Structured Chapter Brief formatting (flexible guidance, not rigid checklist)
{
  const brief = normalizeChapterBrief({
    projectId: 'story-1',
    title: 'Chapter 8 — Tea Before the Storm',
    objective: 'Let Hange test her wrong theory while Levi stays unreadable.',
    perspective: 'Third-person close (Levi)',
    activeParticipants: ['erwin', 'levi', 'hange'],
    emotionalProgression: 'dry humor -> quiet tension -> unspoken loyalty',
    dialogueIntentions: ['Hange fishes for clues without sounding like a therapist'],
    desiredRevelations: ['Joseph knows about their past outside the room'],
    mustRemainSecret: ['Eruri history remains hidden from Eren and Mikasa'],
    relevantHistoricalMemories: ['Chapter 7 brass pocket watch oath'],
    requiredEndingConditions: 'Screen unpauses right as Hange notices Levi’s expression',
    targetLength: 5000,
    sceneCharacterModifications: ['Keep Levi standard — no Violet traits'],
    status: 'approved',
  });
  const formatted = formatChapterBriefAsInstructions(brief);
  assert.ok(formatted.includes('Chapter 8 — Tea Before the Storm'));
  assert.ok(formatted.includes('MUST REMAIN SECRET'));
  assert.ok(formatted.includes('flexible') || formatted.includes('brújula narrativa'));
}

// 8. PART A #1: Standalone false belief NEVER promotes belief text to objective truth
{
  const prop = await extractConversationalProposal(
    'Hange thinks Levi is secretly running an underground tea smuggling ring.',
    { fandom: 'power_to_strive' }
  );
  const fb = prop.items.find((i) => i.kind === 'epistemic_false_belief');
  assert.ok(fb, 'Should extract standalone false belief');
  assert.equal(fb.claimCategory, 'character_belief');
  assert.equal(fb.payload.factTruth, '', 'Objective truth must remain empty when unconfirmed');
  assert.equal(fb.payload.truthStatus, 'unresolved_author_confirmation_required');
  assert.equal(fb.payload.requiresAuthorTruthConfirmation, true);
}

// 9. PART A #2: Writing DNA chapter_scene scope isolation & heuristic warning label
{
  const feedback = [
    { id: 'fb-ch2-scA', scope: 'chapter_scene', projectId: 'p1', chapterId: 'ch-2', sceneId: 'sc-a', status: 'approved', ruleText: 'ONLY_CH2_SCENE_A' },
    { id: 'fb-ch2-all', scope: 'chapter_scene', projectId: 'p1', chapterId: 'ch-2', sceneId: null, status: 'approved', ruleText: 'ONLY_CH2_ALL_SCENES' },
    { id: 'fb-ch-missing', scope: 'chapter_scene', projectId: 'p1', chapterId: null, sceneId: null, status: 'approved', ruleText: 'UNSCOPED_MUST_NOT_APPLY' },
    { id: 'fb-fandom-polluted', scope: 'fandom', fandom: 'power_to_strive', status: 'approved', ruleText: 'Levi married Joseph in Violet AU.' },
  ];

  const rCh2ScA = resolveWritingDna({ editorialFeedback: feedback, fandom: 'power_to_strive', projectId: 'p1', targetChapterId: 'ch-2', targetSceneId: 'sc-a' });
  const rCh2ScB = resolveWritingDna({ editorialFeedback: feedback, fandom: 'power_to_strive', projectId: 'p1', targetChapterId: 'ch-2', targetSceneId: 'sc-b' });
  const rCh3ScA = resolveWritingDna({ editorialFeedback: feedback, fandom: 'power_to_strive', projectId: 'p1', targetChapterId: 'ch-3', targetSceneId: 'sc-a' });

  assert.equal(rCh2ScA.antiContaminationDetectionMode, 'heuristic_warning_not_semantic_guarantee');
  assert.ok(rCh2ScA.approvedLearnedRules.some((r) => r.id === 'fb-ch2-scA'));
  assert.ok(rCh2ScA.approvedLearnedRules.some((r) => r.id === 'fb-ch2-all'));
  assert.ok(!rCh2ScA.approvedLearnedRules.some((r) => r.id === 'fb-ch-missing'));
  assert.ok(!rCh2ScA.approvedLearnedRules.some((r) => r.id === 'fb-fandom-polluted'), 'Story/AU-specific rule must NOT leak through fandom scope');

  assert.ok(!rCh2ScB.approvedLearnedRules.some((r) => r.id === 'fb-ch2-scA'), 'Scene A rule must NOT leak into Scene B');
  assert.ok(rCh2ScB.approvedLearnedRules.some((r) => r.id === 'fb-ch2-all'));
  assert.ok(!rCh3ScA.approvedLearnedRules.some((r) => r.id === 'fb-ch2-scA'), 'Chapter 2 rule must NOT leak into Chapter 3');
  assert.ok(!rCh3ScA.approvedLearnedRules.some((r) => r.id === 'fb-ch2-all'), 'Chapter 2 rule must NOT leak into Chapter 3');

  const guard = detectPlotOrAuSpecificContent('Violet AU marriage');
  assert.equal(guard.detectionMode, 'heuristic_warning_not_semantic_guarantee');
}

// 10. PART A #3: Strict eligible Chapter Brief selection (rejects draft, rejected, consumed, wrong chapter even with explicit activeBriefId)
{
  const briefs = [
    normalizeChapterBrief({ id: 'br-draft', projectId: 'p1', status: 'draft', targetChapterOrder: 5, objective: 'Draft' }),
    normalizeChapterBrief({ id: 'br-rejected', projectId: 'p1', status: 'rejected', targetChapterOrder: 5, objective: 'Rejected' }),
    normalizeChapterBrief({ id: 'br-consumed', projectId: 'p1', status: 'consumed', targetChapterOrder: 5, objective: 'Consumed' }),
    normalizeChapterBrief({ id: 'br-ch3', projectId: 'p1', status: 'approved', targetChapterId: 'ch-3', targetChapterOrder: 3, objective: 'Ch 3 brief' }),
    normalizeChapterBrief({ id: 'br-ch5', projectId: 'p1', status: 'transferred', targetChapterId: 'ch-5', targetChapterOrder: 5, objective: 'Ch 5 brief' }),
  ];

  assert.equal(selectEligibleChapterBrief(briefs, { activeBriefId: 'br-draft', targetChapterOrder: 5 }), null);
  assert.equal(selectEligibleChapterBrief(briefs, { activeBriefId: 'br-rejected', targetChapterOrder: 5 }), null);
  assert.equal(selectEligibleChapterBrief(briefs, { activeBriefId: 'br-consumed', targetChapterOrder: 5 }), null);
  assert.equal(selectEligibleChapterBrief(briefs, { activeBriefId: 'br-ch3', targetChapterId: 'ch-5', targetChapterOrder: 5 }), null);
  assert.equal(selectEligibleChapterBrief(briefs, { targetChapterId: 'ch-5', targetChapterOrder: 5 })?.id, 'br-ch5');
  assert.equal(selectEligibleChapterBrief(briefs, { targetChapterId: 'ch-9', targetChapterOrder: 9 }), null);
}

// 11. PART A #4: BM25 reference retrieval in assembleHierarchicalMemory enforces identical role/timeline/fandom/active filters
{
  const docs = [
    { id: 'doc-style-legacy', filename: 'Violet.txt', type: 'REFERENCE', role: 'STYLE_ONLY', active: true, timelineId: 'shared_active' },
    { id: 'doc-alt-timeline', filename: 'PtS_III.txt', type: 'CANON', role: 'AU_CANON', active: true, timelineId: 'pts_iii_part_1_alternate', fandom: 'power_to_strive' },
    { id: 'doc-foreign-fandom', filename: 'SciFiLore.txt', type: 'CANON', role: 'WORLD_BUILDING', active: true, timelineId: 'shared_active', fandom: 'starlight_original' },
    { id: 'doc-inactive', filename: 'Disabled.txt', type: 'CANON', role: 'AU_CANON', active: false, timelineId: 'pts_i_ii_original', fandom: 'power_to_strive' },
    { id: 'doc-valid', filename: 'PtS_I_II.txt', type: 'CANON', role: 'AU_CANON', active: true, timelineId: 'pts_i_ii_original', fandom: 'power_to_strive' },
  ];
  const chunks = [
    { id: 'c-1', documentId: 'doc-style-legacy', index: 0, text: 'Secret silver compass melody in Leiden typewriter letters.' },
    { id: 'c-2', documentId: 'doc-alt-timeline', index: 0, text: 'Secret silver compass alternate timeline Season 3 continuation.' },
    { id: 'c-3', documentId: 'doc-foreign-fandom', index: 0, text: 'Secret silver compass starship hyperdrive core.' },
    { id: 'c-4', documentId: 'doc-inactive', index: 0, text: 'Secret silver compass inactive archive draft.' },
    { id: 'c-5', documentId: 'doc-valid', index: 0, text: 'Secret silver compass watching room canon reference.' },
  ];
  // Even if a pre-built persisted documentLexicalIndex contains ALL docs, BM25 must exclude STYLE_ONLY, alt timeline, foreign fandom, and inactive!
  const fullIndex = buildDocumentLexicalIndex(docs, chunks, { projectId: 'p-pts' });
  const mem = assembleHierarchicalMemory({
    projectId: 'p-pts',
    targetChapterOrder: 2,
    activeTimelineId: 'pts_i_ii_original',
    fandom: 'power_to_strive',
    query: 'secret silver compass',
    documents: docs,
    docChunks: chunks,
    documentLexicalIndex: fullIndex,
  });
  const refHits = mem.modelPayload.layers.C_historical_episodic.referencePassages;
  assert.equal(refHits.length, 1);
  assert.equal(refHits[0].documentId, 'doc-valid');
  assert.ok(!refHits.some((h) => h.documentId === 'doc-style-legacy'), 'STYLE_ONLY must NEVER leak via BM25');
  assert.ok(!refHits.some((h) => h.documentId === 'doc-alt-timeline'), 'Alternate timeline must NEVER leak via BM25');
  assert.ok(!refHits.some((h) => h.documentId === 'doc-foreign-fandom'), 'Foreign fandom must NEVER leak via BM25');
  assert.ok(!refHits.some((h) => h.documentId === 'doc-inactive'), 'Inactive doc must NEVER leak via BM25');
}

// 12. PART A #6: Canonical narrative target prevents latest story checkpoint leaking into historical rewrites
{
  const chapters = [
    { id: 'ch-1', order: 1, title: 'Chapter 1', checkpointId: 's1_beginning', timelineId: 'pts_i_ii_original' },
    { id: 'ch-10', order: 10, title: 'Chapter 10', checkpointId: 's2_end', timelineId: 'pts_i_ii_original' },
  ];
  const storyConfig = { fandom: 'power_to_strive', checkpointId: 's3_alternate', timelineId: 'pts_iii_part_1_alternate' };

  const histTarget = resolveCanonicalNarrativeTarget({
    storyConfig,
    chapters,
    targetChapterId: 'ch-1',
    targetSceneId: 'sc-1',
  });
  assert.equal(histTarget.isHistoricalRewrite, true);
  assert.equal(histTarget.targetChapterOrder, 1);
  assert.equal(histTarget.checkpointId, 's1_beginning', 'Historical rewrite MUST use target chapter checkpoint, NEVER latest storyConfig.checkpointId');
  assert.equal(histTarget.activeTimelineId, 'pts_i_ii_original');

  const newTarget = resolveCanonicalNarrativeTarget({ storyConfig, chapters });
  assert.equal(newTarget.isHistoricalRewrite, false);
  assert.equal(newTarget.targetChapterOrder, 11);
  assert.equal(newTarget.checkpointId, 's3_alternate');
}

console.log('PASS: all Milestone 4 + Part A offline unit tests passed (v4 schema, 4-scope Writing DNA + chapter/scene isolation, 14 anti-patterns, AU anti-contamination guard, 6 reference roles & BM25 consistency, PtS timeline separation, bounded Creative Chat, false-belief truth isolation, eligible Chapter Briefs & canonical narrative target).');
