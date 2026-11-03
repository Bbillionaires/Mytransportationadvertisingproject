/**
 * Platform staff section: ad review (with previews), video moderation and appeals, copyright notices, earnings
 * eligibility, finance approvals and reports, organizations and the audit log. Every staff permission requires an
 * MFA-verified session; the API also enforces separation of duties (no self-approval, no deciding for your own org).
 * AI pre-screen results are shown as advisory only — a person makes every decision (D-034).
 */
import { can, type Section } from './main';
import { act, api, btn, chip, dialog, download, el, errText, fmtDate, input, money, render, select, toast, type Kid } from './ui';

export const staffSections: Section[] = [
  { id: 'overview', title: 'Overview', perm: '', view: () => overview() },
  { id: 'ad-review', title: 'Ad review', perm: 'campaign.review', view: () => adReview() },
  { id: 'moderation', title: 'Video moderation', perm: 'content.review', view: () => moderation() },
  { id: 'takedowns', title: 'Copyright notices', perm: 'takedown.manage', view: () => takedowns() },
  { id: 'eligibility', title: 'Earnings eligibility', perm: 'platform.eligibility.manage', view: (t) => eligibility(t === 'drivers' ? 'drivers' : 'creators') },
  { id: 'finance', title: 'Finance', perm: 'finance.read', view: () => finance() },
  { id: 'organizations', title: 'Organizations', perm: '', view: () => organizations() },
  { id: 'audit', title: 'Audit log', perm: 'platform.audit.read', view: () => auditLog() },
];

const REASONS = ['PROFANITY', 'SEXUAL_CONTENT', 'NUDITY', 'GRAPHIC_VIOLENCE', 'HATE_OR_ABUSE', 'SELF_HARM', 'DRUGS', 'WEAPONS', 'COPYRIGHT', 'NOT_FAMILY_FRIENDLY', 'LOW_QUALITY', 'MISLEADING', 'OTHER'];
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const stat = (n: string, l: string, id: string, href?: string) => {
  const s = el('div', { class: 'stat', id }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l));
  return href ? el('a', { href, class: 'stat-link' }, s) : s;
};
const ai = (rec: string | null | undefined) => rec ? el('div', { class: 'sub' }, 'AI pre-screen (advisory only): ', chip(label(rec), rec === 'LIKELY_OK' ? 'ok' : rec === 'LIKELY_VIOLATION' ? 'err' : 'warn')) : null;
const mfaNeeded = (e: unknown) => /multi-factor/.test(errText(e));
const mfaCard = () => el('div', { class: 'card notice err-border', id: 'mfa-required' }, el('strong', {}, 'Two-step verification required. '),
  'Staff actions need a verified session. ', el('a', { href: '#/security' }, 'Set up two-step verification'), ', then sign in again.');
/** Render a staff page, replacing MFA_REQUIRED failures with a clear call to action. */
async function guard(fn: () => Promise<void>) {
  try { await fn(); } catch (e) { if (mfaNeeded(e)) render(mfaCard()); else throw e; }
}

