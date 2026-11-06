/**
 * 11/5 (Nic) — ONE WALK-AWAY DEBT PER PERSON, FED FROM EVERY SOURCE.
 *
 *   "I don't like recording it per lease because... people have short-term
 *    stays as well. Or people, 'hey, my card wasn't working when I went to buy
 *    some propane, and I'm going to come back with a new card,' and they never
 *    do. That wasn't a lease or a stay. ...we need a way for it to only record
 *    once, but it needs to be able to be infused from different sources."
 *
 * The defect these cover is the one that was live this morning: a tenancy
 * ending wrote a figure, a stay opened a SECOND record keyed on the booking,
 * and the move-out carry-forward set a third — so a resident who walked away
 * from a lease and also left a stay unpaid was two debts to the same landlord,
 * and where two writers met the last one to run overwrote the other's money.
 *
 * So the claims under test are about the BOOK and not about one function: how
 * many records a person has, what the figure comes to, and what happens to the
 * rest of it when one piece is paid.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'
import {
  recordWalkAwayPart, dropWalkAwayPart, walkAwayParts, walkAwayPersonKey,
  refreshWalkAwayTotal,
} from './leftOwingParts'

beforeEach(async () => { await cleanupAllSchema() })

const pool = { query: query as any }

interface Scene {
  landlordId: string; propertyId: string; unitId: string
  tenantId: string; userId: string
}

async function scene(): Promise<Scene> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const t = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    await c.query('COMMIT')
    return { landlordId, propertyId, unitId, tenantId, userId: t.rows[0].user_id }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
  finally { c.release() }
}

/** Every record this landlord holds, with its figure. */
async function records(s: Scene) {
  return (await db.query<any>(
    `SELECT id, amount::float8 AS amount, who, phone, person_key, source_kind,
            source_key, settled_at, settled_reason
       FROM tenant_left_owing WHERE landlord_id = $1 ORDER BY created_at`,
    [s.landlordId])).rows
}

/**
 * THE INVARIANT THE WHOLE SHAPE RESTS ON: a record's figure is its live parts
 * added up, and every live record can be matched to a person. Asserted after
 * each path runs rather than once at the end, so a failure names the writer
 * that broke it.
 */
async function assertBookAddsUp() {
  const bad = (await db.query<any>(
    `SELECT o.id, o.amount::float8 AS amount, o.person_key,
            COALESCE((SELECT SUM(p.amount) FROM tenant_left_owing_parts p
                       WHERE p.owing_id = o.id AND p.voided_at IS NULL), 0)::float8 AS parts
       FROM tenant_left_owing o
      WHERE o.settled_at IS NULL
        AND COALESCE(o.collected_amount, 0) = 0
        -- An imported balance is a figure another operator handed over; it has
        -- a part of its own from the 11/5 backfill, so it is included.
        AND (o.person_key IS NULL
             OR o.amount <> COALESCE((SELECT SUM(p.amount) FROM tenant_left_owing_parts p
                                       WHERE p.owing_id = o.id AND p.voided_at IS NULL), 0))`)).rows
  expect(bad).toEqual([])
}

const charge = async (s: Scene, amount: number) => (await db.query<{ id: string }>(
  `INSERT INTO payments
     (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
      entry_description, due_date, revenue_owner)
   VALUES ($1,NULL,$2,$3,'fee',$4,'pending','OTHERFEE',CURRENT_DATE - 10,'landlord')
   RETURNING id`, [s.unitId, s.tenantId, s.landlordId, amount])).rows[0].id

