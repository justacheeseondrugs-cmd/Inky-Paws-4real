// Offline Milestone 2 unit tests: reusable presets, Power to Strive invariants,
// Eruri configuration, layer-aware validation, Character Lab scopes & conflicts,
// and unrelated fandom isolation. Synthetic fixtures only; zero paid API calls.
// Run with: node tests/milestone2-unit.mjs
import assert from 'node:assert/strict';

import {
  normalizeUniversalCharacter,
  normalizeCharacterOverlay,
  isOverlayConfigured,
} from '../js/characterLibrary.js';
import {
  PTS_FANDOM,
  NEUTRAL_FANDOM,
  getBuiltinPresets,
  combinePresetTemplates,
  buildStoryConfigFromPreset,
} from '../js/storyPresets.js';
import {
  PTS_DEFAULT_TWELVE,
  resolveUniverseConfiguration,
  validateLayerSafety,
} from '../js/universeResolver.js';

function makeSyntheticUniversalLibrary() {
  const chars = [
    ...PTS_DEFAULT_TWELVE.map((id) => normalizeUniversalCharacter({
      id,
      name: id[0].toUpperCase() + id.slice(1),
      fandom: PTS_FANDOM,
      category: 'core',
      corePersonality: `Standard ${id} personality.`,
    })),
    normalizeUniversalCharacter({
      id: 'joseph',
      name: 'Joseph Alcott',
      fandom: PTS_FANDOM,
      category: 'optional',
      corePersonality: 'Dry observant informant.',
    }),
    normalizeUniversalCharacter({
      id: 'anya',
      name: 'Anya',
      fandom: PTS_FANDOM,
      category: 'optional',
      corePersonality: 'Five-year-old non-telepathic child.',
    }),
    normalizeUniversalCharacter({
      id: 'aria',
      name: 'Aria Solis',
      fandom: 'starlight_original',
      category: 'core',
      corePersonality: 'Original sci-fi astronomer.',
    }),
  ];
  const emptyVioletOverlay = normalizeCharacterOverlay({
    id: 'levi_violet_traits',
    name: 'Violet Traits (Levi)',
    baseCharacterId: 'levi',
    fandom: PTS_FANDOM,
    characterizationChanges: [],
    preserveCoreTraits: ['Blunt economy of words', 'Loyal protector'],
    allowedScopes: ['story', 'character_version', 'scene'],
  });
  return { chars, emptyVioletOverlay };
}

const presets = getBuiltinPresets();
const presetByLogical = new Map(presets.map((p) => [p.logicalId, p]));
const { chars, emptyVioletOverlay } = makeSyntheticUniversalLibrary();

