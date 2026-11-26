// inkyWallet.js — Configuración de modelos (primario y auxiliar), esfuerzo de
// razonamiento donde esté soportado oficialmente, tabla configurable de precios
// con fuente y fecha de actualización, estimación de costos vs uso real reportado
// por el proveedor, límites de gasto por generación y registro local (`usageLog`).
//
// Reglas no negociables:
// - Las claves API permanecen estrictamente locales en IndexedDB y JAMÁS entran en
//   `usageLog`, copias de seguridad, reportes del Inspector ni prompts.
// - Nunca inventa precios para modelos sin tarifa conocida: muestra `costo desconocido`.
// - Nunca presenta el uso local estimado como si fuera el saldo real de la cuenta de OpenAI.
// - Advierte explícitamente que solicitudes fallidas o canceladas pueden generar cargos.
// - Nunca hace fallback silencioso a otro modelo ni reintentos pagados en segundo plano.

import { db } from './db.js';
import { getModelOutputLimit } from './providers/index.js';

export const WALLET_SETTINGS_ID = 'inky-wallet';

export const WALLET_NOTICES = {
  apiModelIdNote:
    'Los nombres de producto de ChatGPT web (p. ej. "GPT-5 Thinking") NO son siempre IDs válidos de la API de OpenAI. Usa IDs documentados de API o introduce un ID personalizado verificando sus capacidades.',
  localUsageNotAccountBalance:
    'El uso registrado aquí es un estimado/registro local de Inky Paws y NO equivale al saldo real de tu cuenta de OpenAI u otro proveedor. Verifica siempre tu facturación oficial en la consola del proveedor.',
  failedOrCancelledChargeWarning:
    'Aviso de facturación: las solicitudes que fallan a mitad del proceso, alcanzan límite de salida o son canceladas tras enviarse aún pueden generar cargos parciales en el proveedor.',
  geminiBillingNotice:
    'Gemini permanece sin facturación activada por defecto; OpenRouter se limita exclusivamente a IDs gratuitos (`:free` / `openrouter/free`).',
};

/**
 * Catálogo documentado de IDs de API oficiales (sin inventar nombres de producto web).
 * Las tarifas son configurables por la autora y llevan metadatos de fuente y fecha.
 */
