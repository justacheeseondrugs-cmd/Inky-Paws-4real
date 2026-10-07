import { db } from './db.js';
import { renderWrite } from './ui/write.js?v=20261003-armin-onscreen-v1';
import { renderChapters } from './ui/chapters.js?v=20260928-economy-mini-v1';
import { renderCharacters } from './ui/characters.js?v=20260928-author-brain-v1';
import { renderDocuments } from './ui/documents.js?v=20260926-spanish-ui-v1';
import { renderMemory } from './ui/memory.js?v=20261003-canon-scope-v1';
import { renderSettings } from './ui/settings.js?v=20261003-backup-key-guard-v1';
import { renderPlanner } from './ui/planner.js?v=20260928-long-memory-v1';
import { bus, toast } from './utils.js';
import { getActiveGenerationState } from './generation.js?v=20261003-room-cast-canon-v1';
import { initAppearance } from './ui/appearance.js';
import { isPowerToStriveStory } from './storyCast.js?v=20261007-kael-au-v1';
import { ensureKaelAuWorkspace, KAEL_AU_PROJECT } from './kaelAu.js?v=20261007-kael-au-v1';

const VIEWS = { write: renderWrite, planner: renderPlanner, chapters: renderChapters, characters: renderCharacters, documents: renderDocuments, memory: renderMemory, settings: renderSettings };

const POWER_TO_STRIVE_DEFAULT_FACTS = [
  'Levi es mujer en este AU. Usa SIEMPRE pronombres she/her (ella/la) para Levi. Nunca uses he/him/his ni términos masculinos (hombre, esposo, novio, hijo) para referirte a Levi. Esas palabras sí pueden usarse para otros personajes masculinos en la misma frase.',
  'Hange usa pronombres they/them (elle/su). Nunca uses pronombres binarios (he/she, él/ella) para Hange. Esos pronombres sí pueden referirse a otros personajes cercanos a Hange en la misma frase.',
];

