import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { setProximityRandomForTests } from '../src/modules/riders/proximity.js';
import { ensureOpenPeriod, FakeTablet, linkToken, org, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let advertiser: string, advAdmin: User, other: string, otherAdmin: User, fleetOrg: string, fleetAdmin: User;
let campaignId: string, creativeId: string, tablet: FakeTablet, tablet2: FakeTablet;
let rider: { email: string; h: Record<string, string> };
let riderSession: string;
const HERE = { latitude: 39.7817, longitude: -89.6501 };

const api = (method: 'GET' | 'POST', url: string, h: object = {}, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });
/** Tablet call carrying the rider session header in addition to the device signature. */
const asRider = async (t: FakeTablet, method: 'GET' | 'POST', path: string, payload?: object, session = riderSession) => {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers: Record<string, string> = { ...t.signedHeaders(method, path, body), 'x-rider-session': session };
  if (!body) delete headers['content-type'];
  return ctx.app.inject({ method, url: path, headers, ...(body ? { payload: body } : {}) });
};
const registerRider = async (email: string, birthYear = 1990) => api('POST', '/v1/riders/register', {}, { email, password: 'a long rider passphrase', displayName: 'Sam', birthYear, confirmAdult: true, termsVersion: 'RIDER_TERMS_V1' });

async function enrolledTablet(vehicleLabel: string) {
  const code = (await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, fleetAdmin.h, {})).json().code;
  const t = new FakeTablet(ctx.app);
  t.deviceId = (await api('POST', '/v1/devices/enroll', {}, { code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: '1' })).json().deviceId;
  const fleet = (await ctx.db.query('SELECT id FROM fleets WHERE org_id = $1', [fleetOrg])).rows[0].id;
  const v = (await ctx.db.query(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,$3) RETURNING id`, [fleetOrg, fleet, vehicleLabel])).rows[0].id;
  await api('POST', `/v1/orgs/${fleetOrg}/devices/${t.deviceId}/assignments`, fleetAdmin.h, { vehicleId: v });
  return t;
}

beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  advertiser = await org(ctx.db, 'ADVERTISER'); advAdmin = await userWithRole(ctx, advertiser, 'advertiser_admin');
  other = await org(ctx.db, 'ADVERTISER'); otherAdmin = await userWithRole(ctx, other, 'advertiser_admin');
  await withTx(ctx.db, (tx) => postEntry(tx, { idempotencyKey: `fund-${advertiser}`, entryDate: new Date().toISOString().slice(0, 10), description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 100_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 100_000n, partyType: 'ADVERTISER', partyId: advertiser }] }));
  campaignId = (await ctx.db.query(`INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor, markets) VALUES ($1,'Coffee','APPROVED', now() - interval '1 day', now() + interval '30 days','CPQV',50,'{Springfield}') RETURNING id`, [advertiser])).rows[0].id;
  creativeId = (await ctx.db.query(`INSERT INTO creatives (campaign_id, kind, status, headline) VALUES ($1,'BANNER','APPROVED','Coffee') RETURNING id`, [campaignId])).rows[0].id;
  await ctx.db.query(`INSERT INTO commission_offers (campaign_id, advertiser_org_id, name, kind, rate_bps, coupon_description, valid_from, valid_to, created_by) VALUES ($1,$2,'10%','PERCENT_OF_SALE',1000,'Free cookie with any coffee', now() - interval '1 day', now() + interval '30 days', $3)`, [campaignId, advertiser, advAdmin.userId]);
  fleetOrg = await org(ctx.db, 'FLEET_OPERATOR'); fleetAdmin = await userWithRole(ctx, fleetOrg, 'fleet_admin');
  await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC')`, [fleetOrg]);
  tablet = await enrolledTablet('V1');
  tablet2 = await enrolledTablet('V2');
});
afterAll(async () => { setProximityRandomForTests(() => Math.random()); await ctx.app.close(); await ctx.db.end(); });

describe('rider accounts', () => {
  it('adults only, uniform responses, email verification, then sign-in on the phone', async () => {
    expect((await registerRider(`kid-${uid()}@example.test`, new Date().getUTCFullYear() - 15)).statusCode).toBe(422);
    const email = `rider-${uid()}@example.test`;
    expect((await registerRider(email)).statusCode).toBe(202);
    expect((await registerRider(email)).json()).toEqual((await registerRider(`fresh-${uid()}@example.test`)).json());
    expect((await api('POST', '/v1/riders/verify-email', {}, { token: await linkToken(ctx.db, email, 'rider_verify_email', 'verify') })).statusCode).toBe(200);
    const tok = (await api('POST', '/v1/riders/login', {}, { email, password: 'a long rider passphrase' })).json().token;
    rider = { email, h: { authorization: `Bearer ${tok}` } };
    expect((await api('GET', '/v1/riders/me', rider.h)).json()).toMatchObject({ displayName: 'Sam', emailVerified: true });
    // staff endpoints do not accept rider tokens
    expect((await api('GET', '/v1/me', rider.h)).statusCode).toBe(401);
  });
});

