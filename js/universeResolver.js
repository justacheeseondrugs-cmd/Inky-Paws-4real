// universeResolver.js — Motor determinista de reglas por fandom/universo,
// invariantes de Power to Strive, invitaciones temporales, configuración de Eruri,
// prevalidación estructural por capas y vista previa de configuración narrativa (0 tokens).
//
// Este mismo resolvedor será consumido directamente por el Context Engine unificado
// en el Hito 5: jamás construye un sistema paralelo contradictorio.
//
// NOTA IMPORTANTE SOBRE ALCANCE DE VALIDACIÓN:
// `validateLayerSafety` y `resolveUniverseConfiguration` realizan comprobaciones
// deterministas estructurales y heurísticas de prevalidación (0 tokens).
// NO garantizan cumplimiento semántico completo en prosa generada; la auditoría
// semántica se conectará sobre `buildSemanticReviewPayload` en el Hito 5.

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

export const PTS_DEFAULT_TWELVE_SET = new Set(PTS_DEFAULT_TWELVE);

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

export const PTS_CHECKPOINT_ORDER = {
  before_first_screen: 0,
  after_s1: 1,
  after_s2: 2,
  s3_alternate: 3,
};

// Mapa estricto de nombres exactos normalizados y alias explícitos para Power to Strive.
// Nunca usa coincidencias por subcadena (`includes`), evitando falsos positivos como
// "Levine" -> levi, "Serena"/"Erenwald" -> eren o "Tanya" -> anya.
export const PTS_EXACT_ALIASES = new Map([
  ['erwin', 'erwin'],
  ['erwin smith', 'erwin'],
  ['commander erwin', 'erwin'],
  ['commander erwin smith', 'erwin'],
  ['comandante erwin', 'erwin'],
  ['levi', 'levi'],
  ['levi ackerman', 'levi'],
  ['captain levi', 'levi'],
  ['captain levi ackerman', 'levi'],
  ['capitan levi', 'levi'],
  ['heichou', 'levi'],
  ['hange', 'hange'],
  ['hanji', 'hange'],
  ['hange zoe', 'hange'],
  ['hanji zoe', 'hange'],
  ['section commander hange', 'hange'],
  ['petra', 'petra'],
  ['petra ral', 'petra'],
  ['eren', 'eren'],
  ['eren yeager', 'eren'],
  ['eren jaeger', 'eren'],
  ['eren jager', 'eren'],
  ['mikasa', 'mikasa'],
  ['mikasa ackerman', 'mikasa'],
  ['armin', 'armin'],
  ['armin arlert', 'armin'],
  ['jean', 'jean'],
  ['jean kirstein', 'jean'],
  ['jean kirschtein', 'jean'],
  ['connie', 'connie'],
  ['connie springer', 'connie'],
  ['sasha', 'sasha'],
  ['sasha blouse', 'sasha'],
  ['sasha braus', 'sasha'],
  ['ymir', 'ymir'],
  ['historia', 'historia'],
  ['historia reiss', 'historia'],
  ['christa', 'historia'],
  ['christa lenz', 'historia'],
  ['krista', 'historia'],
  ['krista lenz', 'historia'],
  ['historia reiss / christa lenz', 'historia'],
  ['candy', 'candy'],
  ['joseph', 'joseph'],
  ['joseph alcott', 'joseph'],
  ['anya', 'anya'],
]);

