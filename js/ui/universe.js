// ui/universe.js — Configuración de historia/universo, biblioteca de presets
// reutilizables, activación de overlays (Character Lab) e Inspector de
// configuración narrativa gratuito (0 tokens).

import { db } from '../db.js';
import { escapeHtml, toast, openModal, closeModal } from '../utils.js';
import {
  normalizeFandomNamespace,
  extractLogicalId,
  isOverlayConfigured,
} from '../characterLibrary.js';
import {
  createDefaultStoryConfig,
  getStoryConfig,
  saveStoryConfig,
  approveConfigProposal,
  rejectConfigProposal,
} from '../storyConfigSchema.js';
import {
  PTS_FANDOM,
  NEUTRAL_FANDOM,
  listStoryPresets,
  saveStoryPreset,
  duplicateStoryPreset,
  deleteStoryPreset,
  applyPresetToStory,
  buildStoryConfigFromPreset,
} from '../storyPresets.js';
import {
  ERURI_STATES,
  PTS_CHECKPOINTS,
  normalizeEruriConfig,
  normalizeRoomGuestInvitations,
  resolveUniverseConfiguration,
} from '../universeResolver.js';

function linesToArray(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function csvToArray(text) {
  return String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

export async function renderUniverseSection(container, {
  universalCharacters = [],
  storyCharacters = [],
  overlays = [],
  onRefresh,
} = {}) {
  const projectId = db.getActiveProjectId();
  const [storedConfig, presets, documents] = await Promise.all([
    getStoryConfig(projectId),
    listStoryPresets(),
    db.getAll('documents'),
  ]);
  const config = storedConfig || createDefaultStoryConfig(projectId, { fandom: NEUTRAL_FANDOM });
  const fandom = normalizeFandomNamespace(config.fandom || NEUTRAL_FANDOM);
  const isPts = fandom === PTS_FANDOM;
  const eruri = normalizeEruriConfig(config.relationshipStates?.eruri);
  const enabledOpt = new Set((config.enabledOptionalCharacters || []).map(extractLogicalId));
  const normalizedInvites = normalizeRoomGuestInvitations(config.roomGuestInvitations || [], { universalCharacters });
  const josephInvite = normalizedInvites.find((inv) => inv.characterId === 'joseph') || null;
  const activations = Array.isArray(config.overlayActivations) ? config.overlayActivations : [];
  const pendingProposals = (config.proposals || []).filter((p) => p.status === 'proposed');

  const resolved = resolveUniverseConfiguration({
    storyConfig: config,
    universalCharacters,
    storyCharacters,
    overlays,
    documents,
    context: { fandom, characterVersion: config.reactionMode ? 'room' : 'default' },
  });

  const presetOptions = ['<option value="">(sin preset / configuración manual)</option>']
    .concat(presets.map((p) => `<option value="${escapeHtml(p.id)}" ${config.presetId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.fandom)}</option>`))
    .join('');

  const fandomPresetVal = fandom === PTS_FANDOM ? PTS_FANDOM : (fandom === NEUTRAL_FANDOM ? NEUTRAL_FANDOM : '__custom__');

  container.innerHTML = `
    <div class="card" id="universe-config-card" style="margin-bottom:16px;">
      <div class="card-row">
        <div>
          <h3>🌌 Universo y configuración de historia</h3>
          <p class="muted">Configura fandom, preset, personajes opcionales, relaciones y overlays para esta historia sin afectar otras historias.</p>
        </div>
        <span class="pill pill-reference" title="Estas configuraciones se guardan y validan ya en IndexedDB, y se conectarán al motor de generación en el Hito 5.">🛠️ Config lista · motor en Hito 5</span>
      </div>

      <div class="grid-2">
        <div>
          <label class="field-label" for="uc-fandom-select">Fandom / espacio de reglas</label>
          <select id="uc-fandom-select">
            <option value="${NEUTRAL_FANDOM}" ${fandomPresetVal === NEUTRAL_FANDOM ? 'selected' : ''}>Neutral / Ficción original / Otro fandom</option>
            <option value="${PTS_FANDOM}" ${fandomPresetVal === PTS_FANDOM ? 'selected' : ''}>Power to Strive (reglas de sala + Eruri)</option>
            <option value="__custom__" ${fandomPresetVal === '__custom__' ? 'selected' : ''}>Fandom personalizado…</option>
          </select>
          <input type="text" id="uc-fandom-custom" value="${fandomPresetVal === '__custom__' ? escapeHtml(fandom) : ''}" placeholder="ej: starlight_original, crossover_au" style="margin-top:6px; display:${fandomPresetVal === '__custom__' ? 'block' : 'none'};">
        </div>
        <div>
          <label class="field-label" for="uc-preset-select">Preset de inicio rápido</label>
          <div class="card-row" style="gap:6px;">
            <select id="uc-preset-select">${presetOptions}</select>
            <button type="button" class="btn btn-ghost btn-sm" id="uc-apply-preset-btn">Aplicar</button>
          </div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:8px;">
        <div>
          <label class="field-label" for="uc-universe-name">Nombre del universo / AU</label>
          <input type="text" id="uc-universe-name" value="${escapeHtml(config.universeName || '')}" placeholder="ej: Classic Eruri, Novela espacial">
        </div>
        <div>
          <label class="field-label" for="uc-checkpoint">Checkpoint narrativo</label>
          <select id="uc-checkpoint">
            <option value="">(sin checkpoint fijo)</option>
            ${PTS_CHECKPOINTS.map((cp) => `<option value="${escapeHtml(cp.id)}" ${config.checkpointId === cp.id ? 'selected' : ''}>${escapeHtml(cp.label)}</option>`).join('')}
          </select>
        </div>
      </div>

      <label class="field-label" for="uc-premise">Premisa narrativa (opcional)</label>
      <textarea id="uc-premise" rows="2" placeholder="Describe en 1-2 frases la premisa de esta historia.">${escapeHtml(config.premise || '')}</textarea>

      ${isPts ? `
      <div class="paper" id="uc-pts-panel" style="padding:12px; margin-top:10px;">
        <div class="title-row"><b>⚔️ Reglas de Power to Strive</b><span class="muted">12 espectadores base + Candy (facilitadora)</span></div>
        <label class="field-label" style="margin-top:6px;">
          <input type="checkbox" id="uc-reaction-mode" ${config.reactionMode !== false ? 'checked' : ''}> Historia de sala de reacciones (12 originales + Candy como facilitadora)
        </label>
        <div class="grid-2" style="margin-top:8px;">
          <div>
            <label class="field-label">Personajes opcionales (desactivados por defecto)</label>
            <label style="display:block; margin:4px 0;"><input type="checkbox" id="uc-opt-joseph" ${enabledOpt.has('joseph') ? 'checked' : ''}> Habilitar a Joseph Alcott (fuera de sala por defecto)</label>
            <label style="display:block; margin:4px 0 4px 18px;"><input type="checkbox" id="uc-invite-joseph" ${josephInvite ? 'checked' : ''} ${enabledOpt.has('joseph') ? '' : 'disabled'}> Invitación explícita a la sala (13.º espectador; sin conocimiento previo automático)</label>
            <div id="uc-joseph-temporal" style="margin:4px 0 6px 18px; display:${enabledOpt.has('joseph') && josephInvite ? 'block' : 'none'};">
              <div class="grid-2" style="gap:6px;">
                <div>
                  <label class="field-label" for="uc-joseph-arrival-cp">Llegada desde checkpoint</label>
                  <select id="uc-joseph-arrival-cp">
                    <option value="">(inmediata)</option>
                    ${PTS_CHECKPOINTS.map((cp) => `<option value="${escapeHtml(cp.id)}" ${josephInvite?.effectiveCheckpoint === cp.id ? 'selected' : ''}>${escapeHtml(cp.label)}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="field-label" for="uc-joseph-arrival-order">Desde capítulo n.º (opcional)</label>
                  <input type="number" min="1" id="uc-joseph-arrival-order" value="${josephInvite?.effectiveChapterOrder ?? ''}" placeholder="ej: 10">
                </div>
              </div>
            </div>
            <label style="display:block; margin:4px 0;"><input type="checkbox" id="uc-opt-anya" ${enabledOpt.has('anya') ? 'checked' : ''}> Habilitar a Anya (SOLO pantalla / flashbacks / exterior · NUNCA sala)</label>
          </div>
          <div>
            <label class="field-label" for="uc-eruri-state">Relación Eruri (estado real)</label>
            <select id="uc-eruri-state">
              ${ERURI_STATES.map((st) => `<option value="${escapeHtml(st.id)}" ${eruri.state === st.id ? 'selected' : ''}>${escapeHtml(st.label)}</option>`).join('')}
            </select>
            <input type="text" id="uc-eruri-custom" value="${escapeHtml(eruri.customLabel || '')}" placeholder="Etiqueta personalizada (si aplica)" style="margin-top:6px; display:${eruri.state === 'custom' ? 'block' : 'none'};">
            <label style="display:block; margin-top:6px;"><input type="checkbox" id="uc-eruri-public" ${eruri.publiclyKnown ? 'checked' : ''}> Relación conocida públicamente (desactivado por defecto)</label>
            <label class="field-label" style="margin-top:6px;" for="uc-eruri-knownby">Quién la sabe (IDs o nombres separados por coma)</label>
            <input type="text" id="uc-eruri-knownby" value="${escapeHtml((eruri.knownBy || []).join(', '))}" placeholder="ej: erwin, levi">
            <label class="field-label" style="margin-top:4px;" for="uc-eruri-suspectedby">Quién sospecha</label>
            <input type="text" id="uc-eruri-suspectedby" value="${escapeHtml((eruri.suspectedBy || []).join(', '))}" placeholder="ej: hange, ymir">
          </div>
        </div>
      </div>` : `<p class="muted" style="margin-top:8px;">✨ Espacio neutral (${escapeHtml(fandom)}): no se aplica ninguna regla de Power to Strive, Eruri, Candy, Joseph, Anya ni Violet.</p>`}

      <details style="margin-top:10px;">
        <summary style="cursor:pointer; font-weight:600;">⚙️ Ajustes avanzados (reparto por capas, conocimiento privado y reglas de historia)</summary>
        <div style="margin-top:8px;">
          <div class="grid-2">
            <div>
              <label class="field-label" for="uc-cast-room">Reparto en sala / escena principal (coma)</label>
              <input type="text" id="uc-cast-room" value="${escapeHtml((config.casts?.room || []).join(', '))}" placeholder="${isPts ? 'Vacío = 12 originales (+ Joseph si está invitado)' : 'ej: Aria, Marcus'}">
            </div>
            <div>
              <label class="field-label" for="uc-cast-screen">Reparto en pantalla / footage (coma)</label>
              <input type="text" id="uc-cast-screen" value="${escapeHtml((config.casts?.screen || []).join(', '))}" placeholder="ej: levi, joseph, anya">
            </div>
          </div>
          <label class="field-label" for="uc-cast-outside">Reparto en escenas exteriores (coma)</label>
          <input type="text" id="uc-cast-outside" value="${escapeHtml((config.casts?.outside || []).join(', '))}" placeholder="ej: joseph, anya">
          <label class="field-label" for="uc-private-knowledge">Conocimiento privado del autor (uno por línea)</label>
          <textarea id="uc-private-knowledge" rows="2">${escapeHtml((config.privateAuthorKnowledge || []).join('\n'))}</textarea>
          <label class="field-label" for="uc-story-rules">Reglas específicas de esta historia (una por línea)</label>
          <textarea id="uc-story-rules" rows="2">${escapeHtml((config.storyRules || []).join('\n'))}</textarea>
          ${isPts ? `<label class="field-label" for="uc-eruri-history">Historia privada / matices de Eruri</label><textarea id="uc-eruri-history" rows="2">${escapeHtml(eruri.historyNote || '')}</textarea>` : ''}
        </div>
      </details>

      <div class="btn-row" style="margin-top:12px;">
        <button type="button" class="btn btn-primary" id="uc-save-btn">💾 Guardar configuración de historia</button>
        <button type="button" class="btn btn-ghost" id="uc-toggle-inspector-btn">🔎 Ver inspector de configuración (0 tokens)</button>
      </div>

      ${pendingProposals.length ? `
      <div class="paper" id="uc-proposals-box" style="padding:10px; margin-top:12px;">
        <b>💬 Propuestas conversacionales pendientes (${pendingProposals.length})</b>
        <p class="muted">Ninguna propuesta se aplica hasta que la apruebes explícitamente.</p>
        ${pendingProposals.map((p) => `
          <div class="list-item" data-proposal-id="${escapeHtml(p.id)}">
            <div>${escapeHtml(p.sourceMessage || 'Propuesta sin mensaje')}</div>
            ${p.unresolvedAmbiguities?.length ? `<div class="muted">Ambigüedades: ${escapeHtml(p.unresolvedAmbiguities.join(' · '))}</div>` : ''}
            <div class="btn-row">
              <button type="button" class="btn btn-primary btn-sm act-prop-approve">✓ Aprobar</button>
              <button type="button" class="btn btn-danger btn-sm act-prop-reject">✗ Rechazar</button>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div id="uc-active-overlays-box" style="margin-top:12px;">
        <div class="card-row">
          <b>🎭 Overlays activos en esta historia (${activations.filter((a) => a.enabled !== false).length})</b>
          <button type="button" class="btn btn-ghost btn-sm" id="uc-activate-overlay-btn">+ Activar overlay en esta historia</button>
        </div>
        ${activations.length ? activations.map((act, idx) => {
          const tpl = overlays.find((o) => o.id === act.overlayId || o.logicalId === extractLogicalId(act.overlayId));
          const configured = tpl ? isOverlayConfigured(tpl) : false;
          return `
          <div class="list-item" data-act-index="${idx}">
            <div class="title-row">
              <b>${escapeHtml(tpl?.name || act.overlayId)}</b>
              <span class="muted">ámbito: ${escapeHtml(act.scope)}${act.characterVersion && act.characterVersion !== 'all' ? ` · versión=${escapeHtml(act.characterVersion)}` : ''}${act.sceneId ? ` · escena=${escapeHtml(act.sceneId)}` : ''}</span>
            </div>
            <div class="chip-row" style="margin:4px 0;">
              <span class="pill ${act.enabled !== false ? 'pill-active' : 'pill-inactive'}">${act.enabled !== false ? 'Activado en esta historia' : 'Pausado'}</span>
              ${tpl && !configured ? '<span class="pill pill-canon">⚠️ Sin rasgos configurados (se usa perfil estándar)</span>' : ''}
              ${tpl?.preserveCoreTraits?.length ? `<span class="pill pill-reference">Conserva: ${escapeHtml(tpl.preserveCoreTraits.slice(0, 2).join(', '))}</span>` : ''}
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm act-ov-toggle">${act.enabled !== false ? 'Desactivar' : 'Reactivar'}</button>
              <button type="button" class="btn btn-danger btn-sm act-ov-remove">Quitar de esta historia</button>
            </div>
          </div>`;
        }).join('') : '<p class="muted">Ningún overlay activo en esta historia. Se usa la caracterización estándar por defecto.</p>'}
      </div>

      <div id="uc-inspector-slot" style="margin-top:12px;"></div>

      <details style="margin-top:12px;">
        <summary style="cursor:pointer; font-weight:600;">✨ Presets de historia reutilizables (${presets.length})</summary>
        <div style="margin-top:8px;" id="uc-presets-list">
          ${presets.map((p) => `
            <div class="list-item" data-preset-id="${escapeHtml(p.id)}">
              <div class="title-row"><b>${escapeHtml(p.name)}</b><span class="pill pill-reference">${escapeHtml(p.fandom)}</span></div>
              ${p.notes ? `<div class="muted">${escapeHtml(p.notes)}</div>` : ''}
              <div class="btn-row">
                <button type="button" class="btn btn-primary btn-sm act-preset-apply">Aplicar a esta historia</button>
                <button type="button" class="btn btn-ghost btn-sm act-preset-new-story">➕ Nueva historia con este preset</button>
                <button type="button" class="btn btn-ghost btn-sm act-preset-dup">Duplicar</button>
                <button type="button" class="btn btn-ghost btn-sm act-preset-edit">Editar</button>
                ${p.isBuiltin ? '' : '<button type="button" class="btn btn-danger btn-sm act-preset-del">Eliminar</button>'}
              </div>
            </div>`).join('')}
        </div>
      </details>
    </div>`;

  // --- Event bindings ---
  const fandomSelect = container.querySelector('#uc-fandom-select');
  const fandomCustom = container.querySelector('#uc-fandom-custom');
  fandomSelect?.addEventListener('change', () => {
    fandomCustom.style.display = fandomSelect.value === '__custom__' ? 'block' : 'none';
  });

  const optJoseph = container.querySelector('#uc-opt-joseph');
  const inviteJoseph = container.querySelector('#uc-invite-joseph');
  const josephTemporalBox = container.querySelector('#uc-joseph-temporal');
  const syncJosephTemporalVisibility = () => {
    if (!josephTemporalBox) return;
    josephTemporalBox.style.display = optJoseph?.checked && inviteJoseph?.checked ? 'block' : 'none';
  };
  optJoseph?.addEventListener('change', () => {
    if (!inviteJoseph) return;
    inviteJoseph.disabled = !optJoseph.checked;
    if (!optJoseph.checked) inviteJoseph.checked = false;
    syncJosephTemporalVisibility();
  });
  inviteJoseph?.addEventListener('change', syncJosephTemporalVisibility);

  const eruriSelect = container.querySelector('#uc-eruri-state');
  const eruriCustom = container.querySelector('#uc-eruri-custom');
  eruriSelect?.addEventListener('change', () => {
    if (eruriCustom) eruriCustom.style.display = eruriSelect.value === 'custom' ? 'block' : 'none';
  });

  const collectFormConfig = () => {
    const selectedFandom = fandomSelect.value === '__custom__'
      ? normalizeFandomNamespace(fandomCustom.value || NEUTRAL_FANDOM)
      : normalizeFandomNamespace(fandomSelect.value);
    const nextEnabledOptional = [];
    const nextInvitations = [];
    const nextRelationships = structuredClone(config.relationshipStates || {});

    if (selectedFandom === PTS_FANDOM) {
      if (container.querySelector('#uc-opt-joseph')?.checked) {
        nextEnabledOptional.push('joseph');
        if (container.querySelector('#uc-invite-joseph')?.checked) {
          const arrivalCp = container.querySelector('#uc-joseph-arrival-cp')?.value || '';
          const arrivalOrderRaw = container.querySelector('#uc-joseph-arrival-order')?.value || '';
          const arrivalOrder = arrivalOrderRaw ? Math.max(1, parseInt(arrivalOrderRaw, 10)) : null;
          nextInvitations.push({
            characterId: 'joseph',
            effectiveCheckpoint: arrivalCp,
            effectiveChapterOrder: Number.isFinite(arrivalOrder) ? arrivalOrder : null,
            invitedAt: josephInvite?.invitedAt || new Date().toISOString(),
            authorizedBy: 'author',
          });
        }
      }
      if (container.querySelector('#uc-opt-anya')?.checked) {
        nextEnabledOptional.push('anya');
      }
      if (container.querySelector('#uc-eruri-state')) {
        nextRelationships.eruri = {
          state: container.querySelector('#uc-eruri-state').value,
          customLabel: container.querySelector('#uc-eruri-custom')?.value.trim() || '',
          publiclyKnown: Boolean(container.querySelector('#uc-eruri-public')?.checked),
          knownBy: csvToArray(container.querySelector('#uc-eruri-knownby')?.value).map(extractLogicalId),
          suspectedBy: csvToArray(container.querySelector('#uc-eruri-suspectedby')?.value).map(extractLogicalId),
          historyNote: container.querySelector('#uc-eruri-history')?.value.trim() || '',
        };
      }
    }

    return {
      ...config,
      fandom: selectedFandom,
      presetId: container.querySelector('#uc-preset-select')?.value || null,
      universeName: container.querySelector('#uc-universe-name')?.value.trim() || '',
      checkpointId: container.querySelector('#uc-checkpoint')?.value || '',
      premise: container.querySelector('#uc-premise')?.value.trim() || '',
      reactionMode: selectedFandom === PTS_FANDOM
        ? (container.querySelector('#uc-reaction-mode') ? container.querySelector('#uc-reaction-mode').checked : true)
        : false,
      enabledOptionalCharacters: nextEnabledOptional,
      roomGuestInvitations: nextInvitations,
      relationshipStates: selectedFandom === PTS_FANDOM ? nextRelationships : {},
      casts: {
        room: csvToArray(container.querySelector('#uc-cast-room')?.value),
        screen: csvToArray(container.querySelector('#uc-cast-screen')?.value),
        outside: csvToArray(container.querySelector('#uc-cast-outside')?.value),
      },
      privateAuthorKnowledge: linesToArray(container.querySelector('#uc-private-knowledge')?.value),
      storyRules: linesToArray(container.querySelector('#uc-story-rules')?.value),
    };
  };

  container.querySelector('#uc-save-btn')?.addEventListener('click', async () => {
    try {
      const next = collectFormConfig();
      await saveStoryConfig(next);
      toast('Configuración de historia guardada (solo para esta historia).');
      onRefresh?.();
    } catch (err) {
      toast(err.message || 'No se pudo guardar la configuración.', { error: true });
    }
  });

  container.querySelector('#uc-apply-preset-btn')?.addEventListener('click', async () => {
    const presetId = container.querySelector('#uc-preset-select')?.value;
    if (!presetId) return toast('Elige primero un preset de la lista.', { error: true });
    try {
      await applyPresetToStory(projectId, presetId);
      toast('Preset aplicado a la configuración de esta historia (sin tocar otras historias ni capítulos).');
      onRefresh?.();
    } catch (err) {
      toast(err.message || 'No se pudo aplicar el preset.', { error: true });
    }
  });

  // Inspector gratuito (0 tokens)
  const inspectorSlot = container.querySelector('#uc-inspector-slot');
  const renderInspector = (viewVersion = config.reactionMode ? 'room' : 'default', viewScene = '', viewChapterOrder = '') => {
    const liveCfg = collectFormConfig();
    const parsedOrder = viewChapterOrder !== '' && Number.isFinite(Number(viewChapterOrder))
      ? Math.max(1, parseInt(viewChapterOrder, 10))
      : null;
    const res = resolveUniverseConfiguration({
      storyConfig: liveCfg,
      universalCharacters,
      storyCharacters,
      overlays,
      documents,
      context: {
        fandom: liveCfg.fandom,
        characterVersion: viewVersion,
        sceneId: viewScene || null,
        chapterOrder: parsedOrder,
      },
    });
    const conflictsHtml = res.contradictions.map((c) => {
      const resolveButtons = c.type === 'overlay_conflict'
        ? `<div class="btn-row" style="margin-top:6px;">${c.overlayIds.map((ovId, idx) => `<button type="button" class="btn btn-primary btn-sm act-resolve-conflict" data-pair="${escapeHtml(c.pairKey)}" data-winner="${escapeHtml(ovId)}">Elegir «${escapeHtml(c.overlayNames[idx])}»</button>`).join('')}</div>`
        : '';
      return `<div class="context-guard-item context-guard-critical"><b>🛑 ${escapeHtml(c.id || c.type)}</b><div>${escapeHtml(c.message)}</div>${resolveButtons}</div>`;
    }).join('');
    const warningsHtml = res.warnings.map((w) => `<div class="context-guard-item context-guard-warning"><b>⚠️ Aviso</b><div>${escapeHtml(w.message)}</div></div>`).join('');
    const comparisonEntries = Object.values(res.versionComparison || {});

    inspectorSlot.innerHTML = `
      <div class="paper" id="universe-inspector-panel" style="padding:14px;">
        <div class="card-row">
          <div>
            <b>🔎 Inspector de configuración narrativa (0 tokens)</b>
            <div class="muted">Usa el mismo resolvedor determinista que consumirá el Context Engine unificado.</div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="ui-insp-close">Cerrar</button>
        </div>
        <div class="context-guard-item context-guard-warning" style="margin:8px 0;">
          <b>ℹ️ Estado de integración y alcance de validación</b>
          <div><b>Ya conectado a generación:</b> ${escapeHtml(res.engineIntegrationStatus.connectedToGeneration.join(' · '))}.</div>
          <div><b>Solo configuración por ahora (se conecta en Hito 5):</b> ${escapeHtml(res.engineIntegrationStatus.configuredAwaitingContextEngine.join(' · '))}.</div>
          <div style="margin-top:4px;"><b>Alcance de prevalidación:</b> ${escapeHtml(res.validationLimitationNote)}</div>
        </div>
        <div class="grid-3" style="margin:8px 0;">
          <div>
            <label class="field-label">Probar ámbito de versión</label>
            <select id="ui-insp-version">
              <option value="room" ${viewVersion === 'room' ? 'selected' : ''}>room (sala)</option>
              <option value="screen" ${viewVersion === 'screen' ? 'selected' : ''}>screen (pantalla)</option>
              <option value="outside" ${viewVersion === 'outside' ? 'selected' : ''}>outside (exterior)</option>
              <option value="default" ${viewVersion === 'default' ? 'selected' : ''}>default</option>
            </select>
          </div>
          <div>
            <label class="field-label">Probar ID de escena (opcional)</label>
            <input type="text" id="ui-insp-scene" value="${escapeHtml(viewScene)}" placeholder="ej: ch3-s2">
          </div>
          <div>
            <label class="field-label">Probar capítulo n.º (opcional)</label>
            <input type="number" min="1" id="ui-insp-chapter-order" value="${escapeHtml(String(viewChapterOrder || ''))}" placeholder="ej: 2 o 10">
          </div>
        </div>
        <div class="chip-row" style="margin:6px 0;">
          <span class="pill ${res.ok ? 'pill-active' : 'pill-canon'}">${res.ok ? '✅ Sin contradicciones críticas' : `🛑 ${res.contradictions.length} contradicción(es)`}</span>
          <span class="pill pill-reference">Fandom: ${escapeHtml(res.fandom)}</span>
          <span class="pill pill-character">${res.allowedRoomCast.length} en sala permitida</span>
          <span class="pill pill-style">${res.activeOverlays.length} overlay(s) aplicado(s)</span>
        </div>
        ${conflictsHtml}
        ${warningsHtml}
        <div style="font-size:13px; margin-top:8px;">
          <div><b>Universo / preset:</b> ${escapeHtml(res.universeName || '(sin nombre)')} ${res.presetId ? `(${escapeHtml(res.presetId)})` : ''}</div>
          ${res.facilitator ? `<div><b>Facilitadora:</b> ${escapeHtml(res.facilitator.name)} — ${escapeHtml(res.facilitator.note)}</div>` : ''}
          <div><b>Reparto permitido en sala:</b> ${escapeHtml(res.allowedRoomCastLabels.join(', ') || '(ninguno)')}</div>
          <div><b>Reparto en pantalla:</b> ${escapeHtml(res.screenCast.join(', ') || '(ninguno)')}</div>
          <div><b>Reparto exterior:</b> ${escapeHtml(res.outsideCast.join(', ') || '(ninguno)')}</div>
          <div><b>Opcionales habilitados:</b> ${escapeHtml(res.enabledOptionalCharacters.join(', ') || '(ninguno)')} · <b>Inactivos:</b> ${escapeHtml(res.inactiveOptionalCharacters.map((x) => x.name).join(', ') || '(ninguno)')}</div>
          ${res.isPowerToStrive ? `<div><b>Eruri:</b> ${escapeHtml(res.relationshipSummary.eruri?.state || 'mutual_pining')} · pública=${res.relationshipSummary.eruri?.publiclyKnown ? 'sí' : 'no'} · saben=[${escapeHtml((res.relationshipSummary.eruri?.knownBy || []).join(', '))}] · sospechan=[${escapeHtml((res.relationshipSummary.eruri?.suspectedBy || []).join(', '))}]</div>` : ''}
          ${res.knowledgeBarriers.map((b) => `<div><b>🔒 Barrera de conocimiento (${escapeHtml(b.characterId)}):</b> ${escapeHtml(b.message)}</div>`).join('')}
          ${res.styleOnlyNote ? `<div class="muted" style="margin-top:4px;">${escapeHtml(res.styleOnlyNote)}</div>` : ''}
          ${comparisonEntries.length ? `<div style="margin-top:6px;"><b>Comparativa Sala vs Pantalla:</b> ${comparisonEntries.map((item) => `${escapeHtml(item.characterName)}: sala=${item.roomIsStandard ? 'estándar' : escapeHtml(item.roomTraits.join('; '))} / pantalla=${item.screenIsStandard ? 'estándar' : escapeHtml(item.screenTraits.join('; '))}`).join(' | ')}</div>` : ''}
        </div>
      </div>`;

    inspectorSlot.querySelector('#ui-insp-close')?.addEventListener('click', () => { inspectorSlot.innerHTML = ''; });
    const reRender = () => {
      renderInspector(
        inspectorSlot.querySelector('#ui-insp-version')?.value || 'room',
        inspectorSlot.querySelector('#ui-insp-scene')?.value.trim() || '',
        inspectorSlot.querySelector('#ui-insp-chapter-order')?.value.trim() || ''
      );
    };
    inspectorSlot.querySelector('#ui-insp-version')?.addEventListener('change', reRender);
    inspectorSlot.querySelector('#ui-insp-scene')?.addEventListener('change', reRender);
    inspectorSlot.querySelector('#ui-insp-chapter-order')?.addEventListener('change', reRender);
    inspectorSlot.querySelectorAll('.act-resolve-conflict').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pairKey = btn.dataset.pair;
        const winner = btn.dataset.winner;
        const nextWinners = { ...(config.approvedConflictWinners || {}), [pairKey]: winner };
        await saveStoryConfig({ ...collectFormConfig(), approvedConflictWinners: nextWinners });
        toast('Decisión de conflicto guardada para esta historia.');
        onRefresh?.();
      });
    });
  };

  container.querySelector('#uc-toggle-inspector-btn')?.addEventListener('click', () => {
    if (inspectorSlot.innerHTML.trim()) inspectorSlot.innerHTML = '';
    else renderInspector();
  });

  // Activar un overlay en esta historia (Character Lab)
  container.querySelector('#uc-activate-overlay-btn')?.addEventListener('click', () => {
    if (!overlays.length) {
      return toast('Primero crea o importa una plantilla de overlay abajo en Character Lab.', { error: true });
    }
    openModal(`
      <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">🎭 Activar overlay en esta historia</h3>
      <p class="muted">Activa una plantilla solo para esta historia y ámbito. El perfil universal base y otras historias no cambian.</p>
      <label class="field-label">Plantilla de overlay</label>
      <select id="act-ov-select">${overlays.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)} (base: ${escapeHtml(o.baseCharacterId)} · ${escapeHtml(o.fandom)})</option>`).join('')}</select>
      <div class="grid-2">
        <div>
          <label class="field-label">Ámbito</label>
          <select id="act-ov-scope">
            <option value="story">Toda esta historia (story)</option>
            <option value="character_version">Versión específica (room / screen / outside)</option>
            <option value="scene">Escena temporal (expira fuera de la escena)</option>
          </select>
        </div>
        <div>
          <label class="field-label">Versión del personaje</label>
          <select id="act-ov-version">
            <option value="all">Todas (all)</option>
            <option value="room">Sala (room)</option>
            <option value="screen">Pantalla (screen)</option>
            <option value="outside">Exterior (outside)</option>
          </select>
        </div>
      </div>
      <label class="field-label">ID de escena (solo si ámbito = escena)</label>
      <input type="text" id="act-ov-scene" placeholder="ej: ch3-s2">
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="act-ov-confirm">Activar en esta historia</button>
        <button type="button" class="btn btn-ghost" id="act-ov-cancel">Cancelar</button>
      </div>`);
    document.getElementById('act-ov-cancel')?.addEventListener('click', closeModal);
    document.getElementById('act-ov-confirm')?.addEventListener('click', async () => {
      const overlayId = document.getElementById('act-ov-select').value;
      const scope = document.getElementById('act-ov-scope').value;
      const characterVersion = document.getElementById('act-ov-version').value;
      const sceneId = scope === 'scene' ? (document.getElementById('act-ov-scene').value.trim() || null) : null;
      if (scope === 'scene' && !sceneId) return toast('Indica un ID de escena para un overlay de ámbito escena.', { error: true });
      if (scope === 'character_version' && characterVersion === 'all') return toast('Elige room, screen u outside para un overlay por versión.', { error: true });
      const tpl = overlays.find((o) => o.id === overlayId);
      const nextActivations = [
        ...activations,
        {
          overlayId,
          overlayLogicalId: tpl?.logicalId || extractLogicalId(overlayId),
          characterId: tpl?.baseCharacterId || '',
          scope,
          characterVersion,
          sceneId,
          enabled: true,
        },
      ];
      await saveStoryConfig({ ...collectFormConfig(), overlayActivations: nextActivations });
      toast('Overlay activado solo en esta historia.');
      closeModal();
      onRefresh?.();
    });
  });

  // Toggle / quitar overlays activos de esta historia
  container.querySelectorAll('#uc-active-overlays-box .list-item').forEach((el) => {
    const idx = parseInt(el.dataset.actIndex, 10);
    el.querySelector('.act-ov-toggle')?.addEventListener('click', async () => {
      const next = structuredClone(activations);
      if (!next[idx]) return;
      next[idx].enabled = next[idx].enabled === false ? true : false;
      await saveStoryConfig({ ...collectFormConfig(), overlayActivations: next });
      onRefresh?.();
    });
    el.querySelector('.act-ov-remove')?.addEventListener('click', async () => {
      const next = activations.filter((_, i) => i !== idx);
      await saveStoryConfig({ ...collectFormConfig(), overlayActivations: next });
      toast('Overlay quitado de esta historia.');
      onRefresh?.();
    });
  });

  // Aprobar / rechazar propuestas conversacionales
  container.querySelectorAll('#uc-proposals-box .list-item').forEach((el) => {
    const pid = el.dataset.proposalId;
    el.querySelector('.act-prop-approve')?.addEventListener('click', async () => {
      await approveConfigProposal(projectId, pid);
      toast('Propuesta aprobada y aplicada a esta historia.');
      onRefresh?.();
    });
    el.querySelector('.act-prop-reject')?.addEventListener('click', async () => {
      await rejectConfigProposal(projectId, pid);
      toast('Propuesta rechazada.');
      onRefresh?.();
    });
  });

  // Presets reutilizables: aplicar, crear nueva historia independiente, duplicar, editar, eliminar
  container.querySelectorAll('#uc-presets-list .list-item').forEach((el) => {
    const presetId = el.dataset.presetId;
    el.querySelector('.act-preset-apply')?.addEventListener('click', async () => {
      await applyPresetToStory(projectId, presetId);
      toast('Preset aplicado a la historia actual.');
      onRefresh?.();
    });
    el.querySelector('.act-preset-new-story')?.addEventListener('click', async () => {
      const preset = presets.find((p) => p.id === presetId);
      if (!preset) return;
      const storyName = prompt('Nombre de la nueva historia independiente:', `${preset.name} — Historia`);
      if (!storyName || !storyName.trim()) return;
      const wsRecord = (await db.get('settings', 'workspaces')) || { id: 'workspaces', items: [] };
      const newProject = { id: db.uid(), name: storyName.trim(), createdAt: new Date().toISOString() };
      await db.put('settings', { ...wsRecord, items: [...(wsRecord.items || []), newProject] });
      const newCfg = buildStoryConfigFromPreset(newProject.id, preset, { universeName: storyName.trim() });
      await saveStoryConfig(newCfg);
      db.setActiveProjectId(newProject.id);
      const select = document.getElementById('workspace-select');
      if (select) {
        const opt = document.createElement('option');
        opt.value = newProject.id;
        opt.textContent = newProject.name;
        select.appendChild(opt);
        select.value = newProject.id;
      }
      const label = document.getElementById('workspace-label');
      if (label) label.textContent = newProject.name;
      toast(`Historia independiente «${newProject.name}» creada desde el preset «${preset.name}».`);
      onRefresh?.();
    });
    el.querySelector('.act-preset-dup')?.addEventListener('click', async () => {
      await duplicateStoryPreset(presetId);
      toast('Preset duplicado.');
      onRefresh?.();
    });
    el.querySelector('.act-preset-edit')?.addEventListener('click', async () => {
      const preset = await db.get('storyPresets', presetId);
      if (!preset) return;
      openModal(`
        <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Editar preset «${escapeHtml(preset.name)}»</h3>
        <label class="field-label">Nombre</label><input type="text" id="pe-name" value="${escapeHtml(preset.name)}">
        <label class="field-label">Fandom</label><input type="text" id="pe-fandom" value="${escapeHtml(preset.fandom)}">
        <label class="field-label">Notas</label><textarea id="pe-notes" rows="3">${escapeHtml(preset.notes || '')}</textarea>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="pe-save">Guardar preset</button><button type="button" class="btn btn-ghost" id="pe-cancel">Cancelar</button></div>`);
      document.getElementById('pe-cancel')?.addEventListener('click', closeModal);
      document.getElementById('pe-save')?.addEventListener('click', async () => {
        await saveStoryPreset({
          ...preset,
          name: document.getElementById('pe-name').value.trim() || preset.name,
          fandom: document.getElementById('pe-fandom').value.trim() || preset.fandom,
          notes: document.getElementById('pe-notes').value.trim(),
        }, { authorEdited: true });
        toast('Preset actualizado.');
        closeModal();
        onRefresh?.();
      });
    });
    el.querySelector('.act-preset-del')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este preset personalizado?')) return;
      await deleteStoryPreset(presetId);
      toast('Preset eliminado.');
      onRefresh?.();
    });
  });

  // Exponer resultado resuelto para depuración/inspección sin coste
  return resolved;
}
