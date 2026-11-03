import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPendingUploads } from '../src/modules/media/process.js';
import type { ModerationProvider } from '../src/modules/media/moderation.js';
import { addBusinessDays } from '../src/modules/media/routes.js';
import { org, platformOrg, registerVerified, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
const dir = mkdtempSync(path.join(tmpdir(), 'rmn-media-fixtures-'));
const files: Record<string, Buffer> = {};
let creator: { orgId: string; channelId: string; h: Record<string, string> };
let mod1: Awaited<ReturnType<typeof userWithRole>>, mod2: Awaited<ReturnType<typeof userWithRole>>;
const okProvider: ModerationProvider = { name: 'fake-visual', analyze: async (i) => ({ provider: 'fake-visual', status: 'OK', scores: { nudity: 0.01, violence: 0.02 }, transcript: 'welcome to the city walk', notes: [`${i.framePaths.length} frames`] }) };
const brokenProvider: ModerationProvider = { name: 'fake-visual', analyze: async () => { throw new Error('vendor timeout'); } };
const attestation = { statementVersion: 'RIGHTS_ATTESTATION_V1', ownsOrLicensedAllMedia: true, noThirdPartyPlatformContent: true, consentOfPeopleShown: true, familyFriendly: true };

const api = (method: 'GET' | 'POST' | 'PUT', url: string, h: Record<string, string> = {}, payload?: unknown, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method, url, headers: { ...h, ...extra } as any, payload: payload as any });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Upload a buffer in chunks through the API; returns the upload id and the complete response. */
async function upload(orgId: string, h: Record<string, string>, buf: Buffer, chunks = 2, declaredSha = sha(buf)) {
  const u = await api('POST', `/v1/orgs/${orgId}/uploads`, h, { filename: 'f.bin', contentType: 'video/mp4', sizeBytes: buf.length, sha256: declaredSha });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().uploadId;
  const size = Math.ceil(buf.length / chunks);
  for (let start = 0; start < buf.length; start += size) {
    const end = Math.min(buf.length, start + size) - 1;
    const r = await api('PUT', `/v1/uploads/${id}/content`, h, buf.subarray(start, end + 1), { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${buf.length}` });
    expect(r.statusCode, r.body).toBe(200);
  }
  return { id, complete: (await api('POST', `/v1/uploads/${id}/complete`, h, {})).json() };
}

const createVideo = (uploadId: string, title = 'City walk: downtown murals', over: object = {}) =>
  api('POST', `/v1/orgs/${creator.orgId}/videos`, creator.h, { channelId: creator.channelId, uploadId, title, attestation, ...over });
const caseFor = async (videoId: string) => (await ctx.db.query(`SELECT * FROM moderation_cases WHERE subject_type = 'VIDEO' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [videoId])).rows[0];
const videoStatus = async (id: string) => (await ctx.db.query('SELECT status, duration_ms FROM videos WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  ctx = await setupApp();
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(dir, 'ok.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=24', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(dir, 'short.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=orange:s=600x300', '-frames:v', '1', path.join(dir, 'banner.png')]);
  writeFileSync(path.join(dir, 'fake.mp4'), 'this is not really a video file at all');
  for (const f of ['ok.mp4', 'short.mp4', 'banner.png', 'fake.mp4']) files[f] = readFileSync(path.join(dir, f));

  const reg = await registerVerified(ctx, '/v1/creators/register', { channelName: 'City Walks', email: `creator-${Date.now()}@example.test`, displayName: 'Walker', password: 'a-long-password-123' });
  const channelId = (await api('GET', `/v1/orgs/${reg.orgId}/channels`, reg.h)).json().items[0].id;
  creator = { orgId: reg.orgId, channelId, h: reg.h };
  const p = await platformOrg(ctx.db);
  mod1 = await userWithRole(ctx, p, 'moderator', { mfa: true });
  mod2 = await userWithRole(ctx, p, 'moderator', { mfa: true });
}, 60_000);
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('resumable uploads', () => {
  it('accepts ordered chunks, rejects wrong offsets, reports progress for resume, and verifies checksum and real type', async () => {
    const buf = files['ok.mp4']!;
    const u = (await api('POST', `/v1/orgs/${creator.orgId}/uploads`, creator.h, { filename: 'ok.mp4', contentType: 'video/mp4', sizeBytes: buf.length, sha256: sha(buf) })).json();
    const half = Math.floor(buf.length / 2);
    const put = (s: number, e: number) => api('PUT', `/v1/uploads/${u.uploadId}/content`, creator.h, buf.subarray(s, e + 1), { 'content-type': 'application/octet-stream', 'content-range': `bytes ${s}-${e}/${buf.length}` });
    expect((await put(0, half - 1)).statusCode).toBe(200);
    expect((await put(half + 10, buf.length - 1)).statusCode).toBe(409);                       // gap
    expect((await api('GET', `/v1/uploads/${u.uploadId}`, creator.h)).json().receivedBytes).toBe(String(half)); // resume point
    expect((await put(half, buf.length - 1)).statusCode).toBe(200);
    expect((await api('POST', `/v1/uploads/${u.uploadId}/complete`, creator.h, {})).json()).toMatchObject({ status: 'UPLOADED', detectedType: 'video/mp4' });
  });

  it('fails uploads whose bytes do not match the declared checksum or are not real media', async () => {
    expect((await upload(creator.orgId, creator.h, files['ok.mp4']!, 2, sha(Buffer.from('other')))).complete).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/SHA-256/) });
    expect((await upload(creator.orgId, creator.h, files['fake.mp4']!)).complete).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/unsupported/) });
    expect((await upload(creator.orgId, creator.h, files['banner.png']!)).complete).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/must be video/) });
  });

  it('uploads are tenant-scoped', async () => {
    const other = await org(ctx.db, 'CREATOR_STUDIO');
    expect((await api('POST', `/v1/orgs/${other}/uploads`, creator.h, { filename: 'x', contentType: 'video/mp4', sizeBytes: 1, sha256: '0'.repeat(64) })).statusCode).toBe(403);
  });
});

