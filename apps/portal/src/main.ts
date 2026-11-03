import { qrSvg } from '../../player/src/qr';
import { advertiserSections } from './advertiser';
import { creatorSections } from './creator';
import { staffSections } from './staff';
import { driverSections } from './driver';
import { TOKEN, ORG, ss, $, el, btn, input, select, chip, toast, render, ago, fmtDate, api, errText, act, closeDialog, dialog, info, setUnauthorizedHandler, type Kid } from './ui';

/**
 * Business portal. Plain DOM, hash routing; every value from the server is rendered with textContent.
 * The session token lives in sessionStorage (cleared when the tab closes). All authorization is enforced by the API;
 * the UI only hides actions the user's role cannot perform.
 */


// ------------------------------------------------------------------ session state
interface Membership { orgId: string; orgKind: string; role: string; permissions: string[] }
interface Me { user: { id: string; email: string; displayName: string; mfaEnabled: boolean }; session: { mfaVerified: boolean }; memberships: Membership[] }
let me: Me | null = null;
let orgs: Array<{ id: string; kind: string; name: string }> = [];
export let current: { id: string; kind: string; name: string; perms: Set<string> } | null = null;
export const can = (p: string) => !!current?.perms.has(p);

// ------------------------------------------------------------------ signed out
/** Forget everything about the signed-in user (token, org, timers, cached identity). */
function endSession() {
  stopPolling(); ss.del(TOKEN); ss.del(ORG); me = null; current = null;
  history.replaceState(null, '', location.pathname); // drop the #section without triggering the router
  signedOut();
}

function signedOut(view: 'signin' | 'forgot' | 'register' = 'signin', note = ''): void {
  $('#nav').hidden = true; $('#who').replaceChildren(); $('#org-switch').replaceChildren();
  if (view === 'register') return register();
  if (view === 'forgot') {
    const f: HTMLFormElement = el('form', { class: 'card narrow', id: 'forgot' }, el('h1', {}, 'Reset your password'),
      el('p', { class: 'muted' }, "Enter your work email and we'll send a reset link."),
      input('Email', { type: 'email', name: 'email', required: '', autocomplete: 'email' }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Send link'), btn('Back to sign in', () => signedOut(), 'btn link'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await act(() => api('POST', '/v1/auth/password-reset/request', { email: new FormData(f).get('email') }))) signedOut('signin', 'If that address has an account, a reset link is on its way.');
    });
    render(f);
    return;
  }
  const f = el('form', { class: 'card narrow', id: 'signin' }, el('h1', {}, 'Business portal'),
    el('p', { class: 'muted' }, 'For fleet operators, advertisers, creators, drivers and staff.'),
    note ? el('p', { class: 'ok' }, note) : null,
    input('Work email', { type: 'email', name: 'email', required: '', autocomplete: 'username' }),
    input('Password', { type: 'password', name: 'password', required: '', autocomplete: 'current-password' }),
    el('p', { class: 'err', id: 'signin-err' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), btn('Forgot password?', () => signedOut('forgot'), 'btn link'),
    el('p', { class: 'muted' }, 'New creator or advertiser? ', btn('Create an account', () => signedOut('register'), 'btn link', { id: 'to-register' })));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    try {
      const r = await api('POST', '/v1/auth/login', { email: d.get('email'), password: d.get('password') });
      ss.set(TOKEN, r.token);
      if (r.mfaRequired) return mfaChallenge();
      await boot();
    } catch (err) { $('#signin-err').textContent = errText(err); }
  });
  render(f);
}

