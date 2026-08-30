-- S630 DIRECTIVE (Nic): a unit carries SEVERAL subtypes, each toggled on its own.
--
-- "Units need to be able to handle multiple subtypes as a checkbox. I can select
--  pull through and thirty amp... it's not having back in fifty and back in
--  thirty as two separate things. Each distinct categorization is selectable
--  without being bundled. A spot could be a back in and facing west or a back in
--  and facing east. So fifty amp back in should not be one subtype. It's two
--  subtypes."
--
-- units.subtype_id could hold exactly one, which forced every combination to be
-- pre-bundled into its own row: "Back In", "Back In 50 Amp", and — the moment
-- orientation matters — "Back In 50 Amp Facing West". That is the combinatorial
-- explosion a landlord has to maintain by hand, and it is why the catalog already
-- had a "Back In" and a "Back In 50 Amp" that mean overlapping things.
--
-- The catalog itself does not change. What changes is that a unit points at many
-- of its rows instead of one.
CREATE TABLE IF NOT EXISTS unit_subtype_links (
  unit_id    uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  subtype_id uuid NOT NULL REFERENCES property_unit_subtypes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, subtype_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_subtype_links_subtype ON unit_subtype_links (subtype_id);

-- Carry across every unit that already had one. No backfill is needed beyond
-- this: units.subtype_id was only ever written at creation or by the S613 linker.
INSERT INTO unit_subtype_links (unit_id, subtype_id)
SELECT id, subtype_id FROM units WHERE subtype_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- units.subtype_id is KEPT and stays in step with the links as "the first one",
-- because the booking quote and the retire-and-replace column list still read it.
-- It is no longer the source of truth; unit_subtype_links is. Dropping it is a
-- separate change once those readers move over.
COMMENT ON COLUMN units.subtype_id IS
  'LEGACY single subtype. Source of truth is unit_subtype_links (a unit holds many). Kept in step as the first link for readers not yet migrated.';
