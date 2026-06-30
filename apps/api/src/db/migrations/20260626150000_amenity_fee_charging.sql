-- Amenity reservation-fee charging + demand pricing (walkthrough Amenities #4, Nic 2026-06-26)
--
-- WHY: the common-area reservation fee must actually be CHARGED on-platform (all
-- money through GAM, like rent), the landlord may set demand pricing (a higher
-- weekend rate), and it's refundable if cancelled 48h+ before the reservation.
-- The fee is billed as a normal `payments` row (type='fee', fee_type=amenity_fee)
-- that the tenant pays through the existing Stripe rails — no bespoke charge code.
--
-- NO BACKFILL NEEDED — all new nullable/false columns.

-- Demand pricing: optional higher fee when the reservation falls on a weekend
-- (Fri/Sat/Sun). NULL = flat reservation_fee always.
ALTER TABLE public.common_areas
  ADD COLUMN IF NOT EXISTS weekend_fee numeric(10,2);

-- Link a reservation to the fee payment it generated + track refund state.
ALTER TABLE public.common_area_reservations
  ADD COLUMN IF NOT EXISTS fee_payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fee_refund_due boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fee_voided boolean NOT NULL DEFAULT false;
