import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize, requireAuth } from '../../auth/context.js';
import { authenticateDevice } from '../devices/routes.js';
import { isScheduleActive } from '../campaigns/schedule.js';
import { advertiserAvailableMilli, campaignSpend, nextPlayBlock } from '../campaigns/budget.js';
import { screenText } from '../media/moderation.js';
import { authenticateKey } from '../commissions/routes.js';
import { couponCode } from '../commissions/attribution.js';
import { distanceMeters, eligibleFences, PROXIMITY_POLICY, proximityRandom, shouldShow } from './proximity.js';
import { tabletRider } from './routes.js';

export const GAME_POLICY_VERSION = 'GAME_POLICY_V1';

export async function engagementRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const ownCampaign = async (orgId: string, id: string) => {
    const c = (await db.query('SELECT * FROM campaigns WHERE id = $1 AND advertiser_org_id = $2', [id, orgId])).rows[0];
    if (!c) throw notFound('campaign not found');
    return c;
  };

  // ================= geofences (advertiser) =================
  app.post('/v1/orgs/:orgId/campaigns/:id/geofences', async (req, reply) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    const auth = await authorize(db, req, 'campaign.manage', orgId);
    await ownCampaign(orgId, id);
    const b = parse(z.object({
      name: z.string().min(1).max(80), message: z.string().min(1).max(120), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
      radiusM: z.number().int().min(50).max(2000), dailyCapPerDevice: z.number().int().min(1).max(10).default(2), cooldownMinutes: z.number().int().min(5).max(1440).default(30),
    }), req.body);
    const screen = screenText([b.name, b.message]);
    if (Object.values(screen.scores ?? {}).some((v) => (v ?? 0) > 0)) throw unprocessable(`alert text fails the family-friendly screen (${(screen.notes ?? []).join('; ')})`);
    const g = await db.query(
      `INSERT INTO geofences (campaign_id, advertiser_org_id, name, message, latitude, longitude, radius_m, daily_cap_per_device, cooldown_minutes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, orgId, b.name, b.message, b.latitude, b.longitude, b.radiusM, b.dailyCapPerDevice, b.cooldownMinutes, auth.userId]);
    await audit(db, actorOf(req), 'geofence.created', { type: 'geofence', id: g.rows[0].id, orgId }, { campaignId: id, radiusM: b.radiusM });
    reply.code(201);
    return g.rows[0];
  });

  app.get('/v1/orgs/:orgId/campaigns/:id/geofences', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    await authorize(db, req, 'campaign.read', orgId);
    await ownCampaign(orgId, id);
    const r = await db.query(
      `SELECT g.id, g.name, g.message, g.latitude, g.longitude, g.radius_m, g.daily_cap_per_device, g.cooldown_minutes, g.status,
              count(a.id) AS alerts_issued, count(a.id) FILTER (WHERE a.outcome = 'OPENED') AS opened, count(a.id) FILTER (WHERE a.outcome = 'CLAIMED') AS claimed,
              count(a.id) FILTER (WHERE a.outcome = 'DISMISSED') AS dismissed
         FROM geofences g LEFT JOIN geofence_alerts a ON a.geofence_id = g.id WHERE g.campaign_id = $1 GROUP BY g.id ORDER BY g.created_at`, [id]);
    return { items: r.rows };
  });

  for (const [action, status] of [['pause', 'PAUSED'], ['resume', 'ACTIVE']] as const) {
    app.post(`/v1/orgs/:orgId/geofences/:gid/${action}`, async (req) => {
      const { orgId, gid } = parse(z.object({ orgId: uuid, gid: uuid }), req.params);
      await authorize(db, req, 'campaign.manage', orgId);
      const r = await db.query(`UPDATE geofences SET status = $3 WHERE id = $1 AND advertiser_org_id = $2 RETURNING id, status`, [gid, orgId, status]);
      if (!r.rows[0]) throw notFound('geofence not found');
      return r.rows[0];
    });
  }

  // ================= proximity engine (tablet) =================
  /**
   * The tablet reports its current position; the server returns at most one alert. Coordinates are used only to compute
   * distances in memory and are never stored or logged. Only the issued alert (device, geofence, time) is recorded.
   */
  app.post('/v1/devices/proximity', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const b = parse(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), speedMps: z.number().min(0).max(100).optional() }), req.body);
    if (dev.status !== 'ACTIVE') return { alert: null, reason: 'DEVICE_SUSPENDED' };
    const now = new Date();
    const a = (await db.query(`SELECT f.market FROM device_assignments da JOIN vehicles v ON v.id = da.vehicle_id JOIN fleets f ON f.id = v.fleet_id WHERE da.device_id = $1 AND da.ends_at IS NULL`, [dev.deviceId])).rows[0];
    if (!a) return { alert: null, reason: 'NOT_ASSIGNED' };
    const dLat = 2000 / 111_320, dLon = 2000 / (111_320 * Math.max(0.01, Math.cos((b.latitude * Math.PI) / 180)));
    const fences = (await db.query(
      `SELECT g.*, c.timezone, c.days_of_week, c.start_minute, c.end_minute, c.markets, c.pricing_model, c.rate_minor, c.total_budget_minor, c.daily_budget_minor,
              c.advertiser_org_id AS adv, c.currency,
              (SELECT max(issued_at) FROM geofence_alerts x WHERE x.geofence_id = g.id AND x.device_id = $5) AS last_alert,
              (SELECT count(*) FROM geofence_alerts x WHERE x.geofence_id = g.id AND x.device_id = $5 AND x.issued_at >= date_trunc('day', now())) AS today
         FROM geofences g JOIN campaigns c ON c.id = g.campaign_id
        WHERE g.status = 'ACTIVE' AND c.status = 'APPROVED' AND c.starts_at <= now() AND c.ends_at > now()
          AND g.latitude BETWEEN $1 AND $2 AND g.longitude BETWEEN $3 AND $4`,
      [b.latitude - dLat, b.latitude + dLat, b.longitude - dLon, b.longitude + dLon, dev.deviceId])).rows
      .filter((g) => (g.markets.length === 0 || g.markets.includes(a.market)) && isScheduleActive({ timezone: g.timezone, daysOfWeek: g.days_of_week, startMinute: g.start_minute, endMinute: g.end_minute }, now));
    const live = [];
    for (const g of fences) {
      const spend = (await campaignSpend(db, [g.campaign_id], now)).get(g.campaign_id)!;
      if (nextPlayBlock(g, spend, await advertiserAvailableMilli(db, g.adv, g.currency.trim(), now)) === null) live.push(g);
    }
    const last = (await db.query(`SELECT max(issued_at) AS t FROM geofence_alerts WHERE device_id = $1`, [dev.deviceId])).rows[0].t;
    const { eligible, reason } = eligibleFences(live.map((g) => ({
      id: g.id, distanceM: distanceMeters(b.latitude, b.longitude, g.latitude, g.longitude), radiusM: g.radius_m, lastAlertAt: g.last_alert,
      cooldownMinutes: g.cooldown_minutes, todayCount: Number(g.today), dailyCap: g.daily_cap_per_device,
    })), now, b.speedMps ?? null, last);
    if (!eligible.length) return { alert: null, reason };
    if (!shouldShow(proximityRandom())) return { alert: null, reason: 'RANDOMIZED_SKIP' };
    const chosen = live.find((g) => g.id === eligible[0]!.id)!;
    const coupon = (await db.query(`SELECT coupon_description FROM commission_offers WHERE campaign_id = $1 AND status = 'ACTIVE' AND coupon_enabled AND valid_from <= now() AND valid_to > now() LIMIT 1`, [chosen.campaign_id])).rows[0];
    const ins = await db.query(`INSERT INTO geofence_alerts (geofence_id, campaign_id, device_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4)) RETURNING id, expires_at`,
      [chosen.id, chosen.campaign_id, dev.deviceId, PROXIMITY_POLICY.alertTtlSeconds]);
    return {
      alert: { alertId: ins.rows[0].id, campaignId: chosen.campaign_id, title: chosen.name, message: chosen.message, context: 'Near your route',
        coupon: coupon ? { description: coupon.coupon_description } : null, expiresAt: ins.rows[0].expires_at, sound: false, audience: 'PASSENGER_ONLY' },
    };
  });

  app.post('/v1/devices/proximity/alerts/:id/outcome', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { outcome } = parse(z.object({ outcome: z.enum(['SHOWN', 'OPENED', 'CLAIMED', 'DISMISSED', 'EXPIRED']) }), req.body);
    const r = await db.query(`UPDATE geofence_alerts SET outcome = $3, outcome_at = now() WHERE id = $1 AND device_id = $2 AND expires_at > now() - interval '10 minutes' RETURNING id, outcome`, [id, dev.deviceId, outcome]);
    if (!r.rows[0]) throw notFound('alert not found');
    return r.rows[0];
  });

  /** Game catalog for business users choosing a game for a sponsored reward. */
  app.get('/v1/games', async (req) => {
    requireAuth(req);
    return { items: (await db.query(`SELECT slug, name, kind FROM games WHERE status = 'ACTIVE' AND (NOT chance_based OR legal_approval_ref IS NOT NULL) ORDER BY name`)).rows };
  });

  // ================= games (tablet) =================
  app.get('/v1/devices/games', async (req) => {
    await authenticateDevice(db, config, req);
    const g = await db.query(`SELECT slug, name, kind FROM games WHERE status = 'ACTIVE' AND (NOT chance_based OR legal_approval_ref IS NOT NULL) ORDER BY name`);
    const rewards = await db.query(`SELECT p.id, p.reward_description, o.name AS sponsor, g.slug AS game FROM reward_programs p JOIN organizations o ON o.id = p.advertiser_org_id LEFT JOIN games g ON g.id = p.game_id
                                     WHERE p.status = 'ACTIVE' AND p.starts_at <= now() AND p.ends_at > now()`);
    return { games: g.rows, sponsoredRewards: rewards.rows, rules: 'Skill games. No purchase or payment. Rewards need a signed-in rider account (18+).' };
  });

  app.post('/v1/devices/games/:slug/sessions', async (req, reply) => {
    const dev = await authenticateDevice(db, config, req);
    if (dev.status !== 'ACTIVE') throw forbidden('device is suspended');
    const { slug } = parse(z.object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/) }), req.params);
    const rider = await tabletRider(db, req, dev.deviceId);
    const game = (await db.query(`SELECT * FROM games WHERE slug = $1 AND status = 'ACTIVE' AND (NOT chance_based OR legal_approval_ref IS NOT NULL)`, [slug])).rows[0];
    if (!game) throw notFound('game not found');
    const s = await db.query(`INSERT INTO game_sessions (game_id, device_id, rider_id) VALUES ($1,$2,$3) RETURNING id, started_at`, [game.id, dev.deviceId, rider?.id ?? null]);
    reply.code(201);
    const questions = game.kind === 'TRIVIA' ? (game.config.questions as any[]).map((q, i) => ({ index: i, q: q.q, options: q.options })) : undefined;
    return { sessionId: s.rows[0].id, game: { slug: game.slug, kind: game.kind }, questions, mode: rider ? 'SIGNED_IN' : 'GUEST' };
  });

  /**
   * Completion. Duration is measured by the server (start to completion), never trusted from the tablet; trivia is
   * scored server-side. A plausible session by a signed-in adult rider may earn one sponsor reward within the program's caps.
   */
  app.post('/v1/devices/games/sessions/:id/complete', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ score: z.number().int().min(0).max(1_000_000).optional(), answers: z.array(z.number().int().min(0).max(10)).max(50).optional() }), req.body);
    return withTx(db, async (tx) => {
      const s = (await tx.query(`SELECT s.*, g.kind, g.config FROM game_sessions s JOIN games g ON g.id = s.game_id WHERE s.id = $1 AND s.device_id = $2 FOR UPDATE OF s`, [id, dev.deviceId])).rows[0];
      if (!s) throw notFound('session not found');
      if (s.completed_at) throw conflict('session already completed');
      const elapsed = Date.now() - new Date(s.started_at).getTime();
      let score: number; const details: Record<string, unknown> = { elapsedMs: elapsed, policy: GAME_POLICY_VERSION };
      if (s.kind === 'TRIVIA') {
        const qs = s.config.questions as Array<{ answer: number }>;
        score = (b.answers ?? []).reduce((acc, a, i) => acc + (qs[i] && qs[i]!.answer === a ? 1 : 0), 0);
      } else score = b.score ?? 0;
      let verdict = 'ACCEPTED';
      if (elapsed < (s.config.minDurationMs ?? 0)) { verdict = 'REJECTED_IMPLAUSIBLE'; details.reason = 'completed faster than humanly plausible'; }
      if (s.kind !== 'TRIVIA' && score > (s.config.maxScore ?? Infinity)) { verdict = 'REJECTED_IMPLAUSIBLE'; details.reason = 'score above the game maximum'; }
      if (elapsed > 60 * 60_000) { verdict = 'EXPIRED'; details.reason = 'session older than one hour'; }
      await tx.query(`UPDATE game_sessions SET completed_at = now(), score = $2, verdict = $3, details = $4 WHERE id = $1`, [id, score, verdict, JSON.stringify(details)]);

      let reward: unknown = null;
      // Rewards only for the rider who started the session and is still signed in on this tablet.
      const rider = verdict === 'ACCEPTED' && s.rider_id ? await tabletRider(tx, req, dev.deviceId).catch(() => null) : null;
      if (rider && rider.id === s.rider_id) {
        const p = (await tx.query(
          `SELECT p.* FROM reward_programs p WHERE p.status = 'ACTIVE' AND p.starts_at <= now() AND p.ends_at > now() AND (p.game_id IS NULL OR p.game_id = $1) AND p.min_score <= $2
              AND (SELECT count(*) FROM reward_grants g WHERE g.program_id = p.id) < p.total_quantity
              AND (SELECT count(*) FROM reward_grants g WHERE g.program_id = p.id AND g.rider_id = $3 AND g.issued_at >= date_trunc('day', now())) < p.per_rider_per_day
            ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [s.game_id, score, rider.id])).rows[0];
        if (p) {
          const left = (await tx.query('SELECT count(*)::int n FROM reward_grants WHERE program_id = $1', [p.id])).rows[0].n;
          if (left < p.total_quantity) {
            const code = couponCode(randomBytes(10));
            const g = await tx.query(`INSERT INTO reward_grants (program_id, rider_id, game_session_id, code, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING code, expires_at`,
              [p.id, rider.id, id, code, p.valid_days]);
            reward = { description: p.reward_description, code: g.rows[0].code, expiresAt: g.rows[0].expires_at, savedToWallet: true };
          }
        }
      }
      return { score, verdict, reward, guest: !s.rider_id };
    });
  });

  // ================= reward programs (advertiser) =================
  app.post('/v1/orgs/:orgId/reward-programs', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const auth = await authorize(db, req, 'campaign.manage', orgId);
    const b = parse(z.object({
      name: z.string().min(1).max(100), rewardDescription: z.string().min(3).max(140), faceValueMinor: z.coerce.number().int().min(0).max(100_000),
      totalQuantity: z.number().int().min(1).max(1_000_000), minScore: z.number().int().min(0).default(1), perRiderPerDay: z.number().int().min(1).max(5).default(1),
      validDays: z.number().int().min(1).max(365).default(30), gameSlug: z.string().optional(), campaignId: uuid.optional(),
      startsAt: z.string().datetime(), endsAt: z.string().datetime(),
    }), req.body);
    if (new Date(b.endsAt) <= new Date(b.startsAt)) throw unprocessable('endsAt must be after startsAt');
    const screen = screenText([b.name, b.rewardDescription]);
    if (Object.values(screen.scores ?? {}).some((v) => (v ?? 0) > 0)) throw unprocessable('reward text fails the family-friendly screen');
    const game = b.gameSlug ? (await db.query('SELECT id FROM games WHERE slug = $1', [b.gameSlug])).rows[0] : null;
    if (b.gameSlug && !game) throw notFound('game not found');
    if (b.campaignId) await ownCampaign(orgId, b.campaignId);
    const p = await db.query(
      `INSERT INTO reward_programs (advertiser_org_id, campaign_id, game_id, name, reward_description, face_value_minor, total_quantity, min_score, per_rider_per_day, valid_days, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [orgId, b.campaignId ?? null, game?.id ?? null, b.name, b.rewardDescription, b.faceValueMinor, b.totalQuantity, b.minScore, b.perRiderPerDay, b.validDays, b.startsAt, b.endsAt, auth.userId]);
    await audit(db, actorOf(req), 'reward_program.created', { type: 'reward_program', id: p.rows[0].id, orgId }, { quantity: b.totalQuantity, faceValueMinor: b.faceValueMinor });
    reply.code(201);
    return p.rows[0];
  });

  /** Outstanding redemption obligations are tracked per program: issued − redeemed − expired, at face value. */
  app.get('/v1/orgs/:orgId/reward-programs', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'campaign.read', orgId);
    const r = await db.query(
      `SELECT p.id, p.name, p.reward_description, p.face_value_minor, p.total_quantity, p.status, p.starts_at, p.ends_at,
              count(g.id) AS issued, count(g.id) FILTER (WHERE g.redeemed_at IS NOT NULL) AS redeemed,
              count(g.id) FILTER (WHERE g.redeemed_at IS NULL AND g.expires_at <= now()) AS expired,
              count(g.id) FILTER (WHERE g.redeemed_at IS NULL AND g.expires_at > now()) AS outstanding
         FROM reward_programs p LEFT JOIN reward_grants g ON g.program_id = p.id WHERE p.advertiser_org_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`, [orgId]);
    return { items: r.rows.map((x) => ({ ...x, outstandingObligationMinor: String(BigInt(x.outstanding) * BigInt(x.face_value_minor)) })) };
  });

  app.post('/v1/orgs/:orgId/reward-programs/:pid/end', async (req) => {
    const { orgId, pid } = parse(z.object({ orgId: uuid, pid: uuid }), req.params);
    await authorize(db, req, 'campaign.manage', orgId);
    const r = await db.query(`UPDATE reward_programs SET status = 'ENDED' WHERE id = $1 AND advertiser_org_id = $2 RETURNING id, status`, [pid, orgId]);
    if (!r.rows[0]) throw notFound('program not found');
    return r.rows[0];
  });

  /** Merchant point of sale redeems a reward code once (API key with rewards:redeem). */
  app.post('/v1/rewards/redeem', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const key = await authenticateKey(db, req, 'rewards:redeem');
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Za-z2-9]{10}$/) }), req.body);
    return withTx(db, async (tx) => {
      const g = (await tx.query(`SELECT g.*, p.advertiser_org_id, p.reward_description FROM reward_grants g JOIN reward_programs p ON p.id = g.program_id WHERE g.code = $1 FOR UPDATE OF g`, [code.toUpperCase()])).rows[0];
      if (!g || g.advertiser_org_id !== key.orgId) throw notFound('code not found');
      if (g.redeemed_at) throw conflict('code already redeemed');
      if (new Date(g.expires_at) < new Date()) throw conflict('code expired');
      await tx.query('UPDATE reward_grants SET redeemed_at = now(), redeemed_via_key = $2 WHERE id = $1', [g.id, key.keyId]);
      await audit(tx, { requestId: req.id }, 'reward.redeemed', { type: 'reward_grant', id: g.id, orgId: key.orgId });
      return { redeemed: true, reward: g.reward_description };
    });
  });
}