describe('QR sign-in on a tablet', () => {
  it('pairs once, hands the token to the tablet once, and the session only works on that tablet', async () => {
    const p = (await tablet.call('POST', '/v1/devices/rider-pairings', {})).json();
    expect(p.qrPayload).toMatch(/^RMNPAIR:[A-Z2-9]{8}$/);
    expect((await tablet.call('GET', `/v1/devices/rider-pairings/${p.pairingId}`)).json().status).toBe('WAITING');
    expect((await api('POST', '/v1/riders/pair', rider.h, { code: p.qrPayload })).json().paired).toBe(true);
    expect((await api('POST', '/v1/riders/pair', rider.h, { code: p.code })).statusCode).toBe(400); // single use
    const got = (await tablet.call('GET', `/v1/devices/rider-pairings/${p.pairingId}`)).json();
    expect(got).toMatchObject({ status: 'PAIRED', riderDisplayName: 'Sam' });
    riderSession = got.riderSession;
    expect((await tablet.call('GET', `/v1/devices/rider-pairings/${p.pairingId}`)).json()).toEqual({ status: 'PAIRED', alreadyDelivered: true });
    expect((await asRider(tablet, 'GET', '/v1/devices/rider-sessions/current')).json().riderDisplayName).toBe('Sam');
    expect((await asRider(tablet2, 'GET', '/v1/devices/rider-sessions/current')).statusCode).toBe(401); // stolen token, other tablet
    // another tablet's pairing view is not visible
    expect((await tablet2.call('GET', `/v1/devices/rider-pairings/${p.pairingId}`)).statusCode).toBe(404);
  });

  it('unverified riders cannot pair; expired codes fail', async () => {
    const email = `unverified-${uid()}@example.test`;
    await registerRider(email);
    const h = { authorization: `Bearer ${(await api('POST', '/v1/riders/login', {}, { email, password: 'a long rider passphrase' })).json().token}` };
    const p = (await tablet2.call('POST', '/v1/devices/rider-pairings', {})).json();
    expect((await api('POST', '/v1/riders/pair', h, { code: p.code })).json().error.code).toBe('EMAIL_NOT_VERIFIED');
    await ctx.db.query(`UPDATE rider_pairings SET expires_at = now() - interval '1 second' WHERE id = $1`, [p.pairingId]);
    expect((await api('POST', '/v1/riders/pair', rider.h, { code: p.code })).statusCode).toBe(400);
  });

  it('coupons claimed while signed in land in the rider wallet', async () => {
    const c = (await asRider(tablet, 'POST', '/v1/devices/coupons', { campaignId, creativeId })).json();
    expect(c.savedToWallet).toBe(true);
    expect((await tablet2.call('POST', '/v1/devices/coupons', { campaignId, creativeId })).json().savedToWallet).toBe(false);
    const w = (await api('GET', '/v1/riders/me/wallet', rider.h)).json();
    expect(w.coupons).toEqual([expect.objectContaining({ code: c.code, description: 'Free cookie with any coffee' })]);
  });
});

