import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { currency, minor, parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';
import { campaignMetrics } from '../events/aggregate.js';
import { isValidTimezone } from './schedule.js';
import { advertiserAvailableMilli, campaignSpend, nextPlayBlock } from './budget.js';

export const ALLOWED_CATEGORIES = ['GENERAL', 'FOOD_DRINK', 'RETAIL', 'ENTERTAINMENT', 'TRAVEL', 'LOCAL_SERVICES', 'AUTOMOTIVE', 'TECHNOLOGY', 'EDUCATION', 'HEALTH_WELLNESS', 'FINANCIAL_SERVICES', 'NONPROFIT'] as const;
/** Refused outright until legal sets jurisdiction-specific rules (DECISIONS.md D-031). */
export const RESTRICTED_CATEGORIES = ['ALCOHOL', 'CANNABIS', 'TOBACCO_VAPING', 'GAMBLING', 'FIREARMS', 'ADULT', 'POLITICAL', 'PRESCRIPTION_DRUGS', 'DATING', 'CRYPTO'] as const;

const httpsUrl = z.string().max(2000).refine((v) => {
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname && u.hostname !== 'localhost'; } catch { return false; }
}, 'must be an https URL without credentials');

const category = z.string().superRefine((v, c) => {
  if ((RESTRICTED_CATEGORIES as readonly string[]).includes(v)) c.addIssue({ code: 'custom', message: `${v} advertising is restricted and cannot be submitted` });
  else if (!(ALLOWED_CATEGORIES as readonly string[]).includes(v)) c.addIssue({ code: 'custom', message: `unknown category ${v}` });
});

