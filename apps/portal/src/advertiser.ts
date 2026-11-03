/**
 * Advertiser section of the business portal: campaigns (create, edit drafts, submit, pause/resume/end), ads with
 * resumable uploads, coupon/commission offers, location alerts, results, sponsored game rewards and prepaid billing.
 * The API enforces every rule (budgets, review, funds, family-friendly text screens); the UI explains them.
 */
import { base, can, poll, team, type Section } from './main';
import { act, ago, api, btn, chip, closeDialog, dialog, el, errText, fmtDate, input, money, render, select, toMinor, toast, type Kid } from './ui';

export const advertiserSections: Section[] = [
  { id: 'overview', title: 'Overview', perm: 'campaign.read', view: () => overview() },
  { id: 'campaigns', title: 'Campaigns', perm: 'campaign.read', view: (id) => (id ? campaignDetail(id) : campaigns()) },
  { id: 'rewards', title: 'Game rewards', perm: 'campaign.read', view: () => rewards() },
  { id: 'billing', title: 'Billing', perm: 'campaign.read', view: () => billing() },
  { id: 'team', title: 'Team', perm: 'org.members.manage', view: () => team(['advertiser_admin', 'advertiser_member']) },
];

// ------------------------------------------------------------------ data
interface Campaign {
  id: string; name: string; status: string; category: string; pricingModel: 'CPM' | 'CPQV'; rateMinor: string; currency: string; startsAt: string; endsAt: string;
  destinationUrl: string | null; markets: string[]; frequencyCapPerHour: number | null; priority: number; skipDelaySeconds: number;
  schedule: { timezone: string; daysOfWeek: number[]; startMinute: number; endMinute: number };
  totalBudgetMinor: string | null; dailyBudgetMinor: string | null; reviewNote: string | null; submittedAt: string | null;
  creatives?: Creative[];
}
interface Creative { id: string; name: string; kind: 'VIDEO' | 'BANNER' | 'DISPLAY'; status: string; durationMs: number | null; headline: string | null; bodyText: string | null; reviewNote: string | null }
interface Spend { spent: string; spentToday: string; unbilled: string; totalBudget: string | null; dailyBudget: string | null; remainingBudget: string | null; deliveryBlockedBy: string | null }
interface Metrics { impressions: string; starts: string; qualifiedViews: string; completions: string; skips: string; visibleSeconds: string; averageVisibleSeconds: string; clicks: string; ctr: string; invalidEvents: string; heldEvents: string }

