// storyRecall.js — lightweight retrieval over the author's OWN main-timeline
// chapters. No AI call is used: relevant excerpts are selected locally so
// older chapters can remain available without sending every manuscript in full.

const STOPWORDS = new Set(
  'the of and to in a is that it for on with as was were are be this his her she he him they them their from into at by an or if but not no yes do does did have has had will would can could should chapter scene room screen reaction reactions write writing words word story current previous next then than there here who what when where why how one two three four five six seven eight nine ten'.split(' ')
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9\s]/gi, ' ')
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

  const candidates = [];
  for (const chapter of chapters || []) {
    if (!chapter || chapter.id === excludeChapterId || !String(chapter.content || '').trim()) continue;
    for (const chunk of chunkWords(chapter.content, chunkSize)) {
      const s = score(chunk.text, queryCounts);
      if (s > 0) {
        candidates.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title || 'Sin título',
          chapterOrder: chapter.order ?? 0,
          chunkIndex: chunk.index,
          text: chunk.text,
          score: s,
        });
      }
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
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
