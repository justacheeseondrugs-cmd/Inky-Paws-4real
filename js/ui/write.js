import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, bus, copyTextToClipboard } from '../utils.js';
import { getActiveGenerationState, startOrResumeGeneration, discardGeneration, approvePendingBlock, rejectPendingBlock, finishReviewedChapter, extendPendingBlockWithEnding, polishPendingBlock } from '../generation.js?v=20261003-room-cast-canon-v1';
import { generateContinuityMemory } from '../memoryEngine.js?v=20260928-long-memory-v1';
import { isMainTimelineChapter } from '../timeline.js?v=20260928-chapter-variants-v1';
import { buildModelTestPack } from '../modelTestPack.js?v=20261003-room-cast-canon-v1';
import { FEEDBACK_OPTIONS, recordAuthorFeedback, recordEditSignal } from '../authorBrain.js?v=20260928-ownership-guard-v1';
import { getAutomaticReactionRoomCast, combineCast, formatCast } from '../storyCast.js?v=20261003-room-cast-v2';

let isRunning = false;
const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const docTypeLabel = { CANON:'Canon', CHARACTER:'Personajes', CONTINUITY:'Continuidad', STYLE_ONLY:'Solo estilo', REFERENCE:'Referencia' };

export async function renderWrite(root) {
  const [settings, active, documents, plannerDraft] = await Promise.all([
    db.get('settings','main'), getActiveGenerationState(), db.getAll('documents'),
    db.get('settings','planner-draft:' + db.getActiveProjectId())
  ]);
  const hasKey = !!settings?.apiKeys?.[settings.provider];
  const defaultGenerationMode = settings?.defaultGenerationMode || 'full_chapter';
  const docs = documents.filter((d) => d.active !== false).sort((a,b) => (b.priority || 0)-(a.priority || 0));
  const docsHtml = docs.map((d) => '<label class="doc-choice"><input type="checkbox" class="w-doc" value="'+escapeHtml(d.id)+'" '+(['CANON','CHARACTER','CONTINUITY'].includes(d.type) ? 'checked' : '')+'> '+escapeHtml(d.filename)+' <span class="muted">('+escapeHtml(docTypeLabel[d.type] || d.type)+')</span></label>').join('');
  const automaticRoomCast=getAutomaticReactionRoomCast(db.getActiveProjectId(),true);
  const roomCastHtml=automaticRoomCast.length
    ? '<div class="auto-cast-box"><div class="auto-cast-title">👀 Sala de reacciones · automático</div><div class="auto-cast-pills">'+automaticRoomCast.map((name)=>'<span class="pill pill-character">'+escapeHtml(name)+'</span>').join('')+'</div><p class="scene-guide">Los 13 espectadores se incluyen automáticamente. No tienes que volver a escribirlos 🥳</p></div>'
    : '<label class="field-label" for="w-room-cast">👀 Personajes presentes en la sala / escena principal</label><textarea id="w-room-cast" rows="3" placeholder="Personajes físicamente presentes en la escena principal"></textarea>';
  root.innerHTML = [
    '<h2 class="section-title">Escribir</h2>',
    '<p class="section-hint">Planifica el capítulo y aprueba cada bloque antes de que la IA continúe. Los bloques descartados NO pasan al capítulo.</p>',
    !hasKey ? '<div class="key-warning">Configura una clave API en Ajustes antes de escribir.</div>' : '',
    '<div id="gen-banner-slot"></div>',
    '<div class="card" id="write-form-card"><h3>Nuevo capítulo</h3>',
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
    '<label class="field-label"><input id="w-reactions" type="checkbox" checked> Sala de reacciones: caos natural + la pantalla NO espera a que terminen de reaccionar</label>',
    '<label class="field-label">📚 Documentos autorizados para ESTE capítulo</label>',
    '<p class="scene-guide">Los no marcados quedan fuera. Un documento de «Solo estilo» aporta sus notas de estilo, nunca texto ni personajes originales.</p>',
    '<div id="w-reference-list">'+(docsHtml || '<p class="muted">Sin documentos activos en esta historia. Súbelos en Documentos si los necesitas.</p>')+'</div>',
    '<div class="grid-2"><div><label class="field-label" for="w-words">Extensión orientativa</label><select id="w-words"><option value="3000">3.000 palabras</option><option value="5000" selected>5.000 palabras</option><option value="7000">7.000 palabras</option></select></div>',
    '<div><label class="field-label" for="w-generation-mode">Modo de escritura</label><select id="w-generation-mode"><option value="full_chapter" '+(defaultGenerationMode === 'full_chapter' ? 'selected' : '')+'>📖 Capítulo completo · una sola llamada</option><option value="blocks" '+(defaultGenerationMode === 'blocks' ? 'selected' : '')+'>🧩 Por bloques · revisar paso a paso</option></select></div></div>',
    '<p class="scene-guide" id="w-mode-help">'+(defaultGenerationMode === 'full_chapter' ? 'Capítulo completo pide toda la extensión seleccionada en una sola respuesta y luego te deja revisarla antes de guardarla.' : 'Por bloques usa el tamaño configurado en Ajustes y te deja aprobar cada tramo antes de continuar.')+'</p>',
    '<div class="writer-action-bar writer-action-bar-start"><button class="btn btn-primary writer-action" id="w-generate-btn" '+(!hasKey || active ? 'disabled' : '')+'>▶ Escribir</button><button class="btn btn-ghost btn-ending writer-action" id="w-generate-ending-btn" '+(!hasKey || active ? 'disabled' : '')+'>✨ Add an ending</button><button class="btn btn-ghost" id="w-context-inspector-btn">👀 Ver contexto</button><button class="btn btn-ghost" id="w-export-test-pack-btn">🧪 Exportar pack</button></div><p class="scene-guide">«Ver contexto» muestra qué sabe Inky antes de escribir y NO usa API ni créditos. «Exportar pack» descarga ese contexto en Markdown.</p></div>',
    '<div id="w-context-inspector-slot"></div>',
    '<div class="card paper" id="w-paper-card" style="display:none"><div class="paper-title" id="w-paper-title"></div><div class="muted" id="w-paper-meta"></div><div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" id="w-copy-chapter-btn">📋 Copiar capítulo</button></div><hr><div class="paper-readonly manuscript-rendered" id="w-paper-text"></div></div>'
  ].join('');
  // An explicitly chosen brainstorm suggestion is only a draft: the author
  // still reviews it and fills title, cast, scene plan and ending before writing.
  if (plannerDraft?.text && !active) {
    root.querySelector('#w-instructions').value = plannerDraft.text;
    await db.del('settings',plannerDraft.id);
    toast('Idea de planificación lista para revisar en las instrucciones.');
  }
  document.getElementById('w-generation-mode')?.addEventListener('change',(e)=>{ const help=document.getElementById('w-mode-help'); if(help) help.textContent=e.target.value==='full_chapter' ? 'Capítulo completo pide toda la extensión seleccionada en una sola respuesta y luego te deja revisarla antes de guardarla.' : 'Por bloques usa el tamaño configurado en Ajustes y te deja aprobar cada tramo antes de continuar.'; });
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
  const pct=Math.min(100,Math.round((state.wordsSoFar || 0)/Math.max(1,state.targetWords)*100));
  const planOptions=(state.scenePlan || []).map((beat,i)=>'<option value="'+i+'" '+(i===(state.sceneIndex || 0)?'selected':'')+'>'+(i+1)+'. '+escapeHtml(beat)+'</option>').join('');
  slot.innerHTML=[
    '<div class="banner"><div style="flex:1;min-width:200px"><b>'+escapeHtml(state.chapterTitle)+'</b> · '+(labels[state.status] || escapeHtml(state.status)),
    '<div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>',
    '<div class="muted">'+state.wordsSoFar+' / '+state.targetWords+' palabras aceptadas · '+state.blocksDone+' '+((state.generationMode || 'blocks')==='full_chapter' ? 'respuesta(s) larga(s)' : 'bloque(s)')+'</div>',
    state.lastError ? '<p class="muted">'+escapeHtml(state.lastError.message)+'</p>':'','</div></div>',
    waiting ? '<div class="generation-review"><h3>✏️ Lee, corrige y aprueba este bloque</h3><p class="scene-guide">Este texto todavía NO es parte del capítulo. Si algo no te gusta, edítalo o descártalo antes de continuar.</p><textarea id="w-review-text" rows="12">'+escapeHtml(state.pendingText || '')+'</textarea><p class="scene-guide"><b>🐈‍⬛ Enséñale tu gusto a Inky:</b> marca lo que falló; se guarda localmente y pesa en futuros capítulos.</p><div class="btn-row" id="w-feedback-row">'+FEEDBACK_OPTIONS.map(([tag,label])=>'<button type="button" class="btn btn-ghost btn-sm w-feedback-tag" data-tag="'+tag+'">'+escapeHtml(label)+'</button>').join('')+'</div><div class="review-actions"><button type="button" class="btn btn-primary" id="w-approve-btn">✓ Aceptar bloque</button><button type="button" class="btn btn-ghost" id="w-copy-block-btn">📋 Copiar bloque</button><button type="button" class="btn btn-ghost" id="w-editor-pass-btn">🐈‍⬛ Editor Pass · 1 llamada</button><button type="button" class="btn btn-ghost btn-ending writer-action" id="w-ending-pending-btn">✨ Add an ending</button><button type="button" class="btn btn-ghost" id="w-reject-btn">Descartar SOLO este bloque</button></div><p class="scene-guide">Editor Pass reescribe el borrador completo conservando eventos y final, pero aprieta ritmo, voz y subtexto. Usa una llamada extra. «Add an ending» sólo añade el cierre.</p></div>' : '',
    showControls ? '<div class="card"><h3>🎬 Siguiente bloque</h3>'+
       (planOptions ? '<label class="field-label" for="w-current-scene">¿Qué escena debe avanzar ahora?</label><select id="w-current-scene">'+planOptions+'</select>':'')+
       '<label class="field-label" for="w-block-notes">Correcciones para el siguiente bloque</label><textarea id="w-block-notes" rows="3" placeholder="No repetir la plaza. Anya YA llegó: continúa con su encuentro con Erwin."></textarea>'+
       '<div class="writer-action-bar"><button type="button" class="btn btn-primary writer-action" id="w-next-btn">▶ Continue</button><button type="button" class="btn btn-ghost writer-action" id="w-keep-going-btn">↪ Keep going</button><button type="button" class="btn btn-ghost btn-ending writer-action" id="w-add-ending-btn">✨ Add an ending</button><button type="button" class="btn btn-ghost writer-action" id="w-surprise-btn">🎲 Surprise me</button></div>'+
       '<div class="btn-row">'+
       (state.wordsSoFar ? '<button type="button" class="btn btn-ghost" id="w-finish-btn">✓ Finalizar capítulo aquí</button>':'')+
       '<button type="button" class="btn btn-danger" id="w-discard-btn">Cerrar generación</button></div>'+
       '<p class="scene-guide">Finaliza solo cuando el desenlace esté completo. Cerrar generación conserva lo aprobado como borrador.</p></div>':''
  ].join('');
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
  document.getElementById('w-editor-pass-btn')?.addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    const review=document.getElementById('w-review-text');
    if(!review?.value.trim())return toast('No hay borrador para editar.',{error:true});
    btn.disabled=true;
    btn.textContent='🐈‍⬛ Editando…';
    try{
      const updated=await polishPendingBlock(state.chapterId,review.value);
      review.value=updated.pendingText || review.value;
      state.pendingText=updated.pendingText || state.pendingText;
      toast('Editor Pass listo. Revisa el nuevo borrador antes de aprobar.',{ms:7500});
    }catch(err){toast(err.message || 'No se pudo hacer el Editor Pass.',{error:true,ms:9000});}
    finally{btn.disabled=false;btn.textContent='🐈‍⬛ Editor Pass · 1 llamada';}
  });
  document.getElementById('w-ending-pending-btn')?.addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    const review=document.getElementById('w-review-text');
    btn.disabled=true;
    btn.textContent='✨ Adding ending…';
    try{
      const updated=await extendPendingBlockWithEnding(state.chapterId,review?.value || state.pendingText || '');
      if(review) review.value=updated.pendingText || '';
      toast('Final añadido al bloque. Revísalo antes de aprobar.',{ms:6000});
    }catch(err){toast(err.message || 'No se pudo añadir el final.',{error:true,ms:8500});}
    finally{btn.disabled=false;btn.textContent='✨ Add an ending';}
  });
  document.getElementById('w-approve-btn')?.addEventListener('click',async(e)=>{
    e.currentTarget.disabled=true;
    try{
      const edited=document.getElementById('w-review-text').value;
      const original=state.pendingText || '';
      await approvePendingBlock(state.chapterId,edited);
      try{await recordEditSignal(original,edited);}catch{}
      toast('Bloque aprobado y guardado.');await renderWrite(document.getElementById('view-write'));
    }catch(err){toast(err.message,{error:true,ms:6500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-reject-btn')?.addEventListener('click',async()=>{
    if(!confirm('¿Descartar SOLO este bloque? Los anteriores se conservan.'))return;
    await rejectPendingBlock(state.chapterId);
    toast('Bloque descartado. Puedes indicar cómo reescribirlo.');await renderWrite(document.getElementById('view-write'));
  });
  const runIntent=(buttonId,generationIntent)=>{
    document.getElementById(buttonId)?.addEventListener('click',async(e)=>{
      e.currentTarget.disabled=true;
      await runGeneration({
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
    if(!confirm('¿Ya se escribió el desenlace? Se finalizará con los bloques que aceptaste.'))return;
    e.currentTarget.disabled=true;
    try{
      await finishReviewedChapter(state.chapterId);
      await renderWrite(document.getElementById('view-write'));
      toast('Capítulo terminado. Generando memoria de continuidad…');
      const chapter=await db.get('chapters',state.chapterId);
      if(chapter){
        const memory=await generateContinuityMemory(chapter);
        if(memory.ok)toast('Memoria de continuidad guardada.');
        else toast('Capítulo guardado; falló la memoria: '+memory.error,{error:true,ms:8500});
      }
      bus.emit('chapters-changed');
    }catch(err){toast(err.message,{error:true,ms:8500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-discard-btn')?.addEventListener('click',async()=>{
    if(!confirm('¿Cerrar generación? Se conservará en Capítulos el texto ya aprobado como borrador.'))return;
    await discardGeneration(state.chapterId);
    toast('Generación cerrada. Tu texto aprobado sigue guardado.');await renderWrite(document.getElementById('view-write'));
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

function readCastFromForm(){
  const reactionMode=!!document.getElementById('w-reactions')?.checked;
  const automaticRoom=getAutomaticReactionRoomCast(db.getActiveProjectId(),reactionMode);
  const manualRoom=document.getElementById('w-room-cast')?.value.trim() || '';
  const roomCast=automaticRoom.length ? formatCast(automaticRoom) : (reactionMode ? manualRoom : '');
  const onscreenCast=document.getElementById('w-onscreen-cast')?.value.trim() || '';
  const allowedCast=formatCast(combineCast(roomCast,onscreenCast));
  return {reactionMode,roomCast,onscreenCast,allowedCast};
}

async function showContextInspectorFromForm(){
  const title=document.getElementById('w-title')?.value.trim() || '';
  const instructions=document.getElementById('w-instructions')?.value.trim() || '';
  const targetWords=Number(document.getElementById('w-words')?.value || 5000);
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
    const ctx=pack.inspector || {};
    const chars=(ctx.characters || []).map((item)=>escapeHtml(item.name)).join(', ') || 'Ninguno';
    const memoryReason={
      'historial completo':'historial corto · se conserva',
      'fundacional':'ancla fundacional',
      'fundacional + reciente':'fundacional + reciente',
      'reciente':'memoria reciente',
      'relevante':'relevante para esta escena',
      'cobertura temporal':'cobertura de continuidad'
    };
    const memories=(ctx.memories || []).map((item)=>{
      const score=Number(item.score || 0);
      const relevance=score>0 ? ' · relevancia '+score.toFixed(2) : '';
      return '<li><b>'+escapeHtml(item.chapterTitle)+'</b> <span class="muted">· '+escapeHtml(memoryReason[item.reason] || item.reason || 'seleccionada')+escapeHtml(relevance)+'</span></li>';
    }).join('') || '<li>Ninguna</li>';
    const docs=(ctx.documents || []).map((item)=>'<li><b>'+escapeHtml(item.filename)+'</b> <span class="muted">('+escapeHtml(item.type)+')</span></li>').join('') || '<li>Ninguno</li>';
    const chunks=(ctx.retrievedChunks || []).map((item)=>{
      const raw=String(item.text || '');
      const snippet=raw.length>750 ? raw.slice(0,749).trimEnd()+'…' : raw;
      const score=item.score===null || item.score===undefined ? '' : ' · relevancia '+Number(item.score).toFixed(2);
      return '<div class="context-snippet"><b>'+escapeHtml(item.filename)+'</b><span class="muted">'+escapeHtml(score)+'</span><div>'+escapeHtml(snippet)+'</div></div>';
    }).join('') || '<p class="muted">No se recuperó ningún fragmento.</p>';
    const excerpts=(ctx.storyExcerpts || []).map((item)=>{
      const raw=String(item.text || '');
      const snippet=raw.length>650 ? raw.slice(0,649).trimEnd()+'…' : raw;
      const score=item.score===null || item.score===undefined ? '' : ' · relevancia '+Number(item.score).toFixed(2);
      return '<div class="context-snippet"><b>'+escapeHtml(item.chapterTitle)+'</b><span class="muted">'+escapeHtml(score)+'</span><div>'+escapeHtml(snippet)+'</div></div>';
    }).join('') || '<p class="muted">No se recuperaron extractos directos de capítulos anteriores.</p>';
    const locked=(ctx.lockedFacts || []).map((text)=>'<li>'+escapeHtml(text)+'</li>').join('') || '<li>Ninguno</li>';
    const canonScores=new Map((ctx.canonRanking || []).map((item)=>[String(item.text || ''),Number(item.score || 0)]));
    const renderCanonList=(items,mode)=>(items || []).map((text)=>{
      const score=canonScores.get(String(text || '')) || 0;
      const why=mode==='private'
        ? (score>0 ? ' · verdad privada · relevancia '+score.toFixed(2) : ' · verdad privada')
        : (score>0 ? ' · revelado · relevancia '+score.toFixed(2) : ' · revelado');
      return '<li>'+escapeHtml(text)+' <span class="muted">'+escapeHtml(why)+'</span></li>';
    }).join('') || '<li>Ninguno</li>';
    const revealedCanon=renderCanonList(ctx.revealedCanonNotes,'revealed');
    const privateCanon=renderCanonList(ctx.privateCanonNotes,'private');
    const previous=ctx.previousEnding
      ? '<pre class="context-prompt">'+escapeHtml(ctx.previousEnding)+'</pre>'
      : '<p class="muted">No hay un final anterior disponible.</p>';
    const preflight=ctx.preflight || {issues:[],criticalCount:0,warningCount:0,infoCount:0,ok:true};
    const issueIcon={critical:'🚨',warning:'⚠️',info:'ℹ️'};
    const issueLabel={critical:'Conflicto',warning:'Advertencia',info:'Info'};
    const preflightHtml=(preflight.issues || []).length
      ? (preflight.issues || []).map((item)=>{
          const evidence=Array.isArray(item.evidence)
            ? item.evidence.map((x)=>'<li>'+escapeHtml(String(x))+'</li>').join('')
            : (item.evidence ? '<div class="context-evidence">'+escapeHtml(String(item.evidence))+'</div>' : '');
          return '<div class="context-guard-item context-guard-'+escapeHtml(item.level || 'info')+'"><div><b>'+escapeHtml(issueIcon[item.level] || 'ℹ️')+' '+escapeHtml(item.title || issueLabel[item.level] || 'Revisión')+'</b><div>'+escapeHtml(item.message || '')+'</div>'+(item.suggestion?'<div class="muted"><b>Sugerencia:</b> '+escapeHtml(item.suggestion)+'</div>':'')+(evidence?'<details><summary>Ver evidencia</summary>'+(Array.isArray(item.evidence)?'<ul>'+evidence+'</ul>':evidence)+'</details>':'')+'</div></div>';
        }).join('')
      : '<div class="context-guard-ok">✅ Context Guard no encontró conflictos estructurales críticos.</div>';

    slot.innerHTML=[
      '<div class="card context-inspector" id="w-context-inspector">',
      '<div class="card-row context-inspector-head"><div><h3>👀 Context Inspector</h3><div class="muted">Vista previa local. No llama a la IA ni gasta créditos.</div></div><button type="button" class="btn btn-ghost btn-sm" id="w-context-close">Cerrar</button></div>',
      '<div class="context-summary">',
      '<span class="pill '+(preflight.criticalCount?'pill-canon':'pill-active')+'">🛡️ '+(preflight.criticalCount?preflight.criticalCount+' conflicto(s)':'Preflight OK')+'</span>',
      '<span class="pill pill-character">'+(ctx.characters?.length || 0)+' personajes</span>',
      '<span class="pill pill-continuity">'+(ctx.memories?.length || 0)+'/'+(ctx.memoryTotal ?? ctx.memories?.length ?? 0)+' memorias</span>',
      '<span class="pill pill-canon">'+((ctx.lockedFacts?.length || 0)+(ctx.canonNotes?.length || 0))+' hechos/canon</span>',
      '<span class="pill pill-reference">'+(ctx.retrievedChunks?.length || 0)+' fragmentos</span>',
      '<span class="pill pill-style">≈ '+(ctx.approxInputTokens || 0).toLocaleString('es-CL')+' tokens de entrada</span>',
      '</div>',
      '<details open><summary>🛡️ Context Guard · revisión antes de generar</summary><div class="context-details-body">'+preflightHtml+'</div></details>',
      '<p class="context-lead"><b>👀 Sala de reacciones:</b> '+escapeHtml(ctx.roomCast || '(sin reparto automático)')+'</p>',
      '<p class="context-lead"><b>🎬 Onscreen:</b> '+escapeHtml(ctx.onscreenCast || '(ninguno anotado)')+'</p>',
      '<p class="context-lead"><b>Personajes cargados:</b> '+chars+'</p>',
      '<p class="muted">🐾 Smart Context v1 seleccionó '+(ctx.memories?.length || 0)+' de '+(ctx.memoryTotal ?? ctx.memories?.length ?? 0)+' memorias de continuidad'+((ctx.memoryOmitted || 0) ? ' y dejó '+ctx.memoryOmitted+' fuera por menor prioridad.' : '. Todo el historial cabe sin recorte.')+' El canon revelado y privado se mantienen separados en el prompt.</p>',
      '<p class="muted">Proveedor/modelo configurado: '+escapeHtml(ctx.sourceProvider || 'unknown')+' · '+escapeHtml(ctx.sourceModel || '')+'</p>',
      '<details open><summary>📚 Fragmentos recuperados de documentos ('+(ctx.retrievedChunks?.length || 0)+')</summary><div class="context-details-body">'+chunks+'</div></details>',
      '<details><summary>🔎 Recuerdo directo de capítulos ('+(ctx.storyExcerpts?.length || 0)+')</summary><div class="context-details-body">'+excerpts+'</div></details>',
      '<details><summary>🧠 Memorias seleccionadas ('+(ctx.memories?.length || 0)+' de '+(ctx.memoryTotal ?? ctx.memories?.length ?? 0)+')</summary><div class="context-details-body"><ul>'+memories+'</ul></div></details>',
      '<details><summary>🔒 Hechos bloqueados ('+(ctx.lockedFacts?.length || 0)+')</summary><div class="context-details-body"><ul>'+locked+'</ul></div></details>',
      '<details><summary>📖 Canon revelado ('+(ctx.revealedCanonNotes?.length || 0)+')</summary><div class="context-details-body"><ul>'+revealedCanon+'</ul></div></details>',
      '<details><summary>🕵️ Canon privado del autor ('+(ctx.privateCanonNotes?.length || 0)+')</summary><div class="context-details-body"><ul>'+privateCanon+'</ul></div></details>',
      '<details><summary>📄 Documentos autorizados ('+(ctx.documents?.length || 0)+')</summary><div class="context-details-body"><ul>'+docs+'</ul></div></details>',
      '<details><summary>📖 Final del capítulo anterior</summary><div class="context-details-body">'+previous+'</div></details>',
      '<details><summary>🧾 Prompt completo</summary><div class="context-details-body"><div class="muted">System prompt</div><pre class="context-prompt">'+escapeHtml(ctx.systemPrompt || '')+'</pre><div class="muted">User prompt</div><pre class="context-prompt">'+escapeHtml(ctx.userPrompt || '')+'</pre></div></details>',
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
  const targetWords=Number(document.getElementById('w-words')?.value || 5000);
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
    if(btn){btn.disabled=false;btn.textContent='🧪 Exportar pack para otro modelo';}
  }
}

async function onGenerateClick(generationIntent='continue'){
  const title=document.getElementById('w-title').value.trim();
  const instructions=document.getElementById('w-instructions').value.trim();
  const targetWords=Number(document.getElementById('w-words').value);
  const generationMode=document.getElementById('w-generation-mode')?.value || 'full_chapter';
  const requiredEnding=document.getElementById('w-ending').value.trim();
  const scenePlan=lines(document.getElementById('w-scenes').value);
  const {reactionMode,roomCast,onscreenCast,allowedCast}=readCastFromForm();
  const forbiddenCast=document.getElementById('w-forbidden').value.trim();
  const documentIds=Array.from(document.querySelectorAll('.w-doc:checked')).map((el)=>el.value);
  if(!title || !instructions)return toast('Escribe título e instrucciones.',{error:true});
  if(!allowedCast)return toast('Indica el reparto autorizado del capítulo.',{error:true,ms:6500});
  if(await getActiveGenerationState())return toast('Termina o cierra el capítulo pendiente.',{error:true});

  // Preflight is fully local: catch structural conflicts before spending API credits.
  try{
    const preflightPack=await buildModelTestPack({
      chapterTitle:title,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      allowedCast,
      forbiddenCast,
      documentIds,
      reactionMode,
      generationMode,
    });
    const preflight=preflightPack.inspector?.preflight;
    const blockers=(preflight?.issues || []).filter((item)=>item.level==='critical');
    if(blockers.length){
      const summary=blockers.map((item)=>'• '+item.title+': '+item.message).join('\n\n');
      const proceed=confirm('🛡️ Context Guard encontró '+blockers.length+' conflicto(s) antes de generar:\n\n'+summary+'\n\nAceptar = generar igualmente.\nCancelar = volver y corregir.');
      if(!proceed){
        toast('Generación cancelada para que corrijas el contexto. Usa 👀 Ver contexto para revisar la evidencia.',{error:true,ms:8500});
        return;
      }
    }
  }catch(err){
    console.warn('Context Guard preflight failed:',err);
  }

  const chapters=await db.getAll('chapters');
  const mainChapters=chapters.filter(isMainTimelineChapter);
  const nextOrder=mainChapters.length ? Math.max(...mainChapters.map((chapter)=>chapter.order ?? 0)) + 1 : 0;
  const chapter={id:db.uid(),title,content:'',wordCount:0,status:'draft',order:nextOrder,versions:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await db.put('chapters',chapter);
  await runGeneration({chapterId:chapter.id,chapterTitle:title,instructions,targetWords,requiredEnding,scenePlan,allowedCast,roomCast,onscreenCast,forbiddenCast,documentIds,reactionMode,generationIntent,generationMode});
}

async function runGeneration(options){
  if(isRunning)return toast('Ya hay una generación en curso.',{error:true});
  isRunning=true;
  const root=document.getElementById('view-write');
  root?.querySelectorAll('.writer-action').forEach((btn)=>btn.setAttribute('disabled','true'));
  root?.querySelector('#w-next-btn')?.setAttribute('disabled','true');
  root?.querySelector('#w-generate-btn')?.setAttribute('disabled','true');
  try{
    const result=await startOrResumeGeneration({...options,onProgress:({state})=>{renderBanner(state);showPaper(state);}});
    if(result.status==='awaiting_review')toast((result.generationMode==='full_chapter' ? 'Capítulo completo listo' : 'Bloque listo')+': léelo y apruébalo antes de continuar.',{ms:6500});
    else if(result.status?.startsWith('paused_'))toast(result.lastError?.message || 'Generación pausada.',{error:true,ms:8000});
  }catch(err){toast('No se pudo generar: '+err.message,{error:true,ms:10000});}
  finally{isRunning=false;await renderWrite(root);}
}
