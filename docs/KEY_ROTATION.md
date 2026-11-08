# Rotating keys and secrets (R-016)

Rotate a key when it may have been seen by someone who shouldn't have it (pasted in chat or email, shown on screen, a
former team member), and otherwise about once a year. All values live in Railway → project **rideshare-media** →
service → **Variables**. Seal them after setting (⋮ → **Seal**).

New random keys: sign in to the portal as the super admin → **Security** → **Generate an encryption key**. The key is
made on your device and is never sent anywhere. Copy it straight into Railway.

The job services (`worker`, `allocate-*`, `verify-spend-counters`, `check-attestation-roots`) reference the **api**
service's `APP_ENCRYPTION_KEY` and `MEDIA_SIGNING_KEY` (`${{api.…}}`), so you change those on **api** only.

## APP_ENCRYPTION_KEY (encrypts two-step verification secrets and rider pairing tokens)
Never just replace it: everyone's two-step codes would stop working. Instead:
1. On **api**, add `APP_ENCRYPTION_KEY_PREVIOUS` = the current key. If the old value is sealed and you can't copy it,
   don't change anything; ask for help first.
2. Set `APP_ENCRYPTION_KEY` to the newly generated key. Add `APP_ENCRYPTION_KEY_PREVIOUS` = `${{api.APP_ENCRYPTION_KEY_PREVIOUS}}`
   on the **worker** and job services. Let them redeploy. Sign-in keeps working: old values are read with the previous
   key, new ones are written with the new key.
3. Re-encrypt everything under the new key. **No terminal needed:** whenever `APP_ENCRYPTION_KEY_PREVIOUS` is set, the
   **worker** does it on start and logs `KEY ROTATION complete: … you can now delete APP_ENCRYPTION_KEY_PREVIOUS`
   (or `KEY ROTATION incomplete` with counts). It is safe while the app is serving and safe to repeat (restart the
   worker). With a shell: `node --import tsx src/jobs/rotate-encryption-key.ts [--check]`.
4. Only then delete `APP_ENCRYPTION_KEY_PREVIOUS` everywhere.

If `unreadable` is not 0, keep the previous key and investigate before removing anything.

Tested end to end in `apps/api/test/keyrotation.test.ts`: a staff member's two-step sign-in works on the old key,
during the switch, after re-encryption, and after the old key is removed.

## MEDIA_SIGNING_KEY
Only signs links for media stored on local disk. Production stores media in the Railway bucket, which uses the
bucket's own signed links, so this key can simply be replaced on **api** (existing local links expire within minutes).

## METRICS_TOKEN
Replace it on **api**, then update whatever scrapes `/metrics`.

## AWS backup key (`BACKUP1_S3_ACCESS_KEY_ID` / `BACKUP1_S3_SECRET_ACCESS_KEY`, worker only)
1. AWS → IAM → Users → `rmn-media-backup` → **Create access key** (a user can have two at once).
2. Put the new pair into the **worker**'s variables yourself (not into chat), seal them, and let it redeploy.
3. Check the worker logs show no backup errors for a few minutes (backups run every 5 minutes).
4. AWS → the old key → **Deactivate**, wait a day, then **Delete**.

## Railway bucket and database credentials
- Bucket (`media`): Railway → bucket → **Credentials** → reset. Services reference `${{media.…}}`, so they pick up the
  new values on their next deploy (redeploy api and worker).
- Postgres password: Railway's Postgres service → regenerate the password, then redeploy services that use
  `${{Postgres.DATABASE_URL}}`.
