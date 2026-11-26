// Offline Milestone 1 unit tests (Node 22, synthetic fixtures only, zero paid API calls).
// Run with: node tests/milestone1-unit.mjs
import assert from 'node:assert/strict';

import { DB_NAME, DB_VERSION, V1_STORE_NAMES, STORE_NAMES, validateBackupDump } from '../js/db.js';
import {
  validateMasterCharacterBible,
  mapMasterCharacterBibleV1,
  normalizeUniversalCharacter,
  normalizeCharacterOverlay,
  isOverlayConfigured,
  resolveCharacterProfile,
  resolveStoryCharacterRoster,
} from '../js/characterLibrary.js';
import { createDefaultStoryConfig, validateConfigProposal } from '../js/storyConfigSchema.js';

function makeSyntheticBible(contentVersion = '1.1') {
  return {
    schema: 'inky.master_character_bible',
    schema_version: 1,
    content_version: contentVersion,
    language: 'en',
    title: 'Synthetic Master Character Bible Fixture',
    rules: {
      hard_constraints: {
        anya_room_entry: 'never',
        allowed_optional_room_guest: 'joseph',
        joseph_invitation_required: true,
        optional_characters_default_enabled: false,
        levi_violet_traits_default_enabled: false,
      },
    },
    core_characters: [
      {
        id: 'erwin',
        name: 'Erwin Smith',
        role: 'Commander',
        core: 'Strategic, composed, deeply human.',
        attention: 'Incentives, evidence, Levi distress.',
        voice: 'Formal, precise, conditional reasoning.',
        body_language: 'Measured pause before answering.',
        stress_response: 'Quieter sharper speech.',
        relationships: { levi: 'Central Eruri trust and agency.' },
        development: 'Early checkpoints keep later reveals gated.',
        avoid: ['Omniscient chessmaster', 'constant speeches'],
        original_voice_example: 'Before deciding, let us check what we actually know.',
        sources: ['SYNTH_1'],
      },
      {
        id: 'levi',
        name: 'Levi Ackerman',
        role: 'Captain',
        core: 'Blunt, observant, economical, deeply loyal.',
        attention: 'Physical danger, injuries, bad assumptions.',
        voice: 'Short, dry, literal.',
        body_language: 'Stillness when angry; practical movement.',
        stress_response: 'Concern comes out as practical instructions.',
        relationships: { erwin: 'Chosen trust.' },
        development: 'Standard Levi is the permanent default.',
        avoid: ['Profanity in every line', 'Importing Violet traits into standard Levi'],
        original_voice_example: 'Eat first. Argue after.',
        variant_policy: 'Standard Levi is default; Violet traits are opt-in only.',
        sources: ['SYNTH_1'],
      },
    ],
    optional_characters: [
      {
        id: 'joseph',
        name: 'Joseph Alcott',
        role: 'Optional civilian informant',
        core: 'Dry, observant, loyal once trust is earned.',
        attention: 'Social hierarchy, exits, omissions.',
        voice: 'Natural, efficient, dry humor.',
        body_language: 'Relaxed posture can be strategic.',
        stress_response: 'Humor vanishes when family is threatened.',
        relationships: { levi: 'Optional AU partnership only.' },
        development: 'Invited guest only; never inherits unwatched episodes.',
        avoid: ['Present in every fanfic', 'automatic room access'],
        original_voice_example: 'I know who might know.',
        sources: ['SYNTH_OPT'],
      },
      {
        id: 'anya',
        name: 'Anya',
        role: 'Optional child character; strictly outside room',
        core: 'Five-year-old, imaginative, non-telepathic.',
        attention: 'Adult behavior, routines, small mysteries.',
        voice: 'Concrete child phrasing.',
        body_language: 'Expressive face.',
        stress_response: 'Fears abandonment.',
        relationships: { joseph: 'Papa when AU enabled.' },
        development: 'Never enters the watching room under any circumstance.',
        avoid: ['Entering the watching room', 'telepathy'],
        original_voice_example: 'That is a secret mission.',
        sources: ['SYNTH_OPT'],
      },
    ],
    story_presets: [
      {
        id: 'pts_eruri_default',
        name: 'PtS — Eruri',
        enabled_optional: [],
        room_guest_ids: [],
        eruri_state: 'mutual_attachment_unspoken',
        joseph_marriage: false,
        anya_room_entry: false,
        enabled_character_overlays: [],
      },
      {
        id: 'violet_au',
        name: 'Violet AU — Eruri',
        enabled_optional: [],
        room_guest_ids: [],
        eruri_state: 'author-defined',
        joseph_marriage: false,
        anya_room_entry: false,
        enabled_character_overlays: ['levi_violet_traits'],
      },
    ],
    optional_character_overlays: [
      {
        id: 'levi_violet_traits',
        character_id: 'levi',
        default_enabled: false,
        activation: ['author_selects_violet_au', 'author_explicitly_requests_traits'],
        allowed_scopes: ['story', 'character_version', 'scene'],
        traits_source: 'Author-approved Violet AU configuration; not defined by bible.',
        policy: 'Standard Levi is default; opt-in only.',
      },
    ],
  };
}

