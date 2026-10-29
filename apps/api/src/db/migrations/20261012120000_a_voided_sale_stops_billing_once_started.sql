-- 10/12 (Nic) — A VOIDED INSTALLMENT CONTRACT ENDS ITS SALE, EVEN ONE ALREADY BILLING.
--
--   "We need people to be billed correctly regardless of signing status."
--
-- From today the LANDLORD's signature starts a home sale billing
-- (services/homeSale activateHomeSaleContract, called on his signature in
-- routes/esign.ts), the way his signature has issued a lease since S647. The
-- buyer's signature no longer holds it back. So a sale can be ACTIVE while the
-- buyer has not signed, and its agreement can still be voided: a document only
-- the landlord has signed binds nobody (lib/voidDocument refuses only once a
-- TENANT has signed).
--
-- S652's trigger (20260921070000) cancelled the sale only while it was
-- 'pending_signature', on the reasoning that "an active contract means somebody
-- signed for it". That is no longer true. Left as it was, voiding a
-- landlord-signed agreement would leave its sale active and billing every month
-- on paper that no longer exists.
--
-- So the trigger now also cancels an ACTIVE sale whose agreement nobody but the
-- landlord signed. A sale the buyer signed for is still never touched (no void
-- path can reach that document; this guards a hand-written UPDATE too).
--
-- The home payments such a sale already put on the buyer's bill come off in
-- lib/voidDocument (unwindHomeSaleOnVoid), BEFORE the status changes, because
-- it has to be able to refuse in plain words when money already moved — a
-- trigger cannot. Every void path that can reach a landlord-signed agreement
-- goes through it (the 48-hour timeout resends rather than voids once the
-- landlord has signed). If some other path voids one with a home payment from
-- the sale still OWED, this trigger stops the void instead of leaving a
-- cancelled sale's charges on the bill.
--
-- cancelled_at is stamped now for every sale this cancels (it was left NULL for
-- a pending one; the cancel button has always stamped it).
--
-- The sale's row is locked before the trigger looks for home payments on the
-- bill. Putting due installments on the bill (services/homeSale
-- attachDueInstallmentsIn) holds that same lock, so a void racing it waits for
-- it to finish and then sees the lines it wrote — rather than checking first,
-- missing lines committed a moment later, and cancelling a sale whose home
-- payments then stay on the buyer's bill.
--
-- purchase_document_id's column comment (S629) said the contract stays
-- pending_signature until the agreement COMPLETES; restated for 10/12.
--
-- Expand-only and inert on today's data: every active contract's agreement is
-- completed (signed by everybody), and a completed document cannot be voided.
-- No backfill needed.

CREATE OR REPLACE FUNCTION cancel_unsigned_sale_on_void() RETURNS trigger AS $$
DECLARE
  buyer_signed boolean;
BEGIN
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
    PERFORM 1 FROM home_sale_contracts
      WHERE purchase_document_id = NEW.id AND status IN ('pending_signature', 'active')
      FOR UPDATE;

    SELECT EXISTS (
      SELECT 1 FROM lease_document_signers s
       WHERE s.document_id = NEW.id AND s.signed_at IS NOT NULL
         AND s.role NOT IN ('landlord', 'witness')) INTO buyer_signed;

    IF NOT buyer_signed AND EXISTS (
      SELECT 1 FROM home_sale_contracts c
        JOIN home_sale_installments i ON i.contract_id = c.id
        JOIN payments p ON p.home_sale_installment_id = i.id
       WHERE c.purchase_document_id = NEW.id AND c.status = 'active'
         AND p.status IN ('pending', 'failed')) THEN
      RAISE EXCEPTION 'The sale on installment contract % still has home payments on the buyer''s bill. Void it through lib/voidDocument, which takes them off first.', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE home_sale_contracts
       SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
     WHERE purchase_document_id = NEW.id
       AND (status = 'pending_signature' OR (status = 'active' AND NOT buyer_signed));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN home_sale_contracts.purchase_document_id IS 'S629: the signed purchase agreement this billing comes from. 10/12 (Nic): the contract stays pending_signature until the LANDLORD signs it (a buyer who belongs to another company: until the buyer signs, S655); that signature writes the schedule and starts the billing.';