// ── THE HEADLINE: THREE SOURCES, ONE DEBT ───────────────────────────────────
describe('a person who walked away from more than one thing', () => {
  it('has ONE debt with that landlord, and it is the parts added up', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener', phone: '928-555-0144' }
    const leaseId = randomUUID()
    const bookingId = randomUUID()
    const ticketId = randomUUID()

    const a = await recordWalkAwayPart(pool, {
      landlordId: s.landlordId, propertyId: s.propertyId, person,
      kind: 'lease', sourceKey: leaseId, amount: 1252.80, leftOn: '2026-10-31' })
    const b = await recordWalkAwayPart(pool, {
      landlordId: s.landlordId, propertyId: s.propertyId, person,
      kind: 'stay', sourceKey: bookingId, amount: 700 })
    // His propane: a counter tab nobody came back for. Not a lease, not a stay.
    const c = await recordWalkAwayPart(pool, {
      landlordId: s.landlordId, propertyId: s.propertyId, person,
      kind: 'counter', sourceKey: ticketId, amount: 31.49 })

    expect(a!.joined).toBe(false)   // the first one opened the record
    expect(b!.joined).toBe(true)    // the rest joined it
    expect(c!.joined).toBe(true)
    expect(a!.owingId).toBe(b!.owingId)
    expect(b!.owingId).toBe(c!.owingId)

    const rows = await records(s)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(1984.29)        // 1252.80 + 700 + 31.49
    expect(rows[0].person_key).toBe(`user:${s.userId}`)
    // Provenance: the tenancy opened it, and that is all source_key says now.
    expect(rows[0].source_kind).toBe('lease')
    expect(rows[0].source_key).toBe(leaseId)

    const parts = await walkAwayParts(pool, rows[0].id)
    expect(parts.map(p => [p.kind, p.amount]).sort()).toEqual(
      [['counter', 31.49], ['lease', 1252.80], ['stay', 700]].sort())
    await assertBookAddsUp()
  })

  it('paying one of them off leaves the rest standing', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const leaseId = randomUUID()
    const ticketId = randomUUID()
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: leaseId, amount: 450 })
    const rec = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'counter', sourceKey: ticketId, amount: 31.49 })

    // THE BUG THIS CLOSES: before parts, paying off the tenancy settled the
    // whole record — so the propane they never came back for vanished with it.
    const left = await dropWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: leaseId, reason: 'Paid in full after they left' })
    expect(left).toBe(31.49)

    const [row] = await records(s)
    expect(row.settled_at).toBeNull()
    expect(row.amount).toBe(31.49)
    // The withdrawn part is kept, never deleted, so the figure's move is
    // explained ([[gam-data-retention-keep-everything]]).
    const parts = await walkAwayParts(pool, rec!.owingId)
    expect(parts.find(p => p.kind === 'lease')!.voidedAt).not.toBeNull()
    await assertBookAddsUp()
  })

  it('settles the record when the last part is withdrawn', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const leaseId = randomUUID()
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: leaseId, amount: 450 })
    expect(await dropWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: leaseId, reason: 'Paid in full after they left' })).toBe(0)

    const [row] = await records(s)
    expect(row.settled_at).not.toBeNull()
    expect(row.settled_reason).toContain('Paid in full')
    // Never set to zero and left flagging: a zero-dollar debt that still flags
    // somebody is the worst failure this book has.
    expect(row.amount).toBe(450)
    await assertBookAddsUp()
  })
})

// ── THE GUEST WITH NO ACCOUNT, WHO IS WHO THIS IS FOR ───────────────────────
describe('somebody with no account at all', () => {
  it('two unpaid stays are one debt, matched on the phone they gave', async () => {
    const s = await scene()
    const person = { who: 'Dale Wisener', phone: '(928) 555-0144' }
    const first = await recordWalkAwayPart(pool, { landlordId: s.landlordId,
      propertyId: s.propertyId, person, kind: 'stay', sourceKey: randomUUID(), amount: 700 })
    // Same phone, written differently — the matcher normalizes to the last ten
    // digits, so a second desk entry is the same person.
    const second = await recordWalkAwayPart(pool, { landlordId: s.landlordId,
      propertyId: s.propertyId, person: { who: 'Dale Wisener', phone: '9285550144' },
      kind: 'stay', sourceKey: randomUUID(), amount: 240 })

    expect(second!.owingId).toBe(first!.owingId)
    const rows = await records(s)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(940)
    expect(rows[0].person_key).toBe('phone:9285550144')
    await assertBookAddsUp()
  })

  it('writes nothing at all when there is nothing to key it on', async () => {
    const s = await scene()
    // A debt that can never be matched flags nobody and sits forever, which is
    // worse than no debt.
    expect(walkAwayPersonKey({ who: 'Walk-in' })).toBeNull()
    expect(await recordWalkAwayPart(pool, { landlordId: s.landlordId, person: { who: 'Walk-in' },
      kind: 'counter', sourceKey: randomUUID(), amount: 31.49 })).toBeNull()
    expect(await records(s)).toEqual([])
  })
})

