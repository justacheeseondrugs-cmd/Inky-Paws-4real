// ui/memory.js — Panel integral de Memoria (Inky Brain, Hito 3):
// - Buscador local explicable de memoria a largo plazo (BM25 + 6 capas, 0 tokens)
// - Revisión de elementos desactualizados (stale / disputed) tras editar capítulos
// - Libro epistémico (verdad objetiva, secretos, falsas creencias, sala vs pantalla)
// - Continuidad emocional y relacional cualitativa (sin puntuaciones numéricas)
// - Resúmenes de arcos narrativos e hilos abiertos
// - Hechos bloqueados, canon revelado/privado y memoria de continuidad por capítulo

import { db } from '../db.js';
import { escapeHtml, toast, fmtDate, openModal, closeModal, contentFingerprint } from '../utils.js';
import { memoriesForChapters, sortMainTimelineChapters } from '../timeline.js';
import {
  QUALITATIVE_DIMENSIONS,
  listKnowledgeFacts,
  saveKnowledgeFact,
  deleteKnowledgeFact,
  updateCharacterBelief,
  listRelationshipStates,
  saveRelationshipState,
  deleteRelationshipState,
} from '../knowledgeLedger.js';
import {
  syncPersistedChapterIndex,
  syncPersistedDocumentIndex,
} from '../lexicalIndex.js';
import {
  listArcSummaries,
  saveArcSummary,
  deleteArcSummary,
  compressArcWindow,
  assembleHierarchicalMemory,
} from '../hierarchicalMemory.js';
import { getStoryConfig } from '../storyConfigSchema.js';
import { normalizeRoomGuestInvitations } from '../universeResolver.js';

const STATE_LABELS = {
  knows: 'Sabe',
  suspects: 'Sospecha',
  believes_false: 'Cree algo falso',
  disputed: 'En disputa',
  unknown: 'Desconoce',
};

const SCOPE_LABELS = {
  world_fact: 'Hecho del mundo',
  private_author: 'Privado del autor',
  revealed_canon: 'Canon revelado',
  room_event: 'Evento en sala',
  screen_event: 'Evento en pantalla',
  outside_event: 'Escena exterior',
  flashback_event: 'Flashback / recuerdo',
};

const DIMENSION_LABELS = {
  trust: 'Confianza',
  affection: 'Afecto',
  romanticTension: 'Tensión romántica',
  resentment: 'Resentimiento',
  grief: 'Duelo',
  embarrassment: 'Vergüenza / incomodidad',
  loyalty: 'Lealtad',
  fear: 'Miedo / cautela',
};

const LAYER_LABELS = {
  A_immediate_scene: 'Capa A · Escena inmediata',
  B_recent_continuity: 'Capa B · Capítulos recientes',
  C_historical_episodic: 'Capa C · Memoria histórica / BM25',
  D_character_epistemic_and_relationships: 'Capa D · Conocimiento y relaciones',
  E_arc_summaries: 'Capa E · Arcos narrativos',
  F_permanent_canon: 'Capa F · Canon permanente e hilos',
};