const CATEGORIES: Array<[string, string]> = [['GENERAL', 'General'], ['FOOD_DRINK', 'Food & drink'], ['RETAIL', 'Retail'], ['ENTERTAINMENT', 'Entertainment'], ['TRAVEL', 'Travel'],
  ['LOCAL_SERVICES', 'Local services'], ['AUTOMOTIVE', 'Automotive'], ['TECHNOLOGY', 'Technology'], ['EDUCATION', 'Education'], ['HEALTH_WELLNESS', 'Health & wellness'],
  ['FINANCIAL_SERVICES', 'Financial services'], ['NONPROFIT', 'Nonprofit']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS: Record<string, [string, '' | 'ok' | 'warn' | 'err']> = {
  DRAFT: ['Draft', ''], PENDING_REVIEW: ['In review', 'warn'], APPROVED: ['Running', 'ok'], REJECTED: ['Changes needed', 'err'], PAUSED: ['Paused', 'warn'], ENDED: ['Ended', ''],
};
const statusChip = (s: string) => chip(...(STATUS[s] ?? [s, '']));
const creativeChip = (s: string) => s === 'APPROVED' ? chip('Approved', 'ok') : s === 'REJECTED' ? chip('Rejected', 'err') : chip('In review', 'warn');
const BLOCK: Record<string, string> = {
  BUDGET_EXHAUSTED: 'Total budget reached — delivery has stopped. Raise the budget on a new campaign to continue.',
  DAILY_BUDGET_EXHAUSTED: 'Today’s budget is used up — delivery resumes tomorrow.',
  ADVERTISER_FUNDS_EXHAUSTED: 'Your prepaid balance is used up — add funds under Billing to resume delivery.',
  CAMPAIGN_DRAFT: 'Draft — add ads and submit for review.', CAMPAIGN_PENDING_REVIEW: 'Waiting for platform review (usually within one business day).',
  CAMPAIGN_REJECTED: 'Changes needed — see the reviewer’s note, edit and resubmit.', CAMPAIGN_PAUSED: 'Paused by you.', CAMPAIGN_ENDED: 'Ended.',
};
const priceText = (c: Pick<Campaign, 'pricingModel' | 'rateMinor' | 'currency'>) =>
  c.pricingModel === 'CPM' ? `${money(c.rateMinor, c.currency)} per 1,000 impressions` : `${money(c.rateMinor, c.currency)} per qualified view`;
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toLocalInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const fromLocalInput = (v: string) => new Date(v).toISOString();

const loadCampaigns = async () => (await api<{ items: Campaign[] }>('GET', `${base()}/campaigns`)).items;
const loadMetrics = (id: string, from: Date, to = new Date()) => api<Metrics>('GET', `${base()}/campaigns/${id}/metrics?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const stat = (n: string, l: string, id: string) => el('div', { class: 'stat', id }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l));

// ------------------------------------------------------------------ overview
async function overview() {
  const [list, bal] = await Promise.all([loadCampaigns(), api('GET', `${base()}/balance`)]);
  const usd = bal.balances.USD;
  const live = list.filter((c) => c.status === 'APPROVED');
  const week = await Promise.all(live.map((c) => loadMetrics(c.id, daysAgo(7))));
  const sum = (k: keyof Metrics) => week.reduce((a, m) => a + Number(m[k]), 0);
  const todo: Kid[] = [];
  for (const c of list) {
    const link = el('a', { href: `#/campaigns/${c.id}` }, c.name);
    if (c.status === 'REJECTED') todo.push(el('li', {}, link, ' — changes needed: ', c.reviewNote ?? ''));
    if (c.status === 'DRAFT') todo.push(el('li', {}, link, ' — draft: add ads and submit for review'));
  }
  if (!usd || BigInt(usd.available) <= 0n) todo.unshift(el('li', {}, 'Your prepaid balance is empty. ', el('a', { href: '#/billing' }, 'Add funds'), ' so approved campaigns can run.'));
  render(el('h1', {}, 'Overview'),
    el('div', { class: 'grid' },
      stat(money(usd?.available ?? '0'), 'Available to spend', 'stat-available'),
      stat(String(live.length), 'Campaigns running', 'stat-running'),
      stat(sum('impressions').toLocaleString(), 'Impressions, last 7 days', 'stat-impressions'),
      stat(sum('qualifiedViews').toLocaleString(), 'Qualified views, last 7 days', 'stat-qualified'),
      stat(sum('clicks').toLocaleString(), 'Taps & QR scans, last 7 days', 'stat-clicks')),
    el('div', { class: 'card', id: 'todo' }, el('h2', {}, 'To do'),
      todo.length ? el('ul', { class: 'attention' }, ...todo) : el('p', { class: 'muted' }, list.length ? 'Nothing needs your attention.' : 'Create your first campaign to reach riders.'),
      can('campaign.manage') && !list.length ? el('p', {}, el('a', { href: '#/campaigns' }, 'Create a campaign →')) : null),
    el('p', { class: 'muted' }, 'Only events that pass validation are counted and billed. Earnings for drivers and creators come from the same validated events.'));
}

// ------------------------------------------------------------------ campaigns list
async function campaigns() {
  const list = await loadCampaigns();
  render(el('div', { class: 'row-head' }, el('h1', {}, 'Campaigns'), can('campaign.manage') ? btn('New campaign', () => campaignForm(), 'btn primary', { id: 'new-campaign' }) : null),
    list.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'campaigns' },
      el('thead', {}, el('tr', {}, ...['Campaign', 'Status', 'Dates', 'Price', 'Budget'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...list.map((c) => el('tr', {},
        el('td', {}, el('a', { href: `#/campaigns/${c.id}` }, c.name), el('div', { class: 'sub' }, c.markets.join(', ') || 'all markets')),
        el('td', {}, statusChip(c.status)),
        el('td', { class: 'sub' }, `${new Date(c.startsAt).toLocaleDateString()} – ${new Date(c.endsAt).toLocaleDateString()}`),
        el('td', {}, priceText(c)),
        el('td', {}, c.totalBudgetMinor ? money(c.totalBudgetMinor) : el('span', { class: 'muted' }, 'balance only'), c.dailyBudgetMinor ? el('div', { class: 'sub' }, `${money(c.dailyBudgetMinor)}/day`) : null))))))
      : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No campaigns yet.')));
}