// ------------------------------------------------------------------ overview
async function overview() {
  const tiles: Kid[] = [];
  let mfaBlocked = false;
  const count = async (perm: string, fn: () => Promise<number>, l: string, id: string, href: string) => {
    if (!can(perm)) return;
    try { tiles.push(stat(String(await fn()), l, id, href)); } catch (e) { if (mfaNeeded(e)) mfaBlocked = true; }
  };
  await Promise.all([
    count('campaign.review', async () => { const r = await api('GET', '/v1/review/campaigns'); return r.campaigns.length + r.creativesOnLiveCampaigns.length; }, 'Ads waiting for review', 'stat-ads', '#/ad-review'),
    count('content.review', async () => (await api('GET', '/v1/moderation/queue')).items.length, 'Videos waiting for review', 'stat-videos', '#/moderation'),
    count('content.review', async () => (await api('GET', '/v1/moderation/appeals')).items.length, 'Open appeals', 'stat-appeals', '#/moderation'),
    count('takedown.manage', async () => (await api('GET', '/v1/takedowns')).items.filter((t: any) => ['ACTIONED', 'COUNTER_NOTICED'].includes(t.status)).length, 'Open copyright notices', 'stat-takedowns', '#/takedowns'),
    count('platform.eligibility.manage', async () => (await api('GET', '/v1/platform/creators?status=PENDING')).items.length, 'Creators awaiting eligibility', 'stat-creators', '#/eligibility/creators'),
    count('platform.eligibility.manage', async () => (await api('GET', '/v1/platform/drivers?status=PENDING')).items.length, 'Drivers awaiting eligibility', 'stat-drivers', '#/eligibility/drivers'),
    count('finance.read', async () => (await api('GET', '/v1/finance/journal-requests?status=PENDING')).items.length, 'Journal requests to approve', 'stat-journal', '#/finance'),
    count('finance.read', async () => (await api('GET', '/v1/finance/revenue-rules')).items.filter((r: any) => r.status === 'DRAFT').length, 'Revenue rules awaiting approval', 'stat-rules', '#/finance'),
  ]);
  render(el('h1', {}, 'Staff overview'), mfaBlocked ? mfaCard() : null,
    tiles.length ? el('div', { class: 'grid' }, ...tiles) : !mfaBlocked ? el('p', { class: 'muted' }, 'Your role has no review queues.') : null,
    el('p', { class: 'muted' }, 'Staff actions are audited. You cannot approve your own requests or decide for an organization you belong to.'));
}

// ------------------------------------------------------------------ ad review
function creativePreview(k: any): Kid {
  if (k.kind === 'VIDEO' && k.previewUrl) return el('video', { src: k.previewUrl, controls: '', muted: '', preload: 'metadata', class: 'preview' });
  if (k.kind === 'DISPLAY' && k.previewUrl) return el('img', { src: k.previewUrl, alt: 'Display ad', class: 'preview' });
  return el('div', { class: 'banner-preview' }, el('strong', {}, k.headline ?? ''), k.bodyText ? el('div', {}, k.bodyText) : null);
}

