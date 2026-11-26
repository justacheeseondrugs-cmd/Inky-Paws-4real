import { db } from '../db.js';
import { escapeHtml, toast, openModal, closeModal } from '../utils.js';
import {
  listUniversalCharacters,
  saveUniversalCharacter,
  listCharacterOverlays,
  saveCharacterOverlay,
  deleteCharacterOverlay,
  cloneCharacterOverlay,
  importMasterCharacterBible,
  isOverlayConfigured,
  resolveCharacterProfile,
} from '../characterLibrary.js';
import { getStoryConfig } from '../storyConfigSchema.js';
import { renderUniverseSection } from './universe.js';

function linesToArray(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function dynamicsToLines(map) {
  if (!map || typeof map !== 'object') return '';
  return Object.entries(map).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function linesToDynamics(text) {
  const out = {};
  for (const line of linesToArray(text)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

export async function renderCharacters(root) {
  const projectId = db.getActiveProjectId();
  const [characters, universalCharacters, overlays, storyConfig] = await Promise.all([
    db.getAll('characters'),
    listUniversalCharacters(),
    listCharacterOverlays(),
    getStoryConfig(projectId),
  ]);
  const sortedStoryChars = (characters || []).sort((a, b) => a.name.localeCompare(b.name));

  root.innerHTML = `
    <h2 class="section-title">Personajes &amp; Universo</h2>
    <p class="section-hint">Configura el universo, los presets, tus fichas locales, la biblioteca universal y Character Lab (overlays) con total aislamiento entre historias.</p>
    <div id="universe-section-slot"></div>
    <div class="btn-row" style="margin-bottom:14px;">
      <button class="btn btn-primary" id="char-new-btn">+ Nuevo personaje en esta historia</button>
    </div>
    <div id="char-list"></div>

    <div class="card" id="universal-library-card" style="margin-top:20px;">
      <div class="card-row">
        <div>
          <h3>📚 Biblioteca universal de personajes</h3>
          <p class="muted">Perfiles base reutilizables entre historias. Los personajes opcionales y overlays guardados aquí NO se activan automáticamente en ninguna historia.</p>
        </div>
        <div class="btn-row">
          <label class="btn btn-primary btn-sm" style="cursor:pointer;">⬆️ Importar Biblia Maestra JSON
            <input type="file" id="bible-import-input" accept="application/json,.json" style="display:none;">
          </label>
          <button type="button" class="btn btn-ghost btn-sm" id="univ-char-new-btn">+ Perfil universal</button>
        </div>
      </div>
      <div id="univ-char-list"></div>
    </div>

    <div class="card" id="overlay-library-card" style="margin-top:16px;">
      <div class="card-row">
        <div>
          <h3>🎭 Character Lab · Biblioteca de overlays de caracterización</h3>
          <p class="muted">Plantillas opcionales reutilizables (como rasgos Violet para Levi o cualquier variación personalizada). Siempre desactivadas por defecto: guardar una plantilla NO la convierte en canon activo ni altera el perfil base.</p>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-primary btn-sm" id="overlay-new-btn">+ Nuevo overlay</button>
        </div>
      </div>
      <div id="overlay-list"></div>
    </div>`;

  const universeSlot = document.getElementById('universe-section-slot');
  if (universeSlot) {
    await renderUniverseSection(universeSlot, {
      universalCharacters,
      storyCharacters: sortedStoryChars,
      overlays,
      onRefresh: () => renderCharacters(root),
    });
  }

  document.getElementById('char-new-btn').addEventListener('click', () => openCharacterModal(null, root, universalCharacters));
  document.getElementById('univ-char-new-btn').addEventListener('click', () => openUniversalCharacterModal(null, root));
  document.getElementById('overlay-new-btn').addEventListener('click', () => openOverlayModal(null, root, universalCharacters));

  document.getElementById('bible-import-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const summary = await importMasterCharacterBible(json);
      const protectedCount = summary.protectedAuthorEdited.length;
      const msg = `Biblia Maestra v${summary.contentVersion} importada: ${summary.characters.created} perfiles nuevos, ${summary.characters.updated} actualizados, ${summary.overlays.created + summary.overlays.updated} overlays, ${summary.presets.created + summary.presets.updated} presets.` +
        (protectedCount ? ` 🛡️ ${protectedCount} registro(s) editados por ti se conservaron intactos.` : '');
      toast(msg, { ms: 8500 });
      renderCharacters(root);
    } catch (err) {
      toast('No se pudo importar la Biblia Maestra: ' + (err?.message || err), { error: true, ms: 9000 });
    }
  });

  // 1. Fichas propias de la historia actual
  const list = document.getElementById('char-list');
  if (!sortedStoryChars.length) {
    list.innerHTML = `<div class="empty"><span class="ic">💗</span>Todavía no has añadido personajes propios a esta historia.</div>`;
  } else {
    list.innerHTML = sortedStoryChars.map((c) => `
      <div class="list-item" data-id="${escapeHtml(c.id)}">
        <div class="title-row"><b>${escapeHtml(c.name)}</b><span class="pill ${c.active !== false ? 'pill-active' : 'pill-inactive'}">${c.active !== false ? 'Activo' : 'Inactivo'}</span></div>
        <div class="muted">${escapeHtml(c.pronouns || 'sin pronombres definidos')}${c.universalCharacterId ? ` · 🔗 universal: ${escapeHtml(c.universalCharacterId)}` : ''}</div>
        ${c.personality ? `<div class="muted" style="margin-top:4px;">${escapeHtml(c.personality)}</div>` : ''}
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm act-edit">Editar</button>
          <button class="btn btn-ghost btn-sm act-preview">🔎 Vista resuelta</button>
          <button class="btn btn-ghost btn-sm act-toggle">${c.active !== false ? 'Desactivar' : 'Activar'}</button>
          <button class="btn btn-danger btn-sm act-delete">Eliminar</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.list-item').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('.act-edit').addEventListener('click', () => openCharacterModal(id, root, universalCharacters));
      el.querySelector('.act-preview').addEventListener('click', async () => {
        const sc = await db.get('characters', id);
        const link = sc?.universalCharacterId || sc?.id;
        const u = universalCharacters.find((item) => item.id === link || item.logicalId === link) || null;
        openResolvedPreviewModal(u, sc, overlays, storyConfig);
      });
      el.querySelector('.act-toggle').addEventListener('click', async () => {
        const c = await db.get('characters', id);
        c.active = c.active === false ? true : false;
        await db.put('characters', c);
        renderCharacters(root);
      });
      el.querySelector('.act-delete').addEventListener('click', async () => {
        if (!confirm('¿Eliminar este personaje de la historia actual? (La biblioteca universal no se modifica.)')) return;
        await db.del('characters', id);
        renderCharacters(root);
      });
    });
  }

  // 2. Biblioteca universal
  const univList = document.getElementById('univ-char-list');
  if (!universalCharacters.length) {
    univList.innerHTML = `<p class="muted">Aún no hay perfiles en la biblioteca universal. Importa la Biblia Maestra JSON o crea un perfil base.</p>`;
  } else {
    univList.innerHTML = universalCharacters.map((u) => `
      <div class="list-item" data-univ-id="${escapeHtml(u.id)}" data-logical-id="${escapeHtml(u.logicalId || u.id)}">
        <div class="title-row">
          <b>${escapeHtml(u.name)}</b>
          <span class="muted" title="${escapeHtml(u.id)}">${escapeHtml(u.logicalId || u.id)}</span>
        </div>
        <div class="chip-row" style="margin:4px 0;">
          <span class="pill ${u.category === 'optional' ? 'pill-inactive' : 'pill-active'}">${u.category === 'optional' ? 'Opcional · desactivado por defecto' : escapeHtml(u.category)}</span>
          <span class="pill pill-reference">${escapeHtml(u.fandom || 'neutral')}</span>
          ${u.authorEdited ? '<span class="pill pill-canon">✏️ Editado por autora</span>' : ''}
        </div>
        ${u.role ? `<div class="muted">${escapeHtml(u.role)}</div>` : ''}
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-sm act-univ-edit">Ver / editar base</button>
          <button type="button" class="btn btn-ghost btn-sm act-univ-preview">🔎 Vista previa resuelta (0 tokens)</button>
        </div>
      </div>`).join('');
    univList.querySelectorAll('.list-item').forEach((el) => {
      const uid = el.dataset.univId;
      const u = universalCharacters.find((item) => item.id === uid);
      el.querySelector('.act-univ-edit')?.addEventListener('click', () => openUniversalCharacterModal(uid, root));
      el.querySelector('.act-univ-preview')?.addEventListener('click', () => {
        const sc = sortedStoryChars.find((item) =>
          item.universalCharacterId === uid || item.universalCharacterId === u?.logicalId || item.id === uid || item.id === u?.logicalId
        ) || null;
        openResolvedPreviewModal(u, sc, overlays, storyConfig);
      });
    });
  }

  // 3. Biblioteca de overlays reutilizables
  const overlayList = document.getElementById('overlay-list');
  if (!overlays.length) {
    overlayList.innerHTML = `<p class="muted">Sin plantillas de overlay todavía. Importa la Biblia Maestra o crea un overlay personalizado para cualquier personaje.</p>`;
  } else {
    overlayList.innerHTML = overlays.map((ov) => {
      const configured = isOverlayConfigured(ov);
      return `
      <div class="list-item" data-overlay-id="${escapeHtml(ov.id)}" data-logical-id="${escapeHtml(ov.logicalId || ov.id)}">
        <div class="title-row"><b>${escapeHtml(ov.name)}</b><span class="muted">base: ${escapeHtml(ov.baseCharacterId)} · ${escapeHtml(ov.fandom || 'neutral')}</span></div>
        <div class="chip-row" style="margin:4px 0;">
          <span class="pill pill-inactive">Plantilla · desactivada por defecto</span>
          <span class="pill ${configured ? 'pill-active' : 'pill-canon'}">${configured ? `${ov.characterizationChanges.length} rasgo(s) definido(s)` : '⚠️ Sin rasgos configurados'}</span>
          <span class="pill pill-reference">ámbitos: ${escapeHtml((ov.allowedScopes || []).join(', '))}</span>
          ${ov.authorEdited ? '<span class="pill pill-canon">✏️ Editado por autora</span>' : ''}
        </div>
        ${ov.description ? `<div class="muted">${escapeHtml(ov.description)}</div>` : ''}
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-sm act-ov-edit">Editar rasgos</button>
          <button type="button" class="btn btn-ghost btn-sm act-ov-clone">Duplicar</button>
          <button type="button" class="btn btn-danger btn-sm act-ov-del">Eliminar</button>
        </div>
      </div>`;
    }).join('');
    overlayList.querySelectorAll('.list-item').forEach((el) => {
      const oid = el.dataset.overlayId;
      el.querySelector('.act-ov-edit')?.addEventListener('click', () => openOverlayModal(oid, root, universalCharacters));
      el.querySelector('.act-ov-clone')?.addEventListener('click', async () => {
        try {
          await cloneCharacterOverlay(oid);
          toast('Plantilla de overlay duplicada (desactivada por defecto).');
          renderCharacters(root);
        } catch (err) {
          toast(err.message || 'No se pudo duplicar el overlay.', { error: true });
        }
      });
      el.querySelector('.act-ov-del')?.addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta plantilla de overlay de la biblioteca universal?')) return;
        await deleteCharacterOverlay(oid);
        toast('Plantilla de overlay eliminada.');
        renderCharacters(root);
      });
    });
  }
}

async function openCharacterModal(id, root, universalCharacters = []) {
  const c = id ? await db.get('characters', id) : { name: '', pronouns: '', personality: '', speechStyle: '', hardRules: '', currentKnowledge: '', relationships: '', chemistry: '', neverDoRules: '', universalCharacterId: '', active: true };
  const univOptions = ['<option value="">(ninguno / ficha independiente)</option>']
    .concat(universalCharacters.map((u) => `<option value="${escapeHtml(u.id)}" ${c.universalCharacterId === u.id ? 'selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(u.id)})</option>`))
    .join('');
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700); font-size:22px;">${id ? 'Editar' : 'Nuevo'} personaje (esta historia)</h3>
    <label class="field-label">Perfil universal vinculado (opcional)</label>
    <select id="f-univ-link">${univOptions}</select>
    <label class="field-label">Nombre</label><input type="text" id="f-name" value="${escapeHtml(c.name)}">
    <label class="field-label">Pronombres</label><input type="text" id="f-pronouns" value="${escapeHtml(c.pronouns)}" placeholder="ej: she/her, they/them, he/him">
    <label class="field-label">Personalidad (estado en esta historia)</label><textarea id="f-personality">${escapeHtml(c.personality)}</textarea>
    <label class="field-label">Estilo de habla</label><textarea id="f-speech">${escapeHtml(c.speechStyle)}</textarea>
    <label class="field-label">Reglas obligatorias</label><textarea id="f-hardrules" placeholder="Cosas que siempre deben cumplirse para este personaje">${escapeHtml(c.hardRules)}</textarea>
    <label class="field-label">Conocimiento actual</label><textarea id="f-knowledge" placeholder="Sólo lo que este personaje sabe hasta el momento actual de la historia">${escapeHtml(c.currentKnowledge)}</textarea>
    <label class="field-label">Relaciones</label><textarea id="f-relationships">${escapeHtml(c.relationships)}</textarea>
    <label class="field-label">⚡ Química con otros personajes</label><textarea id="f-chemistry" placeholder="Cómo cambia su voz/comportamiento con personas concretas.">${escapeHtml(c.chemistry || '')}</textarea>
    <p class="muted">No es una lista de hechos: describe el ritmo, fricción, confianza, bromas privadas, silencios y hábitos que hacen única la dinámica.</p>
    <label class="field-label">Reglas de nunca hacer</label><textarea id="f-neverdo">${escapeHtml(c.neverDoRules)}</textarea>
    <label class="field-label"><input type="checkbox" id="f-active" ${c.active !== false ? 'checked' : ''}> Incluir en el control de canon (activo)</label>
    <div class="btn-row"><button class="btn btn-primary" id="f-save-btn">Guardar</button><button class="btn btn-ghost" id="f-cancel-btn">Cancelar</button></div>`);
  document.getElementById('f-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('f-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return toast('El personaje necesita un nombre.', { error: true });
    const obj = {
      ...c,
      id: id || undefined,
      universalCharacterId: document.getElementById('f-univ-link').value.trim(),
      name,
      pronouns: document.getElementById('f-pronouns').value.trim(),
      personality: document.getElementById('f-personality').value.trim(),
      speechStyle: document.getElementById('f-speech').value.trim(),
      hardRules: document.getElementById('f-hardrules').value.trim(),
      currentKnowledge: document.getElementById('f-knowledge').value.trim(),
      relationships: document.getElementById('f-relationships').value.trim(),
      chemistry: document.getElementById('f-chemistry').value.trim(),
      neverDoRules: document.getElementById('f-neverdo').value.trim(),
      active: document.getElementById('f-active').checked,
    };
    await db.put('characters', obj);
    toast('Personaje guardado para esta historia.');
    closeModal();
    renderCharacters(root);
  });
}

async function openUniversalCharacterModal(id, root) {
  const u = id ? await db.get('universalCharacters', id) : {
    id: '',
    name: '',
    pronouns: '',
    role: '',
    fandom: 'neutral',
    category: 'custom',
    corePersonality: '',
    speechPatterns: '',
    motivations: '',
    emotionalDefenses: '',
    bodyLanguage: '',
    interpersonalDynamics: {},
    strengthsVulnerabilities: '',
    publicPrivateBehavior: '',
    antiPatterns: [],
    stageDevelopment: '',
    voiceExample: '',
  };
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700); font-size:22px;">${id ? 'Editar' : 'Nuevo'} perfil universal</h3>
    <p class="muted">Los cambios aquí se marcan como «Editado por autora» para que futuras importaciones de la Biblia no los sobrescriban silenciosamente.</p>
    <div class="grid-2">
      <div><label class="field-label">ID estable</label><input type="text" id="u-id" value="${escapeHtml(u.id || '')}" ${id ? 'readonly' : ''} placeholder="ej: levi, original_hero"></div>
      <div><label class="field-label">Fandom / namespace</label><input type="text" id="u-fandom" value="${escapeHtml(u.fandom || 'neutral')}" placeholder="ej: power_to_strive, neutral"></div>
    </div>
    <div class="grid-2">
      <div><label class="field-label">Nombre</label><input type="text" id="u-name" value="${escapeHtml(u.name || '')}"></div>
      <div><label class="field-label">Pronombres</label><input type="text" id="u-pronouns" value="${escapeHtml(u.pronouns || '')}"></div>
    </div>
    <div class="grid-2">
      <div><label class="field-label">Rol</label><input type="text" id="u-role" value="${escapeHtml(u.role || '')}"></div>
      <div><label class="field-label">Categoría</label><select id="u-category">
        <option value="core" ${u.category === 'core' ? 'selected' : ''}>Núcleo (core)</option>
        <option value="optional" ${u.category === 'optional' ? 'selected' : ''}>Opcional (desactivado por defecto)</option>
        <option value="facilitator" ${u.category === 'facilitator' ? 'selected' : ''}>Facilitador</option>
        <option value="custom" ${!['core', 'optional', 'facilitator'].includes(u.category) ? 'selected' : ''}>Personalizado</option>
      </select></div>
    </div>
    <label class="field-label">Personalidad permanente</label><textarea id="u-core">${escapeHtml(u.corePersonality || '')}</textarea>
    <label class="field-label">Patrones de habla y vocabulario</label><textarea id="u-speech">${escapeHtml(u.speechPatterns || '')}</textarea>
    <label class="field-label">Motivaciones psicológicas / atención</label><textarea id="u-motivations">${escapeHtml(u.motivations || '')}</textarea>
    <label class="field-label">Defensas emocionales y respuesta al estrés</label><textarea id="u-defenses">${escapeHtml(u.emotionalDefenses || '')}</textarea>
    <label class="field-label">Lenguaje corporal</label><textarea id="u-body">${escapeHtml(u.bodyLanguage || '')}</textarea>
    <label class="field-label">Dinámicas interpersonales (una por línea: id: descripción)</label><textarea id="u-dynamics">${escapeHtml(dynamicsToLines(u.interpersonalDynamics))}</textarea>
    <label class="field-label">Fortalezas y vulnerabilidades</label><textarea id="u-strengths">${escapeHtml(u.strengthsVulnerabilities || '')}</textarea>
    <label class="field-label">Comportamiento público vs. privado</label><textarea id="u-pubpriv">${escapeHtml(u.publicPrivateBehavior || '')}</textarea>
    <label class="field-label">Anti-patrones de caracterización (uno por línea)</label><textarea id="u-avoid">${escapeHtml((u.antiPatterns || []).join('\n'))}</textarea>
    <label class="field-label">Desarrollo emocional dependiente de etapa</label><textarea id="u-stage">${escapeHtml(u.stageDevelopment || '')}</textarea>
    <div class="btn-row"><button type="button" class="btn btn-primary" id="u-save-btn">Guardar perfil universal</button><button type="button" class="btn btn-ghost" id="u-cancel-btn">Cancelar</button></div>`);
  document.getElementById('u-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('u-save-btn').addEventListener('click', async () => {
    try {
      await saveUniversalCharacter({
        id: document.getElementById('u-id').value.trim() || undefined,
        fandom: document.getElementById('u-fandom').value.trim() || 'neutral',
        name: document.getElementById('u-name').value.trim(),
        pronouns: document.getElementById('u-pronouns').value.trim(),
        role: document.getElementById('u-role').value.trim(),
        category: document.getElementById('u-category').value,
        corePersonality: document.getElementById('u-core').value.trim(),
        speechPatterns: document.getElementById('u-speech').value.trim(),
        motivations: document.getElementById('u-motivations').value.trim(),
        emotionalDefenses: document.getElementById('u-defenses').value.trim(),
        bodyLanguage: document.getElementById('u-body').value.trim(),
        interpersonalDynamics: linesToDynamics(document.getElementById('u-dynamics').value),
        strengthsVulnerabilities: document.getElementById('u-strengths').value.trim(),
        publicPrivateBehavior: document.getElementById('u-pubpriv').value.trim(),
        antiPatterns: linesToArray(document.getElementById('u-avoid').value),
        stageDevelopment: document.getElementById('u-stage').value.trim(),
      }, { authorEdited: true });
      toast('Perfil universal guardado (protegido frente a re-importaciones).');
      closeModal();
      renderCharacters(root);
    } catch (err) {
      toast(err.message || 'No se pudo guardar el perfil universal.', { error: true });
    }
  });
}

async function openOverlayModal(id, root, universalCharacters = []) {
  const ov = id ? await db.get('characterOverlays', id) : {
    id: '',
    name: '',
    description: '',
    baseCharacterId: universalCharacters[0]?.id || '',
    fandom: 'neutral',
    characterizationChanges: [],
    preserveCoreTraits: [],
    backstoryChanges: '',
    relationshipChanges: {},
    activationConditions: [],
    allowedScopes: ['story', 'character_version', 'scene'],
    defaultScope: 'story',
    priority: 50,
    conflictGroup: '',
    conflictsWith: [],
    conflictResolution: 'ask_author',
  };
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700); font-size:22px;">${id ? 'Editar' : 'Nuevo'} overlay de caracterización</h3>
    <p class="muted">Los overlays son plantillas opcionales desactivadas por defecto. Nunca modifican el perfil universal base ni se activan automáticamente.</p>
    <div class="grid-2">
      <div><label class="field-label">ID estable</label><input type="text" id="ov-id" value="${escapeHtml(ov.id || '')}" ${id ? 'readonly' : ''} placeholder="ej: levi_violet_traits"></div>
      <div><label class="field-label">ID del personaje base</label><input type="text" id="ov-base" value="${escapeHtml(ov.baseCharacterId || '')}" placeholder="ej: levi"></div>
    </div>
    <div class="grid-2">
      <div><label class="field-label">Nombre del overlay</label><input type="text" id="ov-name" value="${escapeHtml(ov.name || '')}" placeholder="ej: Violet Traits (Levi)"></div>
      <div><label class="field-label">Fandom / namespace</label><input type="text" id="ov-fandom" value="${escapeHtml(ov.fandom || 'neutral')}"></div>
    </div>
    <label class="field-label">Descripción</label><textarea id="ov-desc" rows="2">${escapeHtml(ov.description || '')}</textarea>
    <label class="field-label">Cambios explícitos de caracterización (uno por línea)</label>
    <textarea id="ov-changes" rows="4" placeholder="Escribe aquí los rasgos aprobados por ti. Si queda vacío, el overlay se marcará como sin configurar y NO inventará rasgos.">${escapeHtml((ov.characterizationChanges || []).join('\n'))}</textarea>
    <label class="field-label">Rasgos originales del personaje que DEBEN permanecer intactos (uno por línea)</label>
    <textarea id="ov-preserve" rows="3">${escapeHtml((ov.preserveCoreTraits || []).join('\n'))}</textarea>
    <label class="field-label">Cambios opcionales de trasfondo (backstory)</label><textarea id="ov-backstory" rows="2">${escapeHtml(ov.backstoryChanges || '')}</textarea>
    <label class="field-label">Cambios opcionales de relaciones (uno por línea: id: descripción)</label><textarea id="ov-rel" rows="2">${escapeHtml(typeof ov.relationshipChanges === 'string' ? ov.relationshipChanges : dynamicsToLines(ov.relationshipChanges))}</textarea>
    <div class="grid-2">
      <div><label class="field-label">Prioridad</label><input type="number" id="ov-priority" value="${Number.isFinite(Number(ov.priority)) ? Number(ov.priority) : 50}"></div>
      <div><label class="field-label">Grupo de conflicto (opcional)</label><input type="text" id="ov-group" value="${escapeHtml(ov.conflictGroup || '')}" placeholder="ej: levi_personality_variant"></div>
    </div>
    <label class="field-label">Condiciones de activación (una por línea)</label><textarea id="ov-conditions" rows="2">${escapeHtml((ov.activationConditions || []).join('\n'))}</textarea>
    <div class="btn-row"><button type="button" class="btn btn-primary" id="ov-save-btn">Guardar plantilla de overlay</button><button type="button" class="btn btn-ghost" id="ov-cancel-btn">Cancelar</button></div>`);
  document.getElementById('ov-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('ov-save-btn').addEventListener('click', async () => {
    try {
      await saveCharacterOverlay({
        id: document.getElementById('ov-id').value.trim() || undefined,
        baseCharacterId: document.getElementById('ov-base').value.trim(),
        name: document.getElementById('ov-name').value.trim(),
        fandom: document.getElementById('ov-fandom').value.trim() || 'neutral',
        description: document.getElementById('ov-desc').value.trim(),
        characterizationChanges: linesToArray(document.getElementById('ov-changes').value),
        preserveCoreTraits: linesToArray(document.getElementById('ov-preserve').value),
        backstoryChanges: document.getElementById('ov-backstory').value.trim(),
        relationshipChanges: linesToDynamics(document.getElementById('ov-rel').value),
        priority: parseInt(document.getElementById('ov-priority').value, 10) || 50,
        conflictGroup: document.getElementById('ov-group').value.trim(),
        activationConditions: linesToArray(document.getElementById('ov-conditions').value),
      }, { authorEdited: true });
      toast('Plantilla de overlay guardada (desactivada por defecto).');
      closeModal();
      renderCharacters(root);
    } catch (err) {
      toast(err.message || 'No se pudo guardar el overlay.', { error: true });
    }
  });
}

function openResolvedPreviewModal(universalProfile, storyCharacter, overlays, storyConfig) {
  const renderPreview = (version, sceneId) => {
    const resolved = resolveCharacterProfile({
      universalProfile,
      storyCharacter,
      overlays,
      activations: storyConfig?.overlayActivations || [],
      context: {
        characterVersion: version,
        sceneId: sceneId || null,
        fandom: storyConfig?.fandom || universalProfile?.fandom || 'neutral',
        approvedConflictWinners: storyConfig?.approvedConflictWinners || {},
      },
    });
    const eff = resolved.effectiveProfile;
    return `
      <div class="chip-row" style="margin:8px 0;">
        <span class="pill ${resolved.isStandardDefault ? 'pill-active' : 'pill-character'}">${resolved.isStandardDefault ? 'Perfil estándar (sin overlays activos)' : `${resolved.appliedOverlays.length} overlay(s) aplicado(s)`}</span>
        ${resolved.unconfiguredOverlays.length ? `<span class="pill pill-canon">⚠️ ${resolved.unconfiguredOverlays.length} overlay sin configurar</span>` : ''}
        ${resolved.conflicts.length ? `<span class="pill pill-canon">🛑 ${resolved.conflicts.length} conflicto(s)</span>` : ''}
      </div>
      ${resolved.warnings.map((w) => `<div class="context-guard-item context-guard-warning">${escapeHtml(w.message)}</div>`).join('')}
      ${resolved.conflicts.map((c) => `<div class="context-guard-item context-guard-critical">${escapeHtml(c.message)}</div>`).join('')}
      <div class="paper" style="padding:12px; font-size:13px;">
        <div><b>Nombre:</b> ${escapeHtml(eff.name)} (${escapeHtml(eff.pronouns || 'sin pronombres')})</div>
        <div><b>Ámbito evaluado:</b> versión=${escapeHtml(eff.characterVersion)}${eff.sceneId ? `, escena=${escapeHtml(eff.sceneId)}` : ''}</div>
        ${eff.corePersonality ? `<div style="margin-top:6px;"><b>Personalidad efectiva:</b> ${escapeHtml(eff.corePersonality)}</div>` : ''}
        ${eff.overlayTraits.length ? `<div style="margin-top:6px;"><b>Rasgos de overlay aplicados:</b> ${escapeHtml(eff.overlayTraits.join(' · '))}</div>` : ''}
        ${eff.antiPatterns.length ? `<div style="margin-top:6px;"><b>Anti-patrones:</b> ${escapeHtml(eff.antiPatterns.join('; '))}</div>` : ''}
      </div>`;
  };

  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">🔎 Vista previa resuelta (0 tokens)</h3>
    <p class="muted">Muestra exactamente qué perfil y qué overlays se resolverían para este personaje sin gastar créditos de IA.</p>
    <div class="grid-2">
      <div><label class="field-label">Versión de personaje</label><select id="prev-version"><option value="default">default</option><option value="room">room (sala)</option><option value="screen">screen (pantalla)</option><option value="outside">outside (exterior)</option></select></div>
      <div><label class="field-label">ID de escena (opcional)</label><input type="text" id="prev-scene" placeholder="ej: ch3-s2"></div>
    </div>
    <div id="prev-body">${renderPreview('default', '')}</div>
    <div class="btn-row"><button type="button" class="btn btn-ghost" id="prev-close-btn">Cerrar</button></div>`);
  const update = () => {
    const v = document.getElementById('prev-version').value;
    const s = document.getElementById('prev-scene').value.trim();
    document.getElementById('prev-body').innerHTML = renderPreview(v, s);
  };
  document.getElementById('prev-version').addEventListener('change', update);
  document.getElementById('prev-scene').addEventListener('input', update);
  document.getElementById('prev-close-btn').addEventListener('click', closeModal);
}
