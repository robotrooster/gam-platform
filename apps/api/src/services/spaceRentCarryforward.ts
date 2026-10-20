/**
 * UNPAID SPACE RENT FOLLOWS THE SPACE ON A TENANT-OWNED HOME (10/19, Nic).
 *
 *   "because mobile homes already rent the space for the ground that they're
 *    parked on, Rashawn from Oak Park has left the park. The trailer has been
 *    sold to somebody else, and it was not facilitated through the park. So the
 *    new owner of the trailer is going to be this tenant ... He is going to be
 *    responsible for paying the bill that Rashawn left behind ... The rent is
 *    owed by the trailer because it was the same trailer there. It doesn't
 *    matter how many people cycle in and out. The lien attaches to the trailer."
 *
 * WHAT MOVES, AND WHAT DOES NOT. Only SPACE RENT. Nic, asked whether utilities
 * ride along: "in terms of being real and equitable, it should be the space
 * rent is the only thing tied to the trailer, right?" A utility, a fee, a
 * deposit and a home payment are the departing resident's own debt and stay
 * with him. Late fees are dropped outright: "Jacob, it was not possible for him
 * to be late. So I would say on a carry forward balance like that, just in the
 * nature of being reasonable, we drop the late fees." Then: "close out late
 * fees entirely."
 *
 * ONE SETTLEMENT, NOT TWO BALANCES. Nic: "Yes, Rashan is still responsible for
 * the money until it is paid. Even though it's acting as the lien, you got the
 * right method there." Both are on the hook, so the money is ONE charge row.
 * One row can only be ASKED of one household at a time, and its two columns say
 * which:
 *
 *   tenant_id  WHO IS ASKED FOR IT NOW — the departing resident while the space
 *              sits empty, and the resident who takes the space on from the
 *              moment their lease is drafted (the trigger in migration
 *              20261021100000 moves it). Every payment path reads a household
 *              off this column: the desk, the portal, autopay, a bank deposit.
 *   lease_id   WHICH LEASE CARRIES IT — the space's current lease, so it lands
 *              on the new resident's bill as its own line.
 *
 * WHOSE DEBT IT IS does not move, and the CLAIM is the record of it:
 * origin_tenant_id with amount, settled_amount and settled_on (carryforwardView
 * / carryforwardsOwedBy). Nic: "it's going to just record under his name only
 * when the payment happens ... we're not recording a payment like that until
 * it's fully settled." Because there is one row, collecting it twice is not
 * something a human has to avoid — either side paying it is the same row
 * settling, and the database refuses a second live charge per claim.
 *
 * And NOT both quotes at once, which an earlier draft of this file promised: a
 * quote reaches a lease the person is not on only for the rows billed to THEM
 * (creditUse.householdLeases), and a desk payment is spread across the ROW's
 * household oldest-first (manualPaymentSettle settleHousehold). Left on the
 * departing resident, the new resident's $100 at the counter would have paid
 * the departing resident's $997 water bill.
 *
 * WHY IT NEVER GOES NEAR AN INVOICE. jobs/lateFees walks INVOICES. A charge
 * that is not a line on one is out of the engine's reach by construction, so
 * `invoice_id` is NULL on the carried charge for life and no filter has to keep
 * being right. It is also why the carried balance can be paid in part while an
 * invoiced bill cannot (S622) — the part-payment split in
 * services/manualPaymentSettle copies the row, invoice and all.
 *
 * TENANT-OWNED HOMES ONLY. A landlord-owned rental going vacant carries nothing
 * forward; there is no third party who inherits it. The gate is
 * a mobile_home space whose dwelling_ownership = 'tenant'. home_ownerships names the owner where
 * the landlord recorded one, and nothing here requires trailer identity: Nic,
 * on why the debt is tied to the spot, "manufactured home, they're set up.
 * They're not moving. ... There's no VIN numbers that the landlord is going to
 * have access to ... So for simplicity, we just want to attach the debt to the
 * spot."
 */
import type { PoolClient } from 'pg'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { SPACE_CARRYFORWARD_CHARGE_NOTE } from '@gam/shared'
import { payableRowSql, lockHousehold } from './moneyPredicates'

const r2 = (n: number) => Math.round(n * 100) / 100
/**
 * How the landlord's answer at the invite opens, named once because two things
 * depend on the exact words: the sentence written to the claim's notes, and the
 * duplicate check that keeps a re-sent invite from writing it twice.
 */
const ASSUMPTION_NOTE_PREFIX = 'Taken on as a condition of moving in'
const sum = (rows: { amount: number }[]) => r2(rows.reduce((t, r) => t + r.amount, 0))

export interface CarryforwardChargeLine {
  id: string
  type: string
  amount: number
  dueDate: string
  label: string
  detail: string | null
}

export interface CarryforwardPreview {
  leaseId: string
  unitId: string
  /** The space's printed name (display_label when the park gave it one). */
  spaceName: string
  propertyId: string
  propertyName: string
  landlordId: string
  departingTenantId: string | null
  departingTenantName: string | null
  /** units.unit_type must be mobile_home AND dwelling_ownership 'tenant' (10/19 — an RV spot
   *  is tenant-owned too, and an RV leaves with its owner). */
  dwellingOwnership: string | null
  /** The home's recorded owner, when the landlord entered one. Never required. */
  recordedHomeOwnerName: string | null
  /** False when nothing carries forward; `reason` says why, in plain words. */
  eligible: boolean
  reason: string | null
  /** Space rent that moves to the space. */
  carries: CarryforwardChargeLine[]
  carriesTotal: number
  /** Everything that stays the departing resident's own debt. */
  stays: CarryforwardChargeLine[]
  staysTotal: number
  /** Late fees dropped outright — not moved, not kept. */
  waives: CarryforwardChargeLine[]
  waivesTotal: number
  /** The oldest carried rent's due date: the day the carried balance ages from. */
  oldestDueDate: string | null
  /** An open claim already on this space (a close-out already done). */
  existingCarryforwardId: string | null
}

interface RawRow {
  id: string
  type: string
  amount: string
  due_date: string
  entry_description: string
  notes: string | null
  invoice_id: string | null
  lease_fee_id: string | null
}

/**
 * SPACE RENT is a rent charge, and only a rent charge. A park-owned trailer's
 * rent rides the same `rent` row as the ground it sits on, which is why this
 * mechanism refuses a landlord-owned dwelling outright rather than trying to
 * split one row into ground and home.
 */
const CARRIES_SQL = `p.type = 'rent'`
const WAIVES_SQL = `p.type = 'late_fee'`

/**
 * THIS COMPANY'S OWN MONEY ($2 is the lease's landlord). A lease's bill is read
 * by lease AND by its invoices, because a charge can sit on the document
 * without being a term of the lease — and on a CONVERGED invoice (S616) one of
 * those charges belongs to a DIFFERENT COMPANY: the neighbor landlord whose
 * meter supplies a serviced space is billed on this resident's invoice with
 * `lease_id` NULL and his own `landlord_id`. Nic: "the utilities are not tied
 * to the lease from the landlord next door because they are not part of that.
 * They're getting billed to the same tenant but for a different landlord."
 *
 * Without this, the close-out window read the neighbor's $40 water bill as
 * "stays the departing resident's own debt" to THIS park, put another
 * company's receivable on the screen and in the done screen's figure, and
 * broke the rule that each audience only ever sees its own money.
 */