/** Create (no campaign) or edit a draft/rejected campaign. */
async function campaignForm(c?: Campaign) {
  const now = new Date(), later = new Date(Date.now() + 30 * 86_400_000);
  const sch = c?.schedule ?? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 };
  const days = el('fieldset', { class: 'days' }, el('legend', {}, 'Days'), ...DAYS.map((d, i) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: `day${i}`, value: '1', ...(sch.daysOfWeek.includes(i) ? { checked: '' } : {}) }), d)));
  const v = await dialog(c ? `Edit ${c.name}` : 'New campaign', [
    input('Campaign name', { name: 'name', required: '', maxlength: '200', value: c?.name ?? '' }),
    select('Category', 'category', CATEGORIES),
    el('p', { class: 'muted small' }, 'Alcohol, cannabis, tobacco, gambling, firearms, adult, political, prescription drugs, dating and crypto ads are not accepted.'),
    el('div', { class: 'two' },
      select('Pay for', 'pricingModel', [['CPQV', 'Qualified views (watched 2+ s, visible, unmuted)'], ['CPM', 'Impressions (per 1,000)']]),
      input('Price ($)', { name: 'rate', required: '', inputmode: 'decimal', value: c ? (Number(c.rateMinor) / 100).toFixed(2) : '0.50', pattern: '\\d+(\\.\\d{1,2})?' })),
    el('div', { class: 'two' },
      input('Starts', { type: 'datetime-local', name: 'startsAt', required: '', value: toLocalInput(c?.startsAt ?? now.toISOString()) }),
      input('Ends', { type: 'datetime-local', name: 'endsAt', required: '', value: toLocalInput(c?.endsAt ?? later.toISOString()) })),
    el('div', { class: 'two' },
      input('Total budget ($, optional)', { name: 'total', inputmode: 'decimal', value: c?.totalBudgetMinor ? (Number(c.totalBudgetMinor) / 100).toFixed(2) : '' }),
      input('Daily budget ($, optional)', { name: 'daily', inputmode: 'decimal', value: c?.dailyBudgetMinor ? (Number(c.dailyBudgetMinor) / 100).toFixed(2) : '' })),
    input('Markets (comma-separated; empty = all)', { name: 'markets', value: c?.markets.join(', ') ?? '', placeholder: 'e.g. Springfield' }),
    input('Landing page (https, optional) — riders open it on their phone by QR', { name: 'destinationUrl', type: 'url', value: c?.destinationUrl ?? '', placeholder: 'https://' }),
    el('details', {}, el('summary', {}, 'Schedule and delivery'),
      days,
      el('div', { class: 'two' }, input('From', { type: 'time', name: 'from', value: hhmm(sch.startMinute) }), input('Until', { type: 'time', name: 'until', value: sch.endMinute >= 1440 ? '23:59' : hhmm(sch.endMinute) })),
      input('Time zone', { name: 'timezone', value: sch.timezone }),
      el('div', { class: 'two' }, input('Skip allowed after (s)', { name: 'skip', type: 'number', min: '0', max: '60', value: String(c?.skipDelaySeconds ?? 5) }),
        input('Max plays per tablet per hour (optional)', { name: 'cap', type: 'number', min: '1', max: '60', value: c?.frequencyCapPerHour ? String(c.frequencyCapPerHour) : '' }))),
  ], c ? 'Save changes' : 'Create draft');
  if (!v) return;
  const rate = toMinor(v.rate!), total = v.total ? toMinor(v.total) : null, daily = v.daily ? toMinor(v.daily) : null;
  if (!rate || (v.total && !total) || (v.daily && !daily)) { toast('Enter amounts in dollars, e.g. 0.50 or 250', true); return; }
  const minutes = (t: string, end = false) => { const [h, m] = t.split(':').map(Number); const x = h! * 60 + m!; return end && x === 23 * 60 + 59 ? 1440 : x; };
  const daysOfWeek = DAYS.map((_, i) => i).filter((i) => v[`day${i}`] === '1');
  const body: Record<string, unknown> = {
    name: v.name, category: v.category, pricingModel: v.pricingModel, rateMinor: rate, startsAt: fromLocalInput(v.startsAt!), endsAt: fromLocalInput(v.endsAt!),
    markets: v.markets!.split(',').map((s) => s.trim()).filter(Boolean), skipDelaySeconds: Number(v.skip || 5), timezone: v.timezone || 'UTC',
    daysOfWeek: daysOfWeek.length ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6], startMinute: minutes(v.from || '00:00'), endMinute: minutes(v.until || '23:59', true),
  };
  if (c) Object.assign(body, { totalBudgetMinor: total, dailyBudgetMinor: daily, destinationUrl: v.destinationUrl || null, frequencyCapPerHour: v.cap ? Number(v.cap) : null });
  else Object.assign(body, total ? { totalBudgetMinor: total } : {}, daily ? { dailyBudgetMinor: daily } : {}, v.destinationUrl ? { destinationUrl: v.destinationUrl } : {}, v.cap ? { frequencyCapPerHour: Number(v.cap) } : {});
  try {
    const r = c ? await api<Campaign>('PATCH', `${base()}/campaigns/${c.id}`, body) : await api<Campaign>('POST', `${base()}/campaigns`, body);
    toast(c ? 'Changes saved.' : 'Draft created. Now add your ads.');
    location.hash = `#/campaigns/${r.id}`;
    if (c) await campaignDetail(r.id);
  } catch (e) { toast(errText(e), true); }
}

