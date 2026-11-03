import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  /** 32-byte key, base64. Encrypts MFA secrets at rest. Load from a secret manager in production. */
  APP_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY must be 32 bytes base64'),
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
  /** Opt-in only: let the AI pre-screen auto-approve. Disabled by default; a human decides every case (D-034). */
  MODERATION_AUTO_APPROVE: z.enum(['false']).default('false'),
  /** Live money movement is hard-disabled until explicitly approved (see DECISIONS.md D-010). */
  LIVE_PAYMENTS_ENABLED: z.enum(['false']).default('false'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid configuration: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  if (parsed.data.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/.test(parsed.data.DATABASE_URL) === false && !/sslmode=require|sslmode=verify/.test(parsed.data.DATABASE_URL)) {
    throw new Error('Production DATABASE_URL must require TLS (sslmode=require or verify-full)');
  }
  return parsed.data;
}