const LANDLORDS_OWN_ROW_SQL = `p.landlord_id = $2`

function lineOf(row: RawRow): CarryforwardChargeLine {
  const note = (row.notes ?? '').trim()
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    dueDate: String(row.due_date).slice(0, 10),
    label: row.type === 'rent' ? 'Space rent'
      : row.type === 'late_fee' ? 'Late fee'
      : row.type === 'utility' ? 'Utility'
      : row.type === 'deposit' ? 'Deposit'
      : row.type === 'home_payment' ? 'Home payment'
      : 'Fee',
    detail: note.length > 0 ? (note.length > 120 ? `${note.slice(0, 117)}…` : note) : null,
  }
}

/**
 * What a close-out would do, in dollars, changing nothing. This is the screen a
 * landlord decides from: the rent that leaves with the space, the utilities
 * that stay, and the late fees that disappear.
 */
export async function previewSpaceRentCarryforward(leaseId: string): Promise<CarryforwardPreview> {
  const lease = await queryOne<{
    id: string; landlord_id: string; unit_id: string; status: string
    space_name: string; dwelling_ownership: string | null; unit_type: string | null
    property_id: string; property_name: string; timezone: string | null
    tenant_id: string | null; first_name: string | null; last_name: string | null
    owner_first: string | null; owner_last: string | null
  }>(`
    SELECT l.id, l.landlord_id, l.unit_id, l.status,
           COALESCE(u.display_label, u.unit_number) AS space_name,
           u.dwelling_ownership, u.unit_type,
           pr.id AS property_id, pr.name AS property_name, pr.timezone,
           lt.tenant_id, tu.first_name, tu.last_name,
           ou.first_name AS owner_first, ou.last_name AS owner_last
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN LATERAL (
        SELECT x.tenant_id FROM lease_tenants x
         WHERE x.lease_id = l.id AND x.status IN ('active', 'pending_add', 'pending_remove')
         ORDER BY CASE x.role WHEN 'primary' THEN 0 ELSE 1 END, x.created_at LIMIT 1
      ) lt ON TRUE
      LEFT JOIN tenants t ON t.id = lt.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      LEFT JOIN LATERAL (
        SELECT ho.owner_user_id FROM home_ownerships ho
         WHERE ho.unit_id = u.id AND ho.status = 'active' LIMIT 1
      ) hoa ON TRUE
      LEFT JOIN users ou ON ou.id = hoa.owner_user_id
     WHERE l.id = $1`, [leaseId])
  if (!lease) throw new AppError(404, 'Lease not found')

  const rows = await query<RawRow>(`
    SELECT p.id, p.type, p.amount::text AS amount, p.due_date::text AS due_date,
           p.entry_description, p.notes, p.invoice_id, p.lease_fee_id
      FROM payments p
      LEFT JOIN invoices inv ON inv.id = p.invoice_id
     WHERE (p.lease_id = $1
            OR p.invoice_id IN (SELECT i2.id FROM invoices i2 WHERE i2.lease_id = $1))
       AND ${LANDLORDS_OWN_ROW_SQL}
       AND ${payableRowSql('p')}
       AND p.revenue_owner = 'landlord'
       AND p.space_carryforward_id IS NULL
       AND (inv.id IS NULL OR inv.status <> 'void')
     ORDER BY p.due_date, p.created_at, p.id`, [leaseId, lease.landlord_id])

  const carries = rows.filter(r => r.type === 'rent').map(lineOf)
  const waives = rows.filter(r => r.type === 'late_fee').map(lineOf)
  const stays = rows.filter(r => r.type !== 'rent' && r.type !== 'late_fee').map(lineOf)

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM space_rent_carryforwards WHERE unit_id = $1 AND status = 'open'`, [lease.unit_id])

  const name = (a: string | null, b: string | null) =>
    [a, b].filter(Boolean).join(' ').trim() || null

  let eligible = true
  let reason: string | null = null
  // In this order on purpose: the space's own rule first, then what the space
  // already carries, and only then the lease. A lease that has ALREADY been
  // closed out has no resident on it any more (the close-out removes them, as
  // every other ending does), so asking about the resident first answered a
  // second close-out with "this lease has no resident" — true, and no use to
  // anybody. What the landlord needs to be told is that the space already
  // carries a balance, and what to do about it.
  if (lease.unit_type !== 'mobile_home') {
    eligible = false
    // 10/19 (Nic), and this gate was WRONG when first built — it asked only
    // whether the home was tenant-owned, which is TRUE of an RV spot by its
    // nature: the guest owns the RV. 94 live RV spots would have carried a
    // balance forward. His rule, verbatim:
    //
    //   "I also want that only be applicable to mobile home spots as the space
    //    rent accrues tied to the trailer. So that should never happen to an RV
    //    because somebody leaves with their RV and somebody else comes in with
    //    their own RV. And other unit types are landlord-owned, like apartments
    //    or single-family homes. So really tenant-owned mobile homes is the only
    //    place that should be having this kind of workflow."
    //
    // The whole claim rests on the SAME home staying on the SAME spot while its
    // owners change. A manufactured home is set up and does not move; an RV
    // leaves with the person who owes the money, and there is nothing left on
    // the spot for the debt to attach to. So the unit type is the first gate,
    // before ownership.
    reason = 'Only a mobile home space carries unpaid space rent forward. An RV or a park-owned unit leaves nothing behind for the next resident to inherit.'
  } else if (lease.dwelling_ownership !== 'tenant') {
    eligible = false
    // The park owns the home, so the space does not change hands with it.
    reason = 'The park owns the home on this space, so nothing carries forward — a vacancy has no next owner to inherit it.'
  } else if (existing) {
    eligible = false
    // takeOffCarryforward is the "take off" this names. Before it existed the
    // sentence asked for something no screen, route or job in GAM could do.
    reason = 'This space already carries an unpaid space-rent balance. Settle or take off the existing one first.'
  } else if (!lease.tenant_id) {
    eligible = false
    reason = 'This lease has no resident, so there is nobody the balance belongs to.'
  } else if (carries.length === 0) {
    eligible = false
    reason = 'There is no unpaid space rent on this lease, so there is nothing to carry.'
  }

  return {
    leaseId: lease.id,
    unitId: lease.unit_id,
    spaceName: lease.space_name,
    propertyId: lease.property_id,
    propertyName: lease.property_name,
    landlordId: lease.landlord_id,
    departingTenantId: lease.tenant_id,
    departingTenantName: name(lease.first_name, lease.last_name),
    dwellingOwnership: lease.dwelling_ownership,
    recordedHomeOwnerName: name(lease.owner_first, lease.owner_last),
    eligible,
    reason,
    carries, carriesTotal: sum(carries),
    stays, staysTotal: sum(stays),
    waives, waivesTotal: sum(waives),
    oldestDueDate: carries.length > 0 ? carries[0].dueDate : null,
    existingCarryforwardId: existing?.id ?? null,
  }
}

/**
 * THE FIGURE THE LANDLORD SAW (S655's desk rule: "a figure that moved under the
 * desk's answer is asked again IN PLACE, never sent silently"). One sentence,
 * used by both checks — the cheap one on the way in and the one that actually
 * holds, under the household lock — so a landlord cannot be told two different
 * things about the same mismatch.
 */
export function carriedFigureMoved(expected: number, now: number): string {
  return `The unpaid space rent on this space has changed — it is now $${now.toFixed(2)}, `
    + `not $${expected.toFixed(2)}. Check the figures and press again.`
}
/** Dollars apart enough to matter (a cent, not a float artifact). */
export const carriedFigureDiffers = (expected: number, now: number) => Math.abs(expected - now) > 0.004

export interface CloseOutResult {
  carryforwardId: string
  chargeId: string
  carriedAmount: number
  lateFeesWaived: number
  stayedWithDepartingTenant: number
  leaseEndedOn: string
  invoicesExemptedFromLateFees: number
}

/**
 * Close a departing resident out on a tenant-owned space.
 *
 * In one transaction: the unpaid space rent is taken off his lease and re-billed
 * as the space's ONE carried balance, every open late fee is voided, the
 * still-open bills he leaves behind stop accruing new ones, and his lease is
 * ended. What he still owes on his own — utilities, fees, a deposit — is not
 * touched, by design.
 *
 * Nothing about the next resident is needed or recorded here. The claim sits on
 * the space, and the trigger in migration 20261021100000 attaches it to
 * whatever lease is drafted next, from whichever of the half-dozen draft paths
 * writes it.
 */
export async function closeOutWithCarryforward(client: PoolClient, opts: {
  leaseId: string
  byUserId: string
  /** The day they left. Defaults to the park's today. */
  endDate?: string | null
  notes?: string | null
  /**
   * The figure the landlord pressed on, checked against the LOCKED read below
   * and not only against the preview. The route's own check reads outside the
   * lock, and a desk payment landing in that window holds the household lock
   * and therefore completes first: the guard passed on the stale $880 and the
   * claim was then created for $440 — closed out silently on a figure the
   * landlord never saw, which is exactly what the guard exists to prevent.
   * Omitted by a caller with no screen behind it (a job, a test).
   */
  expectedCarried?: number | null
}): Promise<CloseOutResult> {
  const pv = await previewSpaceRentCarryforward(opts.leaseId)
  if (!pv.eligible) throw new AppError(409, pv.reason ?? 'This space carries nothing forward.')
  if (!pv.departingTenantId) throw new AppError(409, 'This lease has no resident.')

  // The departing resident's whole balance is read and written under his
  // household lock, so a payment landing at the same moment cannot settle a row
  // this is voiding.
  await lockHousehold(client, pv.departingTenantId, pv.landlordId)

  const tz = (await queryOne<{ timezone: string | null }>(
    `SELECT timezone FROM properties WHERE id = $1`, [pv.propertyId]))?.timezone ?? null
  const today = todayIn(tz)
  const endDate = opts.endDate ?? today

  // Re-read the rows under the lock: the preview was taken outside it.
  const live = (await client.query<{ id: string; type: string; amount: string; due_date: string }>(`
    SELECT p.id, p.type, p.amount::text AS amount, p.due_date::text AS due_date
      FROM payments p
      LEFT JOIN invoices inv ON inv.id = p.invoice_id
     WHERE (p.lease_id = $1
            OR p.invoice_id IN (SELECT i2.id FROM invoices i2 WHERE i2.lease_id = $1))
       AND ${LANDLORDS_OWN_ROW_SQL}
       AND ${payableRowSql('p')}
       AND p.revenue_owner = 'landlord'
       AND p.space_carryforward_id IS NULL
       AND (inv.id IS NULL OR inv.status <> 'void')
       AND (${CARRIES_SQL} OR ${WAIVES_SQL})
     ORDER BY p.due_date, p.created_at, p.id
     FOR UPDATE OF p`, [opts.leaseId, pv.landlordId])).rows

  const rentRows = live.filter(r => r.type === 'rent')
  const lateRows = live.filter(r => r.type === 'late_fee')
  if (rentRows.length === 0) throw new AppError(409, 'There is no unpaid space rent on this lease any more.')

  const carried = r2(rentRows.reduce((t, r) => t + Number(r.amount), 0))
  const waived = r2(lateRows.reduce((t, r) => t + Number(r.amount), 0))
  const oldestDue = String(rentRows[0].due_date).slice(0, 10)

  // The press is answered against THIS figure — the one nothing can move any
  // more, because the household is locked and stays locked until the commit.
  if (opts.expectedCarried != null && carriedFigureDiffers(opts.expectedCarried, carried)) {
    throw new AppError(409, carriedFigureMoved(opts.expectedCarried, carried))
  }

  const cf = (await client.query<{ id: string }>(`
    INSERT INTO space_rent_carryforwards (
      landlord_id, property_id, unit_id, origin_lease_id, origin_tenant_id,
      amount, late_fees_waived, opened_on, oldest_due_date, opened_by, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`,
    [pv.landlordId, pv.propertyId, pv.unitId, opts.leaseId, pv.departingTenantId,
     carried.toFixed(2), waived.toFixed(2), today, oldestDue, opts.byUserId, opts.notes ?? null])).rows[0]

  // The rent charges come off his lease. Their amounts live on in the one
  // carried charge below, and audit_row_changes keeps what each row said.
  await client.query(`
    UPDATE payments
       SET status = 'voided', voided_at = NOW(),
           void_reason = 'Carried to the space: unpaid space rent follows the space on a tenant-owned home',
           space_carryforward_id = $2
     WHERE id = ANY($1::uuid[])`,
    [rentRows.map(r => r.id), cf.id])

  // The late fees are dropped. Not moved, and not left on the departing
  // resident: "close out late fees entirely."
  if (lateRows.length > 0) {
    await client.query(`
      UPDATE payments
         SET status = 'voided', voided_at = NOW(),
             void_reason = 'Dropped at close-out: a carried space-rent balance never carries late fees'
       WHERE id = ANY($1::uuid[])`, [lateRows.map(r => r.id)])
  }

  // And none accrue tomorrow either. His remaining bills (the utilities that
  // stay his) are the ones the nightly engine would keep fining, and the fee
  // decision Nic made is about this situation, not about one night of it.
  //
  // By LEASE, which is already this company's own: invoices.lease_id names a
  // lease of this landlord, so the sweep cannot reach another company's bill
  // even on a CONVERGED invoice. The neighbor landlord's utility line rides
  // this document (the filter above keeps it out of the figures), and the late
  // fee an invoice earns is the INVOICE's landlord's revenue
  // (jobs/lateFees insertLateFeeRow writes invoices.landlord_id), never the
  // utility line's. So what is given up here is this park's own fee income on
  // its own bill, which is the decision — and the neighbor's $40 keeps ageing
  // as his own receivable, un-fined before and after, because no late fee on
  // this invoice was ever his.
  const exempt = await client.query(`
    UPDATE invoices
       SET late_fee_exempt = TRUE
     WHERE lease_id = $1 AND status IN ('pending', 'partial') AND late_fee_exempt = FALSE`,
    [opts.leaseId])

  // THE ONE CHARGE. tenant_id is the departing resident (he owes it); lease_id
  // starts on his lease so he can pay it before anyone takes the space, and the
  // trigger moves it to the next lease drafted here. invoice_id stays NULL for
  // life, which is what keeps the late-fee engine away from it.
  const charge = (await client.query<{ id: string }>(`
    INSERT INTO payments (
      unit_id, lease_id, tenant_id, landlord_id, invoice_id,
      type, amount, status, due_date, entry_description, notes,
      revenue_owner, space_carryforward_id
    ) VALUES ($1,$2,$3,$4, NULL, 'carried_balance', $5, 'pending', $6, 'BALANCE', $7, 'landlord', $8)
    RETURNING id`,
    [pv.unitId, opts.leaseId, pv.departingTenantId, pv.landlordId,
     carried.toFixed(2), oldestDue, SPACE_CARRYFORWARD_CHARGE_NOTE, cf.id])).rows[0]

  // He is gone. The lease was left open and still counting as occupied.
  //
  // ENDING A LEASE IS MORE THAN A STATUS. Every other path that ends one
  // (services/leaseTermination, lib/unwindIssuedLease, services/unitMove) also
  // stamps terminated_at, takes the residents off it and frees the space, and
  // there is no trigger on leases that cascades any of it. Written as a status
  // alone, this close-out left three things wrong: the credit ledger's
  // tenancy_ended_with_balance detector keys on terminated_at within the last
  // day (jobs/balanceCreditDetectors), so the one termination in GAM where the
  // resident walks away owing $1,051 of utilities was the one that emitted
  // nothing; Rashawn still read as an ACTIVE resident of MH 09 to everything
  // that joins lease_tenants on status; and the space still read as taken.
  await client.query(`
    UPDATE leases
       SET status = 'terminated', end_date = COALESCE(end_date, $2::date),
           terminated_at = COALESCE(terminated_at, NOW()),
           termination_reason = COALESCE(termination_reason,
             'Closed out: unpaid space rent carried to the space on a tenant-owned home'),
           needs_review = FALSE, updated_at = NOW()
     WHERE id = $1`, [opts.leaseId, endDate])
  // A spot on the lease nobody ever signed never joined it (the rule
  // lib/leaseDocCascade and leaseTermination both use); the people who were on
  // it are removed, with the reason every other ending gives.
  await client.query(`
    UPDATE lease_tenants SET status = 'void', updated_at = NOW()
     WHERE lease_id = $1 AND status = 'pending_add'`, [opts.leaseId])
  await client.query(`
    UPDATE lease_tenants
       SET status = 'removed', removed_at = NOW(), removed_reason = 'lease_ended', updated_at = NOW()
     WHERE lease_id = $1 AND status IN ('active', 'pending_remove')`, [opts.leaseId])
  // The space is free for whoever buys the home — unless somebody else is
  // already on it (the same guard unwindIssuedLease and unitMove use: never
  // vacate a space another live lease holds). GAM's own per-space fee is not
  // affected: it counts a lease that held the space at any point in the month
  // (billableUnits occupiedSpacesSql), never units.status, so leaving never
  // lowers the month.
  await client.query(`
    UPDATE units SET status = 'vacant', updated_at = NOW()
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM leases l
                        WHERE l.unit_id = $1 AND l.id <> $2 AND l.status IN ('active', 'pending'))`,
    [pv.unitId, opts.leaseId])

  return {
    carryforwardId: cf.id,
    chargeId: charge.id,
    carriedAmount: carried,
    lateFeesWaived: waived,
    stayedWithDepartingTenant: pv.staysTotal,
    leaseEndedOn: endDate,
    invoicesExemptedFromLateFees: exempt.rowCount ?? 0,
  }
}

export interface CarryforwardView {
  id: string
  unitId: string
  spaceName: string
  propertyName: string
  amount: number
  settledAmount: number
  stillOwed: number
  lateFeesWaived: number
  status: string
  openedOn: string
  oldestDueDate: string
  settledOn: string | null
  /** The day the landlord wrote it off, when he did. */
  takenOffOn: string | null
  /** Who left it. He stays liable until it is paid, however long that takes. */
  owedByName: string | null
  owedByTenantId: string
  /** Who took it on with the space, once a lease has been drafted here. */
  assumedLeaseId: string | null
  assumedByName: string | null
  assumedAt: string | null
  /**
   * When a landlord was shown this balance and put it on a named person as a
   * condition of moving in. Null means nobody ever was.
   */
  assumptionRecordedAt: string | null
  /**
   * 10/19: the balance moved onto a lease and NOBODY was asked — a lease
   * drafted from one of the doors that does not ask (tenant onboarding,
   * issuance, stay terms; only the invite asks). The space's window says so,
   * because the alternative is a resident whose first bill carries a stranger's
   * space rent with nothing anywhere saying how it got there.
   */
  movedWithoutBeingAsked: boolean
  /** The label the new resident sees. Never "rent". */
  chargeLabel: string
  arrangement: { amount: number; dayOfMonth: number; startedOn: string } | null
  /** Every cycle an arrangement asked for, newest first. */
  installments: Array<{ dueDate: string; amount: number; status: string; appliedAmount: number; metOn: string | null }>
}

// pg hands a `date` back as a JS Date, and a Date read as a string is
// "Mon Oct 19 2026 …" — so every day is cast to text in SQL and stays the
// park's calendar day the whole way out.
const VIEW_SQL = `
  SELECT c.id, c.landlord_id, c.property_id, c.unit_id, c.origin_lease_id, c.origin_tenant_id,
         c.amount::text AS amount, c.settled_amount::text AS settled_amount,
         c.late_fees_waived::text AS late_fees_waived,
         c.opened_on::text AS opened_on, c.oldest_due_date::text AS oldest_due_date,
         c.assumed_lease_id, c.assumed_tenant_id, c.assumed_at,
         c.assumption_recorded_at,
         c.status, c.settled_on::text AS settled_on, c.taken_off_on::text AS taken_off_on, c.notes,
         c.arrangement_amount::text AS arrangement_amount, c.arrangement_day,
         c.arrangement_started_on::text AS arrangement_started_on,
         COALESCE(u.display_label, u.unit_number) AS space_name,
         -- The space's facts TODAY, which is what decides whether the balance
         -- still follows onto a next lease (claimOf below). Read here rather
         -- than per row: the portfolio list reads every claim at once.
         u.dwelling_ownership, u.unit_type,
         pr.name AS property_name,
         ou.first_name AS owed_first, ou.last_name AS owed_last,
         au.first_name AS assumed_first, au.last_name AS assumed_last
    FROM space_rent_carryforwards c
    JOIN units u ON u.id = c.unit_id
    JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN tenants ot ON ot.id = c.origin_tenant_id
    LEFT JOIN users ou ON ou.id = ot.user_id
    LEFT JOIN tenants at2 ON at2.id = c.assumed_tenant_id
    LEFT JOIN users au ON au.id = at2.user_id`

async function viewOf(row: any): Promise<CarryforwardView> {
  const installments = await query<{
    due_date: string; amount: string; status: string; applied_amount: string; met_on: string | null
  }>(`
    SELECT due_date::text AS due_date, amount::text AS amount, status,
           applied_amount::text AS applied_amount, met_on::text AS met_on
      FROM space_carryforward_installments
     WHERE carryforward_id = $1
     ORDER BY due_date DESC`, [row.id])
  const name = (a: string | null, b: string | null) => [a, b].filter(Boolean).join(' ').trim() || null
  const amount = Number(row.amount)
  const settled = Number(row.settled_amount)
  return {
    id: row.id,
    unitId: row.unit_id,
    spaceName: row.space_name,
    propertyName: row.property_name,
    amount,
    settledAmount: settled,
    // Only an OPEN claim is still owed. A claim the landlord took off is not a
    // bill any more, whatever was paid against it before he took it off — the
    // alternative is a screen that says "Taken off" and "$780 still owed" at
    // the same time, which is what it used to say.
    stillOwed: row.status === 'open' ? r2(Math.max(0, amount - settled)) : 0,
    lateFeesWaived: Number(row.late_fees_waived),
    status: row.status,
    openedOn: String(row.opened_on).slice(0, 10),
    oldestDueDate: String(row.oldest_due_date).slice(0, 10),
    settledOn: row.settled_on ? String(row.settled_on).slice(0, 10) : null,
    takenOffOn: row.taken_off_on ? String(row.taken_off_on).slice(0, 10) : null,
    owedByName: name(row.owed_first, row.owed_last),
    owedByTenantId: row.origin_tenant_id,
    assumedLeaseId: row.assumed_lease_id,
    assumedByName: name(row.assumed_first, row.assumed_last),
    assumedAt: row.assumed_at ? new Date(row.assumed_at).toISOString() : null,
    assumptionRecordedAt: row.assumption_recorded_at ? new Date(row.assumption_recorded_at).toISOString() : null,
    // Only while it is still owed: a balance already paid off or taken off is
    // not a question anybody can still act on.
    movedWithoutBeingAsked: row.status === 'open'
      && row.assumed_lease_id != null && row.assumption_recorded_at == null,
    chargeLabel: SPACE_CARRYFORWARD_CHARGE_NOTE,
    arrangement: row.arrangement_amount == null ? null : {
      amount: Number(row.arrangement_amount),
      dayOfMonth: Number(row.arrangement_day),
      startedOn: String(row.arrangement_started_on).slice(0, 10),
    },
    installments: installments.map(i => ({
      dueDate: String(i.due_date).slice(0, 10),
      amount: Number(i.amount),
      status: i.status,
      appliedAmount: Number(i.applied_amount),
      metOn: i.met_on ? String(i.met_on).slice(0, 10) : null,
    })),
  }
}

/** The claim on a space, open or already paid off (the most recent one). */
export async function carryforwardForUnit(unitId: string): Promise<SpaceClaim | null> {
  const row = await queryOne<any>(
    `${VIEW_SQL} WHERE c.unit_id = $1 ORDER BY (c.status = 'open') DESC, c.opened_on DESC LIMIT 1`, [unitId])
  if (!row) return null
  return await claimOf(row)
}

/**
 * A claim as a SCREEN needs it: the view, plus who to ask, plus the one fact
 * the invite screen has to have — whether this balance will actually land on
 * the next lease drafted here.
 */
export interface SpaceClaim extends CarryforwardView {
  landlordId: string
  propertyId: string
  /** The lease to open it from: the one that took it on, else the one that left it. */
  leaseId: string
  /** The space's ownership TODAY, which is what decides the answer below. */
  dwellingOwnership: string | null
  unitType: string | null
  /**
   * Will this balance follow onto the next lease drafted on this space? Read
   * from the SAME gate the trigger in migration 20261021100000 uses — an open
   * claim on a space whose home is still tenant-owned — so the invite screen
   * never has to re-derive the rule and can never ask the question on a space
   * where the engine would not in fact move it (the park took the home over
   * for the back rent, and a park-owned rental carries nothing forward).
   */
  followsToNextLease: boolean
}

async function claimOf(row: any): Promise<SpaceClaim> {
  return {
    ...(await viewOf(row)),
    landlordId: row.landlord_id,
    propertyId: row.property_id,
    leaseId: row.assumed_lease_id ?? row.origin_lease_id,
    dwellingOwnership: row.dwelling_ownership ?? null,
    unitType: row.unit_type ?? null,
    followsToNextLease: row.status === 'open' && row.dwelling_ownership === 'tenant',
  }
}

/**
 * EVERY SPACE THAT CARRIES SOMETHING, for the landlord looking at his own
 * portfolio. Nic wanted to see what a space carries without first having to
 * remember which lease left it behind, so this reads by SPACE and hands back
 * the lease to open it from.
 *
 * Property-scoped on purpose: a staff member locked to one park has no
 * business reading a debt on a space in another one. `scopedPropertyIds` is
 * middleware/auth getScopedPropertyIds — null means unrestricted, [] means
 * nothing, the same posture every other list here takes.
 */
export async function carryforwardsForLandlords(opts: {
  landlordIds: string[]
  scopedPropertyIds: string[] | null
  /** 'open' is the working list; 'all' includes paid off and taken off. */
  include?: 'open' | 'all'
}): Promise<SpaceClaim[]> {
  if (opts.landlordIds.length === 0) return []
  if (opts.scopedPropertyIds !== null && opts.scopedPropertyIds.length === 0) return []
  const rows = await query<any>(
    `${VIEW_SQL}
      WHERE c.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR c.property_id = ANY($2::uuid[]))
        AND ($3::boolean OR c.status = 'open')
      ORDER BY (c.status = 'open') DESC, c.opened_on DESC, c.id`,
    [opts.landlordIds, opts.scopedPropertyIds, opts.include === 'all'])
  const out: SpaceClaim[] = []
  for (const row of rows) out.push(await claimOf(row))
  return out
}

/** One claim by its own id, for the screens that already know which one. */
export async function carryforwardById(id: string): Promise<SpaceClaim | null> {
  const row = await queryOne<any>(`${VIEW_SQL} WHERE c.id = $1`, [id])
  if (!row) return null
  return await claimOf(row)
}

/**
 * THE LANDLORD'S ANSWER AT THE INVITE, written down (10/19, Nic).
 *
 *   "If Jacob declines, he's not moving into the park. ... Space rent is owed,
 *    and he can buy the trailer all he wants, but he doesn't get to move in
 *    without following the rules of the park, without paying the bills."
 *
 * So it is a condition of moving in, not a request, and the landlord is the one
 * who answers. The MONEY needs nothing recorded here — the trigger moves the
 * charge the moment a lease is drafted on the space. What is recorded is that
 * the landlord was shown the figure and whose it was, and put the condition on
 * a named person, on a day. That matters most in the path where no lease drafts
 * today (an applicant who screens first): without this line, weeks later
 * nothing would say the question was ever asked.
 *
 * Written to the claim's own notes, the way a take-off writes its reason there,
 * and stamped on assumption_recorded_at so a balance somebody was asked to take
 * on can be told apart from one that moved onto a resident in silence (the
 * invite is the only one of the four lease-draft doors that asks).
 *
 * IDEMPOTENT PER PERSON, NOT PER DAY. The sentence carries the day it was
 * written, and the duplicate check used to be `notes.includes(line)` — the
 * whole line, date and all — so it only held within one property-local day. A
 * landlord whose invite email bounced and who sent it again the next morning,
 * or who pressed Invite either side of midnight in the park's timezone, got two
 * near-identical sentences for the same person on the one record of the
 * condition, reading as if it had been imposed twice. The signature is now
 * everything except the date.
 */
export async function recordAssumptionAtInvite(client: PoolClient, opts: {
  carryforwardId: string
  byUserId?: string | null
  byUserEmail: string | null
  residents: Array<{ name?: string | null; email?: string | null }>
}): Promise<{ line: string; alreadyRecorded: boolean }> {
  const cf = (await client.query<{ id: string; status: string; property_id: string; notes: string | null }>(
    `SELECT id, status, property_id, notes FROM space_rent_carryforwards WHERE id = $1 FOR UPDATE`,
    [opts.carryforwardId])).rows[0]
  if (!cf) throw new AppError(404, 'That carried balance was not found.')
  if (cf.status !== 'open') {
    throw new AppError(409, cf.status === 'voided'
      ? 'That balance was taken off, so there is nothing for a new resident to take on.'
      : 'That balance is paid off, so there is nothing for a new resident to take on.')
  }
  const tz = (await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM properties WHERE id = $1`, [cf.property_id])).rows[0]?.timezone ?? null
  const today = todayIn(tz)
  const who = opts.residents
    .map(r => [r.name?.trim(), r.email?.trim() ? `<${r.email.trim()}>` : null].filter(Boolean).join(' '))
    .filter(s => s.length > 0)
    .join(', ')
  // The part that identifies WHO the condition was put on, with no date in it.
  const subject = (who || 'the incoming resident')
    + (opts.byUserEmail ? ` (asked by ${opts.byUserEmail})` : '')
  const line = `${ASSUMPTION_NOTE_PREFIX}, ${today}: ${subject}`
  const already = (cf.notes ?? '').split('\n')
    .some(l => l.trim().startsWith(ASSUMPTION_NOTE_PREFIX) && l.trim().endsWith(subject))
  if (already) return { line, alreadyRecorded: true }
  await client.query(
    `UPDATE space_rent_carryforwards
        SET notes = COALESCE(notes || E'\\n', '') || $2,
            -- The FIRST time anybody was asked. A second household asked about
            -- the same space later adds its own sentence and leaves the stamp
            -- where it is: what the screens read it for is whether the question
            -- was ever put, not when it was last put.
            assumption_recorded_at = COALESCE(assumption_recorded_at, NOW()),
            assumption_recorded_by = COALESCE(assumption_recorded_by, $3),
            updated_at = NOW()
      WHERE id = $1`, [opts.carryforwardId, line, opts.byUserId ?? null])
  return { line, alreadyRecorded: false }
}