export const VALIDATION_SCOPE_PREFLIGHT = 'deterministic_structural_preflight_only';
export const VALIDATION_LIMITATION_NOTE =
  'Prevalidación estructural/heurística determinista (0 tokens): detecta configuraciones e instrucciones contradictorias evidentes, pero NO garantiza cumplimiento semántico total en la prosa generada. La revisión semántica de prosa se integrará en el Hito 5.';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function normalizeTextKey(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * Determina si una historia está sujeta a los invariantes de Power to Strive.
 * Incluye variantes/crossovers explícitos de Power to Strive para que una etiqueta
 * crossover no pueda evadir los invariantes de sala, sin afectar jamás a fandoms
 * no relacionados ni ficción original.
 */
export function isPowerToStriveFandom(fandom) {
  const ns = normalizeFandomNamespace(fandom || NEUTRAL_FANDOM);
  return ns === PTS_FANDOM || /(?:^|[_-])power_to_strive(?:$|[_-])/.test(ns);
}

/**
 * Resuelve la identidad de un personaje de Power to Strive exclusivamente mediante:
 * 1) IDs namespaced explícitos (`power_to_strive::levi`), preservando namespaces ajenos
 *    (`otro_fandom::levi` nunca se colapsa en el `levi` de PtS),
 * 2) Nombres exactos normalizados y alias explícitos de PtS,
 * 3) Nombres/alias exactos registrados en `universalCharacters` del namespace PtS.
 * Si no coincide exactamente, devuelve una identidad preservada sin colisionar con PtS.
 */
export function resolvePtsCharacterId(rawNameOrId, { universalCharacters = [] } = {}) {
  const raw = cleanString(rawNameOrId);
  if (!raw) return '';

  if (raw.includes('::')) {
    const [rawNs, ...rest] = raw.split('::');
    const ns = normalizeFandomNamespace(rawNs);
    const logical = normalizeTextKey(rest.join('::'));
    if (isPowerToStriveFandom(ns)) {
      return PTS_EXACT_ALIASES.get(logical) || extractLogicalId(raw);
    }
    // Personaje perteneciente explícitamente a otro fandom: conservar namespace para no colisionar
    return `${ns}::${extractLogicalId(raw)}`;
  }

  const key = normalizeTextKey(raw);
  if (!key) return '';

  if (PTS_EXACT_ALIASES.has(key)) {
    return PTS_EXACT_ALIASES.get(key);
  }

  // Buscar coincidencia exacta por nombre o alias en el catálogo universal de Power to Strive
  for (const ch of (universalCharacters || [])) {
    if (!ch || !isPowerToStriveFandom(ch.fandom)) continue;
    const candidates = [
      ch.logicalId,
      extractLogicalId(ch.id),
      ch.name,
      ...(Array.isArray(ch.aliases) ? ch.aliases : []),
    ].map(normalizeTextKey).filter(Boolean);
    if (candidates.includes(key)) {
      const logical = extractLogicalId(ch.logicalId || ch.id);
      return PTS_EXACT_ALIASES.get(normalizeTextKey(logical)) || logical;
    }
  }

  // No coincide con ningún personaje conocido de PtS: devolver identificador limpio no colisionante
  return key;
}

/**
 * Normaliza una entrada de invitación a la sala de reacciones.
 * Soporta tanto formato heredado (string `'joseph'`) como objeto temporal:
 * `{ characterId: 'joseph', effectiveCheckpoint: 'after_s1', effectiveChapterOrder: 10, invitedAt, authorizedBy, note }`.
 */
export function normalizeRoomGuestInvitation(entry, { universalCharacters = [] } = {}) {
  if (typeof entry === 'string') {
    const charId = resolvePtsCharacterId(entry, { universalCharacters });
    if (!charId) return null;
    return {
      characterId: charId,
      rawInput: cleanString(entry),
      effectiveCheckpoint: '',
      effectiveChapterOrder: null,
      invitedAt: null,
      authorizedBy: 'author',
      note: '',
    };
  }
  if (!isPlainObject(entry)) return null;
  const rawChar = cleanString(entry.characterId || entry.id || entry.character || '');
  const charId = resolvePtsCharacterId(rawChar, { universalCharacters });
  if (!charId) return null;
  const rawOrder = entry.effectiveChapterOrder !== undefined && entry.effectiveChapterOrder !== null && entry.effectiveChapterOrder !== ''
    ? Number(entry.effectiveChapterOrder)
    : null;
  const effectiveChapterOrder = Number.isFinite(rawOrder) && rawOrder > 0 ? Math.floor(rawOrder) : null;
  return {
    characterId: charId,
    rawInput: rawChar,
    effectiveCheckpoint: cleanString(entry.effectiveCheckpoint || ''),
    effectiveChapterOrder,
    invitedAt: entry.invitedAt ? cleanString(entry.invitedAt) : null,
    authorizedBy: cleanString(entry.authorizedBy || 'author'),
    note: cleanString(entry.note || ''),
  };
}

export function normalizeRoomGuestInvitations(list, { universalCharacters = [] } = {}) {
  if (!Array.isArray(list)) return [];
  const byChar = new Map();
  for (const item of list) {
    const norm = normalizeRoomGuestInvitation(item, { universalCharacters });
    if (!norm) continue;
    byChar.set(norm.characterId, norm);
  }
  return [...byChar.values()];
}

/**
 * Evalúa si una invitación temporal ya es efectiva en el checkpoint y/o orden de capítulo actual.
 * Garantiza que un personaje invitado a partir de un checkpoint/capítulo posterior
 * NO aparezca retroactivamente en capítulos anteriores ni al reescribir capítulos previos.
 */
export function isInvitationEffectiveAt(invitation, { currentCheckpoint = '', chapterOrder = null } = {}) {
  if (!invitation) return false;
  const reqOrder = Number.isFinite(invitation.effectiveChapterOrder) ? invitation.effectiveChapterOrder : null;
  const curOrder = chapterOrder !== undefined && chapterOrder !== null && chapterOrder !== '' && Number.isFinite(Number(chapterOrder))
    ? Math.floor(Number(chapterOrder))
    : null;

  if (reqOrder !== null && curOrder !== null && curOrder < reqOrder) {
    return false;
  }

  const reqCp = cleanString(invitation.effectiveCheckpoint);
  const curCp = cleanString(currentCheckpoint);
  if (reqCp && curCp && Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, reqCp) && Object.prototype.hasOwnProperty.call(PTS_CHECKPOINT_ORDER, curCp)) {
    if (PTS_CHECKPOINT_ORDER[curCp] < PTS_CHECKPOINT_ORDER[reqCp]) {
      return false;
    }
  }

  // Si se fijó capítulo de llegada (p.ej. cap 10) pero no se pasó chapterOrder actual,
  // verificar si el checkpoint actual es anterior al checkpoint de llegada.
  // Si solo existe effectiveChapterOrder sin checkpoint y curOrder === null, considerar efectiva
  // solo si no contradice ningún checkpoint; pero si curOrder sí existe, ya se validó arriba.
  return true;
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
 * Prevalidación determinista/heurística por capas para texto/instrucciones en Power to Strive:
 * - Mencionar a Anya en diálogo de la sala o verla en pantalla/flashback ES LEGÍTIMO.
 * - Colocar a Anya como participante viva en la sala (entrada, portal, sueño, llamada,
 *   telepatía o proxy) se detecta como violación estructural crítica.
 * - LIMITACIÓN EXPLÍCITA: esta función es una prevalidación estructural/heurística (0 tokens)
 *   y NO garantiza cumplimiento semántico completo en prosa libre (reservado para Hito 5).
 */
export function validateLayerSafety({
  text = '',
  fandom = NEUTRAL_FANDOM,
  reactionMode = false,
  enabledOptional = [],
  roomGuestInvitations = [],
  currentCheckpoint = '',
  chapterOrder = null,
} = {}) {
  const issues = [];
  const meta = {
    validationScope: VALIDATION_SCOPE_PREFLIGHT,
    semanticReviewRequired: true,
    limitationNote: VALIDATION_LIMITATION_NOTE,
  };
  if (!isPowerToStriveFandom(fandom) || !reactionMode) {
    return { ok: true, issues, ...meta };
  }
  const source = cleanString(text);
  if (!source) return { ok: true, issues, ...meta };

  const sentences = source.split(/[\n.!?]+/).map((s) => s.trim()).filter(Boolean);
  const enabledSet = new Set(cleanStringArray(enabledOptional).map((x) => resolvePtsCharacterId(x)));
  const normalizedInvites = normalizeRoomGuestInvitations(roomGuestInvitations);
  const josephInvite = normalizedInvites.find((inv) => inv.characterId === 'joseph') || null;
  const josephEffective = josephInvite
    ? isInvitationEffectiveAt(josephInvite, { currentCheckpoint, chapterOrder })
    : false;

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
          validationScope: VALIDATION_SCOPE_PREFLIGHT,
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
            validationScope: VALIDATION_SCOPE_PREFLIGHT,
            message: 'Joseph está deshabilitado en esta historia y no puede entrar en la sala de reacciones.',
            evidence: sentence,
          });
        } else if (!josephInvite) {
          issues.push({
            id: 'joseph_uninvited_room_violation',
            level: 'critical',
            characterId: 'joseph',
            validationScope: VALIDATION_SCOPE_PREFLIGHT,
            message: 'Joseph está habilitado fuera de la sala, pero todavía NO tiene una invitación explícita autorizada para entrar a la sala de reacciones.',
            evidence: sentence,
          });
        } else if (!josephEffective) {
          issues.push({
            id: 'joseph_before_arrival_violation',
            level: 'critical',
            characterId: 'joseph',
            validationScope: VALIDATION_SCOPE_PREFLIGHT,
            message: 'Joseph tiene invitación a la sala, pero aún NO es efectiva en el checkpoint/capítulo actual; no puede participar antes de su llegada.',
            evidence: sentence,
          });
        }
      }
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'critical'),
    issues,
    ...meta,
  };
}

