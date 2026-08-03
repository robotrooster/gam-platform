-- Remove the Bulletin Board entirely (S567, Nic).
--
-- WHY: with the change in product direction the bulletin board is no longer a
-- feature for tenants, landlords, or super_admin. Ripped out of every portal +
-- the API; these tables have no remaining reader or writer.
--
-- DESTRUCTIVE: drops all bulletin data. Nic-authorized. CASCADE clears the
-- votes / reveal-log FKs onto bulletin_posts.

DROP TABLE IF EXISTS bulletin_votes CASCADE;
DROP TABLE IF EXISTS bulletin_reveal_log CASCADE;
DROP TABLE IF EXISTS bulletin_reveal_log_archive CASCADE;
DROP TABLE IF EXISTS bulletin_posts CASCADE;
