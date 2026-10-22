-- 10/22 (Nic) — ONE LOGIN, SEVERAL COMPANIES, SOME OWNED AND SOME MANAGED.
--
-- The third-party property-management portal is folding into the landlord
-- portal. His reason:
--
--   "Blue's going to be property managing for some other people. And he doesn't
--    necessarily want to toggle between portals with a different login. He wants
--    to just adjust a view in the same screen... The goal is flexibility to
--    allow them to run the business where they want to run it."
--
-- GAM already has the structure this needs, built for his own two LLCs:
-- companies sit OUTSIDE the account (landlord_members), an account can act for
-- several of them, nothing is ever a default, and every money page filters by
-- company. A manager working for five owners is the same shape as an account
-- that owns five companies. The only thing missing was a way to say WHY the
-- account may act for a company.
--
-- So `landlord_members.role` opens up. It was CHECK (role = 'owner') — one
-- value, which is a column that was waiting for this.
--
--   'owner'   — the account owns this company. Unchanged, and still the only
--               role that can wind the company up, move its bank account, or
--               hand out ownership.
--   'manager' — the account MANAGES this company's properties for its owner,
--               under a property scope and a permission set the OWNER granted.
--               It is not their company; they are working on it.
--
-- WHAT THIS MIGRATION DOES NOT DO, deliberately: it does not grant anybody
-- anything. Every existing row is an owner and stays an owner. The reads that
-- honor 'manager', the per-company scope resolution and the cap that keeps a
-- manager's staff inside the owner's grant all land in the same batch, in code,
-- where they can be tested.
--
-- No backfill needed: the CHECK widens, no row changes.

ALTER TABLE landlord_members DROP CONSTRAINT IF EXISTS landlord_members_role_check;
ALTER TABLE landlord_members ADD CONSTRAINT landlord_members_role_check
  CHECK (role IN ('owner', 'manager'));

COMMENT ON COLUMN landlord_members.role IS
  '10/22: owner = the account owns this company; manager = the account manages its properties for the owner, inside a scope and permissions the owner granted (services/managedCompanies).';

-- WHICH MANAGEMENT COMPANY IS DOING THE MANAGING, when one is.
--
-- A PM company's staff reach an owner's properties THROUGH their company, not
-- as individuals: the owner engaged TruBlu Management, not Blu personally, and
-- when Blu takes somebody off his own staff that person's access to the owner's
-- park has to go with it. Hanging the grant off the pm_company makes that one
-- fact instead of two.
--
-- NULL means a person the owner added directly — their own property manager,
-- their own front desk. That is the in-house case and it stays exactly as it is.
ALTER TABLE landlord_members ADD COLUMN IF NOT EXISTS via_pm_company_id UUID
  REFERENCES pm_companies(id) ON DELETE CASCADE;

COMMENT ON COLUMN landlord_members.via_pm_company_id IS
  'The management company this access came through, when it came through one. NULL = the owner added this person directly (in-house staff).';

CREATE INDEX IF NOT EXISTS idx_landlord_members_via_pm_company
  ON landlord_members (via_pm_company_id) WHERE via_pm_company_id IS NOT NULL;

-- An owner's row is their own; only a manager's can come through a company.
ALTER TABLE landlord_members DROP CONSTRAINT IF EXISTS landlord_members_owner_is_direct;
ALTER TABLE landlord_members ADD CONSTRAINT landlord_members_owner_is_direct
  CHECK (role = 'manager' OR via_pm_company_id IS NULL);