describe('processing and fail-closed moderation', () => {
  let videoId: string;

  it('requires every rights attestation', async () => {
    const { id } = await upload(creator.orgId, creator.h, files['ok.mp4']!);
    const r = await createVideo(id, 'x', { attestation: { ...attestation, noThirdPartyPlatformContent: false } });
    expect(r.statusCode).toBe(400);
  });

  it('probes and transcodes real media; a clean AI pre-screen still waits for a human', async () => {
    const { id } = await upload(creator.orgId, creator.h, files['ok.mp4']!);
    const v = await createVideo(id);
    expect(v.json().status).toBe('PROCESSING');
    videoId = v.json().id;
    const run = await processPendingUploads(ctx.db, ctx.config, [okProvider]); // also picks up uploads completed by earlier tests
    expect(run.failed).toBe(0);
    expect(run.ready).toBeGreaterThanOrEqual(1);
    const s = await videoStatus(videoId);
    expect(s.status).toBe('PENDING_REVIEW');                    // never auto-approved
    expect(Math.abs(s.duration_ms - 6000)).toBeLessThan(200);  // from ffprobe
    const c = await caseFor(videoId);
    expect(c).toMatchObject({ ai_recommendation: 'LIKELY_OK', priority: 'NORMAL', status: 'OPEN' });
    expect(c.findings.frameCount).toBeGreaterThan(0);
    expect(c.findings.hasAudio).toBe(true);
    const ra = await ctx.db.query('SELECT statement_version FROM rights_attestations WHERE video_id = $1', [videoId]);
    expect(ra.rows[0].statement_version).toBe('RIGHTS_ATTESTATION_V1');
  }, 60_000);

  it('a crashing AI provider or flagged text raises priority but never publishes', async () => {
    const a = await upload(creator.orgId, creator.h, files['ok.mp4']!);
    const va = (await createVideo(a.id)).json().id;
    await processPendingUploads(ctx.db, ctx.config, [brokenProvider]);
    expect(await caseFor(va)).toMatchObject({ ai_recommendation: 'NEEDS_REVIEW', priority: 'HIGH' });
    expect((await videoStatus(va)).status).toBe('PENDING_REVIEW');
    const b = await upload(creator.orgId, creator.h, files['ok.mp4']!);
    const vb = (await createVideo(b.id, 'This shit is wild')).json().id;
    await processPendingUploads(ctx.db, ctx.config, [okProvider]);
    const cb = await caseFor(vb);
    expect(cb).toMatchObject({ ai_recommendation: 'LIKELY_VIOLATION', priority: 'HIGH' });
    expect(cb.scores.profanity).toBe(1);
    const q = (await api('GET', '/v1/moderation/queue', mod1.h)).json().items;
    expect(q[0].priority).toBe('HIGH');
    await expect(ctx.db.query(`UPDATE moderation_cases SET ai_recommendation = 'LIKELY_OK' WHERE id = $1`, [cb.id])).rejects.toThrow(/immutable/);
  }, 60_000);

  it('rejects media outside length limits', async () => {
    const { id } = await upload(creator.orgId, creator.h, files['short.mp4']!);
    const v = (await createVideo(id)).json().id;
    expect(await processPendingUploads(ctx.db, ctx.config, [okProvider])).toMatchObject({ failed: 1 });
    expect((await videoStatus(v)).status).toBe('PROCESSING_FAILED');
    expect((await api('GET', `/v1/uploads/${id}`, creator.h)).json().error).toMatch(/too short/);
  }, 60_000);

  it('serves renditions only through valid signed links, with byte ranges', async () => {
    const item = (await api('GET', '/v1/moderation/queue', mod1.h)).json().items.find((i: any) => i.subject_id === videoId);
    const u = new URL(item.renditionUrl);
    const local = `/media${u.pathname}${u.search}`;
    const full = await api('GET', local);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    const part = await api('GET', local, {}, undefined, { range: 'bytes=0-99' });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);
    expect((await api('GET', local.replace(/sig=[^&]+/, 'sig=AAAA'))).statusCode).toBe(403);
    const assetId = u.pathname.split('/')[1];
    expect((await api('GET', `/media/assets/${assetId}/original?exp=9999999999&sig=x`)).statusCode).toBe(403); // originals never served
  });

  it('humans decide; rejections cite policy; appeals go to a different reviewer', async () => {
    const c = await caseFor(videoId);
    expect((await api('POST', `/v1/moderation/cases/${c.id}/decision`, creator.h, { decision: 'APPROVE', note: 'self approval' })).statusCode).toBe(403);
    expect((await api('POST', `/v1/moderation/cases/${c.id}/decision`, mod1.h, { decision: 'REJECT', note: 'music sounds licensed' })).statusCode).toBe(400);
    const rej = await api('POST', `/v1/moderation/cases/${c.id}/decision`, mod1.h, { decision: 'REJECT', reasons: ['COPYRIGHT'], note: 'Background music sounds like a commercial track' });
    expect(rej.json().videoStatus).toBe('REJECTED');
    const listed = (await api('GET', `/v1/orgs/${creator.orgId}/videos`, creator.h)).json().items.find((v: any) => v.id === videoId);
    expect(listed.moderation).toMatchObject({ decision: 'REJECT', reasons: ['COPYRIGHT'] });

    const appeal = await api('POST', `/v1/orgs/${creator.orgId}/videos/${videoId}/appeal`, creator.h, { statement: 'The tone is a generated 440 Hz test signal, not licensed music.' });
    expect(appeal.statusCode).toBe(201);
    const same = await api('POST', `/v1/moderation/appeals/${appeal.json().id}/decision`, mod1.h, { decision: 'OVERTURN', note: 'changed my mind' });
    expect(same.json().error.code).toBe('SEPARATION_OF_DUTIES');
    const ok = await api('POST', `/v1/moderation/appeals/${appeal.json().id}/decision`, mod2.h, { decision: 'OVERTURN', note: 'Confirmed synthetic tone; no third-party audio' });
    expect(ok.json().status).toBe('OVERTURNED');
    expect((await videoStatus(videoId)).status).toBe('APPROVED');
    await expect(ctx.db.query(`UPDATE videos SET media_key = 'assets/x/720p.mp4' WHERE id = $1`, [videoId])).rejects.toThrow(/cannot be swapped/);
  });

  it('copyright notice removes the video at once; restoration only after counter-notice and the waiting period', async () => {
    const n = await api('POST', '/v1/takedowns', {}, { videoId, complainantName: 'Rights Holder LLC', complainantEmail: 'legal@rights.example.test', complainantAddress: '1 Main St, Springfield',
      copyrightedWork: 'Original mural photography series', goodFaithStatement: true, accuracyUnderPenaltyOfPerjury: true, signature: '/s/ R. Holder' });
    expect(n.statusCode).toBe(201);
    expect((await videoStatus(videoId)).status).toBe('TAKEN_DOWN');
    const noticeId = n.json().noticeId;
    expect((await api('POST', `/v1/takedowns/${noticeId}/resolve`, mod1.h, { action: 'RESTORE', note: 'too early to restore' })).statusCode).toBe(409);
    const cn = await api('POST', `/v1/orgs/${creator.orgId}/videos/${videoId}/counter-notice`, creator.h, { takedownId: noticeId, statement: 'I filmed these murals myself in a public place.', signature: '/s/ Walker', goodFaithBeliefOfMistake: true, consentToJurisdiction: true });
    expect(cn.json().status).toBe('COUNTER_NOTICED');
    expect(new Date(cn.json().restore_eligible_at).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 3600_000);
    expect((await api('POST', `/v1/takedowns/${noticeId}/resolve`, mod1.h, { action: 'RESTORE', note: 'waiting period not over' })).statusCode).toBe(409);
    await ctx.db.query(`UPDATE takedown_notices SET restore_eligible_at = now() - interval '1 minute' WHERE id = $1`, [noticeId]);
    expect((await api('POST', `/v1/takedowns/${noticeId}/resolve`, mod1.h, { action: 'RESTORE', note: 'No court action reported within the waiting period' })).json().status).toBe('RESTORED');
    expect((await videoStatus(videoId)).status).toBe('APPROVED');
  });
});

