-- S616 REVERSAL (Nic) — the landlords do not get a vote.
--
--   "You're treating it like the landlords have to agree or give permissions to
--    each other. Each landlord is entitled to their revenue stream according to
--    how the property is set up as long as they're operating within the law. But
--    you can't have landlord B refusing permission to have landlord A's
--    utilities ride on the same payment rail as the lease invoice. The other
--    landlord shouldn't even see anything about it. We are matching it up on the
--    back end without anybody knowing."
--
-- I built a three-way consent gate and it was the wrong shape. Nothing about
-- this arrangement is anybody's to approve: landlord A already supplies that
-- meter and is already owed for it, landlord B is already owed his rent, and
-- neither amount changes. The only thing that changes is which document the
-- charges print on and which rail the money moves along — and a landlord has no
-- standing to refuse another landlord a payment rail.
--
-- Worse, the gate made the feature useless in the case it exists for. It needed
-- landlord B to notice a request, understand a cross-property billing
-- arrangement he has no interest in, and act on it — before Nic could stop
-- driving over for cash. A feature that requires a stranger's cooperation to
-- work does not work.
--
-- So: GAM matches on the addresses and links. The consent columns are DROPPED
-- rather than left unused — a column nobody sets is a column the next reader
-- assumes is load-bearing.
--
-- WHAT STILL PROTECTS PEOPLE, since the consents were the answer to "what if
-- the match is wrong":
--   · the address match itself, which requires the same town AND the same
--     street AND close street numbers before it will fire at all;
--   · the amounts do not change — the same charges, on one document instead
--     of two;
--   · the tenant already gets a fully itemised line with the meter reads
--     behind it, so a charge that is not theirs is visible rather than buried;
--   · it is reversible: unlinking separates the billing again from the next
--     cycle, and nothing already invoiced is rewritten.

ALTER TABLE cross_property_service_links
  DROP CONSTRAINT IF EXISTS cpsl_active_needs_all_three;

ALTER TABLE cross_property_service_links
  DROP COLUMN IF EXISTS service_landlord_approved_at,
  DROP COLUMN IF EXISTS service_landlord_approved_by,
  DROP COLUMN IF EXISTS unit_landlord_approved_at,
  DROP COLUMN IF EXISTS unit_landlord_approved_by,
  DROP COLUMN IF EXISTS tenant_confirmed_at,
  DROP COLUMN IF EXISTS tenant_confirmed_by;

-- 'proposed' is gone with the approvals — there is nobody left to propose to.
-- A link is live or it is not.
UPDATE cross_property_service_links
   SET status = 'active', activated_at = COALESCE(activated_at, NOW())
 WHERE status = 'proposed';

ALTER TABLE cross_property_service_links DROP CONSTRAINT IF EXISTS cross_property_service_links_status_check;
ALTER TABLE cross_property_service_links ADD CONSTRAINT cross_property_service_links_status_check
  CHECK (status IN ('active','ended'));

DROP INDEX IF EXISTS ux_cpsl_live_agreement;
DROP INDEX IF EXISTS ux_cpsl_live_unit;
CREATE UNIQUE INDEX ux_cpsl_live_agreement
  ON cross_property_service_links (service_agreement_id) WHERE status = 'active';
CREATE UNIQUE INDEX ux_cpsl_live_unit
  ON cross_property_service_links (unit_id) WHERE status = 'active';

COMMENT ON TABLE cross_property_service_links IS
  'S616: a space one landlord SERVICES and a unit another landlord LEASES are '
  'the same physical place, matched by GAM on their addresses. Neither landlord '
  'approves it and the unit''s landlord is never told: no landlord has standing '
  'to refuse another a payment rail, and neither party''s revenue changes. While '
  'active the serviced space stops cutting its own invoice and its charges ride '
  'the leased unit''s tenant invoice, each row still stamped with the SERVICE '
  'landlord''s id so the money reaches the landlord whose meter turned.';