// ------------------------------------------------------------------ campaign detail
async function campaignDetail(id: string) {
  const c = await api<Campaign>('GET', `${base()}/campaigns/${id}`);
  const [spend, week, all, offers, fences] = await Promise.all([
    api<Spend>('GET', `${base()}/campaigns/${id}/spend`), loadMetrics(id, daysAgo(7)), loadMetrics(id, new Date(Math.min(Date.parse(c.startsAt), Date.now() - 1000))),
    api('GET', `${base()}/campaigns/${id}/commission-offers`).then((r) => r.items as any[]), api('GET', `${base()}/campaigns/${id}/geofences`).then((r) => r.items as any[]),
  ]);
  const manage = can('campaign.manage');
  const editable = ['DRAFT', 'REJECTED'].includes(c.status);
  const transition = (action: string, msg: string) => act(() => api('POST', `${base()}/campaigns/${id}/${action}`), msg).then(() => campaignDetail(id));
  const actions = el('div', { class: 'actions', id: 'campaign-actions' },
    manage && editable ? btn('Edit', () => campaignForm(c), 'btn') : null,
    manage && editable ? btn('Submit for review', () => transition('submit', 'Submitted. A reviewer checks the campaign and every ad before it can run.'), 'btn primary') : null,
    manage && c.status === 'APPROVED' ? btn('Pause', () => transition('pause', 'Campaign paused.'), 'btn') : null,
    manage && c.status === 'PAUSED' ? btn('Resume', () => transition('resume', 'Campaign resumed.'), 'btn primary') : null,
    manage && ['APPROVED', 'PAUSED'].includes(c.status) ? btn('End campaign', async () => {
      if (await dialog(`End ${c.name}?`, [el('p', {}, 'Delivery stops now and cannot be restarted. Results and billing for past plays stay available.')], 'End campaign', true)) await transition('end', 'Campaign ended.');
    }, 'btn danger') : null);
  const m = (x: Metrics) => [['Impressions', x.impressions], ['Qualified views', x.qualifiedViews], ['Completed views', x.completions], ['Taps & QR scans', x.clicks],
    ['Tap rate', `${(Number(x.ctr) * 100).toFixed(2)}%`], ['Avg. seconds watched', x.averageVisibleSeconds]] as const;
  const results = el('table', { id: 'results' }, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Last 7 days'), el('th', {}, 'Since start'))),
    el('tbody', {}, ...m(week).map(([k, v], i) => el('tr', {}, el('td', {}, k), el('td', {}, Number.isNaN(Number(v)) ? v : Number(v).toLocaleString()), el('td', {}, (() => { const a = m(all)[i]![1]; return Number.isNaN(Number(a)) ? a : Number(a).toLocaleString(); })())))));
  render(
    el('p', {}, el('a', { href: '#/campaigns' }, '← All campaigns')),
    el('div', { class: 'row-head' }, el('h1', { id: 'campaign-name' }, c.name), statusChip(c.status)),
    c.status === 'REJECTED' && c.reviewNote ? el('div', { class: 'card notice err-border', id: 'review-note' }, el('strong', {}, 'Reviewer’s note: '), c.reviewNote) : null,
    actions,
    el('div', { class: 'grid' },
      stat(money(spend.spent), 'Spent so far', 'stat-spent'), stat(money(spend.spentToday), 'Spent today', 'stat-today'),
      stat(spend.remainingBudget !== null ? money(spend.remainingBudget) : '—', spend.totalBudget ? `Left of ${money(spend.totalBudget)} budget` : 'No total budget (limited by balance)', 'stat-remaining'),
      stat(priceText(c), `${new Date(c.startsAt).toLocaleDateString()} – ${new Date(c.endsAt).toLocaleDateString()}`, 'stat-price')),
    el('div', { class: 'card', id: 'delivery' }, el('h2', {}, 'Delivery'),
      el('p', {}, spend.deliveryBlockedBy ? (BLOCK[spend.deliveryBlockedBy] ?? spend.deliveryBlockedBy) : 'Delivering to tablets in your markets during your schedule.'),
      el('p', { class: 'muted' }, `${c.markets.length ? c.markets.join(', ') : 'All markets'} · ${c.schedule.daysOfWeek.length === 7 ? 'every day' : c.schedule.daysOfWeek.map((d) => DAYS[d]).join(', ')} ${hhmm(c.schedule.startMinute)}–${c.schedule.endMinute >= 1440 ? '24:00' : hhmm(c.schedule.endMinute)} (${c.schedule.timezone}) · skip after ${c.skipDelaySeconds}s`)),
    el('div', { class: 'card' }, el('h2', {}, 'Results'), results,
      el('p', { class: 'muted' }, `Counted from validated plays only. ${Number(all.invalidEvents) ? `${all.invalidEvents} plays were rejected by validation (not billed).` : ''}`)),
    creativesCard(c, manage),
    offersCard(c, offers, manage),
    fencesCard(c, fences, manage));
}