async function seedDefaults() {
  const projectId = db.getActiveProjectId();
  const facts = await db.getAll('lockedFacts');

  // Power to Strive keeps its AU-specific identity rules. Brand-new stories are
  // deliberately canon-neutral so one story's Levi/Hange assumptions never leak
  // into another fic.
  if (projectId === 'original' && facts.length === 0) {
    for (const text of POWER_TO_STRIVE_DEFAULT_FACTS) {
      await db.put('lockedFacts', { text, isCore:true });
    }
  }

  // Clean up only the exact legacy auto-seeded rules in non-original workspaces.
  // Hand-written or edited canon facts are never touched.
  if (projectId !== 'original') {
    const migrationId = 'neutral-workspace-default-cleanup:' + projectId + ':v1';
    const migration = await db.get('settings', migrationId);
    if (!migration) {
      const legacyDefaults = new Set(POWER_TO_STRIVE_DEFAULT_FACTS);
      for (const fact of facts) {
        if (fact?.isCore === true && legacyDefaults.has(String(fact.text || '').trim())) {
          await db.del('lockedFacts', fact.id);
        }
      }
      await db.put('settings', {
        id:migrationId,
        done:true,
        createdAt:new Date().toISOString(),
      });
    }
  }
  // One-time safety migration: legacy canon notes had no visibility.
  // Treat them as PRIVATE AUTHOR CANON so old future-summary material never
  // becomes automatic character knowledge.
  const canonVisibilityMigrationId='canon-visibility:'+projectId+':v1';
  if(!(await db.get('settings',canonVisibilityMigrationId))){
    const legacyCanon=await db.getAll('canonNotes');
    for(const note of legacyCanon){
      if(!note.visibility){
        note.visibility='private';
        await db.put('canonNotes',note);
      }
    }
    await db.put('settings',{id:canonVisibilityMigrationId,done:true,createdAt:new Date().toISOString()});
  }

  const settings = await db.get('settings', 'main');
  if (!settings) {
    await db.put('settings', { id:'main', provider:'gemini', apiKeys:{gemini:'',openai:''}, models:{gemini:'gemini-2.0-flash',openai:'gpt-5.4-mini'}, blockWordSize:1000, defaultGenerationMode:'full_chapter', economyMiniMigration20260928:true, fullChapterMigration20260928:true });
  } else if (!settings.economyMiniMigration20260928) {
    const currentOpenAI = String(settings.models?.openai || '').trim().toLowerCase();
    // One-time personal-app migration requested by the author: move an
    // existing GPT-5.6 Sol setting back to the much cheaper GPT-5.4 Mini.
    // The flag prevents us from overriding a future manual switch back to Sol.
    if (/^gpt-5[._-]6-sol(?:$|[-.])/i.test(currentOpenAI)) {
      settings.models = { ...(settings.models || {}), openai:'gpt-5.4-mini' };
    } else if (!currentOpenAI) {
      settings.models = { ...(settings.models || {}), openai:'gpt-5.4-mini' };
    }
    settings.economyMiniMigration20260928 = true;
    await db.put('settings', settings);
  }
  const refreshedSettings = await db.get('settings', 'main');
  if (refreshedSettings && !refreshedSettings.fullChapterMigration20260928) {
    if (!Number(refreshedSettings.blockWordSize) || Number(refreshedSettings.blockWordSize) < 1000) {
      refreshedSettings.blockWordSize = 1000;
    }
    refreshedSettings.defaultGenerationMode = refreshedSettings.defaultGenerationMode || 'full_chapter';
    refreshedSettings.fullChapterMigration20260928 = true;
    await db.put('settings', refreshedSettings);
  }

  // Repair the one legacy character-sheet typo so the automatic room cast
  // can use the canonical full name without special cases.
  if(isPowerToStriveStory(projectId,facts)){
    const nameFixId='character-name-fix:'+projectId+':armin-arlert-v2';
    if(!(await db.get('settings',nameFixId))){
      const characters=await db.getAll('characters');
      const armin=characters.find((character)=>String(character.name || '').trim().toLowerCase()==='armin arlet');
      if(armin){
        armin.name='Armin Arlert';
        await db.put('characters',armin);
      }
      await db.put('settings',{id:nameFixId,done:true,createdAt:new Date().toISOString()});
    }
  }

  // One-time chemistry seed for the author's original Power to Strive workspace.
  // Never overwrite hand-written chemistry and never inject these AU dynamics into
  // a different workspace/story.
  if (db.getActiveProjectId() === 'original') {
    const markerId = 'author-chemistry-seed:original-v1';
    const marker = await db.get('settings', markerId);
    if (!marker) {
      const chemistry = {
        levi:'With Joseph, Levi tolerates dry insolence she would cut off in others; their intimacy is practical, habitual and secure, often visible in tiny corrections, shared routines and the fact that neither performs the relationship. With Erwin, old history creates compressed familiarity and dangerous shorthand; she resists being publicly interpreted. With Hange, irritation and trust coexist: Hange can recognize embarrassment and deliberately make it worse.',
        joseph:'With Levi, Joseph is dry, composed and provocatively familiar without needing reassurance; he knows which threats are real, which silences mean stop, and when not to expose her. With Anya, he is an easy, steady father who can be amused without turning her into a joke. Around Erwin, he is secure rather than jealous: old history is something he knows, not a competition.',
        erwin:'With Levi, Erwin has unusually deep history and shorthand; he can read small shifts others miss, but public personal exposure can knock him half a step off his command rhythm. He does not turn that history into a current romantic contest. With Joseph, he is measured and observant rather than territorial.',
        hange:'With Levi, Hange has earned the right to notice too much and enjoys social disasters involving her, but knows more than the younger cast and should not casually dump that knowledge. In the room, they escalate through curiosity, badly timed delight and interruptions rather than long analytical speeches.',
        petra:'With Levi, Petra notices tells, habits and practical behavior because she has served under her closely. Her reactions should often begin with a concrete observation before emotion catches up.',
        jean:'Jean tends to blurt the socially dangerous implication before everyone is ready for it, then has to live with the consequences. He is skeptical but not stupid and can become sincere when a reveal actually lands.',
        connie:'Connie asks the simple or invasive question everyone else had enough sense not to say. He is often accidentally useful because his confusion exposes the obvious social implication.',
        sasha:'Sasha reacts sincerely and literally. Her questions can detonate a room because she asks them without strategic embarrassment, not because she is trying to be cruel.',
        armin:'Armin connects evidence quickly, but should do it in compact observations and questions rather than detective lectures. Let him be interrupted before he can turn insight into a seminar.',
        mikasa:'Mikasa is restrained and direct. She notices protection, body mechanics and who moves toward whom under stress; she rarely needs many words to make the observation land.',
        ymir:'Ymir reads social discomfort faster than most of the room and enjoys watching people squirm. Her sharpness works best in short lines, side comments and knowing looks, not explanatory monologues.',
        historia:'Historia is emotionally attentive, especially around children and vulnerability. She notices hurt without turning every moment into a speech and often softens the social temperature by asking one sincere question.',
        eren:'Eren reacts from conviction and confusion more than social finesse. He can miss private implications that others catch, which makes his blunt questions useful when the room gets too clever.'
      };
      const characters = await db.getAll('characters');
      for (const character of characters) {
        const key = String(character.name || '').trim().toLowerCase();
        if (!character.chemistry && chemistry[key]) {
          character.chemistry = chemistry[key];
          await db.put('characters',character);
        }
      }
      await db.put('settings',{id:markerId,done:true,createdAt:new Date().toISOString()});
    }
  }
}

