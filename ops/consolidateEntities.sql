-- S630 (Nic): put the whole portfolio under ONE login that stays with him.
--
-- Oak Park and Mountain View were built under a SECOND landlord account created
-- Aug 14 (oakparkaz@gmail.com). That mailbox goes to the buyer with the park, and
-- it is the address that can reset the password on everything attached to it.
-- The entities move to the personal login (realestaterhoades@gmail.com, created
-- June); the Oak Park PROPERTY goes to the buyer later through the existing
-- property_transfers path, which moves a property between ENTITIES and is
-- untouched by this.
--
-- Membership is a fact in the database (landlord_members), so that is what has
-- to move for scope to follow. landlords.user_id moves too: it is what resolves
-- the landlord signer's identity and email.
BEGIN;

\set old_user  '03b83406-79f8-4a10-9c4c-a4d0a57ecc67'
\set new_user  '8b2f26ad-173a-45cb-9c59-f7a27bfa81e3'
\set oak       '8d59242e-c1e5-48a7-b768-420c57fb5fca'
\set mtn       '96ec7df3-362d-4777-b54c-e9604313820f'
\set afp_prop_name 'AFP Verify Property'

-- 1. The entities themselves.
UPDATE landlords SET user_id = :'new_user', updated_at = now()
 WHERE id IN (:'oak', :'mtn') AND user_id = :'old_user';

-- 2. Scope. The unique constraint is (landlord_id, user_id), and the new user
--    has no row for these entities, so a repoint is safe.
UPDATE landlord_members SET user_id = :'new_user', updated_at = now()
 WHERE landlord_id IN (:'oak', :'mtn') AND user_id = :'old_user';

-- 3. Per-property ownership/management links, which drive the ownership tab and
--    the sale consent gate.
UPDATE properties SET owner_user_id = :'new_user'
 WHERE landlord_id IN (:'oak', :'mtn') AND owner_user_id = :'old_user';
UPDATE properties SET managed_by_user_id = :'new_user'
 WHERE landlord_id IN (:'oak', :'mtn') AND managed_by_user_id = :'old_user';

-- 4. The AFP throwaway is NOT deleted here. It carries a $10.00 platform-fee
--    accrual for 2026-08 tied to platform_revenue_ledger, and GAM does not erase
--    billing history. Handled separately.

COMMIT;
