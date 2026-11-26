// ui/planner.js — Chat Creativo persistente por historia (SOS de ideas mejorado),
// recuperación acotada de historial, extracción de propuestas editables con
// aprobación selectiva (0 tokens en modo local) y Briefs de Capítulo hacia Escribir.
//
// Invariante: explorar ideas en el chat NUNCA altera el canon, storyConfigs ni
// knowledgeFacts hasta que la autora aprueba explícitamente ítems concretos.

import { db } from '../db.js';
import { getProviderForRole, getModelOutputLimit } from '../providers/index.js';
import { getActiveGenerationState } from '../generation.js';
import { escapeHtml, toast, bus, copyTextToClipboard, openModal, closeModal } from '../utils.js';
import { getStoryConfig } from '../storyConfigSchema.js';
import { assembleOperationContext } from '../contextEngine.js';
import { getWalletConfig, checkGenerationBudget, recordUsageEvent } from '../inkyWallet.js';
import {
  getCreativeChat,
  saveCreativeChat,
  buildRollingChatSummary,
  extractConversationalProposal,
  applySelectiveProposalDecision,
  listChapterBriefs,
  saveChapterBrief,
  transferApprovedBriefToWrite,
} from '../creativeChat.js';

const HISTORY_LIMIT = 80;
const projectDraftId = (projectId) => 'planner-draft:' + projectId;
const linesToArray = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const csvToArray = (t) => String(t || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

function renderMessages(root, messages) {
  const list = root.querySelector('#planner-messages');
  if (!list) return;
  list.innerHTML = messages.length ? messages.map((m, index) =>
    '<div class="planner-message ' + (m.role === 'user' ? 'planner-user' : 'planner-assistant') + '">' +
      '<div class="planner-message-label">' + (m.role === 'user' ? 'Tú' : '💡 Inky · Chat Creativo') + '</div>' +
      '<div class="planner-message-text">' + escapeHtml(m.text) + '</div>' +
      (m.role === 'assistant' ? '<div class="planner-message-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm planner-copy" data-message-index="' + index + '">📋 Copiar</button>' +
        '<button type="button" class="btn btn-ghost btn-sm planner-use" data-message-index="' + index + '">✒️ Pasar a Escribir</button>' +
        '</div>' : '') +
    '</div>'
  ).join('') : '<p class="planner-empty">Empieza como quieras — ¡incluso con «OKAAAAY SOOOO...»! Explora escenas, secretos, falsas creencias o caminos alternativos en español o inglés sin miedo a tocar el canon 💗</p>';
  list.scrollTop = list.scrollHeight;
}

export async function renderPlanner(root) {
  const projectId = db.getActiveProjectId();
  const [chatRecord, storyConfig, briefs] = await Promise.all([
    getCreativeChat(projectId),
    getStoryConfig(projectId),
    listChapterBriefs({ projectId }),
  ]);
  let messages = (chatRecord?.messages || []).filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string');
  let activeProposal = (chatRecord?.pendingProposals || []).find((p) => p.status === 'proposed' || p.status === 'partially_resolved') || null;
  let busy = false;
  let activeController = null;

  root.innerHTML = `
    <div class="card-row" style="align-items:flex-start; margin-bottom:6px;">
      <div>
        <h2 class="section-title" style="margin-bottom:4px;">🆘 SOS de ideas · Chat Creativo</h2>
        <p class="section-hint" style="margin-bottom:0;">Flujo: Chat Creativo → Ideas posibles → Propuestas selectivas / Brief aprobado → Escribir. Las ideas aquí NUNCA alteran tu canon sin tu aprobación explícita.</p>
      </div>
      <span class="pill pill-reference">💬 Historial acotado · independiente por historia</span>
    </div>

    <div class="card">
      <div class="planner-chat" role="log" aria-label="Conversación de planificación" id="planner-messages"></div>
      <label class="field-label" for="planner-input">Lluvia de ideas libre (español o inglés)</label>
      <textarea id="planner-input" rows="4" maxlength="6000" placeholder="Ej: OKAAAAY SOOOO what if Joseph knows Erwin and Levi used to date, but Hange thinks something completely different HAHAHAHA. Also no Violet traits this time!"></textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="planner-send">💬 Enviar a IA (Chat Creativo)</button>
        <button type="button" class="btn btn-ghost" id="planner-extract-btn">✨ Extractor heurístico local (0 tokens)</button>
        <button type="button" class="btn btn-danger" id="planner-abort" style="display:none;">⏹ Cancelar</button>
        <button type="button" class="btn btn-ghost" id="planner-clear">Nueva conversación</button>
      </div>
      <p id="planner-status" class="muted" role="status">«Enviar a IA» usa el Motor de Contexto Unificado (modelo auxiliar en Inky Wallet) con historial acotado. El extractor heurístico local (0 tokens) es solo un ayudante rápido gratuito y no equivale a una conversación completa con IA. Las respuestas del chat nunca sobrescriben el manuscrito.</p>
      <div id="planner-proposals-slot" style="margin-top:10px;"></div>
    </div>

    <div class="card" id="chapter-brief-card">
      <div class="card-row">
        <div>
          <h3>📋 Brief de Capítulo (guía flexible hacia Escribir)</h3>
          <p class="muted">Convierte tus ideas en un brief estructurado y revisable (objetivo, POV, participantes, secretos, cierre y extensión) sin perder libertad creativa al escribir.</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="brief-new-btn">+ Nuevo Brief de Capítulo</button>
      </div>
      <div id="chapter-briefs-list" style="margin-top:8px;"></div>
    </div>

    <div class="card">
      <h3>¿Sin ideas? Empieza por aquí</h3>
      <div class="btn-row">
        <button type="button" class="btn btn-ghost btn-sm planner-example" data-prompt="Dame tres caminos distintos y coherentes con el canon para el próximo capítulo, basándote en el final exacto de mi último capítulo guardado. Evita revelar secretos antes de tiempo.">🌷 Dame 3 ideas</button>
        <button type="button" class="btn btn-ghost btn-sm planner-example" data-prompt="¿Qué tensiones entre personajes y conversaciones de la sala de reacciones podrían seguir de forma natural al final del capítulo más reciente? Sorpréndeme sin cambiar el canon establecido.">🎭 ¿Cómo reaccionarían?</button>
        <button type="button" class="btn btn-ghost btn-sm planner-example" data-prompt="Ayúdame a crear un plan breve, escena por escena, para mi próximo capítulo. Hazme primero una pregunta si necesitas que tome una decisión importante.">📖 Planear capítulo</button>
      </div>
    </div>
    <p class="muted">Esta conversación se guarda de forma independiente para esta historia en IndexedDB. Ninguna idea modifica tus capítulos, canon ni personajes hasta que la apruebes.</p>
  `;

  const input = root.querySelector('#planner-input');
  const send = root.querySelector('#planner-send');
  const extractBtn = root.querySelector('#planner-extract-btn');
  const abortBtn = root.querySelector('#planner-abort');
  const clear = root.querySelector('#planner-clear');
  const status = root.querySelector('#planner-status');
  const proposalsSlot = root.querySelector('#planner-proposals-slot');

  renderMessages(root, messages);

  // --- Renderizar tarjeta de propuesta editable con aprobación selectiva ---
  const renderProposalCard = () => {
    if (!activeProposal) {
      proposalsSlot.innerHTML = '';
      return;
    }
    const blocksHtml = (activeProposal.safetyBlocks || []).map((b) =>
      `<div class="context-guard-item context-guard-critical" style="margin:6px 0;"><b>🛑 Protección automática:</b> ${escapeHtml(b.message)}</div>`
    ).join('');
    const itemsHtml = (activeProposal.items || []).map((item) => `
      <div class="list-item" data-item-id="${escapeHtml(item.itemId)}">
        <label style="display:flex; align-items:flex-start; gap:8px;">
          <input type="checkbox" class="prop-item-check" value="${escapeHtml(item.itemId)}" ${item.status === 'proposed' ? 'checked' : ''} ${item.status !== 'proposed' ? 'disabled' : ''}>
          <div style="flex:1;">
            <div class="title-row">
              <b>${escapeHtml(item.label)}</b>
              <span class="pill ${item.status === 'approved' ? 'pill-active' : (item.status === 'rejected' ? 'pill-inactive' : 'pill-reference')}">${escapeHtml(item.status)}</span>
            </div>
            <div style="font-size:13px; margin:2px 0;">${escapeHtml(item.summary)}</div>
            ${(item.kind === 'epistemic_knowledge' || item.kind === 'epistemic_false_belief') ? `<input type="text" class="prop-item-belief-edit" value="${escapeHtml(item.payload?.beliefText || '')}" style="margin-top:4px;" placeholder="Edita el texto exacto de esta creencia/conocimiento">` : ''}
            ${item.safetyNotes?.length ? `<div class="muted" style="font-size:12px;">ℹ️ ${escapeHtml(item.safetyNotes.join(' · '))}</div>` : ''}
          </div>
        </label>
      </div>`).join('');

    proposalsSlot.innerHTML = `
      <div class="paper" id="planner-proposal-review-card" style="padding:12px;">
        <div class="card-row">
          <div>
            <b>🧩 Propuesta editable extraída (${activeProposal.isConditional ? 'idea condicional / borrador' : 'cambios propuestos'})</b>
            <div class="muted" style="font-size:12px;">Marca SOLO los cambios que quieres aprobar; los desmarcados quedarán rechazados y nunca tocarán tu canon.</div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="prop-dismiss-btn">Cerrar</button>
        </div>
        ${blocksHtml}
        <div style="margin-top:6px;">${itemsHtml}</div>
        <div class="btn-row" style="margin-top:8px;">
          <button type="button" class="btn btn-primary btn-sm" id="prop-apply-selected-btn">✓ Aplicar solo los marcados</button>
          <button type="button" class="btn btn-danger btn-sm" id="prop-reject-all-btn">✗ Rechazar todo</button>
        </div>
      </div>`;

    proposalsSlot.querySelector('#prop-dismiss-btn')?.addEventListener('click', () => {
      activeProposal = null;
      renderProposalCard();
    });

    proposalsSlot.querySelector('#prop-apply-selected-btn')?.addEventListener('click', async () => {
      const approvedIds = [];
      const rejectedIds = [];
      const editedPayloads = {};
      proposalsSlot.querySelectorAll('.list-item[data-item-id]').forEach((row) => {
        const itemId = row.dataset.itemId;
        const cb = row.querySelector('.prop-item-check');
        if (!cb || cb.disabled) return;
        if (cb.checked) {
          approvedIds.push(itemId);
          const editInp = row.querySelector('.prop-item-belief-edit');
          if (editInp) editedPayloads[itemId] = { beliefText: editInp.value.trim() };
        } else {
          rejectedIds.push(itemId);
        }
      });
      const res = await applySelectiveProposalDecision(projectId, activeProposal, {
        approvedItemIds: approvedIds,
        rejectedItemIds: rejectedIds,
        editedPayloads,
      });
      activeProposal = res.proposal;
      const freshChat = await getCreativeChat(projectId);
      const nextPending = (freshChat.pendingProposals || []).filter((p) => p.id !== activeProposal.id);
      await saveCreativeChat({ ...freshChat, pendingProposals: [...nextPending, activeProposal] }, { projectId });
      toast(`Decisión aplicada: ${approvedIds.length} aprobado(s), ${rejectedIds.length} rechazado(s).`);
      renderProposalCard();
    });

    proposalsSlot.querySelector('#prop-reject-all-btn')?.addEventListener('click', async () => {
      const allIds = (activeProposal.items || []).map((i) => i.itemId);
      await applySelectiveProposalDecision(projectId, activeProposal, { approvedItemIds: [], rejectedItemIds: allIds });
      const freshChat = await getCreativeChat(projectId);
      await saveCreativeChat({ ...freshChat, pendingProposals: (freshChat.pendingProposals || []).filter((p) => p.id !== activeProposal.id) }, { projectId });
      activeProposal = null;
      toast('Propuesta rechazada por completo. Tu canon no cambió.');
      renderProposalCard();
    });
  };
  renderProposalCard();

  // --- Renderizar Briefs de Capítulo ---
  const renderBriefsList = (list) => {
    const el = root.querySelector('#chapter-briefs-list');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="muted">Todavía no has creado ningún Brief de Capítulo para esta historia.</p>';
      return;
    }
    el.innerHTML = list.map((b) => `
      <div class="list-item" data-brief-id="${escapeHtml(b.id)}">
        <div class="title-row">
          <b>${escapeHtml(b.title || 'Brief sin título')}</b>
          <div class="chip-row">
            <span class="pill ${b.status === 'transferred' ? 'pill-active' : 'pill-reference'}">${escapeHtml(b.status)}</span>
            <span class="pill pill-character">${Number(b.targetLength) || 5000} palabras</span>
          </div>
        </div>
        ${b.objective ? `<div style="font-size:13px; margin:3px 0;"><b>Objetivo:</b> ${escapeHtml(b.objective)}</div>` : ''}
        ${b.mustRemainSecret?.length ? `<div class="muted" style="font-size:12px;"><b>Mantener en secreto:</b> ${escapeHtml(b.mustRemainSecret.join(' · '))}</div>` : ''}
        <div class="btn-row" style="margin-top:6px;">
          <button type="button" class="btn btn-primary btn-sm act-brief-send">✒️ Enviar Brief aprobado a Escribir</button>
          <button type="button" class="btn btn-ghost btn-sm act-brief-edit">Editar</button>
          <button type="button" class="btn btn-danger btn-sm act-brief-del">Eliminar</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.list-item').forEach((row) => {
      const bid = row.dataset.briefId;
      row.querySelector('.act-brief-send')?.addEventListener('click', async () => {
        if (await getActiveGenerationState()) {
          return toast('Ya hay un capítulo en curso en Escribir.', { error: true });
        }
        await transferApprovedBriefToWrite(projectId, bid);
        toast('Brief aprobado transferido a Escribir. Revísalo libremente antes de generar.');
        bus.emit('navigate', 'write');
      });
      row.querySelector('.act-brief-edit')?.addEventListener('click', async () => {
        const b = await db.get('chapterBriefs', bid, { projectId });
        if (b) openBriefModal(b);
      });
      row.querySelector('.act-brief-del')?.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este brief de capítulo?')) return;
        await db.del('chapterBriefs', bid, { projectId });
        renderPlanner(root);
      });
    });
  };
  renderBriefsList(briefs);

  const openBriefModal = (existing = null) => {
    const b = existing || {};
    openModal(`
      <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">${existing ? 'Editar Brief de Capítulo' : 'Nuevo Brief de Capítulo (guía flexible)'}</h3>
      <p class="muted">Sirve como guía creativa hacia Escribir, no te obliga a forzar cada punto si descubres una mejor dirección.</p>
      <div class="grid-2">
        <div><label class="field-label">Título orientativo</label><input type="text" id="br-title" value="${escapeHtml(b.title || '')}" placeholder="Ej: Chapter 8 — Unspoken Tea"></div>
        <div><label class="field-label">Extensión objetivo</label><select id="br-len"><option value="3000" ${(b.targetLength || 5000) === 3000 ? 'selected' : ''}>3.000 palabras</option><option value="5000" ${(b.targetLength || 5000) === 5000 ? 'selected' : ''}>5.000 palabras</option><option value="7000" ${(b.targetLength || 5000) === 7000 ? 'selected' : ''}>7.000 palabras</option></select></div>
      </div>
      <label class="field-label">Objetivo del capítulo</label>
      <textarea id="br-objective" rows="2">${escapeHtml(b.objective || '')}</textarea>
      <div class="grid-2">
        <div><label class="field-label">Perspectiva narrativa / POV</label><input type="text" id="br-pov" value="${escapeHtml(b.perspective || '')}" placeholder="Ej: Third-person close (Levi)"></div>
        <div><label class="field-label">Participantes activos (coma)</label><input type="text" id="br-cast" value="${escapeHtml((b.activeParticipants || []).join(', '))}" placeholder="Ej: erwin, levi, hange"></div>
      </div>
      <label class="field-label">Progresión emocional</label>
      <input type="text" id="br-emotion" value="${escapeHtml(b.emotionalProgression || '')}" placeholder="Ej: tensión seca -> humor involuntario -> inquietud contenida">
      <label class="field-label">Intenciones de diálogo (una por línea)</label>
      <textarea id="br-dialogue" rows="2">${escapeHtml((b.dialogueIntentions || []).join('\n'))}</textarea>
      <div class="grid-2">
        <div><label class="field-label">Revelaciones deseadas (una por línea)</label><textarea id="br-reveal" rows="2">${escapeHtml((b.desiredRevelations || []).join('\n'))}</textarea></div>
        <div><label class="field-label">Información que DEBE seguir secreta (una por línea)</label><textarea id="br-secret" rows="2">${escapeHtml((b.mustRemainSecret || []).join('\n'))}</textarea></div>
      </div>
      <label class="field-label">Memorias históricas relevantes (una por línea)</label>
      <textarea id="br-memories" rows="2">${escapeHtml((b.relevantHistoricalMemories || []).join('\n'))}</textarea>
      <label class="field-label">Modificaciones de personaje solo para esta escena (una por línea)</label>
      <textarea id="br-scene-mods" rows="2">${escapeHtml((b.sceneCharacterModifications || []).join('\n'))}</textarea>
      <label class="field-label">Condición de cierre</label>
      <input type="text" id="br-ending" value="${escapeHtml(b.requiredEndingConditions || '')}" placeholder="Ej: La pantalla se congela justo antes de la respuesta de Erwin">
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="br-save-btn">✓ Guardar y aprobar Brief</button>
        <button type="button" class="btn btn-ghost" id="br-cancel-btn">Cancelar</button>
      </div>`);

    document.getElementById('br-cancel-btn')?.addEventListener('click', closeModal);
    document.getElementById('br-save-btn')?.addEventListener('click', async () => {
      await saveChapterBrief({
        ...(existing || {}),
        title: document.getElementById('br-title').value.trim(),
        targetLength: parseInt(document.getElementById('br-len').value, 10) || 5000,
        objective: document.getElementById('br-objective').value.trim(),
        perspective: document.getElementById('br-pov').value.trim(),
        activeParticipants: csvToArray(document.getElementById('br-cast').value),
        emotionalProgression: document.getElementById('br-emotion').value.trim(),
        dialogueIntentions: linesToArray(document.getElementById('br-dialogue').value),
        desiredRevelations: linesToArray(document.getElementById('br-reveal').value),
        mustRemainSecret: linesToArray(document.getElementById('br-secret').value),
        relevantHistoricalMemories: linesToArray(document.getElementById('br-memories').value),
        sceneCharacterModifications: linesToArray(document.getElementById('br-scene-mods').value),
        requiredEndingConditions: document.getElementById('br-ending').value.trim(),
        status: 'approved',
      }, { projectId });
      toast('Brief de Capítulo aprobado y guardado.');
      closeModal();
      renderPlanner(root);
    });
  };

  root.querySelector('#brief-new-btn')?.addEventListener('click', () => openBriefModal(null));

  // --- Extracción de propuestas en lenguaje natural (0 tokens) ---
  extractBtn?.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return toast('Escribe primero una idea o cambio en el cuadro de texto.', { error: true });
    const prop = await extractConversationalProposal(text, { storyConfig, fandom: storyConfig?.fandom || 'power_to_strive' });
    activeProposal = prop;
    messages = [...messages, { id: db.uid(), role: 'user', text, createdAt: new Date().toISOString() }].slice(-HISTORY_LIMIT);
    const freshChat = await getCreativeChat(projectId);
    await saveCreativeChat({
      ...freshChat,
      messages,
      rollingSummary: buildRollingChatSummary(messages.slice(0, Math.max(0, messages.length - 6)), 1600),
      pendingProposals: [...(freshChat.pendingProposals || []), prop],
    }, { projectId });
    renderMessages(root, messages);
    renderProposalCard();
    status.textContent = `✨ Se extrajeron ${prop.items.length} ítem(s) editables sin gastar tokens. Revisa y aprueba solo los que quieras.`;
  });

  abortBtn.addEventListener('click', () => {
    activeController?.abort();
    abortBtn.disabled = true;
    status.textContent = 'Cancelando solicitud…';
  });

  root.querySelectorAll('.planner-example').forEach((btn) => btn.addEventListener('click', () => {
    input.value = btn.dataset.prompt;
    input.focus();
  }));

  root.querySelector('#planner-messages').addEventListener('click', async (e) => {
    const copy = e.target.closest('.planner-copy');
    const use = e.target.closest('.planner-use');
    if (!copy && !use) return;
    const index = Number((copy || use).dataset.messageIndex);
    const message = messages[index];
    if (!message || message.role !== 'assistant') return;
    if (copy) {
      try { await copyTextToClipboard(message.text); toast('Idea copiada.'); }
      catch { toast('No se pudo copiar; selecciona el texto manualmente.', { error: true }); }
      return;
    }
    if (await getActiveGenerationState()) {
      toast('Ya hay un capítulo en curso. Usa «Copiar» y pega la idea en las correcciones del siguiente bloque.', { ms: 7500 });
      return;
    }
    await db.put('settings', { id: projectDraftId(projectId), text: message.text, createdAt: new Date().toISOString() });
    toast('Idea enviada como borrador de instrucciones. Revísala en Escribir antes de generar.');
    bus.emit('navigate', 'write');
  });

  clear.addEventListener('click', async () => {
    if (busy || !messages.length) return;
    if (!confirm('¿Empezar otra conversación creativa? Esto solo borra el chat de esta historia; tus capítulos y canon quedan intactos.')) return;
    messages = [];
    activeProposal = null;
    await saveCreativeChat({ projectId, messages: [], rollingSummary: '', pendingProposals: [] }, { projectId });
    await db.put('settings', { id: 'planner-chat:' + projectId, messages: [] });
    renderMessages(root, messages);
    renderProposalCard();
    status.textContent = 'Nueva conversación lista. Tus capítulos y canon no cambiaron.';
  });

  send.addEventListener('click', async () => {
    const question = input.value.trim();
    if (busy || !question) return;
    if (projectId !== db.getActiveProjectId()) return toast('Vuelve a abrir Planificar en la historia correcta.', { error: true });
    const [settings, walletConfig] = await Promise.all([
      db.get('settings', 'main'),
      getWalletConfig(),
    ]);
    const auxProviderId = walletConfig.auxiliaryProvider || walletConfig.primaryProvider || settings?.provider || 'openai';
    if (!settings?.apiKeys?.[auxProviderId]) {
      return toast(`Primero configura tu clave API de ${auxProviderId} en Ajustes.`, { error: true, ms: 6500 });
    }
    busy = true; send.disabled = true; clear.disabled = true;
    activeController = new AbortController();
    abortBtn.style.display = '';
    abortBtn.disabled = false;
    status.textContent = '💭 Pensando contigo con el Motor de Contexto Unificado…';
    try {
      const provider = getProviderForRole(settings, walletConfig, 'auxiliary');
      const bundle = await assembleOperationContext({
        projectId,
        operation: 'creative_chat',
        role: 'auxiliary',
        userMessage: question,
        chatMessages: messages,
        providerId: provider.name,
        modelId: provider.config?.model || walletConfig.auxiliaryModel,
        walletConfig,
      });

      const budgetCheck = checkGenerationBudget({
        estimatedAdditionalUsd: bundle.modelBound.costEstimate?.costUsd,
        spentSoFarUsd: 0,
        maxGenerationSpendUsd: walletConfig.maxGenerationSpendUsd,
      });
      if (!budgetCheck.allowed) {
        throw new Error(budgetCheck.message);
      }

      const reasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|gemini-2\.5|gemini-3)/i.test(provider.config?.model || '');
      const modelLimit = getModelOutputLimit(provider.name, provider.config?.model || '');
      const result = await provider.generate({
        systemPrompt: bundle.modelBound.systemPrompt,
        userPrompt: bundle.modelBound.userPrompt,
        maxOutputTokens: Math.min(modelLimit, walletConfig.maxOutputTokensPerRequest || modelLimit, reasoningModel ? 4200 : 1800),
        temperature: 0.9,
        reasoningEffort: bundle.modelBound.reasoningEffort || '',
        signal: activeController.signal,
      });

      await recordUsageEvent({
        projectId,
        operation: 'creative_chat',
        provider: provider.name,
        model: provider.config?.model || bundle.modelBound.modelId,
        role: 'auxiliary',
        status: result.ok ? 'ok' : (result.errorType || 'error'),
        errorType: result.errorType || null,
        estimatedInputTokens: bundle.modelBound.estimatedInputTokens,
        estimatedOutputTokens: bundle.modelBound.estimatedOutputTokens,
        providerUsage: result.usage || null,
        walletConfig,
      });

      if (!result.ok) throw new Error(result.errorMessage || 'La IA no pudo responder.');
      messages = [
        ...messages,
        { id: db.uid(), role: 'user', text: question, createdAt: new Date().toISOString() },
        { id: db.uid(), role: 'assistant', text: result.text, meta: { snapshotHash: bundle.snapshotHash, model: provider.config?.model || '' }, createdAt: new Date().toISOString() },
      ].slice(-HISTORY_LIMIT);
      const freshChat = await getCreativeChat(projectId);
      await saveCreativeChat({
        ...freshChat,
        messages,
        rollingSummary: buildRollingChatSummary(messages.slice(0, Math.max(0, messages.length - 6)), 1600),
      }, { projectId });
      if (db.getActiveProjectId() === projectId && root.isConnected) {
        input.value = '';
        renderMessages(root, messages);
        status.textContent = result.truncated
          ? '⚠️ La respuesta alcanzó el límite de tokens y pudo quedar cortada. Puedes pedirle que continúe.'
          : 'Idea lista (separada del manuscrito). Puedes continuar la conversación, extraer propuestas editables o crear un Brief de Capítulo.';
      }
    } catch (err) {
      if (db.getActiveProjectId() === projectId && root.isConnected) status.textContent = '⚠️ ' + (err?.message || 'No se pudo responder.') + ' Tu mensaje sigue aquí para reintentar.';
    } finally {
      busy = false;
      activeController = null;
      if (root.isConnected) { send.disabled = false; clear.disabled = false; abortBtn.style.display = 'none'; }
    }
  });
}
