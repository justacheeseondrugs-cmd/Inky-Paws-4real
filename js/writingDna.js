// writingDna.js — Perfil permanente de voz literaria (Writing DNA) en 4 ámbitos
// (global, fandom, historia y capítulo/escena), anti-patrones literarios editables
// y aprendizaje editorial revisado a partir de correcciones de la autora (0 tokens).
//
// Reglas clave:
// - Inglés por defecto para manuscritos generados; español por defecto para la interfaz.
// - Las cualidades literarias son preferencias de oficio, nunca fórmulas rígidas de párrafos.
// - Sin listas negras simplistas de palabras que dañen expresión literaria legítima.
// - JAMÁS promueve silenciosamente hechos de trama, rasgos AU ni relaciones románticas
//   al Writing DNA global compartido entre historias.
// - El perfil global se puede exportar e importar independientemente de las copias de historia.

import { db } from './db.js';
import { normalizeFandomNamespace } from './characterLibrary.js';

export const WRITING_DNA_SCOPES = new Set(['global', 'fandom', 'story', 'chapter_scene']);
export const FEEDBACK_STATUSES = new Set(['proposed', 'approved', 'rejected', 'deactivated']);
export const GLOBAL_DNA_ID = 'dna::global';

export const DEFAULT_LITERARY_QUALITIES = [
  'Prosa inmersiva de calidad de novela, no texto mecánico de asistente.',
  'Ritmo narrativo natural: las escenas se desarrollan sin relleno artificial ni prisa.',
  'Escenas bien construidas donde cada momento respira cuando lo merece.',
  'Profundidad emocional e interioridad contenida, sin explicar en exceso.',
  'Voces de personaje auténticas y diferenciadas, nunca intercambiables.',
  'Lenguaje corporal significativo que comunica subtexto antes que el diálogo.',
  'Diálogos naturales con interrupciones, silencios, rodeos y ritmo vivo.',
  'Humor orgánico nacido de la personalidad y el choque entre personajes.',
  'Subtexto romántico creíble y contenido en lugar de melodrama obvio.',
  'Desarrollo emocional gradual y ganado a lo largo de la historia.',
  'Consecuencias persistentes entre capítulos (nada se reinicia a cero).',
  'Diálogo coral en grupo sin turnos mecánicos ni reacciones en fila.',
];

export const DEFAULT_ANTI_PATTERNS = [
  { id: 'ap_everyone_reacts', label: 'Todos los personajes reaccionan a cada revelación', enabled: true },
  { id: 'ap_collective_gasps', label: 'Jadeos colectivos repetidos, silencios congelados o ojos muy abiertos en coro', enabled: true },
  { id: 'ap_explain_evident_emotion', label: 'Personajes o narrador explicando emociones ya evidentes en sus acciones', enabled: true },
  { id: 'ap_generic_speeches', label: 'Discursos motivacionales genéricos o sermones fuera de personaje', enabled: true },
  { id: 'ap_artificial_cliffhangers', label: 'Finales artificialmente dramáticos en cada pasaje o párrafo', enabled: true },
  { id: 'ap_name_repetition', label: 'Repetición excesiva de nombres propios en diálogo o narración', enabled: true },
  { id: 'ap_insult_gesture_repetition', label: 'Repetición excesiva de los mismos insultos, apodos o gestos muletilla', enabled: true },
  { id: 'ap_dialogue_recaps', label: 'Resúmenes innecesarios de lo que acaba de decirse en el diálogo', enabled: true },
  { id: 'ap_constant_blushing', label: 'Sonrojos románticos constantes en lugar de subtexto creíble', enabled: true },
  { id: 'ap_forced_jokes', label: 'Chistes forzados o humor que rompe el tono y la voz del personaje', enabled: true },
  { id: 'ap_sudden_resolution', label: 'Resolución emocional repentina sin proceso ni resistencia creíble', enabled: true },
  { id: 'ap_caricatures', label: 'Caricaturización de personajes (reducirlos a un único rasgo exagerado)', enabled: true },
  { id: 'ap_rhetorical_cadence', label: 'Estructuras retóricas repetitivas o cadencia simétrica de IA', enabled: true },
  { id: 'ap_meta_commentary', label: 'Comentarios meta o notas de asistente dentro de la prosa del manuscrito', enabled: true },
];

