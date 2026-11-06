-- Contractor marketplace — the job a landlord posts and the bids on it.
--
-- 10/31 (Nic), dictated: "landlords put a job out that's open for a bid,
-- contractors have to go on there and bid the job. It's like searching a
-- marketplace, like searching eBay... you're browsing the marketplace for open
-- jobs. You bid. They're all private to the person so that people aren't just
-- publicly underbidding other people. It helps keep it fair."
--
-- PRIVACY IS THE PRODUCT, not a setting. A bid is visible to the landlord who
-- posted the job and to the contractor who made it. No contractor ever sees
-- another contractor's number, or how many bids are in, or whether theirs is
-- high — publishing any of those turns the board into a race to the bottom,
-- which is the thing Nic is competing against. There is no admin screen that
-- shows a landlord the spread before bidding closes either, because a
-- "lowest so far" figure leaks straight back to the bidders.
--
-- THE INSURED GATE IS PER JOB (Nic, 10/31, asked directly). He had left it
-- open — "maybe they set that at the property level... I don't know exactly how
-- we want to finish that structure" — and chose per-job: a mowing job and a
-- gas-line job at the same park get judged separately. Nothing is inherited
-- from the property, so nothing can quietly require (or quietly stop
-- requiring) insurance on a job the landlord did not look at.
--
-- A job that requires insurance still SENDS to an uninsured contractor if the
-- landlord insists — his call, 10/31: warn loudly, let them send anyway. GAM
-- does not referee how a landlord operates their property.
--
-- No backfill needed: new tables.

CREATE TABLE IF NOT EXISTS marketplace_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  -- Ownership lives on the PROPERTY. A job is always at a place.
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES units(id),
  -- A job may be raised from a maintenance request the tenant filed.
  maintenance_request_id uuid REFERENCES maintenance_requests(id),

  title text NOT NULL,
  description text NOT NULL,
  -- What kind of work, for the contractor's browse filter.
  trades text[] NOT NULL DEFAULT '{}',
  photos text[] NOT NULL DEFAULT '{}',

  -- Per job, never inherited. See the header.
  requires_insured boolean NOT NULL DEFAULT false,
  requires_bonded boolean NOT NULL DEFAULT false,

  status text NOT NULL DEFAULT 'open',
  -- When the landlord stops taking bids. Nullable: open until they award it.
  bids_close_at timestamptz,

  awarded_bid_id uuid,
  awarded_contractor_id uuid REFERENCES contractors(id),
  awarded_amount numeric(12,2),
  awarded_at timestamptz,

  -- What the job actually finished at. Starts as the awarded amount; the
  -- landlord may settle at a different figure if the scope moved, and GAM's
  -- cut is taken off what the job ACTUALLY finished at, not what was bid.
  final_amount numeric(12,2),
  completed_at timestamptz,

  -- The cut rate as it stood when the job was AWARDED — that is the deal the
  -- contractor accepted. A later re-price never reaches back into work already
  -- won. Snapshotted, exactly like the destination bank on a ledger row.
  cut_percent_snapshot numeric(6,3),

  cancelled_at timestamptz,
  cancelled_reason text,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE marketplace_jobs DROP CONSTRAINT IF EXISTS marketplace_jobs_status_check;
ALTER TABLE marketplace_jobs ADD CONSTRAINT marketplace_jobs_status_check
  CHECK (status = ANY (ARRAY['open', 'awarded', 'in_progress', 'completed', 'cancelled']));

-- An awarded job names the bid, the contractor, the amount, the moment and the
-- rate together, or none of them. Half an award is not a state the product has.
ALTER TABLE marketplace_jobs DROP CONSTRAINT IF EXISTS marketplace_jobs_award_together;
ALTER TABLE marketplace_jobs ADD CONSTRAINT marketplace_jobs_award_together
  CHECK (
    (awarded_bid_id IS NULL AND awarded_contractor_id IS NULL AND awarded_amount IS NULL
      AND awarded_at IS NULL AND cut_percent_snapshot IS NULL)
    OR
    (awarded_bid_id IS NOT NULL AND awarded_contractor_id IS NOT NULL AND awarded_amount IS NOT NULL
      AND awarded_at IS NOT NULL AND cut_percent_snapshot IS NOT NULL)
  );

-- A completed job was awarded first and has a figure to take a cut of.
ALTER TABLE marketplace_jobs DROP CONSTRAINT IF EXISTS marketplace_jobs_completion_needs_award;
ALTER TABLE marketplace_jobs ADD CONSTRAINT marketplace_jobs_completion_needs_award
  CHECK (completed_at IS NULL
    OR (awarded_bid_id IS NOT NULL AND final_amount IS NOT NULL AND final_amount >= 0));

CREATE INDEX IF NOT EXISTS ix_marketplace_jobs_open
  ON marketplace_jobs(created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_marketplace_jobs_landlord
  ON marketplace_jobs(landlord_id, status);
CREATE INDEX IF NOT EXISTS ix_marketplace_jobs_contractor
  ON marketplace_jobs(awarded_contractor_id) WHERE awarded_contractor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_marketplace_jobs_trades
  ON marketplace_jobs USING gin(trades) WHERE status = 'open';


CREATE TABLE IF NOT EXISTS marketplace_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES marketplace_jobs(id) ON DELETE CASCADE,
  contractor_id uuid NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  -- The contractor's pitch to this landlord. Private to the two of them.
  notes text,
  days_to_complete integer CHECK (days_to_complete IS NULL OR days_to_complete > 0),
  -- Whether this contractor held insurance and a bond AT BID TIME, so a
  -- landlord reading the bid later sees what was true when they chose, not
  -- what became true afterwards.
  insured_at_bid boolean NOT NULL DEFAULT false,
  bonded_at_bid boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'submitted',
  withdrawn_at timestamptz,
  declined_at timestamptz,
  accepted_at timestamptz,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE marketplace_bids DROP CONSTRAINT IF EXISTS marketplace_bids_status_check;
ALTER TABLE marketplace_bids ADD CONSTRAINT marketplace_bids_status_check
  CHECK (status = ANY (ARRAY['submitted', 'withdrawn', 'accepted', 'declined']));

-- One live bid per contractor per job. They may withdraw and bid again; they
-- may not stack two live numbers on the same job.
DROP INDEX IF EXISTS ux_marketplace_bids_one_live;
CREATE UNIQUE INDEX ux_marketplace_bids_one_live
  ON marketplace_bids(job_id, contractor_id)
  WHERE status IN ('submitted', 'accepted');

CREATE INDEX IF NOT EXISTS ix_marketplace_bids_job ON marketplace_bids(job_id, created_at);
CREATE INDEX IF NOT EXISTS ix_marketplace_bids_contractor
  ON marketplace_bids(contractor_id, created_at DESC);

ALTER TABLE marketplace_jobs DROP CONSTRAINT IF EXISTS marketplace_jobs_awarded_bid_fk;
ALTER TABLE marketplace_jobs ADD CONSTRAINT marketplace_jobs_awarded_bid_fk
  FOREIGN KEY (awarded_bid_id) REFERENCES marketplace_bids(id);

-- A bid is money. The change journal is the only record of what it said before
-- somebody edited it, and it is never pruned.
DROP TRIGGER IF EXISTS audit_marketplace_bids ON marketplace_bids;
CREATE TRIGGER audit_marketplace_bids
  AFTER UPDATE OR DELETE ON marketplace_bids
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

DROP TRIGGER IF EXISTS audit_marketplace_jobs ON marketplace_jobs;
CREATE TRIGGER audit_marketplace_jobs
  AFTER UPDATE OR DELETE ON marketplace_jobs
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
