// index.js — fábrica de proveedores. Este es el ÚNICO archivo que el resto
// de la app debe tocar para "saber" qué proveedor está activo. Añadir un
// proveedor nuevo (p.ej. Claude, Mistral, un backend propio) sólo requiere
// crear un archivo hermano con la misma interfaz (ver base.js) y registrarlo
// aquí — el resto de la aplicación (generación de capítulos, memoria, etc.)
// no necesita cambiar ni una línea.

import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';
import { OpenRouterFreeProvider } from './openrouter.js';

const REGISTRY = {
  gemini: { label: 'Google Gemini', build: (cfg) => new GeminiProvider(cfg) },
  openai: { label: 'OpenAI (GPT)', build: (cfg) => new OpenAIProvider(cfg) },
  openrouter: { label: 'OpenRouter · modelos gratuitos', build: (cfg) => new OpenRouterFreeProvider(cfg) },
};

const DEFAULT_MODELS = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-5.4-mini',
  openrouter: 'openrouter/free',
};

export function getModelOutputLimit(providerId, model = '') {
  const provider = String(providerId || '').trim().toLowerCase();
  const id = String(model || DEFAULT_MODELS[provider] || '').trim().toLowerCase();

  if (provider === 'gemini' || (!provider && /^gemini/i.test(id))) {
    if (/^gemini-(?:2\.5|3|[4-9])(?:[.-]|$)/i.test(id)) return 65536;
    return 8192; // gemini-1.5 / gemini-2.0 Flash & Pro safe ceiling
  }

  if (provider === 'openrouter' || /:free$/i.test(id) || id === 'openrouter/free') {
    return 8192;
  }

  if (provider === 'openai' || (!provider && /^(?:gpt-|o[134])/i.test(id))) {
    if (/^(?:gpt-5|gpt-[6-9]|o[134])(?:[.-]|$)/i.test(id)) return 65536;
    if (/^gpt-4\.1(?:[.-]|$)/i.test(id)) return 32768;
    if (/^gpt-4o(?:[.-]|$)/i.test(id)) return 16384;
    if (/^(?:gpt-4(?:$|[-.])|gpt-3\.5)/i.test(id)) return 4096;
    return 16384;
  }

  return 8192;
}

export function listProviders() {
  return Object.entries(REGISTRY).map(([id, v]) => ({ id, label: v.label }));
}

export function getProvider(settings) {
  const id = settings?.provider || 'gemini';
  const entry = REGISTRY[id] || REGISTRY.gemini;
  const apiKey = settings?.apiKeys?.[id] || '';
  const model = settings?.models?.[id] || '';
  return entry.build({ apiKey, model });
}
