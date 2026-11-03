/**
 * Driver section of the business portal (drivers are members of a fleet operator): participation subscription with
 * the required disclosure and transparent cancellation, earnings (never guaranteed), statements, receipts, and the
 * tablet assigned to their vehicle. Shown to anyone holding driver.self.read in the selected fleet.
 */
import { type Section } from './main';
import { act, api, btn, chip, dialog, download, el, errText, fmtDate, money, render, select, toast, type Kid } from './ui';

export const driverSections: Section[] = [
  { id: 'my-earnings', title: 'My earnings', perm: 'driver.self.read', view: () => earnings() },
  { id: 'subscription', title: 'Subscription', perm: 'driver.subscription.manage', view: () => subscription() },
];

const stat = (n: string, l: string, id: string) => el('div', { class: 'stat', id }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l));
const CATEGORY: Record<string, string> = {
  CREATOR_CONTENT_AD: 'Ads alongside creator videos', STANDALONE_AD: 'Standalone ads',
  SALES_COMMISSION_WITH_CREATOR: 'Sales commissions', SALES_COMMISSION_NO_CREATOR: 'Sales commissions',
};
const ELIG: Record<string, [string, string, '' | 'ok' | 'warn' | 'err']> = {
  PENDING: ['Not yet eligible', 'Your share starts after staff confirm your active subscription, signed participation terms and payout setup.', 'warn'],
  ELIGIBLE: ['Eligible', 'You receive the driver share of validated ads and sales from your vehicle’s tablet.', 'ok'],
  SUSPENDED: ['Suspended', 'Earnings are paused. Contact your fleet operator.', 'err'],
  TERMINATED: ['Ended', 'Your participation has ended.', 'err'],
};
const noProfile = (e: unknown) => /no driver profile/.test(errText(e));
const noProfileCard = () => el('div', { class: 'card', id: 'no-driver' }, el('h1', {}, 'Driver profile not set up yet'),
  el('p', {}, 'Your fleet operator needs to add you to a fleet before you can subscribe or see earnings.'));

