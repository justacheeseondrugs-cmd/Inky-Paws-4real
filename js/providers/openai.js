import { AIProvider, isLikelyInvalidProse, isAbortError } from './base.js';

function apiError(res, data) {
  if (res.status === 429) {
    return { ok: false, text: null, errorType: 'quota', errorMessage: 'OpenAI devolvió 429 (cuota/límite de tasa excedido). No reintentes automáticamente; espera y vuelve a intentar.', truncated: false, finishReason: null, raw: data };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, text: null, errorType: 'auth', errorMessage: 'clave API de OpenAI inválida o sin permisos (HTTP ' + res.status + ').', truncated: false, finishReason: null, raw: data };
  }
  return { ok: false, text: null, errorType: 'http', errorMessage: 'OpenAI devolvió HTTP ' + res.status + (data?.error?.message ? ': ' + data.error.message : ''), truncated: false, finishReason: null, raw: data };
}

export function supportsExplicitPromptCacheWrites(modelId = '') {
  return /^(?:gpt-5\.6|gpt-[6-9])(?:[.-]|$)/i.test(String(modelId || '').trim());
}

function extractOpenAIUsage(data) {
  const u = data?.usage;
  if (!u || typeof u !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, reportedByProvider: false };
  }
  const promptTokens = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
  const totalTokens = Number(u.total_tokens ?? (promptTokens + completionTokens)) || 0;
  const cachedTokens = Number(
    u.input_tokens_details?.cached_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0
  ) || 0;
  const cacheWriteTokens = Number(
    u.input_tokens_details?.cache_creation_tokens ??
    u.input_tokens_details?.cache_write_tokens ??
    u.prompt_tokens_details?.cache_creation_tokens ??
    0
  ) || 0;
  const reasoningTokens = Number(
    u.output_tokens_details?.reasoning_tokens ??
    u.completion_tokens_details?.reasoning_tokens ??
    0
  ) || 0;
  return { promptTokens, completionTokens, totalTokens, cachedTokens, cacheWriteTokens, reasoningTokens, reportedByProvider: true };
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

