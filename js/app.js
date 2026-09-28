import { db } from './db.js';
import { renderWrite } from './ui/write.js?v=20260928-economy-mini-v1';
import { renderChapters } from './ui/chapters.js?v=20260928-economy-mini-v1';
import { renderCharacters } from './ui/characters.js?v=20260926-spanish-ui-v1';
import { renderDocuments } from './ui/documents.js?v=20260926-spanish-ui-v1';
import { renderMemory } from './ui/memory.js?v=20260928-chapter-variants-v1';
import { renderSettings } from './ui/settings.js?v=20260928-economy-mini-v1';
import { renderPlanner } from './ui/planner.js?v=20260928-economy-mini-v1';
import { bus, toast } from './utils.js';
import { getActiveGenerationState } from './generation.js?v=20260928-economy-mini-v1';
import { initAppearance } from './ui/appearance.js';

const VIEWS = { write: renderWrite, planner: renderPlanner, chapters: renderChapters, characters: renderCharacters, documents: renderDocuments, memory: renderMemory, settings: renderSettings };
async function seedDefaults() {
  const facts = await db.getAll('lockedFacts');
  if (facts.length === 0) {
    await db.put('lockedFacts', { text: 'Levi es mujer en este AU. Usa SIEMPRE pronombres she/her (ella/la) para Levi. Nunca uses he/him/his ni términos masculinos (hombre, esposo, novio, hijo) para referirte a Levi. Esas palabras sí pueden usarse para otros personajes masculinos en la misma frase.', isCore: true });
    await db.put('lockedFacts', { text: 'Hange usa pronombres they/them (elle/su). Nunca uses pronombres binarios (he/she, él/ella) para Hange. Esos pronombres sí pueden referirse a otros personajes cercanos a Hange en la misma frase.', isCore: true });
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
    toast('Historia nueva creada. La original y su memoria siguen intactas.');
  });
}

function switchView(name) { document.querySelectorAll('.view').forEach((v) => v.classList.remove('active')); document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); const el = document.getElementById('view-' + name); el.classList.add('active'); localStorage.setItem('pts_last_view', name); VIEWS[name](el); }
function initNav() { document.getElementById('tabbar').addEventListener('click', (e) => { const btn = e.target.closest('.tab-btn'); if (!btn) return; switchView(btn.dataset.view); }); bus.on('navigate', (name) => switchView(name)); }
async function initServiceWorker() { if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch { } } }
async function boot() { await db.openDb(); await seedDefaults(); initNav(); await initWorkspaces(); initServiceWorker(); const last = localStorage.getItem('pts_last_view') || 'write'; switchView(VIEWS[last] ? last : 'write'); }
initAppearance();
boot();
