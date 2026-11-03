/** Shared portal helpers: DOM building, dialogs, toasts, API client, formatting. No module state besides the toast timer. */

let onUnauthorized: () => void = () => {};
/** The shell registers what to do when the session has expired or was revoked. */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export const TOKEN = 'rmn_portal_token', ORG = 'rmn_portal_org';
export const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
export const $ = (s: string) => document.querySelector(s) as HTMLElement;
export type Kid = Node | string | null | false | undefined;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}
export const btn = (label: string, onClick: () => unknown, cls = 'btn', attrs: Record<string, string> = {}) => {
  const b = el('button', { type: 'button', class: cls, ...attrs }, label);
  b.addEventListener('click', async () => { b.disabled = true; try { await onClick(); } finally { b.disabled = false; } });
  return b;
};
export const input = (label: string, attrs: Record<string, string>) => el('label', {}, label, el('input', attrs));
export function select(label: string, name: string, options: Array<[string, string]>, attrs: Record<string, string> = {}) {
  const s = el('select', { name, ...attrs });
  for (const [v, t] of options) s.append(el('option', { value: v }, t));
  return el('label', {}, label, s);
}
export const chip = (text: string, kind: '' | 'ok' | 'warn' | 'err' = '') => el('span', { class: `chip ${kind}` }, text);
let toastTimer = 0;
export function toast(text: string, isErr = false) {
  const t = $('#toast'); t.textContent = text; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { t.hidden = true; }, 5000);
}
export const render = (...nodes: Kid[]) => $('#main').replaceChildren(...nodes.filter((n): n is Node | string => !!n));
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const fmtDate = (iso: string) => new Date(iso).toLocaleString();

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = ss.get(TOKEN);
  const res = await fetch(path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/v1/auth/')) onUnauthorized(); // session expired or revoked
  if (!res.ok) throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.details?.[0]?.message ?? j.details?.[0]?.message ?? j.error?.message ?? 'Something went wrong');
  return j as T;
}
export const errText = (e: unknown) => (e instanceof ApiError ? e.message
  : e instanceof TypeError ? 'Network error. Please try again.' // fetch() rejects with TypeError when offline / unreachable
  : e instanceof Error ? e.message : 'Something went wrong.');
export async function act(fn: () => Promise<unknown>, ok?: string) {
  try { await fn(); if (ok) toast(ok); return true; } catch (e) { toast(errText(e), true); return false; }
}

/** Close the dialog and wait for its (asynchronous) close event, so it cannot answer the next dialog. */
export function closeDialog(): Promise<void> {
  const d = $('#dlg') as HTMLDialogElement;
  if (!d.open) return Promise.resolve();
  return new Promise((r) => { d.addEventListener('close', () => setTimeout(r), { once: true }); d.close(); });
}

/** Modal form. Resolves with the form values, or null when cancelled. */
export function dialog(title: string, body: Kid[], submitLabel: string, danger = false): Promise<Record<string, string> | null> {
  const d = $('#dlg') as HTMLDialogElement;
  d.returnValue = '';
  const f = el('form', { method: 'dialog' }, el('h2', {}, title), ...body,
    el('p', { class: 'err', id: 'dlg-err' }),
    el('div', { class: 'row' }, el('button', { class: 'btn', value: 'cancel', formnovalidate: '' }, 'Cancel'), el('button', { class: danger ? 'btn danger' : 'btn primary', value: 'ok' }, submitLabel)));
  d.replaceChildren(f);
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v)])));
    }, { once: true });
  });
}
export function info(title: string, ...body: Kid[]) {
  const d = $('#dlg') as HTMLDialogElement;
  d.replaceChildren(el('form', { method: 'dialog' }, el('h2', {}, title), ...body, el('div', { class: 'row' }, el('button', { class: 'btn primary', value: 'ok' }, 'Done'))));
  d.showModal();
  return new Promise<void>((r) => d.addEventListener('close', () => r(), { once: true }));
}

/** Minor units (cents, as string or bigint) to "$1,234.56". */
export function money(minor: string | number | bigint | null | undefined, currency = 'USD'): string {
  if (minor === null || minor === undefined) return '—';
  const v = BigInt(minor), neg = v < 0n, a = neg ? -v : v;
  const s = `${(a / 100n).toLocaleString('en-US')}.${(a % 100n).toString().padStart(2, '0')}`;
  return `${neg ? '-' : ''}${currency === 'USD' ? '$' : `${currency} `}${s}`;
}
/** "12.50" (dollars, as typed) to minor units string, or null if invalid. */
export function toMinor(dollars: string): string | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(dollars.replace(/[$,]/g, ''));
  return m ? (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '0').padEnd(2, '0'))).toString() : null;
}

/** Download an authenticated file (CSV/PDF) by fetching it with the session token and saving the blob. */
export async function download(path: string, filename: string) {
  const token = ss.get(TOKEN);
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? 'download failed'); }
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