function creativesCard(c: Campaign, manage: boolean) {
  const list = c.creatives ?? [];
  const canAdd = manage && c.status !== 'ENDED';
  return el('div', { class: 'card', id: 'creatives' }, el('h2', {}, 'Ads'),
    list.length ? el('table', {}, el('tbody', {}, ...list.map((k) => el('tr', {},
      el('td', {}, k.name, el('div', { class: 'sub' }, k.kind === 'VIDEO' ? `Video · ${Math.round((k.durationMs ?? 0) / 1000)} s` : k.kind === 'DISPLAY' ? 'Image' : `Text banner · “${k.headline ?? ''}”`)),
      el('td', {}, creativeChip(k.status), k.reviewNote ? el('div', { class: 'sub' }, k.reviewNote) : null)))))
      : el('p', { class: 'muted' }, 'No ads yet. Add at least one before submitting.'),
    canAdd ? el('div', { class: 'actions' },
      btn('Upload a video ad', () => addMediaCreative(c, 'VIDEO'), 'btn', { id: 'add-video' }),
      btn('Upload an image ad', () => addMediaCreative(c, 'DISPLAY'), 'btn', { id: 'add-image' }),
      btn('Add a text banner', () => addBanner(c), 'btn', { id: 'add-banner' })) : null,
    canAdd && ['APPROVED', 'PAUSED'].includes(c.status) ? el('p', { class: 'muted' }, 'New ads on a running campaign are reviewed before they play.') : null);
}

async function addBanner(c: Campaign) {
  const v = await dialog('Text banner', [
    el('p', { class: 'muted' }, 'Shown along the bottom of the screen while riders watch creator videos.'),
    input('Name (internal)', { name: 'name', required: '', maxlength: '200', value: 'Banner' }),
    input('Headline (up to 90 characters)', { name: 'headline', required: '', maxlength: '90' }),
    input('Extra line (optional)', { name: 'bodyText', maxlength: '280' }),
  ], 'Add banner');
  if (!v) return;
  if (await act(() => api('POST', `${base()}/campaigns/${c.id}/creatives`, { kind: 'BANNER', name: v.name, headline: v.headline, ...(v.bodyText ? { bodyText: v.bodyText } : {}) }), 'Banner added.')) await campaignDetail(c.id);
}

async function addMediaCreative(c: Campaign, kind: 'VIDEO' | 'DISPLAY') {
  const file = el('input', { type: 'file', name: 'file', required: '', accept: kind === 'VIDEO' ? 'video/mp4,video/quicktime,video/webm' : 'image/png,image/jpeg', id: 'file' });
  const progress = el('progress', { max: '100', value: '0', id: 'upload-progress', hidden: '' });
  const statusLine = el('p', { class: 'muted', id: 'upload-status' });
  const v = await dialog(kind === 'VIDEO' ? 'Upload a video ad' : 'Upload an image ad', [
    el('p', { class: 'muted' }, kind === 'VIDEO' ? 'MP4, MOV or WebM, landscape, 6–60 seconds. Every ad is reviewed by a person before it plays.' : 'PNG or JPEG, landscape. Every ad is reviewed by a person before it plays.'),
    input('Name (internal)', { name: 'name', required: '', maxlength: '200', value: kind === 'VIDEO' ? 'Video ad' : 'Image ad' }),
    el('label', {}, 'File', file),
    input('Headline shown with the ad (optional)', { name: 'headline', maxlength: '90' }),
  ], 'Upload');
  const f = (file as HTMLInputElement).files?.[0];
  if (!v || !f) return;
  // Upload inside a progress dialog so the user sees each stage.
  const d = document.querySelector('#dlg') as HTMLDialogElement;
  d.replaceChildren(el('h2', {}, `Uploading ${f.name}`), progress, statusLine);
  progress.hidden = false;
  d.showModal();
  const say = (t: string) => { statusLine.textContent = t; };
  try {
    const uploadId = await uploadFile(f, (pct) => { (progress as HTMLProgressElement).value = pct; say(`Uploading… ${pct}%`); }, say);
    say('Checking and processing the file…');
    const asset = await waitForProcessing(uploadId);
    await api('POST', `${base()}/campaigns/${c.id}/creatives`, { kind, name: v.name, uploadId, ...(v.headline ? { headline: v.headline } : {}) });
    await closeDialog();
    toast(kind === 'VIDEO' ? `Video added (${Math.round((asset?.durationMs ?? 0) / 1000)} s).` : 'Image added.');
  } catch (e) {
    await closeDialog();
    toast(errText(e), true);
  }
  await campaignDetail(c.id);
}

