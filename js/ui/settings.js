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
import {
  MODEL_CATALOG,
  REASONING_EFFORT_OPTIONS,
  WALLET_NOTICES,
  getWalletConfig,
  saveWalletConfig,
  getCatalogModelInfo,
  resolveModelPricing,
  getUsageSummary,
} from '../inkyWallet.js';

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
  const [settings, authorBrain, storyConfig, globalDna, feedbackItems, walletConfig, usageSummary] = await Promise.all([
    db.get('settings', 'main'),
    getAuthorBrain(),
    getStoryConfig(projectId),
    getWritingDnaProfile({ scope: 'global' }),
    listEditorialFeedback({ projectId }),
    getWalletConfig(),
    getUsageSummary(),
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
        <option value="full_chapter" ${safeSettings.defaultGenerationMode === 'full_chapter' || !safeSettings.defaultGenerationMode ? 'selected' : ''}>📖 Capítulo completo · una sola llamada</option>
        <option value="novel_orchestrated" ${safeSettings.defaultGenerationMode === 'novel_orchestrated' ? 'selected' : ''}>📚 Novel Mode · orquestado por escenas</option>
        <option value="blocks" ${safeSettings.defaultGenerationMode === 'blocks' ? 'selected' : ''}>🧩 Por bloques · revisar paso a paso</option>
      </select>
      <p class="muted">Capítulo completo pide toda la extensión en una sola llamada; Novel Mode orquesta tramos continuos (3k/5k/7k/custom) con presupuesto visible antes de iniciar; Por bloques usa el tamaño de abajo.</p>
      <label class="field-label">Tamaño por llamada en modo «Por bloques»</label>
      <select id="s-blocksize">
        <option value="1000" ${(safeSettings.blockWordSize || 1000) === 1000 ? 'selected' : ''}>1.000 palabras</option>
        <option value="2000" ${(safeSettings.blockWordSize || 1000) === 2000 ? 'selected' : ''}>2.000 palabras</option>
        <option value="3000" ${(safeSettings.blockWordSize || 1000) === 3000 ? 'selected' : ''}>3.000 palabras</option>
        <option value="5000" ${(safeSettings.blockWordSize || 1000) === 5000 ? 'selected' : ''}>5.000 palabras</option>
        <option value="7000" ${(safeSettings.blockWordSize || 1000) === 7000 ? 'selected' : ''}>7.000 palabras</option>
      </select>
      <p class="muted">Una llamada más larga usa más tokens. Para capítulos cohesionados de 5k–7k, usa «Capítulo completo» o «Novel Mode».</p>
      <div class="btn-row"><button class="btn btn-primary" id="s-save-btn">Guardar ajustes</button></div>
    </div>

    <div class="card" id="inky-wallet-card">
      <div class="card-row">
        <div>
          <h3>💰 Inky Wallet · Modelos, Presupuesto y Uso Local</h3>
          <p class="muted">${escapeHtml(WALLET_NOTICES.apiModelIdNote)}</p>
        </div>
        <span class="pill pill-active">🛡️ Sin fallback silencioso</span>
      </div>
      <div class="grid-2" style="margin-top:8px;">
        <div>
          <label class="field-label" for="w-primary-provider">Proveedor literario principal</label>
          <select id="w-primary-provider">${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${walletConfig.primaryProvider === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select>
          <label class="field-label" for="w-primary-model">Modelo literario principal (ID de API o personalizado)</label>
          <input type="text" id="w-primary-model" list="w-primary-model-list" value="${escapeHtml(walletConfig.primaryModel)}" placeholder="ej: gpt-5.4-mini">
          <datalist id="w-primary-model-list">${(MODEL_CATALOG[walletConfig.primaryProvider] || []).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('')}</datalist>
          <div id="w-primary-model-warning" class="muted" style="font-size:12px; margin-top:4px;"></div>
        </div>
        <div>
          <label class="field-label" for="w-aux-provider">Proveedor auxiliar (Chat Creativo / Revisión / Continuidad)</label>
          <select id="w-aux-provider">${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${walletConfig.auxiliaryProvider === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select>
          <label class="field-label" for="w-aux-model">Modelo auxiliar (ID de API o personalizado)</label>
          <input type="text" id="w-aux-model" list="w-aux-model-list" value="${escapeHtml(walletConfig.auxiliaryModel)}" placeholder="ej: gpt-5.4-mini">
          <datalist id="w-aux-model-list">${(MODEL_CATALOG[walletConfig.auxiliaryProvider] || []).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('')}</datalist>
        </div>
      </div>
      <div class="grid-2" style="margin-top:8px;">
        <div>
          <label class="field-label" for="w-reasoning-effort">Esfuerzo de razonamiento (solo donde la API lo soporta)</label>
          <select id="w-reasoning-effort">${REASONING_EFFORT_OPTIONS.map((opt) => `<option value="${opt}" ${walletConfig.reasoningEffort === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        </div>
        <div>
          <label class="field-label" for="w-max-output">Límite máximo de tokens de salida por solicitud (incluye razonamiento)</label>
          <input type="number" id="w-max-output" min="256" max="128000" step="256" value="${Number(walletConfig.maxOutputTokensPerRequest) || 16384}">
        </div>
      </div>
      <div class="grid-2" style="margin-top:8px;">
        <div>
          <label class="field-label" for="w-max-spend">Límite estimado local por generación (USD · 0 = sin tope local)</label>
          <input type="number" id="w-max-spend" min="0" max="100" step="0.05" value="${Number(walletConfig.maxGenerationSpendUsd ?? 0.50)}">
          <label style="display:block; font-size:12px; margin-top:6px;">
            <input type="checkbox" id="w-allow-unknown-override" ${walletConfig.allowUnknownCostOverride === true ? 'checked' : ''}>
            Reconozco el riesgo y permito solicitudes con <b>costo desconocido</b> aunque haya un límite estimado activo (nunca se trata como $0).
          </label>
        </div>
        <div>
          <label class="field-label">Análisis opcionales (solo cuando los autorices)</label>
          <label style="display:block; font-size:13px;"><input type="checkbox" id="w-opt-semantic" ${walletConfig.optionalAnalysis?.semanticReviewEnabled ? 'checked' : ''}> Mostrar botón de revisión editorial semántica (IA)</label>
          <label style="display:block; font-size:13px;"><input type="checkbox" id="w-opt-continuity" ${walletConfig.optionalAnalysis?.continuityExtractionEnabled ? 'checked' : ''}> Recordar propuesta de continuidad tras aprobar capítulo</label>
        </div>
      </div>
      <details style="margin-top:10px;">
        <summary style="cursor:pointer; font-weight:600;">📊 Tabla configurable de tarifas (USD por 1M tokens) y uso local registrado</summary>
        <div id="w-pricing-info" class="muted" style="font-size:12px; margin-top:6px;"></div>
        <div class="grid-2" style="margin-top:6px;">
          <div>
            <label class="field-label" for="w-price-model-key">Modelo para tarifa personalizada (ej: openai:mi-modelo)</label>
            <input type="text" id="w-price-model-key" placeholder="openai:gpt-5.4-mini">
          </div>
          <div class="grid-2">
            <div><label class="field-label" for="w-price-in">Entrada $/1M</label><input type="number" id="w-price-in" min="0" step="0.01" placeholder="0.75"></div>
            <div><label class="field-label" for="w-price-out">Salida $/1M</label><input type="number" id="w-price-out" min="0" step="0.01" placeholder="4.50"></div>
          </div>
        </div>
        <div class="btn-row" style="margin-top:6px;">
          <button type="button" class="btn btn-ghost btn-sm" id="w-price-save-btn">+ Guardar tarifa personalizada</button>
        </div>
        <div id="w-usage-summary-box" style="margin-top:8px; font-size:13px;">
          <b>Uso de esta sesión:</b> ${usageSummary.session.requests} solicitud(es) · Real reportado: $${usageSummary.session.actualCostUsd.toFixed(4)} USD · Estimado local: $${usageSummary.session.estimatedOnlyCostUsd.toFixed(4)} USD${usageSummary.session.unknownCostRequests ? ` · ${usageSummary.session.unknownCostRequests} con costo desconocido` : ''}<br>
          <b>Total histórico registrado (IndexedDB):</b> ${usageSummary.totalRecorded.requests} solicitud(es) · Real reportado: $${usageSummary.totalRecorded.actualCostUsd.toFixed(4)} USD · Estimado local: $${usageSummary.totalRecorded.estimatedOnlyCostUsd.toFixed(4)} USD${usageSummary.totalRecorded.unknownCostRequests ? ` · ${usageSummary.totalRecorded.unknownCostRequests} con costo desconocido` : ''}
        </div>
      </details>
      <div class="context-guard-item context-guard-info" style="margin-top:10px; font-size:12px;">
        <div><b>ℹ️ Transparencia de costos (estimación local, NO tope garantizado del proveedor):</b> ${escapeHtml(WALLET_NOTICES.localUsageNotAccountBalance)}</div>
        <div style="margin-top:4px;"><b>⚠️ Solicitudes interrumpidas:</b> ${escapeHtml(WALLET_NOTICES.failedOrCancelledChargeWarning)}</div>
        <div style="margin-top:4px;"><b>🔐 Credenciales locales y envío de contexto:</b> ${escapeHtml(WALLET_NOTICES.localCredentialsAndTransmission)}</div>
        <div style="margin-top:4px;">${escapeHtml(WALLET_NOTICES.geminiBillingNotice)}</div>
      </div>
      <div class="btn-row" style="margin-top:8px;"><button type="button" class="btn btn-primary" id="w-wallet-save-btn">💾 Guardar Inky Wallet</button></div>
    </div>

    <div class="card" id="writing-dna-studio-card">
      <div class="card-row">
        <div>
          <h3>🧬 Writing DNA en 4 ámbitos y Anti-patrones literarios</h3>
          <p class="muted">Define tu voz literaria global compartida entre historias, preferencias por fandom (${escapeHtml(fandom)}) y ajustes solo para esta historia. Manuscritos en inglés por defecto; interfaz en español.</p>
        </div>
        <span class="pill pill-active" title="Writing DNA global y reglas editoriales aprobadas están conectadas al Motor de Contexto Unificado.">✅ Conectado al Context Engine</span>
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

  // --- Inky Wallet y Modelos ---
  const refreshWalletPreview = () => {
    const prov = document.getElementById('w-primary-provider')?.value || 'openai';
    const mod = document.getElementById('w-primary-model')?.value.trim() || '';
    const info = getCatalogModelInfo(prov, mod);
    const warnEl = document.getElementById('w-primary-model-warning');
    if (warnEl) {
      const pricing = resolveModelPricing(prov, mod, walletConfig);
      const priceText = pricing
        ? `Tarifa configurada: $${pricing.inputPer1M}/1M entrada · $${pricing.outputPer1M}/1M salida (${pricing.source}, act. ${pricing.lastUpdated || 'N/A'})`
        : 'Tarifa no configurada: se mostrará «costo desconocido» (no se inventan precios).';
      const reasoningText = info.supportsReasoningEffort
        ? `Soporta reasoning_effort (${info.supportedReasoningEfforts.join('/')}).`
        : 'Este modelo no usa parámetro reasoning_effort.';
      warnEl.textContent = [info.capabilityWarning, reasoningText, priceText].filter(Boolean).join(' · ');
    }
    const priceInfoEl = document.getElementById('w-pricing-info');
    if (priceInfoEl) {
      const catalogItems = (MODEL_CATALOG[prov] || []).map((m) => {
        const p = resolveModelPricing(prov, m.id, walletConfig);
        return p
          ? `<code>${escapeHtml(m.id)}</code>: $${p.inputPer1M}/$${p.outputPer1M} por 1M (${escapeHtml(p.lastUpdated || '')})`
          : `<code>${escapeHtml(m.id)}</code>: costo desconocido`;
      });
      const customKeys = Object.entries(walletConfig.customPricingTable || {}).map(
        ([k, p]) => `<code>${escapeHtml(k)}</code>: $${p.inputPer1M}/$${p.outputPer1M} por 1M (personalizada · ${escapeHtml(p.lastUpdated || '')})`
      );
      priceInfoEl.innerHTML = [...catalogItems, ...customKeys].join('<br>') || 'Sin tarifas configuradas.';
    }
  };
  refreshWalletPreview();

  document.getElementById('w-primary-provider')?.addEventListener('change', (e) => {
    const dl = document.getElementById('w-primary-model-list');
    const items = MODEL_CATALOG[e.target.value] || [];
    if (dl) dl.innerHTML = items.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
    refreshWalletPreview();
  });
  document.getElementById('w-aux-provider')?.addEventListener('change', (e) => {
    const dl = document.getElementById('w-aux-model-list');
    const items = MODEL_CATALOG[e.target.value] || [];
    if (dl) dl.innerHTML = items.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
  });
  document.getElementById('w-primary-model')?.addEventListener('input', refreshWalletPreview);

  document.getElementById('w-price-save-btn')?.addEventListener('click', async () => {
    const key = document.getElementById('w-price-model-key')?.value.trim();
    const inputPer1M = Number(document.getElementById('w-price-in')?.value);
    const outputPer1M = Number(document.getElementById('w-price-out')?.value);
    if (!key || !Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M) || inputPer1M < 0 || outputPer1M < 0) {
      return toast('Indica un ID de modelo y tarifas numéricas válidas (≥ 0).', { error: true });
    }
    const nextTable = {
      ...(walletConfig.customPricingTable || {}),
      [key]: {
        inputPer1M,
        outputPer1M,
        cachedInputPer1M: inputPer1M,
        source: 'Tarifa personalizada por la autora',
        lastUpdated: new Date().toISOString().slice(0, 10),
      },
    };
    await saveWalletConfig({ customPricingTable: nextTable });
    toast(`Tarifa personalizada guardada para ${key}.`);
    renderSettings(root);
  });

  document.getElementById('w-wallet-save-btn')?.addEventListener('click', async () => {
    await saveWalletConfig({
      primaryProvider: document.getElementById('w-primary-provider')?.value || 'openai',
      primaryModel: document.getElementById('w-primary-model')?.value.trim() || 'gpt-5.4-mini',
      auxiliaryProvider: document.getElementById('w-aux-provider')?.value || 'openai',
      auxiliaryModel: document.getElementById('w-aux-model')?.value.trim() || 'gpt-5.4-mini',
      reasoningEffort: document.getElementById('w-reasoning-effort')?.value || 'none',
      maxOutputTokensPerRequest: Number(document.getElementById('w-max-output')?.value || 16384),
      maxGenerationSpendUsd: Number(document.getElementById('w-max-spend')?.value ?? 0.50),
      allowUnknownCostOverride: Boolean(document.getElementById('w-allow-unknown-override')?.checked),
      optionalAnalysis: {
        prepEnabled: false,
        semanticReviewEnabled: Boolean(document.getElementById('w-opt-semantic')?.checked),
        continuityExtractionEnabled: Boolean(document.getElementById('w-opt-continuity')?.checked),
      },
    });
    toast('Configuración de Inky Wallet guardada.');
    renderSettings(root);
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
    const mod = document.getElementById('s-model').value.trim();
    fresh.provider = p;
    fresh.apiKeys = { ...fresh.apiKeys, [p]: document.getElementById('s-apikey').value.trim() };
    fresh.models = { ...fresh.models, [p]: mod };
    fresh.blockWordSize = parseInt(document.getElementById('s-blocksize').value, 10) || 1000;
    fresh.defaultGenerationMode = document.getElementById('s-generation-mode').value || 'full_chapter';
    fresh.id = 'main';
    await db.put('settings', fresh);
    await saveWalletConfig({ primaryProvider: p, primaryModel: mod || walletConfig.primaryModel });
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
