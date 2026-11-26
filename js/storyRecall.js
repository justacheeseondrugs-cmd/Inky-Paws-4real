// storyRecall.js — lightweight retrieval over the author's OWN main-timeline
// chapters. No AI call is used: relevant excerpts are selected locally so
// older chapters can remain available without sending every manuscript in full.

const STOPWORDS = new Set(
  ('the of and to in a is that it for on with as was were are be this his her she he him they them their from into at by an or if but not no yes do does did have has had will would can could should chapter scene room screen reaction reactions write writing words word story current previous next then than there here who what when where why how one two three four five six seven eight nine ten ' +
   'de la que el en y a los se del las un por con una su para es al lo como mas o pero sus le ya fue este esta estos estas ha hay si porque entre cuando muy sin sobre tambien me hasta donde quien desde todo todos uno unos unas otro otra otros otras ellos ellas nosotros nosotras mi mis tu tus capitulo escena historia').split(' ')
);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Explicit references are prioritized over common character-name matches.
export function requestedChapterNumbers(query) {
  const normalized = normalize(query);
  return new Set([...normalized.matchAll(/\b(?:chapters?|capitulos?|cap\.?|ch\.?)\s*#?\s*(\d{1,5})\b/gi)]
    .map((m) => Number(m[1])).filter((n) => n > 0));
}

export function isPrologueTitle(title) {
  return /^\s*(?:prologue|prologo)\b/i.test(normalize(title).trim());
}

export function chapterNumberFromTitle(title) {
  const cleaned = normalize(title).trim();
  if (!cleaned || isPrologueTitle(cleaned)) return null;
  const labeled = cleaned.match(/\b(?:chapters?|capitulos?|cap\.?|ch\.?)\s*#?\s*(\d{1,5})\b/i);
  if (labeled) return Number(labeled[1]);
  const leading = cleaned.match(/^#?\s*(\d{1,5})(?:\s*[:.\-—–]|\s+$|$)/);
  if (leading) return Number(leading[1]);
  return null;
}

export function requestsPrologue(query) {
  return /\b(?:prologue|prologo)\b/i.test(normalize(query));
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9ñü\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function chunkWords(text, size = 340, overlap = 70) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const chunks = [];
  const step = Math.max(80, size - overlap);
  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + size);
    if (!slice.length) break;
    chunks.push({ index: chunks.length, text: slice.join(' '), wordCount: slice.length });
    if (i + size >= words.length) break;
  }
  return chunks;
}

function score(text, queryCounts) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  const seen = new Set();
  let raw = 0;
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (queryCounts[token]) raw += queryCounts[token];
  }
  return raw / Math.sqrt(tokens.length);
}

export function getRelevantStoryExcerpts(
  chapters,
  queryText,
  { excludeChapterId = '', maxExcerpts = 5, maxPerChapter = 2, chunkSize = 340 } = {}
) {
  const queryTokens = tokenize(queryText);
  const queryCounts = {};
  for (const token of queryTokens) queryCounts[token] = (queryCounts[token] || 0) + 1;

  if (maxExcerpts <= 0 || maxPerChapter <= 0) return [];
  const requested = requestedChapterNumbers(queryText);
  const wantsPrologue = requestsPrologue(queryText);
  const ordered = (chapters || []).filter((ch) => ch && ch.branchRole !== 'alternative')
    .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  // Resolve explicit numbers from titles first so prologues, empty drafts or
  // skipped chapter numbers never shift chapter lookups by ±1.
  let numberedPos = 0;
  const annotated = ordered.map((chapter) => {
    const prologue = isPrologueTitle(chapter.title);
    const titleNum = chapterNumberFromTitle(chapter.title);
    if (!prologue) numberedPos += 1;
    return { chapter, prologue, titleNum, fallbackNum: prologue ? null : numberedPos };
  });
  const explicitTitleNums = new Set(annotated.map((item) => item.titleNum).filter((n) => n !== null));

  const candidates = [];
  for (const { chapter, prologue, titleNum, fallbackNum } of annotated) {
    if (!chapter || chapter.id === excludeChapterId || !String(chapter.content || '').trim()) continue;
    const explicit =
      (wantsPrologue && prologue) ||
      (titleNum !== null && requested.has(titleNum)) ||
      (titleNum === null && fallbackNum !== null && requested.has(fallbackNum) && !explicitTitleNums.has(fallbackNum));
    for (const chunk of chunkWords(chapter.content, chunkSize)) {
      const s = score(chunk.text, queryCounts);
      if (s > 0 || explicit) {
        candidates.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title || 'Sin título',
          chapterOrder: chapter.order ?? 0,
          chunkIndex: chunk.index,
          text: chunk.text,
          score: s,
          explicit,
        });
      }
    }
  }

  candidates.sort((a, b) =>
    Number(b.explicit) - Number(a.explicit) || b.score - a.score ||
    (b.chapterOrder ?? 0) - (a.chapterOrder ?? 0) ||
    a.chunkIndex - b.chunkIndex
  );

  const perChapter = new Map();
  const selected = [];
  for (const item of candidates) {
    const used = perChapter.get(item.chapterId) || 0;
    if (used >= maxPerChapter) continue;
    selected.push(item);
    perChapter.set(item.chapterId, used + 1);
    if (selected.length >= maxExcerpts) break;
  }

  // Keep selected excerpts in story order after relevance has chosen them.
  return selected.sort((a, b) =>
    (a.chapterOrder ?? 0) - (b.chapterOrder ?? 0) ||
    a.chunkIndex - b.chunkIndex
  );
}

export function getPreviousChapterEnding(chapters, currentChapterId = '', charCap = 4200) {
  const eligible = (chapters || [])
    .filter((chapter) => chapter?.id !== currentChapterId && String(chapter?.content || '').trim())
    .slice()
    .sort((a, b) =>
      (a.order ?? 0) - (b.order ?? 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    );
  const previous = eligible[eligible.length - 1];
  if (!previous) return { title: '', text: '' };
  return {
    title: previous.title || 'capítulo anterior',
    text: String(previous.content || '').slice(-charCap),
  };
}