/**
 * What a lease carries: the claim this lease took on with the space, or — for
 * the lease that left it behind — the claim it created.
 */
export async function carryforwardForLease(leaseId: string): Promise<(SpaceClaim & { role: 'assumed' | 'origin' }) | null> {
  const row = await queryOne<any>(
    `${VIEW_SQL} WHERE c.assumed_lease_id = $1 OR c.origin_lease_id = $1
      ORDER BY (c.assumed_lease_id = $1) DESC, c.opened_on DESC LIMIT 1`, [leaseId])
  if (!row) return null
  return {
    ...(await claimOf(row)),
    role: row.assumed_lease_id === leaseId ? 'assumed' : 'origin',
  }
}

/**
 * What a DEPARTING resident still has against their name, however long it
 * takes. Nic: "Yes, Rashan is still responsible for the money until it is
 * paid." And: "it's going to just record under his name only when the payment
 * happens. So, and we're not recording a payment like that until it's fully
 * settled. So if somebody makes $100 a month payments for a $2,000 bill and
 * it's 20 months till it gets paid off, it's gonna show that as being, you
 * know, almost 2 years late."
 *
 * So the claim — not the charge row — is the record of whose debt it was and
 * the day it finally cleared. `daysOutstanding` is counted from the oldest
 * carried rent's own due date to the day it settled, or to today while it is
 * still open, which is the "almost 2 years late" figure.
 */
