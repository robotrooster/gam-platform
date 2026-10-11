-- 10/5 (Nic): "The only thing the landlord chooses is if they absorb the cost
-- or if they pass it through to the tenant or customer. That is it. ... that
-- setting is at the property level. So they cannot absorb it for some people
-- and pass it through to other people." On the onboarding screen he approved:
-- "card and bank payment fees — do we want to pass them on or cover them."
-- This supersedes the S512/S513 lock that card on rent is always the tenant's.
--
-- Four columns carry that one choice, and the payment code keeps reading them:
--   property_allocation_rules.ach_fee_payer / card_fee_payer   (rent)
--   properties.register_card_fee_payer   (front counter and pay links)
--   properties.booking_card_fee_payer    (booking site)
-- These triggers make them one setting. Whichever of the four a write changes
-- decides the other three, in the same statement, so no route, script or
-- manual UPDATE can leave a property half covered.
--   - within a table: the changed column wins (on INSERT, ach_fee_payer /
--     register_card_fee_payer win);
--   - across tables: an insert or change on the allocation rule sets the
--     property's two columns; a change on the property sets the rule's two.
--     Each side writes only when the other differs, so it stops after one hop.
--
-- No backfill needed: every live property already passes everything on
-- (rules tenant/tenant, properties customer/customer — checked 10/5).
-- Safe drop: drop the four triggers and three functions.

CREATE OR REPLACE FUNCTION public.one_fee_choice_rule_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.card_fee_payer := NEW.ach_fee_payer;
  ELSIF NEW.ach_fee_payer IS DISTINCT FROM OLD.ach_fee_payer THEN
    NEW.card_fee_payer := NEW.ach_fee_payer;
  ELSIF NEW.card_fee_payer IS DISTINCT FROM OLD.card_fee_payer THEN
    NEW.ach_fee_payer := NEW.card_fee_payer;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.one_fee_choice_property_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.booking_card_fee_payer := NEW.register_card_fee_payer;
  ELSIF NEW.register_card_fee_payer IS DISTINCT FROM OLD.register_card_fee_payer THEN
    NEW.booking_card_fee_payer := NEW.register_card_fee_payer;
  ELSIF NEW.booking_card_fee_payer IS DISTINCT FROM OLD.booking_card_fee_payer THEN
    NEW.register_card_fee_payer := NEW.booking_card_fee_payer;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.one_fee_choice_across() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'property_allocation_rules' THEN
    UPDATE public.properties
       SET register_card_fee_payer = CASE WHEN NEW.ach_fee_payer = 'landlord' THEN 'landlord' ELSE 'customer' END
     WHERE id = NEW.property_id
       AND register_card_fee_payer IS DISTINCT FROM
           (CASE WHEN NEW.ach_fee_payer = 'landlord' THEN 'landlord' ELSE 'customer' END);
  ELSE
    UPDATE public.property_allocation_rules
       SET ach_fee_payer = CASE WHEN NEW.register_card_fee_payer = 'landlord' THEN 'landlord' ELSE 'tenant' END
     WHERE property_id = NEW.id
       AND ach_fee_payer IS DISTINCT FROM
           (CASE WHEN NEW.register_card_fee_payer = 'landlord' THEN 'landlord' ELSE 'tenant' END);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_one_fee_choice_rule_row
  BEFORE INSERT OR UPDATE OF ach_fee_payer, card_fee_payer ON public.property_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION public.one_fee_choice_rule_row();

CREATE TRIGGER trg_one_fee_choice_property_row
  BEFORE INSERT OR UPDATE OF register_card_fee_payer, booking_card_fee_payer ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.one_fee_choice_property_row();

CREATE TRIGGER trg_one_fee_choice_rule_to_property
  AFTER INSERT OR UPDATE OF ach_fee_payer, card_fee_payer ON public.property_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION public.one_fee_choice_across();

CREATE TRIGGER trg_one_fee_choice_property_to_rule
  AFTER UPDATE OF register_card_fee_payer, booking_card_fee_payer ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.one_fee_choice_across();
