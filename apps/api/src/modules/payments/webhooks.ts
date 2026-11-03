import type { Db, Tx } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { postEntry } from '../ledger/service.js';
import { advertiserAvailableMilli } from '../campaigns/budget.js';
import type { ProviderEvent } from './provider.js';

const MAX_ATTEMPTS = 8;
export const PROCESSOR = 'stripe';

/** Event date if its accounting period is open, otherwise today (cash is recorded when we learn of it). */
export async function postingDate(tx: Tx, at: Date): Promise<string> {
  const d = at.toISOString().slice(0, 10);
  const open = await tx.query(`SELECT 1 FROM accounting_periods WHERE status = 'OPEN' AND $1::date BETWEEN period_start AND period_end`, [d]);
  if (open.rows[0]) return d;
  const today = new Date().toISOString().slice(0, 10);
  const t = await tx.query(`SELECT 1 FROM accounting_periods WHERE status = 'OPEN' AND $1::date BETWEEN period_start AND period_end`, [today]);
  if (!t.rows[0]) throw new Error('no open accounting period for today; open one before payments can post');
  return today;
}

export async function raiseException(tx: Tx, kind: string, ref: string, amount: number | bigint | null, details: object, runId: string | null = null) {
  await tx.query(
    `INSERT INTO reconciliation_exceptions (run_id, provider, kind, provider_ref, amount_minor, details) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (provider, kind, provider_ref) DO NOTHING`, [runId, PROCESSOR, kind, ref, amount === null ? null : String(amount), JSON.stringify(details)]);
}

const SUB_STATUS: Record<string, string> = { active: 'ACTIVE', trialing: 'ACTIVE', past_due: 'PAST_DUE', unpaid: 'PAST_DUE', canceled: 'CANCELED', incomplete: 'INCOMPLETE', incomplete_expired: 'CANCELED' };

async function onSubscription(tx: Tx, sub: any, deleted: boolean) {
  const driverId = sub.metadata?.driverId;
  const drv = driverId && (await tx.query('SELECT id FROM drivers WHERE id = $1', [driverId])).rows[0];
  if (!drv) throw new Error(`subscription ${sub.id} has no known driverId metadata`);
  const status = deleted ? 'CANCELED' : SUB_STATUS[sub.status] ?? 'INCOMPLETE';
  const price = sub.items?.data?.[0]?.price;
  await tx.query(
    `INSERT INTO driver_subscriptions (driver_id, provider, provider_customer_id, provider_subscription_id, status, price_minor, currency, current_period_end, cancel_at_period_end, canceled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9, CASE WHEN $5 = 'CANCELED' THEN now() END)
     ON CONFLICT (provider_subscription_id) DO UPDATE SET status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end, canceled_at = coalesce(driver_subscriptions.canceled_at, EXCLUDED.canceled_at), updated_at = now()`,
    [driverId, PROCESSOR, sub.customer, sub.id, status, price?.unit_amount ?? 3000, String(price?.currency ?? 'usd').toUpperCase(), sub.current_period_end ?? null, !!sub.cancel_at_period_end]);
}

