# Deploying to Railway

> Status (2026-11-05): **live pilot project `rideshare-media`** on the product owner's Railway account, created with their go-ahead. The API answers at `https://api-production-81031.up.railway.app` (portal at `/portal/`), deploying branch `claude/new-session-rjqusc`. Postgres and the `media` bucket (US East, `iad`) are provisioned. Email and payments are off. Next: first admin, the AWS backup bucket, then the cron services.
>
> Railway has deprecated `railway.json` (config as code), so it is **not applied**. Every setting below is set on the service itself (Settings tab).

## Project layout (one Railway project, e.g. `rideshare-media`)
| Service | Source | Start command | Notes |
|---|---|---|---|
| **Postgres** | Railway Postgres template | — | Daily backups on; PITR when available |
| **media** (bucket) | Railway Bucket | — | Region closest to the first city; see docs/MEDIA_STORAGE.md |
| **api** | this repo, Dockerfile `infra/app/Dockerfile` | default (`node --import tsx src/server.ts`) | Public domain (port 8080); **pre-deploy command** `npm run db:migrate`; health check `/readyz`; `HOST=::` |
| **worker** | same repo/image | `node --import tsx src/jobs/worker.ts` | Always on (restart: always); no pre-deploy command, no health check. Holds the backup keys |
| **allocate-windows** (cron) | same | `node --import tsx src/jobs/allocate-windows.ts` | Hourly (`5 * * * *`); alert on failure |
| **allocate-commissions** (cron) | same | `node --import tsx src/jobs/allocate-commissions.ts` | Daily `20 7 * * *` (UTC) |
| ~~verify-media (cron)~~ | — | — | Runs **inside the worker** once a day, because only the worker holds the backup keys. Failures are logged as errors. Run `jobs:verify-media -- --deep` by hand monthly |
| **verify-spend-counters** (cron) | same | `node --import tsx src/jobs/verify-spend-counters.ts` | Nightly `40 7 * * *` (UTC) |
| **check-attestation-roots** (cron) | same | `node --import tsx src/jobs/check-attestation-roots.ts` | Weekly `10 8 * * 1` (UTC); failure = Google published a new root to pin |

Start jobs with `node --import tsx …` rather than `npm run …`: npm reports every normal stop as an error and doesn't pass the stop signal on cleanly. Cron services must exit when done; all these commands do. Set the **pre-deploy command** (`npm run db:migrate`) and the `/readyz` health check on **api** only, so migrations run once per deploy and job services aren't health-checked over HTTP.

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
| `DEVICE_ATTESTATION` | `optional` for the pilot; `required` once every tablet runs the Android shell (D-059) |
| `METRICS_TOKEN` | random 32+ characters, to scrape `/metrics` |
| `LOG_LEVEL` | `info` |

## First deploy
1. Create the project, Postgres, the `media` bucket, and the **api** service from the GitHub repo, then set the variables. Railway builds `infra/app/Dockerfile`, runs `npm run db:migrate`, and starts the API.
2. Create the first admin **without a terminal**: on the **worker**, add `BOOTSTRAP_ADMIN_EMAIL` (your email) and optionally `BOOTSTRAP_ADMIN_NAME`. On restart the worker logs `FIRST ADMIN: open this single-use link…`. Open it within 30 minutes, choose a password, sign in, and turn on two-step verification under **Security**. If the link expires, restart the worker for a fresh one (same email only, and only until a password has been chosen). Then delete the two variables. With a shell (`railway ssh`), `npm run jobs:bootstrap-admin -- --email you@company.com --name "Your Name"` does the same.
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
