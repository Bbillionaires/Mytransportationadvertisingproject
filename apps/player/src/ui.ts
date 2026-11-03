/** Tiny DOM helpers. All text goes through textContent (never innerHTML), so playlist/advertiser text can't inject markup. */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | null | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c) e.append(c);
  return e;
}

export function button(label: string, onClick: () => void, cls = 'btn', aria?: string) {
  const b = el('button', { type: 'button', class: cls, ...(aria ? { 'aria-label': aria } : {}) }, label);
  b.addEventListener('click', onClick);
  return b;
}

let closeHandler: (() => void) | null = null;
/** Modal overlay (focus moves into it; Escape or "Back to ride" closes). */
export function openOverlay(title: string, ...content: Array<Node | string | null | false>) {
  const o = $('#overlay');
  o.replaceChildren(el('div', { class: 'panel' }, el('h2', { id: 'overlay-title' }, title), ...content, button('Back to ride', closeOverlay, 'btn primary back')));
  o.hidden = false;
  (o.querySelector('button') as HTMLButtonElement | null)?.focus();
}
export function onOverlayClose(fn: (() => void) | null) { closeHandler = fn; }
export function closeOverlay() {
  const o = $('#overlay');
  if (o.hidden) return;
  o.hidden = true;
  o.replaceChildren();
  const fn = closeHandler; closeHandler = null; fn?.();
}
export const overlayOpen = () => !$('#overlay').hidden;

export function toast(...content: Array<Node | string>) {
  const t = $('#toast');
  t.replaceChildren(...content);
  t.hidden = false;
}
export const hideToast = () => { $('#toast').hidden = true; $('#toast').replaceChildren(); };
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });
