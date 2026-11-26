// universeResolver.js — Motor determinista de reglas por fandom/universo,
// invariantes de Power to Strive, configuración de Eruri, validación por capas
// y vista previa de configuración narrativa (0 tokens).
//
// Este mismo resolvedor será consumido directamente por el Context Engine unificado
// en el Hito 5: jamás construye un sistema paralelo contradictorio.

import {
  normalizeFandomNamespace,
  extractLogicalId,
  resolveStoryCharacterRoster,
  resolveCharacterProfile,
} from './characterLibrary.js';
import { PTS_FANDOM, NEUTRAL_FANDOM } from './storyPresets.js';

export const PTS_DEFAULT_TWELVE = [
  'erwin',
  'levi',
  'hange',
  'petra',
  'eren',
  'mikasa',
  'armin',
  'jean',
  'connie',
  'sasha',
  'ymir',
  'historia',
];

export const PTS_DISPLAY_NAMES = {
  erwin: 'Erwin Smith',
  levi: 'Levi Ackerman',
  hange: 'Hange Zoë',
  petra: 'Petra Ral',
  eren: 'Eren Yeager',
  mikasa: 'Mikasa Ackerman',
  armin: 'Armin Arlert',
  jean: 'Jean Kirstein',
  connie: 'Connie Springer',
  sasha: 'Sasha Blouse',
  ymir: 'Ymir',
  historia: 'Historia Reiss / Christa Lenz',
  candy: 'Candy',
  joseph: 'Joseph Alcott',
  anya: 'Anya',
};

export const PTS_FACILITATOR = {
  id: 'candy',
  name: 'Candy',
  role: 'facilitator',
  note: 'Facilitadora de la sala de reacciones; no cuenta como espectadora ordinaria.',
};

export const ERURI_STATES = [
  { id: 'mutual_pining', label: 'Anhelo mutuo (Mutual pining)' },
  { id: 'secret_relationship', label: 'Relación secreta' },
  { id: 'established_relationship', label: 'Relación establecida' },
  { id: 'former_lovers', label: 'Ex amantes con afecto continuo' },
  { id: 'revealed_relationship', label: 'Relación revelada' },
  { id: 'custom', label: 'Personalizado' },
];

