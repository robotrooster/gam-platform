-- Lease renewal requests.
--
-- A tenant can express intent to renew their lease — often through the CS agent,
-- but only on a property where the landlord has enabled the `lease_renewal` agent
-- capability (see property_agent_permissions). This table captures that intent as
-- durable, append-only history; the LANDLORD finalizes the actual renewal (the
-- agent never changes lease terms). Mirrors the lease_termination_requests pattern,
-- minus the fee machinery (a renewal request carries no fee).
--
-- `status` CHECK mirrors LEASE_RENEWAL_REQUEST_STATUSES in packages/shared.
-- No backfill needed.

CREATE TABLE IF NOT EXISTS lease_renewal_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id              UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  landlord_id           UUID NOT NULL REFERENCES landlords(id),
  requested_by_user_id  UUID NOT NULL REFERENCES users(id),
  preferred_term        TEXT,                 -- free-form, e.g. "12 months", "month-to-month"
  notes                 TEXT,                 -- tenant's note / agent-captured detail
  status                TEXT NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'approved', 'declined', 'cancelled', 'completed')),
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lease_renewal_requests_lease   ON lease_renewal_requests (lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_renewal_requests_landlord ON lease_renewal_requests (landlord_id);
-- At most one OPEN ('requested') renewal request per lease — avoids duplicates if
-- a tenant asks more than once before the landlord acts.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_renewal_request_per_lease
  ON lease_renewal_requests (lease_id) WHERE status = 'requested';

COMMENT ON TABLE lease_renewal_requests IS
  'Tenant intent-to-renew, captured (often by the agent, gated by the lease_renewal property permission). Landlord finalizes the actual lease. Status mirrors LEASE_RENEWAL_REQUEST_STATUSES in packages/shared.';
