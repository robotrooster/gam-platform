/**
 * S642 (Nic): ONE definition of "rent collected this month".
 *
 *   "There is a four hundred and sixty dollar discrepancy there… Collected this
 *    month needs to show any in-flight stuff. Those two cards need to match up."
 *
 * The admin overview counted settled + ACH-still-clearing; the landlord
 * dashboard and the Reports page counted settled only. The gap was one $460
 * ACH payment mid-flight — a mobile home whose tenant's bank had already been
 * debited. Two screens, both labelled "collected", disagreeing by a real
 * payment nobody could see.
 *
 * Money in flight is counted because the TENANT HAS SENT IT: Stripe holds an
 * ACH debit ~4 business days after the bank is debited, which spans exactly the
 * first week of the month when rent arrives. A "collected" figure that ignores
 * it reads near zero when the platform is busiest. Same reasoning the heartbeat
 * monitor has used since S616.
 *
 * It is returned SEPARATELY as well as in the total, so a screen can say how
 * much of the figure has not landed yet. Money a landlord is waiting on is a
 * different fact from money that has arrived.
 *
 * This lives in one file because the three call sites used to carry three
 * copies of the same SQL, and the comment above one of them claimed they
 * "reconcile … same SQL definitions". Identical strings in three files is how
 * definitions drift, not how they stay together.
 */
import { query } from '../db'

/** Rent the tenant has SENT — landed, or debited and still clearing. */
export const RENT_RECEIVED_STATUSES = ['settled', 'processing', 'paid_via_deposit'] as const

export interface RentCollected {
  /** Everything the tenant has sent this calendar month. */
  collected: number
  /** Of that, how much Stripe has not released yet. */
  inFlight: number
}

/**
 * @param landlordIds null/undefined = platform-wide (admin lens)
 * @param propertyId  optional single-property filter (landlord dashboard)
 */
export async function collectedRentMtd(
  landlordIds?: string[] | null,
  propertyId?: string | null,
): Promise<RentCollected> {
  const [row] = await query<{ collected: string; in_flight: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS collected,
            COALESCE(SUM(amount) FILTER (WHERE status = 'processing'), 0)::text AS in_flight
       FROM payments
      WHERE type = 'rent'
        AND status = ANY($1::text[])
        -- settled_at is null while a payment is still processing, so the month
        -- falls back to when it was created. Keying on settled_at alone drops
        -- in-flight money out of the window entirely.
        AND date_trunc('month', COALESCE(settled_at, created_at))
            = date_trunc('month', CURRENT_DATE)
        AND ($2::uuid[] IS NULL OR landlord_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR unit_id IN (SELECT id FROM units WHERE property_id = $3))`,
    [RENT_RECEIVED_STATUSES as unknown as string[], landlordIds ?? null, propertyId ?? null])
  return {
    collected: Math.round(parseFloat(row?.collected ?? '0') * 100) / 100,
    inFlight:  Math.round(parseFloat(row?.in_flight ?? '0') * 100) / 100,
  }
}
