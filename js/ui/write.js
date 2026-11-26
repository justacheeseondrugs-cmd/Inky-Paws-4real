import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, bus, copyTextToClipboard, debounce, openModal, closeModal, wordCount } from '../utils.js';
import { getActiveGenerationState, startOrResumeGeneration, discardGeneration, approvePendingBlock, rejectPendingBlock, finishReviewedChapter, extendPendingBlockWithEnding, polishPendingBlock, findForbiddenCastLeaks } from '../generation.js';
import { isMainTimelineChapter } from '../timeline.js';
import { buildModelTestPack } from '../modelTestPack.js';
import { verifyContextSnapshotFreshness } from '../contextEngine.js';
import { previewOrchestrationBudget, runOrchestratedGeneration } from '../novelOrchestrator.js';
import {
  runDeterministicProsePreflight,
  runSemanticEditorialReview,
  proposePostApprovalContinuity,
  applyApprovedContinuityProposal,
} from '../postReview.js';
import { getWalletConfig } from '../inkyWallet.js';
import { FEEDBACK_OPTIONS, recordAuthorFeedback, recordEditSignal } from '../authorBrain.js';
import { getAutomaticReactionRoomCast, combineCast, formatCast } from '../storyCast.js';
import { isSafeOnlinePreview, PREVIEW_API_DISABLED_MESSAGE } from '../previewGuard.js';

let isRunning = false;
let pauseRequested = false;
let activeAbortController = null;
let flushActiveFormDraft = null;
let lastPreviewedSnapshot = null; // { hash, projectId }
let pendingOrchestrationPlan = null;
const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const docTypeLabel = { CANON:'Canon', CHARACTER:'Personajes', CONTINUITY:'Continuidad', STYLE_ONLY:'Solo estilo', REFERENCE:'Referencia', CHARACTER_BIBLE:'Biblia', ORIGINAL_CANON:'Canon original', AU_CANON:'Canon AU', WORLD_BUILDING:'Mundo', AUTHOR_INSTRUCTIONS:'Instrucciones' };
const writeDraftId = (projectId) => 'write-form-draft:' + projectId;

bus.on('view-changing', () => {
  if (typeof flushActiveFormDraft === 'function') flushActiveFormDraft();
});
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (typeof flushActiveFormDraft === 'function') flushActiveFormDraft();
  });
}

function captureWriteFormDraft(root, projectId) {
  if (!root || !root.querySelector('#write-form-card')) return null;
  return {
    id: writeDraftId(projectId),
    title: root.querySelector('#w-title')?.value || '',
    instructions: root.querySelector('#w-instructions')?.value || '',
    scenes: root.querySelector('#w-scenes')?.value || '',
    roomCast: root.querySelector('#w-room-cast')?.value || '',
    onscreenCast: root.querySelector('#w-onscreen-cast')?.value || '',
    forbiddenCast: root.querySelector('#w-forbidden')?.value || '',
    requiredEnding: root.querySelector('#w-ending')?.value || '',
    reactionMode: !!root.querySelector('#w-reactions')?.checked,
    targetWords: Number(root.querySelector('#w-words')?.value || 5000),
    generationMode: root.querySelector('#w-generation-mode')?.value || 'full_chapter',
    documentIds: Array.from(root.querySelectorAll('.w-doc:checked')).map((el) => el.value),
    updatedAt: new Date().toISOString(),
  };
}

function hasFormDraftContent(draft) {
  if (!draft) return false;
  return !!(
    String(draft.title || '').trim() ||
    String(draft.instructions || '').trim() ||
    String(draft.scenes || '').trim() ||
    String(draft.roomCast || '').trim() ||
    String(draft.onscreenCast || '').trim() ||
    String(draft.forbiddenCast || '').trim() ||
    String(draft.requiredEnding || '').trim()
  );
}

