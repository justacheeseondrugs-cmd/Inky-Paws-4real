// creativeChat.js — Espacio conversacional persistente por historia (Chat Creativo),
// recuperación acotada de historial, extractor de propuestas en lenguaje natural con
// aprobación selectiva elemento por elemento, manejo de negaciones/correcciones y
// flujo completo hacia Brief de Capítulo aprobado (0 tokens en modo local).
//
// Reglas no negociables:
// - Explorar ideas en el chat JAMÁS modifica el canon, `storyConfigs` ni `knowledgeFacts`
//   hasta que la autora aprueba explícitamente elementos individuales.
// - Nunca autoriza automáticamente la entrada de Joseph a la sala, ni habilita a Anya,
//   ni hace pública una relación secreta.
// - Nunca envía el historial completo del chat en cada solicitud: usa recuperación acotada.

import { db } from './db.js';
import { normalizeFandomNamespace, extractLogicalId } from './characterLibrary.js';
import { createDefaultStoryConfig, getStoryConfig, saveStoryConfig } from './storyConfigSchema.js';
import {
  listKnowledgeFacts,
  saveKnowledgeFact,
  appendBeliefTransitionToFact,
  makeCharacterVersionKey,
} from './knowledgeLedger.js';
import { tokenizeForBm25 } from './lexicalIndex.js';

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

// ---------------------------------------------------------------------------
// 1. Conversaciones persistentes independientes por historia + recuperación acotada
// ---------------------------------------------------------------------------

export function makeCreativeChatId(projectId) {
  return `chat::${cleanString(projectId) || db.getActiveProjectId()}`;
}

export async function getCreativeChat(projectId = '') {
  const pid = cleanString(projectId) || db.getActiveProjectId();
  const scope = { projectId: pid };
  const id = makeCreativeChatId(pid);
  const existing = await db.get('creativeChats', id, scope);
  if (existing) return existing;

  // Compatibilidad transparente con conversaciones heredadas en settings['planner-chat:' + pid]
  const legacy = await db.get('settings', `planner-chat:${pid}`).catch(() => null);
  const legacyMessages = Array.isArray(legacy?.messages)
    ? legacy.messages
        .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m?.text === 'string')
        .map((m) => ({
          id: db.uid(),
          role: m.role,
          text: m.text,
          createdAt: m.createdAt || legacy.updatedAt || new Date().toISOString(),
        }))
    : [];

  return {
    id,
    projectId: pid,
    messages: legacyMessages,
    rollingSummary: '',
    pendingProposals: [],
    archivedIdeas: [],
    createdAt: new Date().toISOString(),
    updatedAt: legacy?.updatedAt || new Date().toISOString(),
  };
}

export async function saveCreativeChat(chatRecord, { projectId = '' } = {}) {
  const pid = cleanString(projectId || chatRecord?.projectId) || db.getActiveProjectId();
  const scope = { projectId: pid };
  const now = new Date().toISOString();
  const record = {
    id: makeCreativeChatId(pid),
    projectId: pid,
    messages: Array.isArray(chatRecord?.messages) ? chatRecord.messages : [],
    rollingSummary: cleanString(chatRecord?.rollingSummary || ''),
    pendingProposals: Array.isArray(chatRecord?.pendingProposals) ? chatRecord.pendingProposals : [],
    archivedIdeas: Array.isArray(chatRecord?.archivedIdeas) ? chatRecord.archivedIdeas : [],
    createdAt: chatRecord?.createdAt || now,
    updatedAt: now,
  };
  return db.put('creativeChats', record, scope);
}

export async function appendCreativeChatMessage(projectId, { role, text, meta = {} }) {
  const chat = await getCreativeChat(projectId);
  const msg = {
    id: db.uid(),
    role: role === 'assistant' ? 'assistant' : 'user',
    text: String(text || ''),
    meta: isPlainObject(meta) ? structuredClone(meta) : {},
    createdAt: new Date().toISOString(),
  };
  const messages = [...(chat.messages || []), msg];
  const rollingSummary = buildRollingChatSummary(messages.slice(0, Math.max(0, messages.length - 6)), 1600);
  return saveCreativeChat({ ...chat, messages, rollingSummary }, { projectId: chat.projectId });
}

