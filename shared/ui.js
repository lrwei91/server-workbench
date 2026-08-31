/** Shared browser primitives for the workbench and CDR tool. */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', retryable = false, details = null } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.retryable = retryable; this.details = details; }
}

function timeoutSignal(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const forward = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', forward, { once: true }); }
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', forward); } };
}

export async function apiRequest(url, options = {}) {
  const { timeout = 30000, signal, ...fetchOptions } = options;
  const timed = timeoutSignal(timeout, signal);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: timed.signal, headers: { Accept: 'application/json', ...(fetchOptions.headers || {}) } });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json().catch(() => null) : await response.text();
    if (!response.ok || (payload && payload.ok === false)) {
      const err = payload?.error;
      const normalized = typeof err === 'object' && err ? err : { code: 'REQUEST_FAILED', message: typeof err === 'string' ? err : response.statusText || '请求失败' };
      throw new ApiError(normalized.message || '请求失败', { status: response.status, code: normalized.code || 'REQUEST_FAILED', retryable: Boolean(normalized.retryable), details: normalized.details || payload });
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('请求已取消或超时', { code: 'REQUEST_ABORTED', retryable: true });
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.message || '网络请求失败', { code: 'NETWORK_ERROR', retryable: true });
  } finally { timed.dispose(); }
}
export const getJson = (url, options = {}) => apiRequest(url, { ...options, method: 'GET' });
export const postJson = (url, body, options = {}) => apiRequest(url, { ...options, method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, body: JSON.stringify(body ?? {}) });
export function setText(node, value) { if (node) node.textContent = value == null ? '' : String(value); return node; }
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'on') Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
    else if (key in node && !key.startsWith('aria-') && !key.startsWith('data-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) { if (child == null || child === false) continue; node.append(child.nodeType ? child : document.createTextNode(String(child))); }
  return node;
}
export function announce(node, message, tone = 'info') { if (!node) return; node.dataset.tone = tone; node.textContent = message || ''; }
export function formatBytes(value) { const n = Number(value); if (!Number.isFinite(n)) return '—'; if (n < 1024) return `${n} B`; if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`; if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`; return `${(n / 1024 ** 3).toFixed(1)} GiB`; }
export function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); }
export function createRequestGate() { let seq = 0; let controller = null; return { next() { controller?.abort(); controller = new AbortController(); const id = ++seq; return { id, signal: controller.signal, isCurrent: () => id === seq }; }, cancel() { controller?.abort(); controller = null; ++seq; } }; }
export class DialogController {
  constructor(dialog) { this.dialog = dialog; this.previous = null; this.onCancel = this.onCancel.bind(this); }
  open(initialFocus) { if (!this.dialog) return; this.previous = document.activeElement; this.dialog.addEventListener('cancel', this.onCancel); if (typeof this.dialog.showModal === 'function') this.dialog.showModal(); else this.dialog.setAttribute('open', ''); queueMicrotask(() => (initialFocus || this.dialog.querySelector('[autofocus],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'))?.focus()); }
  close() { if (!this.dialog) return; this.dialog.removeEventListener('cancel', this.onCancel); if (this.dialog.open && typeof this.dialog.close === 'function') this.dialog.close(); else this.dialog.removeAttribute('open'); queueMicrotask(() => this.previous?.focus?.()); }
  onCancel(event) { event.preventDefault(); this.close(); }
}
