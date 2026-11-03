import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { idemKey, isoDate, minor, parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize, requireAuth } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';
import { advertiserAvailableMilli } from '../campaigns/budget.js';
import type { PaymentProvider } from './provider.js';
import { verifyStripeSignature } from './provider.js';
import { PROCESSOR, processInboxRow, processPendingWebhooks, raiseException } from './webhooks.js';
import { runReconciliation } from './reconcile.js';

export const DRIVER_SUBSCRIPTION_DISCLOSURE =
  'The $30/month participation subscription is billed separately from any earnings. It does not guarantee earnings; earnings depend on validated ad delivery and eligibility. Cancel any time: access continues to the end of the paid period and no further charges are made.';

async function myDriver(db: Db, req: FastifyRequest, driverId?: string) {
  const auth = requireAuth(req);
  const r = await db.query(`SELECT d.id, d.org_id, u.email FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 ${driverId ? 'AND d.id = $2' : ''}`, driverId ? [auth.userId, driverId] : [auth.userId]);
  if (r.rows.length === 0) throw notFound('no driver profile for this account');
  if (r.rows.length > 1) throw unprocessable('you drive for several fleets; pass driverId');
  await authorize(db, req, 'driver.subscription.manage', r.rows[0].org_id);
  return r.rows[0] as { id: string; org_id: string; email: string };
}

