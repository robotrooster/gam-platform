-- 10/15 (Nic): "theres only one computer downstairs so i know where you think
-- it happened but yes lets record devices so if a problem happens we can
-- solve." Yesterday two cash payments were recorded by an account (Lisa's)
-- from a signed-in browser, and nothing in GAM says WHICH device: the receipt
-- keeps who and when, never where from. Asking the database could not settle
-- it, so from now on a recorded payment keeps the device with it.
--
-- received_device is the browser's own description of itself (user agent), cut
-- to 300 characters; received_ip is the address the request came from (the
-- first proxy hop is trusted, index.ts 'trust proxy'). Both are NULL on a
-- receipt GAM wrote itself (a card or bank payment, a bank match) — nobody
-- typed those.
--
-- Expand only. No backfill: yesterday's receipts have no device to recover.
ALTER TABLE tenant_remittances
  ADD COLUMN IF NOT EXISTS received_ip     inet,
  ADD COLUMN IF NOT EXISTS received_device text;

COMMENT ON COLUMN tenant_remittances.received_ip IS
  '10/15 (Nic): the address a hand-recorded payment was entered from; NULL when GAM wrote the receipt itself.';
COMMENT ON COLUMN tenant_remittances.received_device IS
  '10/15 (Nic): the browser that entered a hand-recorded payment (user agent, 300 chars).';
