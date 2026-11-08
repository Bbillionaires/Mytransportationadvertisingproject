import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  /** 32-byte key, base64. Encrypts MFA secrets at rest. Load from a secret manager in production. */
  APP_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY must be 32 bytes base64'),
  /**
   * Key rotation (R-016, docs/KEY_ROTATION.md): the previous key(s), comma-separated, kept only until
   * jobs:rotate-encryption-key reports nothing left on them. Used to decrypt, never to encrypt.
   */
  APP_ENCRYPTION_KEY_PREVIOUS: z.string().optional().refine((v) => !v || v.split(',').every((k) => Buffer.from(k.trim(), 'base64').length === 32), 'each APP_ENCRYPTION_KEY_PREVIOUS entry must be 32 bytes base64'),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(480),
  DEVICE_CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.string().default('info'),
  /** A campaign window may be allocated only after it has been closed this long, so in-flight events arrive. */
  ALLOCATION_SETTLE_MINUTES: z.coerce.number().int().min(0).default(60),
  /** Scheduled windows end on a boundary of this many minutes (60 = whole hours). */
  ALLOCATION_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  /** 32-byte base64 HMAC key for signed, expiring media URLs (shared with the CDN edge verifier). */
  MEDIA_SIGNING_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MEDIA_SIGNING_KEY must be 32 bytes base64'),
  MEDIA_BASE_URL: z.string().url().default('https://media.invalid'),
  PLAYLIST_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  /** Local media storage root (dev/test). Production uses an object-store adapter with the same interface. */
  MEDIA_ROOT: z.string().default('./var/media'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  /**
   * Media object storage (R-021). 'local' = MEDIA_ROOT on disk (development/tests); 's3' = an S3-compatible bucket
   * (production: a Railway bucket — map ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY from the bucket).
   */
  MEDIA_STORE: z.enum(['local', 's3']).default('local'),
  MEDIA_S3_ENDPOINT: z.string().url().optional(),
  MEDIA_S3_REGION: z.string().default('auto'),
  MEDIA_S3_BUCKET: z.string().optional(),
  MEDIA_S3_ACCESS_KEY_ID: z.string().optional(),
  MEDIA_S3_SECRET_ACCESS_KEY: z.string().optional(),
  MEDIA_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  /** Up to two backup buckets for original uploads (e.g. AWS S3 with Object Lock). Endpoint empty = AWS. */
  BACKUP1_S3_ENDPOINT: z.string().url().optional(), BACKUP1_S3_REGION: z.string().optional(), BACKUP1_S3_BUCKET: z.string().optional(),
  BACKUP1_S3_ACCESS_KEY_ID: z.string().optional(), BACKUP1_S3_SECRET_ACCESS_KEY: z.string().optional(), BACKUP1_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  /** e.g. GLACIER_IR on AWS (instant reads, ~$0.004/GB-month). DEEP_ARCHIVE is not supported: restores would need a 12 h thaw. */
  BACKUP1_S3_STORAGE_CLASS: z.enum(['STANDARD', 'STANDARD_IA', 'GLACIER_IR']).optional(),
  BACKUP2_S3_ENDPOINT: z.string().url().optional(), BACKUP2_S3_REGION: z.string().optional(), BACKUP2_S3_BUCKET: z.string().optional(),
  BACKUP2_S3_ACCESS_KEY_ID: z.string().optional(), BACKUP2_S3_SECRET_ACCESS_KEY: z.string().optional(), BACKUP2_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  /** e.g. GLACIER_IR on AWS (instant reads, ~$0.004/GB-month). DEEP_ARCHIVE is not supported: restores would need a 12 h thaw. */
  BACKUP2_S3_STORAGE_CLASS: z.enum(['STANDARD', 'STANDARD_IA', 'GLACIER_IR']).optional(),
  /** Opt-in only: let the AI pre-screen auto-approve. Disabled by default; a human decides every case (D-034). */
  MODERATION_AUTO_APPROVE: z.enum(['false']).default('false'),
  /** 'fake' = in-process Stripe stand-in (dev/demo/tests); 'stripe' = Stripe API with a TEST key. */
  PAYMENTS_PROVIDER: z.enum(['fake', 'stripe', 'disabled']).default('fake'),
  STRIPE_SECRET_KEY: z.string().regex(/^sk_test_[A-Za-z0-9]+$/, 'only Stripe test keys (sk_test_…) are accepted').optional(),
  /** Required unless PAYMENTS_PROVIDER=disabled. */
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/, 'STRIPE_WEBHOOK_SECRET must look like whsec_…').optional(),
  /** Stripe Price for the $30/month driver participation subscription. */
  STRIPE_DRIVER_PRICE_ID: z.string().default('price_driver_participation_test'),
  APP_PUBLIC_URL: z.string().url().default('http://127.0.0.1:8080'),
  /** Bearer token for GET /metrics (Prometheus). Unset = endpoint disabled. */
  METRICS_TOKEN: z.string().min(24).optional(),
  /** Seconds-scale cache of each campaign's budget decision for playlists (0 disables; tests use 0). See playlist.ts. */
  PLAYLIST_BUDGET_CACHE_MS: z.coerce.number().int().min(0).max(60_000).optional(),
  /** Outgoing email (D-044). 'log' = development (production: recipients only, never bodies); 'resend' = Resend API. */
  /**
   * Android hardware key attestation at enrollment (R-028). optional: verify and record when the tablet sends it (web
   * players and older shells still enroll); required: refuse tablets without a valid hardware attestation, verified
   * boot and a locked bootloader; off: ignore it.
   */
  DEVICE_ATTESTATION: z.enum(['off', 'optional', 'required']).default('optional'),
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]+$/, 'RESEND_API_KEY must look like re_…').optional(),
  /** Sender address on a domain verified in Resend, e.g. "Rideshare Media <no-reply@rides.example.com>". */
  EMAIL_FROM: z.string().min(3).max(200).optional(),
  RESEND_API_URL: z.string().url().default('https://api.resend.com'),
  /** Development only: run media/webhook/email/validation jobs inside the API process. */
  DEV_IN_PROCESS_JOBS: z.enum(['true', 'false']).default('false'),
  /** Live money movement is hard-disabled until explicitly approved (see DECISIONS.md D-010). */
  LIVE_PAYMENTS_ENABLED: z.enum(['false']).default('false'),
});