const scheduleFields = {
  timezone: z.string().refine(isValidTimezone, 'unknown IANA time zone').default('UTC'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  startMinute: z.number().int().min(0).max(1439).default(0),
  endMinute: z.number().int().min(1).max(1440).default(1440),
};

const campaignCreate = z.object({
  name: z.string().min(1).max(200), category: category.default('GENERAL'), pricingModel: z.enum(['CPM', 'CPQV']), rateMinor: minor,
  currency: currency.default('USD'), startsAt: z.string().datetime(), endsAt: z.string().datetime(), destinationUrl: httpsUrl.optional(),
  markets: z.array(z.string().min(1).max(100)).max(50).default([]), frequencyCapPerHour: z.number().int().min(1).max(60).optional(),
  priority: z.number().int().min(1).max(10).default(5), skipDelaySeconds: z.number().int().min(0).max(60).default(5), ...scheduleFields,
  totalBudgetMinor: minor.optional(), dailyBudgetMinor: minor.optional(),
}).refine((v) => new Date(v.endsAt) > new Date(v.startsAt), 'endsAt must be after startsAt').refine((v) => v.startMinute !== v.endMinute, 'startMinute and endMinute must differ')
  .refine((v) => v.rateMinor > 0n, 'rateMinor must be positive')
  .refine((v) => (v.totalBudgetMinor ?? 1n) > 0n && (v.dailyBudgetMinor ?? 1n) > 0n, 'budgets must be positive');

const campaignPatch = z.object({
  name: z.string().min(1).max(200), category, pricingModel: z.enum(['CPM', 'CPQV']), rateMinor: minor, startsAt: z.string().datetime(), endsAt: z.string().datetime(),
  destinationUrl: httpsUrl.nullable(), markets: z.array(z.string().min(1).max(100)).max(50), frequencyCapPerHour: z.number().int().min(1).max(60).nullable(),
  priority: z.number().int().min(1).max(10), skipDelaySeconds: z.number().int().min(0).max(60),
  timezone: z.string().refine(isValidTimezone, 'unknown IANA time zone'), daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
  totalBudgetMinor: minor.nullable(), dailyBudgetMinor: minor.nullable(),
}).partial();

const COLUMN: Record<string, string> = {
  name: 'name', category: 'category', pricingModel: 'pricing_model', rateMinor: 'rate_minor', startsAt: 'starts_at', endsAt: 'ends_at', destinationUrl: 'destination_url',
  markets: 'markets', frequencyCapPerHour: 'frequency_cap_per_hour', priority: 'priority', skipDelaySeconds: 'skip_delay_seconds', timezone: 'timezone',
  daysOfWeek: 'days_of_week', startMinute: 'start_minute', endMinute: 'end_minute', totalBudgetMinor: 'total_budget_minor', dailyBudgetMinor: 'daily_budget_minor',
};

const creativeCreate = z.object({
  name: z.string().min(1).max(200), kind: z.enum(['VIDEO', 'BANNER', 'DISPLAY']),
  headline: z.string().min(1).max(90).optional(), bodyText: z.string().max(280).optional(), uploadId: uuid.optional(),
  destinationUrl: httpsUrl.optional(),
}).superRefine((v, c) => {
  if ((v.kind === 'VIDEO' || v.kind === 'DISPLAY') && !v.uploadId) c.addIssue({ code: 'custom', message: `${v.kind.toLowerCase()} creatives need a processed uploadId` });
  if (v.kind === 'BANNER' && !v.headline) c.addIssue({ code: 'custom', message: 'word/text banners need a headline' });
});

const toApi = (c: any) => c && ({
  id: c.id, advertiserOrgId: c.advertiser_org_id, name: c.name, status: c.status, category: c.category, pricingModel: c.pricing_model, rateMinor: String(c.rate_minor),
  currency: c.currency.trim(), startsAt: c.starts_at, endsAt: c.ends_at, destinationUrl: c.destination_url, markets: c.markets, frequencyCapPerHour: c.frequency_cap_per_hour,
  priority: c.priority, skipDelaySeconds: c.skip_delay_seconds, schedule: { timezone: c.timezone, daysOfWeek: c.days_of_week, startMinute: c.start_minute, endMinute: c.end_minute },
  totalBudgetMinor: c.total_budget_minor === null ? null : String(c.total_budget_minor), dailyBudgetMinor: c.daily_budget_minor === null ? null : String(c.daily_budget_minor),
  submittedAt: c.submitted_at, reviewedAt: c.reviewed_at, reviewNote: c.review_note, createdAt: c.created_at,
});
const creativeApi = (c: any) => ({ id: c.id, campaignId: c.campaign_id, name: c.name, kind: c.kind, status: c.status, durationMs: c.duration_ms, headline: c.headline,
  bodyText: c.body_text, mediaKey: c.media_key, destinationUrl: c.destination_url, reviewNote: c.review_note });

async function advertiserOrg(db: Db, orgId: string) {
  const org = await loadOrg(db, orgId);
  if (org.kind !== 'ADVERTISER') throw notFound('advertiser not found');
  return org;
}

async function ownedCampaign(q: Queryable, orgId: string, id: string, lock = false) {
  const r = await q.query(`SELECT * FROM campaigns WHERE id = $1 AND advertiser_org_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, orgId]);
  if (!r.rows[0]) throw notFound('campaign not found');
  return r.rows[0];
}

export async function campaignRoutes(app: FastifyInstance, { db }: { db: Db }) {
  // ---------- advertiser self-registration ----------
  app.post('/v1/advertisers/register', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({ organizationName: z.string().min(2).max(200), email: z.string().email(), displayName: z.string().min(1).max(200), password: z.string().min(12).max(200) }), req.body);
    const out = await withTx(db, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM users WHERE email = $1', [b.email]);
      if (exists.rows[0]) throw conflict('registration could not be completed with this email');
      const org = await tx.query(`INSERT INTO organizations (kind, name) VALUES ('ADVERTISER', $1) RETURNING id`, [b.organizationName]);
      const u = await tx.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [b.email, await hashPassword(b.password), b.displayName]);
      await tx.query(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'advertiser_admin')`, [u.rows[0].id, org.rows[0].id]);
      await audit(tx, { userId: u.rows[0].id, requestId: req.id }, 'advertiser.self_registered', { type: 'organization', id: org.rows[0].id, orgId: org.rows[0].id }, { name: b.organizationName });
      return { organizationId: org.rows[0].id, userId: u.rows[0].id };
    });
    reply.code(201);
    return { ...out, note: 'Campaigns require platform review before they can run. Fund your prepaid balance to start delivery.' };
  });

  // ---------- advertiser campaigns ----------
  app.get('/v1/orgs/:orgId/campaigns', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.read', orgId);
    const r = await db.query('SELECT * FROM campaigns WHERE advertiser_org_id = $1 ORDER BY created_at DESC', [orgId]);
    return { items: r.rows.map(toApi) };
  });

  app.post('/v1/orgs/:orgId/campaigns', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await advertiserOrg(db, orgId);
    const auth = await authorize(db, req, 'campaign.manage', orgId);
    const b = parse(campaignCreate, req.body);
    const r = await withTx(db, async (tx) => {
      const c = await tx.query(
        `INSERT INTO campaigns (advertiser_org_id, name, category, pricing_model, rate_minor, currency, starts_at, ends_at, destination_url, markets, frequency_cap_per_hour,
           priority, skip_delay_seconds, timezone, days_of_week, start_minute, end_minute, created_by, total_budget_minor, daily_budget_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [orgId, b.name, b.category, b.pricingModel, b.rateMinor.toString(), b.currency, b.startsAt, b.endsAt, b.destinationUrl ?? null, b.markets, b.frequencyCapPerHour ?? null,
         b.priority, b.skipDelaySeconds, b.timezone, [...new Set(b.daysOfWeek)].sort(), b.startMinute, b.endMinute, auth.userId,
         b.totalBudgetMinor?.toString() ?? null, b.dailyBudgetMinor?.toString() ?? null]);
      await audit(tx, actorOf(req), 'campaign.created', { type: 'campaign', id: c.rows[0].id, orgId }, { name: b.name });
      return c.rows[0];
    });
    reply.code(201);
    return toApi(r);
  });

  app.get('/v1/orgs/:orgId/campaigns/:id', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.read', orgId);
    const c = await ownedCampaign(db, orgId, id);
    const cr = await db.query('SELECT * FROM creatives WHERE campaign_id = $1 ORDER BY created_at', [id]);
    return { ...toApi(c), creatives: cr.rows.map(creativeApi) };
  });

  /** Drafts and rejected campaigns are fully editable; once submitted, billing and delivery terms are frozen (DB trigger). */
  app.patch('/v1/orgs/:orgId/campaigns/:id', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.manage', orgId);
    const b = parse(campaignPatch, req.body);
    if (b.category !== undefined) parse(z.object({ c: category }), { c: b.category });
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (!keys.length) throw unprocessable('nothing to update');
    return withTx(db, async (tx) => {
      await ownedCampaign(tx, orgId, id, true);
      if ((b.totalBudgetMinor ?? 1n) <= 0n || (b.dailyBudgetMinor ?? 1n) <= 0n) throw unprocessable('budgets must be positive');
      const vals = keys.map((k) => { const v = b[k]; return typeof v === 'bigint' ? v.toString() : k === 'daysOfWeek' ? [...new Set(v as number[])].sort() : v; });
      const set = keys.map((k, i) => `${COLUMN[k]} = $${i + 3}`).join(', ');
      const u = await tx.query(`UPDATE campaigns SET ${set} WHERE id = $1 AND advertiser_org_id = $2 RETURNING *`, [id, orgId, ...vals]);
      const c = u.rows[0];
      if (new Date(c.ends_at) <= new Date(c.starts_at) || c.start_minute === c.end_minute) throw unprocessable('invalid dates or schedule');
      await audit(tx, actorOf(req), 'campaign.updated', { type: 'campaign', id, orgId }, { fields: keys });
      return toApi(c);
    });
  });

  app.post('/v1/orgs/:orgId/campaigns/:id/creatives', async (req, reply) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.manage', orgId);
    const b = parse(creativeCreate, req.body);
    const r = await withTx(db, async (tx) => {
      const c = await ownedCampaign(tx, orgId, id, true);
      if (c.status === 'ENDED') throw conflict('campaign has ended');
      // Duration and media come from the processed asset (ffprobe), never from the advertiser's claim.
      let asset: any = null;
      if (b.uploadId) {
        asset = (await tx.query(`SELECT a.* FROM media_assets a JOIN media_uploads u ON u.id = a.upload_id WHERE u.id = $1 AND u.org_id = $2 AND u.status = 'READY'`, [b.uploadId, orgId])).rows[0];
        if (!asset) throw unprocessable('upload not found or not processed yet');
        if ((b.kind === 'VIDEO') !== (asset.kind === 'VIDEO')) throw unprocessable(`a ${b.kind} creative needs ${b.kind === 'VIDEO' ? 'a video' : 'an image'} upload`);
      }
      const cr = await tx.query(
        `INSERT INTO creatives (campaign_id, name, kind, duration_ms, headline, body_text, media_key, destination_url, asset_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, b.name, b.kind, asset?.duration_ms ?? null, b.headline ?? null, b.bodyText ?? null, asset?.rendition_key ?? null, b.destinationUrl ?? null, asset?.id ?? null]);
      await audit(tx, actorOf(req), 'creative.created', { type: 'creative', id: cr.rows[0].id, orgId }, { campaignId: id, kind: b.kind });
      return cr.rows[0];
    });
    reply.code(201);
    return creativeApi(r);
  });

  const transition = (action: 'submit' | 'pause' | 'resume' | 'end', to: string) =>
    app.post(`/v1/orgs/:orgId/campaigns/:id/${action}`, async (req) => {
      const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
      await advertiserOrg(db, orgId);
      await authorize(db, req, 'campaign.manage', orgId);
      return withTx(db, async (tx) => {
        const c = await ownedCampaign(tx, orgId, id, true);
        if (action === 'submit') {
          const n = await tx.query(`SELECT count(*)::int n FROM creatives WHERE campaign_id = $1 AND status <> 'REJECTED'`, [id]);
          if (n.rows[0].n === 0) throw unprocessable('add at least one creative before submitting');
          if (new Date(c.ends_at) <= new Date()) throw unprocessable('campaign end date has passed');
        }
        const u = await tx.query(
          `UPDATE campaigns SET status = $3, submitted_at = CASE WHEN $3 = 'PENDING_REVIEW' THEN now() ELSE submitted_at END,
              ends_at = CASE WHEN $3 = 'ENDED' AND ends_at > now() AND status IN ('APPROVED','PAUSED') THEN now() ELSE ends_at END
            WHERE id = $1 AND advertiser_org_id = $2 RETURNING *`, [id, orgId, to]);
        await audit(tx, actorOf(req), `campaign.${action}`, { type: 'campaign', id, orgId }, { from: c.status, to });
        return toApi(u.rows[0]);
      });
    });
  transition('submit', 'PENDING_REVIEW');
  transition('pause', 'PAUSED');
  transition('resume', 'APPROVED');
  transition('end', 'ENDED');

  app.get('/v1/orgs/:orgId/campaigns/:id/metrics', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.read', orgId);
    await ownedCampaign(db, orgId, id);
    const q = parse(z.object({ from: z.string().datetime(), to: z.string().datetime() }), req.query);
    return campaignMetrics(db, id, q.from, q.to);
  });

  /** Live committed spend (valid + held billable plays) against budgets, and whether delivery is currently allowed. */
  app.get('/v1/orgs/:orgId/campaigns/:id/spend', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.read', orgId);
    const c = await ownedCampaign(db, orgId, id);
    const now = new Date();
    const s = (await campaignSpend(db, [id], now)).get(id)!;
    const available = await advertiserAvailableMilli(db, orgId, c.currency.trim(), now);
    const minorStr = (m: bigint) => (m / 1000n).toString();
    const remaining = c.total_budget_minor === null ? null : BigInt(c.total_budget_minor) * 1000n - s.spendMilli;
    return {
      campaignId: id, currency: c.currency.trim(), spent: minorStr(s.spendMilli), spentToday: minorStr(s.todayMilli), unbilled: minorStr(s.unallocatedMilli),
      spentMilliMinor: s.spendMilli.toString(), totalBudget: c.total_budget_minor === null ? null : String(c.total_budget_minor),
      dailyBudget: c.daily_budget_minor === null ? null : String(c.daily_budget_minor), remainingBudget: remaining === null ? null : minorStr(remaining),
      deliveryBlockedBy: c.status === 'APPROVED' ? nextPlayBlock(c, s, available) : `CAMPAIGN_${c.status}`,
    };
  });

  /** Remaining prepaid balance, open refunds and allocated spend, straight from the ledger. */
  app.get('/v1/orgs/:orgId/balance', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await advertiserOrg(db, orgId);
    await authorize(db, req, 'campaign.read', orgId);
    const r = await db.query(
      `SELECT account_code, currency, balance::text FROM ledger_balances WHERE party_type = 'ADVERTISER' AND party_id = $1 AND account_code IN ('2000','2600','1100')`, [orgId]);
    const byCcy: Record<string, { prepaidBalance: string; refundsPending: string; commissionsOwed: string }> = {};
    for (const x of r.rows) {
      const e = (byCcy[x.currency] ??= { prepaidBalance: '0', refundsPending: '0', commissionsOwed: '0' });
      if (x.account_code === '2000') e.prepaidBalance = x.balance;
      if (x.account_code === '2600') e.refundsPending = x.balance;
      if (x.account_code === '1100') e.commissionsOwed = x.balance;
    }
    const now = new Date();
    for (const [ccy, e] of Object.entries(byCcy)) {
      const avail = await advertiserAvailableMilli(db, orgId, ccy, now);
      Object.assign(e, { committedUnbilled: ((BigInt(e.prepaidBalance) * 1000n - avail) / 1000n).toString(), available: (avail / 1000n).toString() });
    }
    return { balances: byCcy };
  });

  // ---------- platform review ----------
  app.get('/v1/review/campaigns', async (req) => {
    await authorize(db, req, 'campaign.review');
    const c = await db.query(`SELECT c.*, o.name AS advertiser_name FROM campaigns c JOIN organizations o ON o.id = c.advertiser_org_id WHERE c.status = 'PENDING_REVIEW' ORDER BY c.submitted_at`);
    const cr = await db.query(
      `SELECT cr.*, (SELECT json_build_object('recommendation', ai_recommendation, 'priority', priority, 'scores', scores, 'findings', findings)
                       FROM moderation_cases mc WHERE mc.asset_id = cr.asset_id ORDER BY created_at DESC LIMIT 1) AS ai
         FROM creatives cr WHERE campaign_id = ANY($1::uuid[]) ORDER BY created_at`, [c.rows.map((x) => x.id)]);
    const pendingCreatives = await db.query(
      `SELECT cr.* FROM creatives cr JOIN campaigns c ON c.id = cr.campaign_id WHERE cr.status = 'PENDING_REVIEW' AND c.status IN ('APPROVED','PAUSED') ORDER BY cr.created_at`);
    return {
      campaigns: c.rows.map((x) => ({ ...toApi(x), advertiserName: x.advertiser_name, creatives: cr.rows.filter((k) => k.campaign_id === x.id).map((k) => ({ ...creativeApi(k), aiPrescreen: k.ai })) })),
      creativesOnLiveCampaigns: pendingCreatives.rows.map(creativeApi),
    };
  });

  /** Approve or reject a submitted campaign together with its pending creatives. */
  app.post('/v1/review/campaigns/:id/decision', async (req) => {
    const auth = await authorize(db, req, 'campaign.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({
      decision: z.enum(['APPROVE', 'REJECT']), note: z.string().min(5).max(2000),
      creatives: z.array(z.object({ creativeId: uuid, decision: z.enum(['APPROVE', 'REJECT']), note: z.string().max(1000).optional() })).default([]),
    }), req.body);
    return withTx(db, async (tx) => {
      const c = (await tx.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!c) throw notFound('campaign not found');
      if (c.status !== 'PENDING_REVIEW') throw conflict(`campaign is ${c.status}, not awaiting review`);
      const member = await tx.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'ACTIVE'`, [auth.userId, c.advertiser_org_id]);
      if (member.rows[0]) throw conflict('reviewers cannot approve campaigns of an organization they belong to');
      const pending = (await tx.query(`SELECT id FROM creatives WHERE campaign_id = $1 AND status = 'PENDING_REVIEW'`, [id])).rows.map((r) => r.id as string);
      for (const d of b.creatives) {
        if (!pending.includes(d.creativeId)) throw unprocessable(`creative ${d.creativeId} is not pending review on this campaign`);
        await tx.query(`UPDATE creatives SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
          [d.creativeId, d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', auth.userId, d.note ?? null]);
        // The campaign reviewer's decision is the human decision on the creative's media moderation case.
        await tx.query(
          `UPDATE moderation_cases SET status = 'DECIDED', decision = $2, decision_note = $3, decided_by = $4, decided_at = now()
            WHERE status = 'OPEN' AND asset_id = (SELECT asset_id FROM creatives WHERE id = $1)`,
          [d.creativeId, d.decision, d.note ?? `campaign ${id} review`, auth.userId]);
      }
      if (b.decision === 'APPROVE') {
        const undecided = pending.filter((p) => !b.creatives.some((d) => d.creativeId === p));
        if (undecided.length) throw unprocessable(`decide every pending creative before approving (${undecided.length} undecided)`);
        const ok = await tx.query(`SELECT count(*)::int n FROM creatives WHERE campaign_id = $1 AND status = 'APPROVED'`, [id]);
        if (ok.rows[0].n === 0) throw unprocessable('a campaign needs at least one approved creative');
      }
      const u = await tx.query(`UPDATE campaigns SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1 RETURNING *`,
        [id, b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', auth.userId, b.note]);
      await audit(tx, actorOf(req), `campaign.review_${b.decision.toLowerCase()}`, { type: 'campaign', id, orgId: c.advertiser_org_id }, { note: b.note, creatives: b.creatives });
      return toApi(u.rows[0]);
    });
  });

  /** Review a creative added to an already-approved campaign, or withdraw an approved one. */
  app.post('/v1/review/creatives/:id/decision', async (req) => {
    const auth = await authorize(db, req, 'campaign.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().min(5).max(1000) }), req.body);
    return withTx(db, async (tx) => {
      const cr = (await tx.query('SELECT cr.*, c.advertiser_org_id FROM creatives cr JOIN campaigns c ON c.id = cr.campaign_id WHERE cr.id = $1 FOR UPDATE OF cr', [id])).rows[0];
      if (!cr) throw notFound('creative not found');
      if (b.decision === 'APPROVE' && cr.status !== 'PENDING_REVIEW') throw conflict('only pending creatives can be approved');
      const u = await tx.query(`UPDATE creatives SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1 RETURNING *`,
        [id, b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', auth.userId, b.note]);
      await audit(tx, actorOf(req), `creative.review_${b.decision.toLowerCase()}`, { type: 'creative', id, orgId: cr.advertiser_org_id }, { note: b.note });
      return creativeApi(u.rows[0]);
    });
  });
}
