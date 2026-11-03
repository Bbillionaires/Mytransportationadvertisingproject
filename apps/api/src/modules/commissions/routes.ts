import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { toCsv } from '../../lib/csv.js';
import type { Config } from '../../config.js';
import type { Db, Tx } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { sha256hex } from '../../lib/crypto.js';
import { conflict, forbidden, notFound, unauthorized, unprocessable, HttpError } from '../../lib/errors.js';
import { currency, minor, parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { authenticateDevice } from '../devices/routes.js';
import { tabletRider } from '../riders/routes.js';
import { postAllocation } from '../revenue/service.js';
import { postingDate } from '../payments/webhooks.js';
import { SYSTEM_USER_ID } from '../events/scheduler.js';
import { ATTRIBUTION_POLICY_VERSION, commissionFor, couponCode, offerApplies, withinWindow, type Offer } from './attribution.js';

const MAX_CODES_PER_DEVICE_CAMPAIGN_HOUR = 3;
const toOffer = (o: any): Offer => ({ ...o, valid_from: new Date(o.valid_from), valid_to: new Date(o.valid_to) });
const offerApi = (o: any) => ({ id: o.id, campaignId: o.campaign_id, name: o.name, kind: o.kind, rateBps: o.rate_bps, fixedMinor: o.fixed_minor === null ? null : String(o.fixed_minor),
  currency: o.currency.trim(), productSku: o.product_sku, couponEnabled: o.coupon_enabled, couponDescription: o.coupon_description, clickWindowHours: o.click_window_hours,
  couponWindowHours: o.coupon_window_hours, holdDays: o.hold_days, validFrom: o.valid_from, validTo: o.valid_to, status: o.status });

/** Advertiser server-to-server key: `Authorization: Bearer rmnk_<prefix>_<secret>`. Stored only as SHA-256. */
export async function authenticateKey(db: Db, req: FastifyRequest, scope: string) {
  const m = /^Bearer rmnk_([a-f0-9]{12})_([A-Za-z0-9_-]{40,})$/.exec(String(req.headers.authorization ?? ''));
  if (!m) throw unauthorized('integration API key required');
  const k = (await db.query(`SELECT k.*, o.status AS org_status FROM integration_keys k JOIN organizations o ON o.id = k.org_id WHERE k.prefix = $1`, [m[1]])).rows[0];
  if (!k || k.revoked_at || k.key_hash !== sha256hex(m[2]!) || k.org_status !== 'ACTIVE') throw unauthorized('invalid API key');
  if (!k.scopes.includes(scope)) throw forbidden(`key lacks scope ${scope}`);
  await db.query('UPDATE integration_keys SET last_used_at = now() WHERE id = $1', [k.id]);
  return { keyId: k.id as string, orgId: k.org_id as string };
}

async function findOffer(tx: Tx, campaignId: string, at: Date, sku: string | null, ccy: string) {
  const offers = (await tx.query('SELECT * FROM commission_offers WHERE campaign_id = $1 ORDER BY created_at DESC', [campaignId])).rows;
  for (const o of offers) if (offerApplies(toOffer(o), at, sku, ccy) === null) return o;
  return null;
}

export async function recordConversion(tx: Tx, orgId: string, keyId: string | null, b: { orderId: string; occurredAt: string; saleAmountMinor: bigint; currency: string; couponCode?: string; clickId?: string; productSku?: string }) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conv:${orgId}:${b.orderId}`]);
  const prior = (await tx.query('SELECT * FROM conversions WHERE advertiser_org_id = $1 AND order_id = $2', [orgId, b.orderId])).rows[0];
  if (prior) {
    if (BigInt(prior.sale_amount_minor) !== b.saleAmountMinor || prior.currency.trim() !== b.currency) throw conflict('order already reported with different values; report changes as refunds');
    return { conversion: prior, duplicate: true };
  }
  const at = new Date(b.occurredAt);
  if (at.getTime() > Date.now() + 5 * 60_000) throw unprocessable('occurredAt is in the future');
  const sku = b.productSku ?? null;
  const notes: string[] = [];
  let attr: { touch: 'COUPON' | 'CLICK'; offer: any; couponId?: string; clickEventId?: string; deviceId: string; driverId: string | null; creatorId: string | null; campaignId: string } | null = null;

  if (b.couponCode) {
    const c = (await tx.query(`SELECT cc.*, c.advertiser_org_id FROM coupon_codes cc JOIN campaigns c ON c.id = cc.campaign_id WHERE cc.code = $1 FOR UPDATE OF cc`, [b.couponCode.toUpperCase()])).rows[0];
    if (!c || c.advertiser_org_id !== orgId) notes.push('coupon code not issued for this advertiser');
    else if (c.redeemed_at) notes.push('coupon code already redeemed');
    else {
      const offer = (await tx.query('SELECT * FROM commission_offers WHERE id = $1', [c.offer_id])).rows[0];
      const why = withinWindow(new Date(c.issued_at), at, new Date(c.expires_at)) ?? offerApplies(toOffer(offer), new Date(c.issued_at), sku, b.currency);
      if (why) notes.push(`coupon: ${why}`);
      else attr = { touch: 'COUPON', offer, couponId: c.id, deviceId: c.device_id, driverId: c.driver_id, creatorId: c.creator_id, campaignId: c.campaign_id };
    }
  }
  if (!attr && b.clickId) {
    const clicks = (await tx.query(
      `SELECT v.* FROM validated_events v JOIN raw_events r ON r.id = v.raw_event_id JOIN campaigns c ON c.id = v.campaign_id
        WHERE r.event_id = $1 AND v.type = 'CLICK' AND c.advertiser_org_id = $2`, [b.clickId, orgId])).rows;
    if (clicks.length !== 1) notes.push(clicks.length ? 'click id is ambiguous' : 'click not found for this advertiser');
    else if (clicks[0].status !== 'VALID') notes.push(`click is ${clicks[0].status.toLowerCase()}`);
    else {
      const cl = clicks[0];
      const offer = await findOffer(tx, cl.campaign_id, new Date(cl.occurred_at), sku, b.currency);
      if (!offer) notes.push('no commission offer covered the click');
      else {
        const why = withinWindow(new Date(cl.occurred_at), at, new Date(new Date(cl.occurred_at).getTime() + offer.click_window_hours * 3_600_000));
        if (why) notes.push(`click: ${why}`);
        else attr = { touch: 'CLICK', offer, clickEventId: cl.id, deviceId: cl.device_id, driverId: cl.driver_id, creatorId: cl.creator_id, campaignId: cl.campaign_id };
      }
    }
  }
  if (!b.couponCode && !b.clickId) notes.push('no touchpoint supplied');

  const commission = attr ? commissionFor(toOffer(attr.offer), b.saleAmountMinor) : 0n;
  const ins = await tx.query(
    `INSERT INTO conversions (advertiser_org_id, order_id, offer_id, campaign_id, touch_type, click_event_id, coupon_code_id, device_id, driver_id, creator_id, currency,
       sale_amount_minor, commission_minor, product_sku, status, attribution_reason, occurred_at, allocatable_after, integration_key_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [orgId, b.orderId, attr?.offer.id ?? null, attr?.campaignId ?? null, attr?.touch ?? 'NONE', attr?.clickEventId ?? null, attr?.couponId ?? null, attr?.deviceId ?? null,
     attr?.driverId ?? null, attr?.creatorId ?? null, b.currency, b.saleAmountMinor.toString(), commission.toString(), sku, attr ? 'ATTRIBUTED' : 'UNATTRIBUTED',
     attr ? `${ATTRIBUTION_POLICY_VERSION}: ${attr.touch.toLowerCase()} within window` : `${ATTRIBUTION_POLICY_VERSION}: ${notes.join('; ')}`, at,
     attr ? new Date(at.getTime() + attr.offer.hold_days * 86_400_000) : null, keyId]);
  if (attr?.couponId) await tx.query('UPDATE coupon_codes SET redeemed_at = now() WHERE id = $1', [attr.couponId]);
  return { conversion: ins.rows[0], duplicate: false };
}

