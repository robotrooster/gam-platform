-- Contractor marketplace — the contractor's own profile.
--
-- 10/31 (Nic), dictated: "I want to compete with Angie's List because Angie's
-- List has gone downhill... contractors can make a profile. And when landlords
-- put a job out that's open for a bid, contractors have to go on there and bid
-- the job. It's like searching a marketplace, like searching eBay...
-- Contractors are on the platform for free. GAM takes a cut of the finished
-- job... Angie's List charges people for leads. We don't want to charge that.
-- We want to charge off of the completed job."
--
-- WHY this is NOT the business portal, in his words (10/31): "The business
-- portal is for somebody operating their small business. A landscaper trying
-- to get more yards is going to post his prices, run his customers and
-- invoicing through there. That is subscription based. Contractors that are
-- looking for one-off jobs on bids, that's a percentage of the cut. A cut of
-- the job. It's two different things." So a contractor is its own entity with
-- its own money model, NOT a `businesses` row. The same person may hold both,
-- paying a subscription to run their shop and 3% on marketplace jobs they win.
--
-- The `contractors` table already existed, empty and unreferenced by any code,
-- from an abandoned directory-listing idea. It is reused rather than replaced
-- (GAM keeps everything), but the two columns that encoded the lead-fee model
-- Nic rejects — listing_tier and listing_fee — are pinned to NULL by a CHECK.
-- A future session cannot quietly start charging for a listing: the database
-- refuses the row. That is deliberate; the rejection is enforced, not
-- remembered.
--
-- No backfill needed: zero rows.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY[
  'admin', 'super_admin', 'landlord', 'tenant', 'bookkeeper',
  'property_manager', 'onsite_manager', 'maintenance',
  'business_owner', 'business_staff', 'fitness_user', 'contact',
  'portfolio_manager',
  -- 10/31: a marketplace contractor signs in as themselves.
  'contractor'
]));

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS zip text,
  -- How far they will travel for work. The marketplace shows a contractor the
  -- open jobs they could actually take, not every job in the country.
  ADD COLUMN IF NOT EXISTS service_radius_miles integer,
  -- Connect = per ENTITY: a contractor is paid as themselves, never through
  -- some other entity's account.
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS connect_payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accepted_terms_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  -- Mirrors the insurance_verified / insurance_expiry pair this table already
  -- carried, so a job that requires a bonded contractor has something to ask.
  -- When the insurance subsystem lands these become a projection of it rather
  -- than a second place to type a policy: one home for insurance, and these
  -- four columns are the marketplace's read of it.
  ADD COLUMN IF NOT EXISTS bond_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bond_expiry date;

ALTER TABLE contractors DROP CONSTRAINT IF EXISTS contractors_status_check;
ALTER TABLE contractors ADD CONSTRAINT contractors_status_check
  CHECK (status = ANY (ARRAY['active', 'suspended', 'retired']));

-- GAM never charges a contractor to be listed or to see a lead. The whole
-- competitive position is that the only charge is a cut of work actually won.
ALTER TABLE contractors DROP CONSTRAINT IF EXISTS contractors_no_listing_fee;
ALTER TABLE contractors ADD CONSTRAINT contractors_no_listing_fee
  CHECK (listing_tier IS NULL AND listing_fee IS NULL);

-- One profile per login.
DROP INDEX IF EXISTS ux_contractors_user;
CREATE UNIQUE INDEX ux_contractors_user ON contractors(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_contractors_active_trades
  ON contractors USING gin(trades) WHERE status = 'active';
