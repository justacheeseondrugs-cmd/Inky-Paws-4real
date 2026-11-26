// base.js — contrato que debe cumplir cualquier proveedor de IA.
// Un proveedor SOLO sabe hablar con una API externa. No sabe nada de
// capítulos, canon guard, ni personajes: recibe texto, devuelve texto.
//
// generate({ systemPrompt, userPrompt, maxOutputTokens, temperature, signal })
// debe resolver SIEMPRE (nunca lanzar), con esta forma:
// {
//   ok: boolean,
//   text: string|null,
//   errorType: null | 'quota' | 'network' | 'http' | 'moderation' | 'empty' | 'auth' | 'busy' | 'aborted',
//   errorMessage: string|null,
//   truncated?: boolean,
//   finishReason?: string|null,
//   raw: <respuesta cruda, para depuración>
// }

export class AIProvider {
  constructor(config) {
    this.config = config || {};
  }
  get name() { return 'base'; }
  async generate(_opts) {
    return { ok: false, text: null, errorType: 'http', errorMessage: 'Proveedor no implementado', truncated: false, finishReason: null, raw: null };
  }
}

export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20);
}

export function isLikelyInvalidProse(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 20) return true;
  // Frases típicas de rechazo/moderación devueltas como "texto" en vez de error HTTP.
  const flags = [
    /^lo siento,? (pero )?no puedo/i,
    /^i('m| am) sorry,? (but )?i can('t|not)/i,
    /^as an ai language model/i,
    /content policy/i,
    /no puedo generar (este|ese) contenido/i,
  ];
  return flags.some((rx) => rx.test(trimmed));
}
