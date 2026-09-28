import { db } from './db.js';

export const DEFAULT_WRITING_DNA = `INKY PAWS — HOUSE WRITING DNA

Write like a confident novelist, not an assistant demonstrating that it understood the prompt.

DRAMATIZE, THEN TRUST THE READER.
- If action, dialogue, silence, body language or timing already communicates an emotion, do not explain that emotion immediately afterward.
- Do not translate gestures into themes. Avoid sentences equivalent to "this showed that...", "the room understood...", "it was proof that...", or "they had learned..."
- Do not end scenes or chapters with a summary of what the characters or reader should conclude.
- Prefer a precise physical action or one dry line over a paragraph of emotional explanation.

CHARACTERS ARE PEOPLE, NOT FUNCTIONS.
- Characters may misunderstand, miss things, interrupt, become distracted, refuse to answer, remember an old joke, or react later.
- Analytical characters connect evidence briefly and naturally; they do not become literary critics, therapists or narrators of the theme.
- Preserve individual speech rhythms. Avoid giving different characters the same polished explanatory voice.
- A character does not say private knowledge aloud merely because the reader would benefit from hearing it.

COMEDY COMES FROM COLLISION.
- Let humor emerge from timing, personality, bad assumptions, interruptions and consequences.
- Do not explain why a joke is funny.
- Do not repeat the same joke until it stops being funny. Let it mutate, return later, or be interrupted.

EMOTION SHOULD HAVE RESISTANCE.
- Tenderness is strongest when the character still sounds like themself.
- Private, guarded or blunt characters should not become eloquent about their feelings simply because the scene is emotional.
- Let affection appear through habit, competence, practical care, annoyance, familiarity and what goes unsaid.
- Avoid sentimental speeches unless the chapter explicitly earns one.

PACING HAS WEIGHT.
- Not every beat deserves equal page time.
- Major revelations may explode outward; bridges should move quickly; texture should stay brief; hooks should arrive before the chapter has exhausted them.
- When a beat has made its point, move.
- Do not turn a prop, gesture or cute detail into a multi-paragraph investigation unless the author explicitly makes it the scene's central subject.

CONTINUITY IS SOCIAL.
- People remember earlier conversations, suspicions, jokes, grudges, promises and embarrassing moments.
- Do not reset relationships to neutral at the start of a new chapter.
- Let old information change how a new moment lands without re-explaining the original event.

PROSE RHYTHM.
- Use polished novel prose with varied paragraph length, clean transitions, interiority when useful, and dialogue braided with action.
- Avoid repetitive dramatic constructions, especially repeated "the room went silent/froze/held its breath" resets.
- Avoid generic AI cadence, symmetrical mini-essays, moral-of-the-scene conclusions and ornate metaphors that draw attention away from character.
- Leave some edges rough. A living scene does not resolve every question before moving on.`;

export const FEEDBACK_OPTIONS = [
  ['too_explanatory','🧠 Too explanatory'],
  ['too_slow','🐌 Too slow'],
  ['wrong_voice','🎭 Wrong voice'],
  ['not_chaotic','💥 Not chaotic enough'],
  ['repetitive','🔁 Repetitive'],
  ['too_sentimental','💗 Too sentimental'],
  ['too_neat','🧹 Too neat / resolved'],
];

const FEEDBACK_RULES = {
  too_explanatory:'The author repeatedly trims explanatory interpretation. Show the beat and trust the reader; do not explain what a gesture, silence or reaction means after it already landed.',
  too_slow:'The author repeatedly trims pacing drag. Spend words on change, conflict, chemistry or consequence; compress bridges and move once a beat has landed.',
  wrong_voice:'The author is sensitive to voice drift. Prefer character-specific bluntness, evasions, habits and imperfect speech over polished generic dialogue.',
  not_chaotic:'The author wants more social collision in ensemble scenes: interruptions, cross-talk, unfinished questions and new developments arriving before old reactions are resolved.',
  repetitive:'The author removes repeated reactions, restatements and duplicated emotional conclusions. Say or show a point once, then let the story move.',
  too_sentimental:'The author prefers restrained affection and subtext. Keep guarded characters guarded; practical care usually lands harder than speeches.',
  too_neat:'The author prefers unresolved social texture. Do not tidy every misunderstanding, question or tension before advancing the scene.',
};

