-- 10/25 (Nic) — THE SECOND FACTOR ON A GAM CUSTOMER PROFILE.
--
--   "Me just giving out somebody's phone number and using their card to pay
--    doesn't work... I'm going to give you my phone number to pay this bill
--    from my account, and you have to give them like a 6 or 8 digit code that
--    you have memorized. That way, some second factor authentication where
--    somebody knowing your phone number can't just use your account."
--
-- The whole walletless idea rests on this: "a society where your GAM account is
-- your bank and you can handle all your transactions with no wallet at all...
-- pay either facial scan, fingerprint, retinal scan, or a PIN."
--
-- THE RULE THIS WRITES DOWN: a phone number IDENTIFIES a person. It never
-- authorizes anything. Money moves on a profile only when a factor the person
-- holds is presented too.
--
-- HOW THE CODE IS KEPT. Hashed with bcrypt, exactly like a password, and never
-- stored, returned, logged or emailed in the clear. It is 6 to 8 digits because
-- that is what a person will memorize — which is also why it MUST be rate
-- limited: a six-digit code is a million guesses, which is nothing to a script
-- and about three days of patient guessing at one a second. So:
--
--   * failed attempts are counted on the profile, not per session, so trying
--     from somewhere new does not reset the count;
--   * five wrong codes locks it for fifteen minutes (locked_until), and the
--     lock is on the ACCOUNT because the attacker is the one choosing where to
--     try from;
--   * a correct code clears the count.
--
-- Biometrics (face, fingerprint, retina) are the later alternatives to the
-- code, which is why the column is named for the factor and not for a PIN.
--
-- Nothing is set by this migration: every profile starts with no factor, and a
-- profile with no factor can authorize nothing. That is the safe default — a
-- customer who has set no code simply pays the way they do today.
--
-- Expand-only and re-runnable.

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS pay_code_hash        text,
  ADD COLUMN IF NOT EXISTS pay_code_set_at      timestamptz,
  ADD COLUMN IF NOT EXISTS pay_code_failures    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pay_code_locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS pay_code_last_used_at timestamptz;

COMMENT ON COLUMN customer_profiles.pay_code_hash IS
  'bcrypt hash of the 6-8 digit code the customer memorizes (Nic, 10/25) — the
   second factor that makes a phone number an identifier rather than an
   authorization. NEVER stored, returned, logged or emailed in the clear. NULL =
   no factor set, and a profile with no factor can authorize nothing.';
COMMENT ON COLUMN customer_profiles.pay_code_failures IS
  'Consecutive wrong codes, counted on the ACCOUNT so trying from somewhere new
   does not reset it. A six-digit code is only a million guesses.';
COMMENT ON COLUMN customer_profiles.pay_code_locked_until IS
  'Set when the failure count hits the ceiling; no code is accepted until it
   passes. On the account, because the attacker chooses where to try from.';
