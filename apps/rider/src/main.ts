import { enablePasswordToggles } from '../../portal/src/passwordToggle';
import { qrSvg } from '../../player/src/qr';

/** Rider phone web app. Plain DOM; all user/advertiser text is set via textContent. */
const TOKEN = 'rmn_rider_token', WALLET = 'rmn_rider_wallet', PENDING_PAIR = 'rmn_pending_pair';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const session = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

const $ = (s: string) => document.querySelector(s) as HTMLElement;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string | null | false | undefined>) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}
const btn = (label: string, onClick: () => void, cls = 'btn', attrs: Record<string, string> = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
function field(label: string, attrs: Record<string, string>) { return el('label', {}, label, el('input', attrs)); }
function msg(text: string, kind: 'ok' | 'err' | '' = '') { const m = $('#msg'); m.textContent = text; m.className = `msg ${kind}`; m.hidden = !text; }
const render = (...nodes: Array<Node | null | false>) => $('#main').replaceChildren(...nodes.filter((n): n is Node => !!n));

class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = store.get(TOKEN);
  const res = await fetch(path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== '/v1/riders/login') { store.del(TOKEN); store.del(WALLET); }
  if (!res.ok) throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.details?.[0]?.message ?? j.error?.details?.[0]?.message ?? j.error?.message ?? 'Something went wrong');
  return j as T;
}
const errText = (e: unknown) => (e instanceof ApiError ? e.message : navigator.onLine ? 'Something went wrong. Please try again.' : 'You are offline.');

/** Accepts the 8-character code, the RMNPAIR: payload, or the deep link the tablet QR encodes. */
export function extractPairCode(s: string): string | null {
  const m = /(?:^|RMNPAIR:|[?&]pair=)([A-Za-z2-9]{8})(?:$|&)/.exec(s.trim());
  return m ? m[1]!.toUpperCase() : null;
}

// ------------------------------------------------------------------ signed out
function signedOut(tab: 'signin' | 'register' | 'forgot' = 'signin') {
  $('#who').textContent = '';
  const tabs = el('div', { class: 'tabs', role: 'tablist' },
    btn('Sign in', () => signedOut('signin'), 'btn', { role: 'tab', 'aria-selected': String(tab === 'signin') }),
    btn('Create account', () => signedOut('register'), 'btn', { role: 'tab', 'aria-selected': String(tab === 'register') }));
  if (tab === 'signin') {
    const f = el('form', { class: 'card', id: 'signin' }, el('h2', {}, 'Sign in'),
      field('Email', { type: 'email', name: 'email', required: '', autocomplete: 'email' }),
      field('Password', { type: 'password', name: 'password', required: '', autocomplete: 'current-password' }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), btn('Forgot password?', () => signedOut('forgot'), 'btn link'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      try {
        const r = await api('POST', '/v1/riders/login', { email: d.get('email'), password: d.get('password') });
        store.set(TOKEN, r.token);
        msg('');
        await home();
      } catch (err) { msg(errText(err), 'err'); }
    });
    render(tabs, f);
  } else if (tab === 'register') {
    const year = new Date().getFullYear();
    const f = el('form', { class: 'card', id: 'register' }, el('h2', {}, 'Create a free account'),
      el('p', { class: 'muted' }, 'Save coupons and win sponsor rewards from any screen in the network.'),
      field('First name or nickname', { type: 'text', name: 'displayName', required: '', maxlength: '50', autocomplete: 'nickname' }),
      field('Email', { type: 'email', name: 'email', required: '', autocomplete: 'email' }),
      field('Password (at least 12 characters)', { type: 'password', name: 'password', required: '', minlength: '12', autocomplete: 'new-password' }),
      field('Birth year', { type: 'number', name: 'birthYear', required: '', min: '1900', max: String(year), inputmode: 'numeric' }),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'adult', required: '' }), 'I am 18 or older.'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'terms', required: '' }), 'I agree to the rider terms and privacy notice.'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'marketing' }), 'Send me occasional offers by email (optional).'),
      el('button', { class: 'btn primary', type: 'submit' }, 'Create account'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      try {
        const r = await api('POST', '/v1/riders/register', { displayName: d.get('displayName'), email: d.get('email'), password: d.get('password'), birthYear: Number(d.get('birthYear')),
          confirmAdult: d.get('adult') === 'on', termsVersion: 'RIDER_TERMS_V1', marketingOptIn: d.get('marketing') === 'on' });
        msg(r.message, 'ok');
        signedOut('signin');
      } catch (err) { msg(errText(err), 'err'); }
    });
    render(tabs, f);
  } else {
    const f = el('form', { class: 'card', id: 'forgot' }, el('h2', {}, 'Reset your password'), field('Email', { type: 'email', name: 'email', required: '', autocomplete: 'email' }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Send reset link'), btn('Back to sign in', () => signedOut('signin'), 'btn link'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { msg((await api('POST', '/v1/riders/password-reset/request', { email: new FormData(f).get('email') })).message, 'ok'); signedOut('signin'); } catch (err) { msg(errText(err), 'err'); }
    });
    render(tabs, f);
  }
}