function linesToArray(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function csvToArray(text) {
  return String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

export async function renderMemory(root) {
  const projectId = db.getActiveProjectId();
  const [
    lockedFacts,
    canonNotes,
    allMemoryEntries,
    chapters,
    knowledgeFacts,
    relationships,
    arcSummaries,
    documents,
    docChunks,
    storyConfig,
  ] = await Promise.all([
    db.getAll('lockedFacts'),
    db.getAll('canonNotes'),
    db.getAll('memoryEntries'),
    db.getAll('chapters'),
    listKnowledgeFacts({ projectId }),
    listRelationshipStates({ projectId }),
    listArcSummaries({ projectId }),
    db.getAll('documents'),
    db.getAll('docChunks'),
    getStoryConfig(projectId),
  ]);

  const mainChapters = sortMainTimelineChapters(chapters);
  const memoryEntries = memoriesForChapters(allMemoryEntries, mainChapters).reverse();
  const staleMemories = memoryEntries.filter((m) => m.stale === true);
  const staleFacts = knowledgeFacts.filter((f) => f.stale === true || f.disputed === true);
  const staleRels = relationships.filter((r) => r.stale === true);
  const staleArcs = arcSummaries.filter((a) => a.stale === true);
  const totalStale = staleMemories.length + staleFacts.length + staleRels.length + staleArcs.length;

  root.innerHTML = `
    <div class="card-row" style="align-items:flex-start; margin-bottom:6px;">
      <div>
        <h2 class="section-title" style="margin-bottom:4px;">Memoria · Inky Brain</h2>
        <p class="section-hint" style="margin-bottom:0;">Memoria jerárquica de largo plazo, conocimiento individual por personaje, falsas creencias, continuidad relacional cualitativa y búsqueda explicable (0 tokens).</p>
      </div>
      <span class="pill pill-reference" id="memory-integration-status" title="Hechos bloqueados, canon y memorias no-stale ya alimentan generación; el libro epistémico, relaciones cualitativas, arcos y BM25 se conectarán al Context Engine unificado en el Hito 5.">🧠 Hito 3 activo · motor unificado en Hito 5</span>
    </div>

    ${totalStale ? `
    <div class="card" id="memory-stale-review-card" style="border-left:4px solid var(--oldrose-600);">
      <h3>⚠️ Elementos desactualizados pendientes de revisión (${totalStale})</h3>
      <p class="muted">Estos registros provienen de capítulos editados o reescritos. Quedan excluidos del canon autoritativo actual pero se conservan íntegros hasta que decidas actualizarlos o marcarlos como revisados (0 llamadas de pago).</p>
      <div class="chip-row" style="margin-bottom:8px;">
        ${staleMemories.length ? `<span class="pill pill-inactive">${staleMemories.length} memoria(s) de capítulo</span>` : ''}
        ${staleFacts.length ? `<span class="pill pill-inactive">${staleFacts.length} hecho(s) epistémico(s)</span>` : ''}
        ${staleRels.length ? `<span class="pill pill-inactive">${staleRels.length} relación(es)</span>` : ''}
        ${staleArcs.length ? `<span class="pill pill-inactive">${staleArcs.length} arco(s)</span>` : ''}
      </div>
      <div id="stale-review-list"></div>
    </div>` : ''}

    <div class="card" id="memory-search-card">
      <div class="card-row">
        <div>
          <h3>🔍 Buscador explicable de memoria (0 tokens)</h3>
          <p class="muted">Consulta el índice léxico BM25 local y las 6 capas jerárquicas para ver qué recuperaría Inky y exactamente por qué.</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="mem-reindex-btn">🔄 Sincronizar índice BM25</button>
      </div>
      <div class="grid-3" style="gap:8px; margin-top:6px;">
        <div>
          <label class="field-label" for="mem-search-query">Consulta o tema (p.ej. «promesa capítulo 7»)</label>
          <input type="text" id="mem-search-query" placeholder="Ej: promesa de Levi en el capítulo 7, secreto Eruri...">
        </div>
        <div>
          <label class="field-label" for="mem-search-chapter">Hasta capítulo n.º (opcional)</label>
          <input type="number" min="1" id="mem-search-chapter" placeholder="Ej: 100 (vacío = final)">
        </div>
        <div>
          <label class="field-label" for="mem-search-version">Versión espacial del personaje</label>
          <select id="mem-search-version">
            <option value="room" selected>room (sala)</option>
            <option value="screen">screen (pantalla)</option>
            <option value="outside">outside (exterior)</option>
            <option value="flashback">flashback</option>
          </select>
        </div>
      </div>
      <div class="btn-row" style="margin-top:8px;">
        <button type="button" class="btn btn-primary btn-sm" id="mem-search-btn">🔎 Buscar y explicar recuperación (0 tokens)</button>
      </div>
      <div id="mem-search-results" style="margin-top:10px;"></div>
    </div>

    <div class="card" id="epistemic-ledger-card">
      <div class="card-row">
        <div>
          <h3>🧠 Libro epistémico: conocimiento, secretos y falsas creencias (${knowledgeFacts.length})</h3>
          <p class="muted">Separa la verdad objetiva del canon de lo que cada personaje sabe, sospecha, desconoce o cree falsamente (con fuente, checkpoint y capa sala/pantalla).</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="kf-add-btn">+ Nuevo hecho epistémico</button>
      </div>
      <div id="epistemic-facts-list"></div>
    </div>

    <div class="card" id="relationship-continuity-card">
      <details ${relationships.length ? 'open' : ''}>
        <summary style="cursor:pointer; font-weight:600;">💞 Continuidad emocional y relacional cualitativa (${relationships.length})</summary>
        <p class="muted" style="margin-top:6px;">Seguimiento narrativo con evidencia (confianza, afecto, tensión, duelo, promesas, desacuerdos y secretos). Nunca usa puntuaciones numéricas simplistas.</p>
        <div class="btn-row" style="margin-bottom:8px;">
          <button type="button" class="btn btn-primary btn-sm" id="rel-add-btn">+ Nuevo estado relacional</button>
        </div>
        <div id="relationships-list"></div>
      </details>
    </div>

    <div class="card" id="arc-summaries-card">
      <details ${arcSummaries.length ? 'open' : ''}>
        <summary style="cursor:pointer; font-weight:600;">🗺️ Resúmenes de arcos narrativos e hilos largos (${arcSummaries.length})</summary>
        <p class="muted" style="margin-top:6px;">Comprime bloques de capítulos conservando secretos, promesas abiertas, cambios relacionales e hilos sin resolver.</p>
        <div class="btn-row" style="margin-bottom:8px;">
          <button type="button" class="btn btn-primary btn-sm" id="arc-add-btn">+ Nuevo resumen de arco</button>
          <button type="button" class="btn btn-ghost btn-sm" id="arc-compress-btn">⚡ Comprimir capítulos en arco (0 tokens)</button>
        </div>
        <div id="arc-summaries-list"></div>
      </details>
    </div>

    <div class="card">
      <h3>🔒 Hechos bloqueados — máxima prioridad</h3>
      <p class="muted">Se reinsertan siempre, aunque otro documento los contradiga.</p>
      <div id="locked-list"></div>
      <label class="field-label">Añadir hecho bloqueado</label>
      <div class="card-row" style="gap:8px;">
        <input type="text" id="locked-new-input" placeholder="Ej: Anya es una niña; su vocabulario y razonamiento deben sonar infantiles.">
        <button class="btn btn-primary btn-sm" id="locked-add-btn">Añadir</button>
      </div>
    </div>

    <div class="card">
      <h3>📖 Canon revelado</h3>
      <p class="muted">Verdades que ya están establecidas/reveladas en la historia. La memoria sigue decidiendo qué sabe cada personaje en concreto.</p>
      <div id="canon-revealed-list"></div>
    </div>

    <div class="card">
      <h3>🕵️ Canon privado del autor</h3>
      <p class="muted">Verdades reales del AU que Inky debe respetar, pero que NO pasan automáticamente al conocimiento de los personajes. Las notas antiguas se tratan como privadas por seguridad.</p>
      <div id="canon-private-list"></div>
      <label class="field-label">Añadir nota de canon</label>
      <textarea id="canon-new-input" placeholder="Pega aquí una verdad del AU, resumen futuro o secreto..."></textarea>
      <div class="grid-2">
        <select id="canon-visibility">
          <option value="private" selected>🕵️ Privado del autor</option>
          <option value="revealed">📖 Revelado / establecido</option>
        </select>
        <button class="btn btn-primary btn-sm" id="canon-add-btn">Añadir</button>
      </div>
    </div>

    <div class="card">
      <h3>🧵 Memoria de continuidad por capítulo</h3>
      <p class="muted">Solo se muestra y usa la memoria de la versión principal de cada capítulo. Si cambias a una alternativa, su memoria pasa a ser la activa cuando la crees desde Capítulos.</p>
      <div id="continuity-list"></div>
    </div>
  `;

  if (totalStale) {
    renderStaleReviewList({ staleMemories, staleFacts, staleRels, staleArcs, root, projectId });
  }
  renderEpistemicFacts(knowledgeFacts, mainChapters, root, projectId);
  renderRelationshipStates(relationships, mainChapters, root, projectId);
  renderArcSummaries(arcSummaries, mainChapters, root, projectId);
  renderLocked(lockedFacts, root);
  renderCanon(canonNotes, root);
  renderContinuity(memoryEntries, root);

  // --- Eventos básicos preservados ---
  document.getElementById('locked-add-btn').addEventListener('click', async () => {
    const input = document.getElementById('locked-new-input');
    const text = input.value.trim();
    if (!text) return;
    await db.put('lockedFacts', { text, isCore: false });
    input.value = '';
    renderMemory(root);
  });

  document.getElementById('canon-add-btn').addEventListener('click', async () => {
    const input = document.getElementById('canon-new-input');
    const text = input.value.trim();
    if (!text) return;
    const visibility = document.getElementById('canon-visibility')?.value === 'revealed' ? 'revealed' : 'private';
    await db.put('canonNotes', { text, visibility, createdAt: new Date().toISOString() });
    input.value = '';
    renderMemory(root);
  });

  // --- Buscador explicable BM25 + 6 capas (0 tokens) ---
  const runExplainableSearch = async () => {
    const resultsEl = document.getElementById('mem-search-results');
    const query = document.getElementById('mem-search-query')?.value.trim() || '';
    const rawTargetOrder = document.getElementById('mem-search-chapter')?.value.trim() || '';
    const targetChapterOrder = rawTargetOrder ? Math.max(1, parseInt(rawTargetOrder, 10)) : null;
    const characterVersion = document.getElementById('mem-search-version')?.value || 'room';

    const [{ index: chIdx }, { index: docIdx }] = await Promise.all([
      syncPersistedChapterIndex({ projectId, chapters }),
      syncPersistedDocumentIndex({ projectId, documents, docChunks }),
    ]);

    const josephInvite = normalizeRoomGuestInvitations(storyConfig?.roomGuestInvitations || [])
      .find((inv) => inv.characterId === 'joseph');

    const assembled = assembleHierarchicalMemory({
      projectId,
      targetChapterOrder,
      currentCheckpoint: storyConfig?.checkpointId || '',
      query,
      characterVersion,
      josephArrivalOrder: josephInvite?.effectiveChapterOrder ?? null,
      chapters,
      memoryEntries: allMemoryEntries,
      knowledgeFacts,
      relationships,
      arcSummaries,
      lockedFacts,
      canonNotes,
      documents,
      docChunks,
      chapterLexicalIndex: chIdx,
      documentLexicalIndex: docIdx,
    });

    const hitsHtml = assembled.layers.C_historical_episodic.historicalPassages.map((hit) => `
      <div class="list-item">
        <div class="title-row">
          <b>📖 ${escapeHtml(hit.chapterTitle)} (Cap. ${escapeHtml(String(hit.chapterOrder))})</b>
          <span class="pill pill-active">BM25: ${escapeHtml(String(hit.bm25Score))}</span>
        </div>
        <div style="font-size:13px; margin:4px 0;">${escapeHtml(hit.excerpt)}</div>
        <div class="muted" style="font-size:12px;"><b>¿Por qué Inky recuperó esto?</b> ${escapeHtml(hit.whyRetrieved)} · rev=${escapeHtml(hit.chapterRevision || 'n/a')}</div>
      </div>`).join('');

    const whyHtml = assembled.explainability.slice(0, 14).map((item) => `
      <div class="list-item" style="padding:8px 10px;">
        <div class="title-row">
          <b>${escapeHtml(LAYER_LABELS[item.layer] || item.layer)} · ${escapeHtml(item.title)}</b>
          ${item.chapterOrder !== null && item.chapterOrder !== undefined ? `<span class="pill pill-reference">Cap. ${escapeHtml(String(item.chapterOrder))}</span>` : ''}
        </div>
        <div class="muted" style="font-size:12px;"><b>Motivo:</b> ${escapeHtml(item.whyRetrieved)}${item.matchedTerms?.length ? ` · términos=[${escapeHtml(item.matchedTerms.join(', '))}]` : ''}</div>
      </div>`).join('');

    resultsEl.innerHTML = `
      <div class="paper" id="mem-explain-panel" style="padding:12px;">
        <div class="chip-row" style="margin-bottom:8px;">
          <span class="pill pill-active">⚡ ${escapeHtml(String(assembled.stats.retrievalMs))} ms (0 tokens)</span>
          <span class="pill pill-reference">${assembled.stats.totalChaptersIndexed} cap. indexados · ${assembled.stats.totalCorpusWords.toLocaleString('es-ES')} palabras</span>
          <span class="pill pill-character">Contexto acotado: ~${assembled.stats.approxTokens.toLocaleString('es-ES')} tokens (${assembled.stats.assembledChars.toLocaleString('es-ES')} chars)</span>
          <span class="pill pill-style">Excluidos: ${assembled.stats.futureExcludedCount} futuros · ${assembled.stats.alternativeExcludedCount} alternativos · ${assembled.stats.staleExcludedCount} stale</span>
        </div>
        ${hitsHtml ? `<div style="margin-bottom:10px;"><b>Pasajes históricos recuperados del manuscrito (BM25):</b>${hitsHtml}</div>` : (query ? '<p class="muted">No hubo pasajes léxicos del manuscrito coincidentes con esa consulta.</p>' : '')}
        <details open>
          <summary style="cursor:pointer; font-weight:600;">🔎 Por qué Inky recuperó cada capa (${assembled.explainability.length} elementos trazados)</summary>
          <div style="margin-top:6px;">${whyHtml || '<p class="muted">Sin elementos registrados todavía en esta historia.</p>'}</div>
        </details>
      </div>`;
  };

  document.getElementById('mem-search-btn')?.addEventListener('click', runExplainableSearch);
  document.getElementById('mem-search-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runExplainableSearch(); }
  });
  document.getElementById('mem-reindex-btn')?.addEventListener('click', async () => {
    const [{ index: chIdx }] = await Promise.all([
      syncPersistedChapterIndex({ projectId, chapters }),
      syncPersistedDocumentIndex({ projectId, documents, docChunks }),
    ]);
    toast(`Índice BM25 sincronizado (${chIdx.totalDocs} pasajes indexados, 0 tokens).`);
  });

  // --- Crear nuevos registros de Milestone 3 ---
  document.getElementById('kf-add-btn')?.addEventListener('click', () => openKnowledgeFactModal(null, mainChapters, root, projectId));
  document.getElementById('rel-add-btn')?.addEventListener('click', () => openRelationshipModal(null, mainChapters, root, projectId));
  document.getElementById('arc-add-btn')?.addEventListener('click', () => openArcSummaryModal(null, root, projectId));
  document.getElementById('arc-compress-btn')?.addEventListener('click', () => {
    openArcCompressModal({ mainChapters, allMemoryEntries, knowledgeFacts, relationships, arcSummaries, root, projectId });
  });
}

function renderStaleReviewList({ staleMemories, staleFacts, staleRels, staleArcs, root, projectId }) {
  const el = document.getElementById('stale-review-list');
  if (!el) return;
  const rows = [];
  for (const m of staleMemories) {
    rows.push(`<div class="list-item"><div class="title-row"><b>🧵 Memoria: ${escapeHtml(m.chapterTitle || 'Capítulo')}</b><span class="pill pill-inactive">${escapeHtml(m.staleReason || 'edited')}</span></div><div class="muted">${escapeHtml(m.events || '(sin eventos)')}</div><div class="btn-row"><button type="button" class="btn btn-ghost btn-sm act-stale-mem" data-id="${escapeHtml(m.id)}">Revisar / editar</button></div></div>`);
  }
  for (const f of staleFacts) {
    rows.push(`<div class="list-item"><div class="title-row"><b>🧠 Hecho epistémico: ${escapeHtml(f.title)}</b><span class="pill pill-inactive">${escapeHtml(f.staleReason || 'disputed')}</span></div><div class="muted">${escapeHtml(f.truth)}</div><div class="btn-row"><button type="button" class="btn btn-primary btn-sm act-stale-fact-ok" data-id="${escapeHtml(f.id)}">✓ Confirmar vigente</button></div></div>`);
  }
  for (const r of staleRels) {
    rows.push(`<div class="list-item"><div class="title-row"><b>💞 Relación: ${escapeHtml(r.label)}</b><span class="pill pill-inactive">${escapeHtml(r.staleReason || 'edited')}</span></div><div class="btn-row"><button type="button" class="btn btn-primary btn-sm act-stale-rel-ok" data-id="${escapeHtml(r.id)}">✓ Confirmar vigente</button></div></div>`);
  }
  for (const a of staleArcs) {
    rows.push(`<div class="list-item"><div class="title-row"><b>🗺️ Arco: ${escapeHtml(a.title)}</b><span class="pill pill-inactive">${escapeHtml(a.staleReason || 'edited')}</span></div><div class="btn-row"><button type="button" class="btn btn-primary btn-sm act-stale-arc-ok" data-id="${escapeHtml(a.id)}">✓ Confirmar vigente</button></div></div>`);
  }
  el.innerHTML = rows.join('');

  el.querySelectorAll('.act-stale-mem').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const m = await db.get('memoryEntries', btn.dataset.id);
      if (m) openMemoryEditModal(m, root);
    });
  });
  el.querySelectorAll('.act-stale-fact-ok').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const f = await db.get('knowledgeFacts', btn.dataset.id, { projectId });
      if (!f) return;
      await saveKnowledgeFact({ ...f, stale: false, disputed: false, staleReason: '', staleAt: null, lastReviewedRevision: f.latestChapterRevision || f.sourceChapterRevision || '' }, { projectId });
      toast('Hecho epistémico confirmado como vigente.');
      renderMemory(root);
    });
  });
  el.querySelectorAll('.act-stale-rel-ok').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = await db.get('relationshipStates', btn.dataset.id, { projectId });
      if (!r) return;
      await saveRelationshipState({ ...r, stale: false, staleReason: '', staleAt: null }, { projectId });
      toast('Estado relacional confirmado como vigente.');
      renderMemory(root);
    });
  });
  el.querySelectorAll('.act-stale-arc-ok').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const a = await db.get('arcSummaries', btn.dataset.id, { projectId });
      if (!a) return;
      await saveArcSummary({ ...a, stale: false, staleReason: '', staleAt: null }, { projectId });
      toast('Resumen de arco confirmado como vigente.');
      renderMemory(root);
    });
  });
}

