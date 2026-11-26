// ui/documents.js — Biblioteca de referencias con los 6 roles oficiales, compatibilidad
// con tipos heredados, aislamiento de líneas temporales y perfiles de oficio literario
// para documentos STYLE_ONLY (sin importar tramas ni activar overlays).

import { db } from '../db.js';
import { escapeHtml, toast, wordCount } from '../utils.js';
import { chunkText } from '../retrieval.js';
import { invalidatePersistedLexicalIndex } from '../lexicalIndex.js';
import {
  REFERENCE_ROLES,
  REFERENCE_ROLE_MAP,
  STYLE_CRAFT_DIMENSIONS,
  TIMELINE_OPTIONS,
  normalizeReferenceRole,
  normalizeStyleCraftProfile,
} from '../referenceRoles.js';

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let pdfjsReady = null;
const INCLUSION_LABELS = { SMART: 'Automática', ALWAYS: 'Siempre' };

function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PDFJS_CDN;
    script.crossOrigin = 'anonymous';
    script.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib); };
    script.onerror = (err) => { pdfjsReady = null; reject(err); };
    document.head.appendChild(script);
  });
  return pdfjsReady;
}

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n\n';
  }
  return text;
}

async function readFileText(file) {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    try { return await extractPdfText(file); }
    catch (e) { toast('No se pudo leer el PDF "' + file.name + '": ' + e.message, { error: true }); return null; }
  }
  return await file.text();
}

