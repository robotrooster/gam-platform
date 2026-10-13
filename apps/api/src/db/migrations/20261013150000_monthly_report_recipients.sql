-- 10/12 (Nic) — WHO GETS THE MONTHLY PROPERTY REPORT
--
--   The monthly property report is emailed at month close with the PDF
--   attached "so they can put it to their books", to the people the OWNER
--   picks: themselves, property managers, bookkeepers, anyone else on the
--   team, plus other email addresses (a CPA, a partner). Default: the owner
--   only. Only the owner (or GAM admin) edits the list.
--
-- One row per recipient per company (landlords.id: the company owns the
-- properties, so the list is the company's):
--   kind 'team_member'  user_id   someone on this company's team (an owner,
--                                 a property manager, an on-site manager,
--                                 maintenance, a bookkeeper). Their own
--                                 property scope decides which properties'
--                                 reports they receive (services/
--                                 monthlyPropertyReport) — a manager of one
--                                 park never receives the other park's money.
--   kind 'email'        email     another address the owner typed. It gets
--                                 every property's report: the owner chose to
--                                 share the company's books with it.
--
-- KEEP EVERYTHING: removing a recipient stamps removed_at / removed_by; the
-- row stays. "Default = the owner only" is a company that has never saved a
-- list (no row at all, removed or not); once the owner saves one, the live
-- rows are the list — an empty list sends to nobody, by the owner's choice.
--
-- Safe to apply before the code ships: a new table nothing reads yet. No
-- backfill needed (no row = the owner only, the default).

CREATE TABLE IF NOT EXISTS monthly_report_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  kind                text NOT NULL,
  user_id             uuid REFERENCES users(id),
  email               text,
  added_by_user_id    uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz,
  removed_by_user_id  uuid REFERENCES users(id),
  CONSTRAINT monthly_report_recipients_kind_check CHECK (kind IN ('team_member', 'email')),
  CONSTRAINT monthly_report_recipients_shape_check CHECK (
    (kind = 'team_member' AND user_id IS NOT NULL AND email IS NULL)
    OR (kind = 'email' AND user_id IS NULL AND email IS NOT NULL AND email = lower(btrim(email)) AND email <> '')),
  CONSTRAINT monthly_report_recipients_removed_shape CHECK ((removed_at IS NULL) = (removed_by_user_id IS NULL))
);

-- One live row per person and per address in a company.
CREATE UNIQUE INDEX IF NOT EXISTS monthly_report_recipients_live_user_uidx
  ON monthly_report_recipients (landlord_id, user_id) WHERE removed_at IS NULL AND kind = 'team_member';
CREATE UNIQUE INDEX IF NOT EXISTS monthly_report_recipients_live_email_uidx
  ON monthly_report_recipients (landlord_id, email) WHERE removed_at IS NULL AND kind = 'email';
CREATE INDEX IF NOT EXISTS monthly_report_recipients_landlord_idx
  ON monthly_report_recipients (landlord_id);
