-- S605 (Nic): show the linked account's balance.
--
-- The FC application was submitted with `payment_method` + `transactions` only —
-- balances were skipped because nothing read them. Nic then asked "how do we see
-- what the bank account balance is?", which is a fair thing to want on a page
-- that already shows that bank's activity.
--
-- Stripe had ALREADY approved `balances` alongside `transactions`, so no
-- application change was needed. Existing links consented to transactions only,
-- so they must be re-linked once to grant it; new links request both up front.
--
-- Cached rather than fetched live: the Bank page shouldn't make a vendor call on
-- every render, and a balance stamped with its as-of time is honest about being
-- a snapshot. Refreshed on each sync.
--
-- No backfill: NULL means "not yet known", which is accurate for every existing
-- connection until it is re-linked.

ALTER TABLE bank_connections
  ADD COLUMN IF NOT EXISTS current_balance   numeric(14,2),
  ADD COLUMN IF NOT EXISTS balance_currency  text,
  ADD COLUMN IF NOT EXISTS balance_as_of     timestamptz;

COMMENT ON COLUMN bank_connections.current_balance IS
  'S605: cached account balance from Stripe FC, refreshed on sync. NULL = the link has no balances consent (pre-S605 links) or none reported.';