export async function carryforwardsOwedBy(tenantId: string): Promise<Array<CarryforwardView & { daysOutstanding: number }>> {
  const rows = await query<any>(
    `${VIEW_SQL} WHERE c.origin_tenant_id = $1 ORDER BY c.opened_on DESC`, [tenantId])
  const out: Array<CarryforwardView & { daysOutstanding: number }> = []
  for (const row of rows) {
    const days = (await query<{ d: number }>(
      `SELECT ((COALESCE($2::date, (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date)) - $1::date)::int AS d
         FROM properties pr WHERE pr.id = $3`,
      [row.oldest_due_date, row.settled_on, row.property_id]))[0]?.d ?? 0
    out.push({ ...(await viewOf(row)), daysOutstanding: Math.max(0, days) })
  }
  return out
}

/**
 * THE PAYMENT ARRANGEMENT (10/19, Nic):
 *
 *   "there's nothing that automatically bills for it right now. The regular
 *    monthly bill comes out every month and the carry forward balance is kept
 *    track of, but it's at the tenant's discretion to actually make any sort of
 *    payment against that. So, to help landlords not forget about it and stuff,
 *    we need to do, you know, payment arrangements on carry forward balances.
 *    So what, even if it's $50 or $100 or whatever."
 *
 * An arrangement ASKS for an amount each cycle. It never writes a second
 * charge, because the whole balance is already the one carried charge — billing
 * $100 against it would bill the same debt twice. So what the cycle produces is
 * an installment record: what was asked for, what came in against the balance,
 * and whether it was met. A missed one costs nothing: there is no invoice to
 * fine, and nothing here writes a late_fee row.
 */
