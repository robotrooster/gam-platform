-- S652 (Nic): "tenants do not still owe $744.45… I have one guy that hasn't
-- paid his bill."
--
-- A utility bill rides an invoice line (payments.type = 'utility') and was
-- marked paid in exactly one place: the Stripe webhook. Cash, check, money
-- order, a confirmed bank deposit, applied credit, a released prepayment —
-- every other way a payment settles left the bill reading "billed" forever.
-- Mountain View had five of them ($532.14), all paid at the counter.
--
-- There are a dozen settlement paths and there will be more, so the rule lives
-- on the table, not in each caller: a utility bill's paid state FOLLOWS the
-- payment it is attached to.
CREATE OR REPLACE FUNCTION utility_bills_follow_payment() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'settled' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'settled') THEN
    UPDATE utility_bills
       SET status = 'paid', paid_at = COALESCE(NEW.settled_at, now()), updated_at = now()
     WHERE payment_id = NEW.id AND status IN ('billed', 'unbilled');
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'settled' AND NEW.status <> 'settled' THEN
    -- a returned check or a reversed payment: the bill is owed again
    UPDATE utility_bills
       SET status = 'billed', paid_at = NULL, updated_at = now()
     WHERE payment_id = NEW.id AND status = 'paid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_utility_bills_follow_payment ON payments;
CREATE TRIGGER trg_utility_bills_follow_payment
  AFTER INSERT OR UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION utility_bills_follow_payment();

-- The ones already settled before the rule existed.
UPDATE utility_bills ub
   SET status = 'paid', paid_at = COALESCE(p.settled_at, now()), updated_at = now()
  FROM payments p
 WHERE p.id = ub.payment_id AND p.status = 'settled' AND ub.status IN ('billed', 'unbilled');