async function adReview() {
  await guard(async () => {
    const q = await api('GET', '/v1/review/campaigns');
    const cards = (q.campaigns as any[]).map((c) => {
      const pending = (c.creatives as any[]).filter((k) => k.status === 'PENDING_REVIEW');
      const decisions = pending.map((k) => el('div', { class: 'creative', 'data-creative': k.id },
        creativePreview(k),
        el('div', {}, el('div', {}, `${k.name} · ${label(k.kind)}${k.durationMs ? ` · ${Math.round(k.durationMs / 1000)} s` : ''}`), ai(k.aiPrescreen?.recommendation),
          k.aiPrescreen?.findings?.notes?.length ? el('div', { class: 'sub' }, `Notes: ${k.aiPrescreen.findings.notes.join('; ')}`) : null,
          el('div', { class: 'actions' },
            el('label', { class: 'check' }, el('input', { type: 'radio', name: `d-${k.id}`, value: 'APPROVE', checked: '' }), 'Approve'),
            el('label', { class: 'check' }, el('input', { type: 'radio', name: `d-${k.id}`, value: 'REJECT' }), 'Reject')),
          el('input', { name: `n-${k.id}`, placeholder: 'Note for the advertiser (required when rejecting)', maxlength: '1000', class: 'wide' }))));
      const form = el('form', { class: 'card review', 'data-campaign': c.id },
        el('div', { class: 'row-head' }, el('h2', {}, c.name), chip(label(c.category))),
        el('p', { class: 'muted' }, `${c.advertiserName} · ${c.pricingModel === 'CPM' ? `${money(c.rateMinor)} CPM` : `${money(c.rateMinor)} per qualified view`} · ${c.totalBudgetMinor ? `budget ${money(c.totalBudgetMinor)}` : 'no total budget'} · ${new Date(c.startsAt).toLocaleDateString()} – ${new Date(c.endsAt).toLocaleDateString()} · ${c.markets.join(', ') || 'all markets'}`),
        c.destinationUrl ? el('p', { class: 'muted' }, 'Landing page: ', el('code', {}, c.destinationUrl)) : null,
        ...decisions,
        el('label', {}, 'Decision note (sent to the advertiser)', el('textarea', { name: 'note', required: '', minlength: '5', maxlength: '2000', rows: '2' })),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'submit', value: 'APPROVE' }, 'Approve campaign'), el('button', { class: 'btn danger', type: 'submit', value: 'REJECT' }, 'Reject campaign')));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const decision = ((ev as SubmitEvent).submitter as HTMLButtonElement).value;
        const d = new FormData(form);
        const creatives = pending.map((k) => ({ creativeId: k.id, decision: decision === 'REJECT' ? 'REJECT' : String(d.get(`d-${k.id}`)), ...(d.get(`n-${k.id}`) ? { note: String(d.get(`n-${k.id}`)) } : {}) }));
        if (decision === 'APPROVE' && !creatives.some((x) => x.decision === 'APPROVE')) return toast('Approve at least one ad, or reject the campaign.', true);
        if (await act(() => api('POST', `/v1/review/campaigns/${c.id}/decision`, { decision, note: d.get('note'), creatives }), decision === 'APPROVE' ? 'Campaign approved.' : 'Campaign rejected; the advertiser sees your note.')) await adReview();
      });
      return form;
    });
    const live = (q.creativesOnLiveCampaigns as any[]).map((k) => el('div', { class: 'card creative', 'data-creative': k.id }, creativePreview(k),
      el('div', {}, el('div', {}, `${k.name} · ${label(k.kind)} (new ad on a running campaign)`), el('div', { class: 'actions' },
        btn('Approve', () => decideCreative(k.id, 'APPROVE'), 'btn small primary'), btn('Reject…', () => decideCreative(k.id, 'REJECT'), 'btn small danger')))));
    render(el('h1', {}, 'Ad review'),
      cards.length || live.length ? null : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Nothing waiting for review.')),
      ...cards, ...live,
      el('p', { class: 'muted' }, 'Check that each ad is family-friendly, truthful, matches its category and landing page, and is not in a restricted category. You cannot review campaigns from an organization you belong to.'));
  });
}

async function decideCreative(id: string, decision: 'APPROVE' | 'REJECT') {
  const v = await dialog(decision === 'APPROVE' ? 'Approve this ad' : 'Reject this ad', [el('label', {}, 'Note (5+ characters)', el('textarea', { name: 'note', required: '', minlength: '5', maxlength: '1000', rows: '2' }))],
    decision === 'APPROVE' ? 'Approve' : 'Reject', decision === 'REJECT');
  if (v && await act(() => api('POST', `/v1/review/creatives/${id}/decision`, { decision, note: v.note }), 'Decision saved.')) await adReview();
}

