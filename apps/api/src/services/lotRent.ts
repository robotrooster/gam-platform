// Lot-rent obligations (S568, Nic) — the investor-operator's expense to an
// EXTERNAL park (homes-only property). GAM tracks the monthly obligation + paid
// status (money moves off-platform, the park isn't on GAM) so the investor's net
// (tenant rent − lot rent) is real.
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'

/**
 * Accrue lot-rent obligations for the given month: one pending charge per unit
 * that has lot_rent_amount > 0 on a homes-only property. Idempotent via the
 * (unit_id, billing_month) unique — safe to re-run. The obligation exists per lot
 * the operator holds, occupied or not. Returns the count created.
 */
export async function accrueLotRentCharges(billingMonth: string): Promise<number> {
  const res = await query<{ id: string }>(
    `INSERT INTO lot_rent_charges (unit_id, property_id, landlord_id, billing_month, amount)
     SELECT u.id, u.property_id, u.landlord_id, $1::date, u.lot_rent_amount
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE p.operator_owns_land = FALSE
        AND u.lot_rent_amount > 0
     ON CONFLICT (unit_id, billing_month) DO NOTHING
     RETURNING id`,
    [billingMonth])
  return res.length
}

/** Mark a lot-rent charge paid (the operator paid the external park directly). */
export async function recordLotRentPaid(chargeId: string, landlordId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `UPDATE lot_rent_charges SET status='paid', paid_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND landlord_id=$2 AND status='pending' RETURNING id`,
    [chargeId, landlordId])
  if (!row) throw new AppError(404, 'Lot-rent charge not found, already paid, or not yours')
}

/**
 * Investor net / portfolio for a landlord's homes-only properties: per-home rent
 * (income) vs lot rent (expense) = net, plus per-property + grand totals and the
 * outstanding lot-rent obligation. Only homes-only properties appear.
 */
/**
 * S637: takes ONE entity id or the whole set the account owns — the read side of
 * "an account is not an entity" (S633). See routes/lotRent.ts for why.
 */
export async function getInvestorPortfolio(landlordId: string | string[]) {
  // One id or many — normalised once, so every query below binds the same shape.
  const ids = Array.isArray(landlordId) ? landlordId : [landlordId]

  const homes = await query<any>(
    `SELECT u.id AS unit_id, u.unit_number, u.rent_amount::float AS rent_amount,
            u.lot_rent_amount::float AS lot_rent_amount,
            (u.rent_amount - u.lot_rent_amount)::float AS net,
            u.status AS unit_status,
            p.id AS property_id, p.name AS property_name
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = ANY($1::uuid[]) AND p.operator_owns_land = FALSE
      ORDER BY p.name, u.unit_number`, [ids])

  const outstanding = await queryOne<{ pending_count: string; pending_amount: string }>(
    `SELECT COUNT(*)::text AS pending_count, COALESCE(SUM(amount),0)::text AS pending_amount
       FROM lot_rent_charges
      WHERE landlord_id = ANY($1::uuid[]) AND status = 'pending'`, [ids])

  const totals = homes.reduce((acc, h) => ({
    homes: acc.homes + 1,
    rent: acc.rent + Number(h.rent_amount || 0),
    lotRent: acc.lotRent + Number(h.lot_rent_amount || 0),
    net: acc.net + Number(h.net || 0),
  }), { homes: 0, rent: 0, lotRent: 0, net: 0 })

  return {
    homes,
    totals,
    outstandingLotRent: {
      count: Number(outstanding?.pending_count ?? 0),
      amount: Number(outstanding?.pending_amount ?? 0),
    },
  }
}