export const MODEL_CATALOG = {
  openai: [
    {
      id: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini (API · económico y rápido)',
      roleRecommendation: 'both',
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
      maxOutputTokens: 65536,
      pricing: {
        inputPer1M: 0.75,
        outputPer1M: 4.50,
        cachedInputPer1M: 0.075,
        source: 'Tabla configurable local de referencia (OpenAI API · editable en Ajustes)',
        lastUpdated: '2026-11-26',
      },
    },
    {
      id: 'gpt-5.4',
      label: 'GPT-5.4 (API · prosa literaria principal)',
      roleRecommendation: 'primary',
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
      maxOutputTokens: 65536,
      pricing: {
        inputPer1M: 2.50,
        outputPer1M: 15.00,
        cachedInputPer1M: 0.25,
        source: 'Tabla configurable local de referencia (OpenAI API · editable en Ajustes)',
        lastUpdated: '2026-11-26',
      },
    },
    {
      id: 'gpt-4.1',
      label: 'GPT-4.1 (API · ventana amplia, sin reasoning effort)',
      roleRecommendation: 'primary',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 32768,
      pricing: {
        inputPer1M: 2.00,
        outputPer1M: 8.00,
        cachedInputPer1M: 0.50,
        source: 'Tabla configurable local de referencia (OpenAI API · editable en Ajustes)',
        lastUpdated: '2026-11-26',
      },
    },
    {
      id: 'gpt-4.1-mini',
      label: 'GPT-4.1 Mini (API · auxiliar económico)',
      roleRecommendation: 'auxiliary',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 32768,
      pricing: {
        inputPer1M: 0.40,
        outputPer1M: 1.60,
        cachedInputPer1M: 0.10,
        source: 'Tabla configurable local de referencia (OpenAI API · editable en Ajustes)',
        lastUpdated: '2026-11-26',
      },
    },
    {
      id: 'o3-mini',
      label: 'o3-mini (API · razonamiento analítico)',
      roleRecommendation: 'auxiliary',
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      maxOutputTokens: 65536,
      pricing: {
        inputPer1M: 1.10,
        outputPer1M: 4.40,
        cachedInputPer1M: 0.55,
        source: 'Tabla configurable local de referencia (OpenAI API · editable en Ajustes)',
        lastUpdated: '2026-11-26',
      },
    },
  ],
  gemini: [
    {
      id: 'gemini-2.0-flash',
      label: 'Gemini 2.0 Flash (API · sin facturación activada)',
      roleRecommendation: 'both',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 8192,
      pricing: null, // Sin facturación activada: no inventar tarifa activa
    },
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash (API · sin facturación activada)',
      roleRecommendation: 'both',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 65536,
      pricing: null,
    },
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro (API · sin facturación activada)',
      roleRecommendation: 'primary',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 65536,
      pricing: null,
    },
  ],
  openrouter: [
    {
      id: 'arcee-ai/trinity-large-preview:free',
      label: 'Arcee Trinity Large Preview (:free · sin costo)',
      roleRecommendation: 'both',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 8192,
      pricing: {
        inputPer1M: 0,
        outputPer1M: 0,
        cachedInputPer1M: 0,
        source: 'OpenRouter free tier (:free)',
        lastUpdated: '2026-11-26',
      },
    },
    {
      id: 'openrouter/free',
      label: 'OpenRouter Free Router (gratuito)',
      roleRecommendation: 'both',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      maxOutputTokens: 8192,
      pricing: {
        inputPer1M: 0,
        outputPer1M: 0,
        cachedInputPer1M: 0,
        source: 'OpenRouter free router',
        lastUpdated: '2026-11-26',
      },
    },
  ],
};

export const REASONING_EFFORT_OPTIONS = ['none', 'low', 'medium', 'high'];

// Registro en memoria de la sesión actual (para distinguir sesión vs total histórico persistido)
const sessionUsageEvents = [];

