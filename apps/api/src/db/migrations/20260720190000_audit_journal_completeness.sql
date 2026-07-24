-- S550 (Nic pressed: "are we sure there is nothing missing?") — the audit
-- sweep found four gaps; this closes three of them at the DB layer:
--
-- 1. USERS changes were fully excluded from the journal (secrets), which
--    also lost the NON-secret history: email/phone/name/role changes.
--    Fix: a REDACTING trigger variant that strips every secret column
--    (password_hash, totp_secret, reset/verify/invite tokens) from the
--    jsonb before journaling. Identity history preserved, secrets never
--    copied.
-- 2. ACCESS HISTORY was lost: staff scope + permission changes
--    (property_manager/onsite_manager/maintenance_worker/bookkeeper
--    scopes) mutate in place — "who had what access when" is
--    security-audit gold and was unrecoverable. Now journaled.
-- 3. More mutable business tables missed by the first pass: utility
--    meters/bills, POS items (price/stock edits), FlexCharge accounts
--    (credit limits/balances), common areas, entry requests, subleases.
--    Now journaled.
--
-- (Gap 4 — demo data polluting growth analytics — is fixed in the next
-- migration; gap 5 — raw Stripe webhook payload storage — lands with the
-- live-keys wiring, noted in OAK_PARK_LAUNCH.md C3.)
-- Bank/plaid tables stay excluded on purpose (encrypted secrets).
-- No backfill possible: history starts now.

CREATE OR REPLACE FUNCTION audit_row_change_redacted() RETURNS trigger AS $$
DECLARE
  redact text[] := ARRAY[
    'password_hash', 'totp_secret', 'reset_token', 'email_verify_token',
    'tenant_invite_token', 'landlord_invite_token'
  ];
  old_j jsonb; new_j jsonb;
BEGIN
  old_j := to_jsonb(OLD) - redact;
  IF TG_OP = 'UPDATE' THEN
    new_j := to_jsonb(NEW) - redact;
    IF old_j = new_j THEN RETURN NEW; END IF;  -- secret-only change: skip
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD)->>'id')::uuid, 'UPDATE', old_j, new_j);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD)->>'id')::uuid, 'DELETE', old_j, NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_users AFTER UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_redacted();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'property_manager_scopes', 'onsite_manager_scopes',
    'maintenance_worker_scopes', 'bookkeeper_scopes',
    'utility_meters', 'utility_bills', 'pos_items',
    'flex_charge_accounts', 'common_areas', 'unit_entry_requests', 'subleases'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      'audit_' || t, t);
  END LOOP;
END $$;