const ORIGINAL = { id:'original', name:'Historia original (mis datos actuales)' };
async function loadWorkspaces() {
  const saved = await db.get('settings','workspaces');
  return [ORIGINAL,...(saved?.items || []).filter((p) => p.id && p.id !== ORIGINAL.id)];
}
async function renderWorkspaces() {
  const select = document.getElementById('workspace-select');
  if (!select) return;
  const list = await loadWorkspaces();
  select.innerHTML = list.map((p) => {
    const option = document.createElement('option');
    option.value = p.id; option.textContent = p.name;
    return option.outerHTML;
  }).join('');
  if (!list.some((p) => p.id === db.getActiveProjectId())) db.setActiveProjectId(ORIGINAL.id);
  select.value = db.getActiveProjectId();
  document.getElementById('workspace-label').textContent = list.find((p) => p.id === select.value)?.name || ORIGINAL.name;
}

function cleanStoryPackCharacter(raw) {
  const fields = ['name','pronouns','personality','speechStyle','hardRules','currentKnowledge','relationships','chemistry','neverDoRules','active'];
  const out = {};
  for (const field of fields) if (raw && raw[field] !== undefined) out[field] = raw[field];
  out.name = String(out.name || '').trim();
  out.pronouns = String(out.pronouns || '').trim();
  out.personality = String(out.personality || '').trim();
  out.speechStyle = String(out.speechStyle || '').trim();
  out.hardRules = String(out.hardRules || '').trim();
  out.currentKnowledge = String(out.currentKnowledge || '').trim();
  out.relationships = String(out.relationships || '').trim();
  out.chemistry = String(out.chemistry || '').trim();
  out.neverDoRules = String(out.neverDoRules || '').trim();
  out.active = out.active !== false;
  return out;
}

async function importStoryPackFile(file) {
  const projectId = db.getActiveProjectId();
  if (projectId === 'original') throw new Error('Crea o selecciona primero una historia nueva. El importador de packs nunca escribe sobre la historia original.');
  const text = await file.text();
  const pack = JSON.parse(text);
  const meta = pack?.__meta || pack?.meta || {};
  if (meta.app && !['inky-paws-story-pack','pts-story-pack'].includes(String(meta.app))) {
    throw new Error('Este JSON no parece un pack de historia de Inky Paws.');
  }

  const existingCharacters = await db.getAll('characters');
  const existingFacts = await db.getAll('lockedFacts');
  const existingCanon = await db.getAll('canonNotes');
  const characterByName = new Map(existingCharacters.map((c) => [String(c.name || '').trim().toLowerCase(), c]));
  const factTexts = new Set(existingFacts.map((f) => String(f.text || '').trim()));
  const canonKeys = new Set(existingCanon.map((n) => (n.visibility === 'revealed' ? 'revealed|' : 'private|') + String(n.text || '').trim()));

  let characters = 0, facts = 0, canon = 0;
  for (const raw of Array.isArray(pack.characters) ? pack.characters : []) {
    const incoming = cleanStoryPackCharacter(raw);
    if (!incoming.name) continue;
    const key = incoming.name.toLowerCase();
    const previous = characterByName.get(key);
    const saved = await db.put('characters', previous ? { ...previous, ...incoming, id:previous.id } : incoming);
    characterByName.set(key, saved);
    characters += 1;
  }

  for (const raw of Array.isArray(pack.lockedFacts) ? pack.lockedFacts : []) {
    const textValue = String(typeof raw === 'string' ? raw : raw?.text || '').trim();
    if (!textValue || factTexts.has(textValue)) continue;
    await db.put('lockedFacts', { text:textValue, isCore:typeof raw === 'object' ? raw?.isCore === true : false });
    factTexts.add(textValue);
    facts += 1;
  }

  for (const raw of Array.isArray(pack.canonNotes) ? pack.canonNotes : []) {
    const textValue = String(typeof raw === 'string' ? raw : raw?.text || '').trim();
    if (!textValue) continue;
    const visibility = typeof raw === 'object' && raw?.visibility === 'revealed' ? 'revealed' : 'private';
    const key = visibility + '|' + textValue;
    if (canonKeys.has(key)) continue;
    await db.put('canonNotes', { text:textValue, visibility, createdAt:new Date().toISOString() });
    canonKeys.add(key);
    canon += 1;
  }

  if (pack.authorBrain && typeof pack.authorBrain === 'object') {
    const current = await db.get('settings', 'author-brain:' + projectId);
    await db.put('settings', {
      ...(current || {}),
      ...pack.authorBrain,
      id:'author-brain:' + projectId,
      feedbackCounts:current?.feedbackCounts || pack.authorBrain.feedbackCounts || {},
      editSignals:current?.editSignals || pack.authorBrain.editSignals || { approvals:0, substantialEdits:0, totalReduction:0 },
    });
  }

  return { characters, facts, canon, title:String(meta.title || pack.title || '').trim() };
}

