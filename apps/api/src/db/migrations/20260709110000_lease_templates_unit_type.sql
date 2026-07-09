-- Lease templates are per UNIT TYPE (Nic, S535).
--
-- Different unit classes get entirely different lease forms — an RV
-- spot lease isn't an apartment lease isn't a commercial lease. Each
-- template optionally declares the unit_type it's written for; NULL =
-- universal (usable for any unit). Drafting (renewal + send) validates
-- the pairing and the pickers filter to compatible templates, so a
-- landlord can't put an apartment on the RV form. This is also the
-- unit-class differentiation mechanism for terms that vary by class
-- (the form's own language) — values like late fees still stamp from
-- the property-level policy (anti-discrimination).
--
-- CHECK mirrors shared UNIT_TYPES.
-- No backfill needed: existing templates stay NULL (universal).

ALTER TABLE lease_templates
    ADD COLUMN unit_type text
        CHECK (unit_type IS NULL OR unit_type IN
               ('apartment','single_family','rv_spot','mobile_home','storage','commercial'));
