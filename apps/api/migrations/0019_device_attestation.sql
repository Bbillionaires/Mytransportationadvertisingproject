-- Android hardware key attestation at enrollment (R-028, D-059).
-- A single-use challenge is issued per enrollment code; the shell bakes it into its key's attestation certificate.
ALTER TABLE device_enrollment_codes
  ADD COLUMN attestation_challenge bytea,
  ADD COLUMN challenge_expires_at  timestamptz;

-- NONE: no attestation (web player or older shell). VERIFIED: hardware key, verified boot, locked bootloader.
-- UNTRUSTED_BOOT: hardware key, but the bootloader is unlocked or boot is not verified. FAILED: chain did not verify.
ALTER TABLE devices
  ADD COLUMN attestation_status         text NOT NULL DEFAULT 'NONE' CHECK (attestation_status IN ('NONE','VERIFIED','UNTRUSTED_BOOT','FAILED')),
  ADD COLUMN attestation_security_level text CHECK (attestation_security_level IN ('TRUSTED_ENVIRONMENT','STRONGBOX')),
  ADD COLUMN attestation_boot_state     text,
  ADD COLUMN attestation_failure        text,
  ADD COLUMN attested_at                timestamptz;
