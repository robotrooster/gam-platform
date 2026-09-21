-- S652 — A GOVERNMENT CAN PUBLISH A LEASE, NOT JUST A DISCLOSURE.
--
-- Nic: "say a state specifically provided a lease, a generic lease for an
-- apartment — that would be in the apartment lease [sleeve] but it would also be
-- underneath" with the other free government versions. The library only knew
-- disclosures. `purpose` says what kind of document a library entry is, the same
-- word lease_templates uses, so a state's model lease lines up with that state's
-- lease sleeve for the unit types it was written for.
--
-- Existing rows are all disclosures: default 'state_disclosure', no backfill.

ALTER TABLE disclosure_library_documents
  ADD COLUMN purpose text NOT NULL DEFAULT 'state_disclosure';
ALTER TABLE disclosure_library_documents
  ALTER COLUMN disclosure_type DROP NOT NULL;