function renderEpistemicFacts(facts, mainChapters, root, projectId) {
  const el = document.getElementById('epistemic-facts-list');
  if (!el) return;
  if (!facts.length) {
    el.innerHTML = '<p class="muted">Todavía no has registrado hechos epistémicos individuales. Úsalos para rastrear secretos, quién sospecha qué y falsas creencias sin contaminar el canon objetivo.</p>';
    return;
  }
  el.innerHTML = facts.map((f) => {
    const beliefs = Object.entries(f.beliefsByCharacter || {}).map(([key, b]) => `
      <div style="font-size:12px; margin-top:2px;">
        <b>${escapeHtml(key)}</b> → <span class="pill ${b.state === 'knows' ? 'pill-active' : (b.state === 'believes_false' ? 'pill-canon' : 'pill-reference')}">${escapeHtml(STATE_LABELS[b.state] || b.state)}</span>
        ${b.beliefText ? ` «${escapeHtml(b.beliefText)}»` : ''}
        ${b.evidence ? `<span class="muted"> · Evidencia: ${escapeHtml(b.evidence)}</span>` : ''}
        ${b.learnedAtChapterOrder !== null && b.learnedAtChapterOrder !== undefined ? `<span class="muted"> (Cap. ${escapeHtml(String(b.learnedAtChapterOrder))})</span>` : ''}
      </div>`).join('');
    return `
      <div class="list-item" data-fact-id="${escapeHtml(f.id)}">
        <div class="title-row">
          <b>${escapeHtml(f.title)}</b>
          <div class="chip-row">
            <span class="pill pill-reference">${escapeHtml(SCOPE_LABELS[f.scope] || f.scope)} · capa=${escapeHtml(f.layer)}</span>
            ${f.firstEffectiveChapterOrder !== null && f.firstEffectiveChapterOrder !== undefined ? `<span class="pill pill-character">Desde Cap. ${escapeHtml(String(f.firstEffectiveChapterOrder))}</span>` : ''}
            ${f.isSecret ? '<span class="pill pill-canon">🔒 Secreto</span>' : ''}
            ${f.stale || f.disputed ? '<span class="pill pill-inactive">⚠️ Desactualizado / en disputa</span>' : ''}
          </div>
        </div>
        <div style="margin:4px 0;"><b>Verdad objetiva:</b> ${escapeHtml(f.truth)}</div>
        ${f.sourceRef ? `<div class="muted" style="font-size:12px;">Fuente: ${escapeHtml(f.sourceRef)}</div>` : ''}
        ${f.disclosureConstraints?.length ? `<div class="muted" style="font-size:12px;">Restricciones de divulgación: ${escapeHtml(f.disclosureConstraints.join(' · '))}</div>` : ''}
        ${beliefs ? `<div style="margin-top:6px; padding-left:8px; border-left:2px solid var(--rose-200);">${beliefs}</div>` : '<div class="muted" style="font-size:12px;">Sin creencias individuales registradas aún.</div>'}
        <div class="btn-row" style="margin-top:6px;">
          <button type="button" class="btn btn-ghost btn-sm act-kf-belief">+ Creencia de personaje</button>
          <button type="button" class="btn btn-ghost btn-sm act-kf-edit">Editar</button>
          <button type="button" class="btn btn-danger btn-sm act-kf-del">Eliminar</button>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.list-item').forEach((item) => {
    const id = item.dataset.factId;
    item.querySelector('.act-kf-belief')?.addEventListener('click', async () => {
      const f = await db.get('knowledgeFacts', id, { projectId });
      if (f) openCharacterBeliefModal(f, root, projectId);
    });
    item.querySelector('.act-kf-edit')?.addEventListener('click', async () => {
      const f = await db.get('knowledgeFacts', id, { projectId });
      if (f) openKnowledgeFactModal(f, mainChapters, root, projectId);
    });
    item.querySelector('.act-kf-del')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este hecho epistémico?')) return;
      await deleteKnowledgeFact(id, { projectId });
      renderMemory(root);
    });
  });
}

function openKnowledgeFactModal(existing, mainChapters, root, projectId) {
  const f = existing || {};
  const chapterOptions = ['<option value="">(sin capítulo fuente enlazado)</option>']
    .concat((mainChapters || []).map((c) => `<option value="${escapeHtml(c.id)}" ${f.sourceChapterId === c.id ? 'selected' : ''}>Cap. ${escapeHtml(String(c.order ?? 0))} — ${escapeHtml(c.title || 'Sin título')}</option>`))
    .join('');

  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">${existing ? 'Editar hecho epistémico' : 'Nuevo hecho epistémico'}</h3>
    <label class="field-label">Título breve</label>
    <input type="text" id="kf-title" value="${escapeHtml(f.title || '')}" placeholder="Ej: Relación secreta Eruri">
    <label class="field-label">Verdad objetiva del canon (nunca se altera por falsas creencias)</label>
    <textarea id="kf-truth" rows="2" placeholder="Describe la verdad objetiva en esta historia...">${escapeHtml(f.truth || '')}</textarea>
    <div class="grid-2">
      <div>
        <label class="field-label">Ámbito</label>
        <select id="kf-scope">
          ${Object.entries(SCOPE_LABELS).map(([k, lbl]) => `<option value="${k}" ${(f.scope || 'world_fact') === k ? 'selected' : ''}>${escapeHtml(lbl)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="field-label">Capa espacial</label>
        <select id="kf-layer">
          <option value="global" ${(f.layer || 'global') === 'global' ? 'selected' : ''}>global</option>
          <option value="room" ${f.layer === 'room' ? 'selected' : ''}>room (sala)</option>
          <option value="screen" ${f.layer === 'screen' ? 'selected' : ''}>screen (pantalla)</option>
          <option value="outside" ${f.layer === 'outside' ? 'selected' : ''}>outside (exterior)</option>
          <option value="flashback" ${f.layer === 'flashback' ? 'selected' : ''}>flashback</option>
        </select>
      </div>
    </div>
    <div class="grid-2">
      <div>
        <label class="field-label">Capítulo fuente (para detección stale)</label>
        <select id="kf-source-chapter">${chapterOptions}</select>
      </div>
      <div>
        <label class="field-label">Efectivo desde capítulo n.º</label>
        <input type="number" min="0" id="kf-first-order" value="${f.firstEffectiveChapterOrder ?? ''}" placeholder="Ej: 7">
      </div>
    </div>
    <div class="grid-2">
      <div>
        <label class="field-label">Referencia de fuente (texto)</label>
        <input type="text" id="kf-source-ref" value="${escapeHtml(f.sourceRef || '')}" placeholder="Ej: Cap. 7 — Juramento en el pasillo">
      </div>
      <div>
        <label class="field-label">Checkpoint efectivo (opcional)</label>
        <input type="text" id="kf-checkpoint" value="${escapeHtml(f.firstEffectiveCheckpoint || '')}" placeholder="Ej: before_first_screen, after_s1">
      </div>
    </div>
    <label style="display:block; margin:6px 0;"><input type="checkbox" id="kf-secret" ${f.isSecret ? 'checked' : ''}> Es un secreto (no conocido por defecto)</label>
    <label class="field-label">Restricciones de divulgación (una por línea)</label>
    <textarea id="kf-constraints" rows="2" placeholder="Ej: No revelar casualmente en la sala">${escapeHtml((f.disclosureConstraints || []).join('\n'))}</textarea>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="kf-save-btn">Guardar hecho</button>
      <button type="button" class="btn btn-ghost" id="kf-cancel-btn">Cancelar</button>
    </div>`);

  document.getElementById('kf-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('kf-save-btn')?.addEventListener('click', async () => {
    try {
      const sourceChapterId = document.getElementById('kf-source-chapter').value || null;
      const sourceCh = sourceChapterId ? (mainChapters || []).find((c) => c.id === sourceChapterId) : null;
      const orderRaw = document.getElementById('kf-first-order').value.trim();
      await saveKnowledgeFact({
        ...(existing || {}),
        title: document.getElementById('kf-title').value.trim(),
        truth: document.getElementById('kf-truth').value.trim(),
        scope: document.getElementById('kf-scope').value,
        layer: document.getElementById('kf-layer').value,
        sourceChapterId,
        sourceChapterRevision: sourceCh ? contentFingerprint(sourceCh.content || '') : (existing?.sourceChapterRevision || ''),
        sourceRef: document.getElementById('kf-source-ref').value.trim(),
        firstEffectiveCheckpoint: document.getElementById('kf-checkpoint').value.trim(),
        firstEffectiveChapterOrder: orderRaw !== '' ? parseInt(orderRaw, 10) : (sourceCh?.order ?? null),
        isSecret: document.getElementById('kf-secret').checked,
        disclosureConstraints: linesToArray(document.getElementById('kf-constraints').value),
        stale: false,
        disputed: false,
      }, { projectId });
      toast('Hecho epistémico guardado.');
      closeModal();
      renderMemory(root);
    } catch (err) {
      toast(err.message || 'No se pudo guardar el hecho.', { error: true });
    }
  });
}

function openCharacterBeliefModal(fact, root, projectId) {
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Creencia individual sobre «${escapeHtml(fact.title)}»</h3>
    <p class="muted"><b>Verdad objetiva (intacta):</b> ${escapeHtml(fact.truth)}</p>
    <div class="grid-2">
      <div>
        <label class="field-label">ID o nombre del personaje</label>
        <input type="text" id="cb-char" placeholder="Ej: hange, levi, joseph">
      </div>
      <div>
        <label class="field-label">Versión espacial</label>
        <select id="cb-ver">
          <option value="any">Cualquiera (any)</option>
          <option value="room">Sala (room)</option>
          <option value="screen">Pantalla (screen)</option>
          <option value="outside">Exterior (outside)</option>
          <option value="flashback">Flashback</option>
        </select>
      </div>
    </div>
    <div class="grid-2">
      <div>
        <label class="field-label">Estado epistémico</label>
        <select id="cb-state">
          <option value="knows">Sabe (knows)</option>
          <option value="suspects">Sospecha (suspects)</option>
          <option value="believes_false">Cree algo falso (believes_false)</option>
          <option value="disputed">En disputa (disputed)</option>
          <option value="unknown">Desconoce (unknown)</option>
        </select>
      </div>
      <div>
        <label class="field-label">Aprendido en capítulo n.º</label>
        <input type="number" min="0" id="cb-order" placeholder="Ej: 10">
      </div>
    </div>
    <label class="field-label">Qué cree exactamente este personaje (especialmente útil para falsas creencias o sospechas)</label>
    <textarea id="cb-text" rows="2" placeholder="Ej: Cree que Erwin y Levi solo comparten un código táctico."></textarea>
    <label class="field-label">Evidencia o fuente por la que llegó a esa creencia</label>
    <input type="text" id="cb-evidence" placeholder="Ej: Oyó una frase ambigua en el capítulo 4.">
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="cb-save-btn">Guardar creencia</button>
      <button type="button" class="btn btn-ghost" id="cb-cancel-btn">Cancelar</button>
    </div>`);

  document.getElementById('cb-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('cb-save-btn')?.addEventListener('click', async () => {
    const charId = document.getElementById('cb-char').value.trim();
    if (!charId) return toast('Indica un personaje.', { error: true });
    const orderRaw = document.getElementById('cb-order').value.trim();
    await updateCharacterBelief(fact.id, charId, {
      characterVersion: document.getElementById('cb-ver').value,
      state: document.getElementById('cb-state').value,
      beliefText: document.getElementById('cb-text').value.trim(),
      evidence: document.getElementById('cb-evidence').value.trim(),
      learnedAtChapterOrder: orderRaw !== '' ? parseInt(orderRaw, 10) : null,
    }, { projectId });
    toast('Creencia individual actualizada (verdad objetiva preservada).');
    closeModal();
    renderMemory(root);
  });
}

function renderRelationshipStates(relationships, mainChapters, root, projectId) {
  const el = document.getElementById('relationships-list');
  if (!el) return;
  if (!relationships.length) {
    el.innerHTML = '<p class="muted">Aún no hay estados relacionales cualitativos registrados.</p>';
    return;
  }
  el.innerHTML = relationships.map((r) => {
    const dims = QUALITATIVE_DIMENSIONS
      .filter((d) => r.dimensions?.[d])
      .map((d) => `<div><b>${escapeHtml(DIMENSION_LABELS[d])}:</b> ${escapeHtml(r.dimensions[d])}</div>`)
      .join('');
    const promises = (r.promises || []).map((p) => `[${p.status}${p.chapterOrder ? ` · Cap.${p.chapterOrder}` : ''}] ${p.text}`).join(' | ');
    return `
      <div class="list-item" data-rel-id="${escapeHtml(r.id)}">
        <div class="title-row">
          <b>${escapeHtml(r.label)}</b>
          <div class="chip-row">
            ${r.relationshipStage ? `<span class="pill pill-character">${escapeHtml(r.relationshipStage)}</span>` : ''}
            ${r.stale ? '<span class="pill pill-inactive">⚠️ Desactualizada</span>' : ''}
          </div>
        </div>
        <div style="font-size:13px; margin-top:4px;">
          ${dims}
          ${promises ? `<div><b>Promesas:</b> ${escapeHtml(promises)}</div>` : ''}
          ${r.unresolvedDisagreements?.length ? `<div><b>Desacuerdos abiertos:</b> ${escapeHtml(r.unresolvedDisagreements.join(' · '))}</div>` : ''}
          ${r.behaviorChanges?.length ? `<div><b>Cambios de trato:</b> ${escapeHtml(r.behaviorChanges.join(' · '))}</div>` : ''}
        </div>
        <div class="btn-row" style="margin-top:6px;">
          <button type="button" class="btn btn-ghost btn-sm act-rel-edit">Editar</button>
          <button type="button" class="btn btn-danger btn-sm act-rel-del">Eliminar</button>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.list-item').forEach((item) => {
    const id = item.dataset.relId;
    item.querySelector('.act-rel-edit')?.addEventListener('click', async () => {
      const r = await db.get('relationshipStates', id, { projectId });
      if (r) openRelationshipModal(r, mainChapters, root, projectId);
    });
    item.querySelector('.act-rel-del')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este estado relacional?')) return;
      await deleteRelationshipState(id, { projectId });
      renderMemory(root);
    });
  });
}

function openRelationshipModal(existing, mainChapters, root, projectId) {
  const r = existing || {};
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">${existing ? 'Editar estado relacional' : 'Nuevo estado relacional cualitativo'}</h3>
    <div class="grid-2">
      <div>
        <label class="field-label">Participantes (separados por coma)</label>
        <input type="text" id="rel-participants" value="${escapeHtml((r.participants || []).join(', '))}" placeholder="Ej: erwin, levi">
      </div>
      <div>
        <label class="field-label">Etiqueta visible</label>
        <input type="text" id="rel-label" value="${escapeHtml(r.label || '')}" placeholder="Ej: Erwin Smith & Levi Ackerman">
      </div>
    </div>
    <div class="grid-2">
      <div>
        <label class="field-label">Etapa relacional</label>
        <input type="text" id="rel-stage" value="${escapeHtml(r.relationshipStage || '')}" placeholder="Ej: relación secreta con lealtad férrea">
      </div>
      <div>
        <label class="field-label">Vigente desde capítulo n.º</label>
        <input type="number" min="0" id="rel-order" value="${r.effectiveChapterOrder ?? ''}" placeholder="Ej: 7">
      </div>
    </div>
    <div class="grid-2">
      ${QUALITATIVE_DIMENSIONS.map((dim) => `
        <div>
          <label class="field-label">${escapeHtml(DIMENSION_LABELS[dim])} (cualitativo)</label>
          <input type="text" class="rel-dim-input" data-dim="${dim}" value="${escapeHtml(r.dimensions?.[dim] || '')}" placeholder="Describe con matiz narrativo...">
        </div>`).join('')}
    </div>
    <label class="field-label">Promesas abiertas (una por línea)</label>
    <textarea id="rel-promises" rows="2">${escapeHtml((r.promises || []).map((p) => p.text).join('\n'))}</textarea>
    <label class="field-label">Desacuerdos sin resolver (uno por línea)</label>
    <textarea id="rel-disagreements" rows="2">${escapeHtml((r.unresolvedDisagreements || []).join('\n'))}</textarea>
    <label class="field-label">Cambios observables de comportamiento (uno por línea)</label>
    <textarea id="rel-behaviors" rows="2">${escapeHtml((r.behaviorChanges || []).join('\n'))}</textarea>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="rel-save-btn">Guardar relación</button>
      <button type="button" class="btn btn-ghost" id="rel-cancel-btn">Cancelar</button>
    </div>`);

  document.getElementById('rel-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('rel-save-btn')?.addEventListener('click', async () => {
    try {
      const dimensions = {};
      document.querySelectorAll('.rel-dim-input').forEach((inp) => {
        dimensions[inp.dataset.dim] = inp.value.trim();
      });
      const orderRaw = document.getElementById('rel-order').value.trim();
      const effOrder = orderRaw !== '' ? parseInt(orderRaw, 10) : null;
      await saveRelationshipState({
        ...(existing || {}),
        participants: csvToArray(document.getElementById('rel-participants').value),
        label: document.getElementById('rel-label').value.trim(),
        relationshipStage: document.getElementById('rel-stage').value.trim(),
        effectiveChapterOrder: effOrder,
        dimensions,
        promises: linesToArray(document.getElementById('rel-promises').value).map((text) => ({
          text,
          chapterOrder: effOrder,
          status: 'open',
        })),
        unresolvedDisagreements: linesToArray(document.getElementById('rel-disagreements').value),
        behaviorChanges: linesToArray(document.getElementById('rel-behaviors').value),
        stale: false,
      }, { projectId });
      toast('Estado relacional guardado.');
      closeModal();
      renderMemory(root);
    } catch (err) {
      toast(err.message || 'No se pudo guardar el estado relacional.', { error: true });
    }
  });
}

function renderArcSummaries(arcs, mainChapters, root, projectId) {
  const el = document.getElementById('arc-summaries-list');
  if (!el) return;
  if (!arcs.length) {
    el.innerHTML = '<p class="muted">Sin resúmenes de arco aún. Cuando tu historia crezca, comprime arcos anteriores preservando secretos, promesas e hilos abiertos.</p>';
    return;
  }
  el.innerHTML = arcs.map((a) => `
    <div class="list-item" data-arc-id="${escapeHtml(a.id)}">
      <div class="title-row">
        <b>Arco ${escapeHtml(String(a.arcOrder))}: ${escapeHtml(a.title)}</b>
        <div class="chip-row">
          <span class="pill pill-reference">Caps. ${escapeHtml(String(a.startChapterOrder))}–${escapeHtml(String(a.endChapterOrder))}</span>
          ${a.stale ? '<span class="pill pill-inactive">⚠️ Desactualizado</span>' : ''}
        </div>
      </div>
      ${a.summary ? `<div style="font-size:13px; margin:4px 0;">${escapeHtml(a.summary)}</div>` : ''}
      ${a.preservedSecrets?.length ? `<div class="muted" style="font-size:12px;"><b>Secretos preservados:</b> ${escapeHtml(a.preservedSecrets.join(' · '))}</div>` : ''}
      ${a.preservedPromises?.length ? `<div class="muted" style="font-size:12px;"><b>Promesas preservadas:</b> ${escapeHtml(a.preservedPromises.join(' · '))}</div>` : ''}
      ${a.openThreads?.length ? `<div class="muted" style="font-size:12px;"><b>Hilos abiertos:</b> ${escapeHtml(a.openThreads.join(' · '))}</div>` : ''}
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost btn-sm act-arc-edit">Editar</button>
        <button type="button" class="btn btn-danger btn-sm act-arc-del">Eliminar</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.list-item').forEach((item) => {
    const id = item.dataset.arcId;
    item.querySelector('.act-arc-edit')?.addEventListener('click', async () => {
      const a = await db.get('arcSummaries', id, { projectId });
      if (a) openArcSummaryModal(a, root, projectId);
    });
    item.querySelector('.act-arc-del')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este resumen de arco?')) return;
      await deleteArcSummary(id, { projectId });
      renderMemory(root);
    });
  });
}

function openArcSummaryModal(existing, root, projectId) {
  const a = existing || {};
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">${existing ? 'Editar resumen de arco' : 'Nuevo resumen de arco narrativo'}</h3>
    <div class="grid-3">
      <div><label class="field-label">Orden del arco</label><input type="number" min="1" id="arc-order" value="${a.arcOrder ?? 1}"></div>
      <div><label class="field-label">Capítulo inicio</label><input type="number" min="1" id="arc-start" value="${a.startChapterOrder ?? 1}"></div>
      <div><label class="field-label">Capítulo fin</label><input type="number" min="1" id="arc-end" value="${a.endChapterOrder ?? 10}"></div>
    </div>
    <label class="field-label">Título del arco</label>
    <input type="text" id="arc-title" value="${escapeHtml(a.title || '')}" placeholder="Ej: Arco I — Primer visionado y sospechas">
    <label class="field-label">Resumen narrativo</label>
    <textarea id="arc-summary" rows="3">${escapeHtml(a.summary || '')}</textarea>
    <label class="field-label">Secretos preservados (uno por línea)</label>
    <textarea id="arc-secrets" rows="2">${escapeHtml((a.preservedSecrets || []).join('\n'))}</textarea>
    <label class="field-label">Promesas preservadas (una por línea)</label>
    <textarea id="arc-promises" rows="2">${escapeHtml((a.preservedPromises || []).join('\n'))}</textarea>
    <label class="field-label">Hilos abiertos (uno por línea)</label>
    <textarea id="arc-threads" rows="2">${escapeHtml((a.openThreads || []).join('\n'))}</textarea>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="arc-save-btn">Guardar arco</button>
      <button type="button" class="btn btn-ghost" id="arc-cancel-btn">Cancelar</button>
    </div>`);

  document.getElementById('arc-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('arc-save-btn')?.addEventListener('click', async () => {
    try {
      await saveArcSummary({
        ...(existing || {}),
        arcOrder: parseInt(document.getElementById('arc-order').value, 10) || 1,
        startChapterOrder: parseInt(document.getElementById('arc-start').value, 10) || 1,
        endChapterOrder: parseInt(document.getElementById('arc-end').value, 10) || 1,
        title: document.getElementById('arc-title').value.trim(),
        summary: document.getElementById('arc-summary').value.trim(),
        preservedSecrets: linesToArray(document.getElementById('arc-secrets').value),
        preservedPromises: linesToArray(document.getElementById('arc-promises').value),
        openThreads: linesToArray(document.getElementById('arc-threads').value),
        stale: false,
      }, { projectId });
      toast('Resumen de arco guardado.');
      closeModal();
      renderMemory(root);
    } catch (err) {
      toast(err.message || 'No se pudo guardar el resumen de arco.', { error: true });
    }
  });
}

