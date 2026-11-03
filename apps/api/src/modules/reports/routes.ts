import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { toCsv } from '../../lib/csv.js';
import { textPdf } from '../../lib/pdf.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { isoDate, parse, uuid } from '../../lib/validation.js';
import { authorize, requireAuth } from '../../auth/context.js';
import { earnings, statement, statementPdfLines, type Party } from './earnings.js';
import { balanceSheet, cashFlow, generalLedger, incomeStatement, liabilities, receivables, recipientEarnings } from './financial.js';

const range = z.object({ from: isoDate.optional(), to: isoDate.optional(), format: z.enum(['json', 'csv']).default('json') });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const fmt = z.enum(['json', 'csv', 'pdf']).default('json');

function dates(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(Date.now() + 86_400_000);
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 90 * 86_400_000);
  if (to <= from) throw unprocessable('to must be after from');
  return { from, to };
}
const sendCsv = (reply: FastifyReply, name: string, rows: Array<Record<string, unknown>>) =>
  reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).send(toCsv(rows));

async function sendStatement(reply: FastifyReply, format: string, title: string, who: string, s: Awaited<ReturnType<typeof statement>>, file: string) {
  if (format === 'csv') return sendCsv(reply, file, s.lines);
  if (format === 'pdf') return reply.type('application/pdf').header('content-disposition', `attachment; filename="${file}.pdf"`).send(textPdf(statementPdfLines(title, who, s), title));
  return s;
}