/**
 * Construye un payload estructurado listo para que el auditor semántico del Hito 5
 * verifique prosa generada contra las reglas deterministas activas de esta historia.
 */
export function buildSemanticReviewPayload(resolvedConfig) {
  if (!resolvedConfig) return null;
  return {
    schemaVersion: 1,
    fandom: resolvedConfig.fandom,
    isPowerToStrive: resolvedConfig.isPowerToStrive,
    reactionMode: resolvedConfig.reactionMode,
    currentCheckpoint: resolvedConfig.currentCheckpoint || resolvedConfig.checkpointId || '',
    chapterOrder: resolvedConfig.chapterOrder ?? null,
    allowedRoomCast: [...(resolvedConfig.allowedRoomCast || [])],
    facilitatorId: resolvedConfig.facilitator?.id || null,
    forbiddenLiveRoomCharacters: resolvedConfig.isPowerToStrive && resolvedConfig.reactionMode
      ? ['anya', ...(resolvedConfig.josephStatus !== 'invited_room_guest' ? ['joseph'] : [])]
      : [],
    knowledgeBarriers: structuredClone(resolvedConfig.knowledgeBarriers || []),
    activeOverlays: (resolvedConfig.activeOverlays || []).map((o) => ({
      overlayId: o.overlayId,
      characterId: o.characterId,
      scope: o.scope,
      characterVersion: o.characterVersion,
      sceneId: o.sceneId || null,
    })),
    preflightScope: VALIDATION_SCOPE_PREFLIGHT,
  };
}