export async function renderDocuments(root) {
  const documents = (await db.getAll('documents')).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const chunksAll = await db.getAll('docChunks');
  root.innerHTML = `
    <h2 class="section-title">Documentos de referencia</h2>
    <p class="section-hint">Sube TXT, MD o PDF y asigna uno de los 6 roles oficiales. Los documentos «Solo estilo (STYLE_ONLY)» (p.ej. Violet Evergarden o The Vow) aportan únicamente oficio literario y nunca importan tramas, personajes ni activan rasgos Violet.</p>
    <div class="card">
      <input type="file" id="doc-upload-input" multiple accept=".txt,.md,.pdf,text/plain,application/pdf">
      <div class="btn-row"><button class="btn btn-primary" id="doc-upload-btn">+ Subir documentos</button></div>
    </div>
    <div id="doc-list"></div>`;

  document.getElementById('doc-upload-btn').addEventListener('click', () => document.getElementById('doc-upload-input').click());
  document.getElementById('doc-upload-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      toast('Procesando ' + file.name + '…');
      const text = await readFileText(file);
      if (!text) continue;
      const doc = {
        id: db.uid(),
        filename: file.name,
        type: 'WORLD_BUILDING',
        role: 'WORLD_BUILDING',
        timelineId: 'shared_active',
        priority: 50,
        useOnlyFor: '',
        neverUseFor: '',
        active: true,
        inclusion: 'SMART',
        styleCraftProfile: {},
        wordCount: wordCount(text),
        createdAt: new Date().toISOString(),
      };
      await db.put('documents', doc);
      const chunks = chunkText(text, doc.id);
      for (const ch of chunks) await db.put('docChunks', ch);
    }
    await invalidatePersistedLexicalIndex({ kind: 'documents' });
    toast('Documentos añadidos.');
    renderDocuments(root);
  });

  const list = document.getElementById('doc-list');
  if (!documents.length) {
    list.innerHTML = `<div class="empty"><span class="ic">📚</span>Aún no has subido documentos de referencia.</div>`;
    return;
  }

  list.innerHTML = documents.map((d) => {
    const nChunks = chunksAll.filter((c) => c.documentId === d.id).length;
    const role = normalizeReferenceRole(d.role || d.type);
    const roleMeta = REFERENCE_ROLE_MAP.get(role) || { label: role, pillClass: 'pill-reference' };
    const safePriority = Number.isFinite(Number(d.priority)) ? Number(d.priority) : 50;
    const timelineVal = d.timelineId || 'shared_active';
    const craft = normalizeStyleCraftProfile(d.styleCraftProfile);
    const stylePanel = role === 'STYLE_ONLY' ? `
      <details style="margin-top:8px;">
        <summary style="cursor:pointer; font-weight:600;">🎨 Perfil de oficio literario (STYLE_ONLY · sin tramas ni personajes)</summary>
        <p class="muted" style="margin-top:4px;">Solo describe técnica narrativa general. Nunca importa tramas, diálogos, relaciones ni activa rasgos Violet de Levi.</p>
        <div class="grid-2" style="margin-top:6px;">
          ${STYLE_CRAFT_DIMENSIONS.map((dim) => `
            <div>
              <label class="field-label">${escapeHtml(dim.label)}</label>
              <input type="text" class="f-craft" data-dim="${escapeHtml(dim.id)}" value="${escapeHtml(craft[dim.id] || '')}" placeholder="Describe el oficio literario...">
            </div>`).join('')}
        </div>
      </details>` : '';

    return `
      <div class="card" data-id="${escapeHtml(d.id)}">
        <div class="card-row">
          <b>${escapeHtml(d.filename)}</b>
          <span class="muted">${Number(d.wordCount) || 0} palabras · ${nChunks} fragmentos</span>
        </div>
        <div class="chip-row">
          <span class="pill ${escapeHtml(roleMeta.pillClass)}">${escapeHtml(roleMeta.label)}</span>
          <span class="pill ${d.active !== false ? 'pill-active' : 'pill-inactive'}">${d.active !== false ? 'Activo' : 'Ignorado'}</span>
          <span class="pill pill-reference">${escapeHtml(INCLUSION_LABELS[d.inclusion] || d.inclusion || 'Automática')}</span>
          ${timelineVal !== 'shared_active' ? `<span class="pill pill-continuity">Línea: ${escapeHtml(timelineVal)}</span>` : ''}
        </div>
        <div class="grid-2" style="margin-top:6px;">
          <div>
            <label class="field-label">Rol de referencia (6 roles oficiales)</label>
            <select class="f-type">
              ${REFERENCE_ROLES.map((r) => `<option value="${escapeHtml(r.id)}" ${role === r.id ? 'selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Línea temporal (aislamiento de canon)</label>
            <select class="f-timeline">
              ${TIMELINE_OPTIONS.map((t) => `<option value="${escapeHtml(t.id)}" ${timelineVal === t.id ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="grid-2">
          <div><label class="field-label">Prioridad (0-100)</label><input type="number" class="f-priority" value="${safePriority}" min="0" max="100"></div>
          <div><label class="field-label">Inclusión</label><select class="f-inclusion"><option value="SMART" ${d.inclusion === 'SMART' ? 'selected' : ''}>Automática (sólo fragmentos relevantes)</option><option value="ALWAYS" ${d.inclusion === 'ALWAYS' ? 'selected' : ''}>Siempre (incluir siempre, con tope)</option></select></div>
        </div>
        <label class="field-label">Usar sólo para (etiquetas separadas por coma)</label>
        <input type="text" class="f-useonly" value="${escapeHtml(d.useOnlyFor || '')}" placeholder="ej: estilo, ambientación">
        <label class="field-label">Nunca usar para (etiquetas separadas por coma)</label>
        <input type="text" class="f-neveruse" value="${escapeHtml(d.neverUseFor || '')}" placeholder="ej: memoria, resumen">
        ${stylePanel}
        <label class="field-label" style="margin-top:6px;"><input type="checkbox" class="f-active" ${d.active !== false ? 'checked' : ''}> Documento activo en esta historia</label>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm act-save">Guardar alcance</button>
          <button class="btn btn-danger btn-sm act-delete">Eliminar</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.card[data-id]').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-save').addEventListener('click', async () => {
      const d = await db.get('documents', id);
      const selectedRole = el.querySelector('.f-type').value;
      d.type = selectedRole;
      d.role = selectedRole;
      d.timelineId = el.querySelector('.f-timeline')?.value || 'shared_active';
      d.priority = parseInt(el.querySelector('.f-priority').value, 10) || 0;
      d.inclusion = el.querySelector('.f-inclusion').value;
      d.useOnlyFor = el.querySelector('.f-useonly').value.trim();
      d.neverUseFor = el.querySelector('.f-neveruse').value.trim();
      d.active = el.querySelector('.f-active').checked;
      const craftInputs = el.querySelectorAll('.f-craft');
      if (craftInputs.length) {
        const nextCraft = {};
        craftInputs.forEach((inp) => { nextCraft[inp.dataset.dim] = inp.value.trim(); });
        d.styleCraftProfile = normalizeStyleCraftProfile(nextCraft);
      }
      await db.put('documents', d);
      await invalidatePersistedLexicalIndex({ kind: 'documents' });
      toast('Alcance y rol guardados para "' + d.filename + '".');
      renderDocuments(root);
    });
    el.querySelector('.act-delete').addEventListener('click', async () => {
      if (!confirm('¿Eliminar este documento y sus fragmentos?')) return;
      await db.del('documents', id);
      const chunks = await db.getByIndex('docChunks', 'by_document', id);
      for (const c of chunks) await db.del('docChunks', c.id);
      await invalidatePersistedLexicalIndex({ kind: 'documents' });
      renderDocuments(root);
    });
  });
}
