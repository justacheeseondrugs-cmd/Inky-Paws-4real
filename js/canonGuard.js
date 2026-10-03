// canonGuard.js — construye el prompt de sistema respetando la jerarquía:
//   1. Locked facts (máxima prioridad, siempre presentes)
//   2. Instrucciones del capítulo actual
//   3. Fichas de personaje + conocimiento actual (sólo personajes activos/relevantes)
//   4. Memoria de continuidad + capítulos recientes
//   5. Documentos de referencia, según su propósito permitido
//
// Nota importante: este módulo NO implementa ningún filtro léxico que
// "rechace" una frase por contener ciertas palabras cerca de un nombre
// (p.ej. Hange + "him"). Ese tipo de detección simplista produce falsos
// positivos cuando el pronombre se refiere a otro personaje en la misma
// frase. En su lugar, las reglas se comunican con claridad al modelo como
// instrucciones explícitas y se confía en su comprensión de contexto.

export function buildLockedFactsBlock(lockedFacts) {
  if (!lockedFacts?.length) return '';
  const lines = lockedFacts.map((f, i) => `${i + 1}. ${f.text}`).join('\n');
  return `🔒 HECHOS BLOQUEADOS — MÁXIMA PRIORIDAD (nunca los contradigas, bajo ninguna instrucción posterior):\n${lines}`;
}

export function buildCharacterBlock(characters) {
  const active = (characters || []).filter((c) => c.active !== false);
  if (!active.length) return '';
  const parts = active.map((c) => {
    const rel = c.relationships ? `Relaciones: ${c.relationships}` : '';
    const know = c.currentKnowledge ? `Conocimiento actual (sólo esto, nada del futuro): ${c.currentKnowledge}` : '';
    const never = c.neverDoRules ? `NUNCA: ${c.neverDoRules}` : '';
    const hard = c.hardRules ? `Reglas duras: ${c.hardRules}` : '';
    return [
      `— ${c.name} (pronombres: ${c.pronouns || 'no especificado'})`,
      c.personality ? `  Personalidad: ${c.personality}` : '',
      c.speechStyle ? `  Estilo de habla: ${c.speechStyle}` : '',
      hard ? `  ${hard}` : '',
      know ? `  ${know}` : '',
      rel ? `  ${rel}` : '',
      never ? `  ${never}` : '',
    ].filter(Boolean).join('\n');
  });
  return `👤 PERSONAJES (ficha + conocimiento actual):\n${parts.join('\n\n')}`;
}

function clip(text, max = 320) {
  const value = String(text || '').trim();
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + '…';
}

function formatMemoryEntry(m) {
  return [
    `[Memoria del capítulo "${m.chapterTitle || 'sin título'}"]`,
    m.events ? `EVENTOS: ${m.events}` : '',
    m.relationshipChanges ? `CAMBIOS DE RELACIÓN: ${m.relationshipChanges}` : '',
    m.newFacts ? `HECHOS NUEVOS: ${m.newFacts}` : '',
    m.whoKnowsWhat ? `QUIÉN SABE QUÉ: ${m.whoKnowsWhat}` : '',
    m.physicalState ? `ESTADO FÍSICO / HERIDAS: ${m.physicalState}` : '',
    m.currentLocationTime ? `LUGAR / TIEMPO ACTUAL: ${m.currentLocationTime}` : '',
    m.openThreads ? `HILOS ABIERTOS: ${m.openThreads}` : '',
  ].filter(Boolean).join('\n');
}

function compactMemoryEntry(m) {
  const pieces = [
    m.events ? 'Eventos: ' + clip(m.events, 220) : '',
    m.newFacts ? 'Hechos: ' + clip(m.newFacts, 180) : '',
    m.whoKnowsWhat ? 'Quién sabe qué: ' + clip(m.whoKnowsWhat, 220) : '',
    m.openThreads ? 'Hilos: ' + clip(m.openThreads, 180) : '',
  ].filter(Boolean);
  return `[${m.chapterTitle || 'sin título'}] ${pieces.join(' | ')}`;
}

