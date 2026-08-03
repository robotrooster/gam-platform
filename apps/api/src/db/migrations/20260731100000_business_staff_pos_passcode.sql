-- S574 (Nic) — cashier register passcode for the terminal lock screen.
--
-- Owners get mandatory email 2FA (they see reports + sensitive data). Cashiers
-- (business_staff) instead sign in at a bound POS terminal with a short numeric
-- passcode — fast switching on a shared register — and that passcode session is
-- capability-locked to ringing sales, taking payment, and refunds (refund still
-- gated by the pos.refund permission). No email 2FA for a passcode session; it
-- can never reach reports, settings, or any sensitive surface.
--
-- The passcode is bcrypt-hashed here (never stored plaintext), exactly like a
-- password. NULL = this staff member has no passcode set and cannot use the
-- lock screen (they'd sign in with full email+password instead). Owner sets /
-- clears it on the Staff page.
ALTER TABLE business_users
  ADD COLUMN IF NOT EXISTS pos_passcode_hash text,
  ADD COLUMN IF NOT EXISTS pos_passcode_updated_at timestamp with time zone;

COMMENT ON COLUMN public.business_users.pos_passcode_hash IS
  'S574: bcrypt hash of the cashier register passcode (4–6 digits). NULL = no passcode set (cannot use the terminal lock screen). Unlocking mints a posLimited cashier session scoped to the POS register only.';