// 1. Database v2 constants and v1/v2 backup validation
{
  assert.equal(DB_NAME, 'pts-studio', 'Database name must remain pts-studio');
  assert.equal(DB_VERSION, 2);
  assert.equal(V1_STORE_NAMES.length, 9);
  assert.ok(STORE_NAMES.includes('universalCharacters'));
  assert.ok(STORE_NAMES.includes('characterOverlays'));
  assert.ok(STORE_NAMES.includes('storyConfigs'));
  assert.ok(STORE_NAMES.includes('storyPresets'));
  assert.ok(STORE_NAMES.includes('knowledgeFacts'));
  assert.ok(STORE_NAMES.includes('usageLog'));

  // Legacy v1 full backup (9 stores) remains importable as FULL
  const v1Full = { __meta: { app: 'pts-studio', version: 1 } };
  for (const name of V1_STORE_NAMES) v1Full[name] = [];
  const v1Info = validateBackupDump(v1Full);
  assert.equal(v1Info.isFull, true);
  assert.equal(v1Info.backupKind, 'full');
  assert.equal(v1Info.version, 1);

  // Full v2 backup (all 15 stores) is FULL
  const v2Full = { __meta: { app: 'pts-studio', version: 2 } };
  for (const name of STORE_NAMES) v2Full[name] = [];
  const v2Info = validateBackupDump(v2Full);
  assert.equal(v2Info.isFull, true);
  assert.equal(v2Info.backupKind, 'full');
  assert.equal(v2Info.version, 2);

  // v2 backup missing new v2 stores is PARTIAL
  const v2Partial = { __meta: { app: 'pts-studio', version: 2 } };
  for (const name of V1_STORE_NAMES) v2Partial[name] = [];
  const v2PartialInfo = validateBackupDump(v2Partial);
  assert.equal(v2PartialInfo.isFull, false);
  assert.equal(v2PartialInfo.backupKind, 'partial');

  // Malformed v2 records rejected
  assert.throws(() => validateBackupDump({
    __meta: { app: 'pts-studio', version: 2 },
    characterOverlays: [{ id: 'ov1', name: 'Missing baseCharacterId' }],
  }));
  assert.throws(() => validateBackupDump({
    __meta: { app: 'pts-studio', version: 2 },
    universalCharacters: [{ id: 'u1', antiPatterns: 'not-array' }],
  }));
}

