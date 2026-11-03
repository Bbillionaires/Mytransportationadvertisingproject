import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { signMediaUrl } from '../../lib/media.js';
import { authenticateDevice } from '../devices/routes.js';
import { isScheduleActive } from './schedule.js';

/**
 * What a tablet may show right now. Served only to signed, ACTIVE, vehicle-assigned tablets. An ad is
 * included only if its campaign is APPROVED, inside its dates and daypart, targets the tablet's market,
 * and its advertiser has a positive prepaid balance. Media links are signed and expire with the playlist.
 * The validator re-checks every rule server-side, so a stale or tampered playlist cannot create billable events.
 */
export async function playlistRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.get('/v1/devices/playlist', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const now = new Date();
    const validUntil = new Date(now.getTime() + config.PLAYLIST_TTL_MINUTES * 60_000);
    const base = { generatedAt: now.toISOString(), validUntil: validUntil.toISOString(), ads: [] as unknown[], content: [] as unknown[] };
    if (dev.status !== 'ACTIVE') return { ...base, deviceStatus: dev.status, playbackAllowed: false, reason: 'DEVICE_SUSPENDED' };
    const a = await db.query(
      `SELECT f.market FROM device_assignments da JOIN vehicles v ON v.id = da.vehicle_id JOIN fleets f ON f.id = v.fleet_id
        WHERE da.device_id = $1 AND da.ends_at IS NULL AND f.status = 'ACTIVE'`, [dev.deviceId]);
    if (!a.rows[0]) return { ...base, deviceStatus: dev.status, playbackAllowed: false, reason: 'NOT_ASSIGNED_TO_VEHICLE' };
    const market: string = a.rows[0].market;

    const campaigns = await db.query(
      `SELECT c.* FROM campaigns c JOIN organizations o ON o.id = c.advertiser_org_id AND o.status = 'ACTIVE'
        WHERE c.status = 'APPROVED' AND c.starts_at <= $1 AND c.ends_at > $1 AND (cardinality(c.markets) = 0 OR $2 = ANY(c.markets))
          AND (SELECT coalesce(sum(credit) - sum(debit), 0) FROM journal_lines jl
                WHERE jl.account_code = '2000' AND jl.party_id = c.advertiser_org_id AND jl.currency = c.currency) > 0`,
      [now, market]);
    const live = campaigns.rows.filter((c) => isScheduleActive({ timezone: c.timezone, daysOfWeek: c.days_of_week, startMinute: c.start_minute, endMinute: c.end_minute }, now));
    const creatives = await db.query(`SELECT * FROM creatives WHERE campaign_id = ANY($1::uuid[]) AND status = 'APPROVED' ORDER BY created_at`, [live.map((c) => c.id)]);
    const ads = creatives.rows.map((cr) => {
      const c = live.find((x) => x.id === cr.campaign_id)!;
      const expiresAt = new Date(Math.min(validUntil.getTime(), new Date(c.ends_at).getTime()));
      return {
        campaignId: c.id, creativeId: cr.id, kind: cr.kind, durationMs: cr.duration_ms, headline: cr.headline, bodyText: cr.body_text,
        destinationUrl: cr.destination_url ?? c.destination_url, priority: c.priority, frequencyCapPerHour: c.frequency_cap_per_hour, skipDelaySeconds: c.skip_delay_seconds,
        schedule: { timezone: c.timezone, daysOfWeek: c.days_of_week, startMinute: c.start_minute, endMinute: c.end_minute },
        expiresAt: expiresAt.toISOString(),
        media: cr.media_key ? { url: signMediaUrl(config.MEDIA_BASE_URL, cr.media_key, expiresAt, config.MEDIA_SIGNING_KEY), expiresAt: expiresAt.toISOString() } : null,
      };
    }).sort((x, y) => y.priority - x.priority);

    const videos = await db.query(
      `SELECT v.id, v.creator_id, v.title, v.duration_ms, v.media_key, cp.display_name FROM videos v JOIN creator_profiles cp ON cp.id = v.creator_id
        WHERE v.status = 'APPROVED' AND v.media_key IS NOT NULL AND cp.monetization_status NOT IN ('SUSPENDED','TERMINATED')
        ORDER BY v.created_at DESC LIMIT 200`);
    const content = videos.rows.map((v) => ({
      videoId: v.id, creatorId: v.creator_id, channelName: v.display_name, title: v.title, durationMs: v.duration_ms,
      media: { url: signMediaUrl(config.MEDIA_BASE_URL, v.media_key, validUntil, config.MEDIA_SIGNING_KEY), expiresAt: validUntil.toISOString() },
    }));
    return { ...base, deviceStatus: dev.status, playbackAllowed: true, market, ads, content };
  });
}
