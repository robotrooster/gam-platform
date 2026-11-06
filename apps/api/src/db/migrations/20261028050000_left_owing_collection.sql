-- 10/27 (Nic) — THE SECOND DOOR IS NOT BUYING A DEBT. IT IS AGREEING TO COLLECT ONE.
--
-- The earlier design had the clicking landlord ASSUME the debt. He replaced it:
--
--   "We don't phrase it as the landlord assuming that debt. We phrase it as the
--    landlord will be collecting this debt on behalf of the previous landlord.
--    It's not optional. If they allow them on the platform, that's it. They are
--    agreeing to that as part of the collective of GAM."
--
-- So there is no button that buys anything, and no choice to decline while
-- still taking the resident:
--
--   "There's no button they click to accept the sort of taking on the debt.
--    It's they're clicking that they accept that a payment arrangement is going
--    to be added to that tenant's portal. And there's no options around it.
--    That's it. That's just how it is. Otherwise, that tenant cannot be on the
--    platform."
--
-- HOW THE MONEY MOVES, in his words:
--
--   "The tenant will be charged in installments in addition to whatever rent
--    that new landlord has. And that will be collected from that landlord's
--    payouts or disbursements. So the new landlord will still get a cut of the
--    part that's collected. And if the full amount is not collected by the time
--    the tenant leaves the second landlord, then... any outstanding balance
--    that's not paid to the first landlord by the time the tenant leaves the
--    second landlord is going to be withdrawn from the second landlord's
--    disbursement balance. The first landlord will be made whole, and the
--    second landlord's owed amount will be calculated based on that first
--    landlord's balance that was passed on, plus any outstanding from what was
--    accrued with that second landlord, and that will show to a third
--    landlord."
--
-- So a debt never dies; it moves. Landlord one is made whole when the resident
-- leaves landlord two, and whatever landlord two is out — the carried balance
-- plus anything the resident ran up with them — becomes what a third landlord
-- sees. `carried_from_id` is that chain, and it is why this is a table rather
-- than a column on tenant_left_owing.
--
-- ONLY GAM BALANCES. "This only applies to balances on GAM. Carry forward
-- balances from landlords that migrate from other platforms are only a kind of
-- watch list." The CHECK below refuses to open an arrangement against an
-- imported debt, in the database, so no later code path can do it by accident.
--
-- NO BACKFILL NEEDED: tenant_left_owing has 0 rows in production, so there is
-- no history to open arrangements for. Verified read-only before writing this.

CREATE TABLE IF NOT EXISTS public.left_owing_collections (
  id                      uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),

  -- The debt being collected, and who is owed it.
  owing_id                uuid NOT NULL REFERENCES public.tenant_left_owing(id),
  owed_landlord_id        uuid NOT NULL REFERENCES public.landlords(id),

  -- The landlord who took the resident on, and is therefore collecting.
  collecting_landlord_id  uuid NOT NULL REFERENCES public.landlords(id),
  tenant_id               uuid NOT NULL REFERENCES public.tenants(id),

  -- What was owed when the arrangement opened, and what has been collected.
  total_amount            numeric(12,2) NOT NULL,
  collected_amount        numeric(12,2) NOT NULL DEFAULT 0,
  -- What rides each month's rent. Never a choice the resident makes.
  installment_amount      numeric(12,2) NOT NULL,

  -- 'active'    collecting now, riding the resident's rent.
  -- 'complete'  paid in full; the debt is settled.
  -- 'carried'   the resident left this landlord still owing, so the remainder
  --             moved on to a new debt (carried_to_owing_id).
  status                  text NOT NULL DEFAULT 'active',
  carried_to_owing_id     uuid REFERENCES public.tenant_left_owing(id),
  -- The arrangement this one's debt came from, so the chain is readable from
  -- either end.
  carried_from_id         uuid REFERENCES public.left_owing_collections(id),

  -- The acknowledgment. Not consent to take the debt on — a record that they
  -- were told a payment arrangement would appear in the resident's portal.
  acknowledged_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_by         uuid REFERENCES public.users(id),
  acknowledged_words      text NOT NULL,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT left_owing_collections_status_check
    CHECK (status = ANY (ARRAY['active'::text, 'complete'::text, 'carried'::text])),
  CONSTRAINT left_owing_collections_amounts_sane
    CHECK (total_amount > 0 AND installment_amount > 0
           AND collected_amount >= 0 AND collected_amount <= total_amount),
  -- 'carried' is the only status that may name where the rest went, and it
  -- must name it: a carried arrangement with nothing to point at has lost a
  -- debt, which is the one thing this table exists to prevent.
  CONSTRAINT left_owing_collections_carried_is_stamped
    CHECK ((status = 'carried') = (carried_to_owing_id IS NOT NULL)),
  -- A landlord never collects a debt they are themselves owed.
  CONSTRAINT left_owing_collections_not_self
    CHECK (collecting_landlord_id <> owed_landlord_id)
);

-- One arrangement per debt per collecting landlord. Taking the same resident
-- on twice does not raise the debt twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_left_owing_collections_debt_landlord
  ON public.left_owing_collections (owing_id, collecting_landlord_id);

CREATE INDEX IF NOT EXISTS idx_left_owing_collections_active
  ON public.left_owing_collections (tenant_id, status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_left_owing_collections_collecting
  ON public.left_owing_collections (collecting_landlord_id, status);

COMMENT ON TABLE public.left_owing_collections IS
  '10/27 (Nic): a landlord who takes on a resident with an unsettled GAM balance '
  'COLLECTS it for the landlord who is owed — never assumes it, and never opts '
  'out while still taking the resident. Installments ride the resident''s rent; '
  'what is collected is netted from the collecting landlord''s disbursements and '
  'paid over. Anything still owed when the resident leaves them is withdrawn '
  'from that landlord''s balance, the first landlord is made whole, and the '
  'remainder becomes a new debt a third landlord will see (carried_to_owing_id).';

COMMENT ON COLUMN public.left_owing_collections.acknowledged_words IS
  'The exact sentence the landlord was shown. Stored because what they were '
  'told is the whole of what they agreed to, and the wording will change.';

-- An arrangement may only ever be opened against a balance GAM itself watched
-- go unpaid. An imported balance is a watch-list note and nothing is collected
-- on it (Nic 10/27) — enforced here so no later code path can forget.
CREATE OR REPLACE FUNCTION public.left_owing_collection_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  SELECT source_kind INTO k FROM public.tenant_left_owing WHERE id = NEW.owing_id;
  IF k = 'import' THEN
    RAISE EXCEPTION 'left_owing_collections: an imported balance is a watch-list note, never collected (owing_id %)', NEW.owing_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS left_owing_collection_source_guard ON public.left_owing_collections;
CREATE TRIGGER left_owing_collection_source_guard
  BEFORE INSERT OR UPDATE OF owing_id ON public.left_owing_collections
  FOR EACH ROW EXECUTE FUNCTION public.left_owing_collection_source_guard();
