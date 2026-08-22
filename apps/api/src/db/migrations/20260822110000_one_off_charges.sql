-- S616 (Nic) — a charge that is not in the lease.
--
-- Nic, pushing back on my claim that the utility gate blocks charges: "you are
-- saying a landlord charging a parking violation would get the charge ignored?"
--
-- Checked, and the truth was worse than either of us said. The gate is
-- utilities-only and would not have touched it — but a parking violation
-- cannot be charged AT ALL. Every payments row on the platform comes from a
-- specific system flow (rent, deposits, utilities, propane, late fees, FlexPay,
-- home sales, termination, move-in), and lease_fees rows are only ever written
-- from the lease document itself — e-sign, the lease parser, a scheduled
-- amendment, lease sync. There is no door for "add fifty dollars for parking in
-- the fire lane."
--
-- So "the lease is law" was being enforced far harder than intended: not by
-- rejecting the charge, but by having nowhere to enter it. Nic's own framing is
-- the resolution — the lease governs RENT, LATE FEES and DEPOSITS, and real
-- tenancies also produce one-off charges the lease never enumerated.
--
-- WHY ITS OWN TABLE rather than another lease_fees row: a lease_fee is a term
-- OF the lease, seeded from the document and synced back to it. This is the
-- opposite — a thing that happened on a Tuesday, with a date, a reason, and a
-- person who decided it. Storing it as a lease term would corrupt the record of
-- what the lease actually says, which is the one thing that holds up in court.

CREATE TABLE IF NOT EXISTS tenant_one_off_charges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id       uuid NOT NULL REFERENCES landlords(id),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  lease_id          uuid REFERENCES leases(id),
  unit_id           uuid NOT NULL REFERENCES units(id),

  charge_type       text NOT NULL
                    CHECK (charge_type IN ('violation','damage','replacement','service','other')),
  amount            numeric(10,2) NOT NULL CHECK (amount > 0),
  -- What the tenant reads on their invoice. Required, and deliberately so: a
  -- charge nobody can explain is a charge nobody should be able to add.
  reason            text NOT NULL,
  -- When the thing HAPPENED, which is rarely the day it was entered. Drives
  -- what the tenant recognises ("the 14th, the fire lane") and what a dispute
  -- would be about.
  incident_date     date NOT NULL,
  -- Longer context for the landlord's own records. Never shown to the tenant.
  internal_note     text,

  -- Which cycle it should ride. Defaults to the next invoice; a landlord can
  -- push it out so a large repair lands on a month the tenant was warned about.
  bill_on_or_after  date NOT NULL DEFAULT CURRENT_DATE,

  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','billed','cancelled')),
  -- The payments row once it reaches an invoice. Set exactly once.
  payment_id        uuid REFERENCES payments(id),
  billed_at         timestamptz,

  -- GAM never erases: a withdrawn charge is cancelled with a reason, never
  -- deleted, so "why did this go away" always has an answer.
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES users(id),
  cancel_reason     text,

  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- A billed charge has a payment behind it; a pending one does not.
  CONSTRAINT tooc_billed_has_payment CHECK (
    (status = 'billed') = (payment_id IS NOT NULL)
  ),
  CONSTRAINT tooc_cancelled_has_reason CHECK (
    status <> 'cancelled' OR cancelled_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_tooc_lease_pending
  ON tenant_one_off_charges (lease_id, bill_on_or_after)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tooc_tenant
  ON tenant_one_off_charges (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tooc_landlord
  ON tenant_one_off_charges (landlord_id, status);

CREATE TRIGGER audit_tenant_one_off_charges
  AFTER DELETE OR UPDATE ON tenant_one_off_charges
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE tenant_one_off_charges IS
  'S616: a charge that happened rather than a term that was agreed — a parking '
  'violation, damage, a replacement key. Rides the tenant''s next invoice as an '
  'ordinary fee row. Kept OUT of lease_fees on purpose: lease_fees is what the '
  'signed lease says, and the lease is the only thing that holds up in court.';