export async function renderWrite(root) {
  const projectId = db.getActiveProjectId();
  const [settings, walletConfig, active, documents, plannerDraft, savedDraft, lockedFacts] = await Promise.all([
    db.get('settings','main'), getWalletConfig(), getActiveGenerationState(), db.getAll('documents'),
    db.get('settings','planner-draft:' + projectId),
    db.get('settings', writeDraftId(projectId)),
    db.getAll('lockedFacts')
  ]);
  const safePreview = isSafeOnlinePreview();
  const primaryProvider = walletConfig?.primaryProvider || settings?.provider || 'openai';
  const hasKey = !safePreview && !!(settings?.apiKeys?.[primaryProvider] || settings?.apiKeys?.[settings?.provider]);
  const defaultGenerationMode = savedDraft?.generationMode || settings?.defaultGenerationMode || 'full_chapter';
  const defaultWords = Number(savedDraft?.targetWords || 5000);
  const isCustomWords = ![3000, 5000, 7000].includes(defaultWords);
  const savedDocSet = Array.isArray(savedDraft?.documentIds) ? new Set(savedDraft.documentIds) : null;
  const docs = documents.filter((d) => d.active !== false).sort((a,b) => (b.priority || 0)-(a.priority || 0));
  const docsHtml = docs.map((d) => {
    const checked = savedDocSet
      ? savedDocSet.has(d.id)
      : (['CANON','CHARACTER','CONTINUITY','CHARACTER_BIBLE','ORIGINAL_CANON','AU_CANON'].includes(d.role || d.type) || d.defaultSelected === true);
    const roleLabel = docTypeLabel[d.role || d.type] || d.role || d.type;
    return '<label class="doc-choice"><input type="checkbox" class="w-doc" value="'+escapeHtml(d.id)+'" '+(checked ? 'checked' : '')+'> '+escapeHtml(d.filename)+' <span class="muted">('+escapeHtml(roleLabel)+')</span></label>';
  }).join('');
  const automaticRoomCast=getAutomaticReactionRoomCast(projectId,true,lockedFacts);
  const autoRoomValue=formatCast(automaticRoomCast);
  const roomCastHtml=automaticRoomCast.length
    ? '<div class="auto-cast-box"><div class="auto-cast-title">👀 Sala de reacciones · automático</div><div class="auto-cast-pills">'+automaticRoomCast.map((name)=>'<span class="pill pill-character">'+escapeHtml(name)+'</span>').join('')+'</div><p class="scene-guide">Los '+automaticRoomCast.length+' espectadores se incluyen automáticamente. No tienes que volver a escribirlos 🥳</p><input type="hidden" id="w-auto-room-cast" value="'+escapeHtml(autoRoomValue)+'"></div>'
    : '<label class="field-label" for="w-room-cast">👀 Personajes presentes en la sala / escena principal</label><textarea id="w-room-cast" rows="3" placeholder="Personajes físicamente presentes en la escena principal"></textarea>';
  const modeHelpText = (mode) => mode === 'novel_orchestrated'
    ? 'Novel Mode divide capítulos largos (3k/5k/7k/custom) en tramos continuos de escena con traspaso de POV/tensión, persiste cada tramo como borrador y muestra el presupuesto máximo antes de empezar.'
    : (mode === 'full_chapter'
      ? 'Capítulo completo pide toda la extensión seleccionada en una sola respuesta coherente y te deja revisarla antes de guardarla.'
      : 'Por bloques usa el tamaño configurado en Ajustes y te deja aprobar cada tramo antes de continuar.');
  const keyBannerHtml = safePreview
    ? '<div class="context-guard-item context-guard-info" style="margin-bottom:10px;">🧪 <b>Vista previa segura (0 tokens):</b> la generación real está desactivada en el preview online. Usa libremente <b>«👀 Ver contexto»</b>, <b>«📋 Plan Novel Mode (0 tokens)»</b> y <b>«🧪 Exportar pack»</b> sin gastar nada.</div>'
    : (!hasKey ? '<div class="key-warning">Configura una clave API en Ajustes antes de escribir.</div>' : '');
  root.innerHTML = [
    '<h2 class="section-title">Escribir</h2>',
    '<p class="section-hint">Motor de Contexto Unificado activo. Todo borrador generado se revisa antes de aprobar; puedes escribir en Capítulo completo, Novel Mode (orquestado) o Por bloques, o co-escribir directamente en Capítulos.</p>',
    keyBannerHtml,
    '<div id="gen-banner-slot"></div>',
    '<div id="w-post-finish-slot"></div>',
    '<div class="card" id="write-form-card"><div class="card-row"><h3>Nuevo capítulo</h3><button type="button" class="btn btn-ghost btn-sm" id="w-clear-draft-btn">🧹 Limpiar formulario</button></div>',
    '<label class="field-label" for="w-title">Título</label><input id="w-title" type="text" placeholder="Capítulo 2 — Una hora antes">',
    '<label class="field-label" for="w-instructions">¿Qué debe pasar? (instrucciones, secretos y límites)</label>',
    '<textarea id="w-instructions" rows="7"></textarea>',
    '<label class="field-label" for="w-scenes">🎬 Plan de escenas, una por línea (en orden)</label>',
    '<textarea id="w-scenes" rows="5" placeholder="Viaje a la capital&#10;Conversaciones en la plaza y reacciones&#10;Anya aparece en el perro&#10;Anya llega a Erwin, habla y se corta el episodio"></textarea>',
    '<p class="scene-guide">Inky pesa los beats automáticamente. Si quieres control extra, puedes prefijar una línea con <code>[BOMB]</code>, <code>[BRIDGE]</code>, <code>[TEXTURE]</code> o <code>[HOOK]</code>.</p>',
    roomCastHtml,
    '<label class="field-label" for="w-onscreen-cast">🎬 Personajes que aparecen ONSCREEN en este capítulo</label>',
    '<textarea id="w-onscreen-cast" rows="2" placeholder="Ej: Levi, Joseph, Anya"></textarea>',
    '<p class="scene-guide">Aquí sólo anota quién aparece en el episodio/pantalla. Inky combina esto con la sala automática para cargar las fichas necesarias, pero mantiene ambos espacios separados.</p>',
    '<label class="field-label" for="w-forbidden">🚫 Personajes prohibidos (opcional)</label>',
    '<input id="w-forbidden" type="text" placeholder="Kael, Luciana">',
    '<p class="scene-guide">Si aparece uno de estos nombres en un bloque, no se incorporará al capítulo.</p>',
    '<label class="field-label" for="w-ending">Última escena obligatoria (recomendado)</label>',
    '<textarea id="w-ending" rows="3" placeholder="La niña llega a los brazos de Erwin y habla entre sollozos ANTES del corte."></textarea>',
    '<label class="field-label"><input id="w-reactions" type="checkbox" '+(savedDraft?.reactionMode === false ? '' : 'checked')+'> Sala de reacciones: ritmo orgánico (~70% sala / ~30% pantalla, flexible) + voces distintas</label>',
    '<label class="field-label">📚 Documentos autorizados para ESTE capítulo</label>',
    '<p class="scene-guide">Los no marcados quedan fuera. Un documento <code>STYLE_ONLY</code> aporta solo descriptores de oficio literario, nunca tramas ni personajes.</p>',
    '<div id="w-reference-list">'+(docsHtml || '<p class="muted">Sin documentos activos en esta historia. Súbelos en Documentos si los necesitas.</p>')+'</div>',
    '<div class="grid-2"><div><label class="field-label" for="w-words">Extensión orientativa</label><select id="w-words"><option value="3000" '+(defaultWords === 3000 ? 'selected' : '')+'>3.000 palabras</option><option value="5000" '+(defaultWords === 5000 ? 'selected' : '')+'>5.000 palabras</option><option value="7000" '+(defaultWords === 7000 ? 'selected' : '')+'>7.000 palabras</option><option value="custom" '+(isCustomWords ? 'selected' : '')+'>Personalizada…</option></select><input id="w-words-custom" type="number" min="500" max="20000" step="250" value="'+(isCustomWords ? defaultWords : 4000)+'" style="margin-top:6px; display:'+(isCustomWords ? 'block' : 'none')+'" placeholder="Palabras objetivo (ej: 4500)"></div>',
    '<div><label class="field-label" for="w-generation-mode">Modo de escritura</label><select id="w-generation-mode"><option value="full_chapter" '+(defaultGenerationMode === 'full_chapter' ? 'selected' : '')+'>📖 Capítulo completo · una sola llamada</option><option value="novel_orchestrated" '+(defaultGenerationMode === 'novel_orchestrated' ? 'selected' : '')+'>📚 Novel Mode · orquestado por escenas</option><option value="blocks" '+(defaultGenerationMode === 'blocks' ? 'selected' : '')+'>🧩 Por bloques · revisar paso a paso</option></select></div></div>',
    '<p class="scene-guide" id="w-mode-help">'+escapeHtml(modeHelpText(defaultGenerationMode))+'</p>',
    '<div id="w-novel-plan-slot"></div>',
    '<div class="writer-action-bar writer-action-bar-start"><button class="btn btn-primary writer-action" id="w-generate-btn" '+(!hasKey || active ? 'disabled' : '')+(safePreview ? ' title="'+escapeHtml(PREVIEW_API_DISABLED_MESSAGE)+'"' : '')+'>▶ Escribir</button><button type="button" class="btn btn-ghost" id="w-novel-preview-btn" style="display:'+(defaultGenerationMode === 'novel_orchestrated' ? '' : 'none')+'">📋 Plan Novel Mode y presupuesto (0 tokens)</button><button class="btn btn-ghost btn-ending writer-action" id="w-generate-ending-btn" '+(!hasKey || active ? 'disabled' : '')+(safePreview ? ' title="'+escapeHtml(PREVIEW_API_DISABLED_MESSAGE)+'"' : '')+'>✨ Add an ending</button><button class="btn btn-ghost" id="w-context-inspector-btn">👀 Ver contexto</button><button class="btn btn-ghost" id="w-export-test-pack-btn">🧪 Exportar pack</button></div><p class="scene-guide">«Ver contexto» previsualiza la instantánea EXACTA enviada al modelo (0 tokens, sin credenciales). Las contradicciones críticas bloquean la generación hasta resolverse.</p></div>',
    '<div id="w-context-inspector-slot"></div>',
    '<div class="card paper" id="w-paper-card" style="display:none"><div class="paper-title" id="w-paper-title"></div><div class="muted" id="w-paper-meta"></div><div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" id="w-copy-chapter-btn">📋 Copiar capítulo</button></div><hr><div class="paper-readonly manuscript-rendered" id="w-paper-text"></div></div>'
  ].join('');

  // Restore persisted form draft for this story.
  if (savedDraft) {
    root.querySelector('#w-title').value = savedDraft.title || '';
    root.querySelector('#w-instructions').value = savedDraft.instructions || '';
    root.querySelector('#w-scenes').value = savedDraft.scenes || '';
    const manualRoom = root.querySelector('#w-room-cast');
    if (manualRoom) manualRoom.value = savedDraft.roomCast || '';
    root.querySelector('#w-onscreen-cast').value = savedDraft.onscreenCast || '';
    root.querySelector('#w-forbidden').value = savedDraft.forbiddenCast || '';
    root.querySelector('#w-ending').value = savedDraft.requiredEnding || '';
  }

  const persistFormDraftNow = () => {
    const draft = captureWriteFormDraft(root, projectId);
    if (!draft) return;
    if (hasFormDraftContent(draft)) {
      db.put('settings', draft).catch(() => {});
    } else {
      db.del('settings', draft.id).catch(() => {});
    }
  };
  const debouncedSaveDraft = debounce(persistFormDraftNow, 350);
  flushActiveFormDraft = () => {
    debouncedSaveDraft.cancel();
    persistFormDraftNow();
  };

  if (plannerDraft?.text && !active) {
    root.querySelector('#w-instructions').value = plannerDraft.text;
    if (plannerDraft.title && !root.querySelector('#w-title').value.trim()) {
      root.querySelector('#w-title').value = plannerDraft.title;
    }
    if (plannerDraft.requiredEnding && !root.querySelector('#w-ending').value.trim()) {
      root.querySelector('#w-ending').value = plannerDraft.requiredEnding;
    }
    if (plannerDraft.targetWords && root.querySelector(`#w-words option[value="${plannerDraft.targetWords}"]`)) {
      root.querySelector('#w-words').value = String(plannerDraft.targetWords);
    }
    const mergedDraft = captureWriteFormDraft(root, projectId);
    if (mergedDraft) await db.put('settings', mergedDraft);
    await db.del('settings', plannerDraft.id);
    toast(plannerDraft.briefId
      ? 'Brief de Capítulo aprobado listo para revisar en Escribir.'
      : 'Idea de planificación lista para revisar en las instrucciones.');
  }

  const formCard = root.querySelector('#write-form-card');
  formCard?.addEventListener('input', () => debouncedSaveDraft());
  formCard?.addEventListener('change', () => debouncedSaveDraft());
  document.getElementById('w-words')?.addEventListener('change', (e) => {
    const custom = document.getElementById('w-words-custom');
    if (custom) custom.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });
  document.getElementById('w-clear-draft-btn')?.addEventListener('click', async () => {
    const draft = captureWriteFormDraft(root, projectId);
    if (hasFormDraftContent(draft) && !confirm('¿Limpiar todos los campos del formulario de este capítulo?')) return;
    debouncedSaveDraft.cancel();
    pendingOrchestrationPlan = null;
    lastPreviewedSnapshot = null;
    await db.del('settings', writeDraftId(projectId));
    await renderWrite(root);
    toast('Formulario limpio.');
  });
  document.getElementById('w-generation-mode')?.addEventListener('change',(e)=>{
    const mode = e.target.value;
    const help = document.getElementById('w-mode-help');
    if (help) help.textContent = modeHelpText(mode);
    const previewBtn = document.getElementById('w-novel-preview-btn');
    if (previewBtn) previewBtn.style.display = mode === 'novel_orchestrated' ? '' : 'none';
  });
  document.getElementById('w-novel-preview-btn')?.addEventListener('click', showNovelPlanPreview);
  document.getElementById('w-generate-btn')?.addEventListener('click',()=>onGenerateClick('continue'));
  document.getElementById('w-generate-ending-btn')?.addEventListener('click',()=>onGenerateClick('ending'));
  document.getElementById('w-context-inspector-btn')?.addEventListener('click',showContextInspectorFromForm);
  document.getElementById('w-export-test-pack-btn')?.addEventListener('click',exportModelTestPackFromForm);
  if(active){ renderBanner(active); showPaper(active); }
}