/** Self-service sign-up for creator channels and advertisers. Fleet, driver and staff accounts are by invitation. */
function register() {
  const f: HTMLFormElement = el('form', { class: 'card narrow', id: 'register' }, el('h1', {}, 'Create an account'),
    el('fieldset', { class: 'kind' }, el('legend', {}, 'I am'),
      el('label', { class: 'check' }, el('input', { type: 'radio', name: 'kind', value: 'creator', checked: '' }), 'a creator — I make videos for passengers'),
      el('label', { class: 'check' }, el('input', { type: 'radio', name: 'kind', value: 'advertiser' }), 'an advertiser — I want to reach riders')),
    input('Channel or business name', { name: 'org', required: '', minlength: '2', maxlength: '100' }),
    input('Your name', { name: 'displayName', required: '', maxlength: '200', autocomplete: 'name' }),
    input('Work email', { name: 'email', type: 'email', required: '', autocomplete: 'email' }),
    input('Password (at least 12 characters)', { name: 'password', type: 'password', required: '', minlength: '12', autocomplete: 'new-password' }),
    el('p', { class: 'muted small' }, 'Fleet operators, drivers and staff join by invitation from their organization.'),
    el('p', { class: 'err', id: 'register-err' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Create account'), btn('Back to sign in', () => signedOut(), 'btn link'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f)) as Record<string, string>;
    const creator = d.kind === 'creator';
    try {
      await api('POST', creator ? '/v1/creators/register' : '/v1/advertisers/register', {
        ...(creator ? { channelName: d.org } : { organizationName: d.org }), displayName: d.displayName, email: d.email, password: d.password });
      signedOut('signin', `Check ${d.email} for a confirmation link, then sign in. (If you already have an account, we sent you a sign-in reminder instead.)`);
    } catch (err) { $('#register-err').textContent = errText(err); }
  });
  render(f);
}

function mfaChallenge() {
  const f = el('form', { class: 'card narrow', id: 'mfa' }, el('h1', {}, 'Two-step verification'),
    el('p', { class: 'muted' }, 'Enter the 6-digit code from your authenticator app.'),
    input('Code', { name: 'code', required: '', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6' }),
    el('p', { class: 'err', id: 'mfa-err' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Verify'), btn('Use a different account', () => { ss.del(TOKEN); signedOut(); }, 'btn link'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/v1/auth/mfa/verify', { code: new FormData(f).get('code') }); await boot(); } catch (err) { $('#mfa-err').textContent = errText(err); }
  });
  render(f);
}

/** One-time links from email: ?verify=…, ?reset=…, ?invite=… */
async function handleEmailLink(): Promise<boolean> {
  const p = new URLSearchParams(location.search);
  const clear = () => history.replaceState(null, '', location.pathname);
  const verify = p.get('verify');
  if (verify) {
    clear();
    try { await api('POST', '/v1/auth/verify-email', { token: verify }); signedOut('signin', 'Email confirmed. You can sign in.'); }
    catch (e) { signedOut('signin'); toast(errText(e), true); }
    return true;
  }
  for (const [param, path, title, help, field, required] of [
    ['reset', '/v1/auth/password-reset/confirm', 'Choose a new password', 'At least 12 characters. All your other sessions will be signed out.', 'newPassword', true],
    ['invite', '/v1/auth/accept-invitation', 'Accept your invitation', 'Choose a password (at least 12 characters). If you already have an account with this email, leave it empty.', 'password', false],
  ] as const) {
    const token = p.get(param);
    if (!token) continue;
    clear();
    const f = el('form', { class: 'card narrow', id: `${param}-form` }, el('h1', {}, title), el('p', { class: 'muted' }, help),
      input('Password', { type: 'password', name: 'pw', autocomplete: 'new-password', minlength: '12', ...(required ? { required: '' } : {}) }),
      el('p', { class: 'err', id: 'link-err' }), el('button', { class: 'btn primary', type: 'submit' }, 'Continue'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = String(new FormData(f).get('pw') ?? '');
      try {
        await api('POST', path, { token, ...(pw ? { [field]: pw } : {}) });
        signedOut('signin', param === 'invite' ? 'Invitation accepted. Sign in to continue.' : 'Password changed. Sign in with your new password.');
      } catch (err) { $('#link-err').textContent = errText(err); }
    });
    render(f);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ shell
export type Section = { id: string; title: string; perm: string; view: (arg?: string) => Promise<void> };
const SECTIONS: Record<string, Section[]> = {
  ADVERTISER: advertiserSections,
  CREATOR_STUDIO: creatorSections,
  PLATFORM: staffSections,
  FLEET_OPERATOR: [
    { id: 'overview', title: 'Overview', perm: 'device.read', view: () => fleetOverview() },
    { id: 'tablets', title: 'Tablets', perm: 'device.read', view: () => fleetTablets() },
    { id: 'add-tablet', title: 'Add a tablet', perm: 'device.manage', view: () => fleetAddTablet() },
    { id: 'vehicles', title: 'Vehicles & fleets', perm: 'fleet.read', view: () => fleetVehicles() },
    { id: 'drivers', title: 'Drivers', perm: 'fleet.read', view: () => fleetDrivers() },
    { id: 'team', title: 'Team', perm: 'org.members.manage', view: () => team(['fleet_admin', 'fleet_viewer', 'driver']) },
    ...driverSections,
  ],
};
const comingSoon = { id: 'home', title: 'Home', perm: '', view: async () => {
  render(el('div', { class: 'card' }, el('h1', {}, current!.name),
    el('p', {}, `The ${current!.kind.replace(/_/g, ' ').toLowerCase()} portal is coming next.`),
    el('p', { class: 'muted' }, 'Contact support if you expected to see your tools here.')));
} };
const sharedSections = [{ id: 'security', title: 'Security', perm: '', view: () => security() }];

async function boot() {
  if (!ss.get(TOKEN)) return signedOut();
  try {
    me = await api<Me>('GET', '/v1/me');
    orgs = (await api('GET', '/v1/orgs')).items;
  } catch { ss.del(TOKEN); return signedOut(); }
  if (me.user.mfaEnabled && !me.session.mfaVerified) return mfaChallenge();
  const mine = orgs.filter((o) => me!.memberships.some((m) => m.orgId === o.id));
  const pick = mine.find((o) => o.id === ss.get(ORG)) ?? mine[0];
  $('#who').replaceChildren(el('span', {}, me.user.displayName), ' ', btn('Sign out', async () => {
    await api('POST', '/v1/auth/logout').catch(() => {}); endSession();
  }, 'btn small'));
  if (!pick) { $('#nav').hidden = true; return render(el('div', { class: 'card' }, el('h1', {}, 'No organization yet'), el('p', { class: 'muted' }, 'Ask your administrator to invite you.'))); }
  const sw = el('select', { 'aria-label': 'Organization', id: 'org-select' });
  for (const o of mine) sw.append(el('option', { value: o.id, ...(o.id === pick.id ? { selected: '' } : {}) }, `${o.name} (${o.kind.replace(/_/g, ' ').toLowerCase()})`));
  sw.addEventListener('change', () => { ss.set(ORG, sw.value); history.replaceState(null, '', location.pathname); void boot(); });
  $('#org-switch').replaceChildren(mine.length > 1 ? sw : el('span', {}, pick.name));
  setOrg(pick.id);
  if (new URLSearchParams(location.search).get('subscription') && !location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/subscription`);
  const back = new URLSearchParams(location.search).get('prepayment');
  if (back) { history.replaceState(null, '', location.pathname + location.hash); toast(back === 'success' ? 'Payment received. Your balance updates as soon as the processor confirms it.' : 'Payment canceled. Nothing was charged.', back !== 'success'); }
  await route();
}

function setOrg(id: string) {
  const o = orgs.find((x) => x.id === id)!;
  const perms = new Set(me!.memberships.filter((m) => m.orgId === id).flatMap((m) => m.permissions));
  current = { id, kind: o.kind, name: o.name, perms };
  ss.set(ORG, id);
}

function sectionsFor() {
  return [...(SECTIONS[current!.kind] ?? [comingSoon]).filter((s) => !s.perm || can(s.perm)), ...sharedSections];
}

async function route() {
  if (!current || !ss.get(TOKEN)) return;
  const list = sectionsFor();
  const [id, ...rest] = (location.hash.replace(/^#\/?/, '') || list[0]!.id).split('/');
  const sec = list.find((s) => s.id === id) ?? list[0]!;
  const nav = $('#nav'); nav.hidden = false;
  nav.replaceChildren(...list.map((s) => el('a', { href: `#/${s.id}`, ...(s.id === sec.id ? { 'aria-current': 'page' } : {}) }, s.title)));
  stopPolling();
  try { await sec.view(rest.join('/') || undefined); } catch (e) { render(el('div', { class: 'card' }, el('p', { class: 'err' }, errText(e)))); }
}
window.addEventListener('hashchange', () => { void route(); });

let pollTimer = 0;
const stopPolling = () => { clearInterval(pollTimer); pollTimer = 0; };
export const poll = (fn: () => Promise<void>, ms = 30_000) => { stopPolling(); pollTimer = window.setInterval(() => { if (!document.hidden && !($('#dlg') as HTMLDialogElement).open) void fn().catch(() => {}); }, ms); };

// ------------------------------------------------------------------ fleet data
interface Device {
  id: string; serial: string; label: string | null; status: 'ACTIVE' | 'SUSPENDED' | 'RETIRED'; app_version: string | null; storage_free_bytes: string | null;
  last_heartbeat_at: string | null; online: boolean | null; vehicle_id: string | null; vehicle_label: string | null; pending_commands: number; keyType: string;
}
interface Vehicle { id: string; fleet_id: string; label: string; make_model: string | null; status?: string }
interface Fleet { id: string; name: string; market: string; timezone: string }
export const base = () => `/v1/orgs/${current!.id}`;
const loadDevices = async () => (await api<{ items: Device[] }>('GET', `${base()}/devices`)).items.filter((d) => d.status !== 'RETIRED');
const loadVehicles = async () => (await api<{ items: Vehicle[] }>('GET', `${base()}/vehicles`)).items;
const loadFleets = async () => (await api<{ items: Fleet[] }>('GET', `${base()}/fleets`)).items;

const LOW_STORAGE = 1024 ** 3; // 1 GiB
function issues(d: Device): string[] {
  const out: string[] = [];
  if (d.status === 'SUSPENDED') out.push('suspended');
  if (!d.online) out.push(d.last_heartbeat_at ? `offline since ${ago(d.last_heartbeat_at)}` : 'never connected');
  if (!d.vehicle_id) out.push('not assigned to a vehicle');
  if (d.storage_free_bytes !== null && Number(d.storage_free_bytes) < LOW_STORAGE) out.push('low storage');
  return out;
}
const tabletName = (d: Device) => d.label || d.serial;

async function fleetOverview() {
  const [devices, vehicles] = await Promise.all([loadDevices(), loadVehicles()]);
  const online = devices.filter((d) => d.online && d.status === 'ACTIVE').length;
  const stat = (n: number, l: string, id: string) => el('div', { class: 'stat', id }, el('div', { class: 'n' }, String(n)), el('div', { class: 'l' }, l));
  const attention = devices.filter((d) => issues(d).length);
  render(el('h1', {}, 'Overview'),
    el('div', { class: 'grid' },
      stat(online, 'Tablets playing now', 'stat-online'),
      stat(devices.filter((d) => !d.online).length, 'Offline (no check-in for 10 min)', 'stat-offline'),
      stat(devices.filter((d) => d.status === 'SUSPENDED').length, 'Suspended', 'stat-suspended'),
      stat(devices.filter((d) => !d.vehicle_id).length, 'Not assigned', 'stat-unassigned'),
      stat(vehicles.length, 'Vehicles', 'stat-vehicles')),
    el('div', { class: 'card', id: 'attention' }, el('h2', {}, 'Needs attention'),
      attention.length
        ? el('ul', { class: 'attention' }, ...attention.map((d) => el('li', {}, el('strong', {}, tabletName(d)), ` — ${issues(d).join(', ')}`)))
        : el('p', { class: 'muted' }, devices.length ? 'All tablets are healthy.' : 'No tablets yet.'),
      can('device.manage') && !devices.length ? el('p', {}, el('a', { href: '#/add-tablet' }, 'Add your first tablet →')) : null));
  poll(fleetOverview);
}

async function fleetTablets() {
  const [devices, vehicles] = await Promise.all([loadDevices(), loadVehicles()]);
  const manage = can('device.manage'), command = can('device.command');
  const send = (d: Device, c: string, ok: string) => act(() => api('POST', `${base()}/devices/${d.id}/commands`, { command: c }), ok).then(() => fleetTablets());
  const rows = devices.map((d) => {
    const statusChip = d.status === 'SUSPENDED' ? chip('Suspended', 'warn') : d.online ? chip('Online', 'ok') : chip('Offline', 'err');
    const actions = el('div', { class: 'actions' },
      manage ? btn(d.vehicle_id ? 'Move' : 'Assign', () => assignDialog(d, vehicles), 'btn small') : null,
      manage && d.vehicle_id ? btn('Unassign', () => act(() => api('POST', `${base()}/devices/${d.id}/unassign`), 'Tablet unassigned.').then(() => fleetTablets()), 'btn small') : null,
      command ? btn('Refresh', () => send(d, 'REFRESH_PLAYBACK', 'Refresh sent; the tablet picks it up at its next check-in.'), 'btn small') : null,
      command && d.status === 'ACTIVE' ? btn('Suspend', async () => {
        if (await dialog(`Suspend ${tabletName(d)}?`, [el('p', {}, 'Playback stops and nothing on this tablet is billed until you resume it. The rider signed in on it is signed out.')], 'Suspend', true)) await send(d, 'SUSPEND', 'Tablet suspended.');
      }, 'btn small') : null,
      command && d.status === 'SUSPENDED' ? btn('Resume', () => send(d, 'RESUME', 'Tablet resumed.'), 'btn small') : null,
      command ? btn('Clear rider', () => send(d, 'PURGE_RIDER_DATA', 'Rider signed out of this tablet.'), 'btn small') : null,
      btn('Details', () => tabletDetails(d), 'btn small'),
    );
    return el('tr', { 'data-serial': d.serial },
      el('td', {}, el('div', {}, tabletName(d)), d.label ? el('div', { class: 'sub' }, d.serial) : null),
      el('td', {}, statusChip, el('div', { class: 'sub' }, `seen ${ago(d.last_heartbeat_at)}`)),
      el('td', {}, d.vehicle_label ?? el('span', { class: 'muted' }, '—')),
      el('td', {}, d.keyType === 'ECDSA_P256' ? chip('Android app') : chip('Web player'), d.pending_commands ? el('div', { class: 'sub' }, `${d.pending_commands} command(s) waiting`) : null),
      el('td', {}, actions));
  });
  render(el('h1', {}, 'Tablets'),
    devices.length
      ? el('div', { class: 'table-wrap' }, el('table', { id: 'tablets' },
        el('thead', {}, el('tr', {}, ...['Tablet', 'Status', 'Vehicle', 'Type', ''].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows)))
      : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No tablets yet.'), manage ? el('a', { href: '#/add-tablet' }, 'Add a tablet →') : null),
    el('p', { class: 'muted' }, 'Tablets check in about once a minute; commands take effect at the next check-in. This page refreshes every 30 seconds.'));
  poll(fleetTablets);
}

async function assignDialog(d: Device, vehicles: Vehicle[]) {
  if (!vehicles.length) { toast('Add a vehicle first (Vehicles & fleets).', true); return; }
  const v = await dialog(`Assign ${tabletName(d)} to a vehicle`, [
    select('Vehicle', 'vehicleId', vehicles.map((x) => [x.id, x.label + (x.make_model ? ` (${x.make_model})` : '')]), { required: '' }),
    el('p', { class: 'muted' }, 'A vehicle has one tablet at a time; any tablet already in that vehicle is unassigned.'),
  ], 'Assign');
  if (!v) return;
  if (await act(() => api('POST', `${base()}/devices/${d.id}/assignments`, { vehicleId: v.vehicleId }), 'Tablet assigned.')) {
    await act(() => api('POST', `${base()}/devices/${d.id}/commands`, { command: 'REFRESH_PLAYBACK' }));
  }
  await fleetTablets();
}

async function tabletDetails(d: Device) {
  const hist = can('device.read') ? (await api('GET', `${base()}/devices/${d.id}/commands`)).items as any[] : [];
  const labelForm = el('form', { class: 'inline', id: 'label-form' }, input('Name', { name: 'label', value: d.label ?? '', maxlength: '100', placeholder: 'e.g. Back seat left' }),
    el('button', { class: 'btn', type: 'submit' }, 'Save name'));
  labelForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await act(() => api('PATCH', `${base()}/devices/${d.id}`, { label: String(new FormData(labelForm).get('label') ?? '') }), 'Name saved.')) { await closeDialog(); await fleetTablets(); }
  });
  const retire = btn('Retire tablet…', async () => {
    await closeDialog();
    const v = await dialog(`Retire ${tabletName(d)}?`, [
      el('p', {}, 'Use this for a lost, stolen, replaced or broken tablet. Its key stops working immediately and it cannot be undone; the tablet must be enrolled again with a new code.'),
      el('label', {}, 'Reason (kept in the audit log)', el('textarea', { name: 'reason', required: '', minlength: '5', maxlength: '500', rows: '2' })),
    ], 'Retire tablet', true);
    if (v && await act(() => api('POST', `${base()}/devices/${d.id}/retire`, { reason: v.reason }), 'Tablet retired.')) await fleetTablets();
  }, 'btn danger');
  await info(`Tablet ${tabletName(d)}`,
    el('p', { class: 'muted' }, `Serial ${d.serial} · ${d.keyType === 'ECDSA_P256' ? 'Android app (device key in Android Keystore)' : 'Web player (browser-held key)'} · version ${d.app_version ?? '?'}`),
    el('p', { class: 'muted' }, `Last check-in ${d.last_heartbeat_at ? fmtDate(d.last_heartbeat_at) : 'never'}${d.storage_free_bytes ? ` · ${(Number(d.storage_free_bytes) / 1024 ** 3).toFixed(1)} GB free` : ''}`),
    can('device.manage') ? labelForm : null,
    el('h2', {}, 'Recent commands'),
    hist.length ? el('table', {}, el('tbody', {}, ...hist.map((c) => el('tr', {}, el('td', {}, c.command.replace(/_/g, ' ').toLowerCase()), el('td', {}, c.status.toLowerCase()), el('td', { class: 'sub' }, `${ago(c.created_at)} by ${c.issued_by}`)))))
      : el('p', { class: 'muted' }, 'None.'),
    can('device.manage') ? el('p', {}, retire) : null);
}

async function fleetAddTablet() {
  const f = el('form', { class: 'inline', id: 'code-form' },
    input('Label (optional)', { name: 'label', maxlength: '100', placeholder: 'e.g. Van 12 rear' }),
    select('Valid for', 'ttl', [['30', '30 minutes'], ['120', '2 hours'], ['1440', '24 hours']]),
    el('button', { class: 'btn primary', type: 'submit' }, 'Create enrollment code'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    try {
      const r = await api('POST', `${base()}/devices/enrollment-codes`, { label: String(d.get('label') || '') || undefined, ttlMinutes: Number(d.get('ttl')) });
      await info('Enrollment code', el('p', {}, 'Type this code on the tablet’s setup screen. It works once and is shown only now.'),
        el('div', { class: 'code', id: 'new-code' }, r.code), el('p', { class: 'muted' }, `Expires ${fmtDate(r.expiresAt)}.`));
      await fleetAddTablet();
    } catch (err) { toast(errText(err), true); }
  });
  const codes = (await api('GET', `${base()}/devices/enrollment-codes`)).items as any[];
  render(el('h1', {}, 'Add a tablet'),
    el('div', { class: 'card' }, el('h2', {}, '1. Install'),
      el('p', {}, 'Android tablet: install the Ride Screen app through your device management (EMM) or for a pilot with adb. Any other tablet: open '),
      el('p', { class: 'code' }, `${location.origin}/player/`),
      el('p', { class: 'muted' }, 'in its browser in full-screen/kiosk mode. The Android app is recommended: it keeps the device key in secure hardware and locks the tablet to the player.')),
    el('div', { class: 'card' }, el('h2', {}, '2. Create a one-time code'), f),
    el('div', { class: 'card' }, el('h2', {}, '3. Assign it'), el('p', {}, 'After the tablet shows “Waiting for vehicle assignment”, assign it on the '), el('a', { href: '#/tablets' }, 'Tablets page.')),
    el('div', { class: 'card' }, el('h2', {}, 'Recent codes (last 7 days)'),
      codes.length ? el('table', { id: 'codes' }, el('tbody', {}, ...codes.map((c) => el('tr', {},
        el('td', {}, c.label || el('span', { class: 'muted' }, 'no label')),
        el('td', {}, c.state === 'ACTIVE' ? chip('Unused', 'ok') : c.state === 'USED' ? chip(`Used by ${c.device_serial ?? 'a tablet'}`) : chip('Expired')),
        el('td', { class: 'sub' }, `created ${ago(c.created_at)}`),
        el('td', {}, c.state === 'ACTIVE' ? btn('Revoke', () => act(() => api('POST', `${base()}/devices/enrollment-codes/${c.id}/revoke`), 'Code revoked.').then(() => fleetAddTablet()), 'btn small danger') : null)))))
        : el('p', { class: 'muted' }, 'None.')));
}

async function fleetVehicles() {
  const [fleets, vehicles, devices] = await Promise.all([loadFleets(), loadVehicles(), loadDevices()]);
  const manage = can('fleet.manage');
  const byVehicle = new Map(devices.filter((d) => d.vehicle_id).map((d) => [d.vehicle_id!, d]));
  const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
  const addFleet = el('form', { class: 'inline', id: 'fleet-form' },
    input('Fleet name', { name: 'name', required: '', maxlength: '200' }), input('Market', { name: 'market', required: '', maxlength: '100', placeholder: 'e.g. Springfield' }),
    input('Time zone', { name: 'timezone', required: '', value: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    el('button', { class: 'btn', type: 'submit' }, 'Add fleet'));
  addFleet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(addFleet));
    if (await act(() => api('POST', `${base()}/fleets`, d), 'Fleet added.')) await fleetVehicles();
  });
  const addVehicle = el('form', { class: 'inline', id: 'vehicle-form' },
    select('Fleet', 'fleetId', fleets.map((f) => [f.id, f.name]), { required: '' }),
    input('Vehicle label', { name: 'label', required: '', maxlength: '100', placeholder: 'e.g. CAB-104' }), input('Make / model (optional)', { name: 'makeModel', maxlength: '200' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Add vehicle'));
  addVehicle.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(addVehicle)) as Record<string, string>;
    if (await act(() => api('POST', `${base()}/vehicles`, { fleetId: d.fleetId, label: d.label, ...(d.makeModel ? { makeModel: d.makeModel } : {}) }), 'Vehicle added.')) await fleetVehicles();
  });
  render(el('h1', {}, 'Vehicles & fleets'),
    manage ? el('div', { class: 'card' }, el('h2', {}, 'Add a vehicle'), fleets.length ? addVehicle : el('p', { class: 'muted' }, 'Add a fleet first.')) : null,
    el('div', { class: 'table-wrap' }, el('table', { id: 'vehicles' },
      el('thead', {}, el('tr', {}, ...['Vehicle', 'Fleet', 'Tablet'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...vehicles.map((v) => el('tr', {},
        el('td', {}, v.label, v.make_model ? el('div', { class: 'sub' }, v.make_model) : null),
        el('td', {}, fleetName.get(v.fleet_id) ?? ''),
        el('td', {}, byVehicle.get(v.id) ? tabletName(byVehicle.get(v.id)!) : el('span', { class: 'muted' }, 'none'))))))),
    el('div', { class: 'card' }, el('h2', {}, 'Fleets'),
      fleets.length ? el('ul', {}, ...fleets.map((f) => el('li', {}, `${f.name} — ${f.market} (${f.timezone})`))) : el('p', { class: 'muted' }, 'No fleets yet.'),
      manage ? addFleet : null));
}

async function fleetDrivers() {
  const drivers = (await api('GET', `${base()}/drivers`)).items as any[];
  const canAdd = can('fleet.manage') && can('org.members.manage');
  const [members, fleets] = canAdd ? await Promise.all([api('GET', `${base()}/members`).then((r) => r.items as any[]), loadFleets()]) : [[], []];
  const waiting = members.filter((m) => m.role === 'driver' && m.status === 'ACTIVE' && !drivers.some((d) => d.user_id === m.user_id));
  const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
  const label: Record<string, [string, '' | 'ok' | 'warn' | 'err']> = { ELIGIBLE: ['Eligible for earnings', 'ok'], PENDING: ['Pending', 'warn'], SUSPENDED: ['Suspended', 'err'], TERMINATED: ['Ended', ''] };
  const add = async (m: any) => {
    if (!fleets.length) { toast('Add a fleet first (Vehicles & fleets).', true); return; }
    const v = await dialog(`Add ${m.display_name} to a fleet`, [select('Fleet', 'fleetId', fleets.map((f) => [f.id, `${f.name} (${f.market})`]))], 'Add driver');
    if (v && await act(() => api('POST', `${base()}/drivers`, { userId: m.user_id, fleetId: v.fleetId }), 'Driver added. They can now subscribe and see earnings.')) await fleetDrivers();
  };
  render(el('h1', {}, 'Drivers'),
    el('p', { class: 'muted' }, 'Drivers join by invitation (Team), then you add them to a fleet here. Earnings eligibility is confirmed by platform staff after the subscription, participation terms and payout setup are complete. Earnings are not guaranteed.'),
    waiting.length ? el('div', { class: 'card', id: 'waiting-drivers' }, el('h2', {}, 'Accepted invitations — add to a fleet'),
      el('table', {}, el('tbody', {}, ...waiting.map((m) => el('tr', { 'data-email': m.email }, el('td', {}, m.display_name, el('div', { class: 'sub' }, m.email)),
        el('td', {}, btn('Add to fleet', () => add(m), 'btn small primary'))))))) : null,
    drivers.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'drivers' }, el('tbody', {}, ...drivers.map((d) => el('tr', {},
      el('td', {}, d.display_name, fleetName.get(d.fleet_id) ? el('div', { class: 'sub' }, fleetName.get(d.fleet_id)!) : null), el('td', {}, chip(...(label[d.eligibility_status] ?? [d.eligibility_status, ''])))))))) : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No drivers yet.')));
}

// ------------------------------------------------------------------ shared sections
export async function team(roles: string[]) {
  const inv = (await api('GET', `${base()}/invitations`)).items as any[];
  const f = el('form', { class: 'inline', id: 'invite-form' },
    input('Name', { name: 'displayName', required: '', maxlength: '200' }), input('Email', { name: 'email', type: 'email', required: '' }),
    select('Role', 'role', roles.map((r) => [r, r.replace(/_/g, ' ')])),
    el('button', { class: 'btn primary', type: 'submit' }, 'Send invitation'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await act(() => api('POST', `${base()}/invitations`, Object.fromEntries(new FormData(f))), 'Invitation sent. The link is valid for 7 days.')) await team(roles);
  });
  const state = (i: any) => i.accepted_at ? chip('Accepted', 'ok') : i.revoked_at ? chip('Revoked') : Date.parse(i.expires_at) < Date.now() ? chip('Expired') : chip('Pending', 'warn');
  render(el('h1', {}, 'Team'),
    el('div', { class: 'card' }, el('h2', {}, 'Invite someone'), f,
      el('p', { class: 'muted' }, 'fleet admin: manages vehicles, tablets and team · fleet viewer: read-only · driver: sees their own earnings.')),
    el('div', { class: 'table-wrap' }, el('table', { id: 'invitations' },
      el('thead', {}, el('tr', {}, ...['Name', 'Email', 'Role', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...inv.map((i) => el('tr', {}, el('td', {}, i.display_name), el('td', {}, i.email), el('td', {}, i.role_code.replace(/_/g, ' ')), el('td', {}, state(i)),
        el('td', {}, !i.accepted_at && !i.revoked_at && Date.parse(i.expires_at) > Date.now()
          ? btn('Revoke', () => act(() => api('POST', `${base()}/invitations/${i.id}/revoke`), 'Invitation revoked.').then(() => team(roles)), 'btn small danger') : null)))))));
}

async function security() {
  const u = me!.user;
  const card = el('div', { class: 'card', id: 'mfa-card' }, el('h2', {}, 'Two-step verification'));
  if (u.mfaEnabled) card.append(el('p', { class: 'ok' }, 'On. You will be asked for a code from your authenticator app when you sign in.'));
  else {
    card.append(el('p', {}, 'Recommended for everyone, and required for finance and platform actions.'), btn('Set up two-step verification', async () => {
      try {
        const r = await api('POST', '/v1/auth/mfa/enroll');
        const v = await dialog('Scan with your authenticator app', [qrSvg(r.otpauthUri, 'Authenticator setup QR code'),
          el('p', { class: 'muted' }, 'Or enter this key manually:'), el('div', { class: 'code' }, r.secret),
          input('Then enter the 6-digit code', { name: 'code', required: '', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: '6', autocomplete: 'one-time-code' })], 'Turn on');
        if (v && await act(() => api('POST', '/v1/auth/mfa/activate', { code: v.code }), 'Two-step verification is on.')) await boot();
      } catch (e) { toast(errText(e), true); }
    }, 'btn primary'));
  }
  render(el('h1', {}, 'Security'), el('div', { class: 'card' }, el('h2', {}, 'Account'), el('p', {}, `${u.displayName} · ${u.email}`)), card);
}

// ------------------------------------------------------------------ start
setUnauthorizedHandler(endSession);
void (async () => { if (!(await handleEmailLink())) await boot(); })();
