/**
 * 10/12 (Nic): the admin Recurring Revenue card is the platform-fee bill for one
 * month, read from GAM's revenue book (platform_revenue_ledger), and nothing else.
 *
 * Nic: "our recurring revenue is showing $166 ... Mountain View and Oak Park
 * together was like $142. So we're billing Country Acres $24 ... is there only
 * 12 units there? ... as we bill for that month, so next month when it goes up,
 * I want to see what we billed."
 *
 * The $166 was right. October was billed Oak Park $48 (24 spaces), Mountain View
 * $94 (47 spaces: $88 on the 1st, then $2 and $4 for spaces filled on 10/5), and
 * Country Acres $24 (12 spaces with a lease, out of 30 live lots). What the card
 * could not do was say so: it printed "2026-10" and one total. This returns the
 * same total split by property, with the spaces each one was billed for and
 * what is still waiting to be collected, so the split never has to be worked
 * out by hand.
 *
 * WHICH MONTH A LINE BELONGS TO. A line written by the monthly run (or by the
 * month's minimum top-up) points at its accrual row, and the accrual row names
 * the month it bills — September's first bill was written on 9/19 and still
 * belongs to September. A nightly top-up line has no accrual id on it (each
 * raise gets its own key so it can never post twice); the nightly run only
 * ever bills the month that is running (jobs/platformFeeAccrual
 * processPlatformFeeTopUp names the month from the Phoenix clock, and the
 * scheduler passes the real clock), so its date names its month.
 *
 * WHAT IS NOT THE SUBSCRIPTION. The old screening sweep
 * (processScreeningFeeSweep) writes 'platform_fee_subscription' lines too, with
 * reference 'screening_fee_sweep'. It has never posted one, but the day it does
 * a background check would read as monthly recurring revenue. It is left out
 * here by its reference, and the money page files it under Background Checks.
 *
 * NOT COLLECTED YET. Every landlord-paid line has a matching charge in
 * landlord_gam_charges, which a payout nets (services/landlordGamAccount
 * netAgainstDisbursement). A charge still open is what the property owes; a
 * landlord with no payout bank linked has nothing to net it against yet, which
 * is why Country Acres' $24 was still open on 10/12. A tenant-paid fee is only
 * written to the book once the rent that carried it cleared, so it has no open
 * charge and reads as collected.
 */
import { query } from '../db'

/** The ledger references a subscription line can carry that are NOT the monthly bill. */
export const NOT_SUBSCRIPTION_REFERENCES = ['screening_fee_sweep'] as const

export interface BilledProperty {
  propertyId: string | null
  name: string
  /** Spaces the month was billed for (the accrual row's count, top-ups included). */
  spaces: number
  billed: number
  /** Of what was billed, what no payout has taken yet. */
  notCollected: number
  /** False when the landlord has no payout bank linked, so nothing can be netted. */
  payoutBankLinked: boolean
}

export interface PlatformFeeBill {
  /** 'YYYY-MM' of the month billed, or null when nothing has ever been billed. */
  month: string | null
  amount: number
  spaces: number
  notCollected: number
  byProperty: BilledProperty[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * The platform-fee lines of the revenue book, each with the month it bills.
 * Columns: id, amount, property_id, reference_id, reference_type, month.
 */
export const PLATFORM_FEE_LINES_SQL = `
  SELECT l.id, l.amount, COALESCE(l.property_id, a.property_id) AS property_id,
         l.reference_id, l.reference_type,
         to_char(COALESCE(a.accrual_month::timestamptz, l.created_at), 'YYYY-MM') AS month
    FROM platform_revenue_ledger l
    LEFT JOIN platform_fee_accruals a
           ON a.id = l.reference_id
          AND l.reference_type IN ('platform_fee_accrual', 'platform_fee_min_topup')
   WHERE l.type = 'platform_fee_subscription'
     AND (l.reference_type IS NULL
          OR l.reference_type <> ALL (ARRAY[${NOT_SUBSCRIPTION_REFERENCES.map(r => `'${r}'`).join(', ')}]::text[]))`

/**
 * The most recent month GAM billed a platform fee for, split by property.
 * `month` picks a month instead ('YYYY-MM').
 */
export async function platformFeeBill(month?: string): Promise<PlatformFeeBill> {
  const rows = await query<{
    month: string; property_id: string | null; name: string | null
    billed: string; not_collected: string; spaces: number | null; payout_bank_linked: boolean | null
  }>(`
    WITH fee AS (${PLATFORM_FEE_LINES_SQL}),
    pick AS (
      SELECT month FROM fee
       WHERE ($1::text IS NULL OR month = $1::text)
       GROUP BY month
       -- The latest month that billed something: on the 1st, before the 1:30 am
       -- run, the new month has nothing yet and must not read as a collapse.
      HAVING SUM(amount) > 0
       ORDER BY month DESC
       LIMIT 1
    ),
    lines AS (
      SELECT f.*,
             -- The charge each line raised, matched on the same keys the
             -- accrual and top-up runs wrote it under — one charge per line,
             -- so nothing is counted twice.
             (SELECT COALESCE(SUM(c.amount - c.collected_amount), 0)
                FROM landlord_gam_charges c
               WHERE c.kind = 'subscription'
                 AND c.source_id = f.reference_id
                 AND c.source_type = ANY (CASE f.reference_type
                       WHEN 'platform_fee_accrual' THEN ARRAY['platform_fee_accrual', 'platform_fee_topup']
                       ELSE ARRAY[f.reference_type] END)) AS not_collected
        FROM fee f JOIN pick ON pick.month = f.month
    )
    SELECT ln.month, ln.property_id, p.name,
           SUM(ln.amount)::text AS billed,
           SUM(ln.not_collected)::text AS not_collected,
           (SELECT SUM(a.total_billable)::int FROM platform_fee_accruals a
             WHERE a.property_id = ln.property_id
               AND a.accrual_month = (ln.month || '-01')::date) AS spaces,
           (SELECT COALESCE(ll.stripe_connect_account_id, u.stripe_connect_account_id) IS NOT NULL
              FROM landlords ll LEFT JOIN users u ON u.id = ll.user_id
             WHERE ll.id = p.landlord_id) AS payout_bank_linked
      FROM lines ln
      LEFT JOIN properties p ON p.id = ln.property_id
     GROUP BY ln.month, ln.property_id, p.name, p.landlord_id
     ORDER BY SUM(ln.amount) DESC, p.name`, [month ?? null])

  if (!rows.length) return { month: null, amount: 0, spaces: 0, notCollected: 0, byProperty: [] }
  const byProperty: BilledProperty[] = rows.map(r => ({
    propertyId: r.property_id,
    name: r.name ?? 'No property on the line',
    spaces: Number(r.spaces ?? 0),
    billed: r2(Number(r.billed)),
    notCollected: r2(Number(r.not_collected)),
    payoutBankLinked: r.payout_bank_linked !== false,
  }))
  return {
    month: rows[0].month,
    amount: r2(byProperty.reduce((n, p) => n + p.billed, 0)),
    spaces: byProperty.reduce((n, p) => n + p.spaces, 0),
    notCollected: r2(byProperty.reduce((n, p) => n + p.notCollected, 0)),
    byProperty,
  }
}