export const PTS_CHECKPOINTS = [
  { id: 'before_first_screen', label: 'Dos días antes de la 57ª Expedición (inicio)' },
  { id: 'after_s1', label: 'Tras el visionado de la Temporada 1' },
  { id: 'after_s2', label: 'Tras el visionado de la Temporada 2' },
  { id: 's3_alternate', label: 'Continuación alternativa PtS III Parte 1' },
  { id: 'custom', label: 'Checkpoint personalizado' },
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = cleanString(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function canonicalNameToId(name) {
  const n = cleanString(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!n) return '';
  if (n.includes('erwin')) return 'erwin';
  if (n.includes('levi')) return 'levi';
  if (n.includes('hange') || n.includes('hanji')) return 'hange';
  if (n.includes('petra')) return 'petra';
  if (n.includes('eren')) return 'eren';
  if (n.includes('mikasa')) return 'mikasa';
  if (n.includes('armin')) return 'armin';
  if (n.includes('jean')) return 'jean';
  if (n.includes('connie')) return 'connie';
  if (n.includes('sasha')) return 'sasha';
  if (n.includes('ymir')) return 'ymir';
  if (n.includes('historia') || n.includes('christa') || n.includes('krista')) return 'historia';
  if (n.includes('joseph')) return 'joseph';
  if (n.includes('anya')) return 'anya';
  if (n.includes('candy')) return 'candy';
  return extractLogicalId(n);
}

export function normalizeEruriConfig(rawEruri) {
  if (!rawEruri) {
    return {
      configured: false,
      state: 'mutual_pining',
      customLabel: '',
      publiclyKnown: false,
      knownBy: [],
      suspectedBy: [],
      historyNote: '',
    };
  }
  if (typeof rawEruri === 'string') {
    const validIds = new Set(ERURI_STATES.map((s) => s.id));
    const cleaned = cleanString(rawEruri);
    const mapped = cleaned === 'mutual_attachment_unspoken'
      ? 'mutual_pining'
      : (cleaned === 'former_lovers_continuing_attachment' ? 'former_lovers' : cleaned);
    return {
      configured: true,
      state: validIds.has(mapped) ? mapped : 'custom',
      customLabel: validIds.has(mapped) ? '' : cleaned,
      publiclyKnown: mapped === 'revealed_relationship',
      knownBy: [],
      suspectedBy: [],
      historyNote: '',
    };
  }
  const stateId = cleanString(rawEruri.state || 'mutual_pining');
  const validIds = new Set(ERURI_STATES.map((s) => s.id));
  const resolvedState = validIds.has(stateId) ? stateId : 'custom';
  return {
    configured: true,
    state: resolvedState,
    customLabel: cleanString(rawEruri.customLabel || (validIds.has(stateId) ? '' : stateId)),
    publiclyKnown: Boolean(rawEruri.publiclyKnown ?? (resolvedState === 'revealed_relationship')),
    knownBy: cleanStringArray(rawEruri.knownBy || []).map(extractLogicalId),
    suspectedBy: cleanStringArray(rawEruri.suspectedBy || []).map(extractLogicalId),
    historyNote: cleanString(rawEruri.historyNote || ''),
  };
}

/**
 * Validación por capas para texto/instrucciones en Power to Strive:
 * - Mencionar a Anya en diálogo de la sala o verla en pantalla/flashback ES LEGÍTIMO.
 * - Colocar a Anya como participante viva en la sala (entrada, portal, sueño, llamada,
 *   telepatía o proxy) se detecta como violación estructural crítica.
 */
export function validateLayerSafety({
  text = '',
  fandom = NEUTRAL_FANDOM,
  reactionMode = false,
  enabledOptional = [],
  roomGuestInvitations = [],
} = {}) {
  const issues = [];
  if (normalizeFandomNamespace(fandom) !== PTS_FANDOM || !reactionMode) {
    return { ok: true, issues };
  }
  const source = cleanString(text);
  if (!source) return { ok: true, issues };

  const sentences = source.split(/[\n.!?]+/).map((s) => s.trim()).filter(Boolean);
  const enabledSet = new Set(cleanStringArray(enabledOptional).map(extractLogicalId));
  const invitedSet = new Set(cleanStringArray(roomGuestInvitations).map(extractLogicalId));

  // Patrones que indican participación VIVA en sala (no mención ni pantalla)
  const roomPresenceRx = /\b(enter(?:s|ed|ing)?|join(?:s|ed|ing)?|arrives?\s+in|sits?\s+in|walks?\s+into|summon(?:s|ed)?|appears?\s+in|portal|dream|telepath|live\s+call|proxy|entra(?:r|ndo)?\s+en\s+la\s+sala|llega\s+a\s+la\s+sala|se\s+sienta\s+en\s+la\s+sala|participa\s+en\s+la\s+sala|invita(?:r|da)?\s+a\s+la\s+sala)\b/i;
  const roomContextRx = /\b(watching\s+room|reaction\s+room|viewing\s+room|the\s+room|sala\s+de\s+reacciones|la\s+sala|portal|dream|telepath|live\s+call|proxy)\b/i;
  const screenOrMentionRx = /\b(on\s*screen|onscreen|en\s+pantalla|footage|recording|video|flashback|memory|memories|recuerdo|outside\s+scene|escena\s+exterior|mention(?:s|ed|ing)?|menciona|talk(?:s|ed|ing)?\s+about|habla(?:n|ba)?\s+de)\b/i;

  for (const sentence of sentences) {
    if (/\banya\b/i.test(sentence)) {
      if (roomPresenceRx.test(sentence) && roomContextRx.test(sentence) && !screenOrMentionRx.test(sentence)) {
        issues.push({
          id: 'anya_room_entry_violation',
          level: 'critical',
          characterId: 'anya',
          message: 'Regla no negociable: Anya NUNCA puede entrar ni participar en vivo en la sala de reacciones (tampoco por portal, sueño, llamada, telepatía o proxy). Puede ser mencionada en diálogo o aparecer en pantalla/escenas exteriores si está habilitada.',
          evidence: sentence,
        });
      }
    }
    if (/\bjoseph\b/i.test(sentence)) {
      if (roomPresenceRx.test(sentence) && roomContextRx.test(sentence) && !screenOrMentionRx.test(sentence)) {
        if (!enabledSet.has('joseph')) {
          issues.push({
            id: 'joseph_disabled_room_violation',
            level: 'critical',
            characterId: 'joseph',
            message: 'Joseph está deshabilitado en esta historia y no puede entrar en la sala de reacciones.',
            evidence: sentence,
          });
        } else if (!invitedSet.has('joseph')) {
          issues.push({
            id: 'joseph_uninvited_room_violation',
            level: 'critical',
            characterId: 'joseph',
            message: 'Joseph está habilitado fuera de la sala, pero todavía NO tiene una invitación explícita autorizada para entrar a la sala de reacciones.',
            evidence: sentence,
          });
        }
      }
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'critical'),
    issues,
  };
}

/**
 * Resolvedor determinista y gratuito (0 tokens) de universo, reparto, relaciones,
 * overlays y contradicciones. Será la entrada directa del Context Engine del Hito 5.
 */
export function resolveUniverseConfiguration({
  storyConfig = null,
  universalCharacters = [],
  storyCharacters = [],
  overlays = [],
  documents = [],
  context = {},
} = {}) {
  const fandom = normalizeFandomNamespace(storyConfig?.fandom || context?.fandom || NEUTRAL_FANDOM);
  const isPts = fandom === PTS_FANDOM;
  const reactionMode = typeof storyConfig?.reactionMode === 'boolean' ? storyConfig.reactionMode : isPts;

  const contradictions = [];
  const warnings = [];
  const knowledgeBarriers = [];

  const enabledOptional = cleanStringArray(storyConfig?.enabledOptionalCharacters || []).map(extractLogicalId);
  const enabledOptionalSet = new Set(enabledOptional);
  const rawInvitations = cleanStringArray(storyConfig?.roomGuestInvitations || []).map(extractLogicalId);
  const rawRoomCast = cleanStringArray(storyConfig?.casts?.room || []);
  const rawScreenCast = cleanStringArray(storyConfig?.casts?.screen || []);
  const rawOutsideCast = cleanStringArray(storyConfig?.casts?.outside || []);

  // Verificar que STYLE_ONLY (p.ej. Violet Evergarden) nunca active overlays
  const styleOnlyDocs = (documents || []).filter((d) => d && d.active !== false && d.type === 'STYLE_ONLY');
  const styleOnlyNote = styleOnlyDocs.length
    ? `Documentos STYLE_ONLY detectados (${styleOnlyDocs.map((d) => d.filename).join(', ')}): aportan sólo oficio literario y NUNCA activan overlays de caracterización.`
    : '';

  let allowedRoomCast = [];
  let facilitator = null;
  let screenCast = [...rawScreenCast];
  let outsideCast = [...rawOutsideCast];
  let josephStatus = 'not_applicable';
  let anyaStatus = 'not_applicable';
  let relationshipSummary = {};

  if (isPts) {
    // --- Reglas estructurales de Power to Strive ---
    facilitator = reactionMode ? { ...PTS_FACILITATOR } : null;

    // 1. Anya: deshabilitada por defecto; JAMÁS entra en sala
    const anyaEnabled = enabledOptionalSet.has('anya');
    const anyaInInvitations = rawInvitations.includes('anya');
    const anyaInRawRoom = rawRoomCast.some((name) => canonicalNameToId(name) === 'anya');
    if (anyaInInvitations || anyaInRawRoom) {
      contradictions.push({
        id: 'anya_room_entry_forbidden',
        level: 'critical',
        characterId: 'anya',
        message: 'Anya tiene prohibida la entrada o participación en vivo en la sala de reacciones bajo cualquier circunstancia. Fue excluida automáticamente del reparto permitido de la sala.',
      });
    }
    if (!anyaEnabled && (rawScreenCast.some((n) => canonicalNameToId(n) === 'anya') || rawOutsideCast.some((n) => canonicalNameToId(n) === 'anya'))) {
      contradictions.push({
        id: 'anya_disabled_but_cast',
        level: 'critical',
        characterId: 'anya',
        message: 'Anya aparece en pantalla o escenas exteriores, pero está deshabilitada en los personajes opcionales de esta historia.',
      });
    }
    anyaStatus = anyaEnabled ? 'enabled_outside_and_screen_only' : 'disabled';

    // 2. Joseph: deshabilitado por defecto; entra a sala SOLO tras invitación explícita
    const josephEnabled = enabledOptionalSet.has('joseph');
    const josephInvited = rawInvitations.includes('joseph');
    const josephInRawRoom = rawRoomCast.some((name) => canonicalNameToId(name) === 'joseph');

    if (!josephEnabled && (josephInvited || josephInRawRoom || rawScreenCast.some((n) => canonicalNameToId(n) === 'joseph') || rawOutsideCast.some((n) => canonicalNameToId(n) === 'joseph'))) {
      contradictions.push({
        id: 'joseph_disabled_but_referenced_in_cast',
        level: 'critical',
        characterId: 'joseph',
        message: 'Joseph está deshabilitado en esta historia; actívalo explícitamente en personajes opcionales antes de incluirlo en pantalla, exterior o invitación.',
      });
    }
    if (josephEnabled && josephInRawRoom && !josephInvited) {
      contradictions.push({
        id: 'joseph_uninvited_room_entry',
        level: 'critical',
        characterId: 'joseph',
        message: 'Joseph está habilitado fuera de la sala, pero no tiene invitación explícita de Candy/autora para entrar a la sala de reacciones. Se excluyó de la sala permitida.',
      });
    }
    if (josephEnabled && josephInvited) {
      josephStatus = 'invited_room_guest';
      knowledgeBarriers.push({
        characterId: 'joseph',
        rule: 'no_automatic_prior_episode_knowledge',
        message: 'Joseph entra como 13.º espectador por invitación explícita, pero NO hereda automáticamente el conocimiento de episodios vistos antes de su llegada.',
      });
    } else if (josephEnabled) {
      josephStatus = 'enabled_outside_uninvited';
    } else {
      josephStatus = 'disabled';
    }

    // Otros invitados no autorizados en la biblia de PtS
    const unauthorizedGuests = rawInvitations.filter((g) => g !== 'joseph' && g !== 'anya' && !PTS_DEFAULT_TWELVE.includes(g));
    if (unauthorizedGuests.length) {
      warnings.push({
        id: 'non_standard_room_guest',
        level: 'warning',
        message: `Invitado(s) fuera del estándar de la Biblia Maestra: ${unauthorizedGuests.join(', ')}. Verifica que estén explícitamente autorizados para este AU.`,
      });
    }

    // 3. Reparto permitido de la sala de reacciones
    if (reactionMode) {
      const baseTwelve = rawRoomCast.length
        ? rawRoomCast
            .map(canonicalNameToId)
            .filter((cid) => cid !== 'anya' && cid !== 'candy' && (cid !== 'joseph' || (josephEnabled && josephInvited)))
        : [...PTS_DEFAULT_TWELVE];
      const roomSet = new Set(baseTwelve.length ? baseTwelve : PTS_DEFAULT_TWELVE);
      if (josephEnabled && josephInvited) roomSet.add('joseph');
      roomSet.delete('anya');
      roomSet.delete('candy');
      allowedRoomCast = [...roomSet];
    } else {
      allowedRoomCast = rawRoomCast.map(canonicalNameToId).filter((cid) => cid !== 'anya' || anyaEnabled);
    }

    // 4. Relación Eruri (separando estado real vs quién lo sabe o sospecha)
    const eruri = normalizeEruriConfig(storyConfig?.relationshipStates?.eruri);
    const otherRelationships = {};
    for (const [k, v] of Object.entries(storyConfig?.relationshipStates || {})) {
      if (k !== 'eruri') otherRelationships[k] = structuredClone(v);
    }
    relationshipSummary = {
      eruri,
      josephMarriage: Boolean(storyConfig?.relationshipStates?.joseph_marriage === true),
      other: otherRelationships,
    };
  } else {
    // --- Namespace neutral / otros fandoms / ficción original (ZERO reglas PtS) ---
    allowedRoomCast = [...rawRoomCast];
    relationshipSummary = structuredClone(storyConfig?.relationshipStates || {});
  }

  // Validar texto de premisa y reglas de la historia por capas (sin baneos léxicos globales)
  const layerValidation = validateLayerSafety({
    text: [storyConfig?.premise || '', ...(storyConfig?.storyRules || [])].join('\n'),
    fandom,
    reactionMode,
    enabledOptional,
    roomGuestInvitations: rawInvitations,
  });
  for (const issue of layerValidation.issues) {
    contradictions.push(issue);
  }

  // Resolución de personajes y overlays para el ámbito solicitado (y comparación room vs screen)
  const effectiveVersion = cleanString(context?.characterVersion || (reactionMode ? 'room' : 'default'));
  const sceneId = cleanString(context?.sceneId || '') || null;
  const roster = resolveStoryCharacterRoster({
    universalCharacters,
    storyCharacters,
    overlays,
    storyConfig,
    context: {
      fandom,
      characterVersion: effectiveVersion,
      sceneId,
      approvedConflictWinners: storyConfig?.approvedConflictWinners || {},
    },
  });

  // Comparativa explícita Room vs Screen para detectar diferencias de caracterización por versión
  const versionComparison = {};
  for (const resolvedChar of roster.resolvedCharacters) {
    const roomProfile = resolveCharacterProfile({
      universalProfile: resolvedChar.baseProfile,
      storyCharacter: resolvedChar.storyState,
      overlays,
      activations: storyConfig?.overlayActivations || [],
      context: { fandom, characterVersion: 'room', sceneId, approvedConflictWinners: storyConfig?.approvedConflictWinners || {} },
    });
    const screenProfile = resolveCharacterProfile({
      universalProfile: resolvedChar.baseProfile,
      storyCharacter: resolvedChar.storyState,
      overlays,
      activations: storyConfig?.overlayActivations || [],
      context: { fandom, characterVersion: 'screen', sceneId, approvedConflictWinners: storyConfig?.approvedConflictWinners || {} },
    });
    if (
      roomProfile.appliedOverlays.length ||
      screenProfile.appliedOverlays.length ||
      roomProfile.unconfiguredOverlays.length ||
      screenProfile.unconfiguredOverlays.length
    ) {
      versionComparison[resolvedChar.id] = {
        characterName: resolvedChar.name,
        roomOverlays: roomProfile.appliedOverlays,
        screenOverlays: screenProfile.appliedOverlays,
        roomIsStandard: roomProfile.isStandardDefault,
        screenIsStandard: screenProfile.isStandardDefault,
        roomTraits: roomProfile.effectiveProfile.overlayTraits,
        screenTraits: screenProfile.effectiveProfile.overlayTraits,
      };
    }
  }

  for (const c of roster.conflicts) contradictions.push(c);
  for (const w of roster.warnings) warnings.push(w);

  const pendingProposals = (storyConfig?.proposals || []).filter((p) => p.status === 'proposed');

  return {
    fandom,
    isPowerToStrive: isPts,
    presetId: storyConfig?.presetId || null,
    universeName: cleanString(storyConfig?.universeName || ''),
    premise: cleanString(storyConfig?.premise || ''),
    checkpointId: cleanString(storyConfig?.checkpointId || ''),
    reactionMode,
    facilitator,
    allowedRoomCast,
    allowedRoomCastLabels: allowedRoomCast.map((id) => PTS_DISPLAY_NAMES[id] || id),
    screenCast,
    outsideCast,
    enabledOptionalCharacters: enabledOptional,
    inactiveOptionalCharacters: roster.inactiveOptionalCharacters,
    josephStatus,
    anyaStatus,
    relationshipSummary,
    activeOverlays: roster.activeOverlays,
    unconfiguredOverlays: roster.unconfiguredOverlays,
    versionComparison,
    resolvedCharacters: roster.resolvedCharacters,
    privateAuthorKnowledge: cleanStringArray(storyConfig?.privateAuthorKnowledge || []),
    storyRules: cleanStringArray(storyConfig?.storyRules || []),
    knowledgeBarriers,
    styleOnlyNote,
    pendingProposalsCount: pendingProposals.length,
    contradictions,
    warnings,
    ok: contradictions.length === 0,
    engineIntegrationStatus: {
      connectedToGeneration: [
        'Fichas locales de personaje por historia (characters)',
        'Hechos bloqueados y canon revelado/privado',
        'Filtrado cronológico de memorias y recuerdos históricos',
        'Límites de salida por proveedor, cuarentena y reescritura con revisión',
      ],
      configuredAwaitingContextEngine: [
        'Inyección automática de perfiles de la Biblioteca Universal',
        'Aplicación de overlays de Character Lab al prompt de generación',
        'Aplicación automática de presets, Eruri y barreras epistémicas de storyConfigs',
        'Extracción automática de propuestas desde SOS Ideas (Hito 4/5)',
      ],
    },
  };
}