async function postJson(url, apiKey, body, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) return { aborted: true };
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
    reasoningEffort = '',
    signal,
  }) {
    const apiKey = String(this.config.apiKey || '').trim();
    const model = String(this.config.model || 'gpt-5.4-mini').trim();
    const effectiveEffort = String(reasoningEffort || this.config.reasoningEffort || '').trim().toLowerCase();
    if (!apiKey) {
      return { ok: false, text: null, errorType: 'auth', errorMessage: 'Falta la clave API de OpenAI en Ajustes.', truncated: false, finishReason: null, usage: null, raw: null };
    }

    // GPT-5.6+ / GPT-6+ introduced paid cache writes (1.25x for 30m, 2.5x for 12h)
    // and explicit cache breakpoints. Inky Paws uses Responses for these models so
    // one-off calls disable implicit cache writes, while multi-block chapter generation
    // caches only the stable lore/instructions prefix.
    const supportsExplicitCache = supportsExplicitPromptCacheWrites(model);
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

      const validResponsesEffort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      const chosenEffort = validResponsesEffort.includes(effectiveEffort) ? effectiveEffort : 'none';
      const body = {
        model,
        input,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: chosenEffort },
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

      const req = await postJson('https://api.openai.com/v1/responses', apiKey, body, signal);
      if (req.aborted) {
        return { ok: false, text: null, errorType: 'aborted', errorMessage: 'Solicitud a OpenAI cancelada por la autora.', truncated: false, finishReason: null, usage: null, raw: null };
      }
      if (req.networkError) {
        return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar OpenAI: ' + req.networkError.message, truncated: false, finishReason: null, usage: null, raw: req.networkError };
      }
      const { res, data } = req;
      const usage = extractOpenAIUsage(data);
      if (!res.ok) return { ...apiError(res, data), usage };

      const incompleteReason = String(data?.incomplete_details?.reason || '');
      const truncated = data?.status === 'incomplete' || incompleteReason === 'max_output_tokens';
      const finishReason = truncated ? (incompleteReason || 'length') : (data?.status || 'completed');

      const text = extractResponsesText(data);
      if (!text || isLikelyInvalidProse(text)) {
        const refusal = (data?.output || []).flatMap((item) => item?.content || []).find((part) => part?.type === 'refusal');
        if (refusal) {
          return { ok: false, text: null, errorType: 'moderation', errorMessage: 'OpenAI bloqueó la respuesta por el filtro de contenido.', truncated: false, finishReason: 'refusal', usage, raw: data };
        }
        const msg = truncated
          ? 'OpenAI alcanzó el límite de tokens de salida antes de devolver texto utilizable.'
          : 'OpenAI devolvió una respuesta vacía o inválida.';
        return { ok: false, text: null, errorType: 'empty', errorMessage: msg, truncated, finishReason, usage, raw: data };
      }

      return { ok: true, text, errorType: null, errorMessage: null, truncated, finishReason, usage, raw: data };
    }

    // Compatibility path for GPT-4.x, GPT-5.4, and o-series models.
    const url = 'https://api.openai.com/v1/chat/completions';
    const isReasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(model);
    const isGpt54 = /^gpt-5\.4(?:[.-]|$)/i.test(model);
    const isOSeries = /^o[134](?:[.-]|$)/i.test(model);
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: userPrompt || '' },
      ],
      [isReasoningModel ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens,
      store: false,
    };

    if (isGpt54) {
      // Official GPT-5.4 / GPT-5.4-mini reasoning_effort: none (default), low, medium, high, xhigh.
      // Sampling temperature is only supported when reasoning_effort is 'none'.
      const effort = ['none', 'low', 'medium', 'high', 'xhigh'].includes(effectiveEffort) ? effectiveEffort : 'none';
      body.reasoning_effort = effort;
      if (effort === 'none') body.temperature = temperature;
    } else if (isOSeries) {
      if (['low', 'medium', 'high'].includes(effectiveEffort)) {
        body.reasoning_effort = effectiveEffort;
      }
    } else if (isReasoningModel) {
      if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effectiveEffort)) {
        body.reasoning_effort = effectiveEffort;
      }
    } else {
      body.temperature = temperature;
    }

    // Fallback mínimo solo ante HTTP 400 de parámetro incompatible en IDs personalizados
    // (sin ejecutar nunca una segunda generación pagada).
    let res, data;
    for (let attempt = 0; attempt < 2; attempt++) {
      const req = await postJson(url, apiKey, body, signal);
      if (req.aborted) {
        return { ok: false, text: null, errorType: 'aborted', errorMessage: 'Solicitud a OpenAI cancelada por la autora.', truncated: false, finishReason: null, usage: null, raw: null };
      }
      if (req.networkError) {
        return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar OpenAI: ' + req.networkError.message, truncated: false, finishReason: null, usage: null, raw: req.networkError };
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
      } else if ((parameter === 'reasoning_effort' || /['"]reasoning_effort['"]/i.test(message)) && Object.hasOwn(body, 'reasoning_effort')) {
        delete body.reasoning_effort;
      } else if ((parameter === 'temperature' || /['"]temperature['"]/i.test(message)) && Object.hasOwn(body, 'temperature')) {
        delete body.temperature;
      } else {
        break;
      }
    }

    const usage = extractOpenAIUsage(data);
    if (!res.ok) return { ...apiError(res, data), usage };

    const choice = data?.choices?.[0];
    const finishReason = choice?.finish_reason || null;
    if (finishReason === 'content_filter') {
      return { ok: false, text: null, errorType: 'moderation', errorMessage: 'OpenAI bloqueó la respuesta por el filtro de contenido.', truncated: false, finishReason, usage, raw: data };
    }

    const truncated = finishReason === 'length';
    const text = (choice?.message?.content || '').trim();
    if (!text || isLikelyInvalidProse(text)) {
      const msg = truncated
        ? 'OpenAI alcanzó el límite de tokens de salida antes de devolver texto utilizable.'
        : 'OpenAI devolvió una respuesta vacía o inválida.';
      return { ok: false, text: null, errorType: 'empty', errorMessage: msg, truncated, finishReason, usage, raw: data };
    }

    return { ok: true, text, errorType: null, errorMessage: null, truncated, finishReason, usage, raw: data };
  }
}
