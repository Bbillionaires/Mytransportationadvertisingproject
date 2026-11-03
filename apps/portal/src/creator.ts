/**
 * Creator section of the business portal: channel status, video uploads with the mandatory rights attestation,
 * human-review status with reasons, appeals and copyright counter-notices, performance, earnings and statements.
 * Earnings are never guaranteed; estimates are labelled as indicative (EARNINGS_DISCLOSURE from the API).
 */
import { base, can, poll, team, type Section } from './main';
import { act, api, btn, chip, closeDialog, dialog, download, el, errText, fmtDate, input, money, render, select, toast, type Kid } from './ui';
import { uploadFile } from './upload';

export const creatorSections: Section[] = [
  { id: 'overview', title: 'Overview', perm: 'creator.read', view: () => overview() },
  { id: 'videos', title: 'Videos', perm: 'creator.read', view: () => videos() },
  { id: 'performance', title: 'Performance', perm: 'creator.read', view: (d) => performance(Number(d) || 30) },
  { id: 'earnings', title: 'Earnings', perm: 'creator.read', view: () => earnings() },
  { id: 'team', title: 'Team', perm: 'org.members.manage', view: () => team(['creator_owner']) },
];

interface Channel { id: string; display_name: string; monetization_status: 'PENDING' | 'ELIGIBLE' | 'SUSPENDED' | 'TERMINATED' }
interface Video {
  id: string; creator_id: string; title: string; status: string; duration_ms: number | null; created_at: string; thumbnailUrl: string | null;
  moderation: { decision: string; reasons: string[] | null; note: string | null; decidedAt: string } | null;
  takedowns: Array<{ id: string; status: string; receivedAt: string; work: string; restoreEligibleAt: string | null }> | null;
  appeal: { id: string; status: string; createdAt: string } | null;
}