export async function setArrangement(client: PoolClient, opts: {
  carryforwardId: string
  amount: number | null
  dayOfMonth: number | null
  byUserId: string
  startOn?: string | null
}): Promise<void> {
  const cf = (await client.query<{ id: string; status: string; amount: string; settled_amount: string; property_id: string }>(
    `SELECT id, status, amount::text AS amount, settled_amount::text AS settled_amount, property_id
       FROM space_rent_carryforwards WHERE id = $1 FOR UPDATE`, [opts.carryforwardId])).rows[0]
  if (!cf) throw new AppError(404, 'That carried balance was not found.')

  if (opts.amount == null || opts.dayOfMonth == null) {
    await client.query(
      `UPDATE space_rent_carryforwards
          SET arrangement_amount = NULL, arrangement_day = NULL, arrangement_started_on = NULL,
              arrangement_set_by = $2, updated_at = NOW()
        WHERE id = $1`, [opts.carryforwardId, opts.byUserId])
    // The cycles it already asked for are settled up now rather than at the
    // next nightly run: the landlord who just pressed "Stop asking" is looking
    // at that list, and a cycle nobody is being asked for any more must not sit
    // there reading "Asked for this month".
    const stopTz = (await client.query<{ timezone: string | null }>(
      `SELECT timezone FROM properties WHERE id = $1`, [cf.property_id])).rows[0]?.timezone ?? null
    await judgeCarryforwardCycles(client, opts.carryforwardId, todayIn(stopTz), cf.status === 'open')
    return
  }
  if (cf.status !== 'open') {
    throw new AppError(409, cf.status === 'voided'
      ? 'That balance was taken off, so there is nothing to arrange payments on.'
      : 'That balance is paid off, so there is nothing to arrange payments on.')
  }
  const owed = r2(Number(cf.amount) - Number(cf.settled_amount))
  if (opts.amount > owed) {
    throw new AppError(422, `The monthly amount cannot be more than the $${owed.toFixed(2)} still owed.`)
  }
  const tz = (await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM properties WHERE id = $1`, [cf.property_id])).rows[0]?.timezone ?? null
  const startOn = opts.startOn ?? todayIn(tz)
  await client.query(
    `UPDATE space_rent_carryforwards
        SET arrangement_amount = $2, arrangement_day = $3, arrangement_started_on = $4,
            arrangement_set_by = $5, updated_at = NOW()
      WHERE id = $1`,
    [opts.carryforwardId, opts.amount.toFixed(2), opts.dayOfMonth, startOn, opts.byUserId])
}

export interface TakeOffResult {
  carryforwardId: string
  /** What was still owed on it and is now owed by nobody. */
  takenOff: number
  /** What had already been paid against it, which stays recorded. */
  keptPaid: number
  chargesVoided: number
}

/**
 * TAKE A CARRIED BALANCE OFF — the undo of a close-out, and the thing the
 * refusal in previewSpaceRentCarryforward tells a landlord to do ("Settle or
 * take off the existing one first").
 *
 * Without it that instruction had nothing behind it: 'voided' was in the
 * claim's CHECK and had a label ("Taken off"), and nothing in GAM could ever
 * write it. So a close-out run on the wrong resident was permanent — the one
 * open claim per space (ux_space_rent_carryforward_open_per_unit) refused every
 * future close-out on that space, and a claim whose charge had been voided by
 * hand sat open forever, re-attaching itself to every lease drafted there with
 * a balance no charge row existed for.
 *
 * It is not a deletion: nothing is erased (GAM keeps everything). The charge
 * rows are voided the way every other unowed charge is (services/chargeVoids —
 * status, stamp and a plain reason, and refused outright if a receipt or a bank
 * match points at one), what was really paid stays in settled_amount, and the
 * claim keeps saying whose debt it was. It only stops being a bill.
 */
export async function takeOffCarryforward(client: PoolClient, opts: {
  carryforwardId: string
  byUserId: string
  reason?: string | null
}): Promise<TakeOffResult> {
  const cf = (await client.query<{
    id: string; status: string; landlord_id: string; property_id: string; amount: string; settled_amount: string
  }>(
    `SELECT id, status, landlord_id, property_id, amount::text AS amount, settled_amount::text AS settled_amount
       FROM space_rent_carryforwards WHERE id = $1 FOR UPDATE`, [opts.carryforwardId])).rows[0]
  if (!cf) throw new AppError(404, 'That carried balance was not found.')
  if (cf.status === 'voided') throw new AppError(409, 'That balance has already been taken off.')
  if (cf.status === 'settled') throw new AppError(409, 'That balance is paid off, so there is nothing to take off.')

  // Whoever is being asked for it right now holds it, so their household is
  // locked before it is read — a payment landing at this moment must not settle
  // a row this is voiding. There is one household: the triggers move every live
  // row of a claim to the resident who took the space on, together, and a
  // part-payment leftover inherits the row it split from. Read in tenant order
  // all the same, so two of these can never take the same pair of locks in
  // opposite orders.
  const owing = (await client.query<{ tenant_id: string }>(
    `SELECT DISTINCT p.tenant_id FROM payments p
      WHERE p.space_carryforward_id = $1 AND p.type = 'carried_balance'
        AND p.status IN ('pending', 'failed') AND p.tenant_id IS NOT NULL
      ORDER BY 1`, [opts.carryforwardId])).rows
  for (const o of owing) await lockHousehold(client, o.tenant_id, cf.landlord_id)

  const live = (await client.query<{ id: string; amount: string; in_flight: boolean }>(
    `SELECT p.id, p.amount::text AS amount,
            (p.status = 'processing' OR (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL)) AS in_flight
       FROM payments p
      WHERE p.space_carryforward_id = $1 AND p.type = 'carried_balance'
        AND p.status IN ('pending', 'processing', 'failed')
      ORDER BY p.due_date, p.created_at, p.id
      FOR UPDATE OF p`, [opts.carryforwardId])).rows
  // Money already on its way cannot be written off: in a day or two it either
  // lands (and the balance is paid, not taken off) or it fails (and this works).
  if (live.some(r => r.in_flight)) {
    throw new AppError(409, 'A payment of this balance is still clearing, so it cannot be taken off yet. Wait for it to land or fail.')
  }

  // The park's own day, never the host's (todayIn, as the close-out does).
  const tz = (await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM properties WHERE id = $1`, [cf.property_id])).rows[0]?.timezone ?? null
  const today = todayIn(tz)

  // Marked first, so the rollup the voids below set off keeps it: a claim taken
  // off stays taken off (fn_space_rent_carryforward_rollup's first branch).
  await client.query(
    `UPDATE space_rent_carryforwards
        SET status = 'voided', settled_on = NULL,
            taken_off_by = $3, taken_off_on = $4::date, updated_at = NOW(),
            notes = COALESCE(notes || E'\\n', '') || $2
      WHERE id = $1`,
    [opts.carryforwardId,
     `Taken off ${today}${opts.reason?.trim() ? `: ${opts.reason.trim()}` : ''}`,
     opts.byUserId, today])

  const { voidUnowedChargesOrRefuse } = await import('./chargeVoids')
  const voided = live.length === 0 ? [] : await voidUnowedChargesOrRefuse(
    (t, p) => client.query(t, p),
    live.map(r => r.id),
    opts.reason?.trim()
      ? `Carried space-rent balance taken off: ${opts.reason.trim()}`
      : 'Carried space-rent balance taken off by the landlord',
    'A payment or a bank match already points at this carried balance, so it cannot be taken off. Undo that first.')

  // Nobody is being asked for this balance any more, so no cycle of it is left
  // waiting on an answer either (the same reason "Stop asking" judges).
  await judgeCarryforwardCycles(client, opts.carryforwardId, today, false)

  const after = (await client.query<{ settled_amount: string }>(
    `SELECT settled_amount::text AS settled_amount FROM space_rent_carryforwards WHERE id = $1`,
    [opts.carryforwardId])).rows[0]
  return {
    carryforwardId: opts.carryforwardId,
    takenOff: r2(voided.reduce((t, v) => t + v.amount, 0)),
    keptPaid: Number(after?.settled_amount ?? cf.settled_amount),
    chargesVoided: voided.length,
  }
}

