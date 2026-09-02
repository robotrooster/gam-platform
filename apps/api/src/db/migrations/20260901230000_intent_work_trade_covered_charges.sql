-- S635 (Nic): WHICH CHARGES A WORK TRADE COVERS IS KNOWN AT INVITE TIME, NOT AT
-- SIGNING.
--
-- `pending_tenant_intents` already carries is_work_trade, hours target and
-- duties — everything about the arrangement EXCEPT the part that decides money.
-- routes/esign.ts creates the work_trade_agreement when the lease completes and
-- passes no covered_charges, so every agreement was born with the column
-- default: rent, fees, water, sewer, electric, gas, trash, propane. Everything.
--
-- That default is wrong for most real arrangements. Nic, setting up Mountain
-- View: "Mobile home one covers electricity and propane... mobile home five and
-- ten, space rent only." A trade that covers electric and propane but NOT rent
-- would have suspended the rent anyway on the tenant's very first invoice, and
-- the error surfaces as a resident who was never billed for the thing they
-- actually owe. The landlord knows the answer when they flag the invite; there
-- is no reason to make them go back and correct an agreement afterwards.
--
-- NULL means "not stated" and the agreement falls back to the table default, so
-- nothing about an existing invite changes. Same CHECK as the agreement table —
-- one vocabulary, enforced in both places.
--
-- BACKFILL: none needed. Every existing intent is NULL, which is exactly the
-- behaviour it had before this column existed.
ALTER TABLE pending_tenant_intents
  ADD COLUMN IF NOT EXISTS work_trade_covered_charges text[];

ALTER TABLE pending_tenant_intents
  DROP CONSTRAINT IF EXISTS pending_intent_work_trade_covered_check;

ALTER TABLE pending_tenant_intents
  ADD CONSTRAINT pending_intent_work_trade_covered_check
  CHECK (work_trade_covered_charges IS NULL
         OR (array_length(work_trade_covered_charges, 1) > 0
             AND work_trade_covered_charges <@ ARRAY[
               'rent','fees','water','sewer','electric','gas','trash','propane']));