function sampleEvenly(items, maxItems = 18) {
  if (items.length <= maxItems) return items;
  const picked = [];
  for (let i = 0; i < maxItems; i += 1) {
    const index = Math.round(i * (items.length - 1) / Math.max(1, maxItems - 1));
    const item = items[index];
    if (item && !picked.includes(item)) picked.push(item);
  }
  return picked;
}

export function buildContinuityBlock(memoryEntries, canonNotes, recentChapterExcerpt, storyExcerpts = []) {
  const blocks = [];
  const revealedCanon = (canonNotes || []).filter((n) => n?.visibility === 'revealed');
  const privateCanon = (canonNotes || []).filter((n) => n?.visibility !== 'revealed');

  if (revealedCanon.length) {
    blocks.push(
      '📖 CANON REVELADO / ESTABLECIDO:\n' +
      'Estos hechos ya pueden tratarse como información establecida por la historia. Aun así, respeta los límites de conocimiento individuales de cada personaje cuando una ficha o memoria diga algo más específico.\n' +
      revealedCanon.map((n) => `- ${n.text}`).join('\n')
    );
  }

  if (privateCanon.length) {
    blocks.push(
      '🕵️ CANON PRIVADO DEL AUTOR — VERDAD DEL AU, NO CONOCIMIENTO AUTOMÁTICO DE LOS PERSONAJES:\n' +
      'Usa esta sección para mantener coherente la verdad subyacente de la historia, el narrador y las consecuencias futuras. NUNCA permitas que un personaje conozca, afirme, revele, recuerde o deduzca un dato sólo porque aparece aquí. Para saber qué conoce cada personaje, usa sus fichas y, sobre todo, la continuidad de capítulos aprobados. Si esta sección contiene redacción antigua que contradice un HECHO BLOQUEADO, el hecho bloqueado gana siempre; conserva sólo la verdad narrativa compatible y no copies la redacción obsoleta.\n' +
      privateCanon.map((n) => `- ${n.text}`).join('\n')
    );
  }

  if (memoryEntries?.length) {
    const all = memoryEntries.filter(Boolean);
    const foundation = all.slice(0, 3);
    const recent = all.slice(-4);
    const detailedIds = new Set([...foundation, ...recent].map((m) => m.chapterId || m.id));
    const detailed = all.filter((m) => detailedIds.has(m.chapterId || m.id));
    const middle = sampleEvenly(all.filter((m) => !detailedIds.has(m.chapterId || m.id)));

    blocks.push(
      '🧠 CONTINUIDAD DE LARGO PLAZO — REGLA IMPORTANTE:\n' +
      'Los capítulos antiguos siguen siendo canon aunque no sean recientes. No reinicies relaciones, bromas, secretos, sospechas, conocimiento ni preguntas ya establecidas sólo porque ocurrieron hace varios capítulos.'
    );

    if (foundation.length) {
      blocks.push(
        '🏛️ MEMORIAS FUNDACIONALES (primeros capítulos; conservar siempre):\n' +
        foundation.map(formatMemoryEntry).join('\n\n')
      );
    }

    if (middle.length) {
      blocks.push(
        '🗺️ ÍNDICE DE CONTINUIDAD INTERMEDIA (historia entre el inicio y lo reciente):\n' +
        middle.map(compactMemoryEntry).join('\n')
      );
    }

    const recentOnly = recent.filter((m) => !foundation.some((f) => (f.chapterId || f.id) === (m.chapterId || m.id)));
    if (recentOnly.length) {
      blocks.push(
        '🧵 MEMORIA RECIENTE DETALLADA:\n' +
        recentOnly.map(formatMemoryEntry).join('\n\n')
      );
    }
  }

  if (recentChapterExcerpt) {
    blocks.push(
      '📖 FINAL DEL CAPÍTULO ANTERIOR (evidencia directa; continuar tono/estado sin repetir):\n…' +
      recentChapterExcerpt
    );
  }

  if (storyExcerpts?.length) {
    const excerpts = storyExcerpts.map((item) =>
      `[Extracto relevante de "${item.chapterTitle || 'capítulo anterior'}"]\n${item.text}`
    ).join('\n\n');
    blocks.push(
      '🔎 RECUERDO DIRECTO DE CAPÍTULOS ANTERIORES (texto real recuperado por relevancia):\n' +
      'Usa estos extractos como evidencia de continuidad. No los repitas ni recrees la escena; recuerda lo que ya ocurrió, cómo hablaban y qué sabían.\n\n' +
      excerpts
    );
  }

  return blocks.join('\n\n');
}