export interface InstallmentRunResult {
  asked: number
  met: number
  missed: number
  /** Always zero, and asserted by the test: a missed installment is never fined. */
  lateFeesCharged: 0
}

/**
 * The cycle run, which does TWO separate things on every run:
 *
 *   ASK — for an open claim with a live arrangement, on the arrangement's day
 *   in the PROPERTY's month, write the installment record (once: the unique
 *   index on (carryforward_id, due_date) makes a second run a no-op).
 *
 *   JUDGE — settle up every cycle already asked for, by the money that has
 *   actually landed on the balance since. No fee either way: there is nothing
 *   to fine, and that is the decision rather than an oversight.
 *
 * WHY JUDGING IS NOT INSIDE THE ASK. It used to be: the whole loop read only
 * `status = 'open' AND arrangement_amount IS NOT NULL`, and the judging ran
 * after the day gate, so the LAST cycle was never judged once the claim left
 * 'open' or the arrangement was cleared. An arrangement asking $100 on the 5th,
 * paid off in full on the 20th: the claim rolls up to 'settled' and the Nov 5
 * row is never read again, so "What this space carries" showed "Paid off",
 * Carried $880 / Paid $880 / Still owed $0, and underneath it "Nov 5 · $100.00
 * · Asked for this month" — forever. "Stop asking" stranded the last cycle the
 * same way. So the claim set now also takes any claim with an unjudged cycle,
 * whatever its status, and the judging runs every night rather than monthly.
 *
 * It writes nothing it does not change (the DISTINCT FROM at the end): the
 * change journal is never pruned, so a nightly no-op UPDATE on a long-settled
 * claim's rows would be a nightly journal row about nothing. And a cycle on a
 * CLOSED claim is judged once and left alone — no money can land on it again —
 * while a missed cycle on an open one is re-judged, because a resident can
 * still pay it late.
 *
 * Idempotent, so it is safe to run as often as the scheduler likes and safe to
 * re-run after a failure.
 */
