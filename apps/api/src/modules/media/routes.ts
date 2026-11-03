import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db, Queryable } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { signMediaUrl, verifyMediaSignature } from '../../lib/media.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';
import { MODERATION_POLICY_VERSION, screenText, summarize, type ProviderResult } from './moderation.js';
import { isVideo, sniff } from './sniff.js';
import { LocalMediaStore, uploadPartKey } from './storage.js';

export const RIGHTS_ATTESTATION_V1 = [
  'I own, or hold a written license for, every video, image, music and audio element in this upload, for public display in vehicles.',
  'This upload contains no content copied from YouTube, TikTok, streaming services or other third-party platforms without written authorization.',
  'Every identifiable person shown has consented to appear, and a parent or guardian has consented for any minor.',
  'The content is family-friendly: no profanity, nudity, sexual content, graphic violence, hate or abuse.',
  'I understand that false statements can lead to removal, forfeiture of related earnings and account termination.',
].join('\n');
const ATTESTATION_SHA = createHash('sha256').update(RIGHTS_ATTESTATION_V1).digest('hex');

const CHUNK_LIMIT = 8 * 1024 * 1024;
const RENDITION_KEY_RE = /^assets\/[0-9a-f-]{36}\/(720p\.mp4|display\.jpg|thumb\.jpg)$/;
const POLICY_REASONS = ['PROFANITY', 'SEXUAL_CONTENT', 'NUDITY', 'GRAPHIC_VIOLENCE', 'HATE_OR_ABUSE', 'SELF_HARM', 'DRUGS', 'WEAPONS', 'COPYRIGHT', 'NOT_FAMILY_FRIENDLY', 'LOW_QUALITY', 'MISLEADING', 'OTHER'] as const;

/** Add n business days (Mon–Fri) for counter-notice waiting periods. */
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from);
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) left -= 1; }
  return d;
}

async function videoInOrg(q: Queryable, orgId: string, videoId: string) {
  const r = await q.query(`SELECT v.* FROM videos v JOIN creator_profiles cp ON cp.id = v.creator_id WHERE v.id = $1 AND cp.org_id = $2`, [videoId, orgId]);
  if (!r.rows[0]) throw notFound('video not found');
  return r.rows[0];
}