const MAX_BROWSER_UPLOAD = 1024 ** 3; // the browser hashes the file in memory; larger files need the resumable API directly

/** Resumable chunked upload: declare size + SHA-256, send chunks with Content-Range, then complete. */
async function uploadFile(f: File, onProgress: (pct: number) => void, say: (t: string) => void): Promise<string> {
  if (f.size > MAX_BROWSER_UPLOAD) throw new Error('Files over 1 GB must be uploaded with the API.');
  say('Preparing…');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const u = await api('POST', `${base()}/uploads`, { filename: f.name.slice(0, 255), contentType: f.type || 'application/octet-stream', sizeBytes: f.size, sha256: digest });
  const chunk = Math.min(u.chunkSizeLimit as number, 8 * 1024 * 1024);
  let offset = 0;
  while (offset < f.size) {
    const end = Math.min(offset + chunk, f.size);
    const token = sessionStorage.getItem('rmn_portal_token');
    const res = await fetch(`/v1/uploads/${u.uploadId}/content`, { method: 'PUT', body: f.slice(offset, end),
      headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${offset}-${end - 1}/${f.size}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message ?? `upload failed (${res.status})`); }
    offset = end;
    onProgress(Math.round((offset / f.size) * 100));
  }
  const done = await api('POST', `/v1/uploads/${u.uploadId}/complete`);
  if (done.status === 'FAILED') throw new Error(done.error);
  return u.uploadId;
}

async function waitForProcessing(uploadId: string, timeoutMs = 10 * 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await api('GET', `/v1/uploads/${uploadId}`);
    if (s.status === 'READY') return s.asset;
    if (s.status === 'FAILED') throw new Error(s.error ?? 'processing failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Processing is taking longer than usual. The ad will appear once it finishes; try adding it again later.');
}

function offersCard(c: Campaign, offers: any[], manage: boolean) {
  const add = async () => {
    const v = await dialog('Coupon / commission offer', [
      el('p', { class: 'muted' }, 'Riders save a single-use coupon from your ad. You pay a commission only on sales you report that used the coupon or followed a tap on your ad.'),
      input('Offer name', { name: 'name', required: '', maxlength: '200', placeholder: 'e.g. 10% off first order' }),
      input('What the rider gets (shown on the coupon)', { name: 'couponDescription', maxlength: '200', placeholder: 'e.g. Free cookie with any coffee' }),
      el('div', { class: 'two' }, select('Commission', 'kind', [['PERCENT_OF_SALE', '% of sale'], ['FIXED_PER_SALE', 'Fixed $ per sale']]), input('Amount (% or $)', { name: 'amount', required: '', inputmode: 'decimal', value: '10' })),
      el('div', { class: 'two' }, input('Valid from', { type: 'datetime-local', name: 'from', required: '', value: toLocalInput(new Date(Date.now() + 60_000).toISOString()) }),
        input('Valid to', { type: 'datetime-local', name: 'to', required: '', value: toLocalInput(c.endsAt) })),
    ], 'Create offer');
    if (!v) return;
    const pct = Number(v.amount), fixed = toMinor(v.amount!);
    const body: Record<string, unknown> = { name: v.name, kind: v.kind, validFrom: fromLocalInput(v.from!), validTo: fromLocalInput(v.to!), ...(v.couponDescription ? { couponDescription: v.couponDescription } : {}) };
    if (v.kind === 'PERCENT_OF_SALE') { if (!(pct > 0 && pct <= 100)) return toast('Enter a percentage between 0 and 100.', true); body.rateBps = Math.round(pct * 100); }
    else { if (!fixed) return toast('Enter a dollar amount, e.g. 2.50', true); body.fixedMinor = fixed; }
    if (await act(() => api('POST', `${base()}/campaigns/${c.id}/commission-offers`, body), 'Offer created.')) await campaignDetail(c.id);
  };
  return el('div', { class: 'card', id: 'offers' }, el('h2', {}, 'Coupons & commissions'),
    offers.length ? el('table', {}, el('tbody', {}, ...offers.map((o) => el('tr', {},
      el('td', {}, o.name, o.couponDescription ? el('div', { class: 'sub' }, o.couponDescription) : null),
      el('td', {}, o.kind === 'PERCENT_OF_SALE' ? `${(o.rateBps / 100).toFixed(2).replace(/\.00$/, '')}% of sale` : `${money(o.fixedMinor)} per sale`),
      el('td', {}, o.status === 'ACTIVE' && Date.parse(o.validTo) > Date.now() ? chip('Active', 'ok') : chip('Ended')),
      el('td', {}, manage && o.status === 'ACTIVE' ? btn('End', () => act(() => api('POST', `${base()}/commission-offers/${o.id}/end`), 'Offer ended.').then(() => campaignDetail(c.id)), 'btn small danger') : null)))))
      : el('p', { class: 'muted' }, 'No offers.'),
    manage && c.status !== 'ENDED' ? btn('Add an offer', add, 'btn', { id: 'add-offer' }) : null,
    el('p', { class: 'muted' }, 'Report sales with an integration key (see the API guide). Commissions are held for the return window before they are paid out.'));
}

