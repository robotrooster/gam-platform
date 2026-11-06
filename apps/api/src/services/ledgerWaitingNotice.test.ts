/**
 * 11/1 — SOMEBODY HEARS ABOUT A POSTING THAT IS WAITING ON AN ANSWER.
 *
 * Country Acres had money from September and no books start date, and 67
 * postings parked behind it for two months through ~1,795 retries each while
 * three separate silences held: the waiting-on-owner reasons raise no notice by
 * design, the stale-outbox notice excludes a company with no books start, and
 * the nightly parity check does not even SELECT such a company.
 *
 * What these pin is the shape of the fix, because the shape is the whole risk:
 * one notice per company per question (67 would have been useless), named by
 * the question rather than by a dollar amount, and not again tomorrow night.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { noticeWaitingOnOwner, RENOTICE_DAYS } from './ledgerWaitingNotice'

beforeEach(async () => { await cleanupAllSchema() })

async function aCompany(name: string): Promise<string> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { landlordId } = await seedLandlord(client)
    await client.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`, [landlordId, name])
    await client.query('COMMIT')
    return landlordId
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** A posting parked on a question, as the engine records it. */
async function parked(ownerId: string, waitingOn: string, opts: { firstFailed?: string; noticed?: string | null } = {}) {
  await db.query(
    `INSERT INTO ledger_source_errors
       (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at,
        waiting_on, first_failed_at, noticed_at)
     VALUES ('payment', $1, $2, $3, 40, 'Waiting on the owner: …', now() + interval '15 min',
             $4, COALESCE($5::timestamptz, now()), $6::timestamptz)`,
    [randomUUID(), ownerId,
     waitingOn === 'books_start' ? 'no_books_start' : 'owner_not_ready',
     waitingOn, opts.firstFailed ?? null, opts.noticed ?? null])
}

const notices = async () => (await db.query<any>(
  `SELECT severity, category, title, body, context FROM admin_notifications
    WHERE category = 'books_waiting_on_owner' ORDER BY created_at, title`)).rows

describe('one notice per company per question', () => {
  it('names the question, not a dollar amount', async () => {
    const id = await aCompany('Country Acres Holdings LLC')
    await parked(id, 'books_start', { firstFailed: '2026-09-02' })
    const r = await noticeWaitingOnOwner()
    expect(r.raised).toBe(1)
    const [n] = await notices()
    expect(n.title).toBe('Country Acres Holdings LLC: the books are waiting on the date their books start')
    expect(n.severity).toBe('warn')
    expect(n.body).toContain('2026-09-02')
    expect(n.context.waitingOn).toBe('books_start')
  })

  it('collapses 67 parked postings into ONE notice that counts them', async () => {
    const id = await aCompany('Country Acres Holdings LLC')
    for (let i = 0; i < 67; i++) await parked(id, 'books_start')
    const r = await noticeWaitingOnOwner()
    expect(r.raised).toBe(1)
    const all = await notices()
    expect(all).toHaveLength(1)
    expect(all[0].context.blocked).toBe(67)
    expect(all[0].body).toContain('67 money records')
  })

  it('raises one per question when a company is waiting on two', async () => {
    const id = await aCompany('Two Questions LLC')
    await parked(id, 'books_start')
    await parked(id, 'home_sale_method')
    const r = await noticeWaitingOnOwner()
    expect(r.raised).toBe(2)
    const titles = (await notices()).map((n: any) => n.title as string)
    expect(titles.some((t: string) => t.includes('the date their books start'))).toBe(true)
    expect(titles.some((t: string) => t.includes('how home sales count'))).toBe(true)
  })

  it('keeps companies apart', async () => {
    const a = await aCompany('Company A LLC')
    const b = await aCompany('Company B LLC')
    await parked(a, 'work_trade_method')
    await parked(b, 'work_trade_method')
    expect((await noticeWaitingOnOwner()).raised).toBe(2)
  })

  it('points at the page the answer lives on', async () => {
    const id = await aCompany('Loans LLC')
    await parked(id, 'loan_opening_balance')
    await noticeWaitingOnOwner()
    expect((await notices())[0].body).toContain('Loans page')
  })
})

describe('not every night forever', () => {
  it('says nothing on the next run', async () => {
    const id = await aCompany('Quiet LLC')
    await parked(id, 'books_start')
    expect((await noticeWaitingOnOwner()).raised).toBe(1)
    expect((await noticeWaitingOnOwner()).raised).toBe(0)
    expect(await notices()).toHaveLength(1)
  })

  it('says it again once the notice has gone stale', async () => {
    const id = await aCompany('Still Waiting LLC')
    await parked(id, 'books_start')
    // Stamped directly: the helper takes values, not SQL.
    await db.query(
      `UPDATE ledger_source_errors SET noticed_at = now() - make_interval(days => $1)`,
      [RENOTICE_DAYS + 1])
    const r = await noticeWaitingOnOwner()
    expect(r.raised).toBe(1)
    expect((await notices())[0].body).toContain('Still unanswered')
  })

  it('a question answered and replaced by the NEXT one is raised again', async () => {
    // Country Acres exactly: no books start date, answered, then the home-sale
    // method underneath it. The engine re-points waiting_on and clears
    // noticed_at when the cause changes.
    const id = await aCompany('Next Question LLC')
    await parked(id, 'books_start')
    expect((await noticeWaitingOnOwner()).raised).toBe(1)
    await db.query(
      `UPDATE ledger_source_errors
          SET waiting_on = 'home_sale_method', reason_code = 'owner_not_ready', noticed_at = NULL`)
    expect((await noticeWaitingOnOwner()).raised).toBe(1)
    expect(await notices()).toHaveLength(2)
  })
})

describe('what it stays quiet about', () => {
  it('says nothing when nothing is parked', async () => {
    await aCompany('All Good LLC')
    expect(await noticeWaitingOnOwner()).toEqual({ groups: 0, raised: 0 })
    expect(await notices()).toHaveLength(0)
  })

  it('leaves out a wait nobody can answer', async () => {
    const id = await aCompany('Business Phase LLC')
    await parked(id, 'business_phase')
    expect((await noticeWaitingOnOwner()).raised).toBe(0)
    expect(await notices()).toHaveLength(0)
  })

  it('ignores a failure that is not waiting on anyone', async () => {
    const id = await aCompany('Broken LLC')
    await db.query(
      `INSERT INTO ledger_source_errors
         (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at)
       VALUES ('payment', $1, $2, 'projector_error', 9, 'the projector threw', now())`,
      [randomUUID(), id])
    expect((await noticeWaitingOnOwner()).raised).toBe(0)
  })
})
