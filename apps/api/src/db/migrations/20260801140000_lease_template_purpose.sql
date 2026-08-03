-- S576 (B-8): work-trade addendum forms.
-- Landlords bring their OWN work-trade addendum form (Nic: "landlords may have
-- different forms they want to use"). A template's `purpose` distinguishes a
-- normal lease form from a work-trade addendum form so the renewal auto-draft
-- can find and attach the right one. Default 'lease' keeps every existing
-- template a lease template (no backfill needed).
ALTER TABLE lease_templates
  ADD COLUMN purpose text NOT NULL DEFAULT 'lease';

ALTER TABLE lease_templates
  ADD CONSTRAINT lease_templates_purpose_check
  CHECK (purpose IN ('lease', 'work_trade_addendum'));

-- A landlord's designated work-trade addendum is resolved the same way lease
-- templates are (optionally scoped by unit_type / property). No uniqueness
-- constraint: the resolver picks the most specific match, mirroring lease
-- template selection.
CREATE INDEX idx_lease_templates_purpose
  ON lease_templates (landlord_id, purpose)
  WHERE purpose <> 'lease';