// 2. Master Character Bible v1.1 validation & mapping (zero invented Violet traits)
{
  assert.throws(() => validateMasterCharacterBible(null));
  assert.throws(() => validateMasterCharacterBible({ schema: 'wrong', schema_version: 1 }));
  assert.throws(() => validateMasterCharacterBible({ schema: 'inky.master_character_bible', schema_version: 99, core_characters: [], rules: { hard_constraints: {} } }));

  const dupBible = makeSyntheticBible();
  dupBible.optional_characters.push({ ...dupBible.core_characters[0] });
  assert.throws(() => validateMasterCharacterBible(dupBible), 'Duplicate character ID across core and optional must throw');

  const mapped = mapMasterCharacterBibleV1(makeSyntheticBible());
  assert.equal(mapped.universalCharacters.length, 4);
  const levi = mapped.universalCharacters.find((c) => c.logicalId === 'levi');
  const joseph = mapped.universalCharacters.find((c) => c.logicalId === 'joseph');
  const anya = mapped.universalCharacters.find((c) => c.logicalId === 'anya');
  assert.equal(levi.id, 'power_to_strive::levi');
  assert.equal(levi.logicalId, 'levi');
  assert.equal(levi.category, 'core');
  assert.equal(joseph.id, 'power_to_strive::joseph');
  assert.equal(joseph.category, 'optional');
  assert.equal(joseph.defaultEnabled, false);
  assert.equal(anya.id, 'power_to_strive::anya');
  assert.equal(anya.category, 'optional');
  assert.equal(anya.defaultEnabled, false);
  assert.equal(levi.sourceAttribution.schema, 'inky.master_character_bible');
  assert.equal(levi.sourceAttribution.contentVersion, '1.1');

  // Unrelated fandom with same logical IDs gets distinct namespaced storage IDs!
  const otherFandomMapped = mapMasterCharacterBibleV1(makeSyntheticBible(), { fandom: 'starlight_saga' });
  const otherLevi = otherFandomMapped.universalCharacters.find((c) => c.logicalId === 'levi');
  assert.equal(otherLevi.id, 'starlight_saga::levi');
  assert.notEqual(otherLevi.id, levi.id);
  assert.equal(otherFandomMapped.characterOverlays[0].id, 'starlight_saga::levi_violet_traits');
  assert.equal(otherFandomMapped.storyPresets[0].id, 'starlight_saga::pts_eruri_default');

  // Invalid cross-references in Bible must be rejected before any write
  const badOverlayRef = makeSyntheticBible();
  badOverlayRef.optional_character_overlays[0].character_id = 'nonexistent_char';
  assert.throws(() => validateMasterCharacterBible(badOverlayRef), 'Overlay referencing missing character must fail');

  const badPresetOpt = makeSyntheticBible();
  badPresetOpt.story_presets[0].enabled_optional = ['ghost_char'];
  assert.throws(() => validateMasterCharacterBible(badPresetOpt), 'Preset referencing missing optional char must fail');

  const badAnyaGuest = makeSyntheticBible();
  badAnyaGuest.story_presets[0].room_guest_ids = ['anya'];
  assert.throws(() => validateMasterCharacterBible(badAnyaGuest), 'Preset putting Anya in room_guest_ids must fail');

  const violetOverlay = mapped.characterOverlays.find((o) => o.logicalId === 'levi_violet_traits');
  assert.ok(violetOverlay, 'levi_violet_traits overlay template must be mapped');
  assert.equal(violetOverlay.id, 'power_to_strive::levi_violet_traits');
  assert.equal(violetOverlay.defaultEnabled, false, 'Violet overlay must be disabled by default');
  assert.deepEqual(violetOverlay.characterizationChanges, [], 'Must NEVER invent Violet traits');
  assert.equal(isOverlayConfigured(violetOverlay), false);
}

