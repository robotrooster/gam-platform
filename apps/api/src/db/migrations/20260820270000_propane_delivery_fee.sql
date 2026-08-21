-- S613 (Nic): the delivery fee / fuel surcharge on a propane invoice.
--
-- Nic's read was that it already passes through — "you do the allocation per
-- unit based off of the total bill so the whole thing is zeroed out." That is
-- true of a RUBS master on the bill-amount basis, which divides the provider's
-- actual dollar charge. It is NOT true of a per-tank fill: recordFill totals
-- gallons × price per gallon (plus the landlord's propane tax) and nothing else,
-- so a $35 hazmat or fuel surcharge on the ticket is absorbed by the landlord,
-- silently, on every delivery.
--
-- He left the call to me — "if you see practical case, do it, and do it in a way
-- that is industry standard." Propane suppliers bill these per STOP, so the
-- normal pass-through when one truck fills several tanks is pro-rata by gallons;
-- an even per-tank split is the other common treatment and some parks prefer it.
-- Both are offered, defaulting to gallons, because which is fair is the
-- landlord's call and the state's, not ours.
--
-- Stored as the TANK'S SHARE, not the whole ticket's fee, so a fill row still
-- answers "what did this tenant owe for this delivery" on its own. Not taxed:
-- the propane tax rate is a fuel tax on the gallons, and applying it to a
-- delivery charge would invent a tax the landlord never configured.
ALTER TABLE propane_fills
  ADD COLUMN IF NOT EXISTS delivery_fee_share numeric(10,2) NOT NULL DEFAULT 0
    CHECK (delivery_fee_share >= 0);

COMMENT ON COLUMN propane_fills.delivery_fee_share IS
  'S613: this tank''s share of the delivery charge on the supplier ticket '
  '(hazmat / fuel surcharge / per-stop fee). Included in total_amount and in '
  'the instalment schedule. Untaxed — the propane tax applies to the fuel.';