// ------------------------------------------------------------------ video moderation
async function moderation() {
  await guard(async () => {
    const [queue, appeals] = await Promise.all([api('GET', '/v1/moderation/queue'), api('GET', '/v1/moderation/appeals')]);
    const cases = (queue.items as any[]).map((c) => {
      const f = el('form', { class: 'card review', 'data-case': c.id },
        el('div', { class: 'creative' }, el('video', { src: c.renditionUrl, controls: '', muted: '', preload: 'metadata', class: 'preview', poster: c.thumbnailUrl }),
          el('div', {}, el('h2', {}, c.title ?? 'Untitled'), el('p', { class: 'muted' }, `${c.channel ?? ''} · ${Math.round((c.duration_ms ?? 0) / 1000)} s · submitted ${fmtDate(c.created_at)}`),
            c.description ? el('p', {}, c.description) : null, ai(c.ai_recommendation), c.priority === 'HIGH' ? chip('high priority', 'err') : null)),
        el('fieldset', { class: 'reasons' }, el('legend', {}, 'Reasons (required when rejecting)'), ...REASONS.map((r) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'reason', value: r }), label(r)))),
        el('label', {}, 'Note (sent to the creator)', el('textarea', { name: 'note', required: '', minlength: '5', maxlength: '2000', rows: '2' })),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'submit', value: 'APPROVE' }, 'Approve video'), el('button', { class: 'btn danger', type: 'submit', value: 'REJECT' }, 'Reject video')));
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const decision = ((ev as SubmitEvent).submitter as HTMLButtonElement).value;
        const d = new FormData(f);
        const reasons = d.getAll('reason').map(String);
        if (decision === 'REJECT' && !reasons.length) return toast('Pick at least one policy reason for a rejection.', true);
        if (await act(() => api('POST', `/v1/moderation/cases/${c.id}/decision`, { decision, reasons: decision === 'REJECT' ? reasons : [], note: d.get('note') }), decision === 'APPROVE' ? 'Video approved.' : 'Video rejected.')) await moderation();
      });
      return f;
    });
    const ap = (appeals.items as any[]).map((a) => el('div', { class: 'card', 'data-appeal': a.id },
      el('h2', {}, 'Appeal'), el('p', {}, `“${a.statement}”`),
      el('p', { class: 'muted' }, `Original decision: ${(a.decision_reasons ?? []).map(label).join(', ')}${a.decision_note ? ` — ${a.decision_note}` : ''}`),
      el('div', { class: 'actions' },
        btn('Overturn (approve video)', () => decideAppeal(a.id, 'OVERTURN'), 'btn primary'), btn('Uphold rejection', () => decideAppeal(a.id, 'UPHOLD'), 'btn'))));
    render(el('h1', {}, 'Video moderation'),
      el('h2', {}, `Review queue (${cases.length})`), ...(cases.length ? cases : [el('p', { class: 'muted' }, 'No videos waiting.')]),
      el('h2', {}, `Appeals (${ap.length})`), ...(ap.length ? ap : [el('p', { class: 'muted' }, 'No open appeals.')]),
      el('p', { class: 'muted' }, 'Appeals must be decided by someone other than the original reviewer.'));
  });
}

async function decideAppeal(id: string, decision: 'UPHOLD' | 'OVERTURN') {
  const v = await dialog(decision === 'OVERTURN' ? 'Overturn: approve the video' : 'Uphold the rejection', [el('label', {}, 'Note (sent to the creator)', el('textarea', { name: 'note', required: '', minlength: '5', maxlength: '2000', rows: '2' }))], 'Save decision');
  if (v && await act(() => api('POST', `/v1/moderation/appeals/${id}/decision`, { decision, note: v.note }), 'Appeal decided.')) await moderation();
}

