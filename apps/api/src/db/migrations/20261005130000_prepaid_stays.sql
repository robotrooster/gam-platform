-- 10/5 (Nic) — PREPAID STAYS. Spec: decisions #41-#43 and the 10/5 answers.
--   * 22+ continuous nights need a background check; its fee rides on the
--     payment that sells or extends the stay and waits for the guest.
--   * 30+ nights ask LEASE or STAY (the guest online, the counter at the
--     register). No lease is ever drafted automatically again.
--   * A stay with no lease is invoiced for its site's utilities through a
--     utility service agreement tied to the stay.
--
-- Expand only: new nullable/defaulted columns and a new table; the code that
-- reads them ships with this. Safe drop: the table and the four columns, and
-- the screening_fee kind (no rows can use it before the code ships).

-- The 30+ night answer. NULL = not asked (under 30 nights, or made before this).
ALTER TABLE public.unit_bookings
  ADD COLUMN IF NOT EXISTS stay_terms text
    CONSTRAINT unit_bookings_stay_terms_check CHECK (stay_terms IS NULL OR stay_terms IN ('lease', 'stay'));

-- Set once the guest's continuous stay reached 22+ nights: check-in then waits
-- for the background check's results and the landlord's decision.
ALTER TABLE public.unit_bookings
  ADD COLUMN IF NOT EXISTS screening_required boolean NOT NULL DEFAULT false;

-- A background-check fee paid inside a stay's payment, waiting for the guest to
-- fill the check out (no second charge at intake). GAM's money: it is taken
-- from the landlord's next payout as a 'screening_fee' charge line, card or cash.
CREATE TABLE IF NOT EXISTS public.screening_prepayments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id        uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  property_id        uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  booking_id         uuid REFERENCES public.unit_bookings(id) ON DELETE SET NULL,
  tenant_id          uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  email              text,
  amount             numeric(10,2) NOT NULL CHECK (amount > 0),
  source             text NOT NULL CHECK (source IN ('register', 'pay_link', 'booking_site', 'schedule')),
  source_id          uuid,
  status             text NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used', 'void')),
  used_by_check_id   uuid REFERENCES public.background_checks(id) ON DELETE SET NULL,
  landlord_charge_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  used_at            timestamptz,
  voided_at          timestamptz
);
-- One live prepayment per stay.
CREATE UNIQUE INDEX IF NOT EXISTS screening_prepayments_one_per_booking
  ON public.screening_prepayments (booking_id) WHERE booking_id IS NOT NULL AND status <> 'void';
CREATE INDEX IF NOT EXISTS screening_prepayments_person
  ON public.screening_prepayments (landlord_id, tenant_id, lower(email)) WHERE status = 'unused';

-- The stay a utility agreement bills for (a 30+ night stay with no lease).
ALTER TABLE public.utility_service_agreements
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.unit_bookings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS utility_service_agreements_one_per_booking
  ON public.utility_service_agreements (booking_id) WHERE booking_id IS NOT NULL;

-- GAM's screening fee netted from the landlord's payout.
ALTER TABLE public.landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_kind_check;
ALTER TABLE public.landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_kind_check
  CHECK (kind = ANY (ARRAY['subscription'::text, 'manual_payment_fee'::text, 'bank_debit_cost'::text,
                           'device_installment'::text, 'screening_fee'::text]));