/**
 * Resolvedor determinista y gratuito (0 tokens) de universo, reparto, relaciones,
 * invitaciones temporales, overlays y contradicciones.
 * Será la entrada directa del Context Engine y del auditor semántico del Hito 5.
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
  const isPts = isPowerToStriveFandom(fandom);
  const reactionMode = typeof storyConfig?.reactionMode === 'boolean' ? storyConfig.reactionMode : isPts;
  const currentCheckpoint = cleanString(context?.currentCheckpoint || storyConfig?.checkpointId || '');
  const chapterOrder = context?.chapterOrder !== undefined && context?.chapterOrder !== null && context?.chapterOrder !== ''
    && Number.isFinite(Number(context.chapterOrder))
    ? Math.floor(Number(context.chapterOrder))
    : null;

  const contradictions = [];
  const warnings = [];
  const knowledgeBarriers = [];

  const enabledOptional = cleanStringArray(storyConfig?.enabledOptionalCharacters || [])
    .map((x) => (isPts ? resolvePtsCharacterId(x, { universalCharacters }) : extractLogicalId(x)));
  const enabledOptionalSet = new Set(enabledOptional);
  const normalizedInvitations = normalizeRoomGuestInvitations(storyConfig?.roomGuestInvitations || [], { universalCharacters });
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
  const screenCast = [...rawScreenCast];
  const outsideCast = [...rawOutsideCast];
  let josephStatus = 'not_applicable';
  let josephInvitation = null;
  let anyaStatus = 'not_applicable';
  let relationshipSummary = {};

  if (isPts) {
    // --- Reglas estructurales estrictas de Power to Strive ---
    facilitator = reactionMode ? { ...PTS_FACILITATOR } : null;

    const resolvePts = (name) => resolvePtsCharacterId(name, { universalCharacters });
    const resolvedRoomEntries = rawRoomCast.map((rawName) => ({ rawName, id: resolvePts(rawName) }));
    const resolvedScreenIds = rawScreenCast.map(resolvePts);
    const resolvedOutsideIds = rawOutsideCast.map(resolvePts);

    // 1. Anya: deshabilitada por defecto; JAMÁS entra en sala
    const anyaEnabled = enabledOptionalSet.has('anya');
    const anyaInInvitations = normalizedInvitations.some((inv) => inv.characterId === 'anya');
    const anyaInRawRoom = resolvedRoomEntries.some((entry) => entry.id === 'anya');
    if (anyaInInvitations || anyaInRawRoom) {
      contradictions.push({
        id: 'anya_room_entry_forbidden',
        level: 'critical',
        characterId: 'anya',
        message: 'Anya tiene prohibida la entrada o participación en vivo en la sala de reacciones bajo cualquier circunstancia. Fue excluida automáticamente del reparto permitido de la sala.',
      });
    }
    if (!anyaEnabled && (resolvedScreenIds.includes('anya') || resolvedOutsideIds.includes('anya'))) {
      contradictions.push({
        id: 'anya_disabled_but_cast',
        level: 'critical',
        characterId: 'anya',
        message: 'Anya aparece en pantalla o escenas exteriores, pero está deshabilitada en los personajes opcionales de esta historia.',
      });
    }
    anyaStatus = anyaEnabled ? 'enabled_outside_and_screen_only' : 'disabled';

    // 2. Joseph: deshabilitado por defecto; entra a sala SOLO tras invitación explícita Y llegada efectiva
    const josephEnabled = enabledOptionalSet.has('joseph');
    josephInvitation = normalizedInvitations.find((inv) => inv.characterId === 'joseph') || null;
    const josephInvited = Boolean(josephInvitation);
    const josephEffective = josephInvited && isInvitationEffectiveAt(josephInvitation, { currentCheckpoint, chapterOrder });
    const josephInRawRoom = resolvedRoomEntries.some((entry) => entry.id === 'joseph');

    if (!josephEnabled && (josephInvited || josephInRawRoom || resolvedScreenIds.includes('joseph') || resolvedOutsideIds.includes('joseph'))) {
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
    if (josephEnabled && josephInvited && !josephEffective) {
      josephStatus = 'invited_not_yet_arrived';
      const arrivalDesc = [
        josephInvitation.effectiveCheckpoint ? `checkpoint=${josephInvitation.effectiveCheckpoint}` : '',
        josephInvitation.effectiveChapterOrder ? `capítulo >= ${josephInvitation.effectiveChapterOrder}` : '',
      ].filter(Boolean).join(', ');
      if (josephInRawRoom) {
        contradictions.push({
          id: 'joseph_before_arrival_checkpoint',
          level: 'critical',
          characterId: 'joseph',
          message: `Joseph tiene invitación a la sala a partir de (${arrivalDesc}), pero el punto narrativo actual es anterior a su llegada. Los capítulos anteriores y sus reescrituras deben conservar los 12 espectadores originales.`,
        });
      }
      knowledgeBarriers.push({
        characterId: 'joseph',
        rule: 'not_yet_arrived_in_room',
        effectiveCheckpoint: josephInvitation.effectiveCheckpoint || '',
        effectiveChapterOrder: josephInvitation.effectiveChapterOrder ?? null,
        message: `Joseph está autorizado a llegar más adelante (${arrivalDesc}), pero todavía NO está en la sala en este punto de la historia.`,
      });
    } else if (josephEnabled && josephInvited && josephEffective) {
      josephStatus = 'invited_room_guest';
      knowledgeBarriers.push({
        characterId: 'joseph',
        rule: 'no_automatic_prior_episode_knowledge',
        effectiveCheckpoint: josephInvitation.effectiveCheckpoint || '',
        effectiveChapterOrder: josephInvitation.effectiveChapterOrder ?? null,
        message: 'Joseph entra como 13.º espectador por invitación explícita, pero NO hereda automáticamente el conocimiento de episodios vistos antes de su llegada.',
      });
    } else if (josephEnabled) {
      josephStatus = 'enabled_outside_uninvited';
    } else {
      josephStatus = 'disabled';
    }

    // 3. Aplicación ESTRICTA del reparto permitido en sala de reacciones de Power to Strive:
    //    - Únicamente los 12 espectadores originales por defecto.
    //    - Joseph es el ÚNICO invitado opcional autorizado (si está habilitado, invitado y efectivo).
    //    - Candy es facilitadora, nunca espectadora ordinaria.
    //    - Cualquier invitado o espectador desconocido/no autorizado produce contradicción CRÍTICA
    //      y queda estructuralmente excluido de `allowedRoomCast`.
    if (reactionMode) {
      const unauthorizedInvitations = normalizedInvitations.filter(
        (inv) => inv.characterId !== 'joseph' && inv.characterId !== 'anya'
      );
      for (const badInv of unauthorizedInvitations) {
        if (badInv.characterId === 'candy') {
          contradictions.push({
            id: 'candy_facilitator_not_spectator',
            level: 'critical',
            characterId: 'candy',
            message: 'Candy es la facilitadora de la sala de reacciones, no una invitada/espectadora ordinaria.',
          });
        } else if (!PTS_DEFAULT_TWELVE_SET.has(badInv.characterId)) {
          contradictions.push({
            id: 'unauthorized_room_guest_invitation',
            level: 'critical',
            characterId: badInv.characterId,
            message: `Invitado no autorizado en la sala de Power to Strive: «${badInv.rawInput || badInv.characterId}». Solo los 12 originales son espectadores base y Joseph es el único invitado opcional autorizado.`,
          });
        }
      }

      const validManualRoom = [];
      for (const entry of resolvedRoomEntries) {
        if (entry.id === 'anya' || entry.id === 'joseph') {
          // Ya validados específicamente arriba
          if (entry.id === 'joseph' && josephEnabled && josephEffective) validManualRoom.push('joseph');
          continue;
        }
        if (entry.id === 'candy') {
          contradictions.push({
            id: 'candy_facilitator_not_spectator',
            level: 'critical',
            characterId: 'candy',
            message: 'Candy es la facilitadora de la sala y no debe colocarse en el reparto de espectadores ordinarios. Fue excluida del reparto de espectadores.',
          });
          continue;
        }
        if (PTS_DEFAULT_TWELVE_SET.has(entry.id)) {
          validManualRoom.push(entry.id);
        } else {
          contradictions.push({
            id: 'unauthorized_room_spectator',
            level: 'critical',
            characterId: entry.id,
            message: `Espectador no autorizado o desconocido en la sala de Power to Strive: «${entry.rawName}». En historias de reacción de PtS solo se permiten los 12 espectadores originales (y Joseph tras invitación efectiva). Fue excluido de la sala permitida.`,
          });
        }
      }

      const roomSet = new Set(validManualRoom.length ? validManualRoom : PTS_DEFAULT_TWELVE);
      if (josephEnabled && josephEffective) roomSet.add('joseph');
      else roomSet.delete('joseph');
      roomSet.delete('anya');
      roomSet.delete('candy');
      allowedRoomCast = [...roomSet];
    } else {
      allowedRoomCast = resolvedRoomEntries
        .map((e) => e.id)
        .filter((cid) => cid !== 'anya' || anyaEnabled);
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

  // Prevalidación determinista/heurística por capas de premisa y reglas de la historia
  const layerValidation = validateLayerSafety({
    text: [storyConfig?.premise || '', ...(storyConfig?.storyRules || [])].join('\n'),
    fandom,
    reactionMode,
    enabledOptional,
    roomGuestInvitations: normalizedInvitations,
    currentCheckpoint,
    chapterOrder,
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

  const result = {
    fandom,
    isPowerToStrive: isPts,
    presetId: storyConfig?.presetId || null,
    universeName: cleanString(storyConfig?.universeName || ''),
    premise: cleanString(storyConfig?.premise || ''),
    checkpointId: cleanString(storyConfig?.checkpointId || ''),
    currentCheckpoint,
    chapterOrder,
    reactionMode,
    facilitator,
    allowedRoomCast,
    allowedRoomCastLabels: allowedRoomCast.map((id) => PTS_DISPLAY_NAMES[id] || id),
    screenCast,
    outsideCast,
    enabledOptionalCharacters: enabledOptional,
    inactiveOptionalCharacters: roster.inactiveOptionalCharacters,
    roomGuestInvitations: normalizedInvitations,
    josephStatus,
    josephInvitation,
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
    validationScope: VALIDATION_SCOPE_PREFLIGHT,
    semanticReviewRequired: true,
    validationLimitationNote: VALIDATION_LIMITATION_NOTE,
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
        'Auditoría semántica de prosa generada (Hito 5)',
        'Extracción automática de propuestas desde SOS Ideas (Hito 4/5)',
      ],
    },
  };
  result.semanticReviewPayload = buildSemanticReviewPayload(result);
  return result;
}
