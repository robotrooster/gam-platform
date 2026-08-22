-- S616 (Nic) — the two landlord pieces converging in the right spot.
--
--   "My friend's apartment and my utilities on the same physical place. If a
--    tenant's already signed up on utilities through me and the landlord goes to
--    onboard somebody, what does that look like?"
--
-- Oak Park supplies power and trash to spaces across the property line. Today
-- the neighbour gets TWO bills for one address: rent from their own landlord,
-- utilities from Oak Park. Once both landlords are on GAM the tenant should get
-- ONE — and the utility dollars still have to reach the landlord whose meter
-- turned. Nic: "We just need to be able to divert the utilities that go to my
-- property from the rent that goes to the other property."
--
-- WHY A LINK TABLE AND NOT A COLUMN. Neither side can be assumed to exist
-- first. Nic: "we don't always know which order... It could be the lease side of
-- things, or it could be the utility side." A link is a thing in its own right
-- that either side can propose, that carries its own evidence and consents, and
-- that can be declined or ended without disturbing either landlord's records.
--
-- WHY THE NAME IS NOT ABOUT UTILITIES. Nic: "it could play into other things
-- where maybe people split costs or whatever, share maintenance on common
-- areas." What this records is that a space one landlord SERVICES and a unit
-- another landlord LEASES are the same physical place. Utilities are the first
-- thing to ride it, not the only possible one.

CREATE TABLE IF NOT EXISTS cross_property_service_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Side A: the landlord who supplies the service and owns the meter/cans.
  service_agreement_id    uuid NOT NULL REFERENCES utility_service_agreements(id) ON DELETE RESTRICT,
  service_landlord_id     uuid NOT NULL REFERENCES landlords(id),

  -- Side B: the landlord who owns the bricks and writes the lease. The UNIT is
  -- the anchor, never the tenant — Nic: "Nobody has to reconfirm anything
  -- because utilities didn't change. The only thing that might have changed was
  -- the amount of the rent." A tenant moving out does not disturb this row.
  unit_id                 uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  unit_landlord_id        uuid NOT NULL REFERENCES landlords(id),

  status                  text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed','active','declined','ended')),

  -- HOW IT WAS NOTICED. Kept because the three people asked to approve deserve
  -- to see why GAM thinks these are the same place.
  --   'tenant_account' — the person being onboarded already holds an active
  --                      service agreement. A strong hint and NOT proof: Nic —
  --                      "it could be that one of the roommates had the
  --                      utilities in their name with landlord A, and the lease
  --                      is signed by tenant B."
  --   'proximity'      — a unit was created at an address near an already-
  --                      onboarded serviced space.
  --   'admin'          — deliberately raised by GAM staff for a case the
  --                      signals could never find.
  proposed_via            text NOT NULL
                          CHECK (proposed_via IN ('tenant_account','proximity','admin')),
  proposed_by_user_id     uuid REFERENCES users(id),

  -- THE PROXIMITY EVIDENCE. Nic: "it needs to be able to tell that it's near
  -- proximity to another onboarded address." Metres between the two properties'
  -- resolved coordinates, snapshotted at proposal time so the approval screens
  -- and the audit trail show the number the decision was actually made on.
  -- NULL means it could not be computed (a property with no coordinates), which
  -- is a reason to refuse to auto-propose — never a reason to assume adjacency.
  proximity_meters        numeric(10,1),
  proximity_checked_at    timestamptz,

  -- THE THREE CONSENTS (Nic). Every one required before anything converges.
  -- Nobody's money moves on a match a computer made by itself.
  --   · the service landlord — gives up his own invoice, and his late fees
  --   · the unit landlord    — his tenant's invoice will carry another
  --                            landlord's charges
  --   · the tenant           — the only party standing in the physical place
  service_landlord_approved_at  timestamptz,
  service_landlord_approved_by  uuid REFERENCES users(id),
  unit_landlord_approved_at     timestamptz,
  unit_landlord_approved_by     uuid REFERENCES users(id),
  tenant_confirmed_at           timestamptz,
  tenant_confirmed_by           uuid REFERENCES users(id),

  -- Set when all three land. Billing converges from the NEXT cycle, never
  -- retroactively — nothing already invoiced is rewritten.
  activated_at            timestamptz,
  declined_at             timestamptz,
  declined_by_user_id     uuid REFERENCES users(id),
  decline_reason          text,
  ended_at                timestamptz,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- An active link needs all three consents. Enforced here rather than trusted
  -- to route code: this is the row that redirects one landlord's money to
  -- another, and there is more than one way to reach it.
  CONSTRAINT cpsl_active_needs_all_three CHECK (
    status <> 'active' OR (
      service_landlord_approved_at IS NOT NULL
      AND unit_landlord_approved_at IS NOT NULL
      AND tenant_confirmed_at IS NOT NULL
    )
  ),
  -- Two landlords, or it is not a cross-property link at all.
  CONSTRAINT cpsl_two_landlords CHECK (service_landlord_id <> unit_landlord_id)
);

-- One live link per serviced space, and one per leased unit. Two live links
-- either way would mean one meter's money owed to two places.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cpsl_live_agreement
  ON cross_property_service_links (service_agreement_id)
  WHERE status IN ('proposed','active');
CREATE UNIQUE INDEX IF NOT EXISTS ux_cpsl_live_unit
  ON cross_property_service_links (unit_id)
  WHERE status IN ('proposed','active');
CREATE INDEX IF NOT EXISTS idx_cpsl_service_landlord
  ON cross_property_service_links (service_landlord_id, status);
CREATE INDEX IF NOT EXISTS idx_cpsl_unit_landlord
  ON cross_property_service_links (unit_landlord_id, status);

CREATE TRIGGER audit_cross_property_service_links
  AFTER DELETE OR UPDATE ON cross_property_service_links
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE cross_property_service_links IS
  'S616: a space one landlord SERVICES and a unit another landlord LEASES are '
  'the same physical place. While active, the serviced space stops cutting its '
  'own invoice and its utility charges ride the leased unit''s tenant invoice, '
  'each row still stamped with the SERVICE landlord''s id so the payout sweep '
  'routes that money to the landlord whose meter turned.';
