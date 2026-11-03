import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '../src/modules/payments/fake.js';
import { formEncode, StripeProvider } from '../src/modules/payments/stripe.js';
import { stripeSignatureHeader, type ProviderEvent } from '../src/modules/payments/provider.js';
import { processPendingWebhooks } from '../src/modules/payments/webhooks.js';
import { ensureOpenPeriod, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
const fake = new FakePaymentProvider();
let ctx: Ctx;
let fin: User, approver: User, driverUser: User, advAdmin: User;
let driverId: string, advertiser: string;
const started = new Date(Date.now() - 60_000);
const SECRET = 'whsec_testsecret123';

const api = (method: 'GET' | 'POST', url: string, h: object = {}, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });
const send = (e: ProviderEvent, opts: { secret?: string; t?: number } = {}) => {
  const body = JSON.stringify(e);
  return ctx.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: body,
    headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(body, opts.secret ?? SECRET, opts.t) } });
};
const bal = async (account: string, party: string | null, processor?: string) => BigInt((await ctx.db.query(
  `SELECT coalesce(sum(CASE WHEN a.normal_balance = 'DEBIT' THEN debit - credit ELSE credit - debit END), 0)::text b
     FROM journal_lines l JOIN ledger_accounts a ON a.code = l.account_code WHERE l.account_code = $1 AND ($2::uuid IS NULL OR l.party_id = $2) AND ($3::text IS NULL OR l.processor = $3)`,
  [account, party, processor ?? null])).rows[0].b);

