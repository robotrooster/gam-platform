-- 10/12 (Nic) — BOOKKEEPERS DO FULL BOOKKEEPING, AT ONE LEVEL
--
-- Nic's decision 2 on the GAM Books ledger (gam-ledger-design-2026-10-12 §1,
-- §11): "Full bookkeeping (bank lines, reconciling, journal entries, bills,
-- payroll, vendors) … never tenant-account actions … One level, no
-- per-bookkeeper switch."
--
-- bookkeeper_scopes.access_level ('read_only' | 'read_write', default
-- 'read_only') was a per-bookkeeper switch that no screen offers any more: the
-- Team page has invited every bookkeeper without one since 10/11, so each one
-- landed read-only and could not file a bank line, pay a bill, post a journal
-- entry, run payroll or keep vendors. From this release nothing decides by it
-- (lib/bookkeeperScope bookkeeperMayWrite: every bookkeeper the company keeps
-- writes; the owner's boxes still decide WHAT they keep — properties,
-- company-wide, the ledger, money coming in — and no bookkeeper ever works a
-- tenant's account: lib/bookkeeperAccess refuses those routes outright).
--
-- So the column says the one level too, wherever it is still read (an older
-- API until this release is live, a report, the audit journal):
--   - its default becomes 'read_write' (BOOKKEEPER_ONE_LEVEL);
--   - every bookkeeper row that says 'read_only' is written 'read_write'
--     (the audit trigger audit_bookkeeper_scopes journals each change);
--   - a pending bookkeeper invitation that names 'read_only' says
--     'read_write' (accepting it writes what its payload says on an older API).
-- The column, its CHECK and both values stay (keep-everything); the shared
-- list BOOKKEEPER_ACCESS_LEVELS is unchanged.
--
-- Safe before the code ships: an older API reads 'read_write' as "may do the
-- bookkeeping", which is the decision; it never reached a tenant's account
-- either way (the bookkeeper allowlist).
-- Backfill: this file is the backfill, idempotent. Production on 10/12: 0
-- bookkeeper rows and 0 pending bookkeeper invitations, so it moves nothing
-- there.
-- Safe drop: not applicable (a default and data); re-running is a no-op.

SET LOCAL lock_timeout = '10s';

ALTER TABLE bookkeeper_scopes ALTER COLUMN access_level SET DEFAULT 'read_write';

UPDATE bookkeeper_scopes
   SET access_level = 'read_write', updated_at = NOW()
 WHERE access_level IS DISTINCT FROM 'read_write';

UPDATE invitations
   SET scope_payload = jsonb_set(scope_payload, '{accessLevel}', '"read_write"'::jsonb)
 WHERE role = 'bookkeeper'
   AND status = 'pending'
   AND jsonb_typeof(scope_payload) = 'object'
   AND scope_payload ? 'accessLevel'
   AND scope_payload->>'accessLevel' IS DISTINCT FROM 'read_write';

COMMENT ON COLUMN bookkeeper_scopes.access_level IS
  '10/12 (Nic, ledger decision 2): one level — every bookkeeper does full bookkeeping on what the owner''s boxes give them, never a tenant''s account. Kept (keep-everything) and written ''read_write''; nothing decides by it.';