export async function paymentRoutes(app: FastifyInstance, { db, config, provider }: { db: Db; config: Config; provider: PaymentProvider }) {
  // ---------------- webhook inbox ----------------
  /** Signed, idempotent intake. Always stored first; processed immediately and retried by jobs:process-webhooks on failure. */
  app.post('/v1/webhooks/stripe', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = req.rawBody ?? '';
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'] as string | undefined, config.STRIPE_WEBHOOK_SECRET)) throw badRequest('invalid webhook signature');
    const e = req.body as any;
    if (!e?.id || !e?.type || !e?.data?.object) throw badRequest('malformed event');
    const ins = await db.query(
      `INSERT INTO webhook_inbox (provider, event_id, type, livemode, payload, status) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [PROCESSOR, e.id, e.type, !!e.livemode, raw, e.livemode ? 'IGNORED' : 'RECEIVED']);
    if (!ins.rows[0]) return { received: true, duplicate: true };
    if (e.livemode) {
      // Live money movement is disabled (D-010): never act on live events, but make them visible.
      await withTx(db, (tx) => raiseException(tx, 'UNHANDLED_EVENT', e.id, null, { type: e.type, reason: 'livemode event received while live payments are disabled' }));
      return { received: true, ignored: 'livemode' };
    }
    const outcome = await processInboxRow(db, ins.rows[0].id);
    reply.code(200);
    return { received: true, outcome };
  });

  app.get('/v1/finance/webhooks', async (req) => {
    await authorize(db, req, 'finance.reconcile');
    const q = parse(z.object({ status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).optional() }), req.query);
    return { items: (await db.query(`SELECT id::text, event_id, type, status, attempts, last_error, received_at, processed_at FROM webhook_inbox WHERE ($1::text IS NULL OR status = $1) ORDER BY id DESC LIMIT 200`, [q.status ?? null])).rows };
  });

  app.post('/v1/finance/webhooks/retry', async (req) => {
    await authorize(db, req, 'finance.reconcile');
    return processPendingWebhooks(db);
  });

  // ---------------- driver subscription ($30/month) ----------------
  app.get('/v1/drivers/me/subscription', async (req) => {
    const q = parse(z.object({ driverId: uuid.optional() }), req.query);
    const d = await myDriver(db, req, q.driverId);
    const s = await db.query(`SELECT status, price_minor, currency, current_period_end, cancel_at_period_end, canceled_at FROM driver_subscriptions WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 1`, [d.id]);
    return { driverId: d.id, subscription: s.rows[0] ?? null, disclosure: DRIVER_SUBSCRIPTION_DISCLOSURE };
  });

  app.post('/v1/drivers/me/subscription', async (req, reply) => {
    const b = parse(z.object({ driverId: uuid.optional(), acceptDisclosure: z.literal(true) }), req.body);
    const d = await myDriver(db, req, b.driverId);
    const live = await db.query(`SELECT 1 FROM driver_subscriptions WHERE driver_id = $1 AND status IN ('ACTIVE','PAST_DUE')`, [d.id]);
    if (live.rows[0]) throw conflict('you already have a subscription');
    const metadata = { driverId: d.id, purpose: 'DRIVER_SUBSCRIPTION' };
    const customer = await provider.createCustomer({ email: d.email, metadata });
    const s = await provider.createSubscriptionCheckout({ customerId: customer.id, priceId: config.STRIPE_DRIVER_PRICE_ID, metadata,
      successUrl: `${config.APP_PUBLIC_URL}/admin/?subscription=success`, cancelUrl: `${config.APP_PUBLIC_URL}/admin/?subscription=canceled` });
    await db.query(`INSERT INTO checkout_sessions (provider, provider_session_id, purpose, driver_id, amount_minor, url, created_by) VALUES ($1,$2,'DRIVER_SUBSCRIPTION',$3,3000,$4,$5)`,
      [PROCESSOR, s.id, d.id, s.url, requireAuth(req).userId]);
    await audit(db, actorOf(req), 'driver.subscription_checkout_started', { type: 'driver', id: d.id, orgId: d.org_id }, { disclosureAccepted: true });
    reply.code(201);
    return { checkoutUrl: s.url, sessionId: s.id, disclosure: DRIVER_SUBSCRIPTION_DISCLOSURE };
  });

  /** Transparent cancellation: stops renewal at period end; the provider's subscription.updated webhook updates our record. */
  app.post('/v1/drivers/me/subscription/cancel', async (req) => {
    const b = parse(z.object({ driverId: uuid.optional() }), req.body ?? {});
    const d = await myDriver(db, req, b.driverId);
    const s = (await db.query(`SELECT * FROM driver_subscriptions WHERE driver_id = $1 AND status IN ('ACTIVE','PAST_DUE','INCOMPLETE') ORDER BY created_at DESC LIMIT 1`, [d.id])).rows[0];
    if (!s) throw notFound('no active subscription');
    await provider.cancelSubscriptionAtPeriodEnd(s.provider_subscription_id);
    await db.query(`UPDATE driver_subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE id = $1`, [s.id]);
    await audit(db, actorOf(req), 'driver.subscription_cancel_requested', { type: 'driver', id: d.id, orgId: d.org_id });
    return { status: s.status, cancelAtPeriodEnd: true, accessUntil: s.current_period_end, message: 'No further charges will be made. Participation continues until the end of the paid period.' };
  });

  app.get('/v1/drivers/me/invoices', async (req) => {
    const q = parse(z.object({ driverId: uuid.optional() }), req.query);
    const d = await myDriver(db, req, q.driverId);
    return { items: (await db.query(`SELECT number, kind, currency, subtotal_minor, tax_minor, total_minor, status, lines, issued_at FROM invoices WHERE driver_id = $1 ORDER BY issued_at DESC`, [d.id])).rows };
  });

  // ---------------- advertiser prepayments ----------------
  app.post('/v1/orgs/:orgId/prepayments', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    if (org.kind !== 'ADVERTISER') throw notFound('advertiser not found');
    const auth = await authorize(db, req, 'billing.manage', orgId);
    const b = parse(z.object({ amountMinor: minor }), req.body);
    if (b.amountMinor < 1000n || b.amountMinor > 10_000_000n) throw unprocessable('prepayments must be between $10.00 and $100,000.00');
    const email = (await db.query('SELECT email FROM users WHERE id = $1', [auth.userId])).rows[0].email;
    const s = await provider.createPaymentCheckout({ amountMinor: Number(b.amountMinor), currency: 'USD', description: `Prepaid advertising balance — ${org.name}`, customerEmail: email,
      metadata: { purpose: 'ADVERTISER_PREPAYMENT', orgId }, successUrl: `${config.APP_PUBLIC_URL}/admin/?prepayment=success`, cancelUrl: `${config.APP_PUBLIC_URL}/admin/?prepayment=canceled` });
    await db.query(`INSERT INTO checkout_sessions (provider, provider_session_id, purpose, org_id, amount_minor, url, created_by) VALUES ($1,$2,'ADVERTISER_PREPAYMENT',$3,$4,$5,$6)`,
      [PROCESSOR, s.id, orgId, b.amountMinor.toString(), s.url, auth.userId]);
    await audit(db, actorOf(req), 'billing.prepayment_checkout_started', { type: 'organization', id: orgId, orgId }, { amountMinor: b.amountMinor.toString() });
    reply.code(201);
    return { checkoutUrl: s.url, sessionId: s.id, note: 'Your balance is credited when the payment processor confirms the payment.' };
  });

  app.get('/v1/orgs/:orgId/invoices', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'billing.manage', orgId);
    return { items: (await db.query(`SELECT number, kind, currency, subtotal_minor, tax_minor, total_minor, status, lines, issued_at FROM invoices WHERE org_id = $1 ORDER BY issued_at DESC`, [orgId])).rows };
  });

  /**
   * Request a refund of unused prepaid balance. Executed only when a different approver approves it
   * (journal-requests decision). Capped by the payment's unrefunded amount AND the advertiser's uncommitted funds.
   */
  app.post('/v1/orgs/:orgId/prepayment-refund-requests', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const auth = await authorize(db, req, 'finance.reconcile');
    const b = parse(z.object({ idempotencyKey: idemKey, paymentId: uuid, amountMinor: minor, reason: z.string().min(10).max(2000), entryDate: isoDate }), req.body);
    const p = (await db.query(`SELECT * FROM payments WHERE id = $1 AND org_id = $2 AND purpose = 'ADVERTISER_PREPAYMENT'`, [b.paymentId, orgId])).rows[0];
    if (!p) throw notFound('payment not found');
    if (b.amountMinor <= 0n || b.amountMinor > BigInt(p.amount_minor) - BigInt(p.refunded_minor)) throw unprocessable('amount exceeds the unrefunded payment');
    const avail = await advertiserAvailableMilli(db, orgId, p.currency.trim(), new Date());
    if (b.amountMinor * 1000n > avail) throw unprocessable(`only ${avail / 1000n} is uncommitted; committed spend cannot be refunded`);
    const jr = await db.query(
      `INSERT INTO journal_requests (idempotency_key, requested_by, reason, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [b.idempotencyKey, auth.userId, b.reason, JSON.stringify({ kind: 'PREPAYMENT_REFUND', paymentId: p.id, orgId, amount: b.amountMinor.toString(), entryDate: b.entryDate })]);
    if (!jr.rows[0]) return (await db.query('SELECT * FROM journal_requests WHERE idempotency_key = $1', [b.idempotencyKey])).rows[0];
    await audit(db, actorOf(req), 'billing.prepayment_refund_requested', { type: 'payment', id: p.id, orgId }, { amount: b.amountMinor.toString() });
    reply.code(201);
    return jr.rows[0];
  });

  // ---------------- reconciliation ----------------
  app.post('/v1/finance/reconciliation/runs', async (req) => {
    const auth = await authorize(db, req, 'finance.reconcile');
    const b = parse(z.object({ from: z.string().datetime(), to: z.string().datetime(), compareBalance: z.boolean().default(false) }), req.body);
    if (new Date(b.to) <= new Date(b.from)) throw badRequest('to must be after from');
    const r = await runReconciliation(db, provider, { from: new Date(b.from), to: new Date(b.to), userId: auth.userId, compareBalance: b.compareBalance });
    await audit(db, actorOf(req), 'finance.reconciliation_run', { type: 'reconciliation_run', id: r.runId }, r);
    return r;
  });

  app.get('/v1/finance/reconciliation/exceptions', async (req) => {
    await authorize(db, req, 'finance.reconcile');
    const q = parse(z.object({ status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') }), req.query);
    return { items: (await db.query(`SELECT * FROM reconciliation_exceptions WHERE status = $1 ORDER BY created_at DESC LIMIT 500`, [q.status])).rows };
  });

  app.post('/v1/finance/reconciliation/exceptions/:id/resolve', async (req) => {
    const auth = await authorize(db, req, 'finance.journal.approve');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ note: z.string().min(10).max(2000) }), req.body);
    const r = await db.query(`UPDATE reconciliation_exceptions SET status = 'RESOLVED', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1 AND status = 'OPEN' RETURNING id, kind, status`, [id, auth.userId, b.note]);
    if (!r.rows[0]) throw notFound('open exception not found');
    await audit(db, actorOf(req), 'finance.reconciliation_exception_resolved', { type: 'reconciliation_exception', id }, { note: b.note });
    return r.rows[0];
  });
}