const VSTATUS: Record<string, [string, '' | 'ok' | 'warn' | 'err']> = {
  PROCESSING: ['Processing', ''], PROCESSING_FAILED: ['Processing failed', 'err'], PENDING_REVIEW: ['In review', 'warn'], APPROVED: ['Live', 'ok'], REJECTED: ['Not approved', 'err'], TAKEN_DOWN: ['Removed (copyright notice)', 'err'],
};
const MONETIZATION: Record<string, [string, string, '' | 'ok' | 'warn' | 'err']> = {
  PENDING: ['Not yet earning', 'Approved videos can play, but ad earnings start after platform staff confirm your monetization eligibility (identity, tax and payout details).', 'warn'],
  ELIGIBLE: ['Earning', 'Your share of ads shown alongside your approved videos is allocated under the published revenue rules.', 'ok'],
  SUSPENDED: ['Suspended', 'Uploads and earnings are paused for this channel. Contact support.', 'err'],
  TERMINATED: ['Closed', 'This channel is closed.', 'err'],
};
const REASON: Record<string, string> = {
  PROFANITY: 'profanity', SEXUAL_CONTENT: 'sexual content', NUDITY: 'nudity', GRAPHIC_VIOLENCE: 'graphic violence', HATE_OR_ABUSE: 'hate or abuse', SELF_HARM: 'self-harm',
  DRUGS: 'drugs', WEAPONS: 'weapons', COPYRIGHT: 'copyright', NOT_FAMILY_FRIENDLY: 'not family-friendly', LOW_QUALITY: 'low quality', MISLEADING: 'misleading', OTHER: 'other',
};
const vchip = (s: string) => chip(...(VSTATUS[s] ?? [s, '']));
const dur = (ms: number | null) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}` : '');
const stat = (n: string, l: string, id: string) => el('div', { class: 'stat', id }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l));
const loadChannels = async () => (await api<{ items: Channel[] }>('GET', `${base()}/channels`)).items;
const loadVideos = async () => (await api<{ items: Video[] }>('GET', `${base()}/videos`)).items;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ overview
async function overview() {
  const [channels, list, perf, earn] = await Promise.all([loadChannels(), loadVideos(),
    api('GET', `${base()}/videos/performance?from=${isoDay(new Date(Date.now() - 30 * 86_400_000))}`), api('GET', `${base()}/earnings`).catch(() => null)]);
  const count = (s: string) => list.filter((v) => v.status === s).length;
  const todo: Kid[] = [];
  for (const v of list) {
    const link = el('a', { href: '#/videos' }, v.title);
    if (v.status === 'REJECTED' && !v.appeal) todo.push(el('li', {}, link, ' was not approved — read the reason or appeal.'));
    if (v.takedowns?.some((t) => t.status === 'ACTIONED')) todo.push(el('li', {}, link, ' was removed after a copyright notice — you can send a counter-notice if it is a mistake.'));
    if (v.status === 'PROCESSING_FAILED') todo.push(el('li', {}, link, ' could not be processed — upload it again.'));
  }
  const views = (perf.items as any[]).reduce((a, x) => a + x.qualifiedViews, 0), hours = (perf.items as any[]).reduce((a, x) => a + x.watchHours, 0);
  render(el('h1', {}, 'Overview'),
    ...channels.map((c) => { const m = MONETIZATION[c.monetization_status]!; return el('div', { class: 'card', id: 'channel' }, el('div', { class: 'row-head' }, el('h2', {}, c.display_name), chip(m[0], m[2])), el('p', { class: 'muted' }, m[1])); }),
    el('div', { class: 'grid' },
      stat(String(count('APPROVED')), 'Videos live', 'stat-live'), stat(String(count('PENDING_REVIEW') + count('PROCESSING')), 'In review or processing', 'stat-review'),
      stat(views.toLocaleString(), 'Qualified views, last 30 days', 'stat-views'), stat(hours.toFixed(1), 'Watch hours, last 30 days', 'stat-hours'),
      stat(money(earn?.summary.net ?? '0'), 'Earned (allocated), last 90 days', 'stat-earned')),
    el('div', { class: 'card', id: 'todo' }, el('h2', {}, 'To do'),
      todo.length ? el('ul', { class: 'attention' }, ...todo) : el('p', { class: 'muted' }, list.length ? 'Nothing needs your attention.' : 'Upload your first video to appear on passenger screens.'),
      can('creator.manage') && !list.length ? el('p', {}, el('a', { href: '#/videos' }, 'Upload a video →')) : null),
    el('p', { class: 'muted' }, earn?.disclosure ?? 'Earnings are not guaranteed.'));
}

// ------------------------------------------------------------------ videos
async function videos() {
  const [channels, list] = await Promise.all([loadChannels(), loadVideos()]);
  const manage = can('creator.manage') && can('media.upload');
  const rows = list.map((v) => {
    const notice = v.takedowns?.find((t) => t.status === 'ACTIONED' || t.status === 'COUNTER_NOTICED');
    const why: Kid[] = [];
    if (v.status === 'REJECTED' && v.moderation) why.push(el('div', { class: 'sub' }, `Reason: ${(v.moderation.reasons ?? []).map((r) => REASON[r] ?? r).join(', ') || '—'}${v.moderation.note ? ` — “${v.moderation.note}”` : ''}`));
    if (v.appeal) why.push(el('div', { class: 'sub' }, v.appeal.status === 'OPEN' ? 'Appeal under review by a different reviewer.' : v.appeal.status === 'OVERTURNED' ? 'Appeal accepted.' : 'Appeal reviewed: decision upheld.'));
    if (notice) why.push(el('div', { class: 'sub' }, notice.status === 'COUNTER_NOTICED'
      ? `Counter-notice sent. The video can be restored after ${notice.restoreEligibleAt ? new Date(notice.restoreEligibleAt).toLocaleDateString() : '10 business days'} unless the claimant reports a court action.`
      : `Copyright notice received ${new Date(notice.receivedAt).toLocaleDateString()} for “${notice.work}”.`));
    return el('tr', { 'data-title': v.title },
      el('td', {}, v.thumbnailUrl ? el('img', { src: v.thumbnailUrl, alt: '', class: 'thumb', loading: 'lazy' }) : el('div', { class: 'thumb' })),
      el('td', {}, el('div', {}, v.title), el('div', { class: 'sub' }, `${dur(v.duration_ms)} · uploaded ${new Date(v.created_at).toLocaleDateString()}`)),
      el('td', {}, vchip(v.status), ...why),
      el('td', {}, el('div', { class: 'actions' },
        manage && v.status === 'REJECTED' && !v.appeal ? btn('Appeal', () => appeal(v), 'btn small') : null,
        manage && notice?.status === 'ACTIONED' ? btn('Counter-notice', () => counterNotice(v, notice.id), 'btn small') : null)));
  });
  render(el('div', { class: 'row-head' }, el('h1', {}, 'Videos'), manage ? btn('Upload a video', () => upload(channels), 'btn primary', { id: 'upload-video' }) : null),
    list.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'videos' },
      el('thead', {}, el('tr', {}, ...['', 'Video', 'Status', ''].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows)))
      : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No videos yet.')),
    el('p', { class: 'muted' }, 'A person reviews every video before it can play on passenger screens. Ads shown alongside your approved videos earn you a share of net revenue once your channel is monetization-eligible.'));
  if (list.some((v) => v.status === 'PROCESSING' || v.status === 'PENDING_REVIEW')) poll(videos, 10_000);
}

async function upload(channels: Channel[]) {
  const att = await api('GET', '/v1/rights/attestation');
  const lines = String(att.text).split('\n');
  const file = el('input', { type: 'file', name: 'file', required: '', accept: 'video/mp4,video/quicktime,video/webm', id: 'file' });
  const checks = lines.slice(0, 4).map((t, i) => el('label', { class: 'check attest' }, el('input', { type: 'checkbox', name: `a${i}`, value: '1', required: '' }), t));
  const v = await dialog('Upload a video', [
    el('p', { class: 'muted' }, 'MP4, MOV or WebM, landscape, family-friendly. Your own original content only — no clips from YouTube, TikTok or other platforms.'),
    channels.length > 1 ? select('Channel', 'channelId', channels.map((c) => [c.id, c.display_name])) : el('input', { type: 'hidden', name: 'channelId', value: channels[0]?.id ?? '' }),
    el('label', {}, 'File', file),
    input('Title', { name: 'title', required: '', maxlength: '200' }),
    el('label', {}, 'Description (optional)', el('textarea', { name: 'description', maxlength: '5000', rows: '3' })),
    el('fieldset', { class: 'attestation' }, el('legend', {}, 'Rights statement (required)'), ...checks, el('p', { class: 'muted small' }, lines[4] ?? '')),
  ], 'Upload and submit');
  const f = (file as HTMLInputElement).files?.[0];
  if (!v || !f) return;
  const progress = el('progress', { max: '100', value: '0', id: 'upload-progress' }) as HTMLProgressElement;
  const statusLine = el('p', { class: 'muted', id: 'upload-status' });
  const d = document.querySelector('#dlg') as HTMLDialogElement;
  d.replaceChildren(el('h2', {}, `Uploading ${f.name}`), progress, statusLine);
  d.showModal();
  try {
    const uploadId = await uploadFile(base(), f, (pct) => { progress.value = pct; statusLine.textContent = `Uploading… ${pct}%`; }, (t) => { statusLine.textContent = t; });
    await api('POST', `${base()}/videos`, { channelId: v.channelId, uploadId, title: v.title, ...(v.description ? { description: v.description } : {}),
      attestation: { statementVersion: att.version, ownsOrLicensedAllMedia: true, noThirdPartyPlatformContent: true, consentOfPeopleShown: true, familyFriendly: true } });
    await closeDialog();
    toast('Uploaded. We are processing the video; then a reviewer checks it (usually within one business day).');
  } catch (e) { await closeDialog(); toast(errText(e), true); }
  await videos();
}

async function appeal(v: Video) {
  const r = await dialog(`Appeal: ${v.title}`, [
    el('p', { class: 'muted' }, 'A different reviewer looks at the video again. Explain why it meets the content policy (at least 20 characters). You can appeal each decision once.'),
    el('label', {}, 'Your explanation', el('textarea', { name: 'statement', required: '', minlength: '20', maxlength: '5000', rows: '4' })),
  ], 'Send appeal');
  if (r && await act(() => api('POST', `${base()}/videos/${v.id}/appeal`, { statement: r.statement }), 'Appeal sent.')) await videos();
}

async function counterNotice(v: Video, takedownId: string) {
  const r = await dialog(`Counter-notice: ${v.title}`, [
    el('p', { class: 'muted' }, 'Use this only if the video was removed by mistake or misidentification. This is a legal statement: false counter-notices can make you liable for damages. If the claimant does not report a court action, the video can be restored after 10 business days.'),
    el('label', {}, 'Why the removal was a mistake', el('textarea', { name: 'statement', required: '', minlength: '20', maxlength: '5000', rows: '4' })),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'goodFaith', value: '1', required: '' }), 'I swear, under penalty of perjury, that I have a good-faith belief the material was removed as a result of mistake or misidentification.'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'jurisdiction', value: '1', required: '' }), 'I consent to the jurisdiction of the appropriate court and will accept service of process from the claimant.'),
    input('Full legal name (signature)', { name: 'signature', required: '', minlength: '2', maxlength: '200', autocomplete: 'name' }),
  ], 'Send counter-notice', true);
  if (r && await act(() => api('POST', `${base()}/videos/${v.id}/counter-notice`, { takedownId, statement: r.statement, signature: r.signature, goodFaithBeliefOfMistake: true, consentToJurisdiction: true }),
    'Counter-notice sent.')) await videos();
}

// ------------------------------------------------------------------ performance
async function performance(days: number) {
  const perf = await api('GET', `${base()}/videos/performance?from=${isoDay(new Date(Date.now() - days * 86_400_000))}`);
  const items = perf.items as any[];
  const range = el('div', { class: 'actions', id: 'range' }, ...[7, 30, 90].map((d) => el('a', { href: `#/performance/${d}`, class: `btn small${d === days ? ' primary' : ''}` }, `${d} days`)));
  render(el('div', { class: 'row-head' }, el('h1', {}, 'Performance'), range),
    items.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'performance' },
      el('thead', {}, el('tr', {}, ...['Video', 'Qualified views', 'Watch hours', 'Ad revenue alongside', 'Taps', 'Sales'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...items.map((x) => el('tr', {}, el('td', {}, x.title, el('div', { class: 'sub' }, (VSTATUS[x.status] ?? [x.status])[0])),
        el('td', {}, x.qualifiedViews.toLocaleString()), el('td', {}, x.watchHours.toFixed(2)), el('td', {}, money(x.monetizedRevenue)), el('td', {}, String(x.clicks)), el('td', {}, String(x.conversions)))))))
      : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No videos yet.')),
    el('p', { class: 'muted' }, '“Ad revenue alongside” is what advertisers were billed for ads shown with that video (validated plays only), before deductions and revenue sharing. It is not your earnings.'));
}

