-- 10/12 (Nic) — A CARD READER INSTALLMENT NAMES ITS ORDER (ledger design P0/P1).
--
-- services/readerOrders raises a $350 reader in four monthly pieces as
-- landlord_gam_charges rows (kind 'device_installment'), but wrote them with
-- source_id NULL, so a piece could not be tied back to the order it pays — the
-- books need that to clear the reader's payable piece by piece (design §6 H4).
--
-- Why not source_id = the order, as the design first said: the table's
-- landlord_gam_charges_source_uniq allows ONE row per (source_type, source_id),
-- and an order has four pieces. That index is what chargeLandlord's
-- ON CONFLICT names (the running code needs it), so it stays. The order and the
-- piece number get their own columns instead, unique together, which also
-- stops a piece from ever being raised twice.
--
-- Expand-only. Old writers (source_id NULL, no order) stay valid.
-- BACKFILL: each existing piece is matched to its order by company and
-- property, numbered by the "payment N of M" its notes carry (else by when it
-- was raised). A property with more than one order is left unmatched and
-- reported. Production 10/12: 1 order (Mountain View, $350, 4 pieces), 1 piece
-- raised (0f912e37, $87.50) → piece 1. Re-run the UPDATE below after the code
-- ships if a piece is raised in between (only on the 1st of a month or when
-- GAM marks an order shipped).

ALTER TABLE landlord_gam_charges
  ADD COLUMN IF NOT EXISTS reader_order_id    uuid REFERENCES pos_reader_orders(id),
  ADD COLUMN IF NOT EXISTS installment_number smallint;

ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_reader_piece_check;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_reader_piece_check
  CHECK ((reader_order_id IS NULL) = (installment_number IS NULL)
         AND (installment_number IS NULL OR installment_number > 0));

CREATE UNIQUE INDEX IF NOT EXISTS landlord_gam_charges_reader_piece_uniq
  ON landlord_gam_charges (reader_order_id, installment_number) WHERE reader_order_id IS NOT NULL;

WITH pieces AS (
  SELECT c.id, o.order_id, o.orders_here,
         COALESCE(substring(c.notes FROM 'payment ([0-9]+) of')::smallint,
                  ROW_NUMBER() OVER (PARTITION BY c.landlord_id, c.property_id ORDER BY c.created_at, c.id)::smallint) AS n
    FROM landlord_gam_charges c
    CROSS JOIN LATERAL (
      SELECT (array_agg(r.id))[1] AS order_id, COUNT(*) AS orders_here
        FROM pos_reader_orders r
       WHERE r.landlord_id = c.landlord_id AND r.property_id = c.property_id) o
   WHERE c.source_type = 'reader_order_installment' AND c.reader_order_id IS NULL
)
UPDATE landlord_gam_charges c
   SET reader_order_id = p.order_id, installment_number = p.n
  FROM pieces p
 WHERE p.id = c.id AND p.orders_here = 1
   AND NOT EXISTS (SELECT 1 FROM landlord_gam_charges x
                    WHERE x.reader_order_id = p.order_id AND x.installment_number = p.n);

DO $$
DECLARE left_over integer;
BEGIN
  SELECT COUNT(*) INTO left_over FROM landlord_gam_charges
   WHERE source_type = 'reader_order_installment' AND reader_order_id IS NULL;
  IF left_over > 0 THEN
    RAISE NOTICE 'reader installments not matched to an order (more than one order at the property): %', left_over;
  END IF;
END $$;

COMMENT ON COLUMN landlord_gam_charges.reader_order_id IS
  '10/12 (ledger P0): the card reader order this device_installment piece pays (pos_reader_orders). With installment_number, unique.';
COMMENT ON COLUMN landlord_gam_charges.installment_number IS
  '10/12: which piece of the reader order (1..installments).';
