// previewGuard.js — Modo de vista previa segura online (Cloudflare Pages / previews HTTPS).
//
// Invariante de seguridad para el preview online Alpha:
// - En dominios de vista previa alojados (*.pages.dev, *.netlify.app, *.vercel.app) o con
//   `?preview_readonly=1`, TODAS las llamadas reales a APIs externas de IA (OpenAI, Gemini,
//   OpenRouter) y el ingreso de claves API quedan desactivados a nivel de proveedor y de UI
//   hasta revisar una estrategia segura de credenciales.
// - La autora puede explorar las 7 pestañas, importar su Biblia localmente en IndexedDB,
//   configurar Universo / Writing DNA / Referencias / Inky Wallet, usar el extractor local
//   (0 tokens), planificar Novel Mode e inspeccionar prompts exactos en «👀 Ver contexto»
//   con 0 tokens gastados y 0 tráfico a proveedores de IA.

export const HOSTED_PREVIEW_HOST_PATTERNS = [
  /\.pages\.dev$/i,
  /\.netlify\.app$/i,
  /\.vercel\.app$/i,
];

export const PREVIEW_API_DISABLED_MESSAGE =
  'Vista previa segura activa (0 tokens): las llamadas reales a APIs de IA están desactivadas en el preview online hasta revisar el manejo seguro de credenciales. Puedes explorar toda la interfaz, importar fichas localmente y usar «👀 Ver contexto» y «📋 Plan Novel Mode» sin gastar tokens.';

export const PREVIEW_BANNER_TITLE =
  '🧪 Vista previa segura · Inky Novelist Alpha (0 tokens)';

export const PREVIEW_BANNER_BODY =
  'Las llamadas reales a APIs de IA y el ingreso de claves API están desactivados en esta vista previa online hasta revisar el manejo seguro de credenciales. Explora libremente las 7 pestañas, importa tus fichas localmente en este navegador (aislado de producción), prueba el extractor local (0 tokens), planifica Novel Mode e inspecciona prompts exactos con «👀 Ver contexto».';

/**
 * Determina si Inky Paws se está ejecutando en modo de vista previa segura online.
 * - `true` en *.pages.dev / *.netlify.app / *.vercel.app o con `?preview_readonly=1`.
 * - `false` en Node (sin `location`), localhost/127.0.0.1 (sin query) y producción GitHub Pages.
 */
export function isSafeOnlinePreview(loc = (typeof globalThis !== 'undefined' ? globalThis.location : null)) {
  if (!loc || typeof loc !== 'object') return false;
  const hostname = String(loc.hostname || '').trim().toLowerCase();
  const search = String(loc.search || '');
  if (/(?:^|[?&])preview_readonly=(?:1|true)(?:&|$)/i.test(search)) {
    return true;
  }
  return HOSTED_PREVIEW_HOST_PATTERNS.some((rx) => rx.test(hostname));
}

export function previewBlockedProviderResult() {
  return {
    ok: false,
    text: null,
    errorType: 'preview_disabled',
    errorMessage: PREVIEW_API_DISABLED_MESSAGE,
    truncated: false,
    finishReason: null,
    usage: null,
    raw: null,
  };
}
