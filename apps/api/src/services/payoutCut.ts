/**
 * S655 review — THE CUT BETWEEN ONE GAM PAYOUT AND THE NEXT.
 *
 * GAM's own sweeps (jobs/autoPayouts.ts) pay out a Connect account's whole
 * balance, so each one carries every transfer that landed before it, and the
 * next sweep starts where it ended (payoutComposition.stampPayoutTransfers reads
 * the previous sweep's initiated_at as its lower bound). That only holds if no
 * transfer can be dated before the cut and still be invisible when the sweep
 * looks for its transfers. Two things made that possible:
 *
 *  • A transfer was dated NOW() — the moment its confirming transaction BEGAN —
 *    and only became visible when that transaction committed. Begun before the
 *    cut, committed after the sweep looked: in neither sweep, for good.
 *  • The cut was the moment Stripe answered the payout, after the balance had
 *    been read. A transfer confirmed in between was linked to a payout whose
 *    amount did not include it.
 *
 * So the two sides take one lock per Connect account:
 *
 *  • landlordPassthrough.confirmIntent takes it, then dates the transfer with
 *    clock_timestamp() — the moment it is written, not the moment it began.
 *    So does landlordPassthrough's reserve for a batch netted down to $0,
 *    which is born 'transferred' with no Stripe call and no confirm;
 *  • the payout run takes the cut under the same lock, just before it reads the
 *    balance (takePayoutCut).
 *
 * A transfer being confirmed when the cut is taken is waited for: it commits,
 * dated before the cut, and the sweep sees it. One confirmed after the cut is
 * dated after it and belongs to the next sweep. Nothing lands in neither.
 *
 * What the cut cannot see: a payout is for the balance Stripe reports, and a
 * transfer's money is on that balance from the moment Stripe makes it, before
 * GAM records it as confirmed. A transfer whose money was on the balance when
 * it was read, but which GAM confirmed only after the cut, is listed on the
 * next payout instead of this one. That happens when Stripe makes it while the
 * balance is being read, or when GAM's confirm failed and the recovery job
 * confirmed it later. Each payout then shows a gap line. Display only: no
 * money moves differently.
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'

type Queryable = Pick<PoolClient, 'query'>

/** The advisory-lock key both sides take for one Connect account. */
export const payoutCutLockKey = (connectAccountId: string) => `connect_payout_cut:${connectAccountId}`

/**
 * Inside the caller's transaction: wait until nobody is confirming a transfer
 * to this account or taking its cut. Released when the transaction ends.
 */
export async function lockPayoutCut(c: Queryable, connectAccountId: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutCutLockKey(connectAccountId)])
}

/**
 * Inside a transaction holding the account's cut lock (lockPayoutCut): the
 * cut, read from the database's clock (the one transfers are dated by), in
 * whole milliseconds, so the value a row stores and the value a sweep is
 * stamped with are the same instant.
 *
 * The next millisecond up, and the lock held until the clock is past it.
 * Rounded down, a transfer confirmed just before the cut in the same
 * millisecond was dated after it: its money was in this payout and it was
 * listed on the next. Rounded up without the wait, a transfer confirmed just
 * after, in that millisecond, would be dated at or before the cut, and if it
 * committed after this sweep looked, no payout would ever list it. Holding the
 * lock 2ms longer closes both.
 */
export async function cutUnderLock(c: Queryable): Promise<Date> {
  const r = await c.query<{ cut: Date }>(
    `SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS cut`)
  // pg_sleep returns only once the clock has reached its end, so whoever
  // takes the lock next is dated after the cut.
  await c.query(`SELECT pg_sleep(0.002)`)
  return r.rows[0].cut
}

/**
 * The cut for a payout about to be made from this account: every transfer
 * dated at or before it is committed by the time this returns, and every
 * transfer confirmed afterwards is dated after it.
 */
export async function takePayoutCut(connectAccountId: string): Promise<Date> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    await lockPayoutCut(c, connectAccountId)
    const cut = await cutUnderLock(c)
    await c.query('COMMIT')
    return cut
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}