function resetForm(token: string) {
  const f = el('form', { class: 'card', id: 'reset' }, el('h2', {}, 'Choose a new password'),
    field('New password (at least 12 characters)', { type: 'password', name: 'password', required: '', minlength: '12', autocomplete: 'new-password' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Save password'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/v1/riders/password-reset/confirm', { token, newPassword: new FormData(f).get('password') }); msg('Password changed. Sign in with your new password.', 'ok'); signedOut('signin'); }
    catch (err) { msg(errText(err), 'err'); }
  });
  render(f);
}

// ------------------------------------------------------------------ signed in
let scanStop: (() => void) | null = null;

async function pair(code: string) {
  try {
    const r = await api('POST', '/v1/riders/pair', { code });
    session.del(PENDING_PAIR);
    msg(`Connected to the screen until ${new Date(r.tabletSessionEndsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Coupons and rewards you get there land in your wallet.`, 'ok');
    $('#connected').textContent = 'Connected to a screen';
  } catch (err) { msg(errText(err), 'err'); }
}

function connectCard() {
  const input = el('input', { type: 'text', id: 'pair-input', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', maxlength: '8', placeholder: 'ABCD2345', 'aria-label': 'Code shown on the screen' }) as HTMLInputElement;
  const form = el('form', { class: 'row', id: 'pair-form' }, input, el('button', { class: 'btn primary', type: 'submit' }, 'Connect'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = extractPairCode(input.value);
    if (!code) { msg('Enter the 8-character code shown on the screen.', 'err'); return; }
    void pair(code);
  });
  const scanBox = el('div', {});
  const canScan = 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  return el('section', { class: 'card' }, el('h2', {}, 'Connect to a ride screen'), el('p', { class: 'muted', id: 'connected' }, "Point your phone's camera at the code on the screen, or type it here."),
    form, canScan ? btn('Scan with camera', () => void startScan(scanBox), 'btn') : null, scanBox);
}

async function startScan(box: HTMLElement) {
  scanStop?.();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = el('video', { class: 'scan', playsinline: '', muted: '', 'aria-label': 'Camera preview' }) as HTMLVideoElement;
    video.srcObject = stream;
    await video.play();
    const stop = () => { for (const t of stream.getTracks()) t.stop(); box.replaceChildren(); scanStop = null; };
    scanStop = stop;
    box.replaceChildren(video, btn('Stop camera', stop, 'btn'));
    const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
    while (scanStop === stop) {
      const codes = await detector.detect(video).catch(() => []);
      const code = codes.map((c: any) => extractPairCode(String(c.rawValue))).find(Boolean);
      if (code) { stop(); await pair(code); return; }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch { msg('Camera unavailable. Type the code from the screen instead.', 'err'); }
}

function walletItem(kind: 'Coupon' | 'Reward', it: any) {
  const used = !!it.redeemed_at, expired = new Date(it.expires_at) < new Date();
  const details = el('div', { class: 'detail', hidden: '' }, qrSvg(kind === 'Coupon' ? `RMNCOUPON:${it.code}` : it.code, `${kind} code QR`), el('p', { class: 'code' }, it.code),
    el('p', { class: 'muted' }, 'Show this at checkout.'));
  const head = el('button', { type: 'button', class: `item${used || expired ? ' used' : ''}`, 'aria-expanded': 'false' },
    el('span', {}, el('span', { class: 'badge' }, kind), ' ', el('strong', {}, it.description ?? 'Offer')),
    el('span', { class: 'meta' }, `${it.campaign ?? it.sponsor ?? ''} · ${used ? 'Used' : expired ? 'Expired' : `Valid until ${new Date(it.expires_at).toLocaleDateString()}`}`));
  head.addEventListener('click', () => { details.hidden = !details.hidden; head.setAttribute('aria-expanded', String(!details.hidden)); });
  return el('div', { class: 'wallet-entry' }, head, details);
}

async function walletCard() {
  let w: { coupons: any[]; rewards: any[] } | null = null;
  let offline = false;
  try { w = await api('GET', '/v1/riders/me/wallet'); store.set(WALLET, JSON.stringify(w)); }
  catch { const cached = store.get(WALLET); if (cached) { w = JSON.parse(cached); offline = true; } }
  const items = w ? [...w.rewards.map((r) => walletItem('Reward', r)), ...w.coupons.map((c) => walletItem('Coupon', c))] : [];
  return el('section', { class: 'card', id: 'wallet' }, el('div', { class: 'row' }, el('h2', {}, 'Wallet'), btn('Refresh', () => void home(), 'btn')),
    offline ? el('p', { class: 'muted', id: 'offline-note' }, 'Offline: showing your saved wallet.') : null,
    items.length ? el('div', { class: 'list' }, ...items) : el('p', { class: 'muted' }, 'Coupons and rewards you collect on ride screens appear here.'));
}

function accountCard(me: any) {
  const name = el('input', { type: 'text', value: me.displayName, maxlength: '50', 'aria-label': 'Display name' }) as HTMLInputElement;
  const marketing = el('input', { type: 'checkbox', ...(me.marketingOptIn ? { checked: '' } : {}) }) as HTMLInputElement;
  return el('section', { class: 'card', id: 'account' }, el('h2', {}, 'Account'),
    el('label', {}, 'Display name', name), el('label', { class: 'check' }, marketing, 'Occasional offers by email'),
    btn('Save', async () => { try { await api('PATCH', '/v1/riders/me', { displayName: name.value, marketingOptIn: marketing.checked }); msg('Saved.', 'ok'); await home(); } catch (e) { msg(errText(e), 'err'); } }, 'btn'),
    btn('Sign out', async () => { await api('POST', '/v1/riders/logout').catch(() => {}); store.del(TOKEN); store.del(WALLET); msg('Signed out.'); signedOut(); }, 'btn'),
    btn('Delete my account', () => deleteFlow(), 'btn danger'));
}

function deleteFlow() {
  const f = el('form', { class: 'card', id: 'delete' }, el('h2', {}, 'Delete account'),
    el('p', {}, 'This erases your email, name and birth year and signs you out everywhere. Codes you already have remain usable at the shop but no longer identify you.'),
    field('Confirm with your password', { type: 'password', name: 'password', required: '', autocomplete: 'current-password' }),
    el('button', { class: 'btn danger', type: 'submit' }, 'Delete permanently'), btn('Cancel', () => void home(), 'btn'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/v1/riders/me/delete', { password: new FormData(f).get('password') }); store.del(TOKEN); store.del(WALLET); msg('Your account was deleted.', 'ok'); signedOut(); }
    catch (err) { msg(errText(err), 'err'); }
  });
  render(f);
}

async function home() {
  let me: any;
  try { me = await api('GET', '/v1/riders/me'); }
  catch (e) {
    if (e instanceof ApiError) { signedOut(); return; }
    me = { displayName: '', marketingOptIn: false, offline: true }; // offline: still show the cached wallet
  }
  $('#who').textContent = me.displayName ? `Hi ${me.displayName}` : '';
  const verifyNote = me.emailVerified === false ? el('p', { class: 'card', id: 'verify-note' }, 'Confirm your email (check your inbox) before connecting to a screen.') : null;
  render(verifyNote, connectCard(), await walletCard(), me.offline ? null : accountCard(me));
  const pending = session.get(PENDING_PAIR);
  if (pending && !me.offline) await pair(pending);
}

// ------------------------------------------------------------------ boot: handle links from email and the tablet QR
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/rider/sw.js', { scope: '/rider/' }).catch(() => {});
  const p = new URLSearchParams(location.search);
  const clean = () => history.replaceState(null, '', location.pathname);
  const pairCode = p.get('pair') ? extractPairCode(p.get('pair')!) : null;
  if (pairCode) session.set(PENDING_PAIR, pairCode);
  if (p.get('verify')) {
    try { await api('POST', '/v1/riders/verify-email', { token: p.get('verify') }); msg('Email confirmed. You can now connect to ride screens.', 'ok'); }
    catch (e) { msg(errText(e), 'err'); }
  }
  const reset = p.get('reset');
  clean();
  if (reset) { resetForm(reset); return; }
  if (store.get(TOKEN)) await home();
  else { if (pairCode) msg('Sign in (or create a free account) to connect to this screen.'); signedOut(); }
}
enablePasswordToggles();
void boot();