// Patrones que indican contenido específico de trama, AU o relación (NO promovible a Global DNA)
const AU_OR_PLOT_SPECIFIC_RX = /\b(eruri|erwin|levi|hange|hanji|petra|eren|mikasa|armin|jean|connie|sasha|ymir|historia|christa|joseph|anya|candy|violet\s+traits|violet\s+au|power\s+to\s+strive|watching\s+room|reaction\s+room|sala\s+de\s+reacciones|former\s+lovers|secret\s+relationship|used\s+to\s+date|married|marriage|expedition|titan|shiganshina|chapter\s+\d+|cap[ií]tulo\s+\d+)\b/i;

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

function normalizeAntiPatterns(rawList, fallbackDefault = false) {
  const source = Array.isArray(rawList) ? rawList : (fallbackDefault ? DEFAULT_ANTI_PATTERNS : []);
  const out = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item === 'string') {
      const label = cleanString(item);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `ap_${out.length + 1}`, label, enabled: true });
    } else if (isPlainObject(item)) {
      const label = cleanString(item.label || item.text || '');
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: cleanString(item.id || '') || db.uid(),
        label,
        enabled: item.enabled !== false,
      });
    }
  }
  return out;
}

export function makeWritingDnaId({ scope = 'global', fandom = '', projectId = '', chapterId = '' } = {}) {
  const s = WRITING_DNA_SCOPES.has(scope) ? scope : 'global';
  if (s === 'global') return GLOBAL_DNA_ID;
  if (s === 'fandom') return `dna::fandom::${normalizeFandomNamespace(fandom || 'neutral')}`;
  if (s === 'story') return `dna::story::${cleanString(projectId) || db.getActiveProjectId()}`;
  return `dna::chapter::${cleanString(projectId) || db.getActiveProjectId()}::${cleanString(chapterId || 'active')}`;
}