// 3. Resolver scenarios: Standard Eruri, Empty Violet AU, Custom Violet Overlay, Room vs Screen, Scene-only, Conflicts, Cross-story & Unrelated Fandom
{
  const mapped = mapMasterCharacterBibleV1(makeSyntheticBible());
  const universalChars = mapped.universalCharacters.map((c) => normalizeUniversalCharacter(c));
  const leviBase = universalChars.find((c) => c.logicalId === 'levi');
  const emptyVioletOverlay = normalizeCharacterOverlay(mapped.characterOverlays[0]);

  // 3a. Normal Eruri story -> standard Levi, optional chars inactive
  const eruriConfig = createDefaultStoryConfig('story-eruri', { fandom: 'power_to_strive', presetId: 'pts_eruri_default' });
  const eruriRoster = resolveStoryCharacterRoster({
    universalCharacters: universalChars,
    storyCharacters: [],
    overlays: [emptyVioletOverlay],
    storyConfig: eruriConfig,
    context: { characterVersion: 'room' },
  });
  assert.deepEqual(eruriRoster.resolvedCharacters.map((r) => r.id).sort(), ['erwin', 'levi']);
  assert.deepEqual(eruriRoster.inactiveOptionalCharacters.map((c) => c.id).sort(), ['anya', 'joseph']);
  const standardLevi = eruriRoster.resolvedCharacters.find((r) => r.id === 'levi');
  assert.equal(standardLevi.isStandardDefault, true);
  assert.deepEqual(standardLevi.effectiveProfile.overlayTraits, []);

  // 3b. Violet AU with empty overlay -> clearly warns unconfigured, invents ZERO traits, keeps standard Levi
  const violetEmptyRes = resolveCharacterProfile({
    universalProfile: leviBase,
    overlays: [emptyVioletOverlay],
    activations: [{ overlayId: 'levi_violet_traits', scope: 'story', characterVersion: 'all', enabled: true }],
    context: { characterVersion: 'room', fandom: 'power_to_strive' },
  });
  assert.equal(violetEmptyRes.isStandardDefault, true);
  assert.equal(violetEmptyRes.unconfiguredOverlays.length, 1);
  assert.equal(violetEmptyRes.warnings[0].type, 'overlay_unconfigured');
  assert.deepEqual(violetEmptyRes.effectiveProfile.overlayTraits, []);

  // 3c. Author-defined custom Violet overlay (without mutating universal Levi!)
  const leviSnapshotBefore = JSON.stringify(leviBase);
  const customViolet = normalizeCharacterOverlay({
    ...emptyVioletOverlay,
    characterizationChanges: ['Author-defined trait alpha', 'Author-defined trait beta'],
    preserveCoreTraits: ['Blunt economy of words', 'Loyal protector'],
  }, { existing: emptyVioletOverlay, markAuthorEdited: true });
  assert.equal(isOverlayConfigured(customViolet), true);
  assert.equal(customViolet.defaultEnabled, false, 'Saved template must remain disabled by default');

  // 3d. Different room and screen versions of Levi
  const screenActivation = [{ overlayId: 'levi_violet_traits', scope: 'character_version', characterVersion: 'screen', enabled: true }];
  const screenLevi = resolveCharacterProfile({
    universalProfile: leviBase,
    overlays: [customViolet],
    activations: screenActivation,
    context: { characterVersion: 'screen', fandom: 'power_to_strive' },
  });
  const roomLevi = resolveCharacterProfile({
    universalProfile: leviBase,
    overlays: [customViolet],
    activations: screenActivation,
    context: { characterVersion: 'room', fandom: 'power_to_strive' },
  });
  assert.equal(screenLevi.isStandardDefault, false);
  assert.deepEqual(screenLevi.effectiveProfile.overlayTraits, ['Author-defined trait alpha', 'Author-defined trait beta']);
  assert.equal(roomLevi.isStandardDefault, true, 'Room Levi must stay standard when overlay is scoped to screen');
  assert.deepEqual(roomLevi.effectiveProfile.overlayTraits, []);
  assert.equal(JSON.stringify(leviBase), leviSnapshotBefore, 'Universal Levi must NEVER be mutated');

  // 3e. Temporary scene-only overlay expires outside its scene
  const sceneActivation = [{ overlayId: 'levi_violet_traits', scope: 'scene', sceneId: 'ch3-s2', characterVersion: 'all', enabled: true }];
  const inScene = resolveCharacterProfile({
    universalProfile: leviBase,
    overlays: [customViolet],
    activations: sceneActivation,
    context: { characterVersion: 'room', sceneId: 'ch3-s2', fandom: 'power_to_strive' },
  });
  const nextScene = resolveCharacterProfile({
    universalProfile: leviBase,
    overlays: [customViolet],
    activations: sceneActivation,
    context: { characterVersion: 'room', sceneId: 'ch3-s3', fandom: 'power_to_strive' },
  });
  assert.equal(inScene.appliedOverlays.length, 1);
  assert.equal(nextScene.appliedOverlays.length, 0, 'Scene overlay must expire outside authorized scene');

  // 3f. General-purpose custom overlay for another character + conflict detection (no silent blending!)
  const erwinBase = universalChars.find((c) => c.logicalId === 'erwin');
  const erwinOvA = normalizeCharacterOverlay({
    id: 'erwin_retired_scholar',
    name: 'Retired Scholar Erwin',
    baseCharacterId: 'erwin',
    fandom: 'power_to_strive',
    characterizationChanges: ['Unrushed academic cadence'],
    conflictGroup: 'erwin_au_persona',
    conflictResolution: 'ask_author',
  }, { markAuthorEdited: true });
  const erwinOvB = normalizeCharacterOverlay({
    id: 'erwin_hardened_fugitive',
    name: 'Hardened Fugitive Erwin',
    baseCharacterId: 'erwin',
    fandom: 'power_to_strive',
    characterizationChanges: ['Hyper-vigilant distrust of institutions'],
    conflictGroup: 'erwin_au_persona',
    conflictResolution: 'ask_author',
  }, { markAuthorEdited: true });

  const conflicted = resolveCharacterProfile({
    universalProfile: erwinBase,
    overlays: [erwinOvA, erwinOvB],
    activations: [
      { overlayId: 'erwin_retired_scholar', scope: 'story', enabled: true },
      { overlayId: 'erwin_hardened_fugitive', scope: 'story', enabled: true },
    ],
    context: { characterVersion: 'default', fandom: 'power_to_strive' },
  });
  assert.equal(conflicted.conflicts.length, 1, 'Conflicting overlays must be reported');
  assert.equal(conflicted.conflicts[0].requiresAuthorDecision, true);
  assert.equal(conflicted.appliedOverlays.length, 0, 'Conflicting overlays must NOT be silently blended');

  const resolvedConflict = resolveCharacterProfile({
    universalProfile: erwinBase,
    overlays: [erwinOvA, erwinOvB],
    activations: [
      { overlayId: 'erwin_retired_scholar', scope: 'story', enabled: true },
      { overlayId: 'erwin_hardened_fugitive', scope: 'story', enabled: true },
    ],
    context: {
      characterVersion: 'default',
      fandom: 'power_to_strive',
      approvedConflictWinners: { [conflicted.conflicts[0].pairKey]: 'erwin_retired_scholar' },
    },
  });
  assert.equal(resolvedConflict.conflicts.length, 0);
  assert.deepEqual(resolvedConflict.appliedOverlays.map((a) => a.overlayLogicalId), ['erwin_retired_scholar']);

  // 3g. Two stories using different overlays without cross-contamination
  const storyA = resolveStoryCharacterRoster({
    universalCharacters: universalChars,
    overlays: [customViolet, erwinOvA],
    storyConfig: { ...createDefaultStoryConfig('story-a', { fandom: 'power_to_strive' }), overlayActivations: [{ overlayId: 'levi_violet_traits', scope: 'story', enabled: true }] },
  });
  const storyB = resolveStoryCharacterRoster({
    universalCharacters: universalChars,
    overlays: [customViolet, erwinOvA],
    storyConfig: { ...createDefaultStoryConfig('story-b', { fandom: 'power_to_strive' }), overlayActivations: [{ overlayId: 'erwin_retired_scholar', scope: 'story', enabled: true }] },
  });
  assert.equal(storyA.resolvedCharacters.find((c) => c.id === 'levi').appliedOverlays.length, 1);
  assert.equal(storyB.resolvedCharacters.find((c) => c.id === 'levi').appliedOverlays.length, 0);
  assert.equal(storyB.resolvedCharacters.find((c) => c.id === 'erwin').appliedOverlays.length, 1);

  // 3h. Unrelated fandom does NOT inherit Power to Strive characters or rules (even if logicalId collides!)
  const originalHero = normalizeUniversalCharacter({
    id: 'levi',
    name: 'Levi Starlight (Sci-Fi)',
    fandom: 'starlight_original',
    category: 'core',
    corePersonality: 'Curious astronomer.',
  });
  assert.equal(originalHero.id, 'starlight_original::levi');
  const unrelatedRoster = resolveStoryCharacterRoster({
    universalCharacters: [...universalChars, originalHero],
    storyCharacters: [],
    overlays: [customViolet],
    storyConfig: createDefaultStoryConfig('orig-novel', { fandom: 'starlight_original' }),
  });
  assert.deepEqual(unrelatedRoster.resolvedCharacters.map((c) => c.storageId), ['starlight_original::levi']);
  assert.equal(unrelatedRoster.resolvedCharacters[0].name, 'Levi Starlight (Sci-Fi)');
  assert.deepEqual(unrelatedRoster.inactiveOptionalCharacters, []);
}