export async function reportRoutes(app: FastifyInstance, { db }: { db: Db }) {
  // ---------------- creators ----------------
  const creatorIds = async (orgId: string) => (await db.query('SELECT id FROM creator_profiles WHERE org_id = $1', [orgId])).rows.map((r) => r.id as string);

  app.get('/v1/orgs/:orgId/earnings', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'creator.read', orgId);
    const q = parse(range, req.query);
    const ids = await creatorIds(orgId);
    if (!ids.length) throw notFound('no channels');
    const { from, to } = dates(q);
    const e = await earnings(db, 'CREATOR', ids, from, to);
    return q.format === 'csv' ? sendCsv(reply, `earnings-${orgId}`, e.lines.map((l) => ({ ...l, batch: undefined, basis: undefined, period: undefined, gross: l.batch.gross, deductions: l.batch.deductions, net: l.batch.net }))) : e;
  });

  /** Video ranking: qualified views, watch hours, monetized ad revenue, clicks, conversions, approval status. */
  app.get('/v1/orgs/:orgId/videos/performance', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'creator.read', orgId);
    const q = parse(range.extend({ sort: z.enum(['qualifiedViews', 'watchHours', 'monetizedRevenue', 'clicks', 'conversions']).default('qualifiedViews') }), req.query);
    const { from, to } = dates(q);
    const r = await db.query(
      `SELECT v.id, v.title, v.status, v.duration_ms,
              count(e.id) FILTER (WHERE e.type = 'CONTENT_PLAYBACK' AND e.qualified) AS qualified_views,
              coalesce(sum(e.watch_seconds) FILTER (WHERE e.type = 'CONTENT_PLAYBACK'), 0) AS watch_seconds,
              coalesce(sum(CASE WHEN c.pricing_model = 'CPQV' AND e.qualified THEN c.rate_minor * 1000 WHEN c.pricing_model = 'CPM' AND e.impression THEN c.rate_minor ELSE 0 END)
                       FILTER (WHERE e.type = 'AD_PLAYBACK'), 0) / 1000 AS monetized_revenue,
              count(e.id) FILTER (WHERE e.type = 'CLICK') AS clicks,
              (SELECT count(*) FROM conversions cv LEFT JOIN validated_events ce ON ce.id = cv.click_event_id LEFT JOIN coupon_codes cc ON cc.id = cv.coupon_code_id
                WHERE cv.status = 'ATTRIBUTED' AND coalesce(ce.video_id, cc.video_id) = v.id AND cv.occurred_at >= $2 AND cv.occurred_at < $3) AS conversions
         FROM videos v JOIN creator_profiles cp ON cp.id = v.creator_id
         LEFT JOIN validated_events e ON e.video_id = v.id AND e.status = 'VALID' AND e.occurred_at >= $2 AND e.occurred_at < $3
         LEFT JOIN campaigns c ON c.id = e.campaign_id
        WHERE cp.org_id = $1 GROUP BY v.id`, [orgId, from, to]);
    const items = r.rows.map((x) => ({ videoId: x.id, title: x.title, status: x.status, qualifiedViews: Number(x.qualified_views), watchHours: Number((Number(x.watch_seconds) / 3600).toFixed(2)),
      monetizedRevenue: String(x.monetized_revenue), clicks: Number(x.clicks), conversions: Number(x.conversions) }));
    const key = q.sort;
    items.sort((a, b) => Number((b as any)[key]) - Number((a as any)[key]));
    return { period: { from, to }, sort: key, items };
  });

  app.get('/v1/orgs/:orgId/statements/:month', async (req, reply) => {
    const { orgId, month: m } = parse(z.object({ orgId: uuid, month }), req.params);
    await authorize(db, req, 'creator.read', orgId);
    const { format } = parse(z.object({ format: fmt }), req.query);
    const ids = await creatorIds(orgId);
    if (!ids.length) throw notFound('no channels');
    const org = (await db.query('SELECT name FROM organizations WHERE id = $1', [orgId])).rows[0];
    return sendStatement(reply, format, 'Creator earnings statement', org.name, await statement(db, 'CREATOR', ids, m), `creator-statement-${m}`);
  });

  // ---------------- drivers ----------------
  const myDrivers = async (req: any) => {
    const auth = requireAuth(req);
    const r = await db.query('SELECT d.id, d.org_id, u.display_name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1', [auth.userId]);
    if (!r.rows.length) throw notFound('no driver profile for this account');
    for (const d of r.rows) await authorize(db, req, 'driver.self.read', d.org_id);
    return r.rows as Array<{ id: string; org_id: string; display_name: string }>;
  };

  app.get('/v1/drivers/me/earnings', async (req, reply) => {
    const ds = await myDrivers(req);
    const q = parse(range, req.query);
    const { from, to } = dates(q);
    const ids = ds.map((d) => d.id);
    const e = await earnings(db, 'DRIVER', ids, from, to);
    const devices = await db.query(
      `SELECT dv.id, dv.serial, dv.status, dv.app_version, dv.last_heartbeat_at, (dv.last_heartbeat_at > now() - interval '10 minutes') AS online
         FROM device_assignments a JOIN devices dv ON dv.id = a.device_id WHERE a.driver_id = ANY($1::uuid[]) AND a.ends_at IS NULL`, [ids]);
    const sub = await db.query(`SELECT status, current_period_end, cancel_at_period_end FROM driver_subscriptions WHERE driver_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 1`, [ids]);
    const conv = await db.query(`SELECT count(*)::int n, coalesce(sum(commission_minor), 0)::text c FROM conversions WHERE driver_id = ANY($1::uuid[]) AND status = 'ATTRIBUTED' AND occurred_at >= $2 AND occurred_at < $3`, [ids, from, to]);
    const elig = await db.query(`SELECT id, eligibility_status FROM drivers WHERE id = ANY($1::uuid[])`, [ids]);
    if (q.format === 'csv') return sendCsv(reply, 'driver-earnings', e.lines.map((l) => ({ ...l, batch: undefined, basis: undefined, period: undefined })));
    return { ...e, devices: devices.rows, subscription: sub.rows[0] ?? null, eligibility: elig.rows, conversions: { count: conv.rows[0].n, attributedCommission: conv.rows[0].c } };
  });

  app.get('/v1/drivers/me/statements/:month', async (req, reply) => {
    const { month: m } = parse(z.object({ month }), req.params);
    const { format } = parse(z.object({ format: fmt }), req.query);
    const ds = await myDrivers(req);
    return sendStatement(reply, format, 'Driver earnings statement', ds[0]!.display_name, await statement(db, 'DRIVER', ds.map((d) => d.id), m), `driver-statement-${m}`);
  });

  // ---------------- finance ----------------
  app.get('/v1/finance/statements/:partyType/:partyId/:month', async (req, reply) => {
    await authorize(db, req, 'finance.read');
    const p = parse(z.object({ partyType: z.enum(['CREATOR', 'DRIVER']), partyId: uuid, month }), req.params);
    const { format } = parse(z.object({ format: fmt }), req.query);
    return sendStatement(reply, format, `${p.partyType === 'CREATOR' ? 'Creator' : 'Driver'} earnings statement`, p.partyId, await statement(db, p.partyType as Party, [p.partyId], p.month), `statement-${p.partyId}-${p.month}`);
  });

  const report = <T>(path: string, run: (q: any) => Promise<T>, csvRows?: (r: T) => Array<Record<string, unknown>>, schema: z.ZodTypeAny = range) =>
    app.get(`/v1/finance/reports/${path}`, async (req, reply) => {
      await authorize(db, req, 'finance.read');
      const q = parse(schema, req.query) as any;
      const r = await run(q);
      if (q.format === 'csv') {
        if (!csvRows) throw unprocessable('CSV is not available for this report');
        return sendCsv(reply, path, csvRows(r));
      }
      return r;
    });
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  report('general-ledger', (q) => { const { from, to } = dates(q); return generalLedger(db, iso(from), iso(to), q.account); }, (r) => r, range.extend({ account: z.string().regex(/^\d{4}$/).optional() }));
  report('income-statement', (q) => { const { from, to } = dates(q); return incomeStatement(db, iso(from), iso(to)); },
    (r) => Object.entries(r.currencies).flatMap(([ccy, c]: any) => [...c.revenue.map((x: any) => ({ currency: ccy, section: 'REVENUE', ...x })), ...c.expenses.map((x: any) => ({ currency: ccy, section: 'EXPENSE', ...x })), { currency: ccy, section: 'NET_INCOME', amount: c.netIncome }]));
  const asOf = z.object({ asOf: isoDate.optional(), format: z.enum(['json', 'csv']).default('json') });
  report('balance-sheet', (q) => balanceSheet(db, q.asOf ?? iso(new Date())),
    (r) => Object.entries(r.currencies).flatMap(([ccy, c]: any) => [...c.assets.map((x: any) => ({ currency: ccy, section: 'ASSET', ...x })), ...c.liabilities.map((x: any) => ({ currency: ccy, section: 'LIABILITY', ...x })), ...c.equity.map((x: any) => ({ currency: ccy, section: 'EQUITY', ...x }))]), asOf);
  report('cash-flow', (q) => { const { from, to } = dates(q); return cashFlow(db, iso(from), iso(to)); },
    (r) => Object.entries(r.currencies).flatMap(([ccy, c]: any) => c.lines.map((x: any) => ({ currency: ccy, ...x }))));
  report('liabilities', (q) => liabilities(db, q.asOf ?? iso(new Date())), (r) => r, asOf);
  report('receivables', (q) => receivables(db, q.asOf ?? iso(new Date())), (r) => r, asOf);
  report('recipient-earnings', (q) => recipientEarnings(db, q.year), (r) => r, z.object({ year: z.coerce.number().int().min(2020).max(2100), format: z.enum(['json', 'csv']).default('json') }));
}