function openArcCompressModal({ mainChapters, allMemoryEntries, knowledgeFacts, relationships, arcSummaries, root, projectId }) {
  const nextOrder = (arcSummaries?.length || 0) + 1;
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">⚡ Comprimir rango de capítulos en arco (0 tokens)</h3>
    <p class="muted">Genera un resumen determinista conservando secretos, promesas abiertas, cambios relacionales e hilos sin resolver.</p>
    <div class="grid-3">
      <div><label class="field-label">Arco n.º</label><input type="number" min="1" id="ac-order" value="${nextOrder}"></div>
      <div><label class="field-label">Desde capítulo</label><input type="number" min="0" id="ac-start" value="1"></div>
      <div><label class="field-label">Hasta capítulo</label><input type="number" min="0" id="ac-end" value="${Math.max(1, mainChapters.length)}"></div>
    </div>
    <label class="field-label">Título del arco</label>
    <input type="text" id="ac-title" placeholder="Ej: Arco ${nextOrder} — Primer bloque">
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="ac-run-btn">Generar y guardar arco</button>
      <button type="button" class="btn btn-ghost" id="ac-cancel-btn">Cancelar</button>
    </div>`);

  document.getElementById('ac-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('ac-run-btn')?.addEventListener('click', async () => {
    const compressed = compressArcWindow({
      projectId,
      arcOrder: parseInt(document.getElementById('ac-order').value, 10) || nextOrder,
      title: document.getElementById('ac-title').value.trim(),
      startChapterOrder: parseInt(document.getElementById('ac-start').value, 10) || 1,
      endChapterOrder: parseInt(document.getElementById('ac-end').value, 10) || 1,
      chapters: mainChapters,
      memoryEntries: allMemoryEntries,
      knowledgeFacts,
      relationships,
    });
    await saveArcSummary(compressed, { projectId });
    toast(`Arco «${compressed.title}» generado sin gastar tokens.`);
    closeModal();
    renderMemory(root);
  });
}

function renderLocked(lockedFacts, root) {
  const el = document.getElementById('locked-list');
  if (!lockedFacts.length) {
    el.innerHTML = `<p class="muted">Sin hechos bloqueados todavía.</p>`;
    return;
  }
  el.innerHTML = lockedFacts.map((f) => `<div class="list-item" data-id="${escapeHtml(f.id)}"><div class="card-row"><span>${escapeHtml(f.text)}</span><button class="btn btn-danger btn-sm act-del">Quitar</button></div>${f.isCore ? '<span class="pill pill-canon">regla base</span>' : ''}</div>`).join('');
  el.querySelectorAll('.list-item').forEach((item) => {
    item.querySelector('.act-del').addEventListener('click', async () => {
      if (!confirm('¿Quitar este hecho bloqueado?')) return;
      await db.del('lockedFacts', item.dataset.id);
      renderMemory(root);
    });
  });
}

function renderCanon(canonNotes, root) {
  const groups = {
    revealed: (canonNotes || []).filter((n) => n?.visibility === 'revealed'),
    private: (canonNotes || []).filter((n) => n?.visibility !== 'revealed'),
  };
  const renderGroup = (list, elId, visibility) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!list.length) {
      el.innerHTML = `<p class="muted">${visibility === 'revealed' ? 'Todavía no hay canon marcado como revelado.' : 'Sin canon privado.'}</p>`;
      return;
    }
    el.innerHTML = list.map((n) => `<div class="list-item" data-id="${escapeHtml(n.id)}"><div style="white-space:pre-wrap;">${escapeHtml(n.text)}</div><div class="btn-row"><button class="btn btn-ghost btn-sm act-toggle">${visibility === 'revealed' ? '🕵️ Mover a privado' : '📖 Marcar revelado'}</button><button class="btn btn-danger btn-sm act-del">Quitar</button></div></div>`).join('');
    el.querySelectorAll('.list-item').forEach((item) => {
      item.querySelector('.act-toggle')?.addEventListener('click', async () => {
        const note = await db.get('canonNotes', item.dataset.id);
        if (!note) return;
        note.visibility = visibility === 'revealed' ? 'private' : 'revealed';
        await db.put('canonNotes', note);
        toast(note.visibility === 'revealed' ? 'Canon marcado como revelado.' : 'Canon movido a privado del autor.');
        renderMemory(root);
      });
      item.querySelector('.act-del')?.addEventListener('click', async () => {
        if (!confirm('¿Quitar esta nota de canon?')) return;
        await db.del('canonNotes', item.dataset.id);
        renderMemory(root);
      });
    });
  };
  renderGroup(groups.revealed, 'canon-revealed-list', 'revealed');
  renderGroup(groups.private, 'canon-private-list', 'private');
}

function renderContinuity(memoryEntries, root) {
  const el = document.getElementById('continuity-list');
  if (!memoryEntries.length) {
    el.innerHTML = `<p class="muted">Todavía no se ha generado memoria de continuidad.</p>`;
    return;
  }
  el.innerHTML = memoryEntries.map((m) => `
    <div class="list-item" data-id="${escapeHtml(m.id)}">
      <div class="title-row"><b>${escapeHtml(m.chapterTitle || 'Capítulo')}</b><span class="muted">${escapeHtml(fmtDate(m.createdAt))}</span></div>
      ${m.stale ? `<div class="chip-row" style="margin:6px 0;"><span class="pill pill-inactive" title="El capítulo fue modificado tras crear esta memoria; se conserva intacta hasta que la revises o actualices.">⚠️ Desactualizada · capítulo modificado</span></div>` : ''}
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm act-view">Ver / editar</button>
        <button class="btn btn-danger btn-sm act-del">Eliminar</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('.list-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('.act-view').addEventListener('click', async () => {
      const m = await db.get('memoryEntries', id);
      openMemoryEditModal(m, root);
    });
    item.querySelector('.act-del').addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta memoria de continuidad?')) return;
      await db.del('memoryEntries', id);
      renderMemory(root);
    });
  });
}

