# Threat Model (STRIDE, Phase 1 scope + planned)

Assets, in priority order: money and payable balances; ledger integrity; personal data (riders, drivers, creators); advertiser confidential data; device fleet control; content integrity (family-friendly guarantee).

| Threat | Vector | Control (✅ implemented, ⬜ planned) |
|---|---|---|
| **S**poofed user | credential stuffing, phishing | ✅ scrypt hashes, uniform errors, dummy-hash timing, lockout after 10 failures, login rate limit, TOTP MFA for privileged permissions · ⬜ WebAuthn for finance admins, breached-password check |
| Spoofed device | cloned tablet, forged heartbeats or impressions | ✅ per-device Ed25519 key, one-time enrollment codes, signed requests, nonce replay table, clock-skew window · ⬜ Play Integrity attestation, Keystore-backed keys |
| **T**ampered ledger | SQL access, buggy code, malicious insider | ✅ immutability triggers, deferred balance check, period guard, dual control, hash-chained audit · ⬜ non-owner runtime DB role (R-002), external hash anchoring |
| Tampered rules | changing splits retroactively | ✅ frozen approved versions, future-only supersession, GiST no-overlap, two approvers |
| Replay | duplicate webhooks/conversions/clicks/heartbeats | ✅ idempotency keys + payload hash, device nonces, allocation source dedupe · ⬜ webhook inbox unique event id, conversion dedupe by advertiser order id |
| **R**epudiation | "I didn't approve that" | ✅ audit log with actor, impersonator, request id; posted_by/approved_by on entries |
| **I**nformation disclosure | cross-tenant reads, advertiser competitive data | ✅ server-side authorization on every route, composite tenant FKs, 403/404 behavior, cross-tenant tests · ⬜ Postgres RLS (R-003), field-level encryption for payout/tax identifiers |
| Secret leakage | logs, repo | ✅ log redaction of auth/signature headers, MFA secrets AES-GCM encrypted, session tokens hashed, `.env` git-ignored, placeholder-only `.env.example` |
| **D**oS | login floods, large bodies | ✅ global and per-route rate limits, 1 MB body limit · ⬜ WAF, per-device quotas |
| **E**levation of privilege | granting platform roles from a tenant, impersonating into finance | ✅ role/org-kind trigger, platform roles need `platform.users.manage`, privileged perms blocked while impersonating |
| Fraudulent earnings | farming views/clicks, idle tablets | ⬜ Phase 2: validated vs raw events, anti-idle, repeated-click heuristics, holds; ✅ eligibility from DB only, ineligible recipients never paid |
| Payout fraud | changing bank details, draining payables | ⬜ Phase 4: provider-hosted onboarding (no bank data stored), dual-approved payout batches, payout ≤ payable, cooling-off after detail change |
| Unsafe content | profanity, adult content reaching children | ⬜ Phase 2: fail-closed moderation (AI → human), versioned policy decisions, appeal log |
| Webview abuse | ad landing page escapes kiosk or phishes | ⬜ Phase 2: restricted webview, allow-listed schemes, no file/JS bridges, always-visible return control |
| Web console XSS/clickjacking | admin shell | ✅ output escaping, CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`; token in sessionStorage (⬜ move to HttpOnly SameSite cookie + CSRF token before production) |
