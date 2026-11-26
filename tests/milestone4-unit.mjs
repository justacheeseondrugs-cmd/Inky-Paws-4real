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
  formatChapterBriefAsInstructions,
} from '../js/creativeChat.js';
import { resolveUniverseConfiguration } from '../js/universeResolver.js';

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

console.log('PASS: all Milestone 4 offline unit tests passed (v4 schema, 4-scope Writing DNA, 14 anti-patterns, AU anti-contamination guard, 6 reference roles & STYLE_ONLY isolation, PtS timeline separation, bounded Creative Chat, NL selective proposals & Chapter Briefs).');
