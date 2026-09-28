import { AIProvider, isLikelyInvalidProse } from './base.js';

function apiError(res, data) {
  if (res.status === 429) {
    return { ok: false, text: null, errorType: 'quota', errorMessage: 'OpenAI devolvió 429 (cuota/límite de tasa excedido). No reintentes automáticamente; espera y vuelve a intentar.', raw: data };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, text: null, errorType: 'auth', errorMessage: 'clave API de OpenAI inválida o sin permisos (HTTP ' + res.status + ').', raw: data };
  }
  return { ok: false, text: null, errorType: 'http', errorMessage: 'OpenAI devolvió HTTP ' + res.status + (data?.error?.message ? ': ' + data.error.message : ''), raw: data };
}

function extractResponsesText(data) {
  const pieces = [];
  for (const item of data?.output || []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') pieces.push(part.text);
    }
  }
  return pieces.join('').trim();
}

async function postJson(url, apiKey, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { networkError: err };
  }
  let data = null;
  try { data = await res.json(); } catch { }
  return { res, data };
}

export class OpenAIProvider extends AIProvider {
  get name() { return 'openai'; }

  async generate({
    systemPrompt,
    userPrompt,
    stableSystemPrompt = '',
    dynamicSystemPrompt = '',
    cacheStrategy = 'off',
    cacheKey = '',
    maxOutputTokens = 2048,
    temperature = 1.0,
  }) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || 'gpt-5.4-mini';
    if (!apiKey) {
      return { ok: false, text: null, errorType: 'auth', errorMessage: 'Falta la clave API de OpenAI en Ajustes.', raw: null };
    }

    // GPT-5.6+ introduced paid cache writes and explicit cache breakpoints.
    // Inky Paws uses Responses for these models so one-off calls can disable
    // implicit cache writes, while multi-block chapter generation caches only
    // the stable lore/instructions prefix.
    const supportsExplicitCache = /^(?:gpt-5\.6|gpt-[6-9])(?:[.-]|$)/i.test(model);
    if (supportsExplicitCache) {
      const stable = String(stableSystemPrompt || '').trim();
      const dynamic = String(dynamicSystemPrompt || '').trim();
      const combined = String(systemPrompt || '').trim();
      const reusable = cacheStrategy === 'reuse' && !!stable;
      const input = [];

      if (reusable) {
        input.push({
          role: 'developer',
          content: [{
            type: 'input_text',
            text: stable,
            prompt_cache_breakpoint: { mode: 'explicit' },
          }],
        });
        if (dynamic) {
          input.push({ role: 'developer', content: [{ type: 'input_text', text: dynamic }] });
        }
      } else if (combined) {
        input.push({ role: 'developer', content: [{ type: 'input_text', text: combined }] });
      }

      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: String(userPrompt || '') }],
      });

      const body = {
        model,
        input,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: this.config.reasoningEffort || 'medium' },
        // Force Standard processing so a project-level Fast setting cannot
        // silently double the per-token price for fanfic generation.
        service_tier: 'default',
        store: false,
        // Explicit-only mode is the cost guard. With no breakpoint (one-off
        // calls), OpenAI creates no prompt-cache write. With the breakpoint
        // above, only the stable prefix is eligible for a cache write/reuse.
        prompt_cache_options: { mode: 'explicit', ttl: '30m' },
        ...(reusable && cacheKey ? { prompt_cache_key: String(cacheKey).slice(0, 64) } : {}),
      };

      const req = await postJson('https://api.openai.com/v1/responses', apiKey, body);
      if (req.networkError) {
        return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar OpenAI: ' + req.networkError.message, raw: req.networkError };
      }
      const { res, data } = req;
      if (!res.ok) return apiError(res, data);

      const text = extractResponsesText(data);
      if (!text || isLikelyInvalidProse(text)) {
        const refusal = (data?.output || []).flatMap((item) => item?.content || []).find((part) => part?.type === 'refusal');
        if (refusal) {
          return { ok: false, text: null, errorType: 'moderation', errorMessage: 'OpenAI bloqueó la respuesta por el filtro de contenido.', raw: data };
        }
        return { ok: false, text: null, errorType: 'empty', errorMessage: 'OpenAI devolvió una respuesta vacía o inválida.', raw: data };
      }

      return { ok: true, text, errorType: null, errorMessage: null, raw: data };
    }

    // Compatibility path for older GPT / o-series models.
    const url = 'https://api.openai.com/v1/chat/completions';
    const isReasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(model);
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: userPrompt || '' },
      ],
      [isReasoningModel ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens,
      ...(isReasoningModel ? {} : { temperature }),
    };

    // Fallback por si el ID del modelo no sigue la convención esperada.
    // Solo se reintenta ante un HTTP 400 que indique un parámetro no compatible.
    // No se vuelve a enviar una generación que haya tenido éxito.
    let res, data;
    for (let attempt = 0; attempt < 3; attempt++) {
      const req = await postJson(url, apiKey, body);
      if (req.networkError) {
        return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar OpenAI: ' + req.networkError.message, raw: req.networkError };
      }
      res = req.res;
      data = req.data;
      const message = String(data?.error?.message || '');
      const parameter = String(data?.error?.param || '');
      if (res.status !== 400 || !/unsupported parameter|unsupported value|not supported|does not support|not available/i.test(message)) break;

      if ((parameter === 'max_tokens' || /['"]max_tokens['"]/i.test(message)) && Object.hasOwn(body, 'max_tokens')) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      } else if ((parameter === 'max_completion_tokens' || /['"]max_completion_tokens['"]/i.test(message)) && Object.hasOwn(body, 'max_completion_tokens')) {
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
      } else if ((parameter === 'temperature' || /['"]temperature['"]/i.test(message)) && Object.hasOwn(body, 'temperature')) {
        delete body.temperature;
      } else {
        break;
      }
    }

    if (!res.ok) return apiError(res, data);

    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      return { ok: false, text: null, errorType: 'moderation', errorMessage: 'OpenAI bloqueó la respuesta por el filtro de contenido.', raw: data };
    }

    const text = (choice?.message?.content || '').trim();
    if (!text || isLikelyInvalidProse(text)) {
      return { ok: false, text: null, errorType: 'empty', errorMessage: 'OpenAI devolvió una respuesta vacía o inválida.', raw: data };
    }

    return { ok: true, text, errorType: null, errorMessage: null, raw: data };
  }
}
