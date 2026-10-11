-- 10/6 (Nic) — "about what time were you at the bank?"
--
-- Nic, 10/6: "the tenant logs into the portal and they say, hey, I deposited
-- ... on this date at ... approximately this time. Maybe they just pick a
-- time, you know, three o'clock, four o'clock ... GAM can match the
-- transaction to something near that window because for people that pay the
-- exact same amount, the probability that they're going to be in the bank at
-- exactly the same time also kind of shrinks."
--
-- A tenant's report of a bank deposit now carries the hour they were at the
-- bank: 8 AM through 6 PM by the hour (declared_hour 8–18), or after hours /
-- an ATM (declared_after_hours). The tenant must pick one (the route refuses a
-- report without it). The matcher (services/declaredDepositAssign) uses it to
-- tell two same-amount deposits apart when the bank writes a time on its own
-- line (Mountain View's bank: "eDeposit in Branch 09/30/26 04:39:28 PM ...").
--
-- Backfill: none. Reports made before this carry neither (NULL / false): the
-- matcher treats them as "no time given" and never guesses one. The
-- requirement lives in the route, not a CHECK, so those older rows can still
-- be confirmed, expired and withdrawn.
-- Safe drop: both columns (nothing else depends on them).

ALTER TABLE public.tenant_declared_deposits
  ADD COLUMN IF NOT EXISTS declared_hour smallint,
  ADD COLUMN IF NOT EXISTS declared_after_hours boolean NOT NULL DEFAULT false;

ALTER TABLE public.tenant_declared_deposits
  ADD CONSTRAINT tenant_declared_deposits_hour_range
    CHECK (declared_hour IS NULL OR declared_hour BETWEEN 8 AND 18),
  ADD CONSTRAINT tenant_declared_deposits_hour_or_after_hours
    CHECK (NOT (declared_after_hours AND declared_hour IS NOT NULL));

COMMENT ON COLUMN public.tenant_declared_deposits.declared_hour IS
  '10/6 (Nic): about what time the tenant says they were at the bank — the hour they picked, 8 (8 AM) through 18 (6 PM). NULL: after hours / ATM (declared_after_hours), or a report made before the time was asked.';
COMMENT ON COLUMN public.tenant_declared_deposits.declared_after_hours IS
  '10/6 (Nic): the tenant says they deposited after banking hours or at an ATM.';
