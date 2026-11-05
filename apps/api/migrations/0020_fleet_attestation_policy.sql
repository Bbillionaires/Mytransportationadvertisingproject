-- Per-fleet "verified tablets only" (D-059): a fleet can require hardware-verified tablets even while the network
-- default (DEVICE_ATTESTATION) is optional.
ALTER TABLE organizations ADD COLUMN require_hardware_attestation boolean NOT NULL DEFAULT false;
