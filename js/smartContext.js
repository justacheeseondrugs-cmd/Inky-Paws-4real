// smartContext.js — selección local y explicable del contexto narrativo.
//
// Objetivo: conservar anclas de continuidad (inicio + capítulos recientes) y
// añadir recuerdos antiguos por relevancia a la escena actual, sin llamadas a
// IA ni embeddings. Los hechos bloqueados y el canon permanente NO se eliminan:
// por seguridad siguen entrando completos al prompt.

const STOPWORDS = new Set(
  ('the of and to in a is that it for on with as was were are be this his her she he him they them their ' +
   'from into at by an or if but not no yes do does did have has had will would can could should ' +
   'de la que el en y a los se del las un por con una su para es al lo como mas o pero sus le ya fue ' +
   'este esta estos estas ha hay si porque entre cuando muy sin sobre tambien me hasta donde quien desde ' +
   'todo todos uno unos unas otro otra otros otras ellos ellas nosotros nosotras mi mis tu tus ' +
   'chapter capitulo capítulo scene escena scenes escenas write escribir writing historia story current ' +
   'actual previous anterior next siguiente words palabras continue continuar ending final').split(/\s+/)
);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function tokenizeSmartContext(text) {
  return normalize(text)
    .replace(/[^a-z0-9ñü\s]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function queryCounts(queryText) {
  const counts = {};
  for (const token of tokenizeSmartContext(queryText)) counts[token] = (counts[token] || 0) + 1;
  return counts;
}

export function scoreSmartText(text, queryTextOrCounts) {
  const counts = typeof queryTextOrCounts === 'string' ? queryCounts(queryTextOrCounts) : (queryTextOrCounts || {});
  const tokens = tokenizeSmartContext(text);
  if (!tokens.length) return 0;
  const seen = new Set();
  let raw = 0;
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (counts[token]) raw += counts[token];
  }
  return raw / Math.sqrt(tokens.length);
}

function memoryKey(memory) {
  return memory?.id || memory?.chapterId || memory?.chapterTitle || JSON.stringify(memory || {});
}

function memoryText(memory) {
  return [
    memory?.chapterTitle,
    memory?.events,
    memory?.relationshipChanges,
    memory?.newFacts,
    memory?.whoKnowsWhat,
    memory?.physicalState,
    memory?.currentLocationTime,
    memory?.openThreads,
  ].filter(Boolean).join(' ');
}

function sampleEvenly(items, count) {
  if (count <= 0 || !items.length) return [];
  if (items.length <= count) return items.slice();
  const picked = [];
  const used = new Set();
  for (let i = 0; i < count; i += 1) {
    const index = Math.round(i * (items.length - 1) / Math.max(1, count - 1));
    if (!used.has(index)) {
      used.add(index);
      picked.push(items[index]);
    }
  }
  return picked;
}

export function buildSmartContextQuery({
  instructions = '',
  allowedCast = '',
  requiredEnding = '',
  scenePlan = [],
  blockNotes = '',
  liveText = '',
} = {}) {
  const recentLiveText = String(liveText || '').slice(-7000);
  return [
    instructions,
    allowedCast,
    requiredEnding,
    Array.isArray(scenePlan) ? scenePlan.join(' ') : scenePlan,
    blockNotes,
    recentLiveText,
  ].filter(Boolean).join(' ');
}

export function selectSmartMemories(memoryEntries, queryText, {
  maxSelected = 12,
  foundationCount = 3,
  recentCount = 4,
} = {}) {
  const chronological = (memoryEntries || []).filter(Boolean).slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const total = chronological.length;
  const counts = queryCounts(queryText);
  const scoreOf = (memory) => scoreSmartText(memoryText(memory), counts);

  if (total <= maxSelected) {
    return {
      selected: chronological,
      details: chronological.map((memory) => ({
        id:memory.id || memory.chapterId,
        chapterId:memory.chapterId,
        chapterTitle:memory.chapterTitle || 'sin título',
        score:scoreOf(memory),
        reason:'historial completo',
      })),
      total,
      omitted:0,
      queryTerms:Object.keys(counts),
    };
  }

  const required = new Map();
  chronological.slice(0, foundationCount).forEach((memory) => {
    required.set(memoryKey(memory), { memory, reason:'fundacional' });
  });
  chronological.slice(-recentCount).forEach((memory) => {
    const key = memoryKey(memory);
    const prior = required.get(key);
    required.set(key, {
      memory,
      reason: prior ? 'fundacional + reciente' : 'reciente',
    });
  });

  const middle = chronological.filter((memory) => !required.has(memoryKey(memory)));
  const ranked = middle.map((memory) => ({ memory, score:scoreOf(memory) }))
    .sort((a,b) => b.score - a.score || String(b.memory.createdAt || '').localeCompare(String(a.memory.createdAt || '')));

  const slots = Math.max(0, maxSelected - required.size);
  const relevant = ranked.filter((item) => item.score > 0).slice(0, slots);
  const chosen = new Map(required);
  for (const item of relevant) {
    chosen.set(memoryKey(item.memory), { memory:item.memory, reason:'relevante', score:item.score });
  }

  const remainingSlots = Math.max(0, maxSelected - chosen.size);
  if (remainingSlots) {
    const leftover = middle.filter((memory) => !chosen.has(memoryKey(memory)));
    for (const memory of sampleEvenly(leftover, remainingSlots)) {
      chosen.set(memoryKey(memory), { memory, reason:'cobertura temporal', score:scoreOf(memory) });
    }
  }

  const selected = chronological.filter((memory) => chosen.has(memoryKey(memory)));
  const details = selected.map((memory) => {
    const item = chosen.get(memoryKey(memory));
    return {
      id:memory.id || memory.chapterId,
      chapterId:memory.chapterId,
      chapterTitle:memory.chapterTitle || 'sin título',
      score:Number.isFinite(item?.score) ? item.score : scoreOf(memory),
      reason:item?.reason || 'seleccionada',
    };
  });

  return {
    selected,
    details,
    total,
    omitted:Math.max(0,total-selected.length),
    queryTerms:Object.keys(counts),
  };
}

export function rankCanonNotes(canonNotes, queryText) {
  const counts = queryCounts(queryText);
  return (canonNotes || []).filter(Boolean).map((note) => ({
    id:note.id,
    text:String(note.text || '').trim(),
    score:scoreSmartText(note.text, counts),
  })).sort((a,b) => b.score - a.score);
}

export function canonQueryBoost(canonNotes, queryText, maxNotes = 4) {
  return rankCanonNotes(canonNotes, queryText)
    .filter((item) => item.score > 0)
    .slice(0, maxNotes)
    .map((item) => item.text)
    .join(' ');
}
