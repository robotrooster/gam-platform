-- Add the 'contact' user role — the e-sign customer/contact pool (S568, Nic).
--
-- WHY: a landlord can only send an e-sign document to someone with a GAM account
-- (no mailing contracts to raw emails). When the recipient isn't already a GAM
-- user, we create them a free lightweight 'contact' account and invite them to
-- activate it — the anti-spam / consent gate (they opt in before they can view
-- or sign). A 'contact' has no landlord/tenant profile row; same shape as
-- fitness_user. Single source of truth: shared USER_ROLES (now includes it).
--
-- Safe: widening the role CHECK. No backfill.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','super_admin','landlord','tenant','bookkeeper',
                  'property_manager','onsite_manager','maintenance',
                  'business_owner','business_staff','fitness_user','contact'));
