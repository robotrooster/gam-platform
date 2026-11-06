/**
 * RECORDING INCOME THAT HAPPENED BEFORE THE OPERATOR JOINED GAM (11/1, Nic).
 *
 *   "We also need to have it not gated on leases, because income that happened
 *    for a property may not attach to a lease. If it's an RV park or a
 *    short-term stay situation, it needs to be this unit brought this much
 *    money, attributed to this person's contact information. To their customer,
 *    their GAM customer profile that we're making."
 *
 * The lease-gated path already exists (Payments → Import payment history) and
 * writes settled `payments` rows for residents. This is the other half: a space
 * earned money and the person who paid it never had a lease — an RV guest, a
 * weekly stay, a motel room. `payments` cannot hold that at all: it has no
 * column for a person who is not a tenant.
 *
 * WHAT THIS IS NOT, which is the load-bearing part (see the migration header
 * for why each one would be wrong):
 *   - never a charge: nobody owes it, it is money already received;
 *   - never in a balance, never collectible, never late-feeable;
 *   - never on GAM's own fee — it predates the account, and billing a
 *     subscription fee on pre-GAM income is exactly what writing these as
 *     reservations would have done (nights drive the fee);
 *   - never shown to the person it names (Nic: landlord and GAM only), because
 *     these figures are typed off an operator's old paper ledger.
 *
 * THE PERSON IS OPTIONAL AND THAT IS DELIBERATE. GAM's identity rule needs
 * three agreeing points to know somebody — a line reading only "Mike"
 * identifies nobody, and inventing a profile for it would manufacture a
 * stranger GAM thinks it knows (services/customerProfiles). An operator reading
 * a three-year-old sheet often has the space, the date and the amount but no
 * legible surname or phone. Refusing that row would lose real income over a
 * missing name, so the row is kept with whatever was written on the paper and
 * no profile attached. The space is what is required: it is the unit of
 * attribution Nic named.
 *
 * WHERE A PERSON *IS* IDENTIFIABLE, they become a `pos_customers` row for that
 * company and then go through `resolveProfile` exactly like a register customer
 * or a reservation guest — so the same three-point matching, the same refusal
 * to guess between two candidates, and the same one profile platform-wide. A
 * historical RV guest is a POS/stay customer; that is already the established
 * home for a non-tenant person, and 586 of the 652 profile links are that kind.
 */
import type { PoolClient } from 'pg'
import { randomUUID } from 'crypto'
import { AppError } from '../middleware/errorHandler'
import { resolveProfile } from './customerProfiles'
import { logger } from '../lib/logger'

/** What the import may call this money. Mirrors the table's CHECK. */
export const PRE_GAM_INCOME_TYPES = [
  'rent', 'fee', 'deposit', 'utility', 'late_fee', 'stay', 'other',
] as const
export type PreGamIncomeType = typeof PRE_GAM_INCOME_TYPES[number]

export interface PreGamIncomeRow {
  unitId: string
  occurredOn: string            // YYYY-MM-DD, the day the money arrived
  amount: number
  incomeType: PreGamIncomeType
  /** Whatever the operator wrote down. Kept verbatim even when no profile matches. */
  payerName?: string | null
  payerPhone?: string | null
  payerEmail?: string | null
  method?: string | null
  reference?: string | null
  notes?: string | null
}

export interface PreGamIncomeResult {
  recorded: number
  /** Rows that landed with a GAM customer attached. */
  withPerson: number
  /** Rows kept against the space alone, because the paper did not identify anybody. */
  withoutPerson: number
  /** People GAM had never seen before. */
  profilesCreated: number
  /** Rows refused, and why — never a silent drop. */
  refused: Array<{ row: number; why: string }>
  batchId: string
}

/** First + last out of one written name, the way a paper sheet gives it. */
function splitName(written: string | null | undefined): { firstName: string; lastName: string } {
  const s = (written ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return { firstName: '', lastName: '' }
  // "Smith, John" — the shape a ledger column usually takes.
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2).map(x => x.trim())
    return { firstName: first ?? '', lastName: last ?? '' }
  }
  const parts = s.split(' ')
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] }
}

