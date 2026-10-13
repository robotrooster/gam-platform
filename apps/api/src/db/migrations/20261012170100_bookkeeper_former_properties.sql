-- 10/12 (Nic) — A SOLD OR TRANSFERRED PROPERTY IS A CLEAN CUT FOR ITS BOOKKEEPERS
--
--   Bookkeepers keep READ access to that property's history for the period it
--   belonged to the company — forever — and see nothing after the transfer
--   date (unless they keep the books for the new owner separately).
--
-- On 10/11 a transfer PRUNED the property off every bookkeeper's ticked list
-- of the old company (services/propertyTransfer pruneBookkeeperBoxes), and the
-- readers dropped any ticked property the company no longer owns. So the
-- bookkeeper lost the property's history the moment it sold — the months they
-- kept its books included — and one whose only box it was lost the company.
--
-- Now the property comes off the ticked list and is kept here as a FORMER
-- property of that bookkeeper, dated by the transfer that took it
-- (property_transfers — the date the transfer service already records, reused
-- rather than copied by hand). Every bookkeeper financial reader includes a
-- former property's money only up to the property's own calendar day of the
-- transfer (lib/bookkeeperScope: PropertyCutoff, applied by incomeBasis,
-- landlordPL, the financial pages, expenses, reports and the Books rent roll).
-- Nothing after it, ever. Never written to: a former property's books are read
-- only (routes/expenses refuses a write on one).
--
--   bookkeeper_scope_id   the bookkeeper's row for the OLD company
--   property_id           the property that left
--   property_transfer_id  the transfer that took it (NULL only for a backfilled
--                         row whose transfer cannot be named)
--   left_at               when it left: property_transfers.transferred_at
--
-- A property can leave, come back and leave again; each departure is its own
-- row (one per scope row and transfer), and the readers take the latest. A
-- property that is back and ticked again is a current property: its former
-- rows are ignored while it is ticked.
--
-- Removing the bookkeeper (DELETE FROM bookkeeper_scopes, the S80 model)
-- takes their former properties with it (ON DELETE CASCADE): their access to
-- the company ends whole. Both the grant and that removal are journaled
-- (audit_row_changes, the 20261012160100 INSERT-aware audit trigger), so
-- nothing about who could read what is lost.
--
-- Backfill: a row whose ticked list still holds a property the company no
-- longer owns, where property_transfers names a transfer of it out of that
-- company (the 10/11 pruning left exactly that on a bookkeeper whose ONLY box
-- was sold), has it moved here with the latest such transfer, and taken off
-- the list. A box pruned on 10/11 cannot be recovered (the list no longer
-- says it was ticked); production had 0 bookkeeper_scopes rows on 10/11, so
-- none was. A ticked property that left with no transfer on record (moved by
-- hand) stays on the list, where the readers drop it, as before.
-- Safe drop: DROP TABLE bookkeeper_former_properties (after restoring the
-- 10/11 pruning in services/propertyTransfer).

CREATE TABLE IF NOT EXISTS bookkeeper_former_properties (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookkeeper_scope_id  uuid NOT NULL REFERENCES bookkeeper_scopes(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL REFERENCES properties(id),
  property_transfer_id uuid REFERENCES property_transfers(id),
  left_at              timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS bookkeeper_former_properties_one_per_transfer
  ON bookkeeper_former_properties (bookkeeper_scope_id, property_transfer_id)
  WHERE property_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookkeeper_former_properties_scope
  ON bookkeeper_former_properties (bookkeeper_scope_id);

COMMENT ON TABLE bookkeeper_former_properties IS
  '10/12 (Nic): a property that left a bookkeeper''s company while ticked for them. Readable up to the property''s own calendar day of left_at (the transfer), never after; read only.';

DROP TRIGGER IF EXISTS audit_bookkeeper_former_properties ON bookkeeper_former_properties;
CREATE TRIGGER audit_bookkeeper_former_properties
  AFTER INSERT OR UPDATE OR DELETE ON bookkeeper_former_properties
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Backfill (see the header).
WITH stranded AS (
  SELECT bs.id AS scope_id, pid AS property_id
    FROM bookkeeper_scopes bs
    CROSS JOIN LATERAL unnest(bs.property_ids) AS pid
    JOIN properties p ON p.id = pid
   WHERE bs.property_ids IS NOT NULL
     AND p.landlord_id <> bs.landlord_id
), latest AS (
  SELECT DISTINCT ON (s.scope_id, s.property_id)
         s.scope_id, s.property_id, pt.id AS transfer_id, pt.transferred_at
    FROM stranded s
    JOIN bookkeeper_scopes bs ON bs.id = s.scope_id
    JOIN property_transfers pt ON pt.property_id = s.property_id AND pt.from_landlord_id = bs.landlord_id
   ORDER BY s.scope_id, s.property_id, pt.transferred_at DESC, pt.id
), moved AS (
  INSERT INTO bookkeeper_former_properties (bookkeeper_scope_id, property_id, property_transfer_id, left_at)
  SELECT scope_id, property_id, transfer_id, transferred_at FROM latest
  ON CONFLICT DO NOTHING
  RETURNING bookkeeper_scope_id, property_id
)
UPDATE bookkeeper_scopes bs
   SET property_ids = ARRAY(SELECT x FROM unnest(bs.property_ids) AS x
                             WHERE NOT EXISTS (SELECT 1 FROM latest l
                                                WHERE l.scope_id = bs.id AND l.property_id = x)),
       updated_at = NOW()
 WHERE EXISTS (SELECT 1 FROM latest l WHERE l.scope_id = bs.id);
