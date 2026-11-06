/**
 * Moved to @gam/shared on 10/30 — see packages/shared/src/stackTables.ts for
 * why, and for how a portal wires it up.
 *
 * This file stays as the re-export so the shell's existing import keeps
 * working and there is exactly ONE implementation to fix. A portal being
 * ported now should import from '@gam/shared' directly rather than adding
 * another one of these.
 */
export { installTableStacking } from '@gam/shared'
