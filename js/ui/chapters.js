import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, fmtDate, debounce, wordCount, openModal, closeModal, bus, copyTextToClipboard } from '../utils.js';
import { rewriteChapter, generateContinuityMemory } from '../memoryEngine.js?v=20260928-cache-cost-v1';
import { isMainTimelineChapter, sortChaptersWithVariants } from '../timeline.js?v=20260928-chapter-variants-v1';

function safeFilename(value, fallback = 'capitulo') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return cleaned || fallback;
}

function downloadMarkdown(filename, markdown) {
  const blob = new Blob([String(markdown || '')], { type:'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : filename + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chapterAsMarkdown(chapter) {
  const title = String(chapter?.title || 'Capítulo sin título').trim();
  const body = String(chapter?.content || '').trim();
  return '# ' + title + '\n\n' + body + '\n';
}

async function copyChapterToClipboard(id) {
  const chapter = await db.get('chapters',id);
  if (!chapter) return toast('No se encontró el capítulo.',{error:true});
  const body = String(chapter.content || '').trim();
  if (!body) return toast('Este capítulo todavía no tiene texto para copiar.',{error:true});
  try {
    await copyTextToClipboard(String(chapter.title || 'Capítulo sin título').trim() + '\n\n' + body);
    toast('Capítulo copiado al portapapeles.');
  } catch (err) {
    toast(err.message || 'No se pudo copiar el capítulo.',{error:true});
  }
}

async function downloadChapterMarkdown(id) {
  const chapter = await db.get('chapters',id);
  if (!chapter) return toast('No se encontró el capítulo.',{error:true});
  downloadMarkdown(safeFilename(chapter.title,'capitulo') + '.md', chapterAsMarkdown(chapter));
  toast('Capítulo descargado en .md · 0 tokens de IA.');
}

async function downloadAllChaptersMarkdown(chapters) {
  if (!chapters.length) return toast('No hay capítulos para descargar.',{error:true});
  const workspace = document.getElementById('workspace-label')?.textContent?.trim() || 'Power to Strive';
  const body = [
    '# ' + workspace,
    '',
    chapters.map((chapter) => chapterAsMarkdown(chapter).trim()).join('\n\n---\n\n'),
    ''
  ].join('\n');
  downloadMarkdown(safeFilename(workspace,'power-to-strive') + ' - chapters.md', body);
  toast('Todos los capítulos descargados en un solo .md · 0 tokens de IA.',{ms:6000});
}


bus.on('chapters-changed', () => {
  const root = document.getElementById('view-chapters');
  if (root && root.classList.contains('active')) renderChapters(root);
});

export async function renderChapters(root) {
  const chapters = sortChaptersWithVariants(await db.getAll('chapters'));
  const mainChapters = chapters.filter(isMainTimelineChapter);
  root.innerHTML = `
    <h2 class="section-title">Capítulos</h2>
    <p class="section-hint">Tu línea principal y sus alternativas. Las alternativas se guardan completas pero NO afectan continuidad, planificación ni «Descargar todos» hasta que las hagas principales.</p>
    <div class="btn-row chapter-export-row">
      <button class="btn btn-ghost" id="chapters-download-all">⬇️ Descargar línea principal en .md</button>
    </div>
    <div id="chapters-list"></div>`;
  document.getElementById('chapters-download-all')?.addEventListener('click', () => downloadAllChaptersMarkdown(mainChapters));
  const list = document.getElementById('chapters-list');
  if (!chapters.length) { list.innerHTML = `<div class="empty"><span class="ic">📖</span>Todavía no tienes capítulos. Ve a «Escribir» para crear el primero.</div>`; return; }

  list.innerHTML = chapters.map((c) => {
    const alternative = !isMainTimelineChapter(c);
    const branched = !!c.branchGroupId;
    const branchLabel = escapeHtml(c.variantLabel || (alternative ? 'Alternativa' : 'Principal'));
    const branchPill = alternative
      ? `<span class="pill pill-reference">🌿 Alternativa ${branchLabel} · fuera de continuidad</span>`
      : branched
        ? `<span class="pill pill-active">🌳 Principal · ${branchLabel}</span>`
        : '';
    return `
    <div class="list-item ${alternative ? 'chapter-variant' : ''}" data-id="${c.id}">
      <div class="title-row"><b>${escapeHtml(c.title)}</b><span class="muted">${c.wordCount || 0} palabras</span></div>
      <div class="chip-row">
        <span class="pill ${c.status === 'finished' ? 'pill-active' : 'pill-inactive'}">${c.status === 'finished' ? 'Terminado' : 'Borrador'}</span>
        ${branchPill}
        ${c.versions?.length ? `<span class="pill pill-reference">${c.versions.length} versión(es) anterior(es)</span>` : ''}
        <span class="muted">${fmtDate(c.updatedAt)}</span>
      </div>
      ${alternative ? '<p class="branch-note">Esta versión es segura para experimentar: puedes editarla o reescribirla sin cambiar la historia principal.</p>' : ''}
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm act-open">Abrir/editar</button>
        <button class="btn btn-ghost btn-sm act-copy">📋 Copiar</button>
        <button class="btn btn-ghost btn-sm act-download">⬇️ .md</button>
        <button class="btn btn-ghost btn-sm act-rewrite">Reescribir</button>
        ${alternative ? '<button class="btn btn-primary btn-sm act-promote">⭐ Usar como principal</button>' : '<button class="btn btn-ghost btn-sm act-memory">🧠 Crear/actualizar memoria</button><button class="btn btn-ghost btn-sm act-variants">🌿 Crear 2 alternativas</button>'}
        <button class="btn btn-ghost btn-sm act-duplicate">Duplicar</button>
        <button class="btn btn-danger btn-sm act-delete">Eliminar</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.list-item').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-open')?.addEventListener('click', () => openChapterEditor(id));
    el.querySelector('.act-copy')?.addEventListener('click', () => copyChapterToClipboard(id));
    el.querySelector('.act-download')?.addEventListener('click', () => downloadChapterMarkdown(id));
    el.querySelector('.act-rewrite')?.addEventListener('click', () => openRewriteModal(id));
    el.querySelector('.act-memory')?.addEventListener('click', () => createChapterMemory(id, el));
    el.querySelector('.act-variants')?.addEventListener('click', () => createChapterAlternatives(id));
    el.querySelector('.act-promote')?.addEventListener('click', () => promoteAlternative(id));
    el.querySelector('.act-duplicate')?.addEventListener('click', () => duplicateChapter(id));
    el.querySelector('.act-delete')?.addEventListener('click', () => deleteChapter(id, root));
  });
}

async function createChapterAlternatives(id) {
  const chapter = await db.get('chapters', id);
  if (!chapter) return;
  if (!isMainTimelineChapter(chapter)) return toast('Crea alternativas desde la versión principal.', {error:true});

  const all = await db.getAll('chapters');
  const groupId = chapter.branchGroupId || chapter.id;
  let main = chapter;
  if (!chapter.branchGroupId) {
    main = { ...chapter, branchGroupId: groupId, branchRole: 'main', variantLabel: chapter.variantLabel || 'Original', updatedAt: new Date().toISOString() };
    await db.put('chapters', main);
  } else if (!chapter.branchRole) {
    main = { ...chapter, branchRole: 'main', variantLabel: chapter.variantLabel || 'Original', updatedAt: new Date().toISOString() };
    await db.put('chapters', main);
  }

  const refreshed = await db.getAll('chapters');
  const group = refreshed.filter((item) => (item.branchGroupId || item.id) === groupId);
  const alternatives = group.filter((item) => item.branchRole === 'alternative');
  if (alternatives.length >= 2) {
    toast('Este capítulo ya tiene dos alternativas. Puedes reescribirlas o elegir una como principal.', {ms:6500});
    bus.emit('chapters-changed');
    return;
  }

  const usedLabels = new Set(group.map((item) => String(item.variantLabel || '').toUpperCase()));
  const labels = ['A','B','C','D'].filter((label) => !usedLabels.has(label));
  const needed = 2 - alternatives.length;
  const now = new Date().toISOString();
  for (let i = 0; i < needed; i++) {
    const label = labels[i] || String(alternatives.length + i + 1);
    const copy = {
      ...main,
      id: db.uid(),
      branchGroupId: groupId,
      branchRole: 'alternative',
      variantLabel: label,
      alternativeSourceId: main.id,
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.put('chapters', copy);
  }
  toast('🌿 Alternativas creadas sin usar IA ni tokens. La versión principal quedó intacta.', {ms:7000});
  bus.emit('chapters-changed');
}

async function promoteAlternative(id) {
  const selected = await db.get('chapters', id);
  if (!selected || selected.branchRole !== 'alternative' || !selected.branchGroupId) return;

  const all = await db.getAll('chapters');
  const group = all.filter((item) => (item.branchGroupId || item.id) === selected.branchGroupId);
  const currentMain = group.find(isMainTimelineChapter);
  const involved = [selected, currentMain].filter(Boolean);
  for (const chapter of involved) {
    const state = await db.get('generationState', chapter.id);
    if (state && state.status !== 'completed' && state.status !== 'discarded') {
      return toast('Cierra primero cualquier generación pendiente de estas versiones antes de cambiar la línea principal.', {error:true,ms:8000});
    }
  }

  const selectedLabel = selected.variantLabel || 'alternativa';
  if (!confirm('¿Usar la alternativa ' + selectedLabel + ' como versión principal? La versión principal actual NO se borrará: pasará a ser una alternativa guardada.')) return;

  const now = new Date().toISOString();
  if (currentMain && currentMain.id !== selected.id) {
    currentMain.branchRole = 'alternative';
    if (!currentMain.variantLabel || currentMain.variantLabel === 'Principal') currentMain.variantLabel = 'Original';
    currentMain.updatedAt = now;
    await db.put('chapters', currentMain);
  }
  selected.branchRole = 'main';
  selected.updatedAt = now;
  await db.put('chapters', selected);

  const memories = await db.getByIndex('memoryEntries', 'by_chapter', selected.id);
  toast(memories.length
    ? '⭐ Alternativa ' + selectedLabel + ' ahora es la historia principal. Su memoria de continuidad ya queda activa.'
    : '⭐ Alternativa ' + selectedLabel + ' ahora es la historia principal. Cuando estés conforme, crea su memoria de continuidad para que Paws continúe desde ella.',
    {ms:9000});
  bus.emit('chapters-changed');
}

async function createChapterMemory(id, card) {
  const chapter = await db.get('chapters', id);
  if (!chapter?.content?.trim()) return toast('Este capítulo no tiene texto para resumir.', { error:true });
  const gen = await db.get('generationState', id);
  if (gen && gen.status !== 'completed' && gen.status !== 'discarded') {
    if (!confirm('Este capítulo tiene un borrador de generación sin terminar. ¿Crear una memoria provisional con lo escrito hasta ahora?')) return;
  }
  const button = card.querySelector('.act-memory');
  if (button) { button.disabled = true; button.textContent = '🧠 Preparando memoria…'; }
  try {
    const result = await generateContinuityMemory(chapter);
    if (result.ok) toast('Memoria de continuidad guardada. Revísala en Memoria → Continuidad.', { ms:6000 });
    else toast('No se guardó memoria: ' + result.error, { error:true, ms:10000 });
  } catch (e) {
    toast('No se pudo guardar la memoria: ' + e.message, { error:true, ms:10000 });
  } finally {
    if (button) { button.disabled = false; button.textContent = '🧠 Crear/actualizar memoria'; }
  }
}

async function openChapterEditor(id) {
  const chapter = await db.get('chapters', id); if (!chapter) return;
  const autosave = debounce(async (content) => {
    const fresh = await db.get('chapters', id); fresh.content = content; fresh.wordCount = wordCount(content); fresh.updatedAt = new Date().toISOString(); await db.put('chapters', fresh);
    const badge = document.getElementById('editor-save-badge'); if (badge) badge.textContent = 'Guardado ✓ ' + new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    bus.emit('chapters-changed');
  }, 700);
  openModal(`
    <div class="paper" style="padding:20px;">
      <div class="card-row"><input type="text" id="editor-title" value="${escapeHtml(chapter.title)}" style="font-family:'Cormorant Garamond',serif; font-size:20px; border:none; background:transparent; padding:0;"><span class="muted" id="editor-save-badge">Guardado ✓</span></div>
      <hr><div class="paper-readonly manuscript-rendered" id="editor-reading">${renderManuscript(chapter.content)}</div><textarea class="paper-text" id="editor-content" rows="18" style="display:none;">${escapeHtml(chapter.content)}</textarea>
    </div>
    <div class="btn-row"><button class="btn btn-primary" id="editor-mode-toggle">✏️ Editar texto</button><button class="btn btn-ghost" id="editor-close-btn">Cerrar</button><span class="muted" style="align-self:center;" id="editor-wc">${wordCount(chapter.content)} palabras</span></div>`);
  document.getElementById('editor-content').addEventListener('input', (e) => { document.getElementById('editor-wc').textContent = wordCount(e.target.value) + ' palabras'; document.getElementById('editor-save-badge').textContent = 'Guardando…'; autosave(e.target.value); });
  // La edición conserva Markdown como texto original; lectura lo presenta con formato.
  document.getElementById('editor-mode-toggle').addEventListener('click', (e) => {
    const source = document.getElementById('editor-content');
    const preview = document.getElementById('editor-reading');
    const toEdit = source.style.display === 'none';
    source.style.display = toEdit ? 'block' : 'none';
    preview.style.display = toEdit ? 'none' : 'block';
    if (!toEdit) preview.innerHTML = renderManuscript(source.value);
    e.currentTarget.textContent = toEdit ? '📖 Vista de lectura' : '✏️ Editar texto';
    if (toEdit) source.focus();
  });
  document.getElementById('editor-title').addEventListener('change', async (e) => { const fresh = await db.get('chapters', id); fresh.title = e.target.value.trim() || fresh.title; await db.put('chapters', fresh); bus.emit('chapters-changed'); });
  document.getElementById('editor-close-btn').addEventListener('click', closeModal);
}

async function openRewriteModal(id) {
  const chapter = await db.get('chapters', id);
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Reescribir «${escapeHtml(chapter.title)}»</h3>
    <p class="muted">La versión actual se conservará en el historial de versiones.</p>
    <label class="field-label">Instrucciones de reescritura</label>
    <textarea id="rewrite-instructions" placeholder="Ej: Alarga la escena entre Levi y Erwin, añade más interioridad de Levi, mantén el resto igual."></textarea>
    <div class="btn-row"><button class="btn btn-primary" id="rewrite-go-btn">Reescribir con IA</button><button class="btn btn-ghost" id="rewrite-cancel-btn">Cancelar</button></div>
    <div id="rewrite-status" class="muted" style="margin-top:8px;"></div>`);
  document.getElementById('rewrite-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('rewrite-go-btn').addEventListener('click', async () => {
    const instructions = document.getElementById('rewrite-instructions').value.trim(); if (!instructions) return toast('Escribe qué quieres cambiar.', { error: true });
    const btn = document.getElementById('rewrite-go-btn'); btn.disabled = true; document.getElementById('rewrite-status').textContent = 'Reescribiendo…';
    const result = await rewriteChapter(chapter, instructions); btn.disabled = false;
    if (!result.ok) { document.getElementById('rewrite-status').textContent = '⚠️ ' + result.error; toast('No se guardó ningún cambio: la respuesta no fue válida.', { error: true }); return; }
    const fresh = await db.get('chapters', id); fresh.versions = fresh.versions || []; fresh.versions.push({ content: fresh.content, note: instructions, timestamp: new Date().toISOString() }); fresh.content = result.text; fresh.wordCount = wordCount(result.text); fresh.updatedAt = new Date().toISOString(); await db.put('chapters', fresh);
    toast('Capítulo reescrito. La versión anterior quedó guardada.'); closeModal(); bus.emit('chapters-changed');
  });
}

async function duplicateChapter(id) {
  const chapter = await db.get('chapters', id);
  if (!chapter) return;
  const copy = { ...chapter, id: db.uid(), title: chapter.title + ' (copia)', versions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  delete copy.branchGroupId;
  delete copy.branchRole;
  delete copy.variantLabel;
  delete copy.alternativeSourceId;
  const mains = (await db.getAll('chapters')).filter(isMainTimelineChapter);
  copy.order = mains.length ? Math.max(...mains.map((item) => item.order ?? 0)) + 1 : 0;
  await db.put('chapters', copy);
  toast('Capítulo duplicado como capítulo independiente.');
  bus.emit('chapters-changed');
}

async function deleteChapter(id, root) {
  const chapter = await db.get('chapters', id);
  if (!chapter) return;
  if (isMainTimelineChapter(chapter) && chapter.branchGroupId) {
    const group = (await db.getAll('chapters')).filter((item) => item.branchGroupId === chapter.branchGroupId);
    if (group.some((item) => item.branchRole === 'alternative')) {
      return toast('Este capítulo tiene alternativas guardadas. Si quieres eliminar la versión principal, primero haz principal otra alternativa o elimina las alternativas.', {error:true,ms:9000});
    }
  }
  const label = chapter.branchRole === 'alternative' ? 'esta alternativa' : 'este capítulo';
  if (!confirm('¿Eliminar definitivamente ' + label + ' y su memoria de continuidad? Antes, exporta una copia si quieres conservarlo.')) return;
  await db.del('chapters', id);
  await db.del('generationState', id).catch(() => {});
  const memories = await db.getByIndex('memoryEntries', 'by_chapter', id);
  for (const memory of memories) await db.del('memoryEntries', memory.id);
  toast(chapter.branchRole === 'alternative' ? 'Alternativa eliminada.' : 'Capítulo y su memoria eliminados.');
  renderChapters(root);
}
