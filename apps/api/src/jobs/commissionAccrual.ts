/**
 * S567: Portfolio-manager commission accrual (monthly).
 *
 * Per OCCUPIED unit/month a landlord relationship accrues three streams into
 * `commission_accruals` (rates from PORTFOLIO_COMMISSION in @gam/shared):
 *
 *   closing (25¢) → the closing agent: the referring LANDLORD
 *                   (landlords.referred_by_user_id) if this was a landlord
 *                   referral, else the PM who closed it
 *                   (landlords.portfolio_manager_id), else (S592) the OWNER's
 *                   PERSON-level upline (users.referred_by_user_id) — the
 *                   fallback that survives 1031s / new LLCs and pays a co-owner's
 *                   captured primary. If STILL none (truly organic self-closed)
 *                   → POT. A landlord referrer earns this residual exactly like a
 *                   PM closer, but does NOT do CS (see below).
 *   service (25¢) → customer service — ALWAYS paid to a person, NEVER the pot.
 *                   Closing and CS are the same agent, so when a closer exists
 *                   it pays the closer (they do their own CS). When self-closed
 *                   (no closer), CS is paid to the assigned CS specialist
 *                   (landlords.service_manager_id) — every landlord always has
 *                   one; CS is mandatory. If somehow unassigned at run time the
 *                   row is skipped (flagged, never pot) and fills on a re-run
 *                   once assigned.
 *   pot     (10¢) → the shared pot, ALWAYS, every occupied unit, no matter the
 *                   situation. Not commission.
 *
 * The pot's ONLY sources are this always-10¢ and the orphaned CLOSING 25¢ of a
 * self-closed landlord. Service is never a pot source.
 *
 * "Occupied unit" = a unit that is NOT vacant (status <> 'vacant'): active,
 * delinquent, and suspended units all have a tenant in place (rent-obligation
 * principle). Vacant units accrue nothing. [If GAM later wants commission tied
 * to actually-collected units instead of physically-occupied ones, change this
 * one predicate.]
 *
 * Idempotency: UNIQUE(landlord_id, accrual_month, role) + per-row INSERT .. ON
 * CONFLICT DO NOTHING. Re-runs are safe and will fill a role that was missing
 * (e.g. a CS assignment made after the month's first run).
 */

import { getClient, query } from '../db'
import { PORTFOLIO_COMMISSION } from '@gam/shared'
import type { PoolClient } from 'pg'

interface CommissionAccrualResult {
  monthScanned: string
  landlordsProcessed: number
  landlordsAccrued: number
  skippedZeroOccupied: number
  potAccrued: number
  commissionAccrued: number
  unassignedCsLandlords: string[]   // no closer AND no CS specialist — CS is mandatory; needs assignment
  errors: { landlord_id: string; error: string }[]
}

export async function processCommissionAccrual(now: Date = new Date()): Promise<CommissionAccrualResult> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthIso   = monthStart.toISOString().slice(0, 10)

  const result: CommissionAccrualResult = {
    monthScanned: monthIso,
    landlordsProcessed: 0,
    landlordsAccrued: 0,
    skippedZeroOccupied: 0,
    potAccrued: 0,
    commissionAccrued: 0,
    unassignedCsLandlords: [],
    errors: [],
  }

  const landlords = await query<{
    id: string
    portfolio_manager_id: string | null
    service_manager_id: string | null
    referred_by_user_id: string | null
    owner_upline_id: string | null
    owner_upline_role: string | null
    occupied: number
  }>(`
    SELECT l.id, l.portfolio_manager_id, l.service_manager_id, l.referred_by_user_id,
      -- S592: the founding owner's PERSON-level upline (+ its role), the fallback
      -- closer when the entity has no explicit attribution (survives 1031s /
      -- new LLCs; pays a co-owner's captured primary).
      ou.referred_by_user_id AS owner_upline_id,
      up.role                AS owner_upline_role,
      -- S604: commission is a share of GAM's per-occupied-unit revenue, so the
      -- count must match what GAM actually BILLS, not merely what is non-vacant.
      --   • 'owner_use'  — the owner lives there: no lease, no rent, no fee.
      --   • 'available'  — vacant but listed. Empty is empty; GAM collects
      --     nothing on it. Counting it (pre-S604) paid reps on units that
      --     generated no fee, and paid more the WORSE occupancy got.
      (SELECT COUNT(*)::int FROM units u
        WHERE u.landlord_id = l.id
          AND u.status NOT IN ('vacant', 'available', 'owner_use')) AS occupied
    FROM landlords l
    JOIN users ou      ON ou.id = l.user_id
    LEFT JOIN users up ON up.id = ou.referred_by_user_id
  `)

  for (const l of landlords) {
    result.landlordsProcessed++
    if (!l.occupied || l.occupied <= 0) { result.skippedZeroOccupied++; continue }
    try {
      const outcome = await accrueOneLandlord(l, monthIso)
      if (outcome.insertedAny) result.landlordsAccrued++
      result.commissionAccrued += outcome.commission
      result.potAccrued        += outcome.pot
      if (outcome.csUnassigned) result.unassignedCsLandlords.push(l.id)
    } catch (e: any) {
      result.errors.push({ landlord_id: l.id, error: e?.message ?? String(e) })
    }
  }

  return result
}