function openMemoryEditModal(m, root) {
  const fields = [
    ['events', 'EVENTOS'],
    ['relationshipChanges', 'CAMBIOS DE RELACIÓN'],
    ['newFacts', 'HECHOS NUEVOS'],
    ['whoKnowsWhat', 'QUIÉN SABE QUÉ'],
    ['physicalState', 'ESTADO FÍSICO / HERIDAS'],
    ['currentLocationTime', 'LUGAR / TIEMPO ACTUAL'],
    ['openThreads', 'HILOS ABIERTOS'],
  ];
  const staleNotice = m.stale
    ? `<div class="context-guard-item context-guard-warning" style="margin-bottom:10px;"><b>⚠️ Memoria desactualizada</b><div>El capítulo cambió después de generar esta memoria. La versión anterior se conserva intacta; al guardar aquí se marcará como revisada, o puedes generar una nueva propuesta para revisar desde Capítulos.</div></div>`
    : '';
  openModal(`<h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">${escapeHtml(m.chapterTitle)}</h3>${staleNotice}${fields.map(([key, label]) => `<label class="field-label">${escapeHtml(label)}</label><textarea class="mem-field" data-key="${escapeHtml(key)}">${escapeHtml(m[key] || '')}</textarea>`).join('')}<div class="btn-row"><button class="btn btn-primary" id="mem-save-btn">Guardar</button><button class="btn btn-ghost" id="mem-cancel-btn">Cerrar</button></div>`);
  document.getElementById('mem-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('mem-save-btn').addEventListener('click', async () => {
    document.querySelectorAll('.mem-field').forEach((ta) => { m[ta.dataset.key] = ta.value.trim(); });
    const chapter = m.chapterId ? await db.get('chapters', m.chapterId) : null;
    m.stale = false;
    m.staleReason = '';
    m.staleAt = null;
    if (chapter) {
      const rev = contentFingerprint(chapter.content);
      m.sourceChapterRevision = rev;
      m.latestChapterRevision = rev;
    }
    await db.put('memoryEntries', m);
    toast('Memoria actualizada.');
    closeModal();
    renderMemory(root);
  });
}