function renderBanner(state) {
  const slot=document.getElementById('gen-banner-slot');
  if(!slot)return;
  if(!state || state.status==='completed'){slot.innerHTML='';return;}
  const labels={
    in_progress:isRunning?'Preparando bloque…':'Interrumpido: pulsa Escribir siguiente bloque',
    awaiting_review:'📝 Bloque pendiente de aprobación',
    paused_review:'⏸ Bloque guardado. Elige qué sigue.',
    review_target_reached:'📖 Extensión alcanzada: revisa si ya está el desenlace.',
    paused_error:'⚠️ Se detuvo por un error',paused_busy:'⏸ Modelo ocupado',
    paused_quota:'⏸ Cuota de API',paused_network:'⏸ Conexión interrumpida',paused_manual:'⏸ Pausado'
  };
  const waiting=state.status==='awaiting_review';
  const showControls=!waiting && (state.status!=='in_progress' || !isRunning);
  const safeWordsSoFar = Number(state.wordsSoFar) || 0;
  const safeTargetWords = Number(state.targetWords) || 0;
  const safeBlocksDone = Number(state.blocksDone) || 0;
  const pct=Math.min(100,Math.round(safeWordsSoFar/Math.max(1,safeTargetWords)*100));
  const planOptions=(state.scenePlan || []).map((beat,i)=>'<option value="'+i+'" '+(i===(state.sceneIndex || 0)?'selected':'')+'>'+(i+1)+'. '+escapeHtml(beat)+'</option>').join('');
  const warnings = Array.isArray(state.pendingWarnings) ? state.pendingWarnings : [];
  const hasPreviousPending = !!String(state.previousPendingText || '').trim();
  const renderQuarantineWarnings = (liveText) => {
    const liveLeaks = findForbiddenCastLeaks(liveText, state.forbiddenCast);
    const items = [];
    if (liveLeaks.length) {
      items.push(
        '<div class="context-guard-item context-guard-critical"><b>🚫 Borrador en cuarentena — personajes prohibidos detectados: ' +
        escapeHtml(liveLeaks.join(', ')) +
        '</b><div>No se perdió el texto generado. Edita o borra esos nombres abajo para habilitar «Aceptar bloque», o descarta el bloque.</div></div>'
      );
    }
    const truncatedWarn = warnings.find((w) => w?.type === 'truncated');
    if (truncatedWarn) {
      items.push(
        '<div class="context-guard-item context-guard-warning"><b>⚠️ Respuesta posiblemente truncada (' +
        escapeHtml(truncatedWarn.finishReason || 'length') +
        ')</b><div>' + escapeHtml(truncatedWarn.message || '') + '</div></div>'
      );
    }
    return { html: items.join(''), blocked: liveLeaks.length > 0 };
  };
  const initialQuarantine = waiting ? renderQuarantineWarnings(state.pendingText || '') : { html: '', blocked: false };
  const initialDet = waiting ? runDeterministicProsePreflight(state.pendingText || '', {
    forbiddenCast: state.forbiddenCast,
    truncated: warnings.some((w) => w?.type === 'truncated'),
    targetWords: state.targetWords,
  }) : null;
  const detSummaryHtml = initialDet
    ? '<div class="context-guard-item context-guard-info" style="margin:6px 0; font-size:12px;"><b>🛡️ '+escapeHtml(initialDet.assessmentLabel)+':</b> '+
      (initialDet.findings.length ? initialDet.findings.map((f) => escapeHtml(f.message)).join(' · ') : 'Sin incidencias estructurales detectadas ('+initialDet.wordCount+' palabras).')+
      '</div>'
    : '';
  slot.innerHTML=[
    '<div class="banner"><div style="flex:1;min-width:200px"><b>'+escapeHtml(state.chapterTitle)+'</b> · '+(labels[state.status] || escapeHtml(state.status)),
    '<div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>',
    '<div class="muted">'+safeWordsSoFar+' / '+safeTargetWords+' palabras aceptadas · '+safeBlocksDone+' '+((state.generationMode || 'blocks')==='full_chapter' ? 'respuesta(s) larga(s)' : ((state.generationMode === 'novel_orchestrated') ? 'tramo(s) Novel Mode' : 'bloque(s)'))+'</div>',
    state.lastError ? '<p class="muted">'+escapeHtml(state.lastError.message)+'</p>':'','</div>',
    isRunning && state.generationMode === 'novel_orchestrated' ? '<button type="button" class="btn btn-ghost btn-sm" id="w-pause-novel-btn">⏸ Pausar tras este tramo</button>' : '',
    isRunning && activeAbortController ? '<button type="button" class="btn btn-danger btn-sm" id="w-abort-btn">⏹ Cancelar solicitud</button>' : '',
    '</div>',
    waiting ? '<div class="generation-review"><h3>✏️ Lee, corrige y aprueba este borrador</h3><p class="scene-guide">Todo texto generado empieza como BORRADOR y NO entra al capítulo hasta que lo apruebes.</p>'+detSummaryHtml+'<div id="w-quarantine-slot">'+initialQuarantine.html+'</div><textarea id="w-review-text" rows="12">'+escapeHtml(state.pendingText || '')+'</textarea><div id="w-semantic-review-slot"></div><p class="scene-guide"><b>🐈‍⬛ Enséñale tu gusto a Inky:</b> marca lo que falló; se guarda localmente y pesa en futuros capítulos.</p><div class="btn-row" id="w-feedback-row">'+FEEDBACK_OPTIONS.map(([tag,label])=>'<button type="button" class="btn btn-ghost btn-sm w-feedback-tag" data-tag="'+escapeHtml(tag)+'">'+escapeHtml(label)+'</button>').join('')+'</div><div class="review-actions"><button type="button" class="btn btn-primary" id="w-approve-btn" '+(initialQuarantine.blocked ? 'disabled' : '')+'>'+(initialQuarantine.blocked ? '🔒 Quita nombres prohibidos para aprobar' : '✓ Aceptar bloque')+'</button><button type="button" class="btn btn-ghost" id="w-copy-block-btn">📋 Copiar bloque</button><button type="button" class="btn btn-ghost" id="w-semantic-review-btn">🔎 Revisión semántica (IA · opcional)</button><button type="button" class="btn btn-ghost" id="w-editor-pass-btn">🐈‍⬛ Editor Pass · 1 llamada</button><button type="button" class="btn btn-ghost btn-ending writer-action" id="w-ending-pending-btn">✨ Add an ending</button><button type="button" class="btn btn-ghost" id="w-save-alt-btn">🌿 Guardar como alternativa</button>'+(hasPreviousPending ? '<button type="button" class="btn btn-ghost" id="w-restore-prev-btn">↩️ Borrador anterior</button>' : '')+'<button type="button" class="btn btn-ghost" id="w-reject-btn">Descartar SOLO este bloque</button></div><p class="scene-guide">La revisión semántica (opcional) es una evaluación probabilística por IA distinta a la comprobación estructural determinista de 0 tokens.</p></div>' : '',
    showControls ? '<div class="card"><h3>🎬 Siguiente paso</h3>'+
       (planOptions ? '<label class="field-label" for="w-current-scene">¿Qué escena debe avanzar ahora?</label><select id="w-current-scene">'+planOptions+'</select>':'')+
       '<label class="field-label" for="w-block-notes">Correcciones o instrucciones para el siguiente tramo</label><textarea id="w-block-notes" rows="3" placeholder="No repetir la plaza. Continúa con el diálogo en la sala."></textarea>'+
       '<div class="writer-action-bar"><button type="button" class="btn btn-primary writer-action" id="w-next-btn">▶ Continue</button><button type="button" class="btn btn-ghost writer-action" id="w-keep-going-btn">↪ Keep going</button><button type="button" class="btn btn-ghost btn-ending writer-action" id="w-add-ending-btn">✨ Add an ending</button><button type="button" class="btn btn-ghost writer-action" id="w-surprise-btn">🎲 Surprise me</button></div>'+
       '<div class="btn-row">'+
       (safeWordsSoFar ? '<button type="button" class="btn btn-ghost" id="w-finish-btn">✓ Finalizar capítulo aquí</button>':'')+
       '<button type="button" class="btn btn-danger" id="w-discard-btn">Cerrar generación</button></div>'+
       '<p class="scene-guide">Finalizar guarda el capítulo aprobado SIN disparar llamadas pagadas en segundo plano. Después podrás autorizar la propuesta de continuidad si lo deseas.</p></div>':''
  ].join('');
  const syncQuarantineUi = () => {
    const review = document.getElementById('w-review-text');
    const qSlot = document.getElementById('w-quarantine-slot');
    const approveBtn = document.getElementById('w-approve-btn');
    if (!review || !qSlot || !approveBtn) return;
    const check = renderQuarantineWarnings(review.value);
    qSlot.innerHTML = check.html;
    approveBtn.disabled = check.blocked;
    approveBtn.textContent = check.blocked ? '🔒 Quita nombres prohibidos para aprobar' : '✓ Aceptar bloque';
  };
  document.getElementById('w-review-text')?.addEventListener('input', syncQuarantineUi);
  document.getElementById('w-restore-prev-btn')?.addEventListener('click', () => {
    const review = document.getElementById('w-review-text');
    if (!review || !state.previousPendingText) return;
    review.value = state.previousPendingText;
    syncQuarantineUi();
    toast('Borrador anterior restaurado en el editor.');
  });
  document.getElementById('w-pause-novel-btn')?.addEventListener('click', (e) => {
    pauseRequested = true;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Pausando tras este tramo…';
  });
  document.getElementById('w-abort-btn')?.addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Cancelando…';
    activeAbortController?.abort();
  });
  document.querySelectorAll('.w-feedback-tag').forEach((btn)=>{
    btn.addEventListener('click',async()=>{
      const tag=btn.dataset.tag;
      try{
        await recordAuthorFeedback(tag);
        btn.disabled=true;
        btn.textContent='✓ '+btn.textContent;
        toast('Inky guardó esa señal de gusto para futuros borradores.');
      }catch(err){toast(err.message || 'No se pudo guardar la señal.',{error:true});}
    });
  });
  document.getElementById('w-copy-block-btn')?.addEventListener('click',async()=>{
    const text=document.getElementById('w-review-text')?.value || state.pendingText || '';
    try{await copyTextToClipboard(text);toast('Bloque copiado al portapapeles.');}
    catch(err){toast(err.message || 'No se pudo copiar el bloque.',{error:true});}
  });
  const stateScope = { projectId: state.projectId || db.getActiveProjectId() };
  document.getElementById('w-semantic-review-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const text = document.getElementById('w-review-text')?.value || state.pendingText || '';
    if (!text.trim()) return toast('No hay borrador para revisar.', { error: true });
    btn.disabled = true;
    btn.textContent = '🔎 Revisando…';
    try {
      const res = await runSemanticEditorialReview(text, {
        projectId: stateScope.projectId,
        targetChapterId: state.chapterId,
        chapterTitle: state.chapterTitle,
      });
      const rSlot = document.getElementById('w-semantic-review-slot');
      if (!res.ok) throw new Error(res.error || 'No se pudo ejecutar la revisión semántica.');
      if (rSlot) {
        const flags = (res.invariantFlags || []).map((f) => `<li><b>[${escapeHtml(f.severity || 'info')}] ${escapeHtml(f.category || '')}:</b> ${escapeHtml(f.explanation || '')}</li>`).join('');
        const craft = (res.voiceAndCraftNotes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
        const leaks = (res.epistemicLeakRisks || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
        rSlot.innerHTML = `<div class="card" style="margin:8px 0;"><b>🔎 ${escapeHtml(res.assessmentLabel)}</b><p style="margin:6px 0;">${escapeHtml(res.overallNotes || '')}</p>${flags ? `<div><b>Alertas de invariantes:</b><ul>${flags}</ul></div>` : ''}${leaks ? `<div><b>Riesgos epistémicos/secretos:</b><ul>${leaks}</ul></div>` : ''}${craft ? `<div><b>Notas de voz y oficio:</b><ul>${craft}</ul></div>` : ''}</div>`;
      }
      toast('Revisión editorial semántica lista (evaluación probabilística).');
    } catch (err) {
      toast(err.message || 'Falló la revisión semántica.', { error: true, ms: 8500 });
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = '🔎 Revisión semántica (IA · opcional)'; }
    }
  });
  document.getElementById('w-save-alt-btn')?.addEventListener('click', async () => {
    const text = document.getElementById('w-review-text')?.value.trim() || state.pendingText || '';
    if (!text) return toast('No hay borrador para guardar.', { error: true });
    const full = state.generationMode === 'novel_orchestrated' ? text : [state.accumulatedText, text].filter(Boolean).join('\n\n');
    const altChapter = {
      id: db.uid(),
      projectId: stateScope.projectId,
      title: `${state.chapterTitle} (alternativa)`,
      content: full,
      wordCount: wordCount(full),
      status: 'draft',
      branchRole: 'alternative',
      branchGroupId: state.chapterId,
      variantLabel: 'Borrador alternativo',
      versions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.put('chapters', altChapter, stateScope);
    bus.emit('chapters-changed');
    toast('Guardado como capítulo alternativo fuera de la línea principal.');
  });
  document.getElementById('w-editor-pass-btn')?.addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    const review=document.getElementById('w-review-text');
    if(!review?.value.trim())return toast('No hay borrador para editar.',{error:true});
    btn.disabled=true;
    btn.textContent='🐈‍⬛ Editando…';
    try{
      const updated=await polishPendingBlock(state.chapterId,review.value,stateScope);
      if (db.getActiveProjectId() === stateScope.projectId && review.isConnected) {
        renderBanner(updated);
      }
      toast(updated.pendingWarnings?.length ? '⚠️ Editor Pass guardado en cuarentena: revisa las advertencias antes de aprobar.' : 'Editor Pass listo. Revisa el nuevo borrador antes de aprobar.',{ms:7500});
    }catch(err){toast(err.message || 'No se pudo hacer el Editor Pass.',{error:true,ms:9000});}
    finally{if(btn.isConnected){btn.disabled=false;btn.textContent='🐈‍⬛ Editor Pass · 1 llamada';}}
  });
  document.getElementById('w-ending-pending-btn')?.addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    const review=document.getElementById('w-review-text');
    btn.disabled=true;
    btn.textContent='✨ Adding ending…';
    try{
      const updated=await extendPendingBlockWithEnding(state.chapterId,review?.value || state.pendingText || '','natural',stateScope);
      if(review && review.isConnected && db.getActiveProjectId() === stateScope.projectId) {
        renderBanner(updated);
      }
      toast(updated.pendingWarnings?.length ? '⚠️ Final añadido con advertencias de cuarentena. Revísalo antes de aprobar.' : 'Final añadido al bloque. Revísalo antes de aprobar.',{ms:6500});
    }catch(err){toast(err.message || 'No se pudo añadir el final.',{error:true,ms:8500});}
    finally{if(btn.isConnected){btn.disabled=false;btn.textContent='✨ Add an ending';}}
  });
  document.getElementById('w-approve-btn')?.addEventListener('click',async(e)=>{
    e.currentTarget.disabled=true;
    try{
      const edited=document.getElementById('w-review-text').value;
      const original=state.pendingText || '';
      await approvePendingBlock(state.chapterId,edited,stateScope);
      try{await recordEditSignal(original,edited);}catch{}
      toast('Bloque aprobado y guardado.');await renderWrite(document.getElementById('view-write'));
    }catch(err){toast(err.message,{error:true,ms:6500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-reject-btn')?.addEventListener('click',async()=>{
    if(!confirm('¿Descartar SOLO este bloque? Los anteriores se conservan.'))return;
    await rejectPendingBlock(state.chapterId,stateScope);
    toast('Bloque descartado. Puedes indicar cómo reescribirlo.');await renderWrite(document.getElementById('view-write'));
  });
  const runIntent=(buttonId,generationIntent)=>{
    document.getElementById(buttonId)?.addEventListener('click',async(e)=>{
      e.currentTarget.disabled=true;
      await runGeneration({
        projectId:stateScope.projectId,
        chapterId:state.chapterId,chapterTitle:state.chapterTitle,instructions:state.instructions,
        targetWords:state.targetWords,requiredEnding:state.requiredEnding,
        sceneIndex:document.getElementById('w-current-scene')?Number(document.getElementById('w-current-scene').value):state.sceneIndex,
        blockNotes:document.getElementById('w-block-notes')?.value.trim() || '',generationIntent,
        generationMode:state.generationMode || 'blocks'
      });
    });
  };
  runIntent('w-next-btn','continue');
  runIntent('w-keep-going-btn','keep-going');
  runIntent('w-add-ending-btn','ending');
  runIntent('w-surprise-btn','surprise');
  document.getElementById('w-finish-btn')?.addEventListener('click',async(e)=>{
    if(!confirm('¿Finalizar capítulo con los bloques aprobados? No se realizará ninguna llamada automática a la API; luego podrás autorizar la propuesta de continuidad si lo deseas.'))return;
    e.currentTarget.disabled=true;
    try{
      const finishedChapterId = state.chapterId;
      await finishReviewedChapter(finishedChapterId,stateScope);
      await renderWrite(document.getElementById('view-write'));
      bus.emit('chapters-changed');
      toast('Capítulo finalizado y guardado (0 llamadas automáticas de continuidad).');
      const chapter = await db.get('chapters', finishedChapterId, stateScope);
      const postSlot = document.getElementById('w-post-finish-slot');
      if (chapter && postSlot) {
        postSlot.innerHTML = `<div class="card" id="w-post-continuity-card"><h3>🧠 Capítulo aprobado: «${escapeHtml(chapter.title)}»</h3><p class="muted">La extracción de continuidad requiere tu autorización explícita y te permite editar cada hecho, conocimiento o cambio relacional antes de guardarlo.</p><div class="btn-row"><button type="button" class="btn btn-primary btn-sm" id="w-propose-continuity-btn">🧠 Proponer actualización de continuidad (1 llamada · editable)</button><button type="button" class="btn btn-ghost btn-sm" id="w-dismiss-continuity-btn">Más tarde</button></div></div>`;
        document.getElementById('w-dismiss-continuity-btn')?.addEventListener('click', () => { postSlot.innerHTML = ''; });
        document.getElementById('w-propose-continuity-btn')?.addEventListener('click', async (ev) => {
          const b = ev.currentTarget;
          b.disabled = true;
          b.textContent = '🧠 Analizando capítulo…';
          try {
            const prop = await proposePostApprovalContinuity(chapter, { projectId: stateScope.projectId });
            if (!prop.ok) throw new Error(prop.error || 'No se pudo proponer la continuidad.');
            openContinuityProposalModal(chapter, prop, stateScope.projectId, () => { postSlot.innerHTML = ''; });
          } catch (err) {
            toast(err.message || 'No se pudo proponer la continuidad.', { error: true, ms: 8500 });
          } finally {
            if (b.isConnected) { b.disabled = false; b.textContent = '🧠 Proponer actualización de continuidad (1 llamada · editable)'; }
          }
        });
      }
    }catch(err){toast(err.message,{error:true,ms:8500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-discard-btn')?.addEventListener('click',async()=>{
    if(!confirm('¿Cerrar generación? Se conservará en Capítulos el texto ya aprobado como borrador.'))return;
    await discardGeneration(state.chapterId,stateScope);
    toast('Generación cerrada. Tu texto aprobado sigue guardado.');await renderWrite(document.getElementById('view-write'));
  });
}

function openContinuityProposalModal(chapter, proposal, projectId, onSaved) {
  const sf = proposal.summaryFields || {};
  const factsHtml = (proposal.proposedFacts || []).map((f, i) => `
    <label style="display:block; margin:4px 0;"><input type="checkbox" class="cp-fact-check" data-idx="${i}" checked> <b>${escapeHtml(f.title)}:</b> ${escapeHtml(f.truth)} ${f.isSecret ? '<span class="pill pill-canon">Secreto</span>' : ''}</label>
  `).join('') || '<p class="muted">Sin hechos nuevos propuestos.</p>';
  const knowHtml = (proposal.proposedKnowledgeTransitions || []).map((k, i) => `
    <label style="display:block; margin:4px 0;"><input type="checkbox" class="cp-know-check" data-idx="${i}" checked> <b>${escapeHtml(k.characterId)}</b> [${escapeHtml(k.state)}] «${escapeHtml(k.factTitle)}»: ${escapeHtml(k.beliefText || '')}</label>
  `).join('') || '<p class="muted">Sin transiciones epistémicas propuestas.</p>';
  const relHtml = (proposal.proposedRelationshipUpdates || []).map((r, i) => `
    <label style="display:block; margin:4px 0;"><input type="checkbox" class="cp-rel-check" data-idx="${i}" checked> <b>${escapeHtml((r.participants || []).join(' ↔ '))}:</b> ${escapeHtml(r.shift || '')} ${r.promise ? '· Promesa: ' + escapeHtml(r.promise) : ''}</label>
  `).join('') || '<p class="muted">Sin cambios relacionales propuestos.</p>';

  openModal(`
    <h3>🧠 Revisar y editar continuidad propuesta — ${escapeHtml(chapter.title)}</h3>
    <p class="muted">Nada se ha guardado todavía. Edita el resumen y marca solo los hechos/transiciones que quieras incorporar al canon.</p>
    <label class="field-label">Eventos</label><textarea id="cp-events" rows="3">${escapeHtml(sf.events || '')}</textarea>
    <label class="field-label">Cambios de relación</label><textarea id="cp-rel" rows="2">${escapeHtml(sf.relationshipChanges || '')}</textarea>
    <label class="field-label">Quién sabe qué</label><textarea id="cp-know" rows="2">${escapeHtml(sf.whoKnowsWhat || '')}</textarea>
    <label class="field-label">Hilos abiertos / promesas</label><textarea id="cp-threads" rows="2">${escapeHtml(sf.openThreads || '')}</textarea>
    <label class="field-label">Hechos propuestos</label><div>${factsHtml}</div>
    <label class="field-label">Transiciones de conocimiento propuestas</label><div>${knowHtml}</div>
    <label class="field-label">Actualizaciones relacionales propuestas</label><div>${relHtml}</div>
    <div class="btn-row" style="margin-top:12px;">
      <button type="button" class="btn btn-primary" id="cp-save-btn">✓ Guardar continuidad seleccionada</button>
      <button type="button" class="btn btn-ghost" id="cp-cancel-btn">Descartar</button>
    </div>
  `);
  document.getElementById('cp-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('cp-save-btn')?.addEventListener('click', async () => {
    const edited = {
      ...proposal,
      summaryFields: {
        ...sf,
        events: document.getElementById('cp-events').value.trim(),
        relationshipChanges: document.getElementById('cp-rel').value.trim(),
        whoKnowsWhat: document.getElementById('cp-know').value.trim(),
        openThreads: document.getElementById('cp-threads').value.trim(),
      },
      proposedFacts: (proposal.proposedFacts || []).map((f, i) => ({ ...f, selected: Boolean(document.querySelector(`.cp-fact-check[data-idx="${i}"]`)?.checked) })),
      proposedKnowledgeTransitions: (proposal.proposedKnowledgeTransitions || []).map((k, i) => ({ ...k, selected: Boolean(document.querySelector(`.cp-know-check[data-idx="${i}"]`)?.checked) })),
      proposedRelationshipUpdates: (proposal.proposedRelationshipUpdates || []).map((r, i) => ({ ...r, selected: Boolean(document.querySelector(`.cp-rel-check[data-idx="${i}"]`)?.checked) })),
    };
    const res = await applyApprovedContinuityProposal(chapter, edited, { projectId });
    closeModal();
    onSaved?.();
    toast(`Continuidad guardada (${res.savedFactsCount} hecho(s), ${res.savedRelationshipsCount} relación(es)).`);
  });
}

function showPaper(state){
  const card=document.getElementById('w-paper-card');if(!card)return;
  card.style.display='block';
  document.getElementById('w-paper-title').textContent=state.chapterTitle;
  document.getElementById('w-paper-meta').textContent=state.wordsSoFar+' / '+state.targetWords+' palabras aprobadas';
  document.getElementById('w-paper-text').innerHTML=renderManuscript(state.accumulatedText || '(ningún bloque aprobado todavía)');
  const copyBtn=document.getElementById('w-copy-chapter-btn');
  if(copyBtn){
    copyBtn.disabled=!String(state.accumulatedText || '').trim();
    copyBtn.onclick=async()=>{
      const text=String(state.accumulatedText || '').trim();
      if(!text)return toast('Todavía no hay bloques aprobados para copiar.',{error:true});
      try{
        await copyTextToClipboard(state.chapterTitle+'\n\n'+text);
        toast('Capítulo copiado al portapapeles.');
      }catch(err){toast(err.message || 'No se pudo copiar el capítulo.',{error:true});}
    };
  }
}

function readTargetWordsFromForm() {
  const sel = document.getElementById('w-words')?.value || '5000';
  if (sel === 'custom') {
    const custom = Number(document.getElementById('w-words-custom')?.value || 4000);
    return Number.isFinite(custom) && custom >= 500 ? Math.floor(custom) : 4000;
  }
  return Number(sel) || 5000;
}

function readCastFromForm(){
  const reactionMode=!!document.getElementById('w-reactions')?.checked;
  const automaticRoomValue=document.getElementById('w-auto-room-cast')?.value.trim() || '';
  const automaticRoom=automaticRoomValue ? combineCast(automaticRoomValue) : [];
  const manualRoom=document.getElementById('w-room-cast')?.value.trim() || '';
  const roomCast=reactionMode ? (automaticRoom.length ? formatCast(automaticRoom) : manualRoom) : '';
  const onscreenCast=document.getElementById('w-onscreen-cast')?.value.trim() || '';
  const allowedCast=formatCast(combineCast(roomCast,onscreenCast));
  return {reactionMode,roomCast,onscreenCast,allowedCast};
}

async function showNovelPlanPreview() {
  const title = document.getElementById('w-title')?.value.trim() || '';
  const instructions = document.getElementById('w-instructions')?.value.trim() || '';
  const targetWords = readTargetWordsFromForm();
  const requiredEnding = document.getElementById('w-ending')?.value.trim() || '';
  const scenePlan = lines(document.getElementById('w-scenes')?.value || '');
  const { reactionMode, roomCast, onscreenCast, allowedCast } = readCastFromForm();
  const forbiddenCast = document.getElementById('w-forbidden')?.value.trim() || '';
  const documentIds = Array.from(document.querySelectorAll('.w-doc:checked')).map((el) => el.value);
  if (!title || !instructions) return toast('Escribe título e instrucciones antes de planear Novel Mode.', { error: true });

  const slot = document.getElementById('w-novel-plan-slot');
  if (!slot) return;
  const preview = await previewOrchestrationBudget({
    chapterTitle: title,
    instructions,
    targetWords,
    requiredEnding,
    scenePlan,
    orchestrationPlan: pendingOrchestrationPlan,
    allowedCast,
    roomCast,
    onscreenCast,
    forbiddenCast,
    documentIds,
    reactionMode,
  });
  pendingOrchestrationPlan = preview.plan;
  lastPreviewedSnapshot = { hash: preview.snapshotHash, projectId: db.getActiveProjectId() };

  slot.innerHTML = `
    <div class="paper" id="w-novel-budget-card" style="padding:12px; margin:8px 0;">
      <div class="card-row">
        <div>
          <b>📚 Plan de Novel Mode (${preview.maxRequests} solicitudes máximas · ~${targetWords} palabras)</b>
          <div class="muted" style="font-size:12px;">
            Modelo: ${escapeHtml(preview.providerId)} / ${escapeHtml(preview.modelId)} ·
            Tokens estimados: ~${preview.estimatedInputTokensTotal.toLocaleString('es-ES')} entrada · Tope salida autorizado total (incluye razonamiento): ${Number(preview.authorizedOutputTokensTotal || preview.estimatedOutputTokensTotal || 0).toLocaleString('es-ES')} ·
            Techo conservador estimado: <b>${escapeHtml(preview.costEstimate?.displayCost || 'costo desconocido')}</b> ·
            Límite estimado local: $${Number(preview.maxGenerationSpendUsd || 0).toFixed(2)} USD (no es límite garantizado del proveedor)
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="w-novel-plan-close">Cerrar</button>
      </div>
      ${!preview.withinBudget ? `<div class="context-guard-item context-guard-critical" style="margin-top:6px;">${escapeHtml(preview.budgetMessage)}</div>` : ''}
      ${preview.blockedByCriticalIssues ? `<div class="context-guard-item context-guard-critical" style="margin-top:6px;">🚨 Bloqueado por contradicciones críticas: ${escapeHtml(preview.criticalBlockers.map((b) => b.message).join(' | '))}</div>` : ''}
      <div style="margin-top:8px;">
        ${preview.plan.map((st, idx) => `
          <div class="grid-2" style="margin-bottom:6px; align-items:center;">
            <input type="text" class="novel-step-focus" data-idx="${idx}" value="${escapeHtml(st.focus)}">
            <input type="number" class="novel-step-words" data-idx="${idx}" min="400" max="6000" step="100" value="${Number(st.targetWords) || 1500}">
          </div>
        `).join('')}
      </div>
    </div>`;

  slot.querySelector('#w-novel-plan-close')?.addEventListener('click', () => { slot.innerHTML = ''; });
  slot.querySelectorAll('.novel-step-focus, .novel-step-words').forEach((inp) => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.idx);
      if (!pendingOrchestrationPlan?.[idx]) return;
      if (inp.classList.contains('novel-step-focus')) pendingOrchestrationPlan[idx].focus = inp.value;
      if (inp.classList.contains('novel-step-words')) pendingOrchestrationPlan[idx].targetWords = Math.max(400, Number(inp.value) || 1500);
    });
  });
}

