-- S592 (Nic): person-level referral upline.
--
-- WHY: the "who referred me" link previously lived ONLY on the landlord ENTITY
-- (landlords.referred_by_user_id / portfolio_manager_id). That drops on a 1031
-- exchange into a new LLC (a new entity with no attribution), silently breaking
-- the referral chain. We anchor the upline to the PERSON so it survives entity
-- changes and auto-applies to any account they open. Single-tier: one upline
-- per person; the accrual job earns only on that person's OWN units and never
-- stacks. See PORTFOLIO_MANAGER_SPEC.md § 4.
--
-- The entity columns remain the value the accrual job reads FIRST; this person
-- link is the fallback (populated at signup / first-touch / co-owner add), so
-- existing explicitly-attributed accounts are unchanged.
--
-- Safe change: additive nullable column + self-FK + index. Backfill seeds the
-- person link from each founding owner's existing entity attribution
-- (best-effort; multi-entity founders resolve to one of their entities — rare,
-- fixable via the manual re-attach in P3+).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS referred_by_user_id uuid REFERENCES public.users(id);

COMMENT ON COLUMN public.users.referred_by_user_id IS
  'S592: this person''s single referral upline (who brought them onto GAM). Anchored to the person so it survives 1031s / new entities. The accrual job (commissionAccrual.ts) reads the landlord ENTITY attribution first and falls back to this. Single-tier — never stacked.';

CREATE INDEX IF NOT EXISTS users_referred_by_user_id_idx
  ON public.users (referred_by_user_id);

UPDATE public.users u
   SET referred_by_user_id = COALESCE(l.referred_by_user_id, l.portfolio_manager_id)
  FROM public.landlords l
 WHERE l.user_id = u.id
   AND u.referred_by_user_id IS NULL
   AND COALESCE(l.referred_by_user_id, l.portfolio_manager_id) IS NOT NULL;
