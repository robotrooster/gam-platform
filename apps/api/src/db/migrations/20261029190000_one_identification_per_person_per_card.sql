-- 10/29: an identification is filed again every time it is seen — a guest who
-- re-uploads a clearer photo, a screening reported twice as its products
-- finish, a sync replayed. Each of those must RESTATE the record, not stack a
-- second copy of the same card, or the matcher ends up comparing a person to
-- three versions of themselves.
--
-- Two keys, because there are two kinds of anchor (one of which is always
-- NULL, so neither index sees the other's rows):
--
--   per tenant   the same card, filed again, is the same record. A person may
--               legitimately hold more than one document (a licence AND a
--               passport), so the key includes the type and the number.
--   per booking  one ID per stay. The guest photographing their licence a
--               second time meant the second photo — "the later one is the one
--               they meant" — so it replaces.
--
-- No backfill needed: the table is empty.

CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_identifications_card
  ON tenant_identifications (tenant_id, id_type, id_number)
  WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_identifications_booking
  ON tenant_identifications (booking_id)
  WHERE booking_id IS NOT NULL;
