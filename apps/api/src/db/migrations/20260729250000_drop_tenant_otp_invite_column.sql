-- Remove the tenant-facing On-Time Pay invite artifact (S567, Nic).
--
-- WHY: On-Time Pay is a LANDLORD-facing product (landlord-paid rent advance) —
-- it was never meant to touch tenants. The late-payment "invite the tenant to
-- On-Time Pay" flow that wrote this column was a mistake and has been ripped
-- out (the invite email, the scheduler trigger, and the tenant enroll endpoint
-- are all gone). This per-tenant invite sentinel now has no reader or writer.
--
-- The LANDLORD-facing OTP product (services/otp.ts, landlord endpoints, the
-- otp_advances table, on_time_pay_enrolled, otp_rollout_enabled) is untouched.
--
-- DESTRUCTIVE: drops a tenant column. Nic-authorized. No backfill.

ALTER TABLE tenants DROP COLUMN IF EXISTS on_time_pay_invite_sent_at;
