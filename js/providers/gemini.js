import { AIProvider, isLikelyInvalidProse, isAbortError } from './base.js';
import { isSafeOnlinePreview, previewBlockedProviderResult } from '../previewGuard.js';

export class GeminiProvider extends AIProvider {
  get name() { return 'gemini'; }

  async generate({ systemPrompt, userPrompt, maxOutputTokens = 2048, temperature = 1.0, signal }) {
    if (isSafeOnlinePreview()) {
      return previewBlockedProviderResult();
    }
    const apiKey = String(this.config.apiKey || '').trim();
    const model = String(this.config.model || 'gemini-2.0-flash').trim();
    if (!apiKey) {
      return { ok: false, text: null, errorType: 'auth', errorMessage: 'Falta la clave API de Gemini en Ajustes.', truncated: false, finishReason: null, raw: null };
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt || '' }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt || '' }] }],
      generationConfig: {
        maxOutputTokens,
        temperature,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        return { ok: false, text: null, errorType: 'aborted', errorMessage: 'Solicitud a Gemini cancelada por la autora.', truncated: false, finishReason: null, raw: null };
      }
      return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar Gemini: ' + err.message, truncated: false, finishReason: null, raw: err };
    }

    let data;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (res.status === 429) {
        return { ok: false, text: null, errorType: 'quota', errorMessage: 'Gemini devolvió 429 (cuota/límite de tasa excedido). No reintentes automáticamente; espera y vuelve a intentar.', truncated: false, finishReason: null, raw: data };
      }
      if (res.status === 503) {
        return { ok: false, text: null, errorType: 'busy', errorMessage: 'Gemini devolvió HTTP 503: el modelo tiene alta demanda temporal. El borrador está guardado. Espera unos minutos y pulsa Reanudar; también puedes elegir otro modelo Flash disponible en Ajustes.', truncated: false, finishReason: null, raw: data };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, text: null, errorType: 'auth', errorMessage: 'clave API de Gemini inválida o sin permisos (HTTP ' + res.status + ').', truncated: false, finishReason: null, raw: data };
      }
      return { ok: false, text: null, errorType: 'http', errorMessage: 'Gemini devolvió HTTP ' + res.status + (data?.error?.message ? ': ' + data.error.message : ''), truncated: false, finishReason: null, raw: data };
    }

    const uMeta = data?.usageMetadata;
    const usage = uMeta && typeof uMeta === 'object'
      ? {
          promptTokens: Number(uMeta.promptTokenCount || 0) || 0,
          completionTokens: Number(uMeta.candidatesTokenCount || 0) || 0,
          totalTokens: Number(uMeta.totalTokenCount || 0) || 0,
          cachedTokens: Number(uMeta.cachedContentTokenCount || 0) || 0,
          reasoningTokens: Number(uMeta.thoughtsTokenCount || 0) || 0,
          reportedByProvider: true,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, reportedByProvider: false };

    const candidate = data?.candidates?.[0];
    const finishReason = candidate?.finishReason || null;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || data?.promptFeedback?.blockReason) {
      return { ok: false, text: null, errorType: 'moderation', errorMessage: 'Gemini bloqueó la respuesta (motivo: ' + (finishReason || data?.promptFeedback?.blockReason) + ').', truncated: false, finishReason, usage, raw: data };
    }

    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
    const truncated = finishReason === 'MAX_TOKENS';
    if (!text || isLikelyInvalidProse(text)) {
      const msg = truncated
        ? 'Gemini alcanzó el límite de tokens antes de devolver texto utilizable (MAX_TOKENS).'
        : 'Gemini devolvió una respuesta vacía o inválida.';
      return { ok: false, text: null, errorType: 'empty', errorMessage: msg, truncated, finishReason, usage, raw: data };
    }

    return { ok: true, text, errorType: null, errorMessage: null, truncated, finishReason, usage, raw: data };
  }
}
