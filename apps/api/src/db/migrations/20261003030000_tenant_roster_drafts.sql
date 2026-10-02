-- S655 (Nic, 10/2): THE TENANT CSV BECOMES A DRAFT ROSTER.
--
-- Until now the bulk tenant CSV wrote live 'imported' leases the moment a file
-- validated clean, and emailed every new person an "Activate your account" link
-- in the same instant — nobody signed anything, and the landlord never saw a
-- review step. Nic's direction (decisions.md, "CSV"): the file fills a DRAFT
-- roster only. Nothing is emailed and no account is created by the import. The
-- landlord reviews and confirms the roster one property at a time; confirming
-- drafts each household's lease from the landlord's own setup (the unit's rent
-- and its unit type's packet), the leases wait for the landlord's signature,
-- and each household hears from GAM once — when the landlord signs.
--
-- Why a table of its own rather than users + pending_tenant_intents:
--   - an intent bound to a unit is drafted by the hourly sweep on its own, so an
--     unconfirmed row would get a lease nobody asked for;
--   - a users row ties that email to this company under the S654 "tied
--     elsewhere" rules before the landlord ever confirmed the person;
--   - an 11,000-unit manager does not confirm in one sitting, so the roster has
--     to live on the server between visits.
-- A roster row holds no user, tenant, intent, lease or invoice. Nothing
-- downstream can act on it.
--
-- file_values keeps what the old system said (rent, dates, deposit, late fee,
-- the raw property/unit names) FOR REFERENCE ONLY — the lease drafts from the
-- landlord's setup, and the review screen flags where the file's rent differs.
-- opening_balance is the one figure that is real money: an old-system balance
-- posts as ONE charge on the household's lease when that lease issues (the
-- landlord's signature, or the resident's own when they are another company's
-- resident). Credits are not carried (a credit is not a charge); they stay in
-- file_values for the landlord to see.
--
-- Rows are never deleted: discarding one stamps discarded_at (GAM keeps
-- everything). Confirming stamps confirmed_at/by and the intent it became.
--
-- Expand-only: a new table, no backfill, safe to run before the code ships.
-- The tenant CSV has never been used in production (0 csv_import_attempts
-- rows for tenants), so there is nothing to carry over.

CREATE TABLE IF NOT EXISTS tenant_roster_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id          uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id          uuid REFERENCES properties(id) ON DELETE SET NULL,
  unit_id              uuid REFERENCES units(id) ON DELETE SET NULL,
  household_order      integer NOT NULL DEFAULT 0,
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  email                text NOT NULL,
  phone                text,
  rent_due_day         integer,
  existing_resident    boolean NOT NULL DEFAULT true,
  package_template_ids uuid[],
  home_sale            boolean NOT NULL DEFAULT false,
  opening_balance      numeric(12,2),
  file_values          jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_platform      text,
  import_attempt_id    uuid REFERENCES csv_import_attempts(id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  confirmed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  intent_id            uuid REFERENCES pending_tenant_intents(id) ON DELETE SET NULL,
  discarded_at         timestamptz,
  discarded_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The household's old balance posts ONCE, ever. Stamped on every row of the
  -- household when it posts, so a later lease for any of them (a re-invite to
  -- the same unit, a by-room re-paper, a returning resident) never posts it
  -- again. A one-per-LEASE guard alone could not see that.
  opening_balance_posted_at  timestamptz,
  opening_balance_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT tenant_roster_drafts_rent_due_day_range
    CHECK (rent_due_day IS NULL OR (rent_due_day >= 1 AND rent_due_day <= 28)),
  CONSTRAINT tenant_roster_drafts_opening_balance_positive
    CHECK (opening_balance IS NULL OR opening_balance > 0)
);

COMMENT ON TABLE tenant_roster_drafts IS
  'S655: people from a tenant CSV waiting for the landlord to review and confirm. No account, intent or lease exists for a live row.';
COMMENT ON COLUMN tenant_roster_drafts.unit_id IS
  'NULL = not placed yet. Confirming refuses while any live row of the property is unplaced.';
COMMENT ON COLUMN tenant_roster_drafts.file_values IS
  'What the old system''s file said (rent, dates, deposit, late fee, raw names). Reference only; the lease drafts from the landlord''s setup.';
COMMENT ON COLUMN tenant_roster_drafts.opening_balance IS
  'Old-system balance owed. Posts once, as a carried-balance charge on the household''s lease when it issues. The household''s first person carries it.';
COMMENT ON COLUMN tenant_roster_drafts.opening_balance_posted_at IS
  'When the household''s old balance posted. Set on every row of the household; once set, no later lease posts it again.';

-- One live draft per address per company: a re-upload updates the row instead
-- of adding a second copy of the same person.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_roster_drafts_live_email_key
  ON tenant_roster_drafts (landlord_id, lower(email))
  WHERE confirmed_at IS NULL AND discarded_at IS NULL;

-- The review screen and the "Mark onboarding complete" gate read live rows by property.
CREATE INDEX IF NOT EXISTS idx_tenant_roster_drafts_property_live
  ON tenant_roster_drafts (property_id)
  WHERE confirmed_at IS NULL AND discarded_at IS NULL;

-- Opening balances are read back from the intent a confirmed row became.
CREATE INDEX IF NOT EXISTS idx_tenant_roster_drafts_intent
  ON tenant_roster_drafts (intent_id)
  WHERE intent_id IS NOT NULL;

-- Same journal every onboarding table keeps.
DROP TRIGGER IF EXISTS audit_tenant_roster_drafts ON tenant_roster_drafts;
CREATE TRIGGER audit_tenant_roster_drafts
  AFTER DELETE OR UPDATE ON tenant_roster_drafts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
