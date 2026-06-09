-- S233: platform_announcements table.
--
-- The table was referenced by routes/announcements.ts since its creation
-- but never had a matching migration. The S233 schema-diff harness SELECT
-- scanner caught it (the prior INSERT/UPDATE-only scan missed reads).
-- The route currently fails with `relation "platform_announcements" does
-- not exist`, which the landlord layout's <AnnouncementBar /> swallows
-- silently — the bar just falls back to the static "Gold Asset Management
-- / Property Management Platform" branding.
--
-- Schema mirrors the columns the SELECT already expects: id, title, body,
-- priority, created_at, plus the active + expires_at filter columns. No
-- backfill needed (admin will write rows via a future admin CRUD surface).

CREATE TABLE platform_announcements (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  title        text NOT NULL,
  body         text,
  priority     text NOT NULL DEFAULT 'info',
  active       boolean NOT NULL DEFAULT true,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_announcements_priority_check
    CHECK (priority IN ('info', 'warning', 'critical'))
);

CREATE INDEX idx_platform_announcements_active_priority
  ON platform_announcements (priority DESC, created_at DESC)
  WHERE active = true;