function fencesCard(c: Campaign, fences: any[], manage: boolean) {
  const add = async () => {
    const v = await dialog('Location alert', [
      el('p', { class: 'muted' }, 'When a tablet passes near this spot, riders see a short, silent message on the passenger screen. Drivers are never alerted. Tablet locations are never stored.'),
      input('Place name', { name: 'name', required: '', maxlength: '80', placeholder: 'e.g. Main St store' }),
      input('Message (up to 120 characters)', { name: 'message', required: '', maxlength: '120', placeholder: 'e.g. Fresh coffee two blocks away' }),
      el('div', { class: 'two' }, input('Latitude', { name: 'lat', required: '', inputmode: 'decimal', placeholder: '39.7817' }), input('Longitude', { name: 'lng', required: '', inputmode: 'decimal', placeholder: '-89.6501' })),
      input('Radius (meters, 50–2000)', { name: 'radius', type: 'number', min: '50', max: '2000', value: '300', required: '' }),
    ], 'Add alert');
    if (!v) return;
    const lat = Number(v.lat), lng = Number(v.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast('Latitude and longitude must be numbers (find them on any map app).', true);
    if (await act(() => api('POST', `${base()}/campaigns/${c.id}/geofences`, { name: v.name, message: v.message, latitude: lat, longitude: lng, radiusM: Number(v.radius) }), 'Location alert added.')) await campaignDetail(c.id);
  };
  return el('div', { class: 'card', id: 'geofences' }, el('h2', {}, 'Location alerts'),
    fences.length ? el('table', {}, el('tbody', {}, ...fences.map((g) => el('tr', {},
      el('td', {}, g.name, el('div', { class: 'sub' }, `“${g.message}” · ${g.radius_m} m`)),
      el('td', { class: 'sub' }, `${g.alerts_issued} shown · ${g.opened} opened · ${g.claimed} claimed`),
      el('td', {}, g.status === 'ACTIVE' ? chip('Active', 'ok') : chip('Paused', 'warn')),
      el('td', {}, manage ? btn(g.status === 'ACTIVE' ? 'Pause' : 'Resume', () => act(() => api('POST', `${base()}/geofences/${g.id}/${g.status === 'ACTIVE' ? 'pause' : 'resume'}`)).then(() => campaignDetail(c.id)), 'btn small') : null)))))
      : el('p', { class: 'muted' }, 'No location alerts.'),
    manage && c.status !== 'ENDED' ? btn('Add a location alert', add, 'btn', { id: 'add-geofence' }) : null);
}

// ------------------------------------------------------------------ rewards
async function rewards() {
  const [programs, games, list] = await Promise.all([api('GET', `${base()}/reward-programs`).then((r) => r.items as any[]), api('GET', '/v1/games').then((r) => r.items as any[]), loadCampaigns()]);
  const add = async () => {
    const v = await dialog('Sponsor a game reward', [
      el('p', { class: 'muted' }, 'Riders who reach the minimum score in a skill game win your reward (no purchase, no chance). Rewards go to signed-in adult riders and are redeemed once at your counter.'),
      input('Program name', { name: 'name', required: '', maxlength: '100', placeholder: 'e.g. Trivia champions' }),
      input('Reward (what the rider gets)', { name: 'rewardDescription', required: '', minlength: '3', maxlength: '140', placeholder: 'e.g. Free small coffee' }),
      el('div', { class: 'two' }, input('Value of one reward ($)', { name: 'value', required: '', inputmode: 'decimal', value: '3.00' }), input('How many to give away', { name: 'qty', type: 'number', min: '1', required: '', value: '100' })),
      el('div', { class: 'two' }, select('Game', 'gameSlug', [['', 'Any game'], ...games.map((g) => [g.slug, g.name] as [string, string])]), input('Minimum score', { name: 'minScore', type: 'number', min: '0', value: '2' })),
      select('Linked campaign (optional)', 'campaignId', [['', 'None'], ...list.map((c) => [c.id, c.name] as [string, string])]),
      el('div', { class: 'two' }, input('Starts', { type: 'datetime-local', name: 'from', required: '', value: toLocalInput(new Date(Date.now() + 60_000).toISOString()) }),
        input('Ends', { type: 'datetime-local', name: 'to', required: '', value: toLocalInput(new Date(Date.now() + 30 * 86_400_000).toISOString()) })),
    ], 'Create program');
    if (!v) return;
    const value = toMinor(v.value!);
    if (!value) return toast('Enter the reward value in dollars, e.g. 3.00', true);
    if (await act(() => api('POST', `${base()}/reward-programs`, { name: v.name, rewardDescription: v.rewardDescription, faceValueMinor: Number(value), totalQuantity: Number(v.qty),
      minScore: Number(v.minScore || 0), startsAt: fromLocalInput(v.from!), endsAt: fromLocalInput(v.to!), ...(v.gameSlug ? { gameSlug: v.gameSlug } : {}), ...(v.campaignId ? { campaignId: v.campaignId } : {}) }), 'Reward program created.')) await rewards();
  };
  render(el('div', { class: 'row-head' }, el('h1', {}, 'Game rewards'), can('campaign.manage') ? btn('Sponsor a reward', add, 'btn primary', { id: 'new-reward' }) : null),
    programs.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'rewards' },
      el('thead', {}, el('tr', {}, ...['Program', 'Given away', 'Redeemed', 'Outstanding', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...programs.map((p) => el('tr', {},
        el('td', {}, p.name, el('div', { class: 'sub' }, `${p.reward_description} · ${money(p.face_value_minor)} each`)),
        el('td', {}, `${p.issued} of ${p.total_quantity}`), el('td', {}, String(p.redeemed)),
        el('td', {}, `${p.outstanding} (${money(p.outstandingObligationMinor)})`),
        el('td', {}, p.status === 'ACTIVE' ? chip('Active', 'ok') : chip('Ended')),
        el('td', {}, can('campaign.manage') && p.status === 'ACTIVE' ? btn('End', () => act(() => api('POST', `${base()}/reward-programs/${p.id}/end`), 'Program ended. Rewards already won stay valid.').then(() => rewards()), 'btn small danger') : null))))))
      : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No reward programs yet.')),
    el('p', { class: 'muted' }, '“Outstanding” is what you still owe riders at face value: rewards won but not yet redeemed or expired.'));
}

