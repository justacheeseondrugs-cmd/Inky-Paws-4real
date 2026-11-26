// utils.js — helpers compartidos por toda la UI.

export function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function contentFingerprint(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v1:${wordCount(normalized)}:${normalized.length}:${hash.toString(16).padStart(8, '0')}`;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Vista de lectura segura: convierte énfasis Markdown en formato tipográfico
// sin interpretar HTML que pueda aparecer dentro del manuscrito.
// La versión original con asteriscos se conserva intacta para seguir editándola.
export function renderManuscript(text) {
  const safe = escapeHtml(String(text ?? '').replace(/\r\n?/g, '\n'));
  const formatted = safe
    .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^\n*]+?)\*/g, '<em>$1</em>');
  return formatted.split(/\n[\t ]*\n+/).map((paragraph) =>
    '<p>' + paragraph.replace(/\n/g, '<br>') + '</p>'
  ).join('');
}

export async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('No hay texto para copiar.');
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('No se pudo copiar automáticamente.');
  return true;
}

export function toast(message, { error = false, ms = 3600 } = {}) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' toast-error' : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ---- modal genérico (sheet) ----
let activeModalCleanup = null;

export function openModal(innerHtml, { onClose } = {}) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'active-modal';
  backdrop.innerHTML = `<div class="modal-sheet" role="dialog" aria-modal="true">${innerHtml}</div>`;
  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  let closed = false;
  activeModalCleanup = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    if (typeof onClose === 'function') {
      try { onClose(); } catch { }
    }
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(backdrop);
  return backdrop;
}

export function closeModal() {
  const cleanup = activeModalCleanup;
  activeModalCleanup = null;
  if (cleanup) cleanup();
  document.getElementById('active-modal')?.remove();
}

export function debounce(fn, wait = 600) {
  let t = null;
  let lastArgs = null;
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(t);
    t = setTimeout(() => {
      const argsToRun = lastArgs;
      t = null;
      lastArgs = null;
      fn(...argsToRun);
    }, wait);
  };
  debounced.flush = () => {
    if (t === null) return undefined;
    clearTimeout(t);
    const argsToRun = lastArgs;
    t = null;
    lastArgs = null;
    return fn(...argsToRun);
  };
  debounced.cancel = () => {
    clearTimeout(t);
    t = null;
    lastArgs = null;
  };
  return debounced;
}

// ---- bus de eventos minimalista ----
const listeners = {};
export const bus = {
  on(evt, cb) { (listeners[evt] ||= []).push(cb); },
  emit(evt, payload) { (listeners[evt] || []).forEach((cb) => cb(payload)); },
};
