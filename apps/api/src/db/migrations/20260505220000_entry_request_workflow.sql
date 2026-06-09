-- Entry-request workflow: landlord requests entry into tenant unit
-- (typical state-law requirement: 24-hour written notice, reasonable
-- hours). Tenant grants or denies. Landlord records the actual entry
-- moment so compliance vs. notice-window can be measured.
--
-- Drives credit-ledger events:
--   entry_request_made                       (landlord, informational)
--   entry_request_granted_within_window      (tenant, +50)
--   entry_request_denied                     (tenant, neutral — denial
--                                             is a tenant right; only
--                                             scored if pattern emerges)
--   entry_compliance_breach                  (landlord, -10%)
--   proper_entry_notice_given                (landlord, +25)
--
-- Notice-window is configurable per landlord via
-- landlords.default_entry_notice_hours (default 24h). The migration
-- adds that column too.
--
-- A row in unit_entry_request_responses persists the tenant's
-- grant/deny decision; the entry_actual_at on the parent row records
-- when the landlord actually entered. Compliance is computed at the
-- point the landlord posts an entry: if entry_actual_at is at or
-- after notice_given_at + notice_window_hours AND the request is in
-- 'granted' status, the landlord scores proper_entry_notice_given.
-- If entry happens outside that window OR without a grant, it's a
-- compliance breach.
--
-- No backfill needed.

ALTER TABLE landlords
  ADD COLUMN default_entry_notice_hours INTEGER NOT NULL DEFAULT 24;

CREATE TABLE unit_entry_requests (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id                   UUID NOT NULL REFERENCES units(id),
  lease_id                  UUID REFERENCES leases(id),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  landlord_id               UUID NOT NULL REFERENCES landlords(id),
  requested_by_user_id      UUID NOT NULL REFERENCES users(id),
  reason                    TEXT NOT NULL,
  reason_category           TEXT NOT NULL CHECK (reason_category IN (
    'maintenance', 'inspection', 'showing', 'emergency', 'other'
  )),
  notice_given_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  proposed_entry_window_start TIMESTAMPTZ NOT NULL,
  proposed_entry_window_end   TIMESTAMPTZ NOT NULL,
  notice_window_hours       INTEGER NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'granted', 'denied', 'completed', 'breached', 'cancelled'
  )),
  entry_actual_at           TIMESTAMPTZ,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_unit_entry_requests_unit     ON unit_entry_requests (unit_id);
CREATE INDEX idx_unit_entry_requests_tenant   ON unit_entry_requests (tenant_id);
CREATE INDEX idx_unit_entry_requests_landlord ON unit_entry_requests (landlord_id);
CREATE INDEX idx_unit_entry_requests_status   ON unit_entry_requests (status);

CREATE TABLE unit_entry_request_responses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID NOT NULL REFERENCES unit_entry_requests(id) ON DELETE CASCADE,
  responder_user_id   UUID NOT NULL REFERENCES users(id),
  decision            TEXT NOT NULL CHECK (decision IN ('granted', 'denied')),
  responded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason              TEXT,
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (request_id)
);
