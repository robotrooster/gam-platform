-- ════════════════════════════════════════════════════════════════════════
-- CONTRACT STEP C0 — NOT A MIGRATION. DO NOT MOVE INTO migrations/ UNTIL THE
-- S655 MONEY CODE IS LIVE.
--
-- WHEN TO RUN: deploy day (money plan §5 P4), minutes after the API restart
-- that ships the credit ledger code (services/creditUse.ts and every path that
-- spends credit through credit_uses), and after the P2 backfill. Confirm the
-- new code is the running code first:
--   * M1-M12 (20261003100000 .. 20261003101100) are in schema_migrations;
--   * the API process started after the deploy (launchctl print).
--
-- HOW: move this file into apps/api/src/db/migrations/ (keep the name; it
-- sorts after M12), run npm run migrate on gam and then gam_demo, then
-- npm run db:dump-schema and commit. It is idempotent: running it twice
-- changes nothing.
--
-- WHY (two guards the old code would trip):
--   1. payment_reversals keeps ONE record per (event, row) through M11's index.
--      The old UNIQUE(stripe_event_id) allowed only one row per event, so a
--      dispute could reopen only one of the rows its charge paid. The old code's
--      ON CONFLICT (stripe_event_id) needs that constraint, so it goes only once
--      the old code is gone.
--   2. amount_remaining on tenant_credits and lease_prepaid_credits moves ONLY
--      through credit_uses (trg_credit_uses_apply turns gam.credit_ledger on for
--      its own update). A new credit starts whole. The old code wrote
--      amount_remaining directly (the void route, the desk's draw-down, the
--      prepaid draw, move-out), so this guard waits for it to be gone. The deploy
--      backfill (gam.credit_backfill) records history that already moved the
--      balance, and passes.
--
-- Running it before the deploy is what must NOT happen: every old-code spend
-- of a credit would fail and roll back the payment that carried it.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key;

CREATE OR REPLACE FUNCTION credit_remaining_moves_by_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- current_setting(..., true) is NULL when never set in this session: read
  -- through COALESCE so NULL means "off".
  IF COALESCE(current_setting('gam.credit_ledger', true), '') = 'on'
     OR COALESCE(current_setting('gam.credit_backfill', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.amount_remaining <> NEW.amount_original THEN
    RAISE EXCEPTION 'A new credit starts whole' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' AND NEW.amount_remaining IS DISTINCT FROM OLD.amount_remaining THEN
    RAISE EXCEPTION 'Credit balance moves only through credit_uses' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION credit_remaining_moves_by_ledger() IS
  'S655 C0: amount_remaining on both credit tables moves only through credit_uses (trg_credit_uses_apply) or the deploy backfill; a new credit starts whole.';

DROP TRIGGER IF EXISTS trg_tenant_credits_remaining_by_ledger ON tenant_credits;
CREATE TRIGGER trg_tenant_credits_remaining_by_ledger
  BEFORE INSERT OR UPDATE OF amount_remaining ON tenant_credits
  FOR EACH ROW EXECUTE FUNCTION credit_remaining_moves_by_ledger();
DROP TRIGGER IF EXISTS trg_lease_prepaid_credits_remaining_by_ledger ON lease_prepaid_credits;
CREATE TRIGGER trg_lease_prepaid_credits_remaining_by_ledger
  BEFORE INSERT OR UPDATE OF amount_remaining ON lease_prepaid_credits
  FOR EACH ROW EXECUTE FUNCTION credit_remaining_moves_by_ledger();