/** Subscription invoice paid: Dr 1010 processor clearing / Cr 4200 driver subscription revenue (+ 2100 tax). Never touches revenue pools. */
async function onInvoicePaid(tx: Tx, inv: any) {
  if (!inv.subscription) return 'IGNORED';
  if ((await tx.query('SELECT 1 FROM payments WHERE provider_payment_ref = $1', [inv.id])).rows[0]) return 'PROCESSED';
  const driverId = inv.subscription_details?.metadata?.driverId
    ?? (await tx.query('SELECT driver_id FROM driver_subscriptions WHERE provider_subscription_id = $1', [inv.subscription])).rows[0]?.driver_id;
  if (!driverId) throw new Error(`invoice ${inv.id}: driver unknown (subscription not yet recorded)`);
  const ccy = String(inv.currency).toUpperCase();
  const total = BigInt(inv.amount_paid), tax = BigInt(inv.tax ?? 0), net = total - tax;
  if (total <= 0n) return 'IGNORED';
  const paidAt = new Date((inv.status_transitions?.paid_at ?? Math.floor(Date.now() / 1000)) * 1000);
  const entry = await postEntry(tx, {
    idempotencyKey: `stripe-invoice-paid:${inv.id}`, entryDate: await postingDate(tx, paidAt), description: `Driver subscription payment ${inv.id}`,
    sourceType: 'SUBSCRIPTION', sourceId: inv.id, metadata: { chargeId: inv.charge, subscription: inv.subscription },
    lines: [
      { accountCode: '1010', currency: ccy, debit: total, processor: PROCESSOR, memo: `charge ${inv.charge}` },
      { accountCode: '4200', currency: ccy, credit: net, partyType: 'DRIVER', partyId: driverId, memo: 'driver participation subscription' },
      ...(tax > 0n ? [{ accountCode: '2100', currency: ccy, credit: tax, memo: 'sales tax collected' }] : []),
    ],
  });
  const p = await tx.query(
    `INSERT INTO payments (provider, purpose, driver_id, provider_payment_ref, provider_charge_id, currency, amount_minor, tax_minor, journal_entry_id, paid_at)
     VALUES ($1,'DRIVER_SUBSCRIPTION',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [PROCESSOR, driverId, inv.id, inv.charge, ccy, total.toString(), tax.toString(), entry.id, paidAt]);
  await tx.query(
    `INSERT INTO invoices (kind, driver_id, payment_id, currency, subtotal_minor, tax_minor, total_minor, status, lines)
     VALUES ('DRIVER_SUBSCRIPTION',$1,$2,$3,$4,$5,$6,'PAID',$7)`,
    [driverId, p.rows[0].id, ccy, net.toString(), tax.toString(), total.toString(),
     JSON.stringify([{ description: 'Rideshare Media Network driver participation (monthly). Participation does not guarantee earnings.', amountMinor: net.toString() }])]);
  return 'PROCESSED';
}

/** Advertiser prepayment: Dr 1010 / Cr 2000 advertiser prepaid balance (a liability until spend is earned). */
async function onPaymentSucceeded(tx: Tx, pi: any) {
  if (pi.metadata?.purpose !== 'ADVERTISER_PREPAYMENT') return 'IGNORED';
  if ((await tx.query('SELECT 1 FROM payments WHERE provider_payment_ref = $1', [pi.id])).rows[0]) return 'PROCESSED';
  const org = (await tx.query(`SELECT id FROM organizations WHERE id = $1 AND kind = 'ADVERTISER'`, [pi.metadata.orgId])).rows[0];
  if (!org) throw new Error(`payment ${pi.id}: unknown advertiser ${pi.metadata?.orgId}`);
  const ccy = String(pi.currency).toUpperCase();
  const amount = BigInt(pi.amount_received);
  const paidAt = new Date((pi.created ?? Math.floor(Date.now() / 1000)) * 1000);
  const entry = await postEntry(tx, {
    idempotencyKey: `stripe-payment:${pi.id}`, entryDate: await postingDate(tx, paidAt), description: `Advertiser prepayment ${pi.id}`,
    sourceType: 'PAYMENT', sourceId: pi.id, metadata: { chargeId: pi.latest_charge },
    lines: [
      { accountCode: '1010', currency: ccy, debit: amount, processor: PROCESSOR, memo: `charge ${pi.latest_charge}` },
      { accountCode: '2000', currency: ccy, credit: amount, partyType: 'ADVERTISER', partyId: org.id, memo: 'prepaid advertising balance' },
    ],
  });
  const p = await tx.query(
    `INSERT INTO payments (provider, purpose, org_id, provider_payment_ref, provider_charge_id, currency, amount_minor, journal_entry_id, paid_at)
     VALUES ($1,'ADVERTISER_PREPAYMENT',$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [PROCESSOR, org.id, pi.id, pi.latest_charge, ccy, amount.toString(), entry.id, paidAt]);
  await tx.query(
    `INSERT INTO invoices (kind, org_id, payment_id, currency, subtotal_minor, tax_minor, total_minor, status, lines) VALUES ('PREPAYMENT_RECEIPT',$1,$2,$3,$4,0,$4,'PAID',$5)`,
    [org.id, p.rows[0].id, ccy, amount.toString(), JSON.stringify([{ description: 'Prepaid advertising balance', amountMinor: amount.toString() }])]);
  return 'PROCESSED';
}

/** Refunds (from our approved requests or made directly in the Stripe dashboard): each refund id posts once. */
async function onChargeRefunded(tx: Tx, ch: any) {
  const pay = (await tx.query('SELECT * FROM payments WHERE provider_charge_id = $1 FOR UPDATE', [ch.id])).rows[0];
  if (!pay) throw new Error(`refund for unknown charge ${ch.id}`);
  const ccy = pay.currency.trim();
  for (const r of ch.refunds?.data ?? []) {
    if (r.status && r.status !== 'succeeded') continue;
    if ((await tx.query('SELECT 1 FROM payment_refunds WHERE provider_refund_id = $1', [r.id])).rows[0]) continue;
    const amount = BigInt(r.amount);
    if (BigInt(pay.refunded_minor) + amount > BigInt(pay.amount_minor)) throw new Error(`refund ${r.id} exceeds payment ${pay.id}`);
    const prepay = pay.purpose === 'ADVERTISER_PREPAYMENT';
    const entry = await postEntry(tx, {
      idempotencyKey: `stripe-refund:${r.id}`, entryDate: await postingDate(tx, new Date()), description: `Refund ${r.id} of ${pay.provider_payment_ref}`,
      sourceType: 'REFUND', sourceId: r.id, metadata: { chargeId: ch.id, paymentId: pay.id },
      lines: [
        prepay
          ? { accountCode: '2000', currency: ccy, debit: amount, partyType: 'ADVERTISER', partyId: pay.org_id, memo: 'prepaid balance refunded' }
          : { accountCode: '4200', currency: ccy, debit: amount, partyType: 'DRIVER', partyId: pay.driver_id, memo: 'subscription refund' },
        { accountCode: '1010', currency: ccy, credit: amount, processor: PROCESSOR, memo: `refund ${r.id}` },
      ],
    });
    await tx.query(`INSERT INTO payment_refunds (provider, provider_refund_id, payment_id, amount_minor, journal_entry_id, requested_by)
                    VALUES ($1,$2,$3,$4,$5,(SELECT requested_by FROM journal_requests WHERE provider_ref = $2 LIMIT 1))`,
      [PROCESSOR, r.id, pay.id, amount.toString(), entry.id]);
    pay.refunded_minor = String(BigInt(pay.refunded_minor) + amount);
    await tx.query('UPDATE payments SET refunded_minor = $2 WHERE id = $1', [pay.id, pay.refunded_minor]);
    if (prepay) {
      await tx.query(`INSERT INTO invoices (kind, org_id, payment_id, currency, subtotal_minor, tax_minor, total_minor, status, lines) VALUES ('PREPAYMENT_REFUND',$1,$2,$3,$4,0,$4,'CREDIT_NOTE',$5)`,
        [pay.org_id, pay.id, ccy, amount.toString(), JSON.stringify([{ description: `Refund of prepaid balance (${r.id})`, amountMinor: amount.toString() }])]);
      const avail = await advertiserAvailableMilli(tx, pay.org_id, ccy, new Date());
      if (avail < 0n) await raiseException(tx, 'REFUND_EXCEEDS_AVAILABLE_FUNDS', r.id, amount, { orgId: pay.org_id, availableMilliMinor: avail.toString(), note: 'refund made outside the approved flow exceeds uncommitted funds' });
    }
  }
  return 'PROCESSED';
}

export async function handleEvent(tx: Tx, e: ProviderEvent): Promise<'PROCESSED' | 'IGNORED'> {
  const o = e.data.object;
  switch (e.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': await onSubscription(tx, o, false); return 'PROCESSED';
    case 'customer.subscription.deleted': await onSubscription(tx, o, true); return 'PROCESSED';
    case 'invoice.paid': return onInvoicePaid(tx, o) as Promise<'PROCESSED' | 'IGNORED'>;
    case 'invoice.payment_failed':
      if (o.subscription) await tx.query(`UPDATE driver_subscriptions SET status = 'PAST_DUE', updated_at = now() WHERE provider_subscription_id = $1 AND status <> 'CANCELED'`, [o.subscription]);
      return 'PROCESSED';
    case 'payment_intent.succeeded': return onPaymentSucceeded(tx, o) as Promise<'PROCESSED' | 'IGNORED'>;
    case 'charge.refunded': return onChargeRefunded(tx, o) as Promise<'PROCESSED' | 'IGNORED'>;
    case 'charge.dispute.created':
      await raiseException(tx, 'DISPUTE', o.id, o.amount, { chargeId: o.charge, reason: o.reason, note: 'decide evidence submission and allocation reversals (refund/chargeback flow)' });
      return 'PROCESSED';
    default: return 'IGNORED';
  }
}

/** Process one inbox row. Failures back off exponentially; after MAX_ATTEMPTS they become a reconciliation exception. */
export async function processInboxRow(db: Db, rowId: string) {
  try {
    return await withTx(db, async (tx) => {
      const r = (await tx.query(`SELECT * FROM webhook_inbox WHERE id = $1 AND status IN ('RECEIVED','FAILED') FOR UPDATE SKIP LOCKED`, [rowId])).rows[0];
      if (!r) return null;
      const outcome = await handleEvent(tx, r.payload);
      await tx.query(`UPDATE webhook_inbox SET status = $2, attempts = attempts + 1, processed_at = now(), last_error = NULL WHERE id = $1`, [rowId, outcome]);
      return outcome;
    });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await withTx(db, async (tx) => {
      const r = (await tx.query(`UPDATE webhook_inbox SET status = 'FAILED', attempts = attempts + 1, last_error = $2,
                                    next_attempt_at = now() + make_interval(mins => power(2, least(attempts, 10))::int) WHERE id = $1 RETURNING attempts, event_id, type`, [rowId, msg])).rows[0];
      if (r && r.attempts >= MAX_ATTEMPTS) {
        await raiseException(tx, 'UNHANDLED_EVENT', r.event_id, null, { type: r.type, error: msg, attempts: r.attempts });
        await audit(tx, {}, 'payments.webhook_gave_up', { type: 'webhook_inbox', id: String(rowId) }, { error: msg });
      }
    });
    return 'FAILED';
  }
}

export async function processPendingWebhooks(db: Db, limit = 100) {
  const due = await db.query(`SELECT id FROM webhook_inbox WHERE status IN ('RECEIVED','FAILED') AND attempts < ${MAX_ATTEMPTS} AND next_attempt_at <= now() ORDER BY id LIMIT $1`, [limit]);
  const out: Record<string, number> = {};
  for (const r of due.rows) { const s = (await processInboxRow(db, r.id)) ?? 'SKIPPED'; out[s] = (out[s] ?? 0) + 1; }
  return out;
}
