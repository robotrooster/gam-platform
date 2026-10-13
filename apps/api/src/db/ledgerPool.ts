/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE BOOKS' OWN CONNECTIONS
 *
 * Posting to the books never takes a connection a money request needs
 * (gam-ledger-design-2026-10-12 §3: "books work never slows or blocks a money
 * write"). The API's pool (db/index.ts) has 20 connections and gives up on a
 * wait after 2 s; if every settle's after-commit kick, the minute drain and a
 * month close all drew from it, a burst of posting for one landlord could hold
 * enough of them to make payment routes, Stripe webhooks and payout jobs fail
 * for every landlord. So the ledger engine (posting, the drain and its runner
 * lock, the kick, the close, the nightly check, the rebuild) runs on this
 * small pool of its own.
 *
 *   - Same database, user and session settings as the API's pool (it copies
 *     that pool's options), so dates read the same everywhere.
 *   - LEDGER_DB_POOL_MAX connections (default 4): the minute drain's runner
 *     lock and its poster, the kick's poster, and one for a close, a check or
 *     a rebuild. Only the minute drain ever holds one connection while asking
 *     for another, and only one minute drain runs at a time, so the pool can
 *     never wait on itself.
 *   - A wait for a free connection is long (books work is never in a hurry);
 *     when it still runs out, the poster says "busy" and the next minute's
 *     drain posts the source (ledgerEngine.postSource).
 *   - Idle connections never keep a script or a test process alive.
 */
import { Pool, type PoolClient } from 'pg'
import { db } from './index'

export const ledgerDb = new Pool({
  ...db.options,
  max: Number(process.env.LEDGER_DB_POOL_MAX) || 4,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  allowExitOnIdle: true,
})

ledgerDb.on('error', () => {
  // An idle books connection that dropped is replaced on the next checkout;
  // the books never crash the API.
})

/** One query on the books' pool. */
export async function ledgerQuery<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
  const { rows } = await ledgerDb.query(sql, params as any[])
  return rows
}

/** A dedicated books connection. CALLER MUST release() it. */
export function ledgerConnect(): Promise<PoolClient> {
  return ledgerDb.connect()
}