async function showContextInspectorFromForm(){
  const title=document.getElementById('w-title')?.value.trim() || '';
  const instructions=document.getElementById('w-instructions')?.value.trim() || '';
  const targetWords=readTargetWordsFromForm();
  const generationMode=document.getElementById('w-generation-mode')?.value || 'full_chapter';
  const requiredEnding=document.getElementById('w-ending')?.value.trim() || '';
  const scenePlan=lines(document.getElementById('w-scenes')?.value || '');
  const {reactionMode,roomCast,onscreenCast,allowedCast}=readCastFromForm();
  const forbiddenCast=document.getElementById('w-forbidden')?.value.trim() || '';
  const documentIds=Array.from(document.querySelectorAll('.w-doc:checked')).map((el)=>el.value);

  if(!title || !instructions)return toast('Escribe título e instrucciones antes de revisar el contexto.',{error:true});
  if(!allowedCast)return toast('Indica el reparto autorizado para ver las fichas que Inky cargará.',{error:true,ms:6500});

  const btn=document.getElementById('w-context-inspector-btn');
  const slot=document.getElementById('w-context-inspector-slot');
  if(!slot)return;
  if(btn){btn.disabled=true;btn.textContent='👀 Preparando…';}
  try{
    const pack=await buildModelTestPack({
      chapterTitle:title,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      documentIds,
      reactionMode,
      generationMode,
    });
    lastPreviewedSnapshot = { hash: pack.snapshotHash, projectId: db.getActiveProjectId() };
    const ctx=pack.inspector || {};
    const uni = ctx.universeSummary || {};
    const dna = ctx.writingDnaSummary || {};
    const refs = ctx.referencesSummary || {};
    const target = ctx.narrativeTarget || {};
    const chars=(ctx.characters || []).map((item)=>escapeHtml(item.name)).join(', ') || 'Ninguno';
    const memories=(ctx.memories || []).map((item)=>'<li><b>'+escapeHtml(item.chapterTitle)+'</b> <span class="muted">· '+escapeHtml(item.reason || 'seleccionada')+'</span></li>').join('') || '<li>Ninguna</li>';
    const docs=(ctx.documents || []).map((item)=>'<li><b>'+escapeHtml(item.filename)+'</b> <span class="muted">('+escapeHtml(item.type)+' · '+escapeHtml(item.timelineId || 'shared_active')+')</span></li>').join('') || '<li>Ninguno</li>';
    const chunks=(ctx.retrievedChunks || []).map((item)=>{
      const raw=String(item.text || '');
      const snippet=raw.length>750 ? raw.slice(0,749).trimEnd()+'…' : raw;
      return '<div class="context-snippet"><b>'+escapeHtml(item.filename)+' ['+escapeHtml(item.type)+']</b><div>'+escapeHtml(snippet)+'</div></div>';
    }).join('') || '<p class="muted">No se recuperó ningún fragmento factual.</p>';
    const styleRefs = (refs.styleGuidance || []).map((sg) => '<li><b>'+escapeHtml(sg.filename)+'</b> (<code>STYLE_ONLY</code> — solo oficio, sin trama ni overlays)</li>').join('') || '<li>Ninguno</li>';
    const excerpts=(ctx.storyExcerpts || []).map((item)=>{
      const raw=String(item.text || '');
      const snippet=raw.length>650 ? raw.slice(0,649).trimEnd()+'…' : raw;
      return '<div class="context-snippet"><b>'+escapeHtml(item.chapterTitle)+'</b><div>'+escapeHtml(snippet)+'</div></div>';
    }).join('') || '<p class="muted">No se recuperaron pasajes históricos BM25.</p>';
    const overlaysHtml = (uni.activeOverlays || []).length
      ? uni.activeOverlays.map((o) => `<li><b>${escapeHtml(o.name)}</b> (${escapeHtml(o.characterId)} · ${escapeHtml(o.scope)}/${escapeHtml(o.characterVersion)})</li>`).join('')
      : '<li>Ninguno activo (Levi estándar por defecto)</li>';
    const kEntries = Object.entries(ctx.epistemicSummary?.characterKnowledgeMap || {});
    const epistemicHtml = kEntries.length
      ? kEntries.map(([cid, b]) => `<li><b>${escapeHtml(cid)}:</b> sabe ${(b.knows || []).length}, sospecha ${(b.suspects || []).length}, falsa creencia ${(b.believesFalse || []).length}, bloqueado por llegada tardía ${(b.blockedByLateArrival || []).length}</li>`).join('')
      : '<li>Sin restricciones epistémicas registradas.</li>';
    const preflight=ctx.preflight || {issues:[],criticalCount:0,warningCount:0,infoCount:0,ok:true};
    const issueIcon={critical:'🚨',warning:'⚠️',info:'ℹ️'};
    const preflightHtml=(preflight.issues || []).length
      ? (preflight.issues || []).map((item)=>
          '<div class="context-guard-item context-guard-'+escapeHtml(item.level || 'info')+'"><div><b>'+escapeHtml(issueIcon[item.level] || 'ℹ️')+' '+escapeHtml(item.title || 'Revisión')+'</b><div>'+escapeHtml(item.message || '')+'</div></div></div>'
        ).join('')
      : '<div class="context-guard-ok">✅ Sin contradicciones críticas. Listo para generar con la instantánea exacta.</div>';

    slot.innerHTML=[
      '<div class="card context-inspector" id="w-context-inspector" data-snapshot-hash="'+escapeHtml(ctx.snapshotHash || '')+'">',
      '<div class="card-row context-inspector-head"><div><h3>👀 Context Inspector (Motor de Contexto Unificado)</h3><div class="muted">Vista previa EXACTA del request al modelo (0 tokens · sin claves API · diagnósticos separados del prompt). Snapshot: <code>'+escapeHtml(ctx.snapshotHash || '')+'</code></div></div><button type="button" class="btn btn-ghost btn-sm" id="w-context-close">Cerrar</button></div>',
      '<div class="context-summary">',
      '<span class="pill '+(preflight.ok ? 'pill-active' : 'pill-canon')+'">'+(preflight.ok ? '✅ Listo' : '🛑 BLOQUEADO ('+preflight.criticalCount+' crítico(s))')+'</span>',
      '<span class="pill pill-character">Cap. objetivo #'+escapeHtml(String(target.targetChapterOrder ?? 'nuevo'))+(target.isHistoricalRewrite ? ' (reescritura histórica)' : '')+'</span>',
      '<span class="pill pill-continuity">'+(ctx.characters?.length || 0)+' personajes · '+(uni.allowedRoomCast?.length || 0)+' en sala</span>',
      '<span class="pill pill-style">≈ '+(ctx.approxInputTokens || 0).toLocaleString('es-ES')+' in · tope salida '+(ctx.maxOutputTokens || 0).toLocaleString('es-ES')+' tok</span>',
      '<span class="pill pill-reference">💰 '+escapeHtml(ctx.costEstimate?.displayCost || 'costo desconocido')+'</span>',
      '</div>',
      ctx.budgetCheck && !ctx.budgetCheck.allowed ? '<div class="context-guard-item context-guard-critical" style="margin:6px 0;"><b>🛑 Presupuesto local:</b> '+escapeHtml(ctx.budgetCheck.message || '')+'</div>' : '',
      '<details open><summary>🛡️ Contradicciones e invariantes (diagnóstico exclusivo del Inspector — bloquea si hay críticos)</summary><div class="context-details-body">'+preflightHtml+'</div></details>',
      '<p class="context-lead"><b>🌌 Universo / Checkpoint:</b> '+escapeHtml(uni.fandom || 'neutral')+' · checkpoint: '+escapeHtml(uni.checkpointId || '(ninguno)')+' · Joseph: '+escapeHtml(uni.josephStatus || 'disabled')+' · Anya: '+escapeHtml(uni.anyaStatus || 'disabled')+'</p>',
      '<p class="context-lead"><b>🧬 Writing DNA:</b> idioma manuscrito=<code>'+escapeHtml(dna.manuscriptLanguage || 'en')+'</code> · '+escapeHtml(String(dna.literaryQualitiesCount || 0))+' cualidades · '+escapeHtml(String(dna.activeAntiPatternsCount || 0))+' anti-patrones · '+escapeHtml(String((dna.approvedLearnedRules || []).length))+' reglas aprendidas aprobadas</p>',
      '<p class="context-lead"><b>📋 Brief aprobado:</b> '+(ctx.approvedChapterBrief ? escapeHtml(ctx.approvedChapterBrief.title || ctx.approvedChapterBrief.objective) : 'Ninguno activo para este capítulo')+'</p>',
      '<p class="context-lead"><b>👤 Personajes cargados:</b> '+chars+'</p>',
      '<p class="muted">Proveedor/modelo: '+escapeHtml(ctx.sourceProvider || 'openai')+' · '+escapeHtml(ctx.sourceModel || '')+(ctx.reasoningEffort ? ' · reasoning='+escapeHtml(ctx.reasoningEffort) : '')+' · tope salida autorizado (enviado exacto al proveedor, incluye razonamiento)='+escapeHtml(String(ctx.maxOutputTokens || ''))+' · aviso: techo de costo estimado local, NO tope garantizado de facturación del proveedor.</p>',
      '<details><summary>🎭 Overlays de personaje activos ('+(uni.activeOverlays?.length || 0)+')</summary><div class="context-details-body"><ul>'+overlaysHtml+'</ul></div></details>',
      '<details><summary>🔐 Restricciones epistémicas y conocimiento individual ('+kEntries.length+')</summary><div class="context-details-body"><ul>'+epistemicHtml+'</ul></div></details>',
      '<details open><summary>📚 Referencias factuales ('+(ctx.retrievedChunks?.length || 0)+') y oficio STYLE_ONLY ('+(refs.styleGuidance?.length || 0)+')</summary><div class="context-details-body">'+chunks+'<div><b>Solo oficio (STYLE_ONLY):</b><ul>'+styleRefs+'</ul></div></div></details>',
      '<details><summary>🔎 Pasajes históricos BM25 ('+(ctx.storyExcerpts?.length || 0)+') y memorias ('+(ctx.memories?.length || 0)+')</summary><div class="context-details-body">'+excerpts+'<ul>'+memories+'</ul></div></details>',
      '<details><summary>📄 Documentos seleccionados ('+(ctx.documents?.length || 0)+')</summary><div class="context-details-body"><ul>'+docs+'</ul></div></details>',
      '<details><summary>🧾 Request EXACTO enviado al modelo (modelBound · sin diagnósticos del Inspector)</summary><div class="context-details-body"><div class="muted">System prompt</div><pre class="context-prompt" id="w-inspector-system-prompt">'+escapeHtml(ctx.systemPrompt || '')+'</pre><div class="muted">User prompt</div><pre class="context-prompt" id="w-inspector-user-prompt">'+escapeHtml(ctx.userPrompt || '')+'</pre></div></details>',
      '<div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" id="w-context-copy">📋 Copiar reporte</button></div>',
      '</div>'
    ].join('');
    document.getElementById('w-context-close')?.addEventListener('click',()=>{slot.innerHTML='';});
    document.getElementById('w-context-copy')?.addEventListener('click',async()=>{
      try{await copyTextToClipboard(pack.markdown);toast('Contexto copiado al portapapeles.');}
      catch(err){toast(err.message || 'No se pudo copiar el contexto.',{error:true});}
    });
    slot.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){
    toast('No se pudo preparar el contexto: '+(err.message || err),{error:true,ms:9000});
  }finally{
    if(btn){btn.disabled=false;btn.textContent='👀 Ver contexto';}
  }
}

