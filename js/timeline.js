// timeline.js — helpers for chapter alternatives / active story continuity.
//
// Legacy chapters have no branchRole and are therefore part of the main story.
// Alternative chapters stay saved and editable, but are ignored by continuity,
// planning and "download all" until the author promotes one.

export function isMainTimelineChapter(chapter) {
  return !!chapter && chapter.branchRole !== 'alternative';
}

export function activeChapterIds(chapters) {
  return new Set((chapters || []).filter(isMainTimelineChapter).map((chapter) => chapter.id));
}

export function filterActiveMemories(memories, chapters) {
  const activeIds = activeChapterIds(chapters);
  return (memories || []).filter((memory) => memory?.chapterId && activeIds.has(memory.chapterId));
}

export function sortChaptersWithVariants(chapters) {
  return [...(chapters || [])].sort((a, b) => {
    const orderDiff = (a.order ?? 0) - (b.order ?? 0);
    if (orderDiff) return orderDiff;

    const groupA = a.branchGroupId || a.id;
    const groupB = b.branchGroupId || b.id;
    if (groupA !== groupB) {
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    }

    const roleA = isMainTimelineChapter(a) ? 0 : 1;
    const roleB = isMainTimelineChapter(b) ? 0 : 1;
    if (roleA !== roleB) return roleA - roleB;

    return String(a.variantLabel || '').localeCompare(String(b.variantLabel || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

export function sortMainTimelineChapters(chapters) {
  return (chapters || [])
    .filter((ch) => isMainTimelineChapter(ch))
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// A chapter may be reopened or an alternative may be drafted in an old slot.
// Future chapters and the main version of the same slot are never past canon.
export function chaptersBefore(chapters, currentChapterId) {
  const all = (chapters || []).filter(Boolean);
  const current = currentChapterId ? all.find((ch) => ch.id === currentChapterId) : null;
  if (currentChapterId && !current) return []; // fail closed on an unknown target
  const scope = current?.projectId || 'original';
  const currentOrder = current ? (current.order ?? 0) : null;
  const currentCreated = current ? String(current.createdAt || '') : '';
  const currentGroup = current?.branchGroupId || '';
  const isAlternativeTarget = current?.branchRole === 'alternative';

  return all.filter((ch) => {
    if (!isMainTimelineChapter(ch)) return false;
    if (ch.id === currentChapterId) return false;
    if (!String(ch.content || '').trim()) return false;
    if (!current) return true;
    if ((ch.projectId || 'original') !== scope) return false;
    if (currentGroup && ch.branchGroupId === currentGroup) return false;
    const chOrder = ch.order ?? 0;
    if (chOrder < currentOrder) return true;
    if (chOrder === currentOrder && !isAlternativeTarget) {
      const chCreated = String(ch.createdAt || '');
      return !!(chCreated && currentCreated && chCreated < currentCreated);
    }
    return false;
  }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// Narrative order, not the timestamp of a later memory regeneration.
export function memoriesForChapters(memories, chapters) {
  const rank = new Map((chapters || []).map((ch, i) => [ch.id, i]));
  const newest = new Map();
  for (const m of memories || []) {
    if (!m || !rank.has(m.chapterId)) continue;
    const ch = chapters[rank.get(m.chapterId)];
    if ((m.projectId || 'original') !== (ch.projectId || 'original')) continue;
    const previous = newest.get(m.chapterId);
    if (!previous || String(m.createdAt || '') >= String(previous.createdAt || ''))
      newest.set(m.chapterId, m);
  }
  return [...newest.values()].sort((a, b) => rank.get(a.chapterId) - rank.get(b.chapterId))
    .map((m) => ({ ...m, chapterOrder: rank.get(m.chapterId) }));
}