export async function mediaRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const store = new LocalMediaStore(config.MEDIA_ROOT);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_LIMIT }, (_req, body, done) => done(null, body));
  const signed = (key: string, minutes: number) => signMediaUrl(config.MEDIA_BASE_URL, key, new Date(Date.now() + minutes * 60_000), config.MEDIA_SIGNING_KEY);

  // ---------------- uploads (resumable, chunked) ----------------
  app.post('/v1/orgs/:orgId/uploads', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    if (org.kind !== 'ADVERTISER' && org.kind !== 'CREATOR_STUDIO') throw notFound('organization cannot upload media');
    const auth = await authorize(db, req, 'media.upload', orgId);
    const b = parse(z.object({ filename: z.string().min(1).max(255), contentType: z.string().max(100), sizeBytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }), req.body);
    if (b.sizeBytes > config.MAX_UPLOAD_BYTES) throw unprocessable(`file exceeds ${config.MAX_UPLOAD_BYTES} bytes`);
    const u = await db.query(
      `INSERT INTO media_uploads (org_id, purpose, filename, declared_type, size_bytes, sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orgId, org.kind === 'ADVERTISER' ? 'AD_CREATIVE' : 'CREATOR_VIDEO', b.filename, b.contentType, b.sizeBytes, b.sha256, auth.userId]);
    reply.code(201);
    return { uploadId: u.rows[0].id, chunkSizeLimit: CHUNK_LIMIT, receivedBytes: 0 };
  });

  const loadUpload = async (req: FastifyRequest, lock = false, q: Queryable = db) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await q.query(`SELECT * FROM media_uploads WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw notFound('upload not found');
    await authorize(db, req, 'media.upload', r.rows[0].org_id);
    return r.rows[0];
  };

  /** Append a chunk. `Content-Range: bytes start-end/total`; start must equal the bytes already received (resume via GET). */
  app.put('/v1/uploads/:id/content', { bodyLimit: CHUNK_LIMIT }, async (req) => {
    const chunk = req.body as Buffer;
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) throw badRequest('send the chunk as application/octet-stream');
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
    if (!m) throw badRequest('Content-Range: bytes start-end/total is required');
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return withTx(db, async (tx) => {
      const u = await loadUpload(req, true, tx);
      if (u.status !== 'UPLOADING') throw conflict(`upload is ${u.status}`);
      if (total !== Number(u.size_bytes) || end - start + 1 !== chunk.length || end >= total) throw badRequest('Content-Range does not match the chunk or the declared size');
      if (start !== Number(u.received_bytes)) throw conflict(`expected offset ${u.received_bytes}`);
      await store.append(uploadPartKey(u.id), chunk);
      const onDisk = await store.size(uploadPartKey(u.id));
      if (onDisk !== end + 1) throw conflict('storage offset mismatch; restart the upload');
      await tx.query('UPDATE media_uploads SET received_bytes = $2 WHERE id = $1', [u.id, end + 1]);
      return { receivedBytes: end + 1, sizeBytes: total };
    });
  });

  /** Verify size, SHA-256 and real file type, then queue for processing. */
  app.post('/v1/uploads/:id/complete', async (req) => {
    return withTx(db, async (tx) => {
      const u = await loadUpload(req, true, tx);
      if (u.status !== 'UPLOADING') throw conflict(`upload is ${u.status}`);
      const fail = async (msg: string) => {
        await tx.query(`UPDATE media_uploads SET status = 'FAILED', error = $2 WHERE id = $1`, [u.id, msg]);
        await store.remove(uploadPartKey(u.id));
        return { uploadId: u.id, status: 'FAILED', error: msg };
      };
      if (Number(u.received_bytes) !== Number(u.size_bytes)) throw conflict(`received ${u.received_bytes} of ${u.size_bytes} bytes`);
      const hash = createHash('sha256');
      let head = Buffer.alloc(0);
      for await (const c of store.read(uploadPartKey(u.id))) { hash.update(c as Buffer); if (head.length < 16) head = Buffer.concat([head, (c as Buffer).subarray(0, 16)]); }
      if (hash.digest('hex') !== u.sha256) return fail('SHA-256 does not match the declared checksum');
      const type = sniff(head);
      if (!type) return fail('unsupported file type (allowed: MP4, MOV, WebM video; PNG, JPEG images for display ads)');
      if (u.purpose === 'CREATOR_VIDEO' && !isVideo(type)) return fail('creator uploads must be video');
      await tx.query(`UPDATE media_uploads SET status = 'UPLOADED', detected_type = $2, completed_at = now() WHERE id = $1`, [u.id, type]);
      await audit(tx, actorOf(req), 'media.uploaded', { type: 'media_upload', id: u.id, orgId: u.org_id }, { detectedType: type, sizeBytes: u.size_bytes });
      return { uploadId: u.id, status: 'UPLOADED', detectedType: type };
    });
  });

  app.get('/v1/uploads/:id', async (req) => {
    const u = await loadUpload(req);
    const a = await db.query('SELECT id, kind, duration_ms, width, height, has_audio, thumbnail_key FROM media_assets WHERE upload_id = $1', [u.id]);
    const asset = a.rows[0];
    return {
      uploadId: u.id, status: u.status, receivedBytes: String(u.received_bytes), sizeBytes: String(u.size_bytes), detectedType: u.detected_type, error: u.error,
      asset: asset && { id: asset.id, kind: asset.kind, durationMs: asset.duration_ms, width: asset.width, height: asset.height, hasAudio: asset.has_audio, thumbnailUrl: signed(asset.thumbnail_key, 30) },
    };
  });

  // ---------------- signed media delivery (dev/edge reference implementation) ----------------
  app.get('/media/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = decodeURIComponent((req.params as any)['*'] as string);
    const q = req.query as { exp?: string; sig?: string };
    if (!RENDITION_KEY_RE.test(key) || !q.sig || !verifyMediaSignature(key, Number(q.exp), q.sig, config.MEDIA_SIGNING_KEY)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'invalid or expired media link' } });
    const size = await store.size(key);
    if (size === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
    reply.header('content-type', key.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg').header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=300');
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(store.read(key, { start, end }));
    }
    return reply.header('content-length', size).send(store.read(key));
  });

  // ---------------- creators ----------------
  app.post('/v1/creators/register', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({ channelName: z.string().min(2).max(100), email: z.string().email(), displayName: z.string().min(1).max(200), password: z.string().min(12).max(200) }), req.body);
    const out = await withTx(db, async (tx) => {
      if ((await tx.query('SELECT 1 FROM users WHERE email = $1', [b.email])).rows[0]) throw conflict('registration could not be completed with this email');
      const org = await tx.query(`INSERT INTO organizations (kind, name) VALUES ('CREATOR_STUDIO', $1) RETURNING id`, [b.channelName]);
      const u = await tx.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [b.email, await hashPassword(b.password), b.displayName]);
      await tx.query(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'creator_owner')`, [u.rows[0].id, org.rows[0].id]);
      const ch = await tx.query(`INSERT INTO creator_profiles (org_id, display_name) VALUES ($1,$2) RETURNING id`, [org.rows[0].id, b.channelName]);
      await audit(tx, { userId: u.rows[0].id, requestId: req.id }, 'creator.self_registered', { type: 'organization', id: org.rows[0].id, orgId: org.rows[0].id });
      return { organizationId: org.rows[0].id, channelId: ch.rows[0].id, userId: u.rows[0].id };
    });
    reply.code(201);
    return { ...out, note: 'Videos are reviewed by a person before they can appear on tablets. Monetization requires separate eligibility approval.' };
  });

  app.get('/v1/orgs/:orgId/channels', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'creator.read', orgId);
    return { items: (await db.query('SELECT id, display_name, monetization_status, created_at FROM creator_profiles WHERE org_id = $1 ORDER BY created_at', [orgId])).rows };
  });

  app.get('/v1/orgs/:orgId/videos', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await authorize(db, req, 'creator.read', orgId);
    const r = await db.query(
      `SELECT v.id, v.creator_id, v.title, v.status, v.duration_ms, v.created_at,
              (SELECT json_build_object('decision', decision, 'reasons', decision_reasons, 'note', decision_note, 'decidedAt', decided_at)
                 FROM moderation_cases mc WHERE mc.subject_type = 'VIDEO' AND mc.subject_id = v.id AND mc.status = 'DECIDED' ORDER BY decided_at DESC LIMIT 1) AS moderation,
              (SELECT json_agg(json_build_object('id', t.id, 'status', t.status, 'receivedAt', t.received_at, 'work', t.copyrighted_work, 'restoreEligibleAt', t.restore_eligible_at))
                 FROM takedown_notices t WHERE t.video_id = v.id) AS takedowns
         FROM videos v JOIN creator_profiles cp ON cp.id = v.creator_id WHERE cp.org_id = $1 ORDER BY v.created_at DESC`, [orgId]);
    return { items: r.rows };
  });

  /** Submit a video for an uploaded file. Rights attestation is mandatory and stored immutably. */
  app.post('/v1/orgs/:orgId/videos', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const auth = await authorize(db, req, 'creator.manage', orgId);
    const b = parse(z.object({
      channelId: uuid, uploadId: uuid, title: z.string().min(1).max(200), description: z.string().max(5000).optional(),
      attestation: z.object({ statementVersion: z.literal('RIGHTS_ATTESTATION_V1'), ownsOrLicensedAllMedia: z.literal(true), noThirdPartyPlatformContent: z.literal(true), consentOfPeopleShown: z.literal(true), familyFriendly: z.literal(true) }),
    }), req.body);
    const out = await withTx(db, async (tx) => {
      const ch = await tx.query('SELECT id, monetization_status FROM creator_profiles WHERE id = $1 AND org_id = $2', [b.channelId, orgId]);
      if (!ch.rows[0]) throw notFound('channel not found');
      if (['SUSPENDED', 'TERMINATED'].includes(ch.rows[0].monetization_status)) throw forbidden('channel is suspended');
      const up = (await tx.query(`SELECT * FROM media_uploads WHERE id = $1 AND org_id = $2 FOR UPDATE`, [b.uploadId, orgId])).rows[0];
      if (!up || up.purpose !== 'CREATOR_VIDEO') throw notFound('upload not found');
      if (up.status === 'FAILED') throw unprocessable(`upload failed: ${up.error}`);
      const asset = (await tx.query('SELECT * FROM media_assets WHERE upload_id = $1', [up.id])).rows[0];
      const v = await tx.query(
        `INSERT INTO videos (creator_id, title, description, upload_id, status, asset_id, media_key, duration_ms, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.channelId, b.title, b.description ?? null, up.id, asset ? 'PENDING_REVIEW' : 'PROCESSING', asset?.id ?? null, asset?.rendition_key ?? null, asset?.duration_ms ?? null, auth.userId]);
      await tx.query(
        `INSERT INTO rights_attestations (video_id, statement_version, statement_sha256, owns_or_licensed_all_media, no_third_party_platform_content, consent_of_people_shown, family_friendly, attested_by, ip)
         VALUES ($1,'RIGHTS_ATTESTATION_V1',$2,true,true,true,true,$3,$4)`, [v.rows[0].id, ATTESTATION_SHA, auth.userId, req.ip]);
      if (asset) {
        // Media was processed before the video was created: reuse the asset's AI findings plus a fresh screen of the title/description.
        const prior = (await tx.query(`SELECT findings FROM moderation_cases WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset.id])).rows[0];
        const results: ProviderResult[] = [...((prior?.findings?.providers ?? []) as ProviderResult[]), screenText([b.title, b.description ?? ''])];
        const s = summarize(results);
        await tx.query(`INSERT INTO moderation_cases (asset_id, subject_type, subject_id, policy_version, ai_recommendation, priority, scores, findings) VALUES ($1,'VIDEO',$2,$3,$4,$5,$6,$7)`,
          [asset.id, v.rows[0].id, MODERATION_POLICY_VERSION, s.recommendation, s.priority, JSON.stringify(s.scores), JSON.stringify({ ...(prior?.findings ?? {}), providers: results })]);
      }
      await audit(tx, actorOf(req), 'video.submitted', { type: 'video', id: v.rows[0].id, orgId }, { title: b.title, attestation: 'RIGHTS_ATTESTATION_V1' });
      return v.rows[0];
    });
    reply.code(201);
    return { id: out.id, status: out.status, attestationVersion: 'RIGHTS_ATTESTATION_V1' };
  });

  app.get('/v1/rights/attestation', async () => ({ version: 'RIGHTS_ATTESTATION_V1', text: RIGHTS_ATTESTATION_V1, sha256: ATTESTATION_SHA }));

  app.post('/v1/orgs/:orgId/videos/:id/appeal', async (req, reply) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    const auth = await authorize(db, req, 'creator.manage', orgId);
    const b = parse(z.object({ statement: z.string().min(20).max(5000) }), req.body);
    const out = await withTx(db, async (tx) => {
      const v = await videoInOrg(tx, orgId, id);
      if (v.status !== 'REJECTED') throw conflict('only rejected videos can be appealed');
      const c = (await tx.query(`SELECT id FROM moderation_cases WHERE subject_type = 'VIDEO' AND subject_id = $1 AND status = 'DECIDED' ORDER BY decided_at DESC LIMIT 1`, [id])).rows[0];
      if (!c) throw conflict('no moderation decision to appeal');
      const a = await tx.query(`INSERT INTO moderation_appeals (case_id, video_id, appellant, statement) VALUES ($1,$2,$3,$4) RETURNING id, status`, [c.id, id, auth.userId, b.statement]);
      await audit(tx, actorOf(req), 'video.appealed', { type: 'video', id, orgId }, { appealId: a.rows[0].id });
      return a.rows[0];
    });
    reply.code(201);
    return out;
  });

  /** Counter-notice to a copyright takedown. Restoration becomes possible after 10 business days unless the complainant reports court action. */
  app.post('/v1/orgs/:orgId/videos/:id/counter-notice', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    const auth = await authorize(db, req, 'creator.manage', orgId);
    const b = parse(z.object({ takedownId: uuid, statement: z.string().min(20).max(5000), signature: z.string().min(2).max(200),
      goodFaithBeliefOfMistake: z.literal(true), consentToJurisdiction: z.literal(true) }), req.body);
    return withTx(db, async (tx) => {
      await videoInOrg(tx, orgId, id);
      const t = (await tx.query(`SELECT * FROM takedown_notices WHERE id = $1 AND video_id = $2 FOR UPDATE`, [b.takedownId, id])).rows[0];
      if (!t) throw notFound('notice not found');
      if (t.status !== 'ACTIONED') throw conflict(`notice is ${t.status}`);
      const eligible = addBusinessDays(new Date(), 10);
      const u = await tx.query(
        `UPDATE takedown_notices SET status = 'COUNTER_NOTICED', counter_statement = $2, counter_signature = $3, counter_by = $4, counter_received_at = now(), restore_eligible_at = $5
          WHERE id = $1 RETURNING id, status, restore_eligible_at`, [t.id, b.statement, b.signature, auth.userId, eligible]);
      await audit(tx, actorOf(req), 'takedown.counter_noticed', { type: 'takedown_notice', id: t.id, orgId }, { videoId: id });
      return u.rows[0];
    });
  });

  // ---------------- human moderation ----------------
  app.get('/v1/moderation/queue', async (req) => {
    await authorize(db, req, 'content.review');
    const r = await db.query(
      `SELECT mc.id, mc.subject_type, mc.subject_id, mc.ai_recommendation, mc.priority, mc.scores, mc.findings, mc.created_at,
              a.rendition_key, a.thumbnail_key, a.duration_ms, v.title, v.description, cp.display_name AS channel, cp.org_id AS creator_org_id
         FROM moderation_cases mc JOIN media_assets a ON a.id = mc.asset_id
         LEFT JOIN videos v ON mc.subject_type = 'VIDEO' AND v.id = mc.subject_id
         LEFT JOIN creator_profiles cp ON cp.id = v.creator_id
        WHERE mc.status = 'OPEN' AND mc.subject_type = 'VIDEO' ORDER BY (mc.priority = 'HIGH') DESC, mc.created_at LIMIT 200`);
    return { items: r.rows.map((x) => ({ ...x, renditionUrl: signed(x.rendition_key, 30), thumbnailUrl: signed(x.thumbnail_key, 30), rendition_key: undefined, thumbnail_key: undefined })) };
  });

  app.post('/v1/moderation/cases/:id/decision', async (req) => {
    const auth = await authorize(db, req, 'content.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), reasons: z.array(z.enum(POLICY_REASONS)).max(10).default([]), note: z.string().min(5).max(2000) }), req.body);
    if (b.decision === 'REJECT' && b.reasons.length === 0) throw badRequest('a rejection must cite at least one policy reason');
    return withTx(db, async (tx) => {
      const c = (await tx.query('SELECT * FROM moderation_cases WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!c) throw notFound('case not found');
      if (c.status !== 'OPEN') throw conflict('case already decided');
      if (c.subject_type !== 'VIDEO') throw conflict('creative assets are decided in the campaign review queue');
      const v = (await tx.query(`SELECT v.*, cp.org_id FROM videos v JOIN creator_profiles cp ON cp.id = v.creator_id WHERE v.id = $1 FOR UPDATE OF v`, [c.subject_id])).rows[0];
      if ((await tx.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'ACTIVE'`, [auth.userId, v.org_id])).rows[0]) throw conflict('reviewers cannot decide content from an organization they belong to');
      await tx.query(`UPDATE moderation_cases SET status = 'DECIDED', decision = $2, decision_reasons = $3, decision_note = $4, decided_by = $5, decided_at = now() WHERE id = $1`,
        [id, b.decision, b.reasons, b.note, auth.userId]);
      await tx.query(`UPDATE videos SET status = $2 WHERE id = $1`, [v.id, b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED']);
      await audit(tx, actorOf(req), `moderation.${b.decision.toLowerCase()}`, { type: 'video', id: v.id, orgId: v.org_id }, { caseId: id, reasons: b.reasons, aiRecommendation: c.ai_recommendation });
      return { caseId: id, videoId: v.id, videoStatus: b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
    });
  });

  app.get('/v1/moderation/appeals', async (req) => {
    await authorize(db, req, 'content.review');
    return { items: (await db.query(`SELECT a.*, mc.decision_reasons, mc.decision_note, mc.decided_by AS original_reviewer FROM moderation_appeals a JOIN moderation_cases mc ON mc.id = a.case_id WHERE a.status = 'OPEN' ORDER BY a.created_at`)).rows };
  });

  app.post('/v1/moderation/appeals/:id/decision', async (req) => {
    const auth = await authorize(db, req, 'content.review');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['UPHOLD', 'OVERTURN']), note: z.string().min(5).max(2000) }), req.body);
    return withTx(db, async (tx) => {
      const a = (await tx.query(`SELECT a.*, mc.decided_by AS original_reviewer FROM moderation_appeals a JOIN moderation_cases mc ON mc.id = a.case_id WHERE a.id = $1 FOR UPDATE OF a`, [id])).rows[0];
      if (!a) throw notFound('appeal not found');
      if (a.status !== 'OPEN') throw conflict('appeal already decided');
      if (a.original_reviewer === auth.userId) throw forbidden('an appeal must be decided by a different reviewer', 'SEPARATION_OF_DUTIES');
      await tx.query(`UPDATE moderation_appeals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [id, b.decision === 'OVERTURN' ? 'OVERTURNED' : 'UPHELD', auth.userId, b.note]);
      if (b.decision === 'OVERTURN') await tx.query(`UPDATE videos SET status = 'APPROVED' WHERE id = $1 AND status = 'REJECTED'`, [a.video_id]);
      await audit(tx, actorOf(req), `moderation.appeal_${b.decision.toLowerCase()}`, { type: 'video', id: a.video_id }, { appealId: id, note: b.note });
      return { appealId: id, status: b.decision === 'OVERTURN' ? 'OVERTURNED' : 'UPHELD' };
    });
  });

  // ---------------- copyright takedowns ----------------
  /** Public notice intake. The video is removed from tablets immediately (status TAKEN_DOWN) pending counter-notice. */
  app.post('/v1/takedowns', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({
      videoId: uuid, complainantName: z.string().min(2).max(200), complainantEmail: z.string().email(), complainantAddress: z.string().min(5).max(500),
      copyrightedWork: z.string().min(5).max(2000), goodFaithStatement: z.literal(true), accuracyUnderPenaltyOfPerjury: z.literal(true), signature: z.string().min(2).max(200),
    }), req.body);
    const out = await withTx(db, async (tx) => {
      const v = (await tx.query(`SELECT v.id, v.status, cp.org_id FROM videos v JOIN creator_profiles cp ON cp.id = v.creator_id WHERE v.id = $1 FOR UPDATE OF v`, [b.videoId])).rows[0];
      if (!v) throw notFound('video not found');
      const t = await tx.query(
        `INSERT INTO takedown_notices (video_id, complainant_name, complainant_email, complainant_address, copyrighted_work, good_faith_statement, accuracy_under_penalty, signature, video_status_before)
         VALUES ($1,$2,$3,$4,$5,true,true,$6,$7) RETURNING id, status, received_at`,
        [v.id, b.complainantName, b.complainantEmail, b.complainantAddress, b.copyrightedWork, b.signature, v.status]);
      if (v.status === 'APPROVED') await tx.query(`UPDATE videos SET status = 'TAKEN_DOWN' WHERE id = $1`, [v.id]);
      await audit(tx, { requestId: req.id }, 'takedown.received', { type: 'video', id: v.id, orgId: v.org_id }, { noticeId: t.rows[0].id });
      return t.rows[0];
    });
    reply.code(201);
    return { noticeId: out.id, status: out.status, receivedAt: out.received_at };
  });

  app.get('/v1/takedowns', async (req) => {
    await authorize(db, req, 'takedown.manage');
    const r = await db.query(
      `SELECT t.*, v.title, v.creator_id,
              (SELECT count(*)::int FROM takedown_notices t2 JOIN videos v2 ON v2.id = t2.video_id WHERE v2.creator_id = v.creator_id AND t2.status IN ('ACTIONED','UPHELD')) AS creator_open_strikes
         FROM takedown_notices t JOIN videos v ON v.id = t.video_id ORDER BY t.received_at DESC LIMIT 200`);
    return { items: r.rows };
  });

  app.post('/v1/takedowns/:id/resolve', async (req) => {
    const auth = await authorize(db, req, 'takedown.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ action: z.enum(['RESTORE', 'UPHOLD', 'WITHDRAWN']), note: z.string().min(5).max(2000) }), req.body);
    return withTx(db, async (tx) => {
      const t = (await tx.query('SELECT * FROM takedown_notices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t) throw notFound('notice not found');
      if (!['ACTIONED', 'COUNTER_NOTICED'].includes(t.status)) throw conflict(`notice is ${t.status}`);
      if (b.action === 'RESTORE') {
        if (t.status !== 'COUNTER_NOTICED') throw conflict('restoration requires a counter-notice');
        if (new Date(t.restore_eligible_at) > new Date()) throw conflict(`restoration is not allowed before ${new Date(t.restore_eligible_at).toISOString()}`);
      }
      const status = b.action === 'RESTORE' ? 'RESTORED' : b.action === 'UPHOLD' ? 'UPHELD' : 'WITHDRAWN';
      await tx.query(`UPDATE takedown_notices SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE id = $1`, [id, status, auth.userId, b.note]);
      if (b.action !== 'UPHOLD' && t.video_status_before === 'APPROVED') {
        const other = await tx.query(`SELECT 1 FROM takedown_notices WHERE video_id = $1 AND id <> $2 AND status IN ('ACTIONED','COUNTER_NOTICED','UPHELD')`, [t.video_id, id]);
        if (!other.rows[0]) await tx.query(`UPDATE videos SET status = 'APPROVED' WHERE id = $1 AND status = 'TAKEN_DOWN'`, [t.video_id]);
      }
      await audit(tx, actorOf(req), `takedown.${status.toLowerCase()}`, { type: 'takedown_notice', id }, { videoId: t.video_id, note: b.note });
      return { noticeId: id, status };
    });
  });
}
