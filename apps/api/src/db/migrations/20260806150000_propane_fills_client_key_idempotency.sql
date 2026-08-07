-- Propane fill idempotency (S594, Nic — money-path double-charge fix).
--
-- WHY: POST /api/propane/fills creates a fill + an immediate installment-#1
-- charge + accelerates any prior balance, all with no idempotency guard. A
-- repeated submission of the SAME fill intent (lost-response retry, a second
-- open tab, a stale re-click) therefore recorded a SECOND fill and DOUBLE-
-- CHARGED the tenant. The landlord UI disables the button while in-flight,
-- which stops a synchronous double-click, but not those cases.
--
-- FIX: the client stamps one stable key per "Record fill" intent; the fill row
-- carries it, and a partial-unique index makes a repeat a hard no-op (the route
-- short-circuits and returns the already-recorded fill, creating no new charge).
--
-- SAFE: additive nullable column; existing rows have NULL client_key and are
-- unaffected (the partial index only constrains non-null keys). No backfill.

ALTER TABLE public.propane_fills
  ADD COLUMN IF NOT EXISTS client_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ux_propane_fills_client_key
  ON public.propane_fills (client_key)
  WHERE (client_key IS NOT NULL);

COMMENT ON COLUMN public.propane_fills.client_key IS
  'S594: client-supplied idempotency key (one per Record-Fill intent). Partial-unique so a repeated submission is a no-op instead of a double-charge.';