export async function runCarryforwardArrangements(client: PoolClient, asOf?: string): Promise<InstallmentRunResult> {
  const rows = (await client.query<{
    id: string; status: string; amount: string; settled_amount: string
    arrangement_amount: string | null; arrangement_day: number | null
    arrangement_started_on: string | null; today: string
  }>(`
    SELECT c.id, c.status, c.amount::text AS amount, c.settled_amount::text AS settled_amount,
           c.arrangement_amount::text AS arrangement_amount, c.arrangement_day,
           c.arrangement_started_on::text AS arrangement_started_on,
           COALESCE($1::date, (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date)::text AS today
      FROM space_rent_carryforwards c
      JOIN units u ON u.id = c.unit_id
      JOIN properties pr ON pr.id = u.property_id
     WHERE (c.status = 'open' AND c.arrangement_amount IS NOT NULL)
        -- A cycle still reading "asked" when the ask is over: the claim was
        -- settled or taken off, or the landlord stopped asking.
        OR EXISTS (SELECT 1 FROM space_carryforward_installments i
                    WHERE i.carryforward_id = c.id AND i.status = 'asked')
     ORDER BY c.id
     FOR UPDATE OF c`, [asOf ?? null])).rows

  const out: InstallmentRunResult = { asked: 0, met: 0, missed: 0, lateFeesCharged: 0 }
  for (const c of rows) {
    const today = c.today
    const day = c.arrangement_day == null ? null : Number(c.arrangement_day)
    const startedOn = c.arrangement_started_on ? String(c.arrangement_started_on).slice(0, 10) : null
    const owed = r2(Number(c.amount) - Number(c.settled_amount))

    // ── Ask ──
    const askToday = c.status === 'open' && day != null && startedOn != null
      && Number(today.slice(8, 10)) === day && today >= startedOn
      // Never ask for more than is left, and never for nothing.
      && owed > 0
    if (askToday) {
      const ask = Math.min(Number(c.arrangement_amount), owed)
      const ins = await client.query(`
        INSERT INTO space_carryforward_installments (carryforward_id, due_date, amount, asked_on)
        VALUES ($1, $2, $3, $2)
        ON CONFLICT (carryforward_id, due_date) DO NOTHING`,
        [c.id, today, ask.toFixed(2)])
      if ((ins.rowCount ?? 0) > 0) out.asked += 1
    }

    // ── Judge ──
    const judged = await judgeCarryforwardCycles(client, c.id, today, c.status === 'open')
    for (const st of judged) {
      if (st === 'met') out.met += 1
      else out.missed += 1
    }
  }
  return out
}

