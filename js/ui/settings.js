// ui/settings.js — Ajustes de proveedor, Apariencia, Writing DNA en 4 ámbitos,
// Anti-patrones editables, Aprendizaje Editorial revisado (0 tokens) y Copias de seguridad.

import { db } from '../db.js';
import { toast, escapeHtml } from '../utils.js';
import { listProviders } from '../providers/index.js';
import { renderAppearanceSettings, bindAppearanceSettings } from './appearance.js';
import { getAuthorBrain, saveAuthorBrain, DEFAULT_WRITING_DNA, FEEDBACK_OPTIONS } from '../authorBrain.js';
import { getStoryConfig } from '../storyConfigSchema.js';
import {
  getWritingDnaProfile,
  saveWritingDnaProfile,
  exportGlobalWritingDnaProfile,
  importGlobalWritingDnaProfile,
  recordEditorialFeedback,
  listEditorialFeedback,
  decideEditorialProposal,
  deleteEditorialFeedback,
} from '../writingDna.js';

function linesToArray(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const FEEDBACK_STATUS_LABELS = {
  proposed: 'Pendiente de revisión',
  approved: 'Aprobada y activa',
  rejected: 'Rechazada',
  deactivated: 'Desactivada',
};

export async function renderSettings(root) {
  const projectId = db.getActiveProjectId();
  const [settings, authorBrain, storyConfig, globalDna, feedbackItems] = await Promise.all([
    db.get('settings', 'main'),
    getAuthorBrain(),
    getStoryConfig(projectId),
    getWritingDnaProfile({ scope: 'global' }),
    listEditorialFeedback({ projectId }),
  ]);
  const safeSettings = settings || { provider: 'gemini', apiKeys: {}, models: {}, blockWordSize: 1000, defaultGenerationMode: 'full_chapter' };
  const fandom = storyConfig?.fandom || 'neutral';
  const [fandomDna, storyDna] = await Promise.all([
    getWritingDnaProfile({ scope: 'fandom', fandom }),
    getWritingDnaProfile({ scope: 'story', projectId }),
  ]);

  const providers = listProviders();
  const learned = FEEDBACK_OPTIONS
    .map(([tag, label]) => ({ label, count: Number(authorBrain.feedbackCounts?.[tag]) || 0 }))
    .filter((x) => x.count)
    .sort((a, b) => b.count - a.count);

  const profilesByScope = {
    global: globalDna,
    fandom: fandomDna,
    story: storyDna,
  };
  let activeScope = 'global';

  root.innerHTML = `
    <h2 class="section-title">Ajustes</h2>
    ${renderAppearanceSettings()}
    <p class="section-hint">Tu clave API se guarda SOLO en este navegador (IndexedDB) — nunca se escribe en el código ni se sube a ningún repositorio.</p>

    <div class="card">
      <h3>Proveedor de IA</h3>
      <label class="field-label">Proveedor activo</label>
      <select id="s-provider">${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${safeSettings.provider === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select>
      <div id="provider-fields"></div>
      <label class="field-label">Modo de escritura predeterminado</label>
      <select id="s-generation-mode">
        <option value="full_chapter" ${safeSettings.defaultGenerationMode !== 'blocks' ? 'selected' : ''}>📖 Capítulo completo · una sola llamada</option>
        <option value="blocks" ${safeSettings.defaultGenerationMode === 'blocks' ? 'selected' : ''}>🧩 Por bloques · revisar paso a paso</option>
      </select>
      <p class="muted">Capítulo completo usa la extensión elegida en «Escribir» (3k/5k/7k) en una sola solicitud. Por bloques usa el tamaño de abajo.</p>
      <label class="field-label">Tamaño por llamada en modo «Por bloques»</label>
      <select id="s-blocksize">
        <option value="1000" ${(safeSettings.blockWordSize || 1000) === 1000 ? 'selected' : ''}>1.000 palabras</option>
        <option value="2000" ${(safeSettings.blockWordSize || 1000) === 2000 ? 'selected' : ''}>2.000 palabras</option>
        <option value="3000" ${(safeSettings.blockWordSize || 1000) === 3000 ? 'selected' : ''}>3.000 palabras</option>
        <option value="5000" ${(safeSettings.blockWordSize || 1000) === 5000 ? 'selected' : ''}>5.000 palabras</option>
        <option value="7000" ${(safeSettings.blockWordSize || 1000) === 7000 ? 'selected' : ''}>7.000 palabras</option>
      </select>
      <p class="muted">Una llamada más larga usa más tokens. Para capítulos cohesionados de 5k–7k, usa «Capítulo completo»; este selector queda para el modo por bloques.</p>
      <div class="btn-row"><button class="btn btn-primary" id="s-save-btn">Guardar ajustes</button></div>
    </div>

    <div class="card" id="writing-dna-studio-card">
      <div class="card-row">
        <div>
          <h3>🧬 Writing DNA en 4 ámbitos y Anti-patrones literarios</h3>
          <p class="muted">Define tu voz literaria global compartida entre historias, preferencias por fandom (${escapeHtml(fandom)}) y ajustes solo para esta historia. Manuscritos en inglés por defecto; interfaz en español.</p>
        </div>
        <span class="pill pill-reference" title="Writing DNA global y reglas editoriales se guardan en IndexedDB v4 y se conectarán al Context Engine unificado en el Hito 5.">🛠️ Listo · motor en Hito 5</span>
      </div>
      <div class="grid-2" style="margin-top:8px;">
        <div>
          <label class="field-label" for="dna-scope-select">Ámbito que estás editando</label>
          <select id="dna-scope-select">
            <option value="global" selected>🌍 Global de la autora (compartido entre historias)</option>
            <option value="fandom">🌌 Específico del fandom (${escapeHtml(fandom)})</option>
            <option value="story">📖 Solo esta historia (override aislado)</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="dna-manuscript-lang">Idioma predeterminado del manuscrito</label>
          <select id="dna-manuscript-lang">
            <option value="en">English (predeterminado)</option>
            <option value="es">Español</option>
          </select>
        </div>
      </div>
      <label class="field-label" for="dna-qualities">Cualidades literarias preferidas (una por línea · guía de oficio, no fórmula rígida)</label>
      <textarea id="dna-qualities" rows="6"></textarea>
      <label class="field-label" for="dna-custom-notes">Notas adicionales de voz y ritmo para este ámbito</label>
      <textarea id="dna-custom-notes" rows="2" placeholder="Ej: Priorizar subtexto seco, diálogos con interrupciones naturales..."></textarea>

      <details style="margin-top:8px;">
        <summary style="cursor:pointer; font-weight:600;">🚫 Anti-patrones literarios editables (sin listas negras de palabras)</summary>
        <div id="dna-antipatterns-list" style="margin-top:8px;"></div>
        <div class="card-row" style="gap:8px; margin-top:6px;">
          <input type="text" id="dna-ap-add-input" placeholder="Añadir anti-patrón propio (ej: evitar resúmenes morales al final)">
          <button type="button" class="btn btn-ghost btn-sm" id="dna-ap-add-btn">+ Añadir</button>
        </div>
      </details>

      <div class="btn-row" style="margin-top:10px;">
        <button type="button" class="btn btn-primary" id="dna-save-btn">💾 Guardar perfil Writing DNA</button>
        <button type="button" class="btn btn-ghost btn-sm" id="dna-export-global-btn">⬇️ Exportar Writing DNA global</button>
        <label class="btn btn-ghost btn-sm" style="cursor:pointer;">⬆️ Importar Writing DNA global<input type="file" id="dna-import-global-input" accept="application/json" style="display:none;"></label>
      </div>

      <details style="margin-top:12px;" ${feedbackItems.length ? 'open' : ''}>
        <summary style="cursor:pointer; font-weight:600;">✍️ Aprendizaje editorial revisado (antes / después · 0 tokens · ${feedbackItems.length})</summary>
        <p class="muted" style="margin-top:6px;">Envía un pasaje original, tu versión revisada y qué no te gustó. Inky propone una regla editable para tu aprobación. Los hechos de trama o AU nunca contaminan el Writing DNA global.</p>
        <label class="field-label" for="ed-orig">A. Pasaje original (antes)</label>
        <textarea id="ed-orig" rows="3" placeholder="Pega el pasaje original que editaste..."></textarea>
        <label class="field-label" for="ed-rev">B. Pasaje revisado por ti (después)</label>
        <textarea id="ed-rev" rows="3" placeholder="Pega cómo lo dejaste tú..."></textarea>
        <div class="grid-2">
          <div>
            <label class="field-label" for="ed-note">C. Qué no te gustó (opcional)</label>
            <input type="text" id="ed-note" placeholder="Ej: explicaba emociones evidentes / diálogo muy rígido">
          </div>
          <div>
            <label class="field-label" for="ed-scope">Ámbito deseado de la regla</label>
            <select id="ed-scope">
              <option value="global" selected>🌍 Global (solo oficio literario)</option>
              <option value="fandom">🌌 Fandom (${escapeHtml(fandom)})</option>
              <option value="story">📖 Solo esta historia</option>
            </select>
          </div>
        </div>
        <div class="btn-row" style="margin-top:6px;">
          <button type="button" class="btn btn-primary btn-sm" id="ed-submit-btn">📝 Registrar corrección y proponer regla (0 tokens)</button>
        </div>
        <div id="ed-proposals-list" style="margin-top:10px;"></div>
      </details>
    </div>

    <div class="card">
      <h3>🐈‍⬛ Cerebro de autora de Inky (activo en generación actual)</h3>
      <p class="muted">Este perfil es propio de esta historia. Se añade al prompt sin una llamada extra. Inky también aprende de las etiquetas que marcas al revisar borradores.</p>
      <label class="field-label">Writing DNA / gusto permanente</label>
      <textarea id="s-writing-dna" rows="14">${escapeHtml(authorBrain.writingDna || DEFAULT_WRITING_DNA)}</textarea>
      <label class="field-label"><input type="checkbox" id="s-author-prep" ${authorBrain.prepEnabled !== false ? 'checked' : ''}> 🧠 Pre-flight editorial antes de escribir (usa una llamada pequeña extra por capítulo nuevo)</label>
      <p class="muted">El pre-flight no escribe prosa: detecta bombas, hilos activos, química relevante, riesgos de ritmo y qué detalles NO sobrecargar. Se guarda en el capítulo y no se repite en cada bloque.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="s-author-save">Guardar cerebro de autora</button>
        <button type="button" class="btn btn-ghost" id="s-author-reset">Restaurar Writing DNA</button>
      </div>
      <p class="muted" id="s-learned-taste">Aprendizaje editorial: ${learned.length ? learned.map((x) => escapeHtml(x.label) + ' ×' + x.count).join(' · ') : 'todavía sin señales; aparecerán cuando marques qué no funcionó en un borrador.'}</p>
    </div>

    <div class="card">
      <h3>Copia de seguridad</h3>
      <p class="muted">Exporta o importa capítulos, personajes, documentos, memoria, Writing DNA y ajustes como JSON. 🔐 Las claves API nunca se incluyen en la copia.</p>
      <div class="btn-row">
        <button class="btn btn-ghost" id="s-export-btn">⬇️ Exportar copia completa</button>
        <label class="btn btn-ghost" style="cursor:pointer;">⬆️ Importar copia<input type="file" id="s-import-input" accept="application/json" style="display:none;"></label>
      </div>
    </div>
  `;

  // --- Proveedor de IA (preservado) ---
  function renderProviderFields() {
    const p = document.getElementById('s-provider').value;
    const field = document.getElementById('provider-fields');
    const key = safeSettings.apiKeys?.[p] || '';
    const model = safeSettings.models?.[p] || (p === 'gemini' ? 'gemini-2.0-flash' : p === 'openrouter' ? 'openrouter/free' : 'gpt-5.4-mini');
    field.innerHTML = `<label class="field-label">Clave API de ${escapeHtml(providers.find((x) => x.id === p)?.label || p)}</label><input type="password" id="s-apikey" value="${escapeHtml(key)}" placeholder="Pega aquí tu clave API" autocomplete="off"><label class="field-label">Modelo</label><input type="text" id="s-model" value="${escapeHtml(model)}" placeholder="ej: gpt-5.4-mini">${p === 'openai' ? '<div class="btn-row"><button type="button" class="btn btn-primary btn-sm" id="s-openai-mini">💸 Economía · GPT-5.4 Mini</button><button type="button" class="btn btn-ghost btn-sm" id="s-openai-sol">✨ Sol · más caro</button></div><p class="muted">Para fanfics diarios, GPT-5.4 Mini queda como opción económica. Sol sigue disponible para escenas especiales: el botón solo cambia el ID y tú decides cuándo guardarlo.</p>' : ''}${p === 'openrouter' ? '<p class="muted">🌸 Para escribir fanfics, prueba <b>arcee-ai/trinity-large-preview:free</b>. <code>openrouter/free</code> elige modelos gratuitos al azar y algunos pueden devolver una respuesta vacía. También puedes usar otros IDs acabados en <code>:free</code>; no admite modelos de pago. <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer">Crear clave gratuita de OpenRouter ↗</a>. La clave de Gemini no sirve aquí. Los modelos gratuitos pueden tener límites y saturación.</p>' : ''}`;
    if (p === 'openai') {
      document.getElementById('s-openai-mini')?.addEventListener('click', () => { document.getElementById('s-model').value = 'gpt-5.4-mini'; toast('Modo economía seleccionado. Pulsa «Guardar ajustes» para aplicarlo.'); });
      document.getElementById('s-openai-sol')?.addEventListener('click', () => { document.getElementById('s-model').value = 'gpt-5.6-sol'; toast('Sol seleccionado. Pulsa «Guardar ajustes» para aplicarlo.'); });
    }
  }
  bindAppearanceSettings();
  renderProviderFields();
  document.getElementById('s-provider').addEventListener('change', renderProviderFields);

  // --- Writing DNA 4 ámbitos + anti-patrones ---
  const renderDnaScopeEditor = () => {
    const prof = profilesByScope[activeScope];
    document.getElementById('dna-manuscript-lang').value = prof.manuscriptLanguage || 'en';
    document.getElementById('dna-qualities').value = (prof.literaryQualities || []).join('\n');
    document.getElementById('dna-custom-notes').value = prof.customNotes || '';
    const apEl = document.getElementById('dna-antipatterns-list');
    const aps = prof.antiPatterns || [];
    apEl.innerHTML = aps.length
      ? aps.map((ap, idx) => `
          <label style="display:flex; align-items:center; gap:8px; margin:4px 0;">
            <input type="checkbox" class="dna-ap-check" data-idx="${idx}" ${ap.enabled !== false ? 'checked' : ''}>
            <span>${escapeHtml(ap.label)}</span>
          </label>`).join('')
      : '<p class="muted">Sin anti-patrones propios en este ámbito (hereda los del ámbito superior).</p>';
  };
  renderDnaScopeEditor();

  document.getElementById('dna-scope-select')?.addEventListener('change', (e) => {
    activeScope = e.target.value;
    renderDnaScopeEditor();
  });

  document.getElementById('dna-ap-add-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('dna-ap-add-input');
    const label = inp.value.trim();
    if (!label) return;
    profilesByScope[activeScope].antiPatterns = [
      ...(profilesByScope[activeScope].antiPatterns || []),
      { id: db.uid(), label, enabled: true },
    ];
    inp.value = '';
    renderDnaScopeEditor();
  });

  document.getElementById('dna-save-btn')?.addEventListener('click', async () => {
    const current = profilesByScope[activeScope];
    const updatedAntiPatterns = (current.antiPatterns || []).map((ap, idx) => {
      const cb = document.querySelector(`.dna-ap-check[data-idx="${idx}"]`);
      return { ...ap, enabled: cb ? cb.checked : ap.enabled !== false };
    });
    const saved = await saveWritingDnaProfile({
      ...current,
      scope: activeScope,
      fandom: activeScope === 'fandom' ? fandom : '',
      projectId: activeScope === 'story' ? projectId : null,
      manuscriptLanguage: document.getElementById('dna-manuscript-lang').value || 'en',
      literaryQualities: linesToArray(document.getElementById('dna-qualities').value),
      customNotes: document.getElementById('dna-custom-notes').value.trim(),
      antiPatterns: updatedAntiPatterns,
    });
    profilesByScope[activeScope] = saved;
    toast(`Writing DNA (${activeScope}) guardado.`);
  });

  document.getElementById('dna-export-global-btn')?.addEventListener('click', async () => {
    const [freshGlobal, allFb] = await Promise.all([
      getWritingDnaProfile({ scope: 'global' }),
      listEditorialFeedback({ scope: 'global', status: 'approved' }),
    ]);
    const payload = exportGlobalWritingDnaProfile(freshGlobal, allFb);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inky-writing-dna-global-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('dna-import-global-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await importGlobalWritingDnaProfile(data);
      toast(`Writing DNA global importado (${res.importedRulesCount} reglas globales aprobadas).`);
      renderSettings(root);
    } catch (err) {
      toast(err.message || 'No se pudo importar el Writing DNA global.', { error: true });
    }
  });

  // --- Aprendizaje editorial revisado ---
  const renderEditorialProposals = (items) => {
    const slot = document.getElementById('ed-proposals-list');
    if (!slot) return;
    if (!items.length) {
      slot.innerHTML = '<p class="muted">Aún no has registrado correcciones editoriales antes/después.</p>';
      return;
    }
    slot.innerHTML = items.map((item) => `
      <div class="list-item" data-fb-id="${escapeHtml(item.id)}">
        <div class="title-row">
          <b>[${escapeHtml(item.scope)}] ${escapeHtml(item.category || 'oficio')}</b>
          <span class="pill ${item.status === 'approved' ? 'pill-active' : (item.status === 'rejected' ? 'pill-inactive' : 'pill-reference')}">${escapeHtml(FEEDBACK_STATUS_LABELS[item.status] || item.status)}</span>
        </div>
        ${item.scopeGuardWarning ? `<div class="context-guard-item context-guard-warning" style="margin:6px 0;">${escapeHtml(item.scopeGuardWarning)}</div>` : ''}
        <label class="field-label">Regla propuesta (editable)</label>
        <input type="text" class="ed-rule-edit" value="${escapeHtml(item.ruleText || '')}">
        <div class="muted" style="font-size:12px; margin:4px 0;"><b>Motivo:</b> ${escapeHtml(item.reason || '')} · Revisiones: ${(item.revisionHistory || []).length}</div>
        <div class="btn-row">
          ${item.status !== 'approved' ? '<button type="button" class="btn btn-primary btn-sm act-ed-approve">✓ Aprobar</button>' : '<button type="button" class="btn btn-ghost btn-sm act-ed-deactivate">Desactivar</button>'}
          ${item.status === 'proposed' ? '<button type="button" class="btn btn-danger btn-sm act-ed-reject">✗ Rechazar</button>' : ''}
          <button type="button" class="btn btn-danger btn-sm act-ed-delete">Eliminar</button>
        </div>
      </div>`).join('');

    slot.querySelectorAll('.list-item').forEach((el) => {
      const id = el.dataset.fbId;
      const getEditedRule = () => el.querySelector('.ed-rule-edit')?.value.trim() || '';
      el.querySelector('.act-ed-approve')?.addEventListener('click', async () => {
        try {
          await decideEditorialProposal(id, 'approved', { editedRuleText: getEditedRule() });
          toast('Regla editorial aprobada.');
          renderSettings(root);
        } catch (err) {
          toast(err.message, { error: true, ms: 7000 });
        }
      });
      el.querySelector('.act-ed-reject')?.addEventListener('click', async () => {
        await decideEditorialProposal(id, 'rejected', { editedRuleText: getEditedRule() });
        toast('Propuesta rechazada.');
        renderSettings(root);
      });
      el.querySelector('.act-ed-deactivate')?.addEventListener('click', async () => {
        await decideEditorialProposal(id, 'deactivated', { editedRuleText: getEditedRule() });
        toast('Regla editorial desactivada.');
        renderSettings(root);
      });
      el.querySelector('.act-ed-delete')?.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este registro editorial?')) return;
        await deleteEditorialFeedback(id);
        renderSettings(root);
      });
    });
  };
  renderEditorialProposals(feedbackItems);

  document.getElementById('ed-submit-btn')?.addEventListener('click', async () => {
    try {
      const rec = await recordEditorialFeedback({
        originalPassage: document.getElementById('ed-orig').value,
        revisedPassage: document.getElementById('ed-rev').value,
        authorNote: document.getElementById('ed-note').value,
        requestedScope: document.getElementById('ed-scope').value,
        fandom,
        projectId,
      });
      toast(rec.scopeGuardWarning
        ? 'Propuesta creada y restringida a esta historia para proteger el Writing DNA global.'
        : 'Propuesta editorial creada. Revísala y apruébala abajo si quieres activarla.');
      renderSettings(root);
    } catch (err) {
      toast(err.message || 'No se pudo registrar la corrección.', { error: true });
    }
  });

  // --- Eventos originales preservados ---
  document.getElementById('s-author-save')?.addEventListener('click', async () => {
    await saveAuthorBrain({
      writingDna: document.getElementById('s-writing-dna').value.trim() || DEFAULT_WRITING_DNA,
      prepEnabled: document.getElementById('s-author-prep').checked,
    });
    toast('Cerebro de autora guardado para esta historia.');
  });
  document.getElementById('s-author-reset')?.addEventListener('click', () => {
    document.getElementById('s-writing-dna').value = DEFAULT_WRITING_DNA;
    toast('Writing DNA restaurado en el formulario. Pulsa «Guardar cerebro de autora» para aplicarlo.');
  });
  document.getElementById('s-save-btn').addEventListener('click', async () => {
    const fresh = (await db.get('settings', 'main')) || { id: 'main', apiKeys: {}, models: {} };
    const p = document.getElementById('s-provider').value;
    fresh.provider = p;
    fresh.apiKeys = { ...fresh.apiKeys, [p]: document.getElementById('s-apikey').value.trim() };
    fresh.models = { ...fresh.models, [p]: document.getElementById('s-model').value.trim() };
    fresh.blockWordSize = parseInt(document.getElementById('s-blocksize').value, 10) || 1000;
    fresh.defaultGenerationMode = document.getElementById('s-generation-mode').value || 'full_chapter';
    fresh.id = 'main';
    await db.put('settings', fresh);
    toast('Ajustes guardados.');
  });
  document.getElementById('s-export-btn').addEventListener('click', async () => {
    const dump = await db.exportAll();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `power-to-strive-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById('s-import-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const dump = JSON.parse(text);
      const info = db.validateBackupDump(dump);
      const isPartial = !info.isFull;
      const msg = isPartial
        ? `Este archivo es una copia PARCIAL (${info.targetStores.join(', ')}). Se combinará sin borrar tus demás almacenes ni sobrescribir otras historias. Tus claves API locales se conservarán. ¿Continuar?`
        : 'Esta es una copia COMPLETA y reemplazará los datos actuales de la app. Tus claves API locales NO se reemplazarán ni se leerán desde el archivo. ¿Continuar?';
      if (!confirm(msg)) return;
      await db.importAll(dump, { merge: isPartial });
      toast(isPartial ? 'Importación parcial combinada con éxito 🔐. Recargando…' : 'Copia completa importada. Tus claves API locales se conservaron 🔐. Recargando…');
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      toast('No se pudo importar (tus datos actuales siguen intactos): ' + (err?.message || err), { error: true, ms: 8500 });
    }
  });
}