describe('ad creative media', () => {
  it('display creatives use processed images; kind must match the asset', async () => {
    const advOrg = await org(ctx.db, 'ADVERTISER');
    const admin = await userWithRole(ctx, advOrg, 'advertiser_admin');
    const { id, complete } = await upload(advOrg, admin.h, files['banner.png']!, 1);
    expect(complete.detectedType).toBe('image/png');
    await processPendingUploads(ctx.db, ctx.config, [okProvider]);
    const c = (await api('POST', `/v1/orgs/${advOrg}/campaigns`, admin.h, { name: 'Banner', pricingModel: 'CPM', rateMinor: '1000', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() })).json();
    expect((await api('POST', `/v1/orgs/${advOrg}/campaigns/${c.id}/creatives`, admin.h, { name: 'v', kind: 'VIDEO', uploadId: id })).statusCode).toBe(422);
    const d = await api('POST', `/v1/orgs/${advOrg}/campaigns/${c.id}/creatives`, admin.h, { name: 'display', kind: 'DISPLAY', uploadId: id });
    expect(d.statusCode).toBe(201);
    expect(d.json().mediaKey).toMatch(/display\.jpg$/);
  }, 60_000);
});

describe('business-day waiting period', () => {
  it('skips weekends', () => {
    expect(addBusinessDays(new Date('2026-11-06T12:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-11-09'); // Fri -> Mon
    expect(addBusinessDays(new Date('2026-11-02T12:00:00Z'), 10).toISOString().slice(0, 10)).toBe('2026-11-16');
  });
});