// ── RUNNING IT AGAIN CANNOT INFLATE ANYBODY'S DEBT ──────────────────────────
describe('the same thing recorded twice', () => {
  it('restates the part instead of adding a second one', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const bookingId = randomUUID()
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'stay', sourceKey: bookingId, amount: 700 })
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'stay', sourceKey: bookingId, amount: 700 })
    const rec = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'stay', sourceKey: bookingId, amount: 820 })   // the figure moved

    expect((await records(s))[0].amount).toBe(820)
    expect((await walkAwayParts(pool, rec!.owingId)).filter(p => !p.voidedAt)).toHaveLength(1)
    await assertBookAddsUp()
  })

  it('brings a withdrawn part back rather than writing a second one', async () => {
    // A check-out undone, the balance settled, then undone again.
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const bookingId = randomUUID()
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'stay', sourceKey: bookingId, amount: 700 })
    await dropWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'stay', sourceKey: bookingId, reason: 'Paid after all' })
    const back = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'stay', sourceKey: bookingId, amount: 700 })

    // The record had settled only because it emptied out, which is bookkeeping
    // and not a decision — so it re-opens, with the stay's part back rather
    // than a second one beside it, and the person's history stays in one place.
    const rows = await records(s)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(back!.owingId)
    expect(rows[0].settled_at).toBeNull()
    expect(rows[0].amount).toBe(700)
    expect((await walkAwayParts(pool, back!.owingId)).filter(p => !p.voidedAt)).toHaveLength(1)
    await assertBookAddsUp()
  })
})

describe('a debt somebody closed on purpose', () => {
  it('is not re-opened by a writer', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const rec = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: randomUUID(), amount: 1000 })
    // A later landlord collected it out — a decision, with a figure behind it.
    await db.query(
      `UPDATE tenant_left_owing
          SET settled_at = NOW(), settled_amount = 800, collected_amount = 800,
              settled_reason = 'collected_by_later_landlord'
        WHERE id = $1`, [rec!.owingId])

    const after = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'counter', sourceKey: randomUUID(), amount: 31.49 })
    // A fresh record in its own right — the closed one is left exactly as it is.
    expect(after!.owingId).not.toBe(rec!.owingId)
    expect(after!.total).toBe(31.49)
    const closed = (await records(s)).find(r => r.id === rec!.owingId)
    expect(closed.settled_reason).toBe('collected_by_later_landlord')
    expect(closed.amount).toBe(1000)
    await assertBookAddsUp()
  })
})

// ── A LIVE ARRANGEMENT IS NOT RE-PRICED BEHIND SOMEBODY'S BACK ──────────────
describe('a debt somebody has begun collecting against', () => {
  it('does not move, and the new part is declined rather than half-written', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const rec = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: randomUUID(), amount: 1000 })
    // An arrangement has taken a dollar: the 80% settlement and the 50/15/15
    // split are computed from this figure, so it is frozen.
    await db.query(
      `UPDATE tenant_left_owing SET collected_amount = 100, settled_amount = 800 WHERE id = $1`,
      [rec!.owingId])

    expect(await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'counter', sourceKey: randomUUID(), amount: 31.49 })).toBeNull()
    expect((await records(s))[0].amount).toBe(1000)
    // And no orphan part was left behind on it.
    expect(await walkAwayParts(pool, rec!.owingId)).toHaveLength(1)
    expect(await refreshWalkAwayTotal(pool, rec!.owingId)).toBeNull()
  })
})

