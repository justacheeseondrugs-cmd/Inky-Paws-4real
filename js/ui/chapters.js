import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, fmtDate, debounce, wordCount, contentFingerprint, openModal, closeModal, bus, copyTextToClipboard } from '../utils.js';
import { rewriteChapter, continueRewriteDraft, generateContinuityMemory, saveContinuityMemoryEntry, markChapterMemoriesStale } from '../memoryEngine.js';
import { isMainTimelineChapter, sortChaptersWithVariants } from '../timeline.js';

const rewriteDraftKey = (projectId, chapterId) => `rewrite-draft:${projectId}:${chapterId}`;
const MEMORY_REVIEW_FIELDS = [
  ['events', 'EVENTOS'],
  ['relationshipChanges', 'CAMBIOS DE RELACIÓN'],
  ['newFacts', 'HECHOS NUEVOS'],
  ['whoKnowsWhat', 'QUIÉN SABE QUÉ'],
  ['physicalState', 'ESTADO FÍSICO / HERIDAS'],
  ['currentLocationTime', 'LUGAR / TIEMPO ACTUAL'],
  ['openThreads', 'HILOS ABIERTOS'],
];

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
  const activeProjectId = db.getActiveProjectId();
  const [rawChapters, memoryEntries, allSettings] = await Promise.all([
    db.getAll('chapters'),
    db.getAll('memoryEntries'),
    db.getAll('settings'),
  ]);
  const chapters = sortChaptersWithVariants(rawChapters);
  const mainChapters = chapters.filter(isMainTimelineChapter);
  const staleChapterIds = new Set(
    (memoryEntries || []).filter((m) => m?.stale === true && m.chapterId).map((m) => m.chapterId)
  );
  const draftPrefix = `rewrite-draft:${activeProjectId}:`;
  const draftChapterIds = new Set(
    (allSettings || [])
      .filter((s) => typeof s?.id === 'string' && s.id.startsWith(draftPrefix) && String(s.text || '').trim())
      .map((s) => s.chapterId || s.id.slice(draftPrefix.length))
  );
  root.innerHTML = `
    <h2 class="section-title">Capítulos</h2>
    <p class="section-hint">Tu línea principal y sus alternativas. Las alternativas se guardan completas pero NO afectan continuidad, planificación ni «Descargar todos» hasta que las hagas principales. Tu copia de seguridad completa sigue disponible en Ajustes.</p>
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
    const stalePill = !alternative && staleChapterIds.has(c.id)
      ? `<span class="pill pill-inactive" title="El capítulo cambió tras generar su memoria. La memoria anterior se conserva hasta que revises una nueva.">⚠️ Memoria desactualizada</span>`
      : '';
    const rewriteDraftPill = draftChapterIds.has(c.id)
      ? `<span class="pill pill-reference" title="Hay un borrador de reescritura pendiente guardado localmente.">✏️ Borrador de reescritura guardado</span>`
      : '';
    return `
    <div class="list-item ${alternative ? 'chapter-variant' : ''}" data-id="${escapeHtml(c.id)}">
      <div class="title-row"><b>${escapeHtml(c.title)}</b><span class="muted">${Number(c.wordCount) || 0} palabras</span></div>
      <div class="chip-row">
        <span class="pill ${c.status === 'finished' ? 'pill-active' : 'pill-inactive'}">${c.status === 'finished' ? 'Terminado' : 'Borrador'}</span>
        ${branchPill}
        ${stalePill}
        ${rewriteDraftPill}
        ${c.versions?.length ? `<span class="pill pill-reference">${Number(c.versions.length) || 0} versión(es) anterior(es)</span>` : ''}
        <span class="muted">${escapeHtml(fmtDate(c.updatedAt))}</span>
      </div>
      ${alternative ? '<p class="branch-note">Esta versión es segura para experimentar: puedes editarla o reescribirla sin cambiar la historia principal.</p>' : ''}
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm act-open">Abrir/editar</button>
        <button class="btn btn-ghost btn-sm act-copy">📋 Copiar</button>
        <button class="btn btn-ghost btn-sm act-download">⬇️ .md</button>
        <button class="btn btn-ghost btn-sm act-rewrite">${draftChapterIds.has(c.id) ? 'Reescribir (borrador)' : 'Reescribir'}</button>
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
  const activeProjectId = db.getActiveProjectId();
  if (currentMain && currentMain.id !== selected.id) {
    currentMain.branchRole = 'alternative';
    if (!currentMain.variantLabel || currentMain.variantLabel === 'Principal') currentMain.variantLabel = 'Original';
    currentMain.updatedAt = now;
    await db.put('chapters', currentMain);
    await markChapterMemoriesStale(currentMain.id, {
      projectId: activeProjectId,
      reason: 'demoted_to_alternative',
      chapterRevision: contentFingerprint(currentMain.content || ''),
    });
  }
  selected.branchRole = 'main';
  selected.updatedAt = now;
  await db.put('chapters', selected);
  await markChapterMemoriesStale(selected.id, {
    projectId: activeProjectId,
    reason: 'alternative_promoted',
    chapterRevision: contentFingerprint(selected.content || ''),
  });

  const memories = await db.getByIndex('memoryEntries', 'by_chapter', selected.id);
  toast(memories.length
    ? '⭐ Alternativa ' + selectedLabel + ' ahora es la historia principal. Su memoria de continuidad ya queda activa.'
    : '⭐ Alternativa ' + selectedLabel + ' ahora es la historia principal. Cuando estés conforme, crea su memoria de continuidad para que Paws continúe desde ella.',
    {ms:9000});
  bus.emit('chapters-changed');
}

