import { AIProvider, isLikelyInvalidProse, isAbortError } from './base.js';

// Free router only: do not switch silently to a paid OpenRouter model.
export const isFreeModel = (model) => model === 'openrouter/free' || /^[a-z0-9._-]+\/[a-z0-9._:-]+:free$/i.test(model);

export class OpenRouterFreeProvider extends AIProvider {
  get name() { return 'openrouter'; }
  async generate({ systemPrompt, userPrompt, maxOutputTokens = 2048, temperature = 1, signal }) {
    const key = String(this.config.apiKey || '').trim();
    const model = String(this.config.model || 'openrouter/free').trim();
    if (!key) return { ok:false, text:null, errorType:'auth', errorMessage:'Falta la clave API de OpenRouter en Ajustes. No sirve la clave de Gemini.', truncated:false, finishReason:null, raw:null };
    if (!isFreeModel(model)) return { ok:false, text:null, errorType:'http', errorMessage:'Este proveedor solo permite openrouter/free o IDs que terminan en :free para evitar cargos.', truncated:false, finishReason:null, raw:null };
    let response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}`, 'X-Title':'Inky Paws' },
        body:JSON.stringify({
          model,
          messages:[{role:'system',content:systemPrompt || ''},{role:'user',content:userPrompt || ''}],
          max_tokens:maxOutputTokens,
          temperature,
          stream:false,
        }),
        signal,
      });
    } catch(e) {
      if (isAbortError(e) || signal?.aborted) {
        return { ok:false, text:null, errorType:'aborted', errorMessage:'Solicitud a OpenRouter cancelada por la autora.', truncated:false, finishReason:null, raw:null };
      }
      return {ok:false,text:null,errorType:'network',errorMessage:'Error de conexión con OpenRouter: '+e.message,truncated:false,finishReason:null,raw:null};
    }
    let data;
    try {data=await response.json();} catch {data=null;}
    const info = String(data?.error?.message || '').slice(0,250);
    if (!response.ok) {
      const status = response.status;
      let errorType = status === 429 || status === 402 ? 'quota' : [502,503,504].includes(status) ? 'busy' : [401,403].includes(status) ? 'auth' : 'http';
      let help = status===402 ? 'Esta petición requiere créditos; no se usarán modelos de pago.' : status===429 ? 'Límite gratuito o alta demanda. Espera antes de reanudar.' : [502,503,504].includes(status) ? 'Alta demanda temporal. Espera antes de reanudar.' : '';
      return {ok:false,text:null,errorType,errorMessage:`OpenRouter HTTP ${status}. ${help} ${info} Tu borrador sigue guardado.`,truncated:false,finishReason:null,raw:data};
    }
    const choice = data?.choices?.[0];
    const finishReason = choice?.finish_reason ? String(choice.finish_reason).slice(0, 60) : null;
    const truncated = finishReason === 'length';
    const content = choice?.message?.content;
    const prose = (typeof content==='string' ? content : Array.isArray(content) ? content.map(x=>typeof x==='string'?x:x?.text||'').join('') : '').trim();
    if (!prose || isLikelyInvalidProse(prose)) {
      const chosenModel = String(data?.model || model).slice(0,120);
      const reasoningTokens = Number(data?.usage?.completion_tokens_details?.reasoning_tokens || 0);
      const help = !prose && (truncated || reasoningTokens > 0)
        ? 'El modelo agotó sus tokens antes de escribir texto visible. '
        : !prose ? 'El modelo devolvió una respuesta sin texto visible. ' : 'La respuesta no era prosa válida. ';
      return {
        ok:false, text:null, errorType:'empty',
        errorMessage:help + 'Modelo: ' + chosenModel + '; motivo: ' + (finishReason || 'desconocido') + '. En Ajustes cambia el modelo de OpenRouter a arcee-ai/trinity-large-preview:free y pulsa Reanudar borrador. Nada se ha borrado.',
        truncated, finishReason, raw:null,
      };
    }
    return {ok:true,text:prose,errorType:null,errorMessage:null,truncated,finishReason,raw:null};
  }
}