// ── THE LEASE AND THE CARRIED SHARE ARE DIFFERENT MONEY ─────────────────────
describe('a resident who leaves part-way through collecting for somebody else', () => {
  it('the carried share and their own unpaid rent are both counted', async () => {
    const s = await scene()
    const person = { userId: s.userId, who: 'Dale Wisener' }
    const leaseId = randomUUID()
    // What services/leftOwingFreeze books for the tenancy...
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: leaseId, amount: 250 })
    // ...and what the landlord paid out of an earlier landlord's debt. Before
    // parts these two overwrote each other and one of them was simply lost.
    const rec = await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'carried', sourceKey: randomUUID(), amount: 287.50 })
    expect((await records(s))[0].amount).toBe(537.50)

    // The deposit-return carry-forward re-states the LEASE's part under the
    // same key, so the same unpaid rent is never counted a second time.
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, person,
      kind: 'lease', sourceKey: leaseId, amount: 250 })
    expect((await records(s))[0].amount).toBe(537.50)
    expect((await walkAwayParts(pool, rec!.owingId)).filter(p => !p.voidedAt)).toHaveLength(2)
    await assertBookAddsUp()
  })
})

// ── TWO LANDLORDS, TWO BOOKS ────────────────────────────────────────────────
describe('the same person at two landlords', () => {
  it('is one debt each, never one shared', async () => {
    const a = await scene()
    const b = await scene()
    const person = { userId: a.userId, who: 'Dale Wisener' }
    const one = await recordWalkAwayPart(pool, { landlordId: a.landlordId, person,
      kind: 'lease', sourceKey: randomUUID(), amount: 450 })
    const two = await recordWalkAwayPart(pool, { landlordId: b.landlordId, person,
      kind: 'stay', sourceKey: randomUUID(), amount: 700 })
    expect(one!.owingId).not.toBe(two!.owingId)
    expect((await records(a))[0].amount).toBe(450)
    expect((await records(b))[0].amount).toBe(700)
    await assertBookAddsUp()
    // A charge of theirs exists but is nobody's business here — this book is
    // written from what a caller hands it, never swept off the payments table.
    await charge(a, 99)
    expect((await records(a))[0].amount).toBe(450)
  })
})

// ── THE RULE STAYS TRUE ONLY IF THERE IS ONE WRITER ─────────────────────────
//
// "It needs to only record once" holds because every source goes through
// recordWalkAwayPart — which finds the person and keys the record on them. A
// writer added beside it would key nothing, land outside the one-per-person
// index (which is partial on person_key being present), and split somebody into
// two debts again. That is exactly how the stay path broke it, so it is checked
// here rather than remembered.
describe('who is allowed to write this book', () => {
  it('is services/leftOwingParts and nothing else', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..')

    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
        const rel = full.slice(root.length + 1)
        // Dated one-off scripts are run once by hand against a known state and
        // are kept as the record of what was done; migrations are SQL.
        if (rel.startsWith('scripts/') || rel.startsWith('db/')) continue
        if (rel === 'services/leftOwingParts.ts') continue
        const src = readFileSync(full, 'utf8')
        if (/INSERT\s+INTO\s+tenant_left_owing\s*\(/i.test(src)) offenders.push(rel)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it('and every live debt it writes can be matched to a person', async () => {
    // The one-per-person index is partial on person_key, so a record without
    // one escapes the rule silently. None may exist.
    const s = await scene()
    await recordWalkAwayPart(pool, { landlordId: s.landlordId, propertyId: s.propertyId,
      person: { userId: s.userId, who: 'Dale Wisener' },
      kind: 'lease', sourceKey: randomUUID(), amount: 450 })
    expect((await db.query<any>(
      `SELECT count(*)::int AS n FROM tenant_left_owing
        WHERE settled_at IS NULL AND person_key IS NULL`)).rows[0].n).toBe(0)
  })
})
