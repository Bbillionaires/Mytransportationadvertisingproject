-- Database-enforced tenant isolation (R-003), defense in depth behind the application's own checks.
--
-- 1. A restricted runtime role. The API switches to it on every connection (SET ROLE, see db/pool.ts), so it is
--    neither a superuser nor a table owner: row-level security applies, and it cannot ALTER/DISABLE triggers (R-002).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rmn_app') THEN
    CREATE ROLE rmn_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not create role rmn_app; create it once as an administrator (see docs/DEPLOYMENT.md)';
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT rmn_app TO %I', current_user);   -- lets the login role SET ROLE rmn_app
EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
  RAISE NOTICE 'could not grant rmn_app to %', current_user;
END $$;

GRANT USAGE ON SCHEMA public TO rmn_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rmn_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO rmn_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rmn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rmn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO rmn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO rmn_app;
-- Ledger history is append-only: the runtime role never deletes journal rows or audit entries (triggers also forbid it).
REVOKE DELETE ON journal_entries, journal_lines, audit_log FROM rmn_app;

-- 2. Request scope, set per connection checkout by the API from the signed-in user's memberships:
--      ''                     system context (jobs, tablets, riders, integration keys, sign-in) — unrestricted
--      'platform'             platform staff — all tenants (staff access is permission-checked and audited)
--      'tenant:<uuid>,<uuid>' a business user — only these organizations
--    Anything else matches nothing (fail closed).
CREATE FUNCTION rmn_org_visible(org uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE s text := coalesce(current_setting('rmn.scope', true), '');
BEGIN
  IF s = '' OR s = 'platform' THEN RETURN true; END IF;
  IF s LIKE 'tenant:%' THEN RETURN org = ANY (string_to_array(substr(s, 8), ',')::uuid[]); END IF;
  RETURN false;
END $$;

-- 3. Policies. FORCE makes them apply to the table owner too.
DO $$
DECLARE t text; col text;
BEGIN
  FOR t, col IN VALUES
    ('fleets','org_id'), ('vehicles','org_id'), ('devices','org_id'), ('device_enrollment_codes','org_id'), ('device_assignments','org_id'),
    ('device_commands','org_id'), ('drivers','org_id'), ('invitations','org_id'), ('memberships','org_id'), ('integration_keys','org_id'),
    ('media_uploads','org_id'), ('media_assets','org_id'), ('creator_profiles','org_id'),
    ('geofences','advertiser_org_id'), ('reward_programs','advertiser_org_id'), ('commission_offers','advertiser_org_id')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (rmn_org_visible(%I)) WITH CHECK (rmn_org_visible(%I))', t, col, col);
  END LOOP;
END $$;

-- Videos belong to a creator channel.
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON videos
  USING (EXISTS (SELECT 1 FROM creator_profiles cp WHERE cp.id = videos.creator_id))
  WITH CHECK (EXISTS (SELECT 1 FROM creator_profiles cp WHERE cp.id = videos.creator_id));

-- Campaigns and creatives: only the owning advertiser (or staff/system) may write. Reads stay open because creator
-- and driver analytics price validated plays by campaign rate; the API never returns other advertisers' campaigns.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns','creatives'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
  END LOOP;
END $$;
CREATE POLICY owner_insert ON campaigns FOR INSERT WITH CHECK (rmn_org_visible(advertiser_org_id));
CREATE POLICY owner_update ON campaigns FOR UPDATE USING (rmn_org_visible(advertiser_org_id)) WITH CHECK (rmn_org_visible(advertiser_org_id));
CREATE POLICY owner_delete ON campaigns FOR DELETE USING (rmn_org_visible(advertiser_org_id));
CREATE POLICY owner_insert ON creatives FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = creatives.campaign_id AND rmn_org_visible(c.advertiser_org_id)));
CREATE POLICY owner_update ON creatives FOR UPDATE USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = creatives.campaign_id AND rmn_org_visible(c.advertiser_org_id)));
CREATE POLICY owner_delete ON creatives FOR DELETE USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = creatives.campaign_id AND rmn_org_visible(c.advertiser_org_id)));

-- Billing records: an organization's own, plus driver-level rows (org_id NULL), which the API filters by driver.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','payments','checkout_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id IS NULL OR rmn_org_visible(org_id)) WITH CHECK (org_id IS NULL OR rmn_org_visible(org_id))', t);
  END LOOP;
END $$;