// 4. Conversational config proposal schema (omitted vs empty, enable/disable, overlay removal, relationship removal)
{
  const proposal = validateConfigProposal({
    id: 'prop-1',
    sourceMessage: 'OKAAAAY SOOOO actually remove Joseph, clear screen cast, remove Violet overlay, and clear eruri!',
    optionalCharacterOps: { disable: ['joseph'] },
    overlayOps: { remove: ['levi_violet_traits'] },
    casts: { screen: [] }, // explicitly empty -> clears screen cast, while room/outside omitted!
    relationshipOps: { set: { eruri: 'former_lovers' }, remove: ['joseph_marriage'] },
    unresolvedAmbiguities: ['Confirm timeline checkpoint'],
  });
  assert.equal(proposal.status, 'proposed');
  assert.deepEqual(proposal.optionalCharacterOps.disable, ['joseph']);
  assert.deepEqual(proposal.overlayOps.remove, ['levi_violet_traits']);
  assert.deepEqual(proposal.castOps.screen.set, []);
  assert.equal(proposal.castOps.room, undefined, 'Omitted cast layer must remain undefined');
  assert.deepEqual(proposal.relationshipOps.remove, ['joseph_marriage']);
  assert.throws(() => validateConfigProposal({ status: 'auto_canon' }));
}

console.log('PASS: all Milestone 1 offline unit tests passed (v2 backup, namespaced IDs, Bible v1.1 cross-ref validation, general overlays, scopes, conflicts, cross-story & unrelated-fandom isolation, proposal correction ops).');
