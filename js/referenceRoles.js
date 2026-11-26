// referenceRoles.js — Biblioteca de referencias con 6 roles explícitos, compatibilidad
// con tipos heredados, perfiles de oficio literario para documentos STYLE_ONLY y
// separación estricta de líneas temporales (p.ej. PtS I-II vs PtS III Parte 1).
//
// Invariantes no negociables:
// - Recuperación factual y recuperación estilística (`STYLE_ONLY`) están separadas.
// - `STYLE_ONLY` (p.ej. Violet Evergarden, The Vow) aporta ÚNICAMENTE descriptores
//   generales de oficio literario; NUNCA importa tramas, personajes, diálogos ni relaciones
//   y NUNCA activa los Violet Traits de Levi.
// - Nunca copia pasajes textuales de historias de referencia al manuscrito generado.
// - Las líneas temporales alternativas (p.ej. Power to Strive III Parte 1) se mantienen
//   estrictamente separadas de la línea original (PtS I-II).

import { getRelevantChunks } from './retrieval.js';

export const REFERENCE_ROLES = [
  { id: 'CHARACTER_BIBLE', label: 'Biblia de personajes (CHARACTER_BIBLE)', factual: true, pillClass: 'pill-character' },
  { id: 'ORIGINAL_CANON', label: 'Canon original (ORIGINAL_CANON)', factual: true, pillClass: 'pill-canon' },
  { id: 'AU_CANON', label: 'Canon del AU (AU_CANON)', factual: true, pillClass: 'pill-continuity' },
  { id: 'STYLE_ONLY', label: 'Solo oficio / estilo literario (STYLE_ONLY)', factual: false, pillClass: 'pill-style' },
  { id: 'WORLD_BUILDING', label: 'Construcción de mundo (WORLD_BUILDING)', factual: true, pillClass: 'pill-reference' },
  { id: 'AUTHOR_INSTRUCTIONS', label: 'Instrucciones de la autora (AUTHOR_INSTRUCTIONS)', factual: true, pillClass: 'pill-active' },
];

export const REFERENCE_ROLE_MAP = new Map(REFERENCE_ROLES.map((r) => [r.id, r]));

export const LEGACY_ROLE_MAPPING = {
  CANON: 'AU_CANON',
  CHARACTER: 'CHARACTER_BIBLE',
  CONTINUITY: 'AU_CANON',
  REFERENCE: 'WORLD_BUILDING',
  STYLE_ONLY: 'STYLE_ONLY',
};

export const STYLE_CRAFT_DIMENSIONS = [
  { id: 'narrativeDistance', label: 'Distancia narrativa' },
  { id: 'scenePacing', label: 'Ritmo de escena' },
  { id: 'dialogueToNarrationBalance', label: 'Equilibrio diálogo / narración' },
  { id: 'interiorPerspective', label: 'Perspectiva interior' },
  { id: 'atmosphere', label: 'Atmósfera sensorial' },
  { id: 'paragraphFlow', label: 'Fluidez de párrafos' },
  { id: 'emotionalRestraint', label: 'Contención emocional' },
  { id: 'descriptionDensity', label: 'Densidad descriptiva' },
  { id: 'sceneTransitions', label: 'Transiciones entre escenas' },
];

export const TIMELINE_OPTIONS = [
  { id: 'shared_active', label: 'Compatible con la historia actual (general)' },
  { id: 'pts_i_ii_original', label: 'Power to Strive I–II (línea original)' },
  { id: 'pts_iii_part_1_alternate', label: 'Power to Strive III Parte 1 (continuación alternativa)' },
  { id: 'custom', label: 'Línea temporal personalizada' },
];