function cleanString(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegativeNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getCatalogModelInfo(providerId, modelId) {
  const pid = cleanString(providerId).toLowerCase();
  const mid = cleanString(modelId);
  const list = MODEL_CATALOG[pid] || [];
  const exact = list.find((m) => m.id.toLowerCase() === mid.toLowerCase());
  if (exact) {
    return {
      ...exact,
      isCustomModel: false,
      capabilityWarning: '',
    };
  }

  const isFreeOpenRouter = pid === 'openrouter' && (mid === 'openrouter/free' || /:free$/i.test(mid));
  const inferredReasoning = pid === 'openai' && /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(mid);
  return {
    id: mid,
    label: mid ? `${mid} (ID personalizado)` : '(sin modelo)',
    roleRecommendation: 'both',
    supportsReasoningEffort: inferredReasoning,
    supportedReasoningEfforts: inferredReasoning ? ['none', 'low', 'medium', 'high'] : [],
    maxOutputTokens: getModelOutputLimit(pid, mid),
    pricing: isFreeOpenRouter
      ? { inputPer1M: 0, outputPer1M: 0, cachedInputPer1M: 0, source: 'OpenRouter :free', lastUpdated: '2026-11-26' }
      : null,
    isCustomModel: Boolean(mid),
    capabilityWarning: mid
      ? `ID personalizado («${mid}»): verifica que sea un ID oficial de API de ${pid || 'tu proveedor'} (no un nombre comercial web) y configura su tarifa si deseas ver costo estimado.`
      : '',
  };
}

export function supportsReasoningEffort(providerId, modelId) {
  return Boolean(getCatalogModelInfo(providerId, modelId).supportsReasoningEffort);
}

export function normalizeReasoningEffort(providerId, modelId, requestedEffort) {
  const info = getCatalogModelInfo(providerId, modelId);
  if (!info.supportsReasoningEffort) return null;
  const eff = cleanString(requestedEffort).toLowerCase();
  if (info.supportedReasoningEfforts.includes(eff)) return eff;
  return info.supportedReasoningEfforts.includes('none') ? 'none' : (info.supportedReasoningEfforts[0] || null);
}

export function createDefaultWalletConfig(mainSettings = null) {
  const provider = cleanString(mainSettings?.provider || 'openai').toLowerCase() || 'openai';
  const primaryModel = cleanString(mainSettings?.models?.[provider]) ||
    (provider === 'openai' ? 'gpt-5.4-mini' : provider === 'openrouter' ? 'arcee-ai/trinity-large-preview:free' : 'gemini-2.0-flash');
  const auxModel = provider === 'openai' ? 'gpt-5.4-mini' : primaryModel;

  return {
    id: WALLET_SETTINGS_ID,
    primaryProvider: provider,
    primaryModel,
    auxiliaryProvider: provider,
    auxiliaryModel: auxModel,
    reasoningEffort: 'none',
    optionalAnalysis: {
      prepEnabled: false,
      semanticReviewEnabled: false,
      continuityExtractionEnabled: false,
    },
    maxOutputTokensPerRequest: 16384,
    maxGenerationSpendUsd: 0.50,
    customPricingTable: {},
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeWalletConfig(raw, { mainSettings = null } = {}) {
  const defaults = createDefaultWalletConfig(mainSettings);
  const src = isPlainObject(raw) ? raw : {};

  const primaryProvider = ['openai', 'gemini', 'openrouter'].includes(cleanString(src.primaryProvider).toLowerCase())
    ? cleanString(src.primaryProvider).toLowerCase()
    : defaults.primaryProvider;
  const auxiliaryProvider = ['openai', 'gemini', 'openrouter'].includes(cleanString(src.auxiliaryProvider).toLowerCase())
    ? cleanString(src.auxiliaryProvider).toLowerCase()
    : primaryProvider;

  const primaryModel = cleanString(src.primaryModel) || cleanString(mainSettings?.models?.[primaryProvider]) || defaults.primaryModel;
  const auxiliaryModel = cleanString(src.auxiliaryModel) || primaryModel;
  const reasoningEffort = REASONING_EFFORT_OPTIONS.includes(cleanString(src.reasoningEffort).toLowerCase())
    ? cleanString(src.reasoningEffort).toLowerCase()
    : 'none';

  const rawMaxOut = Number(src.maxOutputTokensPerRequest);
  const maxOutputTokensPerRequest = Number.isFinite(rawMaxOut) && rawMaxOut >= 256
    ? Math.min(65536, Math.floor(rawMaxOut))
    : defaults.maxOutputTokensPerRequest;

  const rawMaxSpend = toNonNegativeNumber(src.maxGenerationSpendUsd, defaults.maxGenerationSpendUsd);
  const maxGenerationSpendUsd = rawMaxSpend === null ? defaults.maxGenerationSpendUsd : Number(rawMaxSpend.toFixed(4));

  const customPricingTable = {};
  if (isPlainObject(src.customPricingTable)) {
    for (const [key, entry] of Object.entries(src.customPricingTable)) {
      if (!isPlainObject(entry)) continue;
      const inputPer1M = toNonNegativeNumber(entry.inputPer1M, null);
      const outputPer1M = toNonNegativeNumber(entry.outputPer1M, null);
      const cachedInputPer1M = toNonNegativeNumber(entry.cachedInputPer1M, null);
      if (inputPer1M === null || outputPer1M === null) continue;
      customPricingTable[cleanString(key)] = {
        inputPer1M,
        outputPer1M,
        cachedInputPer1M: cachedInputPer1M ?? inputPer1M,
        source: cleanString(entry.source || 'Tarifa personalizada por la autora'),
        lastUpdated: cleanString(entry.lastUpdated || new Date().toISOString().slice(0, 10)),
      };
    }
  }

  const rawOpt = isPlainObject(src.optionalAnalysis) ? src.optionalAnalysis : {};
  return {
    id: WALLET_SETTINGS_ID,
    primaryProvider,
    primaryModel,
    auxiliaryProvider,
    auxiliaryModel,
    reasoningEffort,
    optionalAnalysis: {
      prepEnabled: rawOpt.prepEnabled === true,
      semanticReviewEnabled: rawOpt.semanticReviewEnabled === true,
      continuityExtractionEnabled: rawOpt.continuityExtractionEnabled === true,
    },
    maxOutputTokensPerRequest,
    maxGenerationSpendUsd,
    customPricingTable,
    updatedAt: src.updatedAt || new Date().toISOString(),
  };
}

export async function getWalletConfig() {
  const [stored, mainSettings] = await Promise.all([
    db.get('settings', WALLET_SETTINGS_ID),
    db.get('settings', 'main'),
  ]);
  return normalizeWalletConfig(stored, { mainSettings });
}

export async function saveWalletConfig(patch) {
  const [existing, mainSettings] = await Promise.all([
    db.get('settings', WALLET_SETTINGS_ID),
    db.get('settings', 'main'),
  ]);
  const merged = normalizeWalletConfig({ ...(existing || {}), ...(patch || {}), updatedAt: new Date().toISOString() }, { mainSettings });
  await db.put('settings', merged);
  return merged;
}

/**
 * Resuelve la tarifa aplicable para un par (proveedor, modelo) usando primero la
 * tabla personalizada de la autora y luego el catálogo documentado.
 * Si no existe tarifa confiable, devuelve `null` (NUNCA inventa un precio).
 */
export function resolveModelPricing(providerId, modelId, walletConfig = null) {
  const pid = cleanString(providerId).toLowerCase();
  const mid = cleanString(modelId);
  const custom = walletConfig?.customPricingTable || {};
  const exactKey = `${pid}:${mid}`;
  if (custom[exactKey]) return { ...custom[exactKey], pricingOrigin: 'custom_author_table' };
  if (custom[mid]) return { ...custom[mid], pricingOrigin: 'custom_author_table' };

  const info = getCatalogModelInfo(pid, mid);
  if (info.pricing) {
    return { ...info.pricing, pricingOrigin: 'documented_reference_table' };
  }
  return null;
}

export function estimateTokensFromText(text) {
  const len = String(text || '').length;
  return len ? Math.ceil(len / 4) : 0;
}

export function estimateOutputTokensForWords(targetWords) {
  const w = Math.max(50, Number(targetWords) || 1000);
  // Prosa literaria en inglés ≈ 1.35–1.55 tokens/palabra + margen estructural
  return Math.ceil(w * 1.55);
}

/**
 * Calcula costo estimado o real a partir de tokens.
 * Si no existe tarifa configurada, devuelve `costStatus: 'unknown'` y `displayCost: 'costo desconocido'`.
 */
export function calculateTokenCost({
  providerId,
  modelId,
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  walletConfig = null,
  isActual = false,
} = {}) {
  const pricing = resolveModelPricing(providerId, modelId, walletConfig);
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const cachedTok = Math.min(inTok, Math.max(0, Number(cachedInputTokens) || 0));
  const billableIn = Math.max(0, inTok - cachedTok);

  if (!pricing) {
    return {
      costStatus: 'unknown',
      costUsd: null,
      displayCost: 'costo desconocido',
      pricingSource: null,
      pricingLastUpdated: null,
      isActual: Boolean(isActual),
    };
  }

  const isFree = pricing.inputPer1M === 0 && pricing.outputPer1M === 0;
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;
  const costUsd =
    (billableIn / 1_000_000) * pricing.inputPer1M +
    (cachedTok / 1_000_000) * cachedRate +
    (outTok / 1_000_000) * pricing.outputPer1M;

  return {
    costStatus: isFree ? 'free' : (isActual ? 'actual' : 'estimated'),
    costUsd: Number(costUsd.toFixed(6)),
    displayCost: isFree ? '$0.00 (gratuito)' : `$${costUsd.toFixed(4)} USD`,
    pricingSource: pricing.source || 'Tabla configurable',
    pricingLastUpdated: pricing.lastUpdated || '',
    isActual: Boolean(isActual),
  };
}

/**
 * Verifica si una generación o paso planificado respeta el límite de gasto autorizado.
 */
export function checkGenerationBudget({
  estimatedAdditionalUsd = null,
  spentSoFarUsd = 0,
  maxGenerationSpendUsd = 0.50,
} = {}) {
  const cap = toNonNegativeNumber(maxGenerationSpendUsd, null);
  const spent = Math.max(0, Number(spentSoFarUsd) || 0);
  if (cap === null || cap === 0) {
    return { allowed: true, reason: 'no_cap_configured', projectedUsd: estimatedAdditionalUsd !== null ? spent + estimatedAdditionalUsd : null, capUsd: cap };
  }
  if (spent >= cap) {
    return {
      allowed: false,
      reason: 'spending_limit_reached',
      projectedUsd: spent,
      capUsd: cap,
      message: `Límite de gasto por generación alcanzado ($${spent.toFixed(4)} / $${cap.toFixed(2)} USD). La generación se detuvo para proteger tu presupuesto.`,
    };
  }
  if (estimatedAdditionalUsd !== null && spent + estimatedAdditionalUsd > cap) {
    return {
      allowed: false,
      reason: 'estimated_cost_exceeds_limit',
      projectedUsd: Number((spent + estimatedAdditionalUsd).toFixed(6)),
      capUsd: cap,
      message: `El costo estimado ($${(spent + estimatedAdditionalUsd).toFixed(4)} USD) supera tu límite autorizado por generación ($${cap.toFixed(2)} USD). Ajusta el límite en Inky Wallet o reduce la extensión.`,
    };
  }
  return {
    allowed: true,
    reason: estimatedAdditionalUsd === null ? 'unknown_pricing_proceed_with_caution' : 'within_budget',
    projectedUsd: estimatedAdditionalUsd !== null ? Number((spent + estimatedAdditionalUsd).toFixed(6)) : null,
    capUsd: cap,
  };
}

/**
 * Registra un evento de uso local en `usageLog` (IndexedDB) y en la sesión actual.
 * JAMÁS almacena claves API, cabeceras de autorización ni prompts completos con secretos.
 */
export async function recordUsageEvent({
  projectId = '',
  operation = 'chapter_generation',
  provider = '',
  model = '',
  role = 'primary',
  status = 'ok',
  estimatedInputTokens = 0,
  estimatedOutputTokens = 0,
  providerUsage = null,
  walletConfig = null,
  errorType = null,
} = {}) {
  const pid = cleanString(projectId) || (typeof db.getActiveProjectId === 'function' ? db.getActiveProjectId() : 'original');
  const reported = isPlainObject(providerUsage) && providerUsage.reportedByProvider === true;
  const actualInputTokens = reported ? Math.max(0, Number(providerUsage.promptTokens) || 0) : null;
  const actualOutputTokens = reported ? Math.max(0, Number(providerUsage.completionTokens) || 0) : null;
  const actualCachedTokens = reported ? Math.max(0, Number(providerUsage.cachedTokens) || 0) : 0;
  const actualReasoningTokens = reported ? Math.max(0, Number(providerUsage.reasoningTokens) || 0) : 0;

  const estimatedCost = calculateTokenCost({
    providerId: provider,
    modelId: model,
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    walletConfig,
    isActual: false,
  });

  const actualCost = reported
    ? calculateTokenCost({
        providerId: provider,
        modelId: model,
        inputTokens: actualInputTokens,
        outputTokens: actualOutputTokens,
        cachedInputTokens: actualCachedTokens,
        walletConfig,
        isActual: true,
      })
    : null;

  const entry = {
    id: db.uid(),
    projectId: pid,
    operation: cleanString(operation || 'chapter_generation'),
    provider: cleanString(provider || 'unknown'),
    model: cleanString(model || 'unknown'),
    role: role === 'auxiliary' ? 'auxiliary' : 'primary',
    status: cleanString(status || 'ok'),
    errorType: errorType ? cleanString(errorType) : null,
    usageSource: reported ? 'provider_reported_actual' : 'local_character_estimate',
    estimatedInputTokens: Math.max(0, Math.floor(Number(estimatedInputTokens) || 0)),
    estimatedOutputTokens: Math.max(0, Math.floor(Number(estimatedOutputTokens) || 0)),
    actualInputTokens,
    actualOutputTokens,
    actualCachedTokens,
    actualReasoningTokens,
    estimatedCostUsd: estimatedCost.costUsd,
    actualCostUsd: actualCost ? actualCost.costUsd : null,
    costStatus: actualCost ? actualCost.costStatus : estimatedCost.costStatus,
    mayHaveIncurredPartialCharge: status !== 'ok' && errorType !== 'auth' && errorType !== 'budget_blocked',
    createdAt: new Date().toISOString(),
  };

  sessionUsageEvents.push(entry);
  try {
    await db.put('usageLog', entry);
  } catch {
    // En pruebas unitarias sin IndexedDB, mantener el registro de sesión en memoria
  }
  return entry;
}

export function resetSessionUsageForTests() {
  sessionUsageEvents.length = 0;
}

function summarizeEvents(events = []) {
  let requests = 0;
  let actualInputTokens = 0;
  let actualOutputTokens = 0;
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;
  let actualCostUsd = 0;
  let estimatedCostUsd = 0;
  let unknownCostRequests = 0;
  let actualReportedRequests = 0;

  for (const ev of (events || [])) {
    if (!ev) continue;
    requests += 1;
    estimatedInputTokens += Number(ev.estimatedInputTokens) || 0;
    estimatedOutputTokens += Number(ev.estimatedOutputTokens) || 0;
    if (ev.usageSource === 'provider_reported_actual') {
      actualReportedRequests += 1;
      actualInputTokens += Number(ev.actualInputTokens) || 0;
      actualOutputTokens += Number(ev.actualOutputTokens) || 0;
    }
    if (ev.actualCostUsd !== null && ev.actualCostUsd !== undefined) {
      actualCostUsd += Number(ev.actualCostUsd) || 0;
    } else if (ev.estimatedCostUsd !== null && ev.estimatedCostUsd !== undefined) {
      estimatedCostUsd += Number(ev.estimatedCostUsd) || 0;
    } else {
      unknownCostRequests += 1;
    }
  }

  return {
    requests,
    actualReportedRequests,
    actualInputTokens,
    actualOutputTokens,
    estimatedInputTokens,
    estimatedOutputTokens,
    actualCostUsd: Number(actualCostUsd.toFixed(6)),
    estimatedOnlyCostUsd: Number(estimatedCostUsd.toFixed(6)),
    combinedKnownCostUsd: Number((actualCostUsd + estimatedCostUsd).toFixed(6)),
    unknownCostRequests,
  };
}

export async function getUsageSummary() {
  let all = [];
  try {
    all = await db.getAll('usageLog');
  } catch {
    all = [...sessionUsageEvents];
  }
  return {
    session: summarizeEvents(sessionUsageEvents),
    totalRecorded: summarizeEvents(all),
    recentEvents: [...(all || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 15),
    notices: WALLET_NOTICES,
  };
}
