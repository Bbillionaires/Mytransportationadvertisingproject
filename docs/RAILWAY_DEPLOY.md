# Deploying to Railway

> Status: deployment files are built and tested locally (production image, production mode, migrations, first-admin setup). **No Railway project for this app exists yet.** Creating one starts billing on the product owner's Railway account and needs their go-ahead.

## Project layout (one Railway project, e.g. `rideshare-media`)
| Service | Source | Start command | Notes |
|---|---|---|---|
| **Postgres** | Railway Postgres template | — | Daily backups on; PITR when available |
| **media** (bucket) | Railway Bucket | — | Region closest to the first city; see docs/MEDIA_STORAGE.md |
| **api** | this repo (`railway.json`, image `infra/app/Dockerfile`) | default (`node --import tsx src/server.ts`) | Public domain; runs migrations before each deploy; health check `/readyz` |
| **worker** | same repo/image | `npm run jobs:worker` | Always on: media processing, backups, webhooks, email, validation |
| **allocate-windows** (cron) | same | `npm run jobs:allocate-windows` | Hourly (`5 * * * *`); alert on failure |
| **allocate-commissions** (cron) | same | `npm run jobs:allocate-commissions` | Daily |
| **verify-media** (cron) | same | `npm run jobs:verify-media` | Nightly; add a monthly `-- --deep` |
| **verify-spend-counters** (cron) | same | `npm run jobs:verify-spend-counters` | Nightly |

Cron services must exit when done; all these commands do. Turn the pre-deploy migration off for every service except **api**, so migrations run once per deploy.

## Variables (api and worker; cron services need the database and storage ones)
| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (set in the image) |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`. The private `*.railway.internal` address is accepted without `sslmode`, because Railway's private network is encrypted |
| `APP_PUBLIC_URL` | the api's public URL, e.g. `https://rides.example.com` |
| `APP_ENCRYPTION_KEY`, `MEDIA_SIGNING_KEY` | each `openssl rand -base64 32`; **sealed** |
| `PAYMENTS_PROVIDER` | `disabled` until Stripe is connected (Stripe is last, by the product owner's choice). Checkout then says "Payments are not enabled yet", and webhooks are refused |
| `MEDIA_STORE` + `MEDIA_S3_*` | from the `media` bucket (docs/MEDIA_STORAGE.md) |
| `BACKUP1_S3_*` | AWS backup bucket and key, **sealed**. Worker and verify-media only |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY` | `resend`, e.g. `Rides <no-reply@mail.example.com>` (a domain verified in Resend with SPF/DKIM), and the API key, **sealed**. Worker only |
| `METRICS_TOKEN` | random 32+ characters, to scrape `/metrics` |
| `LOG_LEVEL` | `info` |

## First deploy
1. Create the project, Postgres, the `media` bucket, and the **api** service from the GitHub repo, then set the variables. Railway builds `infra/app/Dockerfile`, runs `npm run db:migrate`, and starts the API.
2. Open a shell on **api** (`railway ssh`, or a one-off command) and create the first admin:
   ```bash
   npm run jobs:bootstrap-admin -- --email you@company.com --name "Your Name"
   ```
   It prints a single-use, 30-minute link. Open it, choose a password, sign in, and turn on two-step verification under **Security**. Later staff are invited from the portal. The command refuses to run once a super admin exists.
3. Run `npm run jobs:check-media-storage` and make sure every line is PASS.
4. Add the **worker** and the cron services.
5. In the portal: draft the real revenue rules and have them approved by two different approvers with signed contract references. Then invite fleets, advertisers and creators.

## Not yet available in production
- **Email** (D-044): the Resend adapter is built. Until a sending domain is verified and `EMAIL_PROVIDER=resend` is set, emails are not sent: production logs show only the recipient and subject (bodies hold one-time links, so they are withheld). Don't invite real users until email works. The bootstrap link is printed directly, so the first admin doesn't need email.
- **Payments**: disabled until the Stripe test-mode round trip (R-025), and live mode stays locked (D-010).
- **Seed data**: `db:seed` refuses to run in production by design.

## Verified locally
The image `infra/app/Dockerfile` was built and run in production mode against PostgreSQL:
- migrations ran
- `/readyz` was healthy
- the portal, player and rider app were served
- the first admin was created, chose a password and signed in
- checkout was refused with "payments not enabled"
- the worker started, and a second bootstrap was refused

`test/deploy.test.ts` covers the bootstrap, disabled payments and the database rules in CI.