const BOMB_WORDS = /\b(reveal|reveals|revealed|discover|discovers|discovered|confess|confesses|secret|truth|mama|papa|mother|father|wife|husband|married|kiss|betray|betrayal|death|dies|dead|identity|pregnan|return|returns|arrive|arrives|appears|recognize|recognises|realizes|realises|calls? him|calls? her)\b/i;
const TEXTURE_WORDS = /\b(brief|small|quick|little|texture|domestic|quiet moment|aside|joke|tease|teasing|transition|walk|walking|move|moving)\b/i;

export async function getAuthorBrain() {
  const id = 'author-brain:' + db.getActiveProjectId();
  const stored = await db.get('settings', id);
  return {
    id,
    writingDna: stored?.writingDna || DEFAULT_WRITING_DNA,
    prepEnabled: stored?.prepEnabled !== false,
    feedbackCounts: stored?.feedbackCounts || {},
    editSignals: stored?.editSignals || { approvals:0, substantialEdits:0, totalReduction:0 },
  };
}

export async function saveAuthorBrain(next) {
  const current = await getAuthorBrain();
  return db.put('settings', {
    ...current,
    ...next,
    id: current.id,
  });
}

export async function recordAuthorFeedback(tag) {
  if (!FEEDBACK_RULES[tag]) return null;
  const brain = await getAuthorBrain();
  brain.feedbackCounts = { ...brain.feedbackCounts, [tag]:(brain.feedbackCounts[tag] || 0) + 1 };
  await saveAuthorBrain(brain);
  return brain;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export async function recordEditSignal(originalText, editedText) {
  const original = wordCount(originalText);
  const edited = wordCount(editedText);
  if (!original || !edited) return null;
  const brain = await getAuthorBrain();
  const signals = { approvals:0, substantialEdits:0, totalReduction:0, ...(brain.editSignals || {}) };
  signals.approvals += 1;
  const delta = (edited - original) / original;
  if (Math.abs(delta) >= 0.08) signals.substantialEdits += 1;
  if (delta < 0) signals.totalReduction += Math.abs(delta);
  brain.editSignals = signals;
  await saveAuthorBrain(brain);
  return brain;
}

export function feedbackGuidance(brain) {
  const counts = brain?.feedbackCounts || {};
  const ranked = Object.entries(counts)
    .filter(([tag,count]) => FEEDBACK_RULES[tag] && count > 0)
    .sort((a,b) => b[1] - a[1])
    .slice(0,4);
  const lines = ranked.map(([tag,count]) => '- '+FEEDBACK_RULES[tag]+' (author flagged this '+count+'×)');
  const signals = brain?.editSignals || {};
  if ((signals.approvals || 0) >= 3 && (signals.substantialEdits || 0) / signals.approvals >= .5) {
    lines.push('- The author often makes substantial edits before approval. Treat the draft as prose that must earn every paragraph; avoid padding and generic connective explanation.');
  }
  if ((signals.approvals || 0) >= 3 && (signals.totalReduction || 0) / signals.approvals >= .08) {
    lines.push('- The author frequently shortens drafts. Bias toward tighter phrasing and earlier movement.');
  }
  return lines.length ? 'LEARNED AUTHOR TASTE FROM PAST FEEDBACK:\n'+lines.join('\n') : '';
}

export function chemistryGuidance(characters) {
  const relevant = (characters || []).filter((c) => String(c.chemistry || '').trim());
  if (!relevant.length) return '';
  return 'RELATIONSHIP CHEMISTRY — how these people change around others:\n' +
    relevant.map((c) => '- '+c.name+': '+c.chemistry.trim()).join('\n');
}

function explicitPressureTag(beat) {
  const m = String(beat || '').match(/^\s*\[(BOMB|BRIDGE|TEXTURE|HOOK)\]\s*/i);
  return m ? m[1].toUpperCase() : '';
}

export function buildPressureMap(scenePlan = [], requiredEnding = '') {
  if (!Array.isArray(scenePlan) || !scenePlan.length) {
    return requiredEnding
      ? 'CHAPTER PRESSURE MAP:\n- HOOK / LANDING: '+requiredEnding+'\nKeep intermediate material proportionate; do not spend the climax budget on setup.'
      : '';
  }
  const mapped = scenePlan.map((raw,i) => {
    const beat = String(raw || '').replace(/^\s*\[(BOMB|BRIDGE|TEXTURE|HOOK)\]\s*/i,'').trim();
    const explicit = explicitPressureTag(raw);
    let weight = explicit;
    if (!weight) {
      if (i === scenePlan.length - 1 && requiredEnding) weight = 'HOOK';
      else if (BOMB_WORDS.test(beat) || /!{2,}/.test(beat) || /\b(MUST|IMPORTANT|MAJOR)\b/.test(raw)) weight = 'BOMB';
      else if (TEXTURE_WORDS.test(beat)) weight = 'TEXTURE';
      else weight = i === 0 ? 'BRIDGE' : 'ESCALATE';
    }
    const instruction = weight === 'BOMB'
      ? 'let consequences collide; do not instantly explain or resolve'
      : weight === 'TEXTURE'
        ? 'keep brief; one vivid exchange/action can be enough'
        : weight === 'BRIDGE'
          ? 'move efficiently into the real pressure'
          : weight === 'HOOK'
            ? 'arrive with energy still alive; stop before over-explaining'
            : 'increase pressure without pretending this is the climax';
    return (i+1)+'. '+weight+' — '+beat+' → '+instruction;
  });
  if (requiredEnding && !mapped.some((line) => line.includes(requiredEnding))) {
    mapped.push('FINAL. HOOK / LANDING — '+requiredEnding+' → reach this before stopping; do not exhaust it with post-reveal analysis.');
  }
  return 'CHAPTER PRESSURE MAP (weight beats differently; this is NOT a checklist):\n'+mapped.join('\n');
}

export function compactAuthorBrief(brief) {
  if (!brief) return '';
  const lines = [];
  if (brief.pressureMap) lines.push('Pressure: '+brief.pressureMap);
  if (brief.activeThreads) lines.push('Active threads: '+brief.activeThreads);
  if (brief.chemistryFocus) lines.push('Chemistry focus: '+brief.chemistryFocus);
  if (brief.pacingRisks) lines.push('Pacing risks: '+brief.pacingRisks);
  if (brief.doNotOverplay) lines.push('Do not overplay: '+brief.doNotOverplay);
  return lines.length ? 'INKY PRE-FLIGHT EDITORIAL BRIEF:\n'+lines.map((x)=>'- '+x).join('\n') : '';
}

export function buildAuthorGuidance({ brain, characters, scenePlan, requiredEnding, authorBrief }) {
  return [
    brain?.writingDna ? 'AUTHOR WRITING DNA — persistent house taste:\n'+brain.writingDna.trim() : '',
    chemistryGuidance(characters),
    feedbackGuidance(brain),
    buildPressureMap(scenePlan, requiredEnding),
    compactAuthorBrief(authorBrief),
  ].filter(Boolean).join('\n\n');
}

export function authorBriefJsonInstruction() {
  return `Act as Inky Paws' pre-flight story editor. Do NOT write prose and do NOT invent new canon.
Return ONLY valid JSON with these exact string keys:
{
  "pressureMap": "",
  "activeThreads": "",
  "chemistryFocus": "",
  "pacingRisks": "",
  "doNotOverplay": ""
}
pressureMap: identify which planned beats are true bombs, bridges, texture and the final hook; keep it concise.
activeThreads: list unresolved questions, suspicions, jokes, secrets, awkwardness or promises from prior continuity that can remain alive during this chapter.
chemistryFocus: identify the 2-4 relationship dynamics most useful to the requested chapter, without inventing feelings or history.
pacingRisks: name likely ways this specific plan could become slow, checklist-like, repetitive or over-explained.
doNotOverplay: identify props/details/reveals that should land and move rather than consume disproportionate page time.
Use only supplied canon, memories, character sheets and chapter instructions.`;
}

export function parseAuthorBrief(text) {
  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);
    return {
      pressureMap:String(obj.pressureMap || '').trim(),
      activeThreads:String(obj.activeThreads || '').trim(),
      chemistryFocus:String(obj.chemistryFocus || '').trim(),
      pacingRisks:String(obj.pacingRisks || '').trim(),
      doNotOverplay:String(obj.doNotOverplay || '').trim(),
    };
  } catch {
    return null;
  }
}