function cleanString(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normaliza un tipo de documento moderno o heredado a uno de los 6 roles oficiales.
 */
export function normalizeReferenceRole(rawType) {
  const t = cleanString(rawType).toUpperCase();
  if (REFERENCE_ROLE_MAP.has(t)) return t;
  if (LEGACY_ROLE_MAPPING[t]) return LEGACY_ROLE_MAPPING[t];
  return 'WORLD_BUILDING';
}

export function isStyleOnlyDocument(doc) {
  return normalizeReferenceRole(doc?.role || doc?.type) === 'STYLE_ONLY';
}

export function isFactualReferenceDocument(doc) {
  const role = normalizeReferenceRole(doc?.role || doc?.type);
  return Boolean(REFERENCE_ROLE_MAP.get(role)?.factual);
}

export function normalizeStyleCraftProfile(rawProfile) {
  const src = isPlainObject(rawProfile) ? rawProfile : {};
  const out = {};
  for (const dim of STYLE_CRAFT_DIMENSIONS) {
    out[dim.id] = cleanString(src[dim.id] || '');
  }
  return out;
}

/**
 * Verifica si un documento pertenece a una línea temporal compatible con la historia actual.
 * Garantiza que Power to Strive III Parte 1 no se mezcle automáticamente en la línea
 * original PtS I-II (ni viceversa).
 */
export function isDocumentTimelineCompatible(doc, activeTimelineId = '') {
  const docTimeline = cleanString(doc?.timelineId || 'shared_active');
  const active = cleanString(activeTimelineId || '');
  if (!active || !docTimeline || docTimeline === 'shared_active') return true;
  return docTimeline === active;
}

/**
 * Filtra y separa estrictamente los documentos activos de una historia en:
 * 1) `factualDocuments`: únicamente roles factuales compatibles con la línea temporal actual.
 * 2) `styleCraftProfiles`: descriptores generales de oficio literario para documentos `STYLE_ONLY`
 *    (sin copiar fragmentos de trama, personajes ni relaciones, y sin activar overlays).
 * 3) `excludedByTimeline` / `inactiveDocuments`: trazabilidad para inspección.
 */
export function partitionStoryReferences(documents = [], { activeTimelineId = '' } = {}) {
  const factualDocuments = [];
  const styleOnlyDocuments = [];
  const styleCraftProfiles = [];
  const excludedByTimeline = [];
  const inactiveDocuments = [];

  for (const doc of (documents || [])) {
    if (!doc) continue;
    if (doc.active === false) {
      inactiveDocuments.push({ id: doc.id, filename: doc.filename, role: normalizeReferenceRole(doc.role || doc.type) });
      continue;
    }
    const role = normalizeReferenceRole(doc.role || doc.type);
    const enriched = { ...doc, role };

    if (role === 'STYLE_ONLY') {
      styleOnlyDocuments.push(enriched);
      styleCraftProfiles.push({
        documentId: doc.id,
        filename: doc.filename,
        role: 'STYLE_ONLY',
        craftProfile: normalizeStyleCraftProfile(doc.styleCraftProfile),
        activatesCharacterOverlays: false,
        importsPlotOrCharacters: false,
        prohibitVerbatimCopying: true,
        safetyNote: 'Solo oficio literario (ritmo, distancia, atmósfera, contención). Nunca importa tramas, personajes, diálogos ni activa rasgos Violet.',
      });
      continue;
    }

    if (!isDocumentTimelineCompatible(enriched, activeTimelineId)) {
      excludedByTimeline.push({
        id: doc.id,
        filename: doc.filename,
        role,
        documentTimeline: enriched.timelineId,
        activeTimeline: activeTimelineId,
      });
      continue;
    }

    factualDocuments.push(enriched);
  }

  return {
    factualDocuments,
    styleOnlyDocuments,
    styleCraftProfiles,
    excludedByTimeline,
    inactiveDocuments,
  };
}

/**
 * Recuperación acotada y estrictamente separada para el motor de contexto:
 * - `factualChunks`: solo fragmentos de documentos factuales activos y compatibles en línea temporal.
 * - `styleGuidance`: únicamente perfiles de oficio literario de `STYLE_ONLY` (NUNCA pasajes textuales
 *   copiables ni hechos de trama).
 */
export function retrieveRoleSeparatedReferences({
  documents = [],
  docChunks = [],
  query = '',
  activeTimelineId = '',
  context = 'chapter_generation',
  maxFactualChunks = 6,
} = {}) {
  const partitioned = partitionStoryReferences(documents, { activeTimelineId });
  const rawFactualChunks = partitioned.factualDocuments.length
    ? getRelevantChunks(partitioned.factualDocuments, docChunks, query, { context }).slice(0, maxFactualChunks)
    : [];

  return {
    factualChunks: rawFactualChunks.map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      filename: c.document?.filename || '',
      role: normalizeReferenceRole(c.document?.role || c.document?.type),
      timelineId: c.document?.timelineId || 'shared_active',
      text: c.text,
      score: c.score,
    })),
    styleGuidance: partitioned.styleCraftProfiles,
    excludedByTimeline: partitioned.excludedByTimeline,
    inactiveCount: partitioned.inactiveDocuments.length,
    styleOnlyNeverActivatesOverlays: true,
    verbatimReferenceCopyingForbidden: true,
  };
}