// ------------------------------------------------------------------ takedowns
async function takedowns() {
  await guard(async () => {
    const items = (await api('GET', '/v1/takedowns')).items as any[];
    const resolve = async (t: any, action: 'RESTORE' | 'UPHOLD' | 'WITHDRAWN') => {
      const v = await dialog({ RESTORE: 'Restore the video', UPHOLD: 'Keep the video removed', WITHDRAWN: 'Claim withdrawn' }[action],
        [el('label', {}, 'Note (kept in the record)', el('textarea', { name: 'note', required: '', minlength: '5', maxlength: '2000', rows: '2' }))], 'Save');
      if (v && await act(() => api('POST', `/v1/takedowns/${t.id}/resolve`, { action, note: v.note }), 'Notice resolved.')) await takedowns();
    };
    render(el('h1', {}, 'Copyright notices'),
      items.length ? el('div', { class: 'table-wrap' }, el('table', { id: 'takedowns' },
        el('thead', {}, el('tr', {}, ...['Video', 'Claim', 'Status', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...items.map((t) => {
          const canRestore = t.status === 'COUNTER_NOTICED' && t.restore_eligible_at && Date.parse(t.restore_eligible_at) <= Date.now();
          return el('tr', { 'data-notice': t.id },
            el('td', {}, t.title, el('div', { class: 'sub' }, `${t.creator_open_strikes} open/upheld notice(s) for this creator`)),
            el('td', {}, t.copyrighted_work, el('div', { class: 'sub' }, `${t.complainant_name} · received ${fmtDate(t.received_at)}`),
              t.counter_statement ? el('div', { class: 'sub' }, `Counter-notice: “${t.counter_statement}” — signed ${t.counter_signature}`) : null),
            el('td', {}, chip(label(t.status), ['ACTIONED', 'COUNTER_NOTICED'].includes(t.status) ? 'warn' : ''),
              t.status === 'COUNTER_NOTICED' && t.restore_eligible_at ? el('div', { class: 'sub' }, `Restorable from ${new Date(t.restore_eligible_at).toLocaleDateString()}`) : null),
            el('td', {}, ['ACTIONED', 'COUNTER_NOTICED'].includes(t.status) ? el('div', { class: 'actions' },
              t.status === 'COUNTER_NOTICED' ? btn('Restore', () => resolve(t, 'RESTORE'), 'btn small', canRestore ? {} : { disabled: '', title: 'Restoration opens 10 business days after the counter-notice' }) : null,
              btn('Uphold', () => resolve(t, 'UPHOLD'), 'btn small'), btn('Withdrawn', () => resolve(t, 'WITHDRAWN'), 'btn small')) : null));
        }))))
        : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No notices.')),
      el('p', { class: 'muted' }, 'A notice removes a live video immediately. After a counter-notice, the video can be restored after 10 business days unless the claimant reports a court action. Repeat-infringer policy: DECISION REQUIRED (R-008).'));
  });
}

// ------------------------------------------------------------------ eligibility
async function eligibility(tab: 'creators' | 'drivers') {
  await guard(async () => {
    const status = new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') ?? '';
    const items = (await api('GET', `/v1/platform/${tab}${status ? `?status=${status}` : ''}`)).items as any[];
    const decide = async (x: any) => {
      const v = await dialog(`Eligibility: ${tab === 'creators' ? x.display_name : x.display_name}`, [
        el('p', { class: 'muted' }, tab === 'creators'
          ? 'Confirm identity, tax form (W-9/W-8), payout onboarding and content history before marking a channel eligible.'
          : 'Confirm an active subscription, signed participation terms and payout onboarding before marking a driver eligible.'),
        select('New status', 'status', [['ELIGIBLE', 'Eligible'], ['PENDING', 'Pending'], ['SUSPENDED', 'Suspended'], ['TERMINATED', 'Terminated']]),
        el('label', {}, 'Reason (kept in the audit log)', el('textarea', { name: 'reason', required: '', minlength: '5', maxlength: '500', rows: '2' })),
      ], 'Save');
      if (v && await act(() => api('POST', `/v1/platform/${tab}/${x.id}/${tab === 'creators' ? 'monetization' : 'eligibility'}`, { status: v.status, reason: v.reason }), 'Eligibility updated.')) await eligibility(tab);
    };
    const st = (s: string) => chip(label(s), s === 'ELIGIBLE' ? 'ok' : s === 'PENDING' ? 'warn' : 'err');
    render(el('h1', {}, 'Earnings eligibility'),
      el('div', { class: 'actions', id: 'elig-tabs' }, el('a', { href: '#/eligibility/creators', class: `btn small${tab === 'creators' ? ' primary' : ''}` }, 'Creators'),
        el('a', { href: '#/eligibility/drivers', class: `btn small${tab === 'drivers' ? ' primary' : ''}` }, 'Drivers')),
      items.length ? el('div', { class: 'table-wrap' }, el('table', { id: `elig-${tab}` },
        el('thead', {}, el('tr', {}, ...(tab === 'creators' ? ['Channel', 'Videos', 'Notices', 'Status', ''] : ['Driver', 'Fleet', 'Subscription', 'Status', '']).map((h) => el('th', {}, h)))),
        el('tbody', {}, ...items.map((x) => tab === 'creators'
          ? el('tr', { 'data-name': x.display_name }, el('td', {}, x.display_name, el('div', { class: 'sub' }, `${x.org_name}${x.is_synthetic ? ' · SYNTHETIC' : ''}`)),
            el('td', {}, `${x.videos_live} live / ${x.videos_total}`), el('td', {}, x.open_takedowns ? chip(`${x.open_takedowns} open`, 'err') : '—'), el('td', {}, st(x.monetization_status)), el('td', {}, btn('Change…', () => decide(x), 'btn small')))
          : el('tr', { 'data-name': x.display_name }, el('td', {}, x.display_name, el('div', { class: 'sub' }, x.email)), el('td', {}, `${x.fleet_operator} · ${x.fleet_name}`),
            el('td', {}, x.subscription_status ? chip(label(x.subscription_status), x.subscription_status === 'ACTIVE' ? 'ok' : 'warn') : chip('none')), el('td', {}, st(x.eligibility_status)), el('td', {}, btn('Change…', () => decide(x), 'btn small')))))))
        : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'None.')));
  });
}