export function createDefaultGlobalWritingDna() {
  const now = new Date().toISOString();
  return {
    id: GLOBAL_DNA_ID,
    scope: 'global',
    fandom: '',
    projectId: null,
    chapterId: null,
    name: 'Writing DNA Global de la autora',
    manuscriptLanguage: 'en',
    uiLanguage: 'es',
    literaryQualities: [...DEFAULT_LITERARY_QUALITIES],
    antiPatterns: structuredClone(DEFAULT_ANTI_PATTERNS),
    customNotes: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeWritingDnaProfile(input, { existing = null } = {}) {
  if (!isPlainObject(input)) throw new Error('El perfil Writing DNA debe ser un objeto válido.');
  const rawScope = cleanString(input.scope || existing?.scope || 'global');
  const scope = WRITING_DNA_SCOPES.has(rawScope) ? rawScope : 'global';
  const fandom = scope === 'fandom' ? normalizeFandomNamespace(input.fandom || existing?.fandom || 'neutral') : '';
  const projectId = (scope === 'story' || scope === 'chapter_scene')
    ? (cleanString(input.projectId || existing?.projectId) || db.getActiveProjectId())
    : null;
  const chapterId = scope === 'chapter_scene' ? (cleanString(input.chapterId || existing?.chapterId || 'active')) : null;
  const id = cleanString(input.id || existing?.id) || makeWritingDnaId({ scope, fandom, projectId, chapterId });
  const now = new Date().toISOString();

  return {
    id,
    scope,
    fandom,
    projectId,
    chapterId,
    name: cleanString(input.name !== undefined ? input.name : (existing?.name || (scope === 'global' ? 'Writing DNA Global de la autora' : `Writing DNA (${scope})`))),
    manuscriptLanguage: cleanString(input.manuscriptLanguage !== undefined ? input.manuscriptLanguage : (existing?.manuscriptLanguage || 'en')) || 'en',
    uiLanguage: cleanString(input.uiLanguage !== undefined ? input.uiLanguage : (existing?.uiLanguage || 'es')) || 'es',
    literaryQualities: cleanStringArray(
      input.literaryQualities !== undefined
        ? input.literaryQualities
        : (existing?.literaryQualities !== undefined ? existing.literaryQualities : (scope === 'global' ? DEFAULT_LITERARY_QUALITIES : []))
    ),
    antiPatterns: normalizeAntiPatterns(
      input.antiPatterns !== undefined ? input.antiPatterns : existing?.antiPatterns,
      scope === 'global' && !existing
    ),
    customNotes: cleanString(input.customNotes !== undefined ? input.customNotes : existing?.customNotes),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

export async function getWritingDnaProfile({ scope = 'global', fandom = '', projectId = '', chapterId = '' } = {}) {
  const id = makeWritingDnaId({ scope, fandom, projectId, chapterId });
  const stored = await db.get('writingDnaProfiles', id);
  if (stored) return normalizeWritingDnaProfile(stored, { existing: stored });
  if (scope === 'global') return createDefaultGlobalWritingDna();
  return normalizeWritingDnaProfile({ id, scope, fandom, projectId, chapterId, literaryQualities: [], antiPatterns: [] });
}

export async function saveWritingDnaProfile(profileInput) {
  const scope = WRITING_DNA_SCOPES.has(profileInput?.scope) ? profileInput.scope : 'global';
  const id = cleanString(profileInput?.id) || makeWritingDnaId({
    scope,
    fandom: profileInput?.fandom,
    projectId: profileInput?.projectId,
    chapterId: profileInput?.chapterId,
  });
  const existing = await db.get('writingDnaProfiles', id);
  const normalized = normalizeWritingDnaProfile({ ...profileInput, id, scope }, { existing });
  return db.put('writingDnaProfiles', normalized);
}

/**
 * Exporta únicamente el perfil global Writing DNA (y reglas globales aprobadas)
 * de forma completamente independiente de las copias de seguridad de historias.
 * Nunca incluye claves API ni canon específico de ninguna historia.
 */
export function exportGlobalWritingDnaProfile(globalProfile, approvedGlobalRules = []) {
  const safeProfile = normalizeWritingDnaProfile({ ...(globalProfile || createDefaultGlobalWritingDna()), scope: 'global', id: GLOBAL_DNA_ID });
  const safeRules = (approvedGlobalRules || [])
    .filter((r) => r && r.scope === 'global' && r.status === 'approved' && !detectPlotOrAuSpecificContent(r.ruleText).isSpecific)
    .map((r) => ({
      id: r.id,
      scope: 'global',
      ruleText: r.ruleText,
      reason: r.reason || '',
      category: r.category || 'craft',
      approvedAt: r.decidedAt || r.updatedAt || null,
    }));
  return {
    __meta: {
      schema: 'inky.global_writing_dna',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      apiKeysExcluded: true,
      storyCanonExcluded: true,
    },
    profile: safeProfile,
    approvedGlobalRules: safeRules,
  };
}

export function validateGlobalWritingDnaImport(payload) {
  if (!isPlainObject(payload)) throw new Error('El archivo de Writing DNA global no es un JSON válido.');
  if (payload.__meta?.schema !== 'inky.global_writing_dna') {
    throw new Error('Este archivo no corresponde a un perfil Writing DNA global de Inky Paws.');
  }
  if (!isPlainObject(payload.profile)) throw new Error('Falta el bloque `profile` en el archivo Writing DNA.');
  const normalizedProfile = normalizeWritingDnaProfile({ ...payload.profile, scope: 'global', id: GLOBAL_DNA_ID });
  const importedRules = Array.isArray(payload.approvedGlobalRules) ? payload.approvedGlobalRules : [];
  const cleanRules = [];
  const rejectedSpecific = [];
  for (const r of importedRules) {
    const text = cleanString(r?.ruleText);
    if (!text) continue;
    const guard = detectPlotOrAuSpecificContent(text);
    if (guard.isSpecific) {
      rejectedSpecific.push({ ruleText: text, matches: guard.matches });
      continue;
    }
    cleanRules.push({
      id: cleanString(r.id) || db.uid(),
      scope: 'global',
      ruleText: text,
      reason: cleanString(r.reason || ''),
      category: cleanString(r.category || 'craft'),
      status: 'approved',
    });
  }
  return { profile: normalizedProfile, approvedGlobalRules: cleanRules, rejectedSpecific };
}

export async function importGlobalWritingDnaProfile(payload) {
  const validated = validateGlobalWritingDnaImport(payload);
  const savedProfile = await saveWritingDnaProfile(validated.profile);
  const savedRules = [];
  for (const rule of validated.approvedGlobalRules) {
    const rec = await db.put('editorialFeedback', {
      id: rule.id,
      scope: 'global',
      fandom: '',
      projectId: null,
      originalPassage: '',
      revisedPassage: '',
      authorNote: 'Importado desde perfil global Writing DNA',
      ruleText: rule.ruleText,
      reason: rule.reason,
      category: rule.category,
      supportingExamples: [],
      status: 'approved',
      revisionHistory: [{ ruleText: rule.ruleText, status: 'approved', timestamp: new Date().toISOString(), note: 'imported' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    savedRules.push(rec);
  }
  return { profile: savedProfile, importedRulesCount: savedRules.length, rejectedSpecific: validated.rejectedSpecific };
}

// ---------------------------------------------------------------------------
// Guardia anti-contaminación y aprendizaje editorial revisado (0 tokens)
// ---------------------------------------------------------------------------

/**
 * Detecta si una regla o corrección editorial contiene hechos de trama, nombres de
 * personajes, rasgos de AU o estados de relación que JAMÁS deben contaminar el Writing DNA global.
 */
export function detectPlotOrAuSpecificContent(text) {
  const src = cleanString(text);
  if (!src) {
    return {
      isSpecific: false,
      matches: [],
      detectionMode: 'heuristic_warning_not_semantic_guarantee',
    };
  }
  const matches = [];
  const rx = new RegExp(AU_OR_PLOT_SPECIFIC_RX.source, 'gi');
  let m;
  while ((m = rx.exec(src)) !== null) {
    const token = m[0].trim();
    if (!matches.includes(token)) matches.push(token);
  }
  return {
    isSpecific: matches.length > 0,
    matches,
    detectionMode: 'heuristic_warning_not_semantic_guarantee',
  };
}

function inferLocalEditorialProposal({ originalPassage, revisedPassage, authorNote }) {
  const note = cleanString(authorNote).toLowerCase();
  const origLen = cleanString(originalPassage).length;
  const revLen = cleanString(revisedPassage).length;

  if (/\b(explain|explic|tell|subtext|subtexto|obvious|obvi)\b/i.test(note)) {
    return {
      category: 'emotional_restraint',
      ruleText: 'Confiar en el subtexto y el lenguaje corporal; evitar explicar emociones ya evidentes en la acción.',
      reason: 'La revisión de la autora recorta explicaciones explícitas de emociones.',
    };
  }
  if (/\b(dialogue|di[aá]logo|natural|stiff|r[ií]gid|interrupt|interrup)\b/i.test(note)) {
    return {
      category: 'dialogue_naturalness',
      ruleText: 'Preferir diálogos naturales con ritmo vivo, interrupciones y rodeos en lugar de réplicas pulidas de asistente.',
      reason: 'La autora ajustó el diálogo para sonar más natural y propio del personaje.',
    };
  }
  if (/\b(pace|pacing|ritmo|rush|r[aá]pid|slow|lent|drag)\b/i.test(note)) {
    return {
      category: 'pacing',
      ruleText: 'Ajustar el ritmo narrativo para dejar respirar las escenas clave sin relleno mecánico ni prisas.',
      reason: 'La revisión corrige el ritmo y desarrollo de la escena.',
    };
  }
  if (/\b(transition|transici[oó]n|bridge|puente)\b/i.test(note)) {
    return {
      category: 'transitions',
      ruleText: 'Construir transiciones fluidas entre momentos y escenas sin cortes bruscos ni resúmenes artificiales.',
      reason: 'La autora mejoró la transición narrativa del pasaje.',
    };
  }
  if (/\b(gasp|jadeo|ensemble|coro|todos|everyone|repeti)\b/i.test(note)) {
    return {
      category: 'ensemble_reactions',
      ruleText: 'Evitar reacciones corales repetitivas; seleccionar solo 2–3 reacciones concretas y diferenciadas por momento.',
      reason: 'La revisión elimina reacciones en fila o colectivas repetitivas.',
    };
  }
  if (/\b(voice|voz|ooc|caricatur|characteriz|caracteriz)\b/i.test(note)) {
    return {
      category: 'character_voice',
      ruleText: 'Mantener la voz auténtica, contención y economía verbal de cada personaje incluso en momentos intensos.',
      reason: 'La autora corrigió desviaciones de voz o caracterización.',
    };
  }
  if (origLen > 0 && revLen > 0 && revLen < origLen * 0.78) {
    return {
      category: 'conciseness_and_subtext',
      ruleText: 'Recortar sobre-explicaciones y repeticiones; mostrar el gesto o línea precisa y avanzar.',
      reason: 'La versión revisada es notablemente más concisa y directa que el borrador original.',
    };
  }
  return {
    category: 'craft_general',
    ruleText: cleanString(authorNote) || 'Preferir el ritmo, contención y naturalidad mostrados en el pasaje revisado por la autora.',
    reason: 'Propuesta generada a partir del par original/revisado guardado por la autora.',
  };
}

/**
 * Registra un par de corrección editorial (original + revisado + explicación opcional)
 * y genera una propuesta estructurada de preferencia literaria (status: 'proposed').
 *
 * - 0 llamadas pagas por defecto (usa heurística local determinista).
 * - Soporta opcionalmente `analyzerProvider` inyectado (mocked en pruebas o explícito por la autora).
 * - NUNCA promueve hechos de trama o rasgos de AU al ámbito global.
 */
export async function recordEditorialFeedback({
  originalPassage = '',
  revisedPassage = '',
  authorNote = '',
  requestedScope = 'global',
  fandom = '',
  projectId = '',
  chapterId = null,
  sceneId = null,
  analyzerProvider = null,
} = {}) {
  const orig = cleanString(originalPassage);
  const rev = cleanString(revisedPassage);
  const note = cleanString(authorNote);
  if (!orig || !rev) {
    throw new Error('Debes incluir tanto el pasaje original (A) como el pasaje revisado (B).');
  }

  let proposal;
  if (analyzerProvider && typeof analyzerProvider.analyzeFeedback === 'function') {
    const aiOut = await analyzerProvider.analyzeFeedback({
      originalPassage: orig,
      revisedPassage: rev,
      authorNote: note,
      requestedScope,
    });
    proposal = {
      category: cleanString(aiOut?.category || 'craft_general'),
      ruleText: cleanString(aiOut?.ruleText || ''),
      reason: cleanString(aiOut?.reason || 'Propuesta sugerida por analizador editorial.'),
    };
  } else {
    proposal = inferLocalEditorialProposal({ originalPassage: orig, revisedPassage: rev, authorNote: note });
  }

  if (!proposal.ruleText) {
    proposal = inferLocalEditorialProposal({ originalPassage: orig, revisedPassage: rev, authorNote: note });
  }

  // Guardia heurística (advertencia, no garantía semántica) para evitar contaminar Global/Fandom
  const guardRule = detectPlotOrAuSpecificContent(`${proposal.ruleText} ${note}`);
  const targetProject = cleanString(projectId) || db.getActiveProjectId();
  const normalizedFandom = normalizeFandomNamespace(fandom || 'neutral');
  let resolvedScope = WRITING_DNA_SCOPES.has(requestedScope) ? requestedScope : 'global';
  let scopeGuardWarning = '';
  if ((resolvedScope === 'global' || resolvedScope === 'fandom') && guardRule.isSpecific) {
    const prevScope = resolvedScope;
    resolvedScope = 'story';
    scopeGuardWarning = `Aviso heurístico: se detectaron elementos específicos de historia/AU (${guardRule.matches.join(', ')}). Esta propuesta se restringió automáticamente de «${prevScope}» a «story» para no contaminar el Writing DNA global ni de fandom.`;
  }

  const now = new Date().toISOString();
  const record = {
    id: db.uid(),
    scope: resolvedScope,
    fandom: resolvedScope === 'fandom' ? normalizedFandom : '',
    projectId: (resolvedScope === 'story' || resolvedScope === 'chapter_scene') ? targetProject : null,
    chapterId: resolvedScope === 'chapter_scene' ? (cleanString(chapterId) || null) : null,
    sceneId: resolvedScope === 'chapter_scene' ? (cleanString(sceneId) || null) : null,
    originalPassage: orig,
    revisedPassage: rev,
    authorNote: note,
    category: proposal.category,
    ruleText: proposal.ruleText,
    reason: proposal.reason,
    supportingExamples: [{ original: orig.slice(0, 500), revised: rev.slice(0, 500), note }],
    isPlotOrAuSpecific: guardRule.isSpecific,
    guardDetectionMode: guardRule.detectionMode,
    scopeGuardWarning,
    status: 'proposed',
    revisionHistory: [
      { ruleText: proposal.ruleText, scope: resolvedScope, status: 'proposed', timestamp: now, note: 'created' },
    ],
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
  };

  return db.put('editorialFeedback', record);
}

export async function listEditorialFeedback({ scope = '', status = '', projectId = '' } = {}) {
  const all = await db.getAll('editorialFeedback');
  return (all || [])
    .filter((item) => !item.deletedAt)
    .filter((item) => !scope || item.scope === scope)
    .filter((item) => !status || item.status === status)
    .filter((item) => {
      if (!projectId) return true;
      if (item.scope === 'global' || item.scope === 'fandom') return true;
      return item.projectId === projectId;
    })
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

export async function decideEditorialProposal(feedbackId, decision, { editedRuleText = undefined, targetScope = undefined, decisionNote = '' } = {}) {
  const existing = await db.get('editorialFeedback', feedbackId);
  if (!existing) throw new Error('No se encontró la propuesta de aprendizaje editorial.');
  if (!FEEDBACK_STATUSES.has(decision)) throw new Error(`Estado editorial inválido: "${decision}".`);

  const nextRuleText = editedRuleText !== undefined ? cleanString(editedRuleText) : existing.ruleText;
  if (!nextRuleText) throw new Error('La regla editorial no puede quedar vacía.');

  const nextScope = targetScope && WRITING_DNA_SCOPES.has(targetScope) ? targetScope : existing.scope;
  if (decision === 'approved' && (nextScope === 'global' || nextScope === 'fandom')) {
    const guard = detectPlotOrAuSpecificContent(`${nextRuleText} ${existing.authorNote || ''}`);
    if (guard.isSpecific && nextScope === 'global') {
      throw new Error(`No se puede aprobar una regla con hechos de trama o AU (${guard.matches.join(', ')}) dentro del Writing DNA global. Cambia el ámbito a «story» o redacta una regla puramente literaria.`);
    }
  }

  const now = new Date().toISOString();
  const next = {
    ...existing,
    scope: nextScope,
    projectId: (nextScope === 'story' || nextScope === 'chapter_scene')
      ? (existing.projectId || db.getActiveProjectId())
      : null,
    ruleText: nextRuleText,
    status: decision,
    decidedAt: now,
    updatedAt: now,
    revisionHistory: [
      ...(existing.revisionHistory || []),
      { ruleText: nextRuleText, scope: nextScope, status: decision, timestamp: now, note: cleanString(decisionNote) || decision },
    ],
  };
  return db.put('editorialFeedback', next);
}

export async function deleteEditorialFeedback(feedbackId) {
  return db.del('editorialFeedback', feedbackId);
}

/**
 * Resuelve la jerarquía aprobada de Writing DNA en 4 ámbitos:
 * Global → Fandom → Historia → Capítulo/Escena + reglas aprendidas APROBADAS.
 *
 * Aislamiento estricto por ámbito:
 * - Las reglas `chapter_scene` se filtran por `projectId`, `targetChapterId` y `targetSceneId`
 *   exactos; jamás se filtran a otros capítulos ni a otras escenas.
 * - Las propuestas rechazadas, pendientes o desactivadas NUNCA entran en el perfil efectivo.
 */
export function resolveWritingDna({
  globalProfile = null,
  fandomProfile = null,
  storyProfile = null,
  chapterSceneOverride = null,
  editorialFeedback = [],
  fandom = 'neutral',
  projectId = '',
  targetChapterId = null,
  targetSceneId = null,
} = {}) {
  const ns = normalizeFandomNamespace(fandom || 'neutral');
  const global = globalProfile ? normalizeWritingDnaProfile(globalProfile) : createDefaultGlobalWritingDna();
  const fProf = fandomProfile && normalizeFandomNamespace(fandomProfile.fandom || '') === ns
    ? normalizeWritingDnaProfile(fandomProfile)
    : null;
  const sProf = storyProfile && (!projectId || storyProfile.projectId === projectId)
    ? normalizeWritingDnaProfile(storyProfile)
    : null;
  const chMatches = chapterSceneOverride &&
    (!projectId || !chapterSceneOverride.projectId || chapterSceneOverride.projectId === projectId) &&
    (!chapterSceneOverride.chapterId || chapterSceneOverride.chapterId === targetChapterId) &&
    (!chapterSceneOverride.sceneId || chapterSceneOverride.sceneId === targetSceneId);
  const chProf = chMatches ? normalizeWritingDnaProfile(chapterSceneOverride) : null;

  const qualities = cleanStringArray([
    ...global.literaryQualities,
    ...(fProf?.literaryQualities || []),
    ...(sProf?.literaryQualities || []),
    ...(chProf?.literaryQualities || []),
  ]);

  // Combinar anti-patrones por etiqueta/ID (un ámbito más específico puede desactivar uno global)
  const apMap = new Map();
  for (const prof of [global, fProf, sProf, chProf]) {
    if (!prof) continue;
    for (const ap of (prof.antiPatterns || [])) {
      const key = cleanString(ap.id || ap.label).toLowerCase();
      apMap.set(key, { ...ap });
    }
  }
  const activeAntiPatterns = [...apMap.values()].filter((ap) => ap.enabled !== false);

  // Solo reglas editoriales APROBADAS que coincidan exactamente con su ámbito autorizado
  const approvedRules = (editorialFeedback || []).filter((item) => {
    if (!item || item.deletedAt || item.status !== 'approved') return false;
    if (item.scope === 'global') return !detectPlotOrAuSpecificContent(item.ruleText).isSpecific;
    if (item.scope === 'fandom') {
      return normalizeFandomNamespace(item.fandom || '') === ns &&
        !detectPlotOrAuSpecificContent(item.ruleText).isSpecific;
    }
    if (item.scope === 'story') {
      return Boolean(projectId) && item.projectId === projectId;
    }
    if (item.scope === 'chapter_scene') {
      if (!projectId || item.projectId !== projectId) return false;
      const itemCh = cleanString(item.chapterId || '');
      const itemSc = cleanString(item.sceneId || '');
      // Una regla chapter_scene debe tener al menos capítulo o escena explícitos y coincidir exactamente
      if (!itemCh && !itemSc) return false;
      if (itemCh && itemCh !== cleanString(targetChapterId || '')) return false;
      if (itemSc && itemSc !== cleanString(targetSceneId || '')) return false;
      return true;
    }
    return false;
  }).map((item) => ({
    id: item.id,
    scope: item.scope,
    category: item.category,
    chapterId: item.chapterId || null,
    sceneId: item.sceneId || null,
    ruleText: item.ruleText,
    reason: item.reason,
  }));

  return {
    manuscriptLanguage: chProf?.manuscriptLanguage || sProf?.manuscriptLanguage || fProf?.manuscriptLanguage || global.manuscriptLanguage || 'en',
    uiLanguage: global.uiLanguage || 'es',
    fandom: ns,
    projectId: projectId || null,
    targetChapterId: cleanString(targetChapterId || '') || null,
    targetSceneId: cleanString(targetSceneId || '') || null,
    literaryQualities: qualities,
    activeAntiPatterns,
    approvedLearnedRules: approvedRules,
    customNotesByScope: {
      global: global.customNotes || '',
      fandom: fProf?.customNotes || '',
      story: sProf?.customNotes || '',
      chapter_scene: chProf?.customNotes || '',
    },
    wordBlacklistsUsed: false,
    antiContaminationDetectionMode: 'heuristic_warning_not_semantic_guarantee',
  };
}