async function exportModelTestPackFromForm(){
  const title=document.getElementById('w-title')?.value.trim() || '';
  const instructions=document.getElementById('w-instructions')?.value.trim() || '';
  const targetWords=readTargetWordsFromForm();
  const generationMode=document.getElementById('w-generation-mode')?.value || 'full_chapter';
  const requiredEnding=document.getElementById('w-ending')?.value.trim() || '';
  const scenePlan=lines(document.getElementById('w-scenes')?.value || '');
  const {reactionMode,roomCast,onscreenCast,allowedCast}=readCastFromForm();
  const forbiddenCast=document.getElementById('w-forbidden')?.value.trim() || '';
  const documentIds=Array.from(document.querySelectorAll('.w-doc:checked')).map((el)=>el.value);

  if(!title || !instructions)return toast('Escribe título e instrucciones antes de exportar el pack.',{error:true});
  if(!allowedCast)return toast('Indica el reparto autorizado para que el pack incluya las fichas correctas.',{error:true,ms:6500});

  const btn=document.getElementById('w-export-test-pack-btn');
  if(btn){btn.disabled=true;btn.textContent='🧪 Preparando pack…';}
  try{
    const pack=await buildModelTestPack({
      chapterTitle:title,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      documentIds,
      reactionMode,
      generationMode,
    });
    const blob=new Blob([pack.markdown],{type:'text/markdown;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=pack.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('🧪 Pack listo: '+pack.stats.characters+' fichas, '+pack.stats.memories+' memorias y '+pack.stats.documents+' documento(s). No se gastaron créditos.',{ms:9000});
  }catch(err){
    toast('No se pudo crear el pack: '+(err.message || err),{error:true,ms:9000});
  }finally{
    if(btn){btn.disabled=false;btn.textContent='🧪 Exportar pack';}
  }
}

async function onGenerateClick(generationIntent='continue'){
  const title=document.getElementById('w-title').value.trim();
  const instructions=document.getElementById('w-instructions').value.trim();
  const targetWords=readTargetWordsFromForm();
  const generationMode=document.getElementById('w-generation-mode')?.value || 'full_chapter';
  const requiredEnding=document.getElementById('w-ending').value.trim();
  const scenePlan=lines(document.getElementById('w-scenes').value);
  const {reactionMode,roomCast,onscreenCast,allowedCast}=readCastFromForm();
  const forbiddenCast=document.getElementById('w-forbidden').value.trim();
  const documentIds=Array.from(document.querySelectorAll('.w-doc:checked')).map((el)=>el.value);
  if(!title || !instructions)return toast('Escribe título e instrucciones.',{error:true});
  if(!allowedCast)return toast('Indica el reparto autorizado del capítulo.',{error:true,ms:6500});
  if(await getActiveGenerationState())return toast('Termina o cierra el capítulo pendiente.',{error:true});

  const projectId=db.getActiveProjectId();

  // 1. Verificar frescura del Context Inspector si la autora lo previsualizó antes
  if (lastPreviewedSnapshot && lastPreviewedSnapshot.projectId === projectId) {
    const op = generationMode === 'novel_orchestrated' ? 'novel_orchestrated' : (generationMode === 'blocks' ? 'manual_block' : 'full_chapter');
    const freshness = await verifyContextSnapshotFreshness(lastPreviewedSnapshot.hash, {
      projectId,
      operation: op,
      chapterTitle: title,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      documentIds,
      reactionMode,
    });
    if (!freshness.fresh) {
      lastPreviewedSnapshot = null;
      await showContextInspectorFromForm();
      toast('⚠️ El contexto cambió después de tu vista previa anterior. Revisa el Context Inspector actualizado antes de generar.', { error: true, ms: 9000 });
      return;
    }
  }

  // 2. Validación unificada y BLOQUEO DURO ante contradicciones críticas
  const preflightPack=await buildModelTestPack({
    projectId,
    chapterTitle:title,
    instructions,
    targetWords,
    requiredEnding,
    scenePlan,
    allowedCast,
    roomCast,
    onscreenCast,
    forbiddenCast,
    documentIds,
    reactionMode,
    generationMode,
  });
  const preflight=preflightPack.inspector?.preflight;
  const blockers=(preflight?.issues || []).filter((item)=>item.level==='critical');
  if(!preflightPack.canGenerate || blockers.length){
    await showContextInspectorFromForm();
    toast('🛑 Generación bloqueada por '+blockers.length+' contradicción(es) crítica(s). Resuélvelas antes de generar.',{error:true,ms:9500});
    return;
  }

  // 3. Si es Novel Mode, divulgar presupuesto máximo antes de empezar
  if (generationMode === 'novel_orchestrated') {
    const budgetPreview = await previewOrchestrationBudget({
      projectId,
      chapterTitle: title,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      orchestrationPlan: pendingOrchestrationPlan,
      allowedCast,
      roomCast,
      onscreenCast,
      forbiddenCast,
      documentIds,
      reactionMode,
    });
    if (!budgetPreview.withinBudget) {
      toast(budgetPreview.budgetMessage || 'Supera tu límite de gasto configurado en Inky Wallet.', { error: true, ms: 9500 });
      return;
    }
    const okStart = confirm(
      `📚 Novel Mode (orquestado):\n` +
      `• Máximo de solicitudes: ${budgetPreview.maxRequests}\n` +
      `• Tokens estimados: ~${budgetPreview.estimatedInputTokensTotal} entrada / ~${budgetPreview.estimatedOutputTokensTotal} salida\n` +
      `• Costo estimado total: ${budgetPreview.costEstimate?.displayCost || 'costo desconocido'}\n` +
      `• Límite autorizado por generación: $${Number(budgetPreview.maxGenerationSpendUsd || 0).toFixed(2)} USD\n\n` +
      `Cada tramo se guardará como borrador antes del siguiente y puedes pausar o cancelar en cualquier momento. ¿Iniciar?`
    );
    if (!okStart) return;
    pendingOrchestrationPlan = budgetPreview.plan;
  }

  const chapters=await db.getAll('chapters');
  const mainChapters=chapters.filter(isMainTimelineChapter);
  const nextOrder=mainChapters.length ? Math.max(...mainChapters.map((chapter)=>chapter.order ?? 0)) + 1 : 0;
  const chapter={id:db.uid(),projectId,title,content:'',wordCount:0,status:'draft',order:nextOrder,versions:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await db.put('chapters',chapter,{projectId});
  flushActiveFormDraft = null;
  await db.del('settings', writeDraftId(projectId)).catch(() => {});
  await runGeneration({
    projectId,
    chapterId:chapter.id,
    chapterTitle:title,
    instructions,
    targetWords,
    requiredEnding,
    scenePlan,
    orchestrationPlan: pendingOrchestrationPlan,
    allowedCast,
    roomCast,
    onscreenCast,
    forbiddenCast,
    documentIds,
    reactionMode,
    generationIntent,
    generationMode,
  });
}

async function runGeneration(options){
  if(isRunning)return toast('Ya hay una generación en curso.',{error:true});
  const targetProjectId = options.projectId || db.getActiveProjectId();
  isRunning=true;
  pauseRequested=false;
  activeAbortController = new AbortController();
  const root=document.getElementById('view-write');
  root?.querySelectorAll('.writer-action').forEach((btn)=>btn.setAttribute('disabled','true'));
  root?.querySelector('#w-next-btn')?.setAttribute('disabled','true');
  root?.querySelector('#w-generate-btn')?.setAttribute('disabled','true');
  try{
    const result = options.generationMode === 'novel_orchestrated'
      ? await runOrchestratedGeneration({
          ...options,
          projectId: targetProjectId,
          signal: activeAbortController.signal,
          shouldPause: () => pauseRequested,
          onProgress: ({ state }) => { if (db.getActiveProjectId() === targetProjectId) { renderBanner(state); showPaper(state); } },
        })
      : await startOrResumeGeneration({
          ...options,
          projectId: targetProjectId,
          signal: activeAbortController.signal,
          onProgress: ({ state }) => { if (db.getActiveProjectId() === targetProjectId) { renderBanner(state); showPaper(state); } },
        });
    if(result.status==='awaiting_review'){
      if(result.pendingWarnings?.length) toast('⚠️ Borrador guardado en cuarentena para revisión (no se perdió texto). Revisa las advertencias antes de aprobar.',{ms:8500});
      else toast((result.generationMode==='full_chapter' ? 'Capítulo completo listo' : (result.generationMode==='novel_orchestrated' ? 'Novel Mode completado (borrador)' : 'Bloque listo'))+': léelo y apruébalo antes de continuar.',{ms:6500});
    }
    else if(result.status?.startsWith('paused_'))toast(result.lastError?.message || 'Generación pausada.',{error:result.lastError?.type!=='aborted',ms:8000});
  }catch(err){toast('No se pudo generar: '+err.message,{error:true,ms:10000});}
  finally{isRunning=false;pauseRequested=false;activeAbortController=null;if(root && root.isConnected) await renderWrite(root);}
}


