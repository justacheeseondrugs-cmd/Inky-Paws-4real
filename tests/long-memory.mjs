// Run with Node 22: node --experimental-default-type=module tests/long-memory.mjs
import assert from 'node:assert/strict';
import { chaptersBefore, memoriesForChapters } from '../js/timeline.js';
import { getRelevantStoryExcerpts } from '../js/storyRecall.js';
import { selectSmartMemories } from '../js/smartContext.js';

const chapters=Array.from({length:100},(_,i)=>({
  id:'c'+(i+1),order:i,projectId:'test',title:'Chapter '+(i+1),
  content:i===6?'A silver strawberry promise. Joseph remembers the ribbon.':
    'Joseph and Levi discussed an ordinary promise in the room.'
}));
chapters.push(
  {id:'alt',order:6,projectId:'test',branchRole:'alternative',content:'not canon'},
  {id:'other',order:3,projectId:'different',content:'other AU'}
);
const prior=chaptersBefore(chapters,'c100');
assert.equal(prior.length,99);
assert.ok(prior.every(c=>c.projectId==='test'&&c.branchRole!=='alternative'));
assert.equal(chaptersBefore(chapters,'c7').length,6);
assert.equal(chaptersBefore(chapters,'alt').length,6);
assert.ok(getRelevantStoryExcerpts(prior,'Remember chapter 7?',{maxExcerpts:3})
  .some(x=>x.chapterId==='c7'&&x.text.includes('silver strawberry')));
assert.ok(getRelevantStoryExcerpts(prior,'silver strawberry ribbon')
  .some(x=>x.chapterId==='c7'));
const memories=prior.map((c,i)=>({
  chapterId:c.id,chapterTitle:c.title,projectId:'test',
  createdAt:i===6?'9999':'2026-'+String(i).padStart(3,'0'),events:c.content
}));
const ordered=memoriesForChapters(memories,prior);
assert.equal(ordered[6].chapterId,'c7');
const chosen=selectSmartMemories(ordered,'silver strawberry ribbon');
assert.equal(chosen.selected.length,12);
assert.ok(chosen.selected.some(x=>x.chapterId==='c7'));
assert.ok(chosen.selected.some(x=>x.chapterId==='c99'));
console.log('PASS: 100-chapter timeline, AU isolation, alternatives, old-chapter retrieval, narrative memory ordering and bounded selection.');