export function buildRollingChatSummary(olderMessages = [], maxChars = 1600) {
  if (!Array.isArray(olderMessages) || !olderMessages.length) return '';
  const lines = [];
  let used = 0;
  for (let i = olderMessages.length - 1; i >= 0; i -= 1) {
    const m = olderMessages[i];
    if (!m?.text) continue;
    const prefix = m.role === 'user' ? 'Autora' : 'Inky';
    const compact = cleanString(m.text).replace(/\s+/g, ' ').slice(0, 180);
    const line = `- ${prefix}: ${compact}`;
    if (used + line.length + 1 > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Construye una ventana acotada del historial de chat para enviar al modelo sin
 * mandar nunca la conversación entera en cada turno.
 */
export function buildBoundedChatContext(messages = [], {
  query = '',
  maxRecentTurns = 6,
  maxSummaryChars = 1400,
  maxTotalChars = 5500,
} = {}) {
  const all = (messages || []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
  const recent = all.slice(-maxRecentTurns);
  const older = all.slice(0, Math.max(0, all.length - maxRecentTurns));

  // Recuperación léxica acotada de turnos antiguos relevantes para la pregunta actual
  const qTokens = new Set(tokenizeForBm25(query));
  const relevantOlder = [];
  if (qTokens.size && older.length) {
    const scored = older.map((m, idx) => {
      const mTokens = tokenizeForBm25(m.text);
      let hits = 0;
      const seen = new Set();
      for (const t of mTokens) {
        if (!seen.has(t) && qTokens.has(t)) {
          seen.add(t);
          hits += 1;
        }
      }
      return { m, idx, hits };
    }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits || b.idx - a.idx).slice(0, 3);
    for (const s of scored) {
      relevantOlder.push({
        role: s.m.role,
        text: cleanString(s.m.text).slice(0, 360),
        turnIndex: s.idx,
        matchedScore: s.hits,
      });
    }
  }

  const summary = buildRollingChatSummary(older, maxSummaryChars);
  const boundedRecent = [];
  let charCount = summary.length + relevantOlder.reduce((acc, x) => acc + x.text.length, 0);

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i];
    const remaining = maxTotalChars - charCount;
    if (remaining <= 120) break;
    const text = cleanString(m.text).slice(0, Math.min(1200, remaining));
    boundedRecent.unshift({ role: m.role, text });
    charCount += text.length;
  }

  return {
    totalStoredMessages: all.length,
    omittedOlderCount: Math.max(0, older.length - relevantOlder.length),
    rollingSummary: summary,
    relevantOlderMessages: relevantOlder,
    recentMessages: boundedRecent,
    totalChars: charCount,
    withinBudget: charCount <= maxTotalChars,
  };
}

// ---------------------------------------------------------------------------
// 2. Extractor de propuestas en lenguaje natural + aprobación selectiva
// ---------------------------------------------------------------------------

const KNOWN_PTS_CHARS = ['erwin', 'levi', 'hange', 'hanji', 'petra', 'eren', 'mikasa', 'armin', 'jean', 'connie', 'sasha', 'ymir', 'historia', 'joseph', 'anya'];

function normalizeCharName(raw) {
  const low = cleanString(raw).toLowerCase();
  if (low === 'hanji') return 'hange';
  return extractLogicalId(low);
}

/**
 * Analiza un mensaje informal/entusiasta (EN o ES) y extrae una propuesta estructurada
 * dividida en ítems editables e individualmente aprobables (`items[]`).
 *
 * - 0 llamadas de pago en modo local determinista.
 * - Soporta opcionalmente `extractorProvider` (mocked en desarrollo o explícito por la autora).
 * - JAMÁS aplica cambios automáticamente, JAMÁS invita a Joseph a la sala sin orden explícita,
 *   JAMÁS habilita a Anya por implicación ni propone entrada de Anya a la sala.
 */
export async function extractConversationalProposal(rawMessage, {
  storyConfig = null,
  fandom = '',
  extractorProvider = null,
} = {}) {
  const text = cleanString(rawMessage);
  if (!text) throw new Error('Escribe primero un mensaje para extraer propuestas.');
  const resolvedFandom = normalizeFandomNamespace(fandom || storyConfig?.fandom || 'power_to_strive');
  const isConditional = /\b(what\s+if|maybe|perhaps|could\s+we|what\s+about|idea|qu[eé]\s+tal\s+si|y\s+si|tal\s+vez|quiz[aá]s|podr[ií]amos)\b/i.test(text);

  // Opción de extractor IA inyectable (mocked en pruebas; jamás se invoca en segundo plano)
  if (extractorProvider && typeof extractorProvider.extractProposal === 'function') {
    const external = await extractorProvider.extractProposal({ message: text, fandom: resolvedFandom, storyConfig });
    return enforceProposalSafetyInvariants({
      id: cleanString(external?.id) || db.uid(),
      sourceMessage: text,
      fandom: resolvedFandom,
      isConditional: Boolean(external?.isConditional ?? isConditional),
      items: Array.isArray(external?.items) ? external.items : [],
      safetyBlocks: Array.isArray(external?.safetyBlocks) ? external.safetyBlocks : [],
      status: 'proposed',
      createdAt: new Date().toISOString(),
    });
  }

  const items = [];
  const safetyBlocks = [];
  const low = text.toLowerCase();

  // 1. Detectar intento prohibido de meter a Anya en la sala (evaluado frase por frase)
  if (resolvedFandom === 'power_to_strive') {
    const sentences = text.split(/[\n.!?]+/).map((s) => s.trim()).filter(Boolean);
    const hasAnyaRoomAttempt = sentences.some((s) =>
      /\banya\b/i.test(s) &&
      /\b(room|sala|enter(?:s|ed|ing)?|entra(?:r|ndo)?|join(?:s|ed|ing)?|invite|invita|portal|dream)\b/i.test(s) &&
      !/\b(no\s+anya|sin\s+anya|never\s+in\s+the\s+room|nunca\s+en\s+la\s+sala|not\s+in\s+the\s+room)\b/i.test(s)
    );
    if (hasAnyaRoomAttempt) {
      safetyBlocks.push({
        code: 'anya_room_entry_blocked',
        message: 'Bloqueado automáticamente: Anya NUNCA puede entrar ni participar en vivo en la sala de reacciones en Power to Strive.',
      });
    }
  }

  // 2. Negaciones / desactivaciones explícitas de overlays (p.ej. "no Violet traits this time!")
  if (/\b(?:no|without|sin|disable|remove|quitar|desactivar|not|forget)\s+(?:any\s+|los\s+)?(?:levi'?s?\s+)?violet(?:\s+traits|\s+rasgos|\s+overlay|\s+au)?\b/i.test(text)) {
    items.push({
      itemId: db.uid(),
      kind: 'overlay_disable',
      label: 'Desactivar overlay Violet Traits para Levi',
      summary: 'Mantiene a Levi en su caracterización estándar por defecto para esta historia (desactiva `levi_violet_traits`).',
      payload: {
        overlayOps: { disable: ['levi_violet_traits'] },
      },
      status: 'proposed',
      safetyNotes: ['Solo afecta a esta historia; no borra la plantilla en Character Lab.'],
    });
  } else if (/\b(?:enable|activate|use|add|activar|usar)\s+(?:levi'?s?\s+)?violet\s+(?:traits|rasgos|overlay)\b/i.test(text)) {
    items.push({
      itemId: db.uid(),
      kind: 'overlay_enable',
      label: 'Autorizar overlay Violet Traits para Levi (si tiene rasgos configurados)',
      summary: 'Activa el overlay `levi_violet_traits` en esta historia (sin inventar rasgos si sigue vacío).',
      payload: {
        overlayOps: {
          add: [{
            overlayId: 'power_to_strive::levi_violet_traits',
            overlayLogicalId: 'levi_violet_traits',
            characterId: 'levi',
            scope: 'story',
            characterVersion: 'all',
            enabled: true,
          }],
        },
      },
      status: 'proposed',
      safetyNotes: ['Requiere aprobación explícita; si el overlay no tiene rasgos definidos, Levi permanece estándar.'],
    });
  }

  // 3. Relación Eruri (former_lovers / secret_relationship / established / mutual_pining + privacidad por defecto)
  let detectedEruriState = null;
  let eruriSummary = '';
  const mentionsEruri = /\beruri\b/i.test(text) || (/\berwin\b/i.test(text) && /\blevi\b/i.test(text));
  if (mentionsEruri) {
    if (/\b(used\s+to\s+date|ex[\s-]?lovers|former\s+lovers|dated\s+before|ex\s+amantes|sal[ií]an\s+antes|fueron\s+pareja|estuvieron\s+juntos\s+antes)\b/i.test(text)) {
      detectedEruriState = 'former_lovers';
      eruriSummary = 'Estado Eruri: ex amantes con afecto continuo (`former_lovers`), mantenido en privado por defecto.';
    } else if (/\b(secret\s+relationship|secretly\s+dating|secretly\s+together|relaci[oó]n\s+secreta|salen\s+en\s+secreto)\b/i.test(text)) {
      detectedEruriState = 'secret_relationship';
      eruriSummary = 'Estado Eruri: relación secreta (`secret_relationship`), no conocida públicamente.';
    } else if (/\b(established\s+relationship|already\s+together|pareja\s+establecida|ya\s+son\s+pareja)\b/i.test(text)) {
      detectedEruriState = 'established_relationship';
      eruriSummary = 'Estado Eruri: relación establecida (`established_relationship`).';
    } else if (/\b(mutual\s+pining|anhelo\s+mutuo|unspoken)\b/i.test(text)) {
      detectedEruriState = 'mutual_pining';
      eruriSummary = 'Estado Eruri: anhelo mutuo (`mutual_pining`).';
    }
  }

  const explicitlyPublic = /\b(everyone\s+knows|publicly\s+known|todos\s+lo\s+saben|relaci[oó]n\s+p[uú]blica)\b/i.test(text) &&
    !/\b(not\s+publicly|nobody\s+else|nadie\s+m[aá]s|secret|secreto)\b/i.test(text);

  if (detectedEruriState) {
    items.push({
      itemId: db.uid(),
      kind: 'relationship_state',
      label: `Configurar historia Eruri: ${detectedEruriState}`,
      summary: eruriSummary,
      payload: {
        relationshipOps: {
          set: {
            eruri: {
              state: detectedEruriState,
              publiclyKnown: explicitlyPublic,
              knownBy: ['erwin', 'levi'],
              suspectedBy: [],
              historyNote: `Propuesto desde Chat Creativo: ${text.slice(0, 180)}`,
            },
          },
        },
      },
      status: 'proposed',
      safetyNotes: explicitlyPublic
        ? ['La autora indicó conocimiento público explícito.']
        : ['Se mantiene `publiclyKnown: false`: la sala NO descubre la relación automáticamente.'],
    });
  }

  // 4. Personajes opcionales (Joseph / Anya) respetando negaciones y correcciones
  const negateJoseph = /\b(?:no|without|sin|forget|cancel|remove|quitar|desactivar|mejor\s+sin)\s+joseph\b/i.test(text);
  const mentionJoseph = /\bjoseph\b/i.test(text);
  if (negateJoseph) {
    items.push({
      itemId: db.uid(),
      kind: 'optional_character_disable',
      label: 'Desactivar a Joseph (y revocar invitación si existía)',
      summary: 'Quita a Joseph de los personajes opcionales de esta historia.',
      payload: {
        optionalCharacterOps: { disable: ['joseph'] },
        guestInvitationOps: { revoke: ['joseph'] },
      },
      status: 'proposed',
      safetyNotes: ['Solo aplica si lo apruebas.'],
    });
  } else if (mentionJoseph) {
    items.push({
      itemId: db.uid(),
      kind: 'optional_character_enable',
      label: 'Habilitar a Joseph Alcott (fuera de sala por defecto)',
      summary: 'Activa a Joseph como personaje opcional en esta historia SIN autorizar automáticamente su entrada a la sala ni habilitar a Anya.',
      payload: {
        optionalCharacterOps: { enable: ['joseph'] },
      },
      status: 'proposed',
      safetyNotes: [
        'NO autoriza la entrada de Joseph a la sala de reacciones (requiere invitación temporal aparte).',
        'NO habilita a Anya ni activa matrimonio.',
      ],
    });
  }

  const negateAnya = /\b(?:no|without|sin|forget|cancel|remove|quitar|desactivar|mejor\s+sin)\s+anya\b/i.test(text);
  const enableAnyaExplicit = /\b(?:enable|add|include|habilitar|incluir|activar)\s+anya\b/i.test(text);
  if (negateAnya) {
    items.push({
      itemId: db.uid(),
      kind: 'optional_character_disable',
      label: 'Mantener a Anya deshabilitada',
      summary: 'Desactiva a Anya en esta historia.',
      payload: { optionalCharacterOps: { disable: ['anya'] } },
      status: 'proposed',
      safetyNotes: [],
    });
  } else if (enableAnyaExplicit) {
    items.push({
      itemId: db.uid(),
      kind: 'optional_character_enable',
      label: 'Habilitar a Anya (solo pantalla / exterior · NUNCA sala)',
      summary: 'Activa a Anya únicamente para pantalla, flashbacks o escenas exteriores.',
      payload: { optionalCharacterOps: { enable: ['anya'] } },
      status: 'proposed',
      safetyNotes: ['Anya JAMÁS puede entrar ni participar en vivo en la sala de reacciones.'],
    });
  }

  // 5. Conocimiento privado individual (p.ej. "Joseph knows Erwin and Levi used to date")
  const knowMatch = text.match(/\b(joseph|hange|hanji|erwin|levi|petra|eren|mikasa|armin|jean|ymir|historia)\s+(?:knows?|found\s+out|discovered|sabe|descubri[oó])\s+(?:that\s+|que\s+)?([^.!?;]+)/i);
  if (knowMatch && !negateJoseph) {
    const charId = normalizeCharName(knowMatch[1]);
    const clause = cleanString(knowMatch[2]).replace(/\b(?:but|pero)\b[\s\S]*$/i, '').trim();
    if (charId && clause) {
      items.push({
        itemId: db.uid(),
        kind: 'epistemic_knowledge',
        label: `Conocimiento privado de ${charId}: sabe «${clause.slice(0, 64)}»`,
        summary: `Registra en el libro epistémico que ${charId} conoce este dato de forma privada (sin revelarlo automáticamente a otros personajes).`,
        payload: {
          factTitle: detectedEruriState ? 'Historia privada Eruri' : `Dato privado (${charId})`,
          factTruth: detectedEruriState === 'former_lovers'
            ? 'Erwin and Levi used to date in the past.'
            : clause,
          characterId: charId,
          characterVersion: charId === 'joseph' ? 'outside' : 'room',
          state: 'knows',
          beliefText: clause,
          evidence: 'Propuesto en Chat Creativo (pendiente de asignar escena/capítulo).',
          isSecret: true,
        },
        status: 'proposed',
        safetyNotes: ['Se guarda como secreto individual: el resto de la sala sigue sin saberlo.'],
      });
    }
  }

  // 6. Creencia falsa / interpretación errónea (p.ej. "but Hange thinks something completely different")
  const falseBeliefMatch = text.match(/\b(hange|hanji|eren|mikasa|armin|jean|connie|sasha|petra|ymir|historia|joseph)\s+(?:thinks?|believes?|assumes?|cree|piensa|asume)\s+([^.!?;]+)/i);
  if (falseBeliefMatch) {
    const charId = normalizeCharName(falseBeliefMatch[1]);
    const rawBelief = cleanString(falseBeliefMatch[2]).replace(/\b(?:hahaha+|jaja+|lol|lmao)\b/gi, '').trim();
    if (charId && rawBelief) {
      items.push({
        itemId: db.uid(),
        kind: 'epistemic_false_belief',
        label: `Falsa creencia de ${charId}: «${rawBelief.slice(0, 64)}»`,
        summary: `Registra que ${charId} sostiene una interpretación incorrecta/diferente sin alterar la verdad objetiva del canon.`,
        payload: {
          factTitle: detectedEruriState ? 'Historia privada Eruri' : `Creencia errónea (${charId})`,
          factTruth: detectedEruriState === 'former_lovers'
            ? 'Erwin and Levi used to date in the past.'
            : 'Verdad objetiva separada de la suposición errónea del personaje.',
          characterId: charId,
          characterVersion: 'room',
          state: 'believes_false',
          beliefText: rawBelief,
          evidence: 'Suposición errónea propuesta desde Chat Creativo.',
          isSecret: true,
        },
        status: 'proposed',
        safetyNotes: ['Las falsas creencias NUNCA modifican la verdad objetiva del canon.'],
      });
    }
  }

  // 7. Idea narrativa condicional / evento posible (nunca canon automático)
  if (isConditional || !items.length) {
    items.push({
      itemId: db.uid(),
      kind: 'possible_idea',
      label: 'Guardar como idea posible de trama (sin aplicar al canon)',
      summary: `Idea exploratoria para considerar en un futuro Brief de Capítulo: «${text.slice(0, 140)}»`,
      payload: {
        ideaText: text,
      },
      status: 'proposed',
      safetyNotes: ['Las ideas posibles no alteran el canon ni la configuración de la historia.'],
    });
  }

  return enforceProposalSafetyInvariants({
    id: db.uid(),
    sourceMessage: text,
    fandom: resolvedFandom,
    isConditional,
    items,
    safetyBlocks,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  });
}

function enforceProposalSafetyInvariants(proposal) {
  const safeItems = [];
  const safetyBlocks = [...(proposal.safetyBlocks || [])];
  const isPts = proposal.fandom === 'power_to_strive' || /(?:^|[_-])power_to_strive(?:$|[_-])/.test(proposal.fandom || '');

  for (const item of (proposal.items || [])) {
    if (isPts) {
      // Nunca permitir que una propuesta automática meta a Anya en invitaciones de sala
      const invites = item?.payload?.guestInvitationOps?.invite || [];
      if (invites.some((x) => extractLogicalId(typeof x === 'string' ? x : x?.characterId) === 'anya')) {
        safetyBlocks.push({
          code: 'anya_room_invitation_stripped',
          message: 'Se bloqueó una invitación de sala para Anya (regla no negociable de Power to Strive).',
        });
        continue;
      }
    }
    safeItems.push({
      itemId: cleanString(item.itemId) || db.uid(),
      kind: cleanString(item.kind || 'possible_idea'),
      label: cleanString(item.label || 'Cambio propuesto'),
      summary: cleanString(item.summary || ''),
      payload: isPlainObject(item.payload) ? structuredClone(item.payload) : {},
      status: ['proposed', 'approved', 'rejected'].includes(item.status) ? item.status : 'proposed',
      safetyNotes: cleanStringArray(item.safetyNotes || []),
    });
  }
  return {
    ...proposal,
    items: safeItems,
    safetyBlocks,
  };
}

/**
 * Aplica de forma SELECTIVA únicamente los ítems que la autora aprobó explícitamente.
 * Los ítems rechazados quedan marcados como `rejected` y JAMÁS tocan el canon ni `storyConfigs`.
 */
export async function applySelectiveProposalDecision(projectId, proposal, {
  approvedItemIds = [],
  rejectedItemIds = [],
  editedPayloads = {},
} = {}) {
  const pid = cleanString(projectId) || db.getActiveProjectId();
  const approvedSet = new Set(approvedItemIds || []);
  const rejectedSet = new Set(rejectedItemIds || []);

  let config = (await getStoryConfig(pid)) || createDefaultStoryConfig(pid, { fandom: proposal?.fandom || 'neutral' });
  let configDirty = false;
  const appliedFacts = [];
  const savedIdeas = [];
  const updatedItems = [];

  for (const item of (proposal?.items || [])) {
    if (rejectedSet.has(item.itemId) && !approvedSet.has(item.itemId)) {
      updatedItems.push({ ...item, status: 'rejected' });
      continue;
    }
    if (!approvedSet.has(item.itemId)) {
      updatedItems.push({ ...item });
      continue;
    }

    const payload = isPlainObject(editedPayloads[item.itemId])
      ? { ...item.payload, ...editedPayloads[item.itemId] }
      : (item.payload || {});

    if (item.kind === 'relationship_state' && isPlainObject(payload.relationshipOps?.set)) {
      config.relationshipStates = {
        ...(config.relationshipStates || {}),
        ...structuredClone(payload.relationshipOps.set),
      };
      configDirty = true;
    } else if (item.kind === 'optional_character_enable' && Array.isArray(payload.optionalCharacterOps?.enable)) {
      const next = new Set((config.enabledOptionalCharacters || []).map(extractLogicalId));
      for (const id of payload.optionalCharacterOps.enable) next.add(extractLogicalId(id));
      config.enabledOptionalCharacters = [...next];
      configDirty = true;
    } else if (item.kind === 'optional_character_disable' && Array.isArray(payload.optionalCharacterOps?.disable)) {
      const drop = new Set(payload.optionalCharacterOps.disable.map(extractLogicalId));
      config.enabledOptionalCharacters = (config.enabledOptionalCharacters || []).filter((id) => !drop.has(extractLogicalId(id)));
      config.roomGuestInvitations = (config.roomGuestInvitations || []).filter((inv) => {
        const cid = typeof inv === 'string' ? extractLogicalId(inv) : extractLogicalId(inv?.characterId || '');
        return !drop.has(cid);
      });
      configDirty = true;
    } else if (item.kind === 'overlay_disable' && Array.isArray(payload.overlayOps?.disable)) {
      const disableSet = new Set(payload.overlayOps.disable.flatMap((id) => [id, extractLogicalId(id)]));
      config.overlayActivations = (config.overlayActivations || []).map((ov) => (
        disableSet.has(ov.overlayId) || disableSet.has(extractLogicalId(ov.overlayId))
          ? { ...ov, enabled: false }
          : ov
      ));
      configDirty = true;
    } else if (item.kind === 'overlay_enable' && Array.isArray(payload.overlayOps?.add)) {
      const nextOv = [...(config.overlayActivations || [])];
      for (const ov of payload.overlayOps.add) {
        const idx = nextOv.findIndex((x) => extractLogicalId(x.overlayId) === extractLogicalId(ov.overlayId) && x.scope === ov.scope);
        if (idx >= 0) nextOv[idx] = { ...nextOv[idx], ...ov, enabled: true };
        else nextOv.push({ ...ov, enabled: true });
      }
      config.overlayActivations = nextOv;
      configDirty = true;
    } else if (item.kind === 'epistemic_knowledge' || item.kind === 'epistemic_false_belief') {
      const existingFacts = await listKnowledgeFacts({ projectId: pid });
      const titleKey = cleanString(payload.factTitle).toLowerCase();
      let fact = existingFacts.find((f) => cleanString(f.title).toLowerCase() === titleKey) || null;
      if (!fact) {
        fact = await saveKnowledgeFact({
          title: cleanString(payload.factTitle) || 'Hecho epistémico propuesto',
          truth: cleanString(payload.factTruth) || cleanString(payload.beliefText) || 'Verdad objetiva pendiente de detallar.',
          scope: 'world_fact',
          layer: cleanString(payload.characterVersion || 'room') === 'outside' ? 'outside' : 'room',
          isSecret: payload.isSecret !== false,
          firstEffectiveChapterOrder: payload.effectiveChapterOrder ?? 1,
          disclosureConstraints: ['No divulgar automáticamente sin escena o evidencia.'],
        }, { projectId: pid });
      }
      const charKey = makeCharacterVersionKey(payload.characterId || 'unknown', payload.characterVersion || 'room');
      const updatedFact = appendBeliefTransitionToFact(fact, charKey, {
        state: payload.state || (item.kind === 'epistemic_false_belief' ? 'believes_false' : 'knows'),
        beliefText: cleanString(payload.beliefText || ''),
        evidence: cleanString(payload.evidence || ''),
        effectiveChapterOrder: payload.effectiveChapterOrder ?? 1,
      });
      const savedFact = await saveKnowledgeFact(updatedFact, { projectId: pid });
      appliedFacts.push(savedFact);
    } else if (item.kind === 'possible_idea') {
      savedIdeas.push({
        id: db.uid(),
        text: cleanString(payload.ideaText || item.summary),
        savedAt: new Date().toISOString(),
      });
    }

    updatedItems.push({ ...item, status: 'approved' });
  }

  if (configDirty) {
    config = await saveStoryConfig(config);
  }
  if (savedIdeas.length) {
    const chat = await getCreativeChat(pid);
    await saveCreativeChat({
      ...chat,
      archivedIdeas: [...(chat.archivedIdeas || []), ...savedIdeas],
    }, { projectId: pid });
  }

  const allDecided = updatedItems.every((i) => i.status !== 'proposed');
  const anyApproved = updatedItems.some((i) => i.status === 'approved');
  return {
    proposal: {
      ...proposal,
      items: updatedItems,
      status: !allDecided ? 'partially_resolved' : (anyApproved ? 'approved' : 'rejected'),
      decidedAt: new Date().toISOString(),
    },
    config,
    configUpdated: configDirty,
    appliedFacts,
    savedIdeas,
  };
}

// ---------------------------------------------------------------------------
// 3. Briefs de Capítulo aprobados (Creative Chat -> Brief -> Escribir)
// ---------------------------------------------------------------------------

export function normalizeChapterBrief(input, { existing = null, projectId = '' } = {}) {
  if (!isPlainObject(input)) throw new Error('El brief de capítulo debe ser un objeto válido.');
  const now = new Date().toISOString();
  const pid = cleanString(projectId || input.projectId || existing?.projectId) || db.getActiveProjectId();
  const rawTargetLen = Number(input.targetLength ?? existing?.targetLength ?? 5000);
  const targetLength = Number.isFinite(rawTargetLen) && rawTargetLen >= 500 ? Math.floor(rawTargetLen) : 5000;

  return {
    id: cleanString(input.id || existing?.id) || db.uid(),
    projectId: pid,
    title: cleanString(input.title !== undefined ? input.title : (existing?.title || '')),
    objective: cleanString(input.objective !== undefined ? input.objective : (existing?.objective || '')),
    perspective: cleanString(input.perspective !== undefined ? input.perspective : (existing?.perspective || '')),
    activeParticipants: cleanStringArray(input.activeParticipants !== undefined ? input.activeParticipants : existing?.activeParticipants),
    emotionalProgression: cleanString(input.emotionalProgression !== undefined ? input.emotionalProgression : (existing?.emotionalProgression || '')),
    dialogueIntentions: cleanStringArray(input.dialogueIntentions !== undefined ? input.dialogueIntentions : existing?.dialogueIntentions),
    desiredRevelations: cleanStringArray(input.desiredRevelations !== undefined ? input.desiredRevelations : existing?.desiredRevelations),
    mustRemainSecret: cleanStringArray(input.mustRemainSecret !== undefined ? input.mustRemainSecret : existing?.mustRemainSecret),
    relevantHistoricalMemories: cleanStringArray(input.relevantHistoricalMemories !== undefined ? input.relevantHistoricalMemories : existing?.relevantHistoricalMemories),
    requiredEndingConditions: cleanString(input.requiredEndingConditions !== undefined ? input.requiredEndingConditions : (existing?.requiredEndingConditions || '')),
    targetLength,
    sceneCharacterModifications: cleanStringArray(input.sceneCharacterModifications !== undefined ? input.sceneCharacterModifications : existing?.sceneCharacterModifications),
    guidanceMode: 'flexible_guidance',
    guidanceNote: cleanString(
      input.guidanceNote ||
      existing?.guidanceNote ||
      'Guía creativa flexible: sirve de brújula narrativa, no obliga a forzar cada evento si la escena descubre un camino orgánico mejor.'
    ),
    status: ['draft', 'approved', 'transferred'].includes(input.status) ? input.status : (existing?.status || 'draft'),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

export async function listChapterBriefs({ projectId = '' } = {}) {
  const pid = cleanString(projectId) || db.getActiveProjectId();
  const all = await db.getAll('chapterBriefs', { projectId: pid });
  return (all || [])
    .filter((b) => !b.deletedAt)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function saveChapterBrief(input, { projectId = '' } = {}) {
  const pid = cleanString(projectId || input?.projectId) || db.getActiveProjectId();
  const scope = { projectId: pid };
  const existing = input?.id ? await db.get('chapterBriefs', input.id, scope) : null;
  const normalized = normalizeChapterBrief(input, { existing, projectId: pid });
  return db.put('chapterBriefs', normalized, scope);
}

export function formatChapterBriefAsInstructions(brief) {
  if (!brief) return '';
  return [
    brief.title ? `CHAPTER BRIEF — ${brief.title}` : 'CHAPTER BRIEF (Flexible Author Guidance)',
    brief.objective ? `Objective: ${brief.objective}` : '',
    brief.perspective ? `Narrative perspective / POV: ${brief.perspective}` : '',
    brief.activeParticipants?.length ? `Active participants: ${brief.activeParticipants.join(', ')}` : '',
    brief.emotionalProgression ? `Emotional progression: ${brief.emotionalProgression}` : '',
    brief.dialogueIntentions?.length ? `Dialogue intentions:\n- ${brief.dialogueIntentions.join('\n- ')}` : '',
    brief.desiredRevelations?.length ? `Desired revelations:\n- ${brief.desiredRevelations.join('\n- ')}` : '',
    brief.mustRemainSecret?.length ? `MUST REMAIN SECRET (do NOT leak):\n- ${brief.mustRemainSecret.join('\n- ')}` : '',
    brief.relevantHistoricalMemories?.length ? `Relevant historical memories:\n- ${brief.relevantHistoricalMemories.join('\n- ')}` : '',
    brief.sceneCharacterModifications?.length ? `Scene-specific character notes:\n- ${brief.sceneCharacterModifications.join('\n- ')}` : '',
    brief.requiredEndingConditions ? `Ending condition: ${brief.requiredEndingConditions}` : '',
    `Note: ${brief.guidanceNote || 'Treat as flexible narrative guidance rather than a rigid checklist.'}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Aprueba un Brief de Capítulo y lo transfiere de forma segura a la vista «Escribir»
 * (guardando `planner-draft:<projectId>` con metadatos estructurados del brief).
 */
export async function transferApprovedBriefToWrite(projectId, briefId) {
  const pid = cleanString(projectId) || db.getActiveProjectId();
  const scope = { projectId: pid };
  const brief = await db.get('chapterBriefs', briefId, scope);
  if (!brief) throw new Error('No se encontró el brief de capítulo.');
  const approved = await saveChapterBrief({ ...brief, status: 'transferred' }, scope);
  const formattedText = formatChapterBriefAsInstructions(approved);
  await db.put('settings', {
    id: `planner-draft:${pid}`,
    briefId: approved.id,
    title: approved.title || '',
    text: formattedText,
    targetWords: approved.targetLength || 5000,
    requiredEnding: approved.requiredEndingConditions || '',
    createdAt: new Date().toISOString(),
  });
  return { brief: approved, formattedText };
}