// 1. Classic Eruri with standard Levi (12 viewers, Candy facilitator, no Joseph/Anya/Violet)
{
  const cfg = buildStoryConfigFromPreset('story-classic', presetByLogical.get('classic_eruri'));
  const res = resolveUniverseConfiguration({
    storyConfig: cfg,
    universalCharacters: chars,
    overlays: [emptyVioletOverlay],
    documents: [{ id: 'd-ve', filename: 'Violet Evergarden.txt', type: 'STYLE_ONLY', active: true }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.allowedRoomCast.length, 12);
  assert.equal(res.facilitator?.id, 'candy');
  assert.ok(!res.allowedRoomCast.includes('candy'), 'Candy is facilitator, not ordinary spectator');
  assert.ok(!res.allowedRoomCast.includes('joseph'));
  assert.ok(!res.allowedRoomCast.includes('anya'));
  assert.equal(res.josephStatus, 'disabled');
  assert.equal(res.anyaStatus, 'disabled');
  assert.equal(res.relationshipSummary.eruri.state, 'mutual_pining');
  assert.equal(res.relationshipSummary.eruri.publiclyKnown, false);
  assert.equal(res.activeOverlays.length, 0, 'STYLE_ONLY Violet Evergarden doc must NEVER activate Violet traits');
  assert.ok(res.styleOnlyNote.includes('Violet Evergarden.txt'));
  const levi = res.resolvedCharacters.find((c) => c.id === 'levi');
  assert.equal(levi.isStandardDefault, true);
}

// 2. Empty Violet overlay in Violet AU -> warns unconfigured, invents ZERO traits
{
  const cfg = buildStoryConfigFromPreset('story-violet-empty', presetByLogical.get('violet_au'));
  const res = resolveUniverseConfiguration({
    storyConfig: cfg,
    universalCharacters: chars,
    overlays: [emptyVioletOverlay],
  });
  assert.equal(res.ok, true);
  assert.equal(res.unconfiguredOverlays.length, 1);
  assert.equal(res.warnings.some((w) => w.type === 'overlay_unconfigured'), true);
  const levi = res.resolvedCharacters.find((c) => c.id === 'levi');
  assert.equal(levi.isStandardDefault, true);
  assert.deepEqual(levi.effectiveProfile.overlayTraits, []);
}

// 3. Author-configured Violet overlay + Independent Room vs Screen Levi + Scene-only expiration
{
  const customViolet = normalizeCharacterOverlay({
    ...emptyVioletOverlay,
    characterizationChanges: ['Author-approved trait one', 'Author-approved trait two'],
  }, { existing: emptyVioletOverlay, markAuthorEdited: true });
  assert.equal(isOverlayConfigured(customViolet), true);

  // Room vs Screen Levi: only Screen Levi gets Violet traits
  const splitCfg = buildStoryConfigFromPreset('story-split', presetByLogical.get('classic_eruri'), {
    overlayActivations: [{
      overlayId: customViolet.id,
      scope: 'character_version',
      characterVersion: 'screen',
      enabled: true,
    }],
  });
  const roomView = resolveUniverseConfiguration({
    storyConfig: splitCfg,
    universalCharacters: chars,
    overlays: [customViolet],
    context: { characterVersion: 'room' },
  });
  const screenView = resolveUniverseConfiguration({
    storyConfig: splitCfg,
    universalCharacters: chars,
    overlays: [customViolet],
    context: { characterVersion: 'screen' },
  });
  assert.equal(roomView.resolvedCharacters.find((c) => c.id === 'levi').isStandardDefault, true);
  assert.equal(screenView.resolvedCharacters.find((c) => c.id === 'levi').isStandardDefault, false);
  assert.deepEqual(screenView.versionComparison.levi.roomTraits, []);
  assert.deepEqual(screenView.versionComparison.levi.screenTraits, ['Author-approved trait one', 'Author-approved trait two']);

  // Scene-only overlay expires outside ch3-s2
  const sceneCfg = buildStoryConfigFromPreset('story-scene', presetByLogical.get('classic_eruri'), {
    overlayActivations: [{
      overlayId: customViolet.id,
      scope: 'scene',
      characterVersion: 'all',
      sceneId: 'ch3-s2',
      enabled: true,
    }],
  });
  const inScene = resolveUniverseConfiguration({
    storyConfig: sceneCfg,
    universalCharacters: chars,
    overlays: [customViolet],
    context: { characterVersion: 'room', sceneId: 'ch3-s2' },
  });
  const afterScene = resolveUniverseConfiguration({
    storyConfig: sceneCfg,
    universalCharacters: chars,
    overlays: [customViolet],
    context: { characterVersion: 'room', sceneId: 'ch3-s3' },
  });
  assert.equal(inScene.activeOverlays.length, 1);
  assert.equal(afterScene.activeOverlays.length, 0);
}

// 4. Joseph outside room vs explicit Joseph invitation (does NOT enable Anya or marriage)
{
  const josephOutsideCfg = buildStoryConfigFromPreset('story-j-out', presetByLogical.get('joseph_au'), {
    casts: { outside: ['joseph'], screen: ['joseph'] },
  });
  const outRes = resolveUniverseConfiguration({
    storyConfig: josephOutsideCfg,
    universalCharacters: chars,
    overlays: [emptyVioletOverlay],
  });
  assert.equal(outRes.ok, true);
  assert.equal(outRes.josephStatus, 'enabled_outside_uninvited');
  assert.equal(outRes.anyaStatus, 'disabled', 'Enabling Joseph must NOT enable Anya');
  assert.equal(outRes.relationshipSummary.josephMarriage, false, 'Enabling Joseph must NOT imply marriage');
  assert.equal(outRes.allowedRoomCast.length, 12);
  assert.ok(!outRes.allowedRoomCast.includes('joseph'));

  // Trying to put uninvited Joseph in room triggers contradiction
  const badJosephRoom = buildStoryConfigFromPreset('story-j-bad', presetByLogical.get('joseph_au'), {
    casts: { room: [...PTS_DEFAULT_TWELVE, 'joseph'] },
  });
  const badRes = resolveUniverseConfiguration({ storyConfig: badJosephRoom, universalCharacters: chars });
  assert.equal(badRes.ok, false);
  assert.ok(badRes.contradictions.some((c) => c.id === 'joseph_uninvited_room_entry'));
  assert.ok(!badRes.allowedRoomCast.includes('joseph'));

  // Explicit author invitation -> 13th viewer + prior episode knowledge barrier
  const invitedCfg = buildStoryConfigFromPreset('story-j-in', presetByLogical.get('joseph_au'), {
    roomGuestInvitations: ['joseph'],
  });
  const invitedRes = resolveUniverseConfiguration({ storyConfig: invitedCfg, universalCharacters: chars });
  assert.equal(invitedRes.ok, true);
  assert.equal(invitedRes.josephStatus, 'invited_room_guest');
  assert.equal(invitedRes.allowedRoomCast.length, 13);
  assert.ok(invitedRes.allowedRoomCast.includes('joseph'));
  assert.ok(invitedRes.knowledgeBarriers.some((b) => b.characterId === 'joseph'));
}

// 5. Anya on screen / outside + legitimate room mentions vs absolute room-entry prohibition
{
  const familyCfg = buildStoryConfigFromPreset('story-family', presetByLogical.get('joseph_anya_family_au'), {
    casts: { screen: ['levi', 'joseph', 'anya'], outside: ['joseph', 'anya'] },
    premise: 'Levi mentions Anya to Erwin while the room watches Anya on screen in a flashback.',
  });
  const okFamily = resolveUniverseConfiguration({ storyConfig: familyCfg, universalCharacters: chars });
  assert.equal(okFamily.ok, true, `Legitimate Anya screen/outside/mention should be valid: ${JSON.stringify(okFamily.contradictions)}`);
  assert.equal(okFamily.anyaStatus, 'enabled_outside_and_screen_only');
  assert.ok(!okFamily.allowedRoomCast.includes('anya'));
  assert.ok(okFamily.screenCast.includes('anya'));

  // Legitimate room dialogue mentioning Anya is ALLOWED (no global forbidden-name ban!)
  const mentionCheck = validateLayerSafety({
    text: 'Hange asked Levi about Anya after the recording paused. Erwin quietly mentioned Anya without guessing the rest.',
    fandom: PTS_FANDOM,
    reactionMode: true,
    enabledOptional: ['joseph', 'anya'],
  });
  assert.equal(mentionCheck.ok, true);

  // Attempting Anya room entry via room cast, invitation, or magical portal/dream/call -> BLOCKED!
  const badAnyaCfg = buildStoryConfigFromPreset('story-anya-bad', presetByLogical.get('joseph_anya_family_au'), {
    roomGuestInvitations: ['anya'],
    casts: { room: [...PTS_DEFAULT_TWELVE, 'anya'] },
    premise: 'Anya enters the watching room through a magical portal.',
  });
  const badAnyaRes = resolveUniverseConfiguration({ storyConfig: badAnyaCfg, universalCharacters: chars });
  assert.equal(badAnyaRes.ok, false);
  assert.ok(!badAnyaRes.allowedRoomCast.includes('anya'), 'Anya must be structurally excluded from allowedRoomCast');
  assert.ok(badAnyaRes.contradictions.some((c) => c.id === 'anya_room_entry_forbidden'));
  assert.ok(badAnyaRes.contradictions.some((c) => c.id === 'anya_room_entry_violation'));
}

// 6. Combining compatible presets + multiple independent stories from same preset
{
  const combined = combinePresetTemplates([
    presetByLogical.get('violet_au'),
    presetByLogical.get('joseph_au'),
  ], { name: 'Violet + Joseph Combined' });
  assert.ok(combined.enabledOptionalCharacters.includes('joseph'));
  assert.ok(!combined.enabledOptionalCharacters.includes('anya'));
  assert.equal(combined.authorizedOverlays.length, 1);

  const story1 = buildStoryConfigFromPreset('story-copy-1', combined, { universeName: 'Timeline 1' });
  const story2 = buildStoryConfigFromPreset('story-copy-2', combined, { universeName: 'Timeline 2' });
  story1.roomGuestInvitations.push('joseph');
  assert.ok(!story2.roomGuestInvitations.includes('joseph'), 'Stories from same preset must stay independent');
}

// 7. Unrelated fandom / original fiction inherits ZERO Power to Strive rules
{
  const neutralCfg = buildStoryConfigFromPreset('orig-scifi', presetByLogical.get('original_neutral'), {
    fandom: 'starlight_original',
    universeName: 'Starlight Station',
    casts: { room: ['Aria Solis'] },
  });
  const neutralRes = resolveUniverseConfiguration({
    storyConfig: neutralCfg,
    universalCharacters: chars,
    overlays: [emptyVioletOverlay],
  });
  assert.equal(neutralRes.ok, true);
  assert.equal(neutralRes.isPowerToStrive, false);
  assert.equal(neutralRes.facilitator, null);
  assert.deepEqual(neutralRes.allowedRoomCast, ['Aria Solis']);
  assert.equal(neutralRes.resolvedCharacters.length, 1);
  assert.equal(neutralRes.resolvedCharacters[0].id, 'aria');
  assert.equal(neutralRes.josephStatus, 'not_applicable');
  assert.equal(neutralRes.anyaStatus, 'not_applicable');
  assert.equal(neutralRes.relationshipSummary.eruri, undefined);
}

// 8. Conflicting overlays detection and explicit resolution
{
  const ov1 = normalizeCharacterOverlay({
    id: 'levi_variant_a',
    name: 'Variant A',
    baseCharacterId: 'levi',
    fandom: PTS_FANDOM,
    characterizationChanges: ['Trait A'],
    conflictGroup: 'levi_alt',
  });
  const ov2 = normalizeCharacterOverlay({
    id: 'levi_variant_b',
    name: 'Variant B',
    baseCharacterId: 'levi',
    fandom: PTS_FANDOM,
    characterizationChanges: ['Trait B'],
    conflictGroup: 'levi_alt',
  });
  const conflictCfg = buildStoryConfigFromPreset('story-conflict', presetByLogical.get('classic_eruri'), {
    overlayActivations: [
      { overlayId: ov1.id, scope: 'story', enabled: true },
      { overlayId: ov2.id, scope: 'story', enabled: true },
    ],
  });
  const conflicted = resolveUniverseConfiguration({
    storyConfig: conflictCfg,
    universalCharacters: chars,
    overlays: [ov1, ov2],
  });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.contradictions.some((c) => c.type === 'overlay_conflict'), true);

  const pairKey = conflicted.contradictions.find((c) => c.type === 'overlay_conflict').pairKey;
  conflictCfg.approvedConflictWinners[pairKey] = ov1.id;
  const resolved = resolveUniverseConfiguration({
    storyConfig: conflictCfg,
    universalCharacters: chars,
    overlays: [ov1, ov2],
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.activeOverlays.map((a) => a.overlayLogicalId), ['levi_variant_a']);
}

console.log('PASS: all Milestone 2 offline unit tests passed (presets, PtS invariants, Eruri, Joseph/Anya layer safety, Room vs Screen & scene overlays, conflicts, neutral fandom isolation).');