// ------------------------------------------------------------------ earnings
const CATEGORY: Record<string, string> = { CREATOR_CONTENT_AD: 'Ads alongside your videos', SALES_COMMISSION_WITH_CREATOR: 'Sales commissions from your videos' };
async function earnings() {
  let e: any;
  try { e = await api('GET', `${base()}/earnings`); } catch (err) { return render(el('h1', {}, 'Earnings'), el('div', { class: 'card' }, el('p', { class: 'err' }, errText(err)))); }
  const s = e.summary;
  const now = new Date(), months: Array<[string, string]> = [];
  for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); const k = d.toISOString().slice(0, 7); months.push([k, d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })]); }
  const stmt = el('form', { class: 'inline', id: 'statement-form' }, select('Month', 'month', months),
    el('button', { class: 'btn', type: 'submit', value: 'pdf' }, 'Download PDF'), el('button', { class: 'btn', type: 'submit', value: 'csv' }, 'Download CSV'));
  stmt.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fmt = ((ev as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'csv' ? 'csv' : 'pdf';
    const m = String(new FormData(stmt).get('month'));
    await act(() => download(`${base()}/statements/${m}?format=${fmt}`, `creator-statement-${m}.${fmt}`));
  });
  render(el('h1', {}, 'Earnings'),
    el('p', { class: 'card notice', id: 'disclosure' }, e.disclosure),
    el('div', { class: 'grid' },
      stat(money(s.net), 'Earned (allocated), last 90 days', 'stat-net'), stat(money(s.payableBalance), 'Balance owed to you', 'stat-payable'),
      stat(money(e.estimate.estimatedShare), 'Estimate, not yet allocated (indicative)', 'stat-estimate'), stat(money(s.reversed), 'Reversed (refunds/chargebacks)', 'stat-reversed')),
    el('div', { class: 'card' }, el('h2', {}, 'By source'),
      Object.keys(s.byCategory).length ? el('ul', {}, ...Object.entries(s.byCategory).map(([k, v]) => el('li', {}, `${CATEGORY[k] ?? k}: ${money(v as string)}`))) : el('p', { class: 'muted' }, 'No allocated earnings in this period yet.')),
    e.lines.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'earning-lines' },
      el('thead', {}, el('tr', {}, ...['Allocated', 'Source', 'Net revenue in batch', 'Your share', 'Status'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...(e.lines as any[]).slice(0, 100).map((l) => el('tr', {}, el('td', { class: 'sub' }, fmtDate(l.allocatedAt)), el('td', {}, CATEGORY[l.category] ?? l.category),
        el('td', {}, money(l.batch.net, l.currency)), el('td', {}, money(l.netAmount, l.currency), l.reversed !== '0' ? el('div', { class: 'sub' }, `${money(l.reversed)} reversed`) : null),
        el('td', {}, chip(l.status.toLowerCase())))))))
      : null,
    el('div', { class: 'card' }, el('h2', {}, 'Monthly statements'), stmt,
      el('p', { class: 'muted' }, 'Statements come straight from the ledger: opening balance, every posting, closing balance. Payouts are not enabled yet.')));
}
