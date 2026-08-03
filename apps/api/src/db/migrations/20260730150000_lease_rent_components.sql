-- Rent line-item split: space rent vs trailer/home rent (S568, Nic).
--
-- WHY: mobile-home / RV parks bill rent as distinct pieces — "space rent" (the
-- lot) plus "trailer rent" (a landlord-owned home the tenant rents). Landlords
-- run this many different ways; forcing a single rent number pushes them into
-- half-assed workarounds. This table itemizes a lease's rent into named
-- components shown on the lease + invoice.
--
-- MODEL: the components ITEMIZE the existing single rent obligation — their
-- amounts SUM to leases.rent_amount. Billing stays one rent payment per cycle
-- (payment application / late fees / eviction / idempotency all unchanged); the
-- components are the presentational + metrics breakdown. A lease with no rows
-- just shows one "Rent" line (backward compatible — no backfill).
--
-- `kind` classifies the component for later metrics (space vs dwelling revenue).
-- Not the physical dwelling-ownership flag (units.dwelling_ownership) — this is
-- about how the RENT is composed. `sort_order` controls display order.

CREATE TABLE lease_rent_components (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id     uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'other'
               CHECK (kind IN ('space', 'trailer', 'other')),
  label        text NOT NULL,
  amount       numeric(10,2) NOT NULL CHECK (amount >= 0),
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lease_rent_components_lease ON lease_rent_components(lease_id);

COMMENT ON TABLE lease_rent_components IS
  'S568: itemized rent breakdown for a lease (space rent + trailer rent + other). Amounts sum to leases.rent_amount; billing remains one rent payment. Presentational + metrics only.';