// ------------------------------------------------------------------ billing
async function billing() {
  const bal = (await api('GET', `${base()}/balance`)).balances.USD ?? { prepaidBalance: '0', available: '0', committedUnbilled: '0', refundsPending: '0', commissionsOwed: '0' };
  const invoices = can('billing.manage') ? (await api('GET', `${base()}/invoices`)).items as any[] : [];
  const f = el('form', { class: 'inline', id: 'fund-form' }, input('Amount ($10 – $100,000)', { name: 'amount', required: '', inputmode: 'decimal', value: '250' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Add funds'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const minor = toMinor(String(new FormData(f).get('amount') ?? ''));
    if (!minor) { toast('Enter an amount in dollars, e.g. 250', true); return; }
    try {
      const r = await api('POST', `${base()}/prepayments`, { amountMinor: minor });
      location.assign(r.checkoutUrl); // hosted checkout; the balance is credited when the processor confirms payment
    } catch (err) { toast(errText(err), true); }
  });
  render(el('h1', {}, 'Billing'),
    el('div', { class: 'grid' },
      stat(money(bal.available), 'Available to spend', 'stat-available'), stat(money(bal.prepaidBalance), 'Prepaid balance', 'stat-prepaid'),
      stat(money(bal.committedUnbilled), 'Delivered, not yet billed', 'stat-committed'), stat(money(bal.commissionsOwed), 'Commissions owed', 'stat-commissions')),
    can('billing.manage') ? el('div', { class: 'card' }, el('h2', {}, 'Add funds'), f,
      el('p', { class: 'muted' }, 'Campaigns spend from your prepaid balance and stop automatically when it runs out. Card payments are processed by Stripe; we never see your card number. Unused balance can be refunded on request.')) : null,
    el('div', { class: 'card' }, el('h2', {}, 'Receipts & invoices'),
      invoices.length ? el('table', { id: 'invoices' }, el('tbody', {}, ...invoices.map((i) => el('tr', {},
        el('td', {}, i.number), el('td', {}, i.kind === 'PREPAYMENT_RECEIPT' ? 'Prepayment receipt' : i.kind.replace(/_/g, ' ').toLowerCase()),
        el('td', {}, money(i.total_minor, i.currency?.trim?.() ?? 'USD')), el('td', { class: 'sub' }, fmtDate(i.issued_at)), el('td', {}, chip(i.status.toLowerCase()))))))
        : el('p', { class: 'muted' }, can('billing.manage') ? 'None yet.' : 'Ask an account admin for billing access.')),
    el('p', { class: 'muted' }, `Last updated ${ago(new Date().toISOString())}.`));
  poll(billing, 15_000);
}

