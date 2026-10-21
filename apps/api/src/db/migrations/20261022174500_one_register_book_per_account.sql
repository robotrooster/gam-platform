-- 10/20 (Nic), on the register's customer list: "that could be people from my
-- other property could be customers at this property for propane. I shouldn't
-- have to toggle."
--
-- WHY THIS FUNCTION EXISTS. His two parks are not two properties of one
-- company — Mountain View RV Ranch sits under Mountain View RV Park Ranch LLC
-- and Oak Park Motel and RV sits under Oak Park Motel and RV LLC. Two
-- `landlords` rows, one account. Every register record hangs off a `landlords`
-- row, so "combined as all properties" still could not show his other park's
-- people, and picking one of them at the far counter minted a SECOND record for
-- the same man — his own second charge account, his own saved cards, his own
-- running total. The thing that splits a person is the ENTITY boundary, not the
-- property boundary.
--
-- WHY NOT account_companies(). That one walks every MEMBER of a company and
-- then every company those people touch, which is right for a lease template
-- (the toolkit of whoever can open it) and badly wrong for a customer book:
-- Oak Park has a co-owner who also owns TruBlu Management LLC in Illinois, so
-- account_companies(Oak Park) reaches Country Acres - Mattoon. One landlord
-- would be reading another landlord's customers.
--
-- WHY IT TAKES THE CALLER, AND WHY THAT IS NOT OPTIONAL.
--
-- The first cut of this function keyed on ownership ALONE: the companies
-- registered to whoever owns the company passed in, on the reasoning that "the
-- set is the same whoever is signed in". That is the identical mistake as
-- account_companies(), only pointed the other way, and it opened on the very
-- person the paragraph above names.
--
-- Oak Park's registered owner is Nic, so the ownership-only set behind Oak Park
-- is {Oak Park, Mountain View}. Blu is an owner-MEMBER of Oak Park and the
-- registered owner of TruBlu Management LLC — his own company, his own
-- landlord. Standing at Oak Park's register, which he is entitled to stand at,
-- he was handed Mountain View: 65 of Nic's residents by name, park and site,
-- every one of them carrying the live email on their own GAM account, 42 of
-- them the live phone, and a saved card on each one chargeable at his counter.
-- Measured read-only against production before the fix. Before 10/20 every one
-- of those reads was refused, and "the landlord at each property can't see what
-- the other one does" is exactly about him.
--
-- So the book is the account's companies INTERSECTED with the caller's own, and
-- the two branches below are the whole of it:
--
--   1. the caller is the registered owner of the account behind this company —
--      every company registered to them is theirs. This is Nic's propane case
--      and the reason the function exists. It is also how the DESK gets the
--      whole account: a cashier or an on-site manager holds no company of her
--      own, so services/registerBook hands in the owner of the company she
--      works for, and she reads what he reads. 10/20 (Nic, decisions #11): a
--      customer anywhere on the account is named, with their site, "to anyone
--      with register access on that account, cashier included — they are his
--      customers and the desk has to find them."
--   2. otherwise the caller is a principal of their own, and reaches only the
--      companies they actually co-own. Blu gets Oak Park and nothing else,
--      which is what he got before any of this and what he should have kept.
--
-- A NULL caller is the one company passed in and nothing more. Fail closed, on
-- purpose and in this direction: a call site that cannot say who is asking
-- narrows the book back to where it was in September. It can never widen it.
--
-- NOTE the division of labour, because it is what keeps this honest. The DATA
-- answers "whose account is this, and who co-owns what" — facts, the same for
-- everybody. The SESSION answers "who is asking" — authorization, which is
-- never a property of the data. Neither one can decide the book alone, and
-- every earlier cut of this failed by trying.
--
-- No backfill needed: this adds a function and reads only existing columns.
-- `landlords.user_id` is NOT NULL, so the inner lookup always answers, and
-- landlord_members.role is CHECKed to 'owner', so a row there means a principal
-- and never an employee — which is what makes branch 2 a fact and not a guess.
CREATE OR REPLACE FUNCTION register_book_companies(company uuid, caller_user uuid)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT l.id FROM landlords l
   WHERE caller_user IS NOT NULL
     AND l.user_id = (SELECT o.user_id FROM landlords o WHERE o.id = company)
     AND (
          -- 1. the account behind this company is the caller's own
          l.user_id = caller_user
          -- 2. a co-owner reaches the companies they co-own, and no siblings
       OR EXISTS (SELECT 1 FROM landlord_members cm
                   WHERE cm.landlord_id = l.id AND cm.user_id = caller_user)
     )
  UNION
  SELECT company
$$;