function openMemoryReviewModal(chapter, existingEntry, proposedEntry, scope) {
  const existingSummary = existingEntry
    ? MEMORY_REVIEW_FIELDS
        .filter(([key]) => String(existingEntry[key] || '').trim())
        .map(([key, label]) => `<div style="margin-bottom:6px;"><b>${escapeHtml(label)}:</b> ${escapeHtml(existingEntry[key])}</div>`)
        .join('')
    : '';
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Revisar nueva memoria · ${escapeHtml(chapter.title)}</h3>
    <div class="context-guard-item context-guard-warning" style="margin-bottom:10px;">
      <b>🛡️ Memoria anterior protegida</b>
      <div>La memoria anterior sigue intacta en la base de datos. Revisa o edita la propuesta abajo y decide si quieres reemplazarla o conservar la anterior.</div>
    </div>
    ${existingSummary ? `<details style="margin-bottom:12px;"><summary style="cursor:pointer; font-weight:600;">Ver memoria anterior guardada${existingEntry.stale ? ' (desactualizada)' : ''}</summary><div class="paper" style="padding:12px; margin-top:8px; font-size:13px;">${existingSummary}</div></details>` : ''}
    ${MEMORY_REVIEW_FIELDS.map(([key, label]) => `
      <label class="field-label">${escapeHtml(label)}</label>
      <textarea class="mem-review-field" data-key="${escapeHtml(key)}">${escapeHtml(proposedEntry[key] || '')}</textarea>`).join('')}
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="mem-review-save-btn">✓ Guardar nueva memoria</button>
      <button type="button" class="btn btn-ghost" id="mem-review-keep-btn">Conservar memoria anterior</button>
    </div>`);
  document.getElementById('mem-review-keep-btn')?.addEventListener('click', () => {
    closeModal();
    toast('Se conservó la memoria de continuidad anterior.');
  });
  document.getElementById('mem-review-save-btn')?.addEventListener('click', async () => {
    const edited = {};
    document.querySelectorAll('.mem-review-field').forEach((ta) => {
      edited[ta.dataset.key] = ta.value.trim();
    });
    try {
      await saveContinuityMemoryEntry(chapter, edited, scope);
      closeModal();
      toast('Memoria de continuidad actualizada tras revisión.', { ms: 6000 });
      bus.emit('chapters-changed');
    } catch (err) {
      toast(err.message || 'No se pudo guardar la nueva memoria.', { error: true, ms: 8000 });
    }
  });
}

async function createChapterMemory(id, card) {
  const projectId = db.getActiveProjectId();
  const scope = { projectId };
  const chapter = await db.get('chapters', id, scope);
  if (!chapter?.content?.trim()) return toast('Este capítulo no tiene texto para resumir.', { error: true });
  const gen = await db.get('generationState', id, scope);
  if (gen && gen.status !== 'completed' && gen.status !== 'discarded') {
    if (!confirm('Este capítulo tiene un borrador de generación sin terminar. ¿Crear una memoria provisional con lo escrito hasta ahora?')) return;
  }
  const existingMemories = await db.getByIndex('memoryEntries', 'by_chapter', id, scope);
  const hasExisting = existingMemories.length > 0;
  const button = card.querySelector('.act-memory');
  if (button) { button.disabled = true; button.textContent = '🧠 Preparando memoria…'; }
  try {
    const result = await generateContinuityMemory(chapter, { stageOnly: hasExisting });
    if (!result.ok) {
      toast('No se guardó memoria: ' + result.error, { error: true, ms: 10000 });
      return;
    }
    if (hasExisting && result.staged) {
      openMemoryReviewModal(chapter, result.existingEntry || existingMemories[0], result.proposedEntry, scope);
    } else {
      toast('Memoria de continuidad guardada. Revísala en Memoria → Continuidad.', { ms: 6000 });
      bus.emit('chapters-changed');
    }
  } catch (e) {
    toast('No se pudo guardar la memoria: ' + e.message, { error: true, ms: 10000 });
  } finally {
    if (button) { button.disabled = false; button.textContent = '🧠 Crear/actualizar memoria'; }
  }
}

async function openChapterEditor(id) {
  const editorProjectId = db.getActiveProjectId();
  const scope = { projectId: editorProjectId };
  const chapter = await db.get('chapters', id, scope); if (!chapter) return;
  let latestContent = String(chapter.content || '');
  let latestTitle = String(chapter.title || '');
  let dirty = false;

  const persistEditor = async () => {
    if (!dirty) return;
    const contentToSave = latestContent;
    const titleToSave = latestTitle.trim() || chapter.title;
    dirty = false;
    const fresh = await db.get('chapters', id, scope);
    if (!fresh) return;
    const contentChanged = contentFingerprint(fresh.content) !== contentFingerprint(contentToSave);
    fresh.content = contentToSave;
    fresh.title = titleToSave;
    fresh.wordCount = wordCount(contentToSave);
    fresh.updatedAt = new Date().toISOString();
    await db.put('chapters', fresh, scope);
    if (contentChanged) {
      await markChapterMemoriesStale(id, {
        projectId: editorProjectId,
        reason: 'manual_edit',
        chapterRevision: contentFingerprint(contentToSave),
      });
    }
    const badge = document.getElementById('editor-save-badge');
    if (badge) badge.textContent = 'Guardado ✓ ' + new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    bus.emit('chapters-changed');
  };

  const autosave = debounce(() => { persistEditor().catch(() => {}); }, 700);
  const onBeforeUnload = () => {
    if (dirty) autosave.flush();
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  openModal(`
    <div class="paper" style="padding:20px;">
      <div class="card-row"><input type="text" id="editor-title" value="${escapeHtml(chapter.title)}" style="font-family:'Cormorant Garamond',serif; font-size:20px; border:none; background:transparent; padding:0;"><span class="muted" id="editor-save-badge">Guardado ✓</span></div>
      <hr><div class="paper-readonly manuscript-rendered" id="editor-reading">${renderManuscript(chapter.content)}</div><textarea class="paper-text" id="editor-content" rows="18" style="display:none;">${escapeHtml(chapter.content)}</textarea>
    </div>
    <div class="btn-row"><button class="btn btn-primary" id="editor-mode-toggle">✏️ Editar texto</button><button class="btn btn-ghost" id="editor-close-btn">Cerrar</button><span class="muted" style="align-self:center;" id="editor-wc">${wordCount(chapter.content)} palabras</span></div>`, {
    onClose: () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      autosave.cancel();
      if (dirty) persistEditor().catch(() => {});
    },
  });
  document.getElementById('editor-content').addEventListener('input', (e) => {
    latestContent = e.target.value;
    dirty = true;
    document.getElementById('editor-wc').textContent = wordCount(latestContent) + ' palabras';
    document.getElementById('editor-save-badge').textContent = 'Guardando…';
    autosave();
  });
  // La edición conserva Markdown como texto original; lectura lo presenta con formato.
  document.getElementById('editor-mode-toggle').addEventListener('click', (e) => {
    const source = document.getElementById('editor-content');
    const preview = document.getElementById('editor-reading');
    const toEdit = source.style.display === 'none';
    source.style.display = toEdit ? 'block' : 'none';
    preview.style.display = toEdit ? 'none' : 'block';
    if (!toEdit) {
      preview.innerHTML = renderManuscript(source.value);
      if (dirty) {
        autosave.cancel();
        persistEditor().catch(() => {});
      }
    }
    e.currentTarget.textContent = toEdit ? '📖 Vista de lectura' : '✏️ Editar texto';
    if (toEdit) source.focus();
  });
  document.getElementById('editor-title').addEventListener('input', (e) => {
    latestTitle = e.target.value;
    dirty = true;
    document.getElementById('editor-save-badge').textContent = 'Guardando…';
    autosave();
  });
  document.getElementById('editor-title').addEventListener('change', () => {
    if (dirty) {
      autosave.cancel();
      persistEditor().catch(() => {});
    }
  });
  document.getElementById('editor-close-btn').addEventListener('click', closeModal);
}

async function saveRewriteAsAlternative(chapter, text, scope) {
  const targetScope = scope || { projectId: chapter?.projectId || db.getActiveProjectId() };
  const groupId = chapter.branchGroupId || chapter.id;
  const now = new Date().toISOString();
  if (!chapter.branchGroupId || !chapter.branchRole) {
    const main = {
      ...chapter,
      branchGroupId: groupId,
      branchRole: chapter.branchRole || 'main',
      variantLabel: chapter.variantLabel || 'Original',
      updatedAt: now,
    };
    await db.put('chapters', main, targetScope);
  }
  const all = await db.getAll('chapters', targetScope);
  const group = all.filter((item) => (item.branchGroupId || item.id) === groupId);
  const usedLabels = new Set(group.map((item) => String(item.variantLabel || '').toUpperCase()));
  const nextLabel = ['A', 'B', 'C', 'D', 'E', 'F'].find((label) => !usedLabels.has(label)) || ('R' + group.length);
  const alt = {
    ...chapter,
    id: db.uid(),
    projectId: targetScope.projectId,
    content: text,
    wordCount: wordCount(text),
    branchGroupId: groupId,
    branchRole: 'alternative',
    variantLabel: nextLabel,
    alternativeSourceId: chapter.id,
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.put('chapters', alt, targetScope);
  return alt;
}

async function openRewriteModal(id) {
  const rewriteProjectId = db.getActiveProjectId();
  const scope = { projectId: rewriteProjectId };
  const chapter = await db.get('chapters', id, scope);
  if (!chapter) return;
  const draftKey = rewriteDraftKey(rewriteProjectId, id);
  const savedDraft = await db.get('settings', draftKey);
  const hasRestoredDraft = Boolean(savedDraft && String(savedDraft.text || '').trim());

  let controller = null;
  let draftResolved = false;
  let hasStagedDraft = hasRestoredDraft;
  let stagedInstructions = hasRestoredDraft ? String(savedDraft.instructions || '') : '';
  let stagedBaseHash = hasRestoredDraft ? String(savedDraft.baseContentHash || '') : contentFingerprint(chapter.content);
  let stagedBaseUpdatedAt = hasRestoredDraft ? String(savedDraft.baseUpdatedAt || '') : String(chapter.updatedAt || '');
  let stagedBaseWordCount = hasRestoredDraft && Number.isFinite(savedDraft.baseWordCount) ? savedDraft.baseWordCount : wordCount(chapter.content);
  let stagedWarnings = hasRestoredDraft && Array.isArray(savedDraft.warnings) ? savedDraft.warnings : [];
  let stagedIncomplete = hasRestoredDraft ? Boolean(savedDraft.incomplete) : false;
  let stagedTruncated = hasRestoredDraft ? Boolean(savedDraft.truncated) : false;
  let stagedModelMaxOutput = hasRestoredDraft && Number.isFinite(savedDraft.modelMaxOutput) ? savedDraft.modelMaxOutput : 0;
  let stagedMayNeedContinuation = hasRestoredDraft ? Boolean(savedDraft.mayNeedContinuation) : false;
  let previousDraftText = hasRestoredDraft ? String(savedDraft.previousText || '') : '';
  let latestPreviewValue = hasRestoredDraft ? String(savedDraft.text || '') : '';
  let latestInstructionsValue = stagedInstructions;

  const persistStagedDraft = async () => {
    if (draftResolved || !hasStagedDraft) return;
    const text = String(latestPreviewValue || '');
    if (!text.trim()) return;
    await db.put('settings', {
      id: draftKey,
      projectId: rewriteProjectId,
      chapterId: id,
      instructions: latestInstructionsValue || stagedInstructions,
      text,
      previousText: previousDraftText,
      baseContentHash: stagedBaseHash,
      baseUpdatedAt: stagedBaseUpdatedAt,
      baseWordCount: stagedBaseWordCount,
      warnings: stagedWarnings,
      incomplete: stagedIncomplete,
      truncated: stagedTruncated,
      modelMaxOutput: stagedModelMaxOutput,
      mayNeedContinuation: stagedMayNeedContinuation,
      updatedAt: new Date().toISOString(),
    });
  };

  const clearStagedDraft = async () => {
    draftResolved = true;
    hasStagedDraft = false;
    await db.del('settings', draftKey).catch(() => {});
  };

  const draftAutosave = debounce(() => { persistStagedDraft().catch(() => {}); }, 400);
  const onBeforeUnload = () => {
    if (!draftResolved && hasStagedDraft) {
      draftAutosave.cancel();
      persistStagedDraft().catch(() => {});
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Reescribir «${escapeHtml(chapter.title)}»</h3>
    <p class="muted">La reescritura se mostrará primero para que la revises y edites. El borrador se guarda automáticamente por si cierras el modal o recargas la página, y el capítulo original no se reemplazará hasta que lo apruebes.</p>
    <div id="rewrite-request-pane">
      <label class="field-label" for="rewrite-instructions">Instrucciones de reescritura</label>
      <textarea id="rewrite-instructions" placeholder="Ej: Alarga la escena entre Levi y Erwin, añade más interioridad de Levi, mantén el resto igual.">${escapeHtml(stagedInstructions)}</textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="rewrite-go-btn">Reescribir con IA</button>
        <button type="button" class="btn btn-danger" id="rewrite-abort-btn" style="display:none;">⏹ Cancelar solicitud</button>
        <button type="button" class="btn btn-ghost" id="rewrite-cancel-btn">Cerrar</button>
      </div>
      <div id="rewrite-status" class="muted" style="margin-top:8px;"></div>
    </div>
    <div id="rewrite-review-pane" style="display:${hasRestoredDraft ? 'block' : 'none'}; margin-top:12px;">
      <div id="rewrite-warning-slot"></div>
      <div id="rewrite-conflict-slot"></div>
      <div class="card-row" style="margin-bottom:6px;">
        <label class="field-label" for="rewrite-preview" style="margin:0;">✏️ Borrador reescrito (pendiente de aprobación)</label>
        <span class="muted" id="rewrite-wc-compare"></span>
      </div>
      <textarea id="rewrite-preview" class="paper-text" rows="14">${escapeHtml(latestPreviewValue)}</textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="rewrite-approve-btn">✓ Aprobar y reemplazar original</button>
        <button type="button" class="btn btn-ghost" id="rewrite-continue-btn">▶ Continuar reescritura</button>
        <button type="button" class="btn btn-ghost" id="rewrite-undo-cont-btn" style="display:${previousDraftText ? '' : 'none'};">↩ Deshacer continuación</button>
        <button type="button" class="btn btn-ghost" id="rewrite-alt-btn">🌿 Guardar como alternativa</button>
        <button type="button" class="btn btn-ghost" id="rewrite-copy-btn">📋 Copiar borrador</button>
        <button type="button" class="btn btn-danger" id="rewrite-discard-btn">Descartar borrador</button>
      </div>
    </div>`, {
    onClose: () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      controller?.abort();
      draftAutosave.cancel();
      if (!draftResolved && hasStagedDraft && String(latestPreviewValue || '').trim()) {
        persistStagedDraft().then(() => bus.emit('chapters-changed')).catch(() => {});
        toast('Borrador de reescritura guardado localmente; vuelve a «Reescribir» cuando quieras retomarlo.', { ms: 5000 });
      }
    },
  });

  const instructionsEl = document.getElementById('rewrite-instructions');
  const goBtn = document.getElementById('rewrite-go-btn');
  const abortBtn = document.getElementById('rewrite-abort-btn');
  const cancelBtn = document.getElementById('rewrite-cancel-btn');
  const statusEl = document.getElementById('rewrite-status');
  const reviewPane = document.getElementById('rewrite-review-pane');
  const warningSlot = document.getElementById('rewrite-warning-slot');
  const conflictSlot = document.getElementById('rewrite-conflict-slot');
  const previewEl = document.getElementById('rewrite-preview');
  const wcEl = document.getElementById('rewrite-wc-compare');
  const continueBtn = document.getElementById('rewrite-continue-btn');
  const undoContBtn = document.getElementById('rewrite-undo-cont-btn');

  const renderWarnings = ({ restored = false, sourceChanged = false } = {}) => {
    const blocks = [];
    if (restored) {
      blocks.push(`<div class="context-guard-item context-guard-warning"><b>💾 Borrador restaurado</b><div>Se recuperó tu borrador de reescritura pendiente. Puedes seguir editándolo, continuarlo, guardarlo como alternativa o descartarlo.</div></div>`);
    }
    if (sourceChanged) {
      blocks.push(`<div class="context-guard-item context-guard-critical"><b>⚠️ El capítulo original cambió desde que empezó esta reescritura</b><div>Al aprobar se abrirá la resolución de conflicto para no sobrescribir tus ediciones recientes por accidente.</div></div>`);
    }
    if (stagedIncomplete) {
      blocks.push(`<div class="context-guard-item context-guard-critical"><b>⚠️ Respuesta posiblemente incompleta o truncada</b><div>${stagedWarnings.map((w) => escapeHtml(w)).join(' ')}</div><div class="muted">Usa «▶ Continuar reescritura» para completar lo que falta sin perder este borrador, o guárdalo como alternativa.</div></div>`);
    } else if (stagedMayNeedContinuation && stagedModelMaxOutput) {
      blocks.push(`<div class="context-guard-item context-guard-warning"><b>ℹ️ Límite de salida del modelo (${stagedModelMaxOutput} tokens)</b><div>Para capítulos muy largos, si notas que faltan escenas al final, usa «▶ Continuar reescritura».</div></div>`);
    }
    warningSlot.innerHTML = blocks.join('');
  };

  const updateCounts = () => {
    const draftWords = wordCount(previewEl.value);
    wcEl.textContent = `${stagedBaseWordCount} → ${draftWords} palabras`;
  };

  if (hasRestoredDraft) {
    updateCounts();
    const liveHashNow = contentFingerprint(chapter.content);
    renderWarnings({ restored: true, sourceChanged: Boolean(stagedBaseHash && liveHashNow !== stagedBaseHash) });
    statusEl.textContent = 'Borrador guardado restaurado. Nada se ha sobrescrito todavía.';
  }

  previewEl.addEventListener('input', () => {
    latestPreviewValue = previewEl.value;
    updateCounts();
    if (hasStagedDraft) draftAutosave();
  });

  instructionsEl.addEventListener('input', () => {
    latestInstructionsValue = instructionsEl.value;
    if (hasStagedDraft) draftAutosave();
  });

  cancelBtn.addEventListener('click', () => {
    controller?.abort();
    closeModal();
  });
  abortBtn.addEventListener('click', () => {
    controller?.abort();
    abortBtn.disabled = true;
    statusEl.textContent = 'Cancelando solicitud…';
  });

  const setBusy = (busy, message = '') => {
    goBtn.disabled = busy;
    continueBtn.disabled = busy;
    abortBtn.style.display = busy ? '' : 'none';
    abortBtn.disabled = false;
    if (message) statusEl.textContent = message;
  };

  goBtn.addEventListener('click', async () => {
    const instructions = instructionsEl.value.trim();
    if (!instructions) return toast('Escribe qué quieres cambiar.', { error: true });
    const freshSource = (await db.get('chapters', id, scope)) || chapter;
    controller = new AbortController();
    setBusy(true, 'Reescribiendo… el capítulo original permanece intacto.');
    conflictSlot.innerHTML = '';
    const result = await rewriteChapter(freshSource, instructions, { signal: controller.signal });
    controller = null;
    setBusy(false);
    if (!result.ok) {
      statusEl.textContent = '⚠️ ' + result.error;
      toast(result.errorType === 'aborted' ? 'Reescritura cancelada.' : 'No se guardó ningún cambio: ' + result.error, { error: result.errorType !== 'aborted' });
      return;
    }
    hasStagedDraft = true;
    draftResolved = false;
    stagedInstructions = instructions;
    latestInstructionsValue = instructions;
    stagedBaseHash = result.baseContentHash || contentFingerprint(freshSource.content);
    stagedBaseUpdatedAt = result.baseUpdatedAt || String(freshSource.updatedAt || '');
    stagedBaseWordCount = result.originalWords || wordCount(freshSource.content);
    stagedWarnings = Array.isArray(result.warnings) ? result.warnings : [];
    stagedIncomplete = Boolean(result.incomplete);
    stagedTruncated = Boolean(result.truncated);
    stagedModelMaxOutput = Number(result.modelMaxOutput) || 0;
    stagedMayNeedContinuation = Boolean(result.mayNeedContinuation);
    previousDraftText = '';
    undoContBtn.style.display = 'none';
    previewEl.value = result.text;
    latestPreviewValue = result.text;
    updateCounts();
    renderWarnings();
    reviewPane.style.display = 'block';
    await persistStagedDraft();
    bus.emit('chapters-changed');
    statusEl.textContent = result.incomplete
      ? '⚠️ Borrador guardado localmente con advertencias. Puedes usar «Continuar reescritura» o revisarlo antes de aprobar.'
      : 'Borrador guardado localmente y listo para revisar. Nada se ha sobrescrito todavía.';
  });

  continueBtn.addEventListener('click', async () => {
    const currentDraft = previewEl.value.trim();
    if (wordCount(currentDraft) < 15) return toast('Primero genera o escribe un borrador para continuarlo.', { error: true });
    const instructions = instructionsEl.value.trim() || stagedInstructions || 'Continúa la reescritura con coherencia.';
    const freshSource = (await db.get('chapters', id, scope)) || chapter;
    controller = new AbortController();
    setBusy(true, 'Continuando la reescritura desde el último párrafo…');
    const result = await continueRewriteDraft(freshSource, instructions, currentDraft, { signal: controller.signal });
    controller = null;
    setBusy(false);
    if (!result.ok) {
      statusEl.textContent = '⚠️ ' + result.error;
      toast(result.errorType === 'aborted' ? 'Continuación cancelada.' : result.error, { error: result.errorType !== 'aborted' });
      return;
    }
    previousDraftText = currentDraft;
    undoContBtn.style.display = '';
    stagedInstructions = instructions;
    latestInstructionsValue = instructions;
    stagedWarnings = Array.isArray(result.warnings) ? result.warnings : [];
    stagedIncomplete = Boolean(result.incomplete);
    stagedTruncated = Boolean(result.truncated);
    stagedModelMaxOutput = Number(result.modelMaxOutput) || stagedModelMaxOutput;
    stagedMayNeedContinuation = Boolean(result.mayNeedContinuation);
    previewEl.value = result.text;
    latestPreviewValue = result.text;
    updateCounts();
    renderWarnings({ sourceChanged: Boolean(stagedBaseHash && contentFingerprint(freshSource.content) !== stagedBaseHash) });
    await persistStagedDraft();
    statusEl.textContent = result.incomplete
      ? '⚠️ Continuación añadida y guardada, pero el modelo indicó que aún podría faltar texto.'
      : 'Continuación añadida y guardada localmente. Revisa la unión antes de aprobar.';
  });

  undoContBtn.addEventListener('click', async () => {
    if (!previousDraftText) return;
    previewEl.value = previousDraftText;
    latestPreviewValue = previousDraftText;
    previousDraftText = '';
    undoContBtn.style.display = 'none';
    updateCounts();
    await persistStagedDraft();
    toast('Se deshizo la última continuación.');
  });

  document.getElementById('rewrite-copy-btn').addEventListener('click', async () => {
    try {
      await copyTextToClipboard(previewEl.value);
      toast('Borrador reescrito copiado al portapapeles.');
    } catch (err) {
      toast(err.message || 'No se pudo copiar el borrador.', { error: true });
    }
  });

  document.getElementById('rewrite-discard-btn').addEventListener('click', async () => {
    if (!confirm('¿Descartar este borrador reescrito? El capítulo original seguirá intacto.')) return;
    await clearStagedDraft();
    closeModal();
    bus.emit('chapters-changed');
    toast('Borrador descartado. El capítulo original no cambió.');
  });

  const commitAsAlternative = async () => {
    const text = previewEl.value.trim();
    if (wordCount(text) < 10) return toast('El borrador está demasiado vacío para guardarlo.', { error: true });
    const fresh = await db.get('chapters', id, scope);
    if (!fresh) return toast('No se encontró el capítulo original.', { error: true });
    await saveRewriteAsAlternative(fresh, text, scope);
    await clearStagedDraft();
    toast('🌿 Reescritura guardada como alternativa. La versión principal quedó intacta.', { ms: 6500 });
    closeModal();
    bus.emit('chapters-changed');
  };

  document.getElementById('rewrite-alt-btn').addEventListener('click', commitAsAlternative);

  const applyRewriteReplacement = async (fresh, text) => {
    const now = new Date().toISOString();
    fresh.versions = fresh.versions || [];
    fresh.versions.push({ content: fresh.content, note: stagedInstructions || instructionsEl.value.trim(), timestamp: now });
    fresh.content = text;
    fresh.wordCount = wordCount(text);
    fresh.updatedAt = now;
    await db.put('chapters', fresh, scope);
    await markChapterMemoriesStale(id, {
      projectId: rewriteProjectId,
      reason: 'rewrite',
      chapterRevision: contentFingerprint(text),
    });
    await clearStagedDraft();
    toast('Capítulo actualizado. La versión anterior quedó guardada en el historial.');
    closeModal();
    bus.emit('chapters-changed');
  };

  const showConflictPanel = (fresh) => {
    const currentWc = wordCount(fresh.content);
    conflictSlot.innerHTML = `
      <div class="context-guard-item context-guard-critical" id="rewrite-conflict-panel" style="margin-bottom:10px;">
        <b>⚠️ Conflicto de edición concurrente</b>
        <div>El capítulo original fue modificado después de iniciar esta reescritura (versión actual: ${currentWc} palabras · ${escapeHtml(fmtDate(fresh.updatedAt))}). No se sobrescribió nada para proteger tus cambios recientes.</div>
        <div class="btn-row" style="margin-top:8px;">
          <button type="button" class="btn btn-primary btn-sm" id="rewrite-conflict-alt-btn">🌿 Guardar reescritura como alternativa (recomendado)</button>
          <button type="button" class="btn btn-ghost btn-sm" id="rewrite-conflict-copy-btn">📋 Copiar borrador</button>
          <button type="button" class="btn btn-danger btn-sm" id="rewrite-conflict-force-btn">⚠️ Reemplazar igualmente</button>
        </div>
      </div>`;
    document.getElementById('rewrite-conflict-alt-btn')?.addEventListener('click', commitAsAlternative);
    document.getElementById('rewrite-conflict-copy-btn')?.addEventListener('click', async () => {
      try {
        await copyTextToClipboard(previewEl.value);
        toast('Borrador reescrito copiado para fusionarlo manualmente.');
      } catch (err) {
        toast(err.message || 'No se pudo copiar el borrador.', { error: true });
      }
    });
    document.getElementById('rewrite-conflict-force-btn')?.addEventListener('click', async () => {
      const text = previewEl.value.trim();
      if (wordCount(text) < 10) return toast('El borrador está demasiado vacío para reemplazar el capítulo.', { error: true });
      if (!confirm('⚠️ El capítulo actual tiene cambios posteriores a esta reescritura. ¿Reemplazarlo igualmente? (La versión editada actual se guardará en el historial de versiones.)')) return;
      const latestFresh = await db.get('chapters', id, scope);
      if (!latestFresh) return toast('No se encontró el capítulo original.', { error: true });
      await applyRewriteReplacement(latestFresh, text);
    });
  };

  document.getElementById('rewrite-approve-btn').addEventListener('click', async () => {
    const text = previewEl.value.trim();
    if (wordCount(text) < 10) return toast('El borrador está demasiado vacío para reemplazar el capítulo.', { error: true });
    const fresh = await db.get('chapters', id, scope);
    if (!fresh) return toast('No se encontró el capítulo original.', { error: true });
    const currentHash = contentFingerprint(fresh.content);
    if (stagedBaseHash && currentHash !== stagedBaseHash) {
      showConflictPanel(fresh);
      statusEl.textContent = '⚠️ Conflicto detectado: elige cómo resolverlo abajo antes de guardar.';
      toast('El capítulo cambió desde que comenzó la reescritura. Elige una opción de resolución.', { error: true, ms: 7000 });
      return;
    }
    if (stagedIncomplete) {
      if (!confirm('⚠️ Este borrador fue marcado como posiblemente incompleto/truncado. ¿Seguro que quieres reemplazar el capítulo original? (El original se guardará en el historial de versiones.)')) return;
    }
    await applyRewriteReplacement(fresh, text);
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
  const activeProjectId = db.getActiveProjectId();
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
  await db.del('settings', rewriteDraftKey(activeProjectId, id)).catch(() => {});
  const memories = await db.getByIndex('memoryEntries', 'by_chapter', id);
  for (const memory of memories) await db.del('memoryEntries', memory.id);
  await markChapterMemoriesStale(id, {
    projectId: activeProjectId,
    reason: 'chapter_deleted',
  });
  toast(chapter.branchRole === 'alternative' ? 'Alternativa eliminada.' : 'Capítulo y su memoria eliminados.');
  renderChapters(root);
}