/**
 * Settle up the cycles an arrangement already asked for, by the money that has
 * actually landed on the balance. Returns what each cycle it CHANGED became.
 *
 * Called by the nightly run for every claim with an unjudged cycle, and
 * directly by the two doors that end the asking by hand — "Stop asking" and
 * taking the balance off — so the landlord who just pressed one of them does
 * not read "Asked for this month" under a balance nobody is being asked for.
 * The remaining case, a resident paying the whole balance off, is closed by the
 * next nightly run: the claim settles in a database trigger, which has no way
 * to call this.
 *
 * `claimOpen` is what decides whether a cycle already judged MISSED is read
 * again: on an open balance money can still land on it late, and on a closed
 * one it cannot, so it is judged once and left alone rather than re-written
 * every night into a change journal that is never pruned.
 */
async function judgeCarryforwardCycles(
  client: PoolClient, carryforwardId: string, beforeDay: string, claimOpen: boolean,
): Promise<string[]> {
  const judged = await client.query<{ status: string }>(`
      WITH paid AS (
        SELECT COALESCE(SUM(p.amount), 0) AS total,
               MAX((p.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date) AS last_day
          FROM payments p
          LEFT JOIN units u ON u.id = p.unit_id
          LEFT JOIN properties pr ON pr.id = u.property_id
         WHERE p.space_carryforward_id = $1 AND p.type = 'carried_balance'
           AND p.status IN ('settled', 'paid_via_deposit')
      ),
      -- What each cycle still open to judgement was owed by the time it came
      -- round: everything paid on the balance, less what the earlier cycles
      -- already asked for.
      target AS (
        SELECT i.id, i.status AS was, i.applied_amount AS was_applied,
               GREATEST(0, LEAST(i.amount, t.toward)) AS applied,
               CASE WHEN t.toward >= i.amount THEN 'met' ELSE 'missed' END AS becomes
          FROM space_carryforward_installments i
          CROSS JOIN LATERAL (
            SELECT (SELECT total FROM paid) - COALESCE((
                     SELECT SUM(e.amount) FROM space_carryforward_installments e
                      WHERE e.carryforward_id = i.carryforward_id AND e.due_date < i.due_date), 0) AS toward
          ) t
         WHERE i.carryforward_id = $1
           AND i.due_date < $2::date
           AND (i.status = 'asked' OR ($3::boolean AND i.status = 'missed'))
      )
      UPDATE space_carryforward_installments i
         SET applied_amount = tg.applied,
             status = tg.becomes,
             met_on = CASE WHEN tg.becomes = 'met'
                           THEN COALESCE(i.met_on, (SELECT last_day FROM paid), i.due_date) END,
             updated_at = NOW()
        FROM target tg
       WHERE i.id = tg.id
         AND (tg.becomes, tg.applied) IS DISTINCT FROM (tg.was, tg.was_applied)
      RETURNING i.status`, [carryforwardId, beforeDay, claimOpen])
  return judged.rows.map(r => r.status)
}