async function initWorkspaces() {
  const select = document.getElementById('workspace-select');
  await renderWorkspaces();
  select.addEventListener('change', async () => {
    const old = db.getActiveProjectId();
    const active = await getActiveGenerationState();
    if (active?.status === 'in_progress') {
      select.value = old;
      toast('Termina, detén o descarta primero el bloque que se está generando.', { error:true, ms:6500 });
      return;
    }
    db.setActiveProjectId(select.value);
    await seedDefaults();
    await renderWorkspaces();
    switchView('chapters');
    toast('Historia cambiada. Solo verás los datos de este proyecto.');
  });
  document.getElementById('workspace-create').addEventListener('click', async () => {
    const active = await getActiveGenerationState();
    if (active?.status === 'in_progress') return toast('Detén primero la generación en curso.', {error:true});
    const name = window.prompt('Nombre de la nueva historia (no se copiarán capítulos ni documentos):');
    if (!name?.trim()) return;
    const saved = await db.get('settings','workspaces') || {id:'workspaces',items:[]};
    const project = { id:db.uid(),name:name.trim().slice(0,90) };
    saved.items.push(project);
    await db.put('settings',saved);
    db.setActiveProjectId(project.id);
    await seedDefaults();
    await renderWorkspaces();
    switchView('chapters');
    toast('Historia nueva creada con canon neutral. La original y su memoria siguen intactas.');
  });

  const packButton = document.getElementById('workspace-import-pack');
  const packInput = document.getElementById('workspace-pack-input');
  packButton?.addEventListener('click', async () => {
    const active = await getActiveGenerationState();
    if (active?.status === 'in_progress') return toast('Detén primero la generación en curso.', {error:true});
    if (db.getActiveProjectId() === 'original') return toast('Crea o selecciona una historia nueva antes de importar un pack. La historia original está protegida.', {error:true, ms:6500});
    packInput?.click();
  });
  packInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const workspaceName = document.getElementById('workspace-label')?.textContent?.trim() || 'esta historia';
    if (!confirm('Importar este pack dentro de “' + workspaceName + '”? Se mezclarán fichas y canon SOLO en esta historia; no se tocará Power to Strive ni otras historias.')) return;
    try {
      const result = await importStoryPackFile(file);
      switchView('characters');
      toast('Pack importado ✨ ' + result.characters + ' personajes · ' + result.facts + ' hechos bloqueados · ' + result.canon + ' notas de canon.', {ms:8000});
    } catch (err) {
      toast('No se pudo importar el pack: ' + (err?.message || err), {error:true, ms:8000});
    }
  });
}

function switchView(name) { document.querySelectorAll('.view').forEach((v) => v.classList.remove('active')); document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); const el = document.getElementById('view-' + name); el.classList.add('active'); localStorage.setItem('pts_last_view', name); VIEWS[name](el); }
function initNav() { document.getElementById('tabbar').addEventListener('click', (e) => { const btn = e.target.closest('.tab-btn'); if (!btn) return; switchView(btn.dataset.view); }); bus.on('navigate', (name) => switchView(name)); }
async function initServiceWorker() { if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch { } } }
async function boot() {
  await db.openDb();
  const kaelCreated = await ensureKaelAuWorkspace(db);
  if (kaelCreated) db.setActiveProjectId(KAEL_AU_PROJECT.id);
  await seedDefaults();
  initNav();
  await initWorkspaces();
  initServiceWorker();
  const last = localStorage.getItem('pts_last_view') || 'write';
  switchView(VIEWS[last] ? last : 'write');
  if (kaelCreated) toast('Kael AU listo ✨ 13 fichas, canon y reglas cargados. Tú sólo escribe el prompt.', {ms:8000});
}
initAppearance();
boot();