interface AccrueOutcome { commission: number; pot: number; insertedAny: boolean; csUnassigned: boolean }

async function accrueOneLandlord(
  l: { id: string; portfolio_manager_id: string | null; service_manager_id: string | null; referred_by_user_id: string | null; owner_upline_id: string | null; owner_upline_role: string | null; occupied: number },
  monthIso: string,
): Promise<AccrueOutcome> {
  const client: PoolClient = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`commission_accrual:${l.id}:${monthIso}`]
    )

    const round2 = (n: number) => Math.round(n * 100) / 100
    // Closer = the referring landlord (referral) OR the PM who closed it, falling
    // back to the OWNER's PERSON-level upline (S592) when the entity carries no
    // explicit attribution. The fallback is what makes the referral survive a
    // 1031 / new LLC and pays a co-owner's captured primary on their own account.
    const entityCloser = l.referred_by_user_id ?? l.portfolio_manager_id
    const closerId = entityCloser ?? l.owner_upline_id
    // A rep closer (portfolio_manager / admin) does their own CS (both halves). A
    // LANDLORD referrer cannot do platform CS, so CS breaks off to the assigned
    // service manager — the same as an organic self-closed landlord. For the
    // fallback closer, the upline's role decides.
    const REP_ROLES = ['portfolio_manager', 'admin', 'super_admin']
    const closerDoesCs =
      l.referred_by_user_id ? false
      : l.portfolio_manager_id ? true
      : l.owner_upline_id ? REP_ROLES.includes(l.owner_upline_role ?? '')
      : false
    const csManager = closerDoesCs ? closerId : l.service_manager_id

    // role → { manager, toPot }. Service NEVER pots. Closing pots only when
    // self-closed. Pot always pots. A service role with no beneficiary is
    // SKIPPED (never pot) and flagged for assignment.
    const specs: { role: string; manager: string | null; rate: number; toPot: boolean; skip?: boolean }[] = [
      { role: 'closing', manager: closerId,  rate: PORTFOLIO_COMMISSION.CLOSING,    toPot: closerId === null },
      { role: 'service', manager: csManager, rate: PORTFOLIO_COMMISSION.SERVICE,    toPot: false, skip: csManager === null },
      { role: 'pot',     manager: null,      rate: PORTFOLIO_COMMISSION.POT_ALWAYS, toPot: true },
    ]

    let commission = 0, pot = 0, insertedAny = false
    for (const s of specs) {
      if (s.skip) continue
      const amount = round2(l.occupied * s.rate)
      const r = await client.query(
        `INSERT INTO commission_accruals
           (accrual_month, landlord_id, role, manager_id, occupied_units, rate_per_unit, amount, to_pot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (landlord_id, accrual_month, role) DO NOTHING`,
        [monthIso, l.id, s.role, s.toPot ? null : s.manager, l.occupied, s.rate, amount, s.toPot]
      )
      if (r.rowCount && r.rowCount > 0) {
        insertedAny = true
        if (s.toPot) pot += amount; else commission += amount
      }
    }

    await client.query('COMMIT')
    return { commission: round2(commission), pot: round2(pot), insertedAny, csUnassigned: csManager === null }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