describe('games and sponsor rewards', () => {
  it('chance-based games cannot exist without a legal approval reference', async () => {
    await expect(ctx.db.query(`INSERT INTO games (slug, name, kind, chance_based, config) VALUES ('jackpot-${uid()}','Jackpot','PUZZLE',true,'{}')`)).rejects.toThrow(/check constraint/);
  });

  it('trivia is scored on the server; guests play but never earn rewards; too-fast sessions are rejected', async () => {
    const list = (await tablet2.call('GET', '/v1/devices/games')).json();
    expect(list.games.map((g: any) => g.slug)).toEqual(expect.arrayContaining(['city-trivia', 'memory-match']));
    const s = (await tablet2.call('POST', '/v1/devices/games/city-trivia/sessions', {})).json();
    expect(s.mode).toBe('GUEST');
    expect(JSON.stringify(s.questions)).not.toContain('answer');
    expect((await tablet2.call('POST', `/v1/devices/games/sessions/${s.sessionId}/complete`, { answers: [1, 0, 2] })).json()).toMatchObject({ verdict: 'REJECTED_IMPLAUSIBLE' });
    const s2 = (await tablet2.call('POST', '/v1/devices/games/city-trivia/sessions', {})).json();
    await ctx.db.query(`UPDATE game_sessions SET started_at = now() - interval '30 seconds' WHERE id = $1`, [s2.sessionId]);
    expect((await tablet2.call('POST', `/v1/devices/games/sessions/${s2.sessionId}/complete`, { answers: [1, 0, 0], score: 999 })).json())
      .toEqual({ score: 2, verdict: 'ACCEPTED', reward: null, guest: true }); // claimed score ignored for trivia
  });

  it('signed-in riders earn capped, single-use sponsor rewards that only the sponsor can redeem', async () => {
    const prog = await api('POST', `/v1/orgs/${advertiser}/reward-programs`, advAdmin.h, { name: 'Trivia week', rewardDescription: 'Free small coffee', faceValueMinor: 300,
      totalQuantity: 2, minScore: 2, gameSlug: 'city-trivia', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(prog.statusCode).toBe(201);
    const play = async (answers: number[]) => {
      const s = (await asRider(tablet, 'POST', '/v1/devices/games/city-trivia/sessions', {})).json();
      await ctx.db.query(`UPDATE game_sessions SET started_at = now() - interval '30 seconds' WHERE id = $1`, [s.sessionId]);
      return (await asRider(tablet, 'POST', `/v1/devices/games/sessions/${s.sessionId}/complete`, { answers })).json();
    };
    expect((await play([0, 0, 0])).reward).toBeNull();                 // score 0 < minScore
    const won = await play([1, 0, 2]);
    expect(won).toMatchObject({ score: 3, verdict: 'ACCEPTED', reward: { description: 'Free small coffee', savedToWallet: true } });
    expect((await play([1, 0, 2])).reward).toBeNull();                 // one per rider per day
    expect((await api('GET', '/v1/riders/me/wallet', rider.h)).json().rewards.map((r: any) => r.code)).toEqual([won.reward.code]);

    const memory = (await asRider(tablet, 'POST', '/v1/devices/games/memory-match/sessions', {})).json();
    await ctx.db.query(`UPDATE game_sessions SET started_at = now() - interval '30 seconds' WHERE id = $1`, [memory.sessionId]);
    expect((await asRider(tablet, 'POST', `/v1/devices/games/sessions/${memory.sessionId}/complete`, { score: 5000 })).json().verdict).toBe('REJECTED_IMPLAUSIBLE');

    const posKey = (await api('POST', `/v1/orgs/${advertiser}/integration-keys`, advAdmin.h, { name: 'POS', scopes: ['rewards:redeem'] })).json().key;
    const convKey = (await api('POST', `/v1/orgs/${advertiser}/integration-keys`, advAdmin.h, { name: 'conv' })).json().key;
    const otherKey = (await api('POST', `/v1/orgs/${other}/integration-keys`, otherAdmin.h, { name: 'x', scopes: ['rewards:redeem'] })).json().key;
    expect((await api('POST', '/v1/rewards/redeem', { authorization: `Bearer ${convKey}` }, { code: won.reward.code })).statusCode).toBe(403);
    expect((await api('POST', '/v1/rewards/redeem', { authorization: `Bearer ${otherKey}` }, { code: won.reward.code })).statusCode).toBe(404);
    expect((await api('POST', '/v1/rewards/redeem', { authorization: `Bearer ${posKey}` }, { code: won.reward.code })).json()).toMatchObject({ redeemed: true });
    expect((await api('POST', '/v1/rewards/redeem', { authorization: `Bearer ${posKey}` }, { code: won.reward.code })).statusCode).toBe(409);
    const stats = (await api('GET', `/v1/orgs/${advertiser}/reward-programs`, advAdmin.h)).json().items[0];
    expect(stats).toMatchObject({ issued: '1', redeemed: '1', outstanding: '0', outstandingObligationMinor: '0' });
  });
});

describe('geofenced proximity alerts', () => {
  let fenceId: string;
  it('advertisers register family-friendly fences', async () => {
    expect((await api('POST', `/v1/orgs/${advertiser}/campaigns/${campaignId}/geofences`, advAdmin.h, { name: 'Cafe', message: 'Damn good shit coffee', ...HERE, radiusM: 300 })).statusCode).toBe(422);
    const f = await api('POST', `/v1/orgs/${advertiser}/campaigns/${campaignId}/geofences`, advAdmin.h, { name: 'Main St Cafe', message: 'Fresh coffee two blocks away', ...HERE, radiusM: 300, cooldownMinutes: 30 });
    expect(f.statusCode).toBe(201);
    fenceId = f.json().id;
  });

  it('randomized, silent, passenger-only alerts with speed suppression and cooldowns; no coordinates stored', async () => {
    setProximityRandomForTests(() => 0.9);
    expect((await tablet2.call('POST', '/v1/devices/proximity', { ...HERE, speedMps: 8 })).json()).toEqual({ alert: null, reason: 'RANDOMIZED_SKIP' });
    setProximityRandomForTests(() => 0.1);
    expect((await tablet2.call('POST', '/v1/devices/proximity', { ...HERE, speedMps: 30 })).json().reason).toBe('SPEED_TOO_HIGH');
    expect((await tablet2.call('POST', '/v1/devices/proximity', { latitude: 39.9, longitude: -89.65, speedMps: 8 })).json().reason).toBe('NONE_ELIGIBLE'); // ~13 km away
    const r = (await tablet2.call('POST', '/v1/devices/proximity', { ...HERE, speedMps: 8 })).json();
    expect(r.alert).toMatchObject({ title: 'Main St Cafe', context: 'Near your route', sound: false, audience: 'PASSENGER_ONLY', coupon: { description: 'Free cookie with any coffee' } });
    expect(new Date(r.alert.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect((await tablet2.call('POST', '/v1/devices/proximity', { ...HERE, speedMps: 8 })).json().reason).toBe('GLOBAL_GAP');
    await ctx.db.query(`UPDATE geofence_alerts SET issued_at = now() - interval '15 minutes' WHERE id = $1`, [r.alert.alertId]);
    expect((await tablet2.call('POST', '/v1/devices/proximity', { ...HERE, speedMps: 8 })).json().reason).toBe('NONE_ELIGIBLE'); // per-fence 30-minute cooldown
    expect((await tablet2.call('POST', `/v1/devices/proximity/alerts/${r.alert.alertId}/outcome`, { outcome: 'OPENED' })).json().outcome).toBe('OPENED');
    expect((await tablet.call('POST', `/v1/devices/proximity/alerts/${r.alert.alertId}/outcome`, { outcome: 'CLAIMED' })).statusCode).toBe(404); // other tablet
    const cols = (await ctx.db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'geofence_alerts'`)).rows.map((c) => c.column_name);
    expect(cols.some((c) => /lat|lon|coord|location/.test(c))).toBe(false);
    const stats = (await api('GET', `/v1/orgs/${advertiser}/campaigns/${campaignId}/geofences`, advAdmin.h)).json().items.find((x: any) => x.id === fenceId);
    expect(stats).toMatchObject({ alerts_issued: '1', opened: '1' });
  });
});

describe('session end and account deletion', () => {
  it('rider sessions end on expiry, sign-out and remote purge', async () => {
    await ctx.db.query(`UPDATE rider_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'TABLET_SESSION' AND device_id = $1`, [tablet.deviceId]);
    expect((await asRider(tablet, 'GET', '/v1/devices/rider-sessions/current')).statusCode).toBe(401);
    const pair = async () => {
      const p = (await tablet.call('POST', '/v1/devices/rider-pairings', {})).json();
      await api('POST', '/v1/riders/pair', rider.h, { code: p.code });
      return (await tablet.call('GET', `/v1/devices/rider-pairings/${p.pairingId}`)).json().riderSession as string;
    };
    let s = await pair();
    expect((await asRider(tablet, 'POST', '/v1/devices/rider-sessions/end', {}, s)).json()).toMatchObject({ ended: true, purgeLocalRiderData: true });
    expect((await asRider(tablet, 'GET', '/v1/devices/rider-sessions/current', undefined, s)).statusCode).toBe(401);
    s = await pair();
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${tablet.deviceId}/commands`, fleetAdmin.h, { command: 'PURGE_RIDER_DATA' });
    expect((await asRider(tablet, 'GET', '/v1/devices/rider-sessions/current', undefined, s)).statusCode).toBe(401);
  });

  it('deleting the account erases personal data and ends every session', async () => {
    expect((await api('POST', '/v1/riders/me/delete', rider.h, { password: 'wrong' })).statusCode).toBe(401);
    expect((await api('POST', '/v1/riders/me/delete', rider.h, { password: 'a long rider passphrase' })).json().deleted).toBe(true);
    expect((await api('GET', '/v1/riders/me', rider.h)).statusCode).toBe(401);
    expect((await api('POST', '/v1/riders/login', {}, { email: rider.email, password: 'a long rider passphrase' })).statusCode).toBe(401);
    const row = (await ctx.db.query(`SELECT email, password_hash, birth_year, display_name, status FROM riders WHERE display_name = 'Deleted rider' ORDER BY deleted_at DESC LIMIT 1`)).rows[0];
    expect(row).toEqual({ email: null, password_hash: null, birth_year: null, display_name: 'Deleted rider', status: 'DELETED' });
  });
});
