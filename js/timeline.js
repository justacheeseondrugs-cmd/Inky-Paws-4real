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