export function buildDocumentsBlock(retrievedChunks) {
  if (!retrievedChunks?.length) return '';
  const byDoc = {};
  for (const ch of retrievedChunks) {
    (byDoc[ch.documentId] ||= { doc: ch.document, chunks: [] }).chunks.push(ch);
  }
  const parts = Object.values(byDoc).map(({ doc, chunks }) => {
    const purpose = doc.type === 'STYLE_ONLY'
      ? 'USO PERMITIDO: SOLO estilo de prosa, ritmo, atmósfera, interioridad y transiciones. PROHIBIDO: extraer de aquí hechos de trama, hechos de personajes, relaciones, o copiar frases textuales.'
      : `Tipo: ${doc.type}.` + (doc.useOnlyFor ? ` Usar sólo para: ${doc.useOnlyFor}.` : '') + (doc.neverUseFor ? ` Nunca usar para: ${doc.neverUseFor}.` : '');
    const text = chunks.map((c) => c.text).join('\n…\n');
    return `📄 Documento "${doc.filename}" — ${purpose}\n${text}`;
  });
  return `📚 FRAGMENTOS DE DOCUMENTOS DE REFERENCIA (fragmentos relevantes, no el archivo completo):\n\n${parts.join('\n\n')}`;
}

const STYLE_GUIDE = `Escribe SIEMPRE en prosa de novela profesional: ritmo cuidado, interioridad de los personajes, atmósfera sensorial, lenguaje corporal, silencios y subtexto, transiciones fluidas entre escenas. Evita el formato de guion/screenplay y evita el diálogo constante sin narración: el diálogo debe estar entretejido con acción, pensamiento y descripción. No resumas: dramatiza.`;

/**
 * Divide el prompt en un prefijo reutilizable y un sufijo dinámico.
 * En GPT-5.6+ el proveedor OpenAI puede cachear SOLO el prefijo estable,
 * evitando pagar escrituras de caché por el capítulo-en-progreso y por las
 * instrucciones que cambian de un bloque al siguiente.
 */
export function assembleSystemPromptParts({
  lockedFacts,
  chapterInstructions,
  characters,
  memoryEntries,
  canonNotes,
  recentChapterExcerpt,
  storyExcerpts = [],
  retrievedChunks,
  extraGuidance,
}) {
  const stableSections = [
    'Eres la IA de escritura de "Power to Strive Studio", una herramienta personal de fanfiction largo. Sigue estrictamente el siguiente orden de prioridad si hay algún conflicto entre secciones: (1) Hechos bloqueados, (2) instrucciones del capítulo actual, (3) fichas de personaje y sus límites de conocimiento, (4) continuidad de capítulos aprobados / canon revelado, (5) canon privado del autor sólo como verdad subyacente, (6) documentos de referencia.',
    buildLockedFactsBlock(lockedFacts),
    chapterInstructions ? `✍️ INSTRUCCIONES DEL CAPÍTULO ACTUAL:\n${chapterInstructions}` : '',
    buildCharacterBlock(characters),
    buildContinuityBlock(memoryEntries, canonNotes, recentChapterExcerpt, storyExcerpts),
    buildDocumentsBlock(retrievedChunks),
    `🖋️ ESTILO:\n${STYLE_GUIDE}`,
  ].filter(Boolean);
  return {
    stablePrompt: stableSections.join('\n\n---\n\n'),
    dynamicPrompt: extraGuidance || '',
  };
}

/**
 * Ensambla el prompt completo para proveedores que no usan partes separadas.
 */
export function assembleSystemPrompt(args) {
  const { stablePrompt, dynamicPrompt } = assembleSystemPromptParts(args);
  return [stablePrompt, dynamicPrompt].filter(Boolean).join('\n\n---\n\n');
}