/**
 * Report a refund/cancellation of (part of) an order. Before the commission is allocated it is simply reduced.
 * After allocation, a CREDIT reversal request is created against the commission batch for a finance approver.
 */
export async function refundConversion(tx: Tx, orgId: string, b: { orderId: string; refundRef: string; saleAmountMinor: bigint }) {
  const c = (await tx.query('SELECT * FROM conversions WHERE advertiser_org_id = $1 AND order_id = $2 FOR UPDATE', [orgId, b.orderId])).rows[0];
  if (!c) throw notFound('order not found');
  const prior = (await tx.query('SELECT * FROM conversion_refunds WHERE conversion_id = $1 AND refund_ref = $2', [c.id, b.refundRef])).rows[0];
  if (prior) return { refund: prior, duplicate: true };
  const refunded = BigInt(c.refunded_sale_minor) + b.saleAmountMinor;
  if (refunded > BigInt(c.sale_amount_minor)) throw unprocessable('refunds exceed the sale amount');
  const offer = c.offer_id ? (await tx.query('SELECT * FROM commission_offers WHERE id = $1', [c.offer_id])).rows[0] : null;
  const newCommission = offer ? commissionFor(toOffer(offer), BigInt(c.sale_amount_minor) - refunded) : 0n;
  const reduction = BigInt(c.commission_minor) - newCommission;
  let journalRequestId: string | null = null;
  if (c.allocation_batch_id && reduction > 0n) {
    const jr = await tx.query(
      `INSERT INTO journal_requests (idempotency_key, requested_by, reason, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
      [`conv-refund:${c.id}:${b.refundRef}`, SYSTEM_USER_ID, `Advertiser reported refund ${b.refundRef} on order ${b.orderId}`,
       JSON.stringify({ kind: 'ALLOCATION_REVERSAL', batchId: c.allocation_batch_id, type: 'CREDIT', amount: reduction.toString(), entryDate: await postingDate(tx, new Date()), processor: null })]);
    journalRequestId = jr.rows[0].id;
  }
  const r = await tx.query(
    `INSERT INTO conversion_refunds (conversion_id, refund_ref, sale_amount_minor, commission_reduction_minor, journal_request_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [c.id, b.refundRef, b.saleAmountMinor.toString(), reduction.toString(), journalRequestId]);
  await tx.query(`UPDATE conversions SET refunded_sale_minor = $2, commission_minor = $3, status = CASE WHEN $2 = sale_amount_minor AND status = 'ATTRIBUTED' THEN 'FULLY_REFUNDED' ELSE status END WHERE id = $1`,
    [c.id, refunded.toString(), newCommission.toString()]);
  return { refund: r.rows[0], duplicate: false, reversalRequestId: journalRequestId };
}

/** Allocate commissions whose refund-hold period has passed: 15/10/75 with an eligible attributed creator, 15/0/85 without. */
export async function runCommissionAllocations(db: Db, opts: { now?: Date; actorUserId?: string } = {}) {
  const now = opts.now ?? new Date();
  const due = await db.query(
    `SELECT * FROM conversions WHERE status = 'ATTRIBUTED' AND allocation_batch_id IS NULL AND commission_minor > 0 AND allocatable_after <= $1 ORDER BY occurred_at LIMIT 500`, [now]);
  const results: Array<{ conversionId: string; status: string; batchId?: string; reason?: string }> = [];
  for (const c of due.rows) {
    try {
      const out = await withTx(db, async (tx) => {
        const locked = (await tx.query('SELECT allocation_batch_id, commission_minor FROM conversions WHERE id = $1 FOR UPDATE', [c.id])).rows[0];
        if (locked.allocation_batch_id) return { batchId: locked.allocation_batch_id };
        const commission = BigInt(locked.commission_minor);
        const occurred = new Date(c.occurred_at);
        const r = await postAllocation(tx, {
          idempotencyKey: `commission:${c.id}`, kind: 'SALES_COMMISSION', sourceRef: `conversion:${c.id}`, advertiserOrgId: c.advertiser_org_id, fundingAccount: '1100',
          currency: c.currency.trim(), periodStart: occurred.toISOString(), periodEnd: new Date(occurred.getTime() + 1000).toISOString(), entryDate: await postingDate(tx, now),
          grossReceipts: commission, taxCollected: 0n, refunds: 0n, credits: 0n, chargebacks: 0n, deductions: [],
          creators: c.creator_id ? [{ creatorId: c.creator_id, attributedRevenue: commission, verifiedWatchSeconds: 0n, qualifiedViews: 0n }] : [],
          drivers: c.driver_id ? [{ driverId: c.driver_id, monetizedAdDelivery: 1n, qualifiedEngagement: 0n, eligibleActiveSeconds: 0n }] : [],
        }, opts.actorUserId ?? SYSTEM_USER_ID);
        await tx.query('UPDATE conversions SET allocation_batch_id = $2 WHERE id = $1', [c.id, r.batchId]);
        await audit(tx, { userId: opts.actorUserId ?? SYSTEM_USER_ID }, 'finance.commission_allocated', { type: 'conversion', id: c.id, orgId: c.advertiser_org_id }, { batchId: r.batchId });
        return { batchId: r.batchId as string };
      });
      results.push({ conversionId: c.id, status: 'ALLOCATED', batchId: out.batchId });
    } catch (e) {
      results.push({ conversionId: c.id, status: 'SKIPPED', reason: e instanceof HttpError ? e.message : (e as Error).message.slice(0, 300) });
    }
  }
  return { allocated: results.filter((r) => r.status === 'ALLOCATED').length, skipped: results.filter((r) => r.status === 'SKIPPED').length, results };
}

const conversionApi = (c: any) => ({ id: c.id, orderId: c.order_id, status: c.status, touchType: c.touch_type, attributionReason: c.attribution_reason, campaignId: c.campaign_id,
  offerId: c.offer_id, currency: c.currency.trim(), saleAmountMinor: String(c.sale_amount_minor), refundedSaleMinor: String(c.refunded_sale_minor),
  commissionMinor: String(c.commission_minor), occurredAt: c.occurred_at, allocatableAfter: c.allocatable_after, allocated: !!c.allocation_batch_id });

export async function commissionRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const advertiserCampaign = async (orgId: string, id: string) => {
    const c = (await db.query(`SELECT * FROM campaigns WHERE id = $1 AND advertiser_org_id = $2`, [id, orgId])).rows[0];
    if (!c) throw notFound('campaign not found');
    return c;
  };

  // ---------- commission offers ----------
  app.post('/v1/orgs/:orgId/campaigns/:id/commission-offers', async (req, reply) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    const auth = await authorize(db, req, 'campaign.manage', orgId);
    const c = await advertiserCampaign(orgId, id);
    const b = parse(z.object({
      name: z.string().min(1).max(200), kind: z.enum(['PERCENT_OF_SALE', 'FIXED_PER_SALE']), rateBps: z.number().int().min(1).max(10000).optional(), fixedMinor: minor.optional(),
      productSku: z.string().min(1).max(100).optional(), couponEnabled: z.boolean().default(true), couponDescription: z.string().max(200).optional(),
      clickWindowHours: z.number().int().min(1).max(2160).default(168), couponWindowHours: z.number().int().min(1).max(2160).default(720), holdDays: z.number().int().min(0).max(120).default(14),
      validFrom: z.string().datetime(), validTo: z.string().datetime(),
    }).refine((v) => (v.kind === 'PERCENT_OF_SALE') === (v.rateBps !== undefined) && (v.kind === 'FIXED_PER_SALE') === (v.fixedMinor !== undefined), 'give rateBps for percentage offers or fixedMinor for fixed offers')
      .refine((v) => new Date(v.validTo) > new Date(v.validFrom), 'validTo must be after validFrom'), req.body);
    if (b.fixedMinor !== undefined && b.fixedMinor <= 0n) throw unprocessable('fixedMinor must be positive');
    const r = await withTx(db, async (tx) => {
      const o = await tx.query(
        `INSERT INTO commission_offers (campaign_id, advertiser_org_id, name, kind, rate_bps, fixed_minor, currency, product_sku, coupon_enabled, coupon_description,
           click_window_hours, coupon_window_hours, hold_days, valid_from, valid_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [id, orgId, b.name, b.kind, b.rateBps ?? null, b.fixedMinor?.toString() ?? null, c.currency, b.productSku ?? null, b.couponEnabled, b.couponDescription ?? null,
         b.clickWindowHours, b.couponWindowHours, b.holdDays, b.validFrom, b.validTo, auth.userId]);
      await audit(tx, actorOf(req), 'commission.offer_created', { type: 'commission_offer', id: o.rows[0].id, orgId }, { campaignId: id, kind: b.kind });
      return o.rows[0];
    });
    reply.code(201);
    return offerApi(r);
  });

  app.get('/v1/orgs/:orgId/campaigns/:id/commission-offers', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await authorize(db, req, 'campaign.read', orgId);
    await advertiserCampaign(orgId, id);
    return { items: (await db.query('SELECT * FROM commission_offers WHERE campaign_id = $1 ORDER BY created_at DESC', [id])).rows.map(offerApi) };
  });

  app.post('/v1/orgs/:orgId/commission-offers/:offerId/end', async (req) => {
    const { orgId, offerId } = parse(z.object({ orgId: uuid, offerId: uuid }), req.params);
    await authorize(db, req, 'campaign.manage', orgId);
    const r = await db.query(`UPDATE commission_offers SET status = 'ENDED', valid_to = LEAST(valid_to, now()) WHERE id = $1 AND advertiser_org_id = $2 RETURNING *`, [offerId, orgId]);
    if (!r.rows[0]) throw notFound('offer not found');
    await audit(db, actorOf(req), 'commission.offer_ended', { type: 'commission_offer', id: offerId, orgId });
    return offerApi(r.rows[0]);
  });

  // ---------- integration API keys ----------
  app.post('/v1/orgs/:orgId/integration-keys', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const auth = await authorize(db, req, 'integrations.manage', orgId);
    const b = parse(z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(['conversions:write', 'rewards:redeem'])).min(1).max(2).default(['conversions:write']) }), req.body);
    const prefix = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const k = await db.query(`INSERT INTO integration_keys (org_id, name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [orgId, b.name, prefix, sha256hex(secret), [...new Set(b.scopes)], auth.userId]);
    await audit(db, actorOf(req), 'integration.key_created', { type: 'integration_key', id: k.rows[0].id, orgId }, { name: b.name, prefix });
    reply.code(201);
    return { id: k.rows[0].id, key: `rmnk_${prefix}_${secret}`, scopes: [...new Set(b.scopes)], note: 'Shown once. Store it in your server-side secret manager.' };
  });

  app.get('/v1/orgs/:orgId/integration-keys', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'integrations.manage', orgId);
    return { items: (await db.query('SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM integration_keys WHERE org_id = $1 ORDER BY created_at DESC', [orgId])).rows };
  });

  app.post('/v1/orgs/:orgId/integration-keys/:keyId/revoke', async (req) => {
    const { orgId, keyId } = parse(z.object({ orgId: uuid, keyId: uuid }), req.params);
    await authorize(db, req, 'integrations.manage', orgId);
    const r = await db.query('UPDATE integration_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND org_id = $2 RETURNING id, revoked_at', [keyId, orgId]);
    if (!r.rows[0]) throw notFound('key not found');
    await audit(db, actorOf(req), 'integration.key_revoked', { type: 'integration_key', id: keyId, orgId });
    return r.rows[0];
  });

  // ---------- tablet: unique coupon / QR code ----------
  app.post('/v1/devices/coupons', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const dev = await authenticateDevice(db, config, req);
    const b = parse(z.object({ campaignId: uuid, creativeId: uuid, contentVideoId: uuid.optional() }), req.body);
    if (dev.status !== 'ACTIVE') throw forbidden('device is suspended');
    const rider = await tabletRider(db, req, dev.deviceId);
    const out = await withTx(db, async (tx) => {
      const a = (await tx.query(`SELECT driver_id FROM device_assignments WHERE device_id = $1 AND ends_at IS NULL`, [dev.deviceId])).rows[0];
      if (!a) throw forbidden('device is not assigned to a vehicle');
      const c = (await tx.query(`SELECT * FROM campaigns WHERE id = $1 AND status = 'APPROVED' AND starts_at <= now() AND ends_at > now()`, [b.campaignId])).rows[0];
      const cr = c && (await tx.query(`SELECT 1 FROM creatives WHERE id = $1 AND campaign_id = $2 AND status = 'APPROVED'`, [b.creativeId, b.campaignId])).rows[0];
      if (!c || !cr) throw notFound('campaign is not running');
      const offer = (await tx.query(`SELECT * FROM commission_offers WHERE campaign_id = $1 AND status = 'ACTIVE' AND coupon_enabled AND valid_from <= now() AND valid_to > now() ORDER BY created_at DESC LIMIT 1`, [b.campaignId])).rows[0];
      if (!offer) throw notFound('no coupon offer for this campaign');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coupon:${dev.deviceId}:${b.campaignId}`]);
      const n = (await tx.query(`SELECT count(*)::int n FROM coupon_codes WHERE device_id = $1 AND campaign_id = $2 AND issued_at > now() - interval '1 hour'`, [dev.deviceId, b.campaignId])).rows[0].n;
      if (n >= MAX_CODES_PER_DEVICE_CAMPAIGN_HOUR) throw conflict('coupon limit reached for this tablet; try again later');
      const video = b.contentVideoId ? (await tx.query(`SELECT id, creator_id FROM videos WHERE id = $1 AND status = 'APPROVED'`, [b.contentVideoId])).rows[0] : null;
      const expires = new Date(Math.min(Date.now() + offer.coupon_window_hours * 3_600_000, new Date(offer.valid_to).getTime() + offer.coupon_window_hours * 3_600_000));
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = couponCode(randomBytes(10));
        const r = await tx.query(
          `INSERT INTO coupon_codes (code, offer_id, campaign_id, device_id, driver_id, creator_id, video_id, expires_at, rider_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (code) DO NOTHING RETURNING code, expires_at`,
          [code, offer.id, b.campaignId, dev.deviceId, a.driver_id, video?.creator_id ?? null, video?.id ?? null, expires, rider?.id ?? null]);
        if (r.rows[0]) return { code: r.rows[0].code, expiresAt: r.rows[0].expires_at, description: offer.coupon_description, qrPayload: `RMNCOUPON:${r.rows[0].code}`, savedToWallet: !!rider };
      }
      throw conflict('could not allocate a unique code; retry');
    });
    reply.code(201);
    return out;
  });

  // ---------- advertiser conversion API (server-to-server) ----------
  app.post('/v1/conversions', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const key = await authenticateKey(db, req, 'conversions:write');
    const b = parse(z.object({
      orderId: z.string().min(1).max(200), occurredAt: z.string().datetime(), saleAmountMinor: minor, currency,
      couponCode: z.string().regex(/^[A-Za-z2-9]{10}$/).optional(), clickId: uuid.optional(), productSku: z.string().max(100).optional(),
    }), req.body);
    if (b.saleAmountMinor <= 0n) throw unprocessable('saleAmountMinor must be positive');
    const r = await withTx(db, (tx) => recordConversion(tx, key.orgId, key.keyId, b));
    if (!r.duplicate) await audit(db, { requestId: req.id }, 'conversion.reported', { type: 'conversion', id: r.conversion.id, orgId: key.orgId }, { status: r.conversion.status, keyId: key.keyId });
    reply.code(r.duplicate ? 200 : 201);
    return { ...conversionApi(r.conversion), duplicate: r.duplicate };
  });

  app.post('/v1/conversions/refunds', async (req, reply) => {
    const key = await authenticateKey(db, req, 'conversions:write');
    const b = parse(z.object({ orderId: z.string().min(1).max(200), refundRef: z.string().min(1).max(200), saleAmountMinor: minor }), req.body);
    if (b.saleAmountMinor <= 0n) throw unprocessable('saleAmountMinor must be positive');
    const r = await withTx(db, (tx) => refundConversion(tx, key.orgId, b));
    if (!r.duplicate) await audit(db, { requestId: req.id }, 'conversion.refunded', { type: 'conversion_refund', id: r.refund.id, orgId: key.orgId }, { reversalRequestId: r.reversalRequestId ?? null });
    reply.code(r.duplicate ? 200 : 201);
    return { refundId: r.refund.id, commissionReductionMinor: String(r.refund.commission_reduction_minor), reversalRequestId: r.reversalRequestId ?? null, duplicate: r.duplicate };
  });

  app.get('/v1/orgs/:orgId/conversions', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'campaign.read', orgId);
    const { format } = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
    const items = (await db.query('SELECT * FROM conversions WHERE advertiser_org_id = $1 ORDER BY occurred_at DESC LIMIT 500', [orgId])).rows.map(conversionApi);
    if (format === 'csv') return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="conversions.csv"').send(toCsv(items, ['occurredAt', 'orderId', 'status', 'touchType', 'attributionReason', 'campaignId', 'offerId', 'currency', 'saleAmountMinor', 'refundedSaleMinor', 'commissionMinor', 'allocatableAfter', 'allocated']));
    return { items };
  });

  app.post('/v1/finance/commissions/run', async (req) => {
    const auth = await authorize(db, req, 'finance.allocation.post');
    const r = await runCommissionAllocations(db, { actorUserId: auth.userId });
    await audit(db, actorOf(req), 'finance.commission_run', { type: 'scheduler' }, { allocated: r.allocated, skipped: r.skipped });
    return r;
  });
}
