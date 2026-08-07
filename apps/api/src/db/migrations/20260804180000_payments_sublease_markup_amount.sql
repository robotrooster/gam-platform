-- S581 (Leases + e-sign sweep): sublease markup was silently dropped under
-- platform-holds.
--
-- WHY: when a sublessee pays, the invoice is for sub_monthly_amount. The
-- sublessor's markup (sub_monthly_amount - master_share_amount) is supposed to
-- go to the sublessor while the LANDLORD receives only master_share_amount. The
-- old destination-charge model diverted the markup via application_fee_amount so
-- Stripe routed less to the landlord. The S560 platform-holds rebuild made
-- application_fee_amount dead (createRentPlatformCharge is a plain PaymentIntent),
-- but nothing replaced the diversion: services/allocation.ts computes owner_share
-- on the FULL sub amount (markup not subtracted), yet creditSublessorMarkupForPayment
-- STILL credits the sublessor the markup. So the landlord is overpaid the markup
-- AND the sublessor is paid it — GAM's platform balance eats the difference every
-- marked-up sublease payment.
--
-- FIX: stamp the per-month markup on the payment (parallel to
-- gam_supersedence_amount). allocation subtracts it from owner_share (landlord
-- nets master_share), and creditSublessorMarkupForPayment credits that SAME
-- stamped amount — so the amount removed from the landlord always equals the
-- amount paid to the sublessor. Default 0 (non-sublease / full-pass-through
-- payments are unaffected). No backfill: no live marked-up subleases pre-launch.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS sublease_markup_amount numeric NOT NULL DEFAULT 0;