/**
 * The person on a historical line, as a GAM customer — or null when the paper
 * does not identify anybody well enough to be sure, which is a normal outcome
 * and not an error.
 *
 * Ambiguity is NOT resolved by guessing: `resolveProfile` throws a 409 when two
 * different people both match on three points, because merging the wrong two
 * puts one person's money on another's account. Here that refusal is caught and
 * turned into "no person on this row" rather than failing the whole import —
 * the income is still the unit's, and a GAM admin can attach the person later.
 */
async function personFor(
  client: PoolClient, landlordId: string, row: PreGamIncomeRow,
): Promise<{ profileId: string | null; created: boolean }> {
  const { firstName, lastName } = splitName(row.payerName)
  if (!firstName && !lastName && !row.payerPhone && !row.payerEmail) {
    return { profileId: null, created: false }
  }
  // The person record a profile hangs off. Scoped to the company that earned
  // the money, like every other pos_customers row.
  //
  // FOUND BEFORE CREATED. The same guest appears on several lines of one sheet
  // — four weekly payments is four rows — and `pos_customers` is unique on
  // (landlord_id, lower(email)) for exactly this reason. Creating blindly threw
  // on the second line and took the whole file down with it. Matched on email
  // first (the unique key), then phone, which is the stronger of the two for a
  // park where several people share an address but not a number.
  const email = (row.payerEmail ?? '').trim()
  const phone = (row.payerPhone ?? '').trim()
  const found = (await client.query<{ id: string }>(
    `SELECT id FROM pos_customers
      WHERE landlord_id = $1 AND archived_at IS NULL
        AND ( ($2 <> '' AND lower(email) = lower($2))
           OR ($2 =  '' AND $3 <> '' AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g')
                                       = regexp_replace($3, '\\D', '', 'g')) )
      ORDER BY created_at
      LIMIT 1`,
    [landlordId, email, phone])).rows[0]

  const customerId = found?.id ?? (await client.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, created_from, notes)
     VALUES ($1, $2, $3, NULLIF($4,''), NULLIF($5,''), 'import',
             'Created from imported pre-GAM income history')
     RETURNING id`,
    [landlordId, firstName, lastName, email, phone]
  )).rows[0].id

  try {
    const got = await resolveProfile(
      client as any,
      { firstName, lastName, phone: row.payerPhone ?? undefined, email: row.payerEmail ?? undefined },
      { kind: 'pos_customer', refId: customerId, landlordId },
    )
    // null = fewer than three points, so GAM does not claim to know who this
    // is. The pos_customers row stays (it is what the operator wrote) and the
    // income records against the space.
    if (!got) return { profileId: null, created: false }
    return { profileId: got.profileId, created: got.created }
  } catch (e) {
    if (e instanceof AppError && e.statusCode === 409) {
      logger.warn({ landlordId, customerId },
        '[pre-gam-income] the payer matches two GAM customers on three points — recorded against the space, no person attached')
      return { profileId: null, created: false }
    }
    throw e
  }
}

/**
 * Write a batch of historical income. Runs INSIDE the caller's transaction, so
 * a file either lands whole or not at all.
 *
 * `batchId` ties the whole file together: one id per import, so a file typed
 * wrong is voided in a single statement instead of hunted row by row.
 *
 * Idempotent against the same row twice in one batch (a unique index on batch +
 * space + day + amount + type) — the same line twice in one file is a
 * double-count of real money, and that is the one thing an income import must
 * never do.
 */
export async function recordPreGamIncome(
  client: PoolClient,
  args: {
    landlordId: string
    byUserId: string
    importSource: string
    rows: PreGamIncomeRow[]
    batchId?: string
  },
): Promise<PreGamIncomeResult> {
  const batchId = args.batchId ?? randomUUID()
  const out: PreGamIncomeResult = {
    recorded: 0, withPerson: 0, withoutPerson: 0, profilesCreated: 0, refused: [], batchId,
  }

  for (let i = 0; i < args.rows.length; i++) {
    const row = args.rows[i]
    const rowNo = i + 1
    if (!row.unitId) { out.refused.push({ row: rowNo, why: 'No space on the line — income has to be attributed to a space' }); continue }
    if (!(row.amount > 0)) { out.refused.push({ row: rowNo, why: 'The amount has to be more than zero' }); continue }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.occurredOn)) { out.refused.push({ row: rowNo, why: 'The date is not a date' }); continue }
    if (!PRE_GAM_INCOME_TYPES.includes(row.incomeType)) {
      out.refused.push({ row: rowNo, why: `"${row.incomeType}" is not a kind of income GAM records` }); continue
    }

    // The space has to belong to the company whose history this is. Without
    // this a file could post another operator's unit as this one's income.
    const unit = (await client.query<{ id: string }>(
      `SELECT u.id FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1 AND p.landlord_id = $2`, [row.unitId, args.landlordId])).rows[0]
    if (!unit) { out.refused.push({ row: rowNo, why: 'That space does not belong to this company' }); continue }

    const person = await personFor(client, args.landlordId, row)
    if (person.created) out.profilesCreated++

    const done = await client.query(
      `INSERT INTO pre_gam_income_history (
         landlord_id, unit_id, customer_profile_id,
         payer_name, payer_phone, payer_email,
         occurred_on, amount, income_type, method, reference, notes,
         import_source, import_batch_id, imported_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (import_batch_id, unit_id, occurred_on, amount, income_type)
         WHERE voided_at IS NULL
         DO NOTHING
       RETURNING id`,
      [args.landlordId, row.unitId, person.profileId,
       (row.payerName ?? '').trim() || null, (row.payerPhone ?? '').trim() || null,
       (row.payerEmail ?? '').trim() || null,
       row.occurredOn, row.amount.toFixed(2), row.incomeType,
       (row.method ?? '').trim() || null, (row.reference ?? '').trim() || null,
       (row.notes ?? '').trim() || null,
       args.importSource, batchId, args.byUserId])

    if (done.rowCount === 0) {
      out.refused.push({ row: rowNo, why: 'The same space, day, amount and kind is already on this import — not counted twice' })
      continue
    }
    out.recorded++
    if (person.profileId) out.withPerson++
    else out.withoutPerson++
  }

  logger.info({ landlordId: args.landlordId, ...out, refused: out.refused.length },
    '[pre-gam-income] historical income recorded')
  return out
}

/** Why a whole import was taken back out. */
export const PRE_GAM_BATCH_VOID_REASON = (why: string) =>
  `The import this came in on was taken back out: ${why}`

/**
 * Undo a whole import. Keep-everything: the rows are voided with their reason,
 * never deleted, so what was claimed and that it was withdrawn both stay on
 * record. Returns how many came off.
 */
export async function voidPreGamIncomeBatch(
  client: PoolClient,
  args: { landlordId: string; batchId: string; why: string },
): Promise<{ voided: number; amount: number }> {
  const r = await client.query<{ amount: string }>(
    `UPDATE pre_gam_income_history
        SET voided_at = NOW(), void_reason = $3, updated_at = NOW()
      WHERE import_batch_id = $2 AND landlord_id = $1 AND voided_at IS NULL
      RETURNING amount::text AS amount`,
    [args.landlordId, args.batchId, PRE_GAM_BATCH_VOID_REASON(args.why)])
  const amount = r.rows.reduce((s, x) => s + Number(x.amount), 0)
  logger.info({ ...args, voided: r.rowCount, amount }, '[pre-gam-income] an import was taken back out')
  return { voided: r.rowCount ?? 0, amount }
}

/**
 * What a company earned before GAM, by month and by space — the shape a report
 * or the books needs. Voided rows are never counted, like every other total.
 */
export async function preGamIncomeSummary(
  q: { query: PoolClient['query'] },
  args: { landlordId: string; from?: string | null; to?: string | null },
): Promise<Array<{ month: string; unitNumber: string; propertyName: string; incomeType: string; total: number; rows: number }>> {
  const r = await q.query<any>(
    `SELECT to_char(date_trunc('month', h.occurred_on), 'YYYY-MM') AS month,
            u.unit_number AS unit_number, p.name AS property_name,
            h.income_type, SUM(h.amount)::text AS total, COUNT(*)::int AS rows
       FROM pre_gam_income_history h
       JOIN units u ON u.id = h.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE h.landlord_id = $1 AND h.voided_at IS NULL
        AND ($2::date IS NULL OR h.occurred_on >= $2::date)
        AND ($3::date IS NULL OR h.occurred_on <= $3::date)
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 DESC, 3, 2, 4`,
    [args.landlordId, args.from ?? null, args.to ?? null])
  return r.rows.map((x: any) => ({
    month: x.month, unitNumber: x.unit_number, propertyName: x.property_name,
    incomeType: x.income_type, total: Number(x.total), rows: x.rows,
  }))
}