async function earnings() {
  let e: any;
  try { e = await api('GET', '/v1/drivers/me/earnings'); } catch (err) { if (noProfile(err)) return render(noProfileCard()); throw err; }
  const s = e.summary;
  const elig = ELIG[e.eligibility?.[0]?.eligibility_status ?? 'PENDING']!;
  const now = new Date(), months: Array<[string, string]> = [];
  for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push([d.toISOString().slice(0, 7), d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })]); }
  const stmt = el('form', { class: 'inline', id: 'statement-form' }, select('Month', 'month', months),
    el('button', { class: 'btn', type: 'submit', value: 'pdf' }, 'Download PDF'), el('button', { class: 'btn', type: 'submit', value: 'csv' }, 'Download CSV'));
  stmt.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fmt = ((ev as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'csv' ? 'csv' : 'pdf';
    const m = String(new FormData(stmt).get('month'));
    await act(() => download(`/v1/drivers/me/statements/${m}?format=${fmt}`, `driver-statement-${m}.${fmt}`));
  });
  const tablets = (e.devices as any[]).map((d) => el('li', {}, `${d.serial} — `, d.status === 'SUSPENDED' ? chip('Suspended', 'warn') : d.online ? chip('Online', 'ok') : chip('Offline', 'err'),
    el('span', { class: 'sub' }, ` last check-in ${d.last_heartbeat_at ? fmtDate(d.last_heartbeat_at) : 'never'}`)));
  render(el('h1', {}, 'My earnings'),
    el('p', { class: 'card notice', id: 'disclosure' }, e.disclosure),
    el('div', { class: 'card', id: 'eligibility' }, el('div', { class: 'row-head' }, el('h2', {}, 'Earnings eligibility'), chip(elig[0], elig[2])), el('p', { class: 'muted' }, elig[1])),
    el('div', { class: 'grid' },
      stat(money(s.net), 'Earned (allocated), last 90 days', 'stat-net'), stat(money(s.payableBalance), 'Balance owed to you', 'stat-payable'),
      stat(money(e.estimate.estimatedShare), 'Estimate, not yet allocated (indicative)', 'stat-estimate'),
      stat(String(e.conversions.count), `Sales from your tablet (${money(e.conversions.attributedCommission)} commission)`, 'stat-sales')),
    el('div', { class: 'card', id: 'tablet' }, el('h2', {}, 'Tablet in your vehicle'),
      tablets.length ? el('ul', {}, ...tablets) : el('p', { class: 'muted' }, 'No tablet is assigned to you yet. Your fleet operator assigns tablets to vehicles.'),
      el('p', { class: 'muted' }, 'Keep the tablet charged and connected: only plays that pass validation count.')),
    el('div', { class: 'card' }, el('h2', {}, 'By source'),
      Object.keys(s.byCategory).length ? el('ul', {}, ...Object.entries(s.byCategory).map(([k, v]) => el('li', {}, `${CATEGORY[k] ?? k}: ${money(v as string)}`))) : el('p', { class: 'muted' }, 'No allocated earnings in this period yet.')),
    (e.lines as any[]).length ? el('div', { class: 'table-wrap' }, el('table', { id: 'earning-lines' },
      el('thead', {}, el('tr', {}, ...['Allocated', 'Source', 'Your share', 'Status'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...(e.lines as any[]).slice(0, 100).map((l) => el('tr', {}, el('td', { class: 'sub' }, fmtDate(l.allocatedAt)), el('td', {}, CATEGORY[l.category] ?? l.category),
        el('td', {}, money(l.netAmount, l.currency)), el('td', {}, chip(l.status.toLowerCase()))))))) : null,
    el('div', { class: 'card' }, el('h2', {}, 'Monthly statements'), stmt, el('p', { class: 'muted' }, 'Payouts are not enabled yet. Statements come straight from the ledger.')));
}

async function subscription() {
  let r: any;
  try { r = await api('GET', '/v1/drivers/me/subscription'); } catch (err) { if (noProfile(err)) return render(noProfileCard()); throw err; }
  const back = new URLSearchParams(location.search).get('subscription');
  if (back) { history.replaceState(null, '', location.pathname + location.hash); toast(back === 'success' ? 'Subscription started. It shows here as soon as the payment processor confirms it.' : 'Checkout canceled. Nothing was charged.', back !== 'success'); }
  const s = r.subscription;
  const invoices = (await api('GET', '/v1/drivers/me/invoices')).items as any[];
  const live = s && ['ACTIVE', 'PAST_DUE', 'INCOMPLETE'].includes(s.status);
  const start = async () => {
    const v = await dialog('Start the $30/month subscription', [
      el('p', {}, r.disclosure),
      el('label', { class: 'check attest' }, el('input', { type: 'checkbox', name: 'accept', value: '1', required: '' }), 'I understand the subscription does not guarantee any earnings, and that I can cancel any time.'),
    ], 'Continue to payment');
    if (!v) return;
    try { location.assign((await api('POST', '/v1/drivers/me/subscription', { acceptDisclosure: true })).checkoutUrl); } catch (e) { toast(errText(e), true); }
  };
  const cancel = async () => {
    const v = await dialog('Cancel your subscription?', [el('p', {}, `No further charges will be made. You stay subscribed until ${s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : 'the end of the paid period'}.`)], 'Cancel subscription', true);
    if (v && await act(() => api('POST', '/v1/drivers/me/subscription/cancel', {}), 'Cancellation scheduled. No further charges.')) await subscription();
  };
  const status: Kid = !s ? chip('Not subscribed') : s.status === 'ACTIVE' && s.cancel_at_period_end ? chip('Ends at period end', 'warn')
    : s.status === 'ACTIVE' ? chip('Active', 'ok') : s.status === 'PAST_DUE' ? chip('Payment failed — update card', 'err') : chip(s.status.toLowerCase());
  render(el('h1', {}, 'Subscription'),
    el('div', { class: 'card', id: 'subscription-card' }, el('div', { class: 'row-head' }, el('h2', {}, 'Participation subscription — $30/month'), status),
      s?.current_period_end ? el('p', {}, `${s.cancel_at_period_end ? 'Access ends' : 'Renews'} on ${new Date(s.current_period_end).toLocaleDateString()}.`) : null,
      el('p', { class: 'muted' }, r.disclosure),
      el('div', { class: 'actions' },
        !live ? btn('Subscribe', start, 'btn primary', { id: 'subscribe' }) : null,
        live && !s.cancel_at_period_end ? btn('Cancel subscription', cancel, 'btn danger', { id: 'cancel-subscription' }) : null)),
    el('div', { class: 'card' }, el('h2', {}, 'Receipts'),
      invoices.length ? el('table', { id: 'invoices' }, el('tbody', {}, ...invoices.map((i) => el('tr', {}, el('td', {}, i.number), el('td', {}, money(i.total_minor, String(i.currency).trim())),
        el('td', { class: 'sub' }, fmtDate(i.issued_at)), el('td', {}, chip(String(i.status).toLowerCase())))))) : el('p', { class: 'muted' }, 'None yet.')));
}
