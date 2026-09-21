-- S652 — A SLEEVE CAN BE COVERED BY MORE THAN ONE DOCUMENT.
--
-- Nic: "my lease for both properties is identical as it was made by my Arizona
-- attorney, so if it's a selectable thing you need to be able to select both the
-- things that it's in already." Oak Park and Mountain View each have their own
-- mobile home lease, and the owner disclosure is inside both. One covering per
-- sleeve could only name one of them.
--
-- No backfill needed: the existing rows (at most one per sleeve) stay valid
-- under the wider key.

ALTER TABLE sleeve_coverings DROP CONSTRAINT sleeve_coverings_landlord_id_sleeve_id_key;
ALTER TABLE sleeve_coverings ADD CONSTRAINT sleeve_coverings_one_per_document
  UNIQUE (landlord_id, sleeve_id, template_id);