// ------------------------------------------------------------------ finance
async function finance() {
  await guard(async () => {
    const [jr, rules, tb] = await Promise.all([api('GET', '/v1/finance/journal-requests?status=PENDING'), api('GET', '/v1/finance/revenue-rules'), api('GET', '/v1/finance/trial-balance')]);
    const decideJournal = async (r: any, decision: 'APPROVE' | 'REJECT') => {
      const v = await dialog(decision === 'APPROVE' ? 'Approve and post this entry' : 'Reject this request', [
        el('p', { class: 'muted' }, decision === 'APPROVE' ? 'Posting is permanent; corrections are made with reversing entries.' : 'The requester sees your note.'),
        el('label', {}, 'Note', el('textarea', { name: 'note', maxlength: '2000', rows: '2', ...(decision === 'REJECT' ? { required: '', minlength: '5' } : {}) }))], decision === 'APPROVE' ? 'Approve and post' : 'Reject', decision === 'REJECT');
      if (v && await act(() => api('POST', `/v1/finance/journal-requests/${r.id}/decision`, { decision, ...(v.note ? { note: v.note } : {}) }), decision === 'APPROVE' ? 'Entry posted.' : 'Request rejected.')) await finance();
    };
    const lines = (p: any) => p.kind === 'REVERSAL' ? `Reverse entry ${p.entryId}` : (p.lines ?? []).map((l: any) => `${l.accountCode} ${l.debit ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}`).join(' · ');
    const drafts = (rules.items as any[]).filter((r) => r.status === 'DRAFT');
    const reportForm = el('form', { class: 'inline', id: 'report-form' },
      select('Report', 'report', [['income-statement', 'Income statement'], ['balance-sheet', 'Balance sheet'], ['general-ledger', 'General ledger'], ['cash-flow', 'Cash flow'], ['liabilities', 'Liabilities'], ['receivables', 'Receivables']]),
      el('button', { class: 'btn', type: 'submit' }, 'Download CSV'));
    reportForm.addEventListener('submit', async (ev) => { ev.preventDefault(); const r = String(new FormData(reportForm).get('report')); await act(() => download(`/v1/finance/reports/${r}?format=csv`, `${r}.csv`)); });
    render(el('h1', {}, 'Finance'),
      el('div', { class: 'card', id: 'journal-requests' }, el('h2', {}, `Journal requests awaiting approval (${jr.items.length})`),
        jr.items.length ? el('table', {}, el('tbody', {}, ...(jr.items as any[]).map((r) => el('tr', { 'data-request': r.id },
          el('td', {}, r.reason, el('div', { class: 'sub' }, lines(r.payload))), el('td', { class: 'sub' }, `requested ${fmtDate(r.requested_at)}`),
          el('td', {}, can('finance.journal.approve') ? el('div', { class: 'actions' }, btn('Approve', () => decideJournal(r, 'APPROVE'), 'btn small primary'), btn('Reject', () => decideJournal(r, 'REJECT'), 'btn small danger')) : el('span', { class: 'muted' }, 'approver role needed'))))))
          : el('p', { class: 'muted' }, 'Nothing to approve.'),
        el('p', { class: 'muted' }, 'Dual control: you cannot approve a request you made.')),
      el('div', { class: 'card', id: 'rules' }, el('h2', {}, `Revenue rules awaiting approval (${drafts.length})`),
        drafts.length ? el('table', {}, el('tbody', {}, ...drafts.map((r) => el('tr', {},
          el('td', {}, `${label(r.category)} v${r.version}`, el('div', { class: 'sub' }, `driver ${r.driver_bps / 100}% · creator ${r.creator_bps / 100}% · platform ${r.platform_bps / 100}% · from ${new Date(r.effective_from).toLocaleDateString()} · ${r.contract_ref}`)),
          el('td', {}, can('finance.rules.approve') ? btn('Approve', () => act(() => api('POST', `/v1/finance/revenue-rules/${r.id}/approve`), 'Approval recorded (two different approvers are required).').then(() => finance()), 'btn small primary') : null)))))
          : el('p', { class: 'muted' }, 'No draft rules.')),
      el('div', { class: 'card', id: 'trial-balance' }, el('h2', {}, 'Trial balance'),
        el('p', {}, tb.balanced ? chip('Balanced', 'ok') : chip('NOT BALANCED — investigate', 'err'), ' ',
          ...Object.entries(tb.totals as Record<string, { debit: string; credit: string }>).map(([ccy, t]) => `${ccy}: debits ${money(t.debit, ccy)}, credits ${money(t.credit, ccy)}. `))),
      el('div', { class: 'card' }, el('h2', {}, 'Reports'), reportForm,
        el('p', { class: 'muted' }, 'Accounting treatment (gross vs. net presentation, revenue recognition) is DECISION REQUIRED (D-011); reports keep gross detail so they can be restated.')));
  });
}

