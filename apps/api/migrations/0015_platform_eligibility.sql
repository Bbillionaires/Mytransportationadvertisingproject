-- Platform staff confirm creator monetization and driver earnings eligibility from the business portal.
INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('platform.eligibility.manage', 'Confirm or suspend creator monetization and driver earnings eligibility', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES ('super_admin', 'platform.eligibility.manage');
