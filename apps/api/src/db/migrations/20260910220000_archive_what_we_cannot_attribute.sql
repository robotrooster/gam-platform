-- S640: an unattributed provider event is still evidence.
--
-- The archive required a background_check_id, which is fine for a report we
-- fetched and wrong for a webhook we merely received. Checkr's TENANT API is a
-- different product from the staffing API their public docs describe: different
-- event names, no subscription list in the dashboard to read, and no way to
-- confirm which events it actually sends. GAM expects `report.completed` to
-- finish a screening and has never seen one arrive — 75 of 79 deliveries were
-- `report.product.completed`, which carries a report item id that matches no
-- order.
--
-- Recording those anyway turns the next real applicant into the answer. Keyed
-- to a check when the event names one, unattached when it does not.
ALTER TABLE background_check_reports
  ALTER COLUMN background_check_id DROP NOT NULL;

COMMENT ON COLUMN background_check_reports.background_check_id IS
  'S640: nullable. A fetched report always names its check; a raw webhook may carry an id we cannot resolve yet, and is kept unattached rather than dropped.';
