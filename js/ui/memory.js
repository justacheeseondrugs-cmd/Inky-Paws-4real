import { db } from '../db.js';
import { escapeHtml, toast, fmtDate, openModal, closeModal } from '../utils.js';
import { filterActiveMemories } from '../timeline.js?v=20260928-chapter-variants-v1';

export async function renderMemory(root) {
  const [lockedFacts, canonNotes, allMemoryEntries, chapters] = await Promise.all([db.getAll('lockedFacts'), db.getAll('canonNotes'), db.getAll('memoryEntries'), db.getAll('chapters')]);
  const memoryEntries = filterActiveMemories(allMemoryEntries, chapters).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  root.innerHTML = `<h2 class="section-title">Memoria</h2><p class="section-hint">Hechos bloqueados, canon separado por visibilidad y memoria de continuidad generada tras cada capítulo.</p><div class="card"><h3>🔒 Hechos bloqueados — máxima prioridad</h3><p class="muted">Se reinsertan siempre, aunque otro documento los contradiga.</p><div id="locked-list"></div><label class="field-label">Añadir hecho bloqueado</label><div class="card-row" style="gap:8px;"><input type="text" id="locked-new-input" placeholder="Ej: Anya es una niña; su vocabulario y razonamiento deben sonar infantiles."><button class="btn btn-primary btn-sm" id="locked-add-btn">Añadir</button></div></div><div class="card"><h3>📖 Canon revelado</h3><p class="muted">Verdades que ya están establecidas/reveladas en la historia. La memoria sigue decidiendo qué sabe cada personaje en concreto.</p><div id="canon-revealed-list"></div></div><div class="card"><h3>🕵️ Canon privado del autor</h3><p class="muted">Verdades reales del AU que Inky debe respetar, pero que NO pasan automáticamente al conocimiento de los personajes. Las notas antiguas se tratan como privadas por seguridad.</p><div id="canon-private-list"></div><label class="field-label">Añadir nota de canon</label><textarea id="canon-new-input" placeholder="Pega aquí una verdad del AU, resumen futuro o secreto..."></textarea><div class="grid-2"><select id="canon-visibility"><option value="private" selected>🕵️ Privado del autor</option><option value="revealed">📖 Revelado / establecido</option></select><button class="btn btn-primary btn-sm" id="canon-add-btn">Añadir</button></div></div><div class="card"><h3>🧵 Memoria de continuidad por capítulo</h3><p class="muted">Solo se muestra y usa la memoria de la versión principal de cada capítulo. Si cambias a una alternativa, su memoria pasa a ser la activa cuando la crees desde Capítulos.</p><div id="continuity-list"></div></div>`;
  renderLocked(lockedFacts, root); renderCanon(canonNotes, root); renderContinuity(memoryEntries, root);
  document.getElementById('locked-add-btn').addEventListener('click', async () => { const input = document.getElementById('locked-new-input'); const text = input.value.trim(); if (!text) return; await db.put('lockedFacts', { text, isCore: false }); input.value = ''; renderMemory(root); });
  document.getElementById('canon-add-btn').addEventListener('click', async () => { const input = document.getElementById('canon-new-input'); const text = input.value.trim(); if (!text) return; const visibility=document.getElementById('canon-visibility')?.value === 'revealed' ? 'revealed' : 'private'; await db.put('canonNotes', { text, visibility, createdAt: new Date().toISOString() }); input.value = ''; renderMemory(root); });
}
function renderLocked(lockedFacts, root) { const el = document.getElementById('locked-list'); if (!lockedFacts.length) { el.innerHTML = `<p class="muted">Sin hechos bloqueados todavía.</p>`; return; } el.innerHTML = lockedFacts.map((f) => `<div class="list-item" data-id="${f.id}"><div class="card-row"><span>${escapeHtml(f.text)}</span><button class="btn btn-danger btn-sm act-del">Quitar</button></div>${f.isCore ? '<span class="pill pill-canon">regla base</span>' : ''}</div>`).join(''); el.querySelectorAll('.list-item').forEach((item) => { item.querySelector('.act-del').addEventListener('click', async () => { if (!confirm('¿Quitar este hecho bloqueado?')) return; await db.del('lockedFacts', item.dataset.id); renderMemory(root); }); }); }
function renderCanon(canonNotes, root) {
  const groups={
    revealed:(canonNotes || []).filter((n)=>n?.visibility === 'revealed'),
    private:(canonNotes || []).filter((n)=>n?.visibility !== 'revealed'),
  };
  const renderGroup=(list,elId,visibility)=>{
    const el=document.getElementById(elId);
    if(!el)return;
    if(!list.length){el.innerHTML=`<p class="muted">${visibility==='revealed' ? 'Todavía no hay canon marcado como revelado.' : 'Sin canon privado.'}</p>`;return;}
    el.innerHTML=list.map((n)=>`<div class="list-item" data-id="${n.id}"><div style="white-space:pre-wrap;">${escapeHtml(n.text)}</div><div class="btn-row"><button class="btn btn-ghost btn-sm act-toggle">${visibility==='revealed' ? '🕵️ Mover a privado' : '📖 Marcar revelado'}</button><button class="btn btn-danger btn-sm act-del">Quitar</button></div></div>`).join('');
    el.querySelectorAll('.list-item').forEach((item)=>{
      item.querySelector('.act-toggle')?.addEventListener('click',async()=>{
        const note=await db.get('canonNotes',item.dataset.id);
        if(!note)return;
        note.visibility=visibility==='revealed' ? 'private' : 'revealed';
        await db.put('canonNotes',note);
        toast(note.visibility==='revealed' ? 'Canon marcado como revelado.' : 'Canon movido a privado del autor.');
        renderMemory(root);
      });
      item.querySelector('.act-del')?.addEventListener('click',async()=>{
        if(!confirm('¿Quitar esta nota de canon?'))return;
        await db.del('canonNotes',item.dataset.id);
        renderMemory(root);
      });
    });
  };
  renderGroup(groups.revealed,'canon-revealed-list','revealed');
  renderGroup(groups.private,'canon-private-list','private');
}
function renderContinuity(memoryEntries, root) { const el = document.getElementById('continuity-list'); if (!memoryEntries.length) { el.innerHTML = `<p class="muted">Todavía no se ha generado memoria de continuidad.</p>`; return; } el.innerHTML = memoryEntries.map((m) => `<div class="list-item" data-id="${m.id}"><div class="title-row"><b>${escapeHtml(m.chapterTitle || 'Capítulo')}</b><span class="muted">${fmtDate(m.createdAt)}</span></div><button class="btn btn-ghost btn-sm act-view">Ver / editar</button><button class="btn btn-danger btn-sm act-del">Eliminar</button></div>`).join(''); el.querySelectorAll('.list-item').forEach((item) => { const id = item.dataset.id; item.querySelector('.act-view').addEventListener('click', async () => { const m = await db.get('memoryEntries', id); openMemoryEditModal(m, root); }); item.querySelector('.act-del').addEventListener('click', async () => { if (!confirm('¿Eliminar esta memoria de continuidad?')) return; await db.del('memoryEntries', id); renderMemory(root); }); }); }
function openMemoryEditModal(m, root) { const fields = [['events','EVENTOS'],['relationshipChanges','CAMBIOS DE RELACIÓN'],['newFacts','HECHOS NUEVOS'],['whoKnowsWhat','QUIÉN SABE QUÉ'],['physicalState','ESTADO FÍSICO / HERIDAS'],['currentLocationTime','LUGAR / TIEMPO ACTUAL'],['openThreads','HILOS ABIERTOS']]; openModal(`<h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">${escapeHtml(m.chapterTitle)}</h3>${fields.map(([key,label]) => `<label class="field-label">${label}</label><textarea class="mem-field" data-key="${key}">${escapeHtml(m[key] || '')}</textarea>`).join('')}<div class="btn-row"><button class="btn btn-primary" id="mem-save-btn">Guardar</button><button class="btn btn-ghost" id="mem-cancel-btn">Cerrar</button></div>`); document.getElementById('mem-cancel-btn').addEventListener('click', closeModal); document.getElementById('mem-save-btn').addEventListener('click', async () => { document.querySelectorAll('.mem-field').forEach((ta) => { m[ta.dataset.key] = ta.value.trim(); }); await db.put('memoryEntries', m); toast('Memoria actualizada.'); closeModal(); renderMemory(root); }); }