// ------------------------------------------------------------------ organizations & audit
async function organizations() {
  const items = (await api('GET', '/v1/orgs')).items as any[];
  render(el('h1', {}, 'Organizations'),
    el('div', { class: 'table-wrap' }, el('table', { id: 'orgs' }, el('thead', {}, el('tr', {}, ...['Name', 'Type', 'Status', 'Created'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...items.map((o) => el('tr', {}, el('td', {}, o.name), el('td', {}, label(o.kind)), el('td', {}, chip(label(o.status ?? 'active'))), el('td', { class: 'sub' }, fmtDate(o.created_at))))))));
}

async function auditLog() {
  await guard(async () => {
    const items = (await api('GET', '/v1/audit?limit=200')).items as any[];
    const filter = input('Filter by action', { id: 'audit-filter', placeholder: 'e.g. campaign. or device.retired' });
    const body = el('tbody', {});
    const draw = (f: string) => body.replaceChildren(...items.filter((a) => !f || a.action.includes(f)).map((a) => el('tr', {},
      el('td', { class: 'sub' }, fmtDate(a.occurred_at)), el('td', {}, a.action),
      el('td', { class: 'sub' }, a.actor_user_id ? `user ${a.actor_user_id.slice(0, 8)}` : a.actor_device_id ? `device ${a.actor_device_id.slice(0, 8)}` : 'system', a.impersonator_user_id ? ' (impersonated)' : ''),
      el('td', { class: 'sub mono' }, JSON.stringify(a.details).slice(0, 160)))));
    filter.querySelector('input')!.addEventListener('input', (e) => draw((e.target as HTMLInputElement).value.trim()));
    draw('');
    render(el('h1', {}, 'Audit log'), filter,
      el('div', { class: 'table-wrap' }, el('table', { id: 'audit' }, el('thead', {}, el('tr', {}, ...['When', 'Action', 'Actor', 'Details'].map((h) => el('th', {}, h)))), body)),
      el('p', { class: 'muted' }, 'Latest 200 entries. The log is append-only and hash-chained; verify the chain with the audit verification job.'));
  });
}