/** Current key first, then previous keys: what decrypt() may use. */
export const encryptionKeys = (c: { APP_ENCRYPTION_KEY: string; APP_ENCRYPTION_KEY_PREVIOUS?: string }): string[] =>
  [c.APP_ENCRYPTION_KEY, ...(c.APP_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((k) => k.trim()).filter(Boolean)];

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid configuration: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  // Remote databases need TLS in production — except Railway's private network (*.railway.internal), which is an
  // encrypted WireGuard mesh reachable only from the project's own services.
  const dbHost = (() => { try { return new URL(parsed.data.DATABASE_URL).hostname; } catch { return ''; } })();
  if (parsed.data.NODE_ENV === 'production' && !/^(localhost|127\.0\.0\.1)$/.test(dbHost) && !dbHost.endsWith('.railway.internal') && !/sslmode=require|sslmode=verify/.test(parsed.data.DATABASE_URL)) {
    throw new Error('Production DATABASE_URL must require TLS (sslmode=require or verify-full)');
  }
  if (parsed.data.PAYMENTS_PROVIDER !== 'disabled' && !parsed.data.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required unless PAYMENTS_PROVIDER=disabled');
  if (parsed.data.PAYMENTS_PROVIDER === 'stripe' && !parsed.data.STRIPE_SECRET_KEY) throw new Error('PAYMENTS_PROVIDER=stripe requires STRIPE_SECRET_KEY (test mode)');
  if (parsed.data.NODE_ENV === 'production' && parsed.data.PAYMENTS_PROVIDER === 'fake') throw new Error('the fake payment provider cannot run in production');
  if (parsed.data.MEDIA_STORE === 's3' && !(parsed.data.MEDIA_S3_BUCKET && parsed.data.MEDIA_S3_ACCESS_KEY_ID && parsed.data.MEDIA_S3_SECRET_ACCESS_KEY)) throw new Error('MEDIA_STORE=s3 requires MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY');
  if (parsed.data.EMAIL_PROVIDER === 'resend' && !(parsed.data.RESEND_API_KEY && parsed.data.EMAIL_FROM)) throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
  parsed.data.PLAYLIST_BUDGET_CACHE_MS ??= parsed.data.NODE_ENV === 'test' ? 0 : 5000;
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_IN_PROCESS_JOBS === 'true') throw new Error('DEV_IN_PROCESS_JOBS cannot be used in production');
  return parsed.data;
}