beforeAll(async () => {
  ctx = await setupApp({ paymentProvider: fake });
  await ensureOpenPeriod(ctx.db);
  const p = await platformOrg(ctx.db);
  fin = await userWithRole(ctx, p, 'finance_admin', { mfa: true });
  approver = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  const fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
  driverUser = await userWithRole(ctx, fleetOrg, 'driver');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','Springfield','UTC') RETURNING id`, [fleetOrg])).rows[0].id;
  driverId = (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id) VALUES ($1,$2,$3) RETURNING id`, [fleetOrg, fleet, driverUser.userId])).rows[0].id;
  advertiser = await org(ctx.db, 'ADVERTISER');
  advAdmin = await userWithRole(ctx, advertiser, 'advertiser_admin');
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('webhook inbox', () => {
  it('rejects bad or stale signatures, dedupes replays, and never acts on live-mode events', async () => {
    const e: ProviderEvent = { id: `evt_${uid()}`, type: 'customer.created', created: 0, livemode: false, data: { object: {} } };
    expect((await send(e, { secret: 'whsec_wrong' })).statusCode).toBe(400);
    expect((await send(e, { t: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(400);
    expect((await send(e)).json()).toMatchObject({ received: true, outcome: 'IGNORED' });
    expect((await send(e)).json()).toMatchObject({ duplicate: true });
    const live = await send({ ...e, id: `evt_${uid()}`, livemode: true, type: 'payment_intent.succeeded' });
    expect(live.json().ignored).toBe('livemode');
    const x = (await api('GET', '/v1/finance/reconciliation/exceptions', fin.h)).json().items;
    expect(x.some((i: any) => i.kind === 'UNHANDLED_EVENT' && /livemode/.test(i.details.reason))).toBe(true);
  });
});

describe('driver $30 participation subscription', () => {
  let sub: any;
  it('requires accepting the no-earnings-guarantee disclosure, then starts a provider checkout', async () => {
    const before = (await api('GET', '/v1/drivers/me/subscription', driverUser.h)).json();
    expect(before.subscription).toBeNull();
    expect(before.disclosure).toMatch(/does not guarantee earnings/);
    expect((await api('POST', '/v1/drivers/me/subscription', driverUser.h, {})).statusCode).toBe(400);
    const r = await api('POST', '/v1/drivers/me/subscription', driverUser.h, { acceptDisclosure: true });
    expect(r.statusCode).toBe(201);
    expect(r.json().checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const done = fake.completeSubscription(r.json().sessionId);
    sub = done.subscription;
    // Out-of-order delivery is fine: the invoice carries the driver in subscription metadata.
    expect((await send(done.invoicePaid)).json().outcome).toBe('PROCESSED');
    expect((await send(done.subscriptionCreated)).json().outcome).toBe('PROCESSED');
    expect((await send(done.invoicePaid)).json().duplicate).toBe(true);
  });

  it('books $30 to driver subscription revenue (4200) only — never to revenue pools or payables', async () => {
    const s = (await api('GET', '/v1/drivers/me/subscription', driverUser.h)).json().subscription;
    expect(s).toMatchObject({ status: 'ACTIVE', price_minor: '3000', cancel_at_period_end: false });
    expect(await bal('4200', driverId)).toBe(3000n);
    expect(await bal('2210', driverId)).toBe(0n);
    const inv = (await api('GET', '/v1/drivers/me/invoices', driverUser.h)).json().items;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ kind: 'DRIVER_SUBSCRIPTION', total_minor: '3000', status: 'PAID' });
    expect(inv[0].lines[0].description).toMatch(/does not guarantee earnings/);
  });

  it('renewal with sales tax posts tax to 2100; failed renewal marks past due; cancellation is transparent', async () => {
    await send(fake.renew(sub.id, 3000, 248));
    expect(await bal('4200', driverId)).toBe(6000n);
    await send({ id: `evt_${uid()}`, type: 'invoice.payment_failed', created: 0, livemode: false, data: { object: { id: `in_${uid()}`, subscription: sub.id } } });
    expect((await api('GET', '/v1/drivers/me/subscription', driverUser.h)).json().subscription.status).toBe('PAST_DUE');
    const c = await api('POST', '/v1/drivers/me/subscription/cancel', driverUser.h, {});
    expect(c.json()).toMatchObject({ cancelAtPeriodEnd: true, message: expect.stringMatching(/No further charges/) });
    expect(fake.canceled).toContain(sub.id);
    await send(fake.subscriptionEvent(sub.id, { status: 'canceled' }, 'customer.subscription.deleted'));
    expect((await api('GET', '/v1/drivers/me/subscription', driverUser.h)).json().subscription.status).toBe('CANCELED');
  });

  it('other users cannot use the driver endpoints', async () => {
    expect((await api('GET', '/v1/drivers/me/subscription', advAdmin.h)).statusCode).toBe(404);
  });
});

describe('advertiser prepayments and refunds', () => {
  let paymentId: string;
  it('credits the prepaid balance only when the processor confirms, once', async () => {
    expect((await api('POST', `/v1/orgs/${advertiser}/prepayments`, advAdmin.h, { amountMinor: '500' })).statusCode).toBe(422);
    const r = await api('POST', `/v1/orgs/${advertiser}/prepayments`, advAdmin.h, { amountMinor: '50000' });
    expect(r.statusCode).toBe(201);
    expect((await api('GET', `/v1/orgs/${advertiser}/balance`, advAdmin.h)).json().balances.USD).toBeUndefined();
    const e = fake.completePayment(r.json().sessionId);
    await send(e);
    await send({ ...e, id: `evt_${uid()}` }); // a second event for the same payment intent must not double-credit
    expect((await api('GET', `/v1/orgs/${advertiser}/balance`, advAdmin.h)).json().balances.USD.prepaidBalance).toBe('50000');
    const inv = (await api('GET', `/v1/orgs/${advertiser}/invoices`, advAdmin.h)).json().items;
    expect(inv.map((i: any) => [i.kind, i.total_minor])).toEqual([['PREPAYMENT_RECEIPT', '50000']]);
    paymentId = (await ctx.db.query('SELECT id FROM payments WHERE org_id = $1', [advertiser])).rows[0].id;
  });

  it('refunds of unused balance need a second approver, go through the processor, and post on confirmation', async () => {
    const tooMuch = await api('POST', `/v1/orgs/${advertiser}/prepayment-refund-requests`, fin.h, { idempotencyKey: `rf-${uid()}`, paymentId, amountMinor: '60000', reason: 'customer request', entryDate: new Date().toISOString().slice(0, 10) });
    expect(tooMuch.statusCode).toBe(422);
    const req = await api('POST', `/v1/orgs/${advertiser}/prepayment-refund-requests`, fin.h, { idempotencyKey: `rf-${uid()}`, paymentId, amountMinor: '20000', reason: 'Advertiser paused their program', entryDate: new Date().toISOString().slice(0, 10) });
    expect(req.statusCode).toBe(201);
    expect((await api('POST', `/v1/finance/journal-requests/${req.json().id}/decision`, fin.h, { decision: 'APPROVE' })).statusCode).toBe(403);
    const ok = await api('POST', `/v1/finance/journal-requests/${req.json().id}/decision`, approver.h, { decision: 'APPROVE' });
    expect(ok.json()).toMatchObject({ status: 'APPROVED' });
    const refundId = ok.json().provider_ref;
    expect(fake.refunds.find((r) => r.id === refundId)?.amountMinor).toBe(20000);
    // Nothing posts until the processor confirms.
    expect((await api('GET', `/v1/orgs/${advertiser}/balance`, advAdmin.h)).json().balances.USD.prepaidBalance).toBe('50000');
    const p = (await ctx.db.query('SELECT provider_payment_ref, provider_charge_id FROM payments WHERE id = $1', [paymentId])).rows[0];
    await send(fake.refundedEvent(p.provider_payment_ref, p.provider_charge_id, 20000, 20000, refundId));
    expect((await api('GET', `/v1/orgs/${advertiser}/balance`, advAdmin.h)).json().balances.USD.prepaidBalance).toBe('30000');
    const r = (await ctx.db.query('SELECT requested_by FROM payment_refunds WHERE provider_refund_id = $1', [refundId])).rows[0];
    expect(r.requested_by).toBe(fin.userId);
    expect((await api('GET', `/v1/orgs/${advertiser}/invoices`, advAdmin.h)).json().items.map((i: any) => i.kind)).toContain('PREPAYMENT_REFUND');
  });

  it('a dispute opens a reconciliation exception for a person to handle', async () => {
    const ch = (await ctx.db.query('SELECT provider_charge_id FROM payments WHERE id = $1', [paymentId])).rows[0].provider_charge_id;
    await send(fake.disputeEvent(ch, 30000));
    const x = (await api('GET', '/v1/finance/reconciliation/exceptions', fin.h)).json().items;
    expect(x.some((i: any) => i.kind === 'DISPUTE' && i.details.chargeId === ch)).toBe(true);
  });
});

describe('retries and reconciliation', () => {
  it('failed events back off and, after 8 attempts, become an exception', async () => {
    const e: ProviderEvent = { id: `evt_${uid()}`, type: 'charge.refunded', created: 0, livemode: false, data: { object: { id: `ch_unknown_${uid()}`, refunds: { data: [] } } } };
    expect((await send(e)).json().outcome).toBe('FAILED');
    for (let i = 0; i < 7; i++) {
      await ctx.db.query(`UPDATE webhook_inbox SET next_attempt_at = now() WHERE event_id = $1`, [e.id]);
      await processPendingWebhooks(ctx.db);
    }
    const row = (await ctx.db.query('SELECT status, attempts FROM webhook_inbox WHERE event_id = $1', [e.id])).rows[0];
    expect(row).toEqual({ status: 'FAILED', attempts: 8 });
    expect((await ctx.db.query(`SELECT 1 FROM reconciliation_exceptions WHERE kind = 'UNHANDLED_EVENT' AND provider_ref = $1`, [e.id])).rows).toHaveLength(1);
  });

  it('matches every processor transaction, books fees and payouts, and the clearing balance equals the processor balance', async () => {
    fake.payout(10_000);
    const window = { from: started.toISOString(), to: new Date(Date.now() + 60_000).toISOString(), compareBalance: true };
    const r = (await api('POST', '/v1/finance/reconciliation/runs', fin.h, window)).json();
    expect(r).toMatchObject({ exceptions: 0, payoutsPosted: 1 });
    expect(r.feesPosted).toBe(3); // one processor fee per charge: first subscription invoice, renewal, prepayment
    expect(r.providerNetBalance).toBe(r.ledgerClearingBalance);
    expect(await bal('5000', null)).toBeGreaterThan(0n);
    const again = (await api('POST', '/v1/finance/reconciliation/runs', fin.h, window)).json();
    expect(again).toMatchObject({ feesPosted: 0, payoutsPosted: 0, exceptions: 0 }); // idempotent
    expect((await api('GET', '/v1/finance/trial-balance', fin.h)).json().balanced).toBe(true);
  });

  it('flags unknown processor transactions and balance drift', async () => {
    fake.balance.push({ id: `txn_${uid()}`, type: 'charge', amount: 777, fee: 53, net: 724, currency: 'USD', created: Math.floor(Date.now() / 1000), source: `ch_mystery_${uid()}` });
    const r = (await api('POST', '/v1/finance/reconciliation/runs', fin.h, { from: started.toISOString(), to: new Date(Date.now() + 60_000).toISOString(), compareBalance: true })).json();
    const kinds = (await api('GET', '/v1/finance/reconciliation/exceptions', fin.h)).json().items.map((i: any) => i.kind);
    expect(r.exceptions).toBe(2);
    expect(kinds).toEqual(expect.arrayContaining(['UNMATCHED_PROVIDER_TRANSACTION', 'BALANCE_MISMATCH']));
  });

  it('open exceptions block closing the period until resolved by an approver', async () => {
    const p = (await ctx.db.query(`INSERT INTO accounting_periods (period_start, period_end) VALUES ('2025-03-01','2025-03-31') RETURNING id`)).rows[0].id;
    const x = (await ctx.db.query(`INSERT INTO reconciliation_exceptions (provider, kind, provider_ref, occurred_at) VALUES ('stripe','AMOUNT_MISMATCH',$1,'2025-03-15') RETURNING id`, [`old-${uid()}`])).rows[0].id;
    const blocked = await api('POST', `/v1/finance/periods/${p}/close`, approver.h, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/reconciliation exception/);
    // Resolve every exception dated on or before the period end, then close.
    const open = (await ctx.db.query(`SELECT id FROM reconciliation_exceptions WHERE status = 'OPEN' AND occurred_at <= '2025-03-31'`)).rows;
    expect(open.map((o) => o.id)).toContain(x);
    for (const o of open) expect((await api('POST', `/v1/finance/reconciliation/exceptions/${o.id}/resolve`, approver.h, { note: 'Investigated and corrected in March close' })).statusCode).toBe(200);
    expect((await api('POST', `/v1/finance/periods/${p}/close`, approver.h, {})).statusCode).toBe(200);
  });
});

describe('Stripe REST client', () => {
  it('refuses live keys and sends correctly encoded, authenticated requests', async () => {
    expect(() => new StripeProvider('sk_live_abc123')).toThrow(/TEST/);
    expect(formEncode({ a: 1, line_items: [{ price_data: { unit_amount: 500 } }], metadata: { orgId: 'x y' } }))
      .toEqual(['a=1', 'line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500', 'metadata%5BorgId%5D=x%20y']);
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }), { status: 200 }); }) as any;
    const s = new StripeProvider('sk_test_abc123', fetchMock);
    const out = await s.createPaymentCheckout({ amountMinor: 50000, currency: 'USD', description: 'Prepaid', customerEmail: 'a@example.test', successUrl: 'https://x/s', cancelUrl: 'https://x/c', metadata: { orgId: 'o1', purpose: 'ADVERTISER_PREPAYMENT' } });
    expect(out).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer sk_test_abc123');
    const body = decodeURIComponent(calls[0]!.init.body);
    expect(body).toContain('mode=payment');
    expect(body).toContain('line_items[0][price_data][unit_amount]=50000');
    expect(body).toContain('payment_intent_data[metadata][orgId]=o1');
    const err = new StripeProvider('sk_test_abc123', (async () => new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 400 })) as any);
    await expect(err.cancelSubscriptionAtPeriodEnd('sub_1')).rejects.toThrow(/No such customer/);
  });
});
