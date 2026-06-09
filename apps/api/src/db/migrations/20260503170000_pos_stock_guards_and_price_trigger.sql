-- S99: pos_items / pos_item_variants stock_qty NEVER negative + auto
-- price_history trigger.
--
-- Stock guards:
--   Pre-S99 the route at pos.ts:166 wraps every stock decrement in
--   `Math.max(0, stock_qty - qty)` — silently masks oversells. With
--   the CHECK in place, the existing route still works (clamped to 0
--   means the constraint never fires from that path) but any other
--   path (direct SQL, future migration, untrusted code) that tries to
--   write a negative value gets rejected loud.
--
--   Variants get the same guard for the same reason.
--
-- Auto price_history trigger:
--   Pre-S99 the route at pos.ts:83-87 INSERTs into pos_price_history
--   inline when a PATCH /items/:id mutates sell_price or cost_price.
--   Other write paths (direct SQL, future seed scripts, future bulk-
--   import) bypass the audit. The trigger moves the responsibility
--   into the DB so every UPDATE is logged regardless of who wrote it.
--   The route's inline INSERT becomes redundant and gets removed in
--   the same session.
--
-- Trigger uses BEFORE UPDATE to capture the pre-update values via OLD
-- and the post-update via NEW. Only fires when sell_price or cost_price
-- actually changes (other field updates are no-ops for price history).
-- changed_by is captured from a session GUC (`gam.user_id`) when set
-- by the route; NULL otherwise (direct SQL writes have no user).

ALTER TABLE pos_items
  ADD CONSTRAINT pos_items_stock_qty_nonneg CHECK (stock_qty >= 0);

ALTER TABLE pos_item_variants
  ADD CONSTRAINT pos_item_variants_stock_qty_nonneg CHECK (stock_qty >= 0);

CREATE OR REPLACE FUNCTION fn_pos_items_log_price_change()
RETURNS TRIGGER AS $$
DECLARE
  actor_id uuid;
BEGIN
  IF NEW.sell_price IS DISTINCT FROM OLD.sell_price
     OR NEW.cost_price IS DISTINCT FROM OLD.cost_price THEN
    -- Read actor from session GUC if set by the route layer; ignore
    -- error if unset (direct SQL writes log with NULL changed_by).
    BEGIN
      actor_id := current_setting('gam.user_id', true)::uuid;
    EXCEPTION WHEN OTHERS THEN
      actor_id := NULL;
    END;

    INSERT INTO pos_price_history
      (item_id, old_price, new_price, old_cost, new_cost, changed_by)
    VALUES
      (NEW.id, OLD.sell_price, NEW.sell_price, OLD.cost_price, NEW.cost_price, actor_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pos_items_price_history_trg
  BEFORE UPDATE ON pos_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_pos_items_log_price_change();
