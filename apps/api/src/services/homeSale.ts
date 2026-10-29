// Financed home/RV sale (S568, Nic). A landlord sells a park-owned home to a
// tenant who pays it off over N years at a set interest rate — SEPARATE from
// space rent. The amortized installment is billed each cycle as a
// type='home_payment' row (routes to the landlord like rent, rides the invoice),
// auto-stops at term, and on payoff the unit flips landlord-owned → tenant-owned.
//
// Money flow: home_payment settles through the same platform-holds batch as rent
// (platform_held), so no new rail. It is intentionally NOT type='rent' (that
// would collide with the rent idempotency unique + trigger rent late-fee/eviction
// logic that must not apply to a purchase installment).
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { todayIn, addDaysTo, monthStartOf } from '../lib/timezone'
import { lockHousehold } from './moneyPredicates'
import { allocateInvoiceNumber } from './invoiceNumbers'
import { computeAmortization } from '@gam/shared'
import { z } from 'zod'

type Client = PoolClient

export interface CreateHomeSaleInput {
  /**
   * S629: hold the terms with no schedule and nothing billed until the
   * agreement is signed. 10/12 (Nic): the LANDLORD's signature is the one that
   * starts the billing (activateHomeSaleContract), not the buyer's.
   */
  pendingSignature?: boolean
  unitId: string
  /**
   * S651 — OPTIONAL, and that is the point.
   *
   * This used to be required as "the billing anchor". Nic: "we can't do the
   * contract sales tied to a lease... I know a guy that owns over a hundred
   * homes throughout various parks without actually owning any parks. He's not
   * going to have a lease. The ownership of the trailer has nothing to do with
   * who's actually living in the trailer."
   *
   * He is right, and the coupling was wrong in both directions: a buyer may
   * own a home they do not live in, and a tenant may live in a home somebody
   * else is buying. One tenant can sell their home to another, who then
   * subleases it on. So a sale stands on its own, and a lease — when there is
   * one — is recorded for context, not required for the sale to exist.
   *
   * `home_sale_contracts.lease_id` and `payments.lease_id` were both already
   * nullable; only this type and the route insisted. A home-sale installment
   * bills as a standalone `home_payment`, which has its own settlement path and
   * is excluded from rent allocation, so it never needed a lease to bill.
   */
  leaseId?: string | null
  tenantId: string
  landlordId: string
  salePrice: number
  downPayment: number
  annualInterestRate: number  // percent, e.g. 7.5
  termMonths: number
  startMonth: string          // 'YYYY-MM-01'
  planType?: 'amortized' | 'flat'  // S594: how the deal is shaped (default amortized)
}

/**
 * Create a financing contract + its precomputed amortization schedule.
 * Enforces one ACTIVE contract per unit (partial unique index also guards).
 */
export async function createHomeSaleContract(client: Client, input: CreateHomeSaleInput) {
  const financed = Math.round((input.salePrice - input.downPayment) * 100) / 100
  if (financed < 0) throw new AppError(400, 'Down payment cannot exceed the sale price.')
  if (input.termMonths <= 0 || input.termMonths > 600) throw new AppError(400, 'Term must be between 1 and 600 months.')

  const existing = await client.query(
    `SELECT id, status FROM home_sale_contracts
      WHERE unit_id=$1 AND status IN ('active','pending_signature') LIMIT 1`, [input.unitId])
  if (existing.rows.length) {
    throw new AppError(409, existing.rows[0].status === 'pending_signature'
      ? 'This unit already has a purchase agreement out for signature. Cancel it before starting another.'
      : 'This unit already has an active home-sale contract.')
  }

  const { monthlyPayment, schedule } = computeAmortization(financed, input.annualInterestRate, input.termMonths)

  // S629: `pendingSignature` holds the agreed terms WITHOUT generating a
  // schedule, so nothing bills until the purchase agreement is signed. 10/12
  // (Nic): signed by the LANDLORD — the same rule the leases follow since S647.
  // The signed document is the authority, and money only moves behind one.
  const status = input.pendingSignature ? 'pending_signature' : 'active'

  const contract = (await client.query<any>(
    `INSERT INTO home_sale_contracts
       (unit_id, lease_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
        annual_interest_rate, term_months, monthly_payment, start_month, installments_total, plan_type,
        status, activated_at)
     -- 10/12 (Nic, ledger P1): a sale written active is active from now
     -- (activated_at); one awaiting signature gets it when the landlord signs.
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             CASE WHEN $14 = 'active' THEN NOW() END)
     RETURNING *`,
    [input.unitId, input.leaseId ?? null, input.tenantId, input.landlordId, input.salePrice.toFixed(2),
     input.downPayment.toFixed(2), financed.toFixed(2), input.annualInterestRate, input.termMonths,
     monthlyPayment.toFixed(2), input.startMonth, schedule.length, input.planType ?? 'amortized',
     status])).rows[0]

  // A contract awaiting signature has agreed terms and no schedule. The
  // schedule is written by activateHomeSaleContract when the landlord signs
  // the agreement (10/12) — writing it now would put installments in the
  // billing tables for paper nobody has signed.
  if (status === 'pending_signature') return contract

  // Precompute the billing month per installment (start_month + (n-1) months).
  for (const row of schedule) {
    await client.query(
      `INSERT INTO home_sale_installments
         (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
       VALUES ($1,$2, ($3::date + ($4::int || ' months')::interval)::date, $5,$6,$7,$8)`,
      [contract.id, row.installmentNumber, input.startMonth, row.installmentNumber - 1,
       row.amount.toFixed(2), row.principalPortion.toFixed(2), row.interestPortion.toFixed(2),
       row.remainingBalance.toFixed(2)])
  }
  return contract
}

/**
 * 10/12 (Nic) — THE LANDLORD'S SIGNATURE STARTS THE BILLING.
 *
 *   "We need people to be billed correctly regardless of signing status."
 *
 * S629 made the purchase agreement's COMPLETION start a home sale billing, so
 * it waited on the buyer. Country Acres MH 18 and MH 24 are what that cost: the
 * landlord signed both installment contracts on 9/22, the buyers had not, and
 * their October bills went out with rent and water and no home payment. A
 * lease has billed on the landlord's signature since S647 ("Bill it out to
 * everybody upon my signature"); a home sale now does the same. Called from his
 * signature on the purchase agreement (routes/esign.ts), and again when the
 * document completes, where it finds nothing left to do.
 *
 * Writes the amortization schedule and makes the contract active, then puts
 * each installment already due onto the buyer's open bill for its month
 * (attachDueInstallmentsToOpenInvoices). Installments before the property's
 * first billing cycle were paid outside GAM and are stamped so. Months still
 * to come bill in their own month, never early — the rule a lease follows.
 *
 * Idempotent: the e-sign paths that call it are best-effort and post-commit,
 * so it can be retried, and a contract already active must not have a second
 * schedule written under it.
 */
export async function activateHomeSaleContract(documentId: string): Promise<{ activated: boolean }> {
  const client = await getClient()
  let written: { contractId: string; installments: number } | null = null
  try {
    await client.query('BEGIN')
    written = await writeScheduleAndActivate(client, documentId)
    await client.query(written ? 'COMMIT' : 'ROLLBACK')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
  if (!written) return { activated: false }

  logger.info({ contractId: written.contractId, documentId, installments: written.installments },
    'home sale: purchase agreement signed — billing schedule created')
  // S654 (Nic, Shane Rueff MH 11): "if he signs today and the bill was
  // generated yesterday, that $150 needs to go on this month's bill as well
  // after he signs." Best-effort after the commit: the signature and the
  // schedule stand even if this fails, and the monthly run still picks the
  // installment up as a straggler.
  await attachDueInstallmentsToOpenInvoices(written.contractId).catch(err =>
    logger.error({ err, contractId: written!.contractId }, 'home sale: could not put due installments on the open bill'))
  return { activated: true }
}

/** One installment put on a bill, as the attach and the 10/12 script report it. */
export type AttachedInstallment = { installmentNumber: number; amount: number; invoiceId: string; dueDate: string }

/** What activating one contract did, inside the caller's transaction. */
export interface ActivationReport {
  contractId: string
  installmentsCreated: number
  stampedOffPlatform: number
  attached: AttachedInstallment[]
}

/**
 * activateHomeSaleContract on a transaction the CALLER owns: the schedule, the
 * stamps for months paid outside GAM, and the lines on open bills, all on
 * `client`, so a dry run can roll every bit of it back (the 10/12 one-time
 * script). Null when the document has no contract waiting to start.
 */
export async function activateHomeSaleContractIn(client: Client, documentId: string): Promise<ActivationReport | null> {
  // 10/12: the buyer's household before the contract's row lock — the order a
  // void takes them in (lib/voidDocument). Here both are held in one
  // transaction, and the other order could deadlock against a void.
  const who = (await client.query<{ tenant_id: string; landlord_id: string }>(
    `SELECT tenant_id, landlord_id FROM home_sale_contracts
      WHERE purchase_document_id = $1 AND status = 'pending_signature'`, [documentId])).rows[0]
  if (!who) return null
  await lockHousehold(client, who.tenant_id, who.landlord_id)
  const written = await writeScheduleAndActivate(client, documentId)
  if (!written) return null
  const r = await attachDueInstallmentsIn(client, written.contractId)
  return { contractId: written.contractId, installmentsCreated: written.installments,
           stampedOffPlatform: r.stampedOffPlatform, attached: r.attached }
}

/** The schedule and the flip to active, on the caller's transaction. */
async function writeScheduleAndActivate(
  client: Client, documentId: string,
): Promise<{ contractId: string; installments: number } | null> {
  const c = (await client.query<any>(
    `SELECT * FROM home_sale_contracts
      WHERE purchase_document_id = $1 AND status = 'pending_signature'
      FOR UPDATE`, [documentId])).rows[0]
  if (!c) return null

  const financed = Number(c.financed_amount)
  const { schedule } = computeAmortization(financed, Number(c.annual_interest_rate), c.term_months)

  for (const row of schedule) {
    await client.query(
      `INSERT INTO home_sale_installments
         (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
       VALUES ($1,$2, ($3::date + ($4::int || ' months')::interval)::date, $5,$6,$7,$8)`,
      [c.id, row.installmentNumber, c.start_month, row.installmentNumber - 1,
       row.amount.toFixed(2), row.principalPortion.toFixed(2), row.interestPortion.toFixed(2),
       row.remainingBalance.toFixed(2)])
  }
  // 10/12 (Nic, ledger P1): the day it went active is stored (activated_at) —
  // the ledger dates the sale from it and reads it against the books' start.
  await client.query(
    `UPDATE home_sale_contracts SET status='active', activated_at = COALESCE(activated_at, NOW()), updated_at=NOW()
      WHERE id=$1`, [c.id])
  return { contractId: c.id, installments: schedule.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10/12 (Nic): A SALE THE LANDLORD SIGNED THAT DID NOT START IS TRIED AGAIN
// EVERY MORNING.
//
// His signature starts a home sale billing — routes/esign.ts calls
// activateHomeSaleContract right after it. That call is best-effort, after the
// signature is committed: when it fails, the sale sits 'pending_signature' and
// bills nothing until the buyer signs (MH 18 and MH 24 all over again). Asked
// what should happen then, Nic: "Retry every morning." So the daily home-sale
// run (billDueHomeSaleInstallments, 04:20 Phoenix) first starts every such
// sale, with the same steps the 10/12 one-time script used
// (scripts/oct12_activate_landlord_signed_home_sales.ts calls
// startLandlordSignedSaleIn too). The landlord is told either way: the morning
// it starts, and — once — the morning it could not.
// ─────────────────────────────────────────────────────────────────────────────

/** A sale whose agreement the landlord signed and that is still waiting to start. */
export interface LandlordSignedSaleWaiting {
  contract_id: string
  document_id: string
  property_id: string
  property: string
  unit: string
  tenant_id: string
  landlord_id: string
  /** The day the landlord signed, in the property's calendar ('YYYY-MM-DD'); null if not stamped. */
  landlord_signed_on: string | null
}

/**
 * Every sale the landlord has signed that is still 'pending_signature': its
 * agreement is neither voided nor failed, and a landlord signer has signed it.
 * `q` is a client inside a transaction, or db's `query`.
 *
 * `signedMinutesAgo` (the morning retry): only a signature at least that old.
 * 10/12: the signature commits before its own path records the typed terms and
 * starts the sale (routes/esign.ts), so a retry landing in that gap saw a
 * signed sale "not started", told the landlord and raised a critical alert
 * seconds before the signature started it — and that alert then stood in for
 * any real one on the agreement. `documentId`: just that agreement's sale.
 */
export async function landlordSignedSalesWaiting(
  q: { query: Function },
  o: { signedMinutesAgo?: number; documentId?: string } = {},
): Promise<LandlordSignedSaleWaiting[]> {
  const params: unknown[] = []
  const signedBefore = o.signedMinutesAgo != null
    ? `AND (s.signed_at IS NULL OR s.signed_at < NOW() - make_interval(mins => $${params.push(o.signedMinutesAgo)}::int))` : ''
  const onlyDoc = o.documentId != null ? `AND d.id = $${params.push(o.documentId)}::uuid` : ''
  return rowsFrom(q,
    `SELECT c.id AS contract_id, c.purchase_document_id AS document_id, p.id AS property_id,
            p.name AS property, u.unit_number AS unit, c.tenant_id, c.landlord_id,
            ls.signed_on AS landlord_signed_on
       FROM home_sale_contracts c
       JOIN lease_documents d ON d.id = c.purchase_document_id
       JOIN units u ON u.id = c.unit_id
       JOIN properties p ON p.id = u.property_id
       CROSS JOIN LATERAL (
         SELECT COUNT(*) AS n,
                (MIN(s.signed_at) AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date::text AS signed_on
           FROM lease_document_signers s
          WHERE s.document_id = d.id AND s.role = 'landlord' AND s.status = 'signed' ${signedBefore}
       ) ls
      WHERE c.status = 'pending_signature'
        AND d.status NOT IN ('voided', 'execution_failed')
        AND ls.n > 0
        ${onlyDoc}
      ORDER BY p.name, u.unit_number`, params)
}

/**
 * What starting one waiting sale did. Only 'started' changed anything.
 *   buyer_signs     — the buyer belongs to another company, so their own
 *                     signature starts it (S655). Expected; not a failure.
 *   nothing_waiting — another path started it first (the buyer signed).
 *   terms           — the terms typed on the agreement cannot be read, or are
 *                     not the sale on file. Never billed on the wrong terms.
 */
export type SaleStartOutcome =
  | { started: ActivationReport }
  | { skipped: 'buyer_signs' | 'nothing_waiting' | 'terms'; why: string }

/**
 * Start one landlord-signed sale on the caller's transaction (the 10/12 script
 * rolls a dry run back; the morning retry commits each sale on its own).
 * The steps the landlord's signature takes (routes/esign.ts), after its terms
 * were recorded: the buyer of another company waits for their own signature,
 * then activateHomeSaleContractIn writes the schedule, stamps the months paid
 * outside GAM and puts what is due on the buyer's open bill. Idempotent: a
 * sale already started is found by nothing here (activation reads only
 * 'pending_signature' contracts, under the contract's row lock).
 */
export async function startLandlordSignedSaleIn(client: Client, w: LandlordSignedSaleWaiting): Promise<SaleStartOutcome> {
  // Imported here: newLeaseInvite pulls in half the e-sign stack.
  const { tenantsNeedingOwnSignature } = await import('./newLeaseInvite')
  if ((await tenantsNeedingOwnSignature(w.document_id)).length > 0) {
    return { skipped: 'buyer_signs', why: 'the buyer belongs to another company — their own signature starts it (S655)' }
  }
  const disagreement = await paperDisagreesWithSale(client, w.document_id, w.contract_id)
  if (disagreement) return { skipped: 'terms', why: disagreement }
  const r = await activateHomeSaleContractIn(client, w.document_id)
  if (!r) return { skipped: 'nothing_waiting', why: 'nothing waiting on this agreement' }
  return { started: r }
}

/** The sale terms the landlord types on an agreement (the rest are printed from the record). */
const TYPED_SALE_COLUMNS = [
  'sale_price', 'sale_down_payment', 'sale_monthly_payment', 'sale_term_months',
  'sale_interest_rate', 'sale_first_payment_month',
]

/**
 * S652 (Nic): "the paper is the record". On his signature the typed terms
 * become the sale (applySaleTermsFromDocument) and only then does it start. If
 * that recording failed, the contract still waiting under the agreement holds
 * the terms it was drafted with — which he may have typed over. Starting it
 * then would bill numbers nobody signed, so a sale whose agreement carries
 * typed terms starts only when they are the sale on file (the same comparison
 * the recording makes to keep a record). An agreement with no typed terms
 * leaves the contract's own. Read-only. Null = fine to start; else why not.
 */
async function paperDisagreesWithSale(client: Client, documentId: string, contractId: string): Promise<string | null> {
  const fields = await saleFieldsOn(client, documentId)
  if (!carriesTypedSaleTerms(fields)) return null
  const k = (await client.query<SaleTermsOnFile & { timezone: string | null }>(
    `SELECT c.sale_price, c.down_payment, c.annual_interest_rate, c.term_months,
            to_char(c.start_month, 'YYYY-MM-DD') AS start_month, p.timezone
       FROM home_sale_contracts c
       JOIN units u ON u.id = c.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE c.id = $1`, [contractId])).rows[0]
  if (!k) return null
  const onPaper = saleTermsFromFields(fields)
  let terms: ReturnType<typeof resolveTypedSaleTerms>
  try {
    terms = resolveTypedSaleTerms(onPaper, k.timezone)
  } catch (e) {
    return `the terms typed on the agreement cannot be read (${e instanceof Error ? e.message : String(e)})`
  }
  // A blank first-payment month is "next month" from the day it is read, so a
  // later morning would read a different month. The record holds the one
  // worked out when he signed.
  if (!onPaper.startMonth) terms = { ...terms, startMonth: k.start_month }
  return sameSaleTerms(k, terms) ? null : 'the terms typed on the agreement are not the sale on file'
}

/** The sale_* fields on an agreement. */
async function saleFieldsOn(q: { query: Function }, documentId: string): Promise<Array<{ lease_column: string | null; value: string | null }>> {
  return rowsFrom(q,
    `SELECT lease_column, value FROM lease_document_fields
      WHERE document_id = $1 AND lease_column LIKE 'sale_%'`, [documentId])
}

/** Did the landlord type any sale terms on the agreement? (None typed: the contract's own terms stand.) */
function carriesTypedSaleTerms(fields: Array<{ lease_column: string | null; value: string | null }>): boolean {
  return fields.some(f => f.lease_column != null && TYPED_SALE_COLUMNS.includes(f.lease_column)
                          && f.value != null && String(f.value).trim() !== '')
}

/** A sale's agreed terms as stored (numerics as pg returns them, start month as 'YYYY-MM-DD'). */
type SaleTermsOnFile = {
  sale_price: string | number; down_payment: string | number; annual_interest_rate: string | number
  term_months: string | number; start_month: string
}

/** Do the stored terms say what the typed ones do? (applySaleTermsFromDocument keeps a record only when they do.) */
function sameSaleTerms(onFile: SaleTermsOnFile, t: { salePrice: number; downPayment: number; annualInterestRate: number; termMonths: number; startMonth: string }): boolean {
  return Number(onFile.sale_price) === t.salePrice && Number(onFile.down_payment) === t.downPayment
    && Number(onFile.annual_interest_rate) === t.annualInterestRate && Number(onFile.term_months) === t.termMonths
    && String(onFile.start_month).slice(0, 10) === t.startMonth
}

/** How old a landlord signature must be before the morning retry touches its sale (see landlordSignedSalesWaiting). */
const RETRY_SIGNED_MINUTES_AGO = 15

/**
 * The morning retry: start every landlord-signed sale still waiting, each in
 * its own transaction so one that fails leaves the rest to start. Called by
 * the daily home-sale run before it bills. Never throws for one sale.
 *
 * 10/12: it retries the WHOLE signature step, recording the typed terms first
 * (applySaleTermsFromDocument), not only the start. When the recording is what
 * failed on his signature, the contract still holds the drafted terms; a retry
 * of the start alone found the paper disagreeing with them, told everyone once
 * and skipped the sale every morning after — and he cannot change a paper he
 * has signed. The recording is safe to repeat: it does nothing for a started
 * sale and keeps a record that already matches. A blank first-payment month
 * still means the month after the day he SIGNED, not after this morning.
 */
export async function retryLandlordSignedHomeSaleStarts(): Promise<{ started: number; notStarted: number }> {
  const waiting = await landlordSignedSalesWaiting({ query }, { signedMinutesAgo: RETRY_SIGNED_MINUTES_AGO })
  let started = 0
  let notStarted = 0
  for (const signed of waiting) {
    let w: LandlordSignedSaleWaiting | undefined = signed
    let outcome: SaleStartOutcome | null = null
    let error: string | null = null
    try {
      // An agreement with no typed terms keeps the contract's own (as
      // paperDisagreesWithSale does): there is nothing to record.
      if (carriesTypedSaleTerms(await saleFieldsOn({ query }, signed.document_id))) {
        await applySaleTermsFromDocument(signed.document_id, { asOf: signed.landlord_signed_on })
        // Recording the typed terms writes a new contract when they differ
        // from the drafted one (its id changes): read the waiting sale again.
        w = (await landlordSignedSalesWaiting({ query }, { documentId: signed.document_id }))[0]
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      logger.error({ err: e, contractId: signed.contract_id, documentId: signed.document_id },
        'home sale: the morning retry could not record the terms typed on a landlord-signed agreement')
    }
    if (!w) continue   // started meanwhile (the buyer signed): nothing to do, nobody to tell
    if (!error) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        outcome = await startLandlordSignedSaleIn(client, w)
        await client.query('started' in outcome ? 'COMMIT' : 'ROLLBACK')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        error = e instanceof Error ? e.message : String(e)
        logger.error({ err: e, contractId: w.contract_id, documentId: w.document_id },
          'home sale: the morning retry could not start a landlord-signed sale')
      } finally { client.release() }
    }

    try {
      if (outcome && 'started' in outcome) {
        started++
        logger.info({ contractId: w.contract_id, documentId: w.document_id, attached: outcome.started.attached.length },
          'home sale: started by the morning retry (it did not start on the landlord\'s signature)')
        // 10/6 (Nic): money the buyer paid ahead goes on the balance the
        // home payment just joined, as the signature path does. Never throws.
        if (outcome.started.attached.length) {
          const { runWholeBillCheckAfterCommit } = await import('./creditUse')
          await runWholeBillCheckAfterCommit({ tenantId: w.tenant_id, landlordId: w.landlord_id })
        }
        await tellLandlordSaleStarted(w, outcome.started)
        continue
      }
      // Waiting on the buyer of another company, or already started by the
      // buyer's signature: nothing went wrong, nobody is told.
      if (outcome && outcome.skipped !== 'terms') continue
      notStarted++
      await tellOnceSaleNotStarted(w, outcome ? 'terms' : 'error', outcome?.why ?? error ?? 'unknown error')
    } catch (e) {
      logger.error({ err: e, contractId: w.contract_id }, 'home sale: telling the landlord about the morning retry failed')
    }
  }
  if (started || notStarted) logger.info({ started, notStarted }, '[home-sale-start-retry]')
  return { started, notStarted }
}

/** The people who run the property — the landlord's side of a notice (S183 resolver). */
async function propertyContacts(propertyId: string): Promise<Array<{ user_id: string; email: string }>> {
  const { getPropertyResponsibleParty } = await import('./responsibleParty')
  const rp = await getPropertyResponsibleParty(propertyId)
  return rp ? (rp.primaries.length ? rp.primaries : [rp.owner]) : []
}

async function tellLandlordSaleStarted(w: LandlordSignedSaleWaiting, r: ActivationReport): Promise<void> {
  const { createNotification, emailTemplate } = await import('./notifications')
  const { portalLink } = await import('../lib/portalUrls')
  const where = `${w.unit} at ${w.property}`
  const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const added = r.attached.map(a =>
    `home payment ${a.installmentNumber} ($${a.amount.toFixed(2)}) on the buyer's bill due ${day(a.dueDate)}`)
  const lines = added.length
    ? `It put ${added.join(' and ')}.`
    : `Each home payment goes on the buyer's bill in its month.`
  const body = `The installment contract you signed for ${where} did not start billing when you signed it. GAM started it this morning. ${lines}`
  for (const contact of await propertyContacts(w.property_id)) {
    await createNotification({
      userId: contact.user_id, landlordId: w.landlord_id,
      type: 'home_sale_started',
      title: `Home payments started — ${where}`,
      body,
      data: { documentId: w.document_id, contractId: w.contract_id },
      actionUrl: '/esign',
      sendEmail: true, emailTo: contact.email,
      emailHtml: emailTemplate(escapeHtml(`Home payments started — ${where}`), `<p>${escapeHtml(body)}</p>`,
        { label: 'Open documents', url: portalLink('landlord', 'esign') }),
    })
  }
}

/**
 * Told once per agreement, not every morning (one email per thing): the first
 * morning it could not start, the landlord and GAM's admins hear why; later
 * mornings keep trying quietly. The admin record is the "already told" mark —
 * it is written whatever anyone's notification settings are, and it is kept
 * (moved to the archive, never deleted).
 */
async function tellOnceSaleNotStarted(w: LandlordSignedSaleWaiting, kind: 'terms' | 'error', why: string): Promise<void> {
  const told = await query(
    `SELECT 1 FROM admin_notifications
      WHERE category = 'home_sale_start_retry_failed' AND context->>'document_id' = $1
     UNION ALL
     SELECT 1 FROM admin_notifications_archive
      WHERE category = 'home_sale_start_retry_failed' AND context->>'document_id' = $1
     LIMIT 1`, [w.document_id])
  if (told.length) return
  const { createAdminNotification } = await import('./adminNotifications')
  await createAdminNotification({
    severity: 'critical',
    category: 'home_sale_start_retry_failed',
    title: `Home-sale billing still not started for ${w.property} ${w.unit} (agreement ${w.document_id})`,
    body: `The landlord signed the installment contract; the sale has not started billing. The morning run keeps trying. ${why}`,
    context: { document_id: w.document_id, contract_id: w.contract_id, kind },
  })
  const { createNotification, emailTemplate } = await import('./notifications')
  const { portalLink } = await import('../lib/portalUrls')
  const where = `${w.unit} at ${w.property}`
  const body = kind === 'terms'
    ? `The installment contract you signed for ${where} has not started billing: the payment terms typed on it do not match the sale on file, so no home payments go on the buyer's bills until that is fixed. GAM support has been told.`
    : `The installment contract you signed for ${where} has not started billing, so no home payments are going on the buyer's bills yet. GAM tries again every morning, and GAM support has been told.`
  for (const contact of await propertyContacts(w.property_id)) {
    await createNotification({
      userId: contact.user_id, landlordId: w.landlord_id,
      type: 'home_sale_not_started',
      title: `Home payments not started — ${where}`,
      body,
      data: { documentId: w.document_id, contractId: w.contract_id },
      actionUrl: '/esign',
      sendEmail: true, emailTo: contact.email,
      emailHtml: emailTemplate(escapeHtml(`Home payments not started — ${where}`), `<p>${escapeHtml(body)}</p>`,
        { label: 'Open documents', url: portalLink('landlord', 'esign') }),
    })
  }
}

/** A property or unit name goes into the email's HTML (emailTemplate takes markup, the title too). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * S654 (Nic): a purchase agreement signed after this month's bill went out puts
 * the installment(s) already due onto that open bill, instead of waiting for the
 * next monthly run to bill two at once.
 *
 * For each unbilled installment whose billing month has arrived (and is on or
 * after the property's first billing cycle — earlier ones were paid outside GAM
 * and are stamped so, exactly as billDueHomeSaleInstallments does), find the
 * buyer's still-open bill for THAT month and add a home_payment line to it,
 * written the same way the monthly run writes one. No open bill for that month
 * (none yet, already paid, or paid and still clearing) → left for the monthly
 * run, which bills stragglers; a paid bill never grows a line.
 *
 * Idempotent: the partial-unique index on payments.home_sale_installment_id
 * and the installment's own payment_id stamp mean an installment bills once.
 * `dryRun` does the whole thing and rolls it back: what it reports is what a
 * real run would do, and nothing changes.
 */
/**
 * 10/25 (Nic): the buyer's due installments, right after their rent bill was
 * written on a property that BUNDLES. "Let landlords choose how it gets
 * bundled." Called by jobs/invoiceGeneration once the bill is committed, so
 * the installment joins the bill it belongs on instead of waiting a day.
 *
 * Does nothing when the unit has no active sale, or when the buyer is somebody
 * other than this lease's resident — the sale is looked up BY the buyer, so a
 * home somebody else is buying is never billed to whoever lives there.
 * Idempotent, and it goes through the one writer, so a property that is set to
 * separate still gets separate bills if this is ever called for one.
 */
export async function attachDueInstallmentsForUnitBuyer(unitId: string, tenantId: string | null): Promise<void> {
  if (!tenantId) return
  const live = await queryOne<{ id: string }>(
    `SELECT id FROM home_sale_contracts
      WHERE unit_id = $1 AND tenant_id = $2 AND status = 'active'`, [unitId, tenantId])
  if (!live) return
  await attachDueInstallmentsToOpenInvoices(live.id)
}

export async function attachDueInstallmentsToOpenInvoices(
  contractId: string, opts: { dryRun?: boolean } = {},
): Promise<{ attached: AttachedInstallment[] }> {
  const client = await getClient()
  let r: { attached: AttachedInstallment[]; stampedOffPlatform: number; household: { tenantId: string; landlordId: string } | null }
  try {
    await client.query('BEGIN')
    r = await attachDueInstallmentsIn(client, contractId)
    await client.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
  // 10/6 (Nic): "a credit against the entire balance" — money the buyer paid
  // ahead goes on the balance the line just joined, the way it does when the
  // monthly run writes the bill. Its own transaction after ours; never throws.
  if (!opts.dryRun && r.attached.length && r.household) {
    const { runWholeBillCheckAfterCommit } = await import('./creditUse')
    await runWholeBillCheckAfterCommit(r.household)
  }
  return { attached: r.attached }
}

/** The attach, on the caller's transaction (no BEGIN/COMMIT of its own). */
/**
 * 10/25 (Nic): A TRAILER PAYMENT IS ITS OWN BILL.
 *
 *   "Should trailer payments get their own invoice separately payable from lot
 *    rent? Yeah, let's do that, and they need to be clearly labeled — I've had
 *    some people literally try to say, oh, I paid my rent, and then it's like,
 *    no, that was the trailer payment, you have the space rent too."
 *
 * The installment used to ride whatever bill was handy: the buyer's rent bill
 * when they were its primary resident (jobs/invoiceGeneration), and no bill at
 * all otherwise. Both were wrong:
 *   * Lisa Scheeler is on work trade, so she gets no rent bill. Her trailer
 *     payment had nowhere to land.
 *   * Dominic Gonzalez's space rent is the park's money; his trailer payment is
 *     the trust's. One bill cannot be paid into two books.
 *   * Rent is pay-in-full platform-wide, so sharing the rent bill made the
 *     trailer payment unpayable on its own — which both of the above need.
 *
 * So every installment now lands on the contract's OWN bill for its month,
 * whoever the buyer is and whether or not they rent the space. One bill per
 * contract per month (ux_invoices_home_sale_contract_cycle).
 *
 * LATE FEES: whatever the CONTRACT says. 10/25 (Nic):
 *
 *   "A trailer bill could possibly have late fees. It's an installment contract
 *    that may carry its own late terms. I don't have any specific to these
 *    contracts, but we need to have the capability for landlords. We provide
 *    the tools to do the job, whatever their job is."
 *
 * So the bill is written late_fee_exempt only while the contract charges no
 * fee (home_sale_contracts.late_fee_enabled, default FALSE — a fee nobody
 * signed for is never charged). When it does, the contract's own stamped
 * parameters govern, exactly as a lease's and a utility agreement's do
 * (jobs/lateFees), and the percentage is figured on the installment itself
 * because the bill has no rent on it.
 */
async function ownBillFor(
  client: Client,
  c: { id: string; unit_id: string; tenant_id: string; landlord_id: string },
  billingMonth: string,
): Promise<{ id: string; dueDate: string }> {
  const existing = (await client.query<{ id: string; due_date: string }>(
    `SELECT id, due_date::text AS due_date FROM invoices
      WHERE home_sale_contract_id = $1 AND due_date = $2::date
      FOR UPDATE`, [c.id, billingMonth])).rows[0]
  if (existing) return { id: existing.id, dueDate: existing.due_date }

  const invoiceNumber = await allocateInvoiceNumber(client, c.landlord_id, Number(billingMonth.slice(0, 4)))
  const made = await client.query<{ id: string }>(
    `INSERT INTO invoices (
       landlord_id, tenant_id, lease_id, unit_id, home_sale_contract_id,
       invoice_number, due_date, subtotal_rent, subtotal_fees, subtotal_utilities,
       subtotal_home_payments, total_amount, late_fee_exempt
     ) VALUES ($1, $2, NULL, $3, $4, $5, $6::date, 0, 0, 0, 0, 0,
       -- Exempt only while the contract charges no late fee.
       NOT COALESCE((SELECT hs.late_fee_enabled FROM home_sale_contracts hs WHERE hs.id = $4), FALSE))
     -- The partial predicate is REQUIRED for Postgres to infer the index.
     ON CONFLICT (home_sale_contract_id, due_date)
       WHERE home_sale_contract_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [c.landlord_id, c.tenant_id, c.unit_id, c.id, invoiceNumber, billingMonth])
  if (made.rows.length) return { id: made.rows[0].id, dueDate: billingMonth }

  // Another writer got there first between the read and the insert. Its bill is
  // the one bill for this month; the number reserved above is simply not used.
  const raced = (await client.query<{ id: string; due_date: string }>(
    `SELECT id, due_date::text AS due_date FROM invoices
      WHERE home_sale_contract_id = $1 AND due_date = $2::date
      FOR UPDATE`, [c.id, billingMonth])).rows[0]
  if (!raced) throw new Error(`home sale: no bill for contract ${c.id} month ${billingMonth}`)
  return { id: raced.id, dueDate: raced.due_date }
}

/**
 * 10/25 (Nic): WHICH BILL IS THE LANDLORD'S CHOICE.
 *
 *   "Leave current properties set up as is. Let landlords choose how it gets
 *    bundled."
 *
 * properties.home_payments_own_bill, default TRUE (separate — Nic's choice for
 * Mountain View and Oak Park). FALSE bundles the installment onto the buyer's
 * rent bill for that month, the way it rode one before today.
 *
 * SEPARATE ALWAYS WINS WHEN THERE IS NOTHING TO BUNDLE INTO. A buyer on work
 * trade gets no rent bill (Lisa Scheeler), and a buyer who rents no space at
 * this park never had one (the operator with a hundred homes in parks he does
 * not own) — so a bundled property still gives those buyers their own bill,
 * because the alternative is not billing them at all. That is the gap this
 * replaces: the old two paths each assumed the other would catch such a buyer,
 * and a buyer listed as a co-tenant was billed by neither.
 *
 * The buyer's bill for the month means: an active lease on this unit that the
 * buyer is a resident on, with that month's bill still open. Any role on the
 * lease, not just primary — the role was never the point.
 */
async function targetBillFor(
  client: Client,
  c: { id: string; unit_id: string; tenant_id: string; landlord_id: string; own_bill: boolean },
  billingMonth: string,
  /**
   * The park's today. On a BUNDLED property whose rent bill for the month has
   * not been written yet, the installment WAITS for it (null) rather than
   * taking a bill of its own — the daily home-sale run is at 04:20 and the
   * monthly bills are written at 07:00 local, so a fallback would beat the
   * rent bill to it every month and the setting would never hold. Once the
   * month is over the fallback does apply, so nothing is left unbilled when
   * no rent bill ever came (a work-trade month, a lease that ended).
   */
  asOf: string,
): Promise<{ id: string; dueDate: string; lease_id: string | null } | null> {
  if (!c.own_bill) {
    const rent = (await client.query<{ id: string; due_date: string; lease_id: string }>(
      `SELECT i.id, i.due_date::text AS due_date, i.lease_id
         FROM invoices i
         JOIN leases l ON l.id = i.lease_id
        WHERE i.status IN ('pending','partial')
          AND NOT i.is_opening_balance
          AND i.home_sale_contract_id IS NULL
          AND date_trunc('month', i.due_date)::date = date_trunc('month', $3::date)::date
          AND l.unit_id = $2 AND l.status = 'active'
          AND (i.tenant_id = $1 OR i.tenant_id IS NULL)
          AND EXISTS (SELECT 1 FROM v_lease_active_tenants v
                       WHERE v.lease_id = l.id AND v.tenant_id = $1)
        ORDER BY EXISTS (SELECT 1 FROM payments r WHERE r.invoice_id = i.id AND r.type = 'rent') DESC,
                 i.due_date, i.id
        LIMIT 1
        FOR UPDATE OF i`, [c.tenant_id, c.unit_id, billingMonth])).rows[0]
    if (rent) return { id: rent.id, dueDate: rent.due_date, lease_id: rent.lease_id }
    // No rent bill of theirs for that month yet. Still inside the month, wait
    // for it; past the month, fall through so the installment is billed
    // somewhere rather than nowhere.
    if (billingMonth.slice(0, 7) >= asOf.slice(0, 7)) return null
  }
  const own = await ownBillFor(client, c, billingMonth)
  return { ...own, lease_id: null }
}

/**
 * 10/25 — THE CHARGE KEEPS ITS LEASE.
 *
 * Only WHICH BILL an installment sits on changed today; the charge row still
 * carries payments.lease_id, because the books, the rent roll, the deposit
 * sweep, the bank-deposit match and the Outstanding page all read it. Three of
 * them read it as a hard requirement:
 *   - bankDepositCandidates: `AND p.lease_id IS NOT NULL` — a charge with no
 *     lease is not offered when matching a bank deposit. Its own comment names
 *     the case: "MH 21 at Country Acres owed rent $450, water $165 and a $200
 *     home payment — exactly the $815 deposit; without the home payment the
 *     deposit tied to nothing."
 *   - depositReturn SWEEP_LINES_SQL: `WHERE p.lease_id IN <lease chain>` — an
 *     unpaid installment with no lease is never deducted at move-out, so the
 *     landlord refunds money the buyer still owes.
 *   - openBalances groups a person's spaces by p.lease_id.
 *
 * home_sale_contracts.lease_id cannot answer this: it is context only (S651 —
 * "a sale stands on its own"), and every contract the signing packet writes has
 * none. Eight of the eleven live contracts have none while all eight buyers do
 * rent the space. Until today the installment inherited the RENT bill's lease
 * because it rode that bill, which is why all nine existing home_payment rows
 * carry one; writing the contract's empty column instead would have quietly
 * dropped it for those eight.
 *
 * So: the bundled bill's lease, else the contract's own if it names one, else
 * the buyer's active lease on this unit — the same value the rent bill gave it.
 * Null only when the buyer genuinely rents nothing here (the operator who owns
 * homes in parks he does not own), which is what it has always been for them.
 */
async function leaseForCharge(
  client: Client,
  c: { unit_id: string; lease_id: string | null; tenant_id: string },
  billLeaseId: string | null,
): Promise<string | null> {
  if (billLeaseId) return billLeaseId
  if (c.lease_id) return c.lease_id
  const own = (await client.query<{ id: string }>(
    `SELECT l.id FROM leases l
      WHERE l.unit_id = $1 AND l.status = 'active'
        AND EXISTS (SELECT 1 FROM v_lease_active_tenants v
                     WHERE v.lease_id = l.id AND v.tenant_id = $2)
      ORDER BY l.start_date DESC, l.id
      LIMIT 1`, [c.unit_id, c.tenant_id])).rows[0]
  return own?.id ?? null
}

/**
 * Bill ONE installment onto whichever bill the property's setting chooses.
 * Returns null when it was already billed (the partial-unique index on
 * payments.home_sale_installment_id makes a concurrent run a no-op), so an
 * installment is charged at most once and the buyer is never double-charged.
 */
async function billInstallmentOnItsOwnBill(
  client: Client,
  c: { id: string; unit_id: string; lease_id: string | null; tenant_id: string; landlord_id: string; installments_total: number; own_bill: boolean },
  d: { id: string; installment_number: number; amount: string | number; billing_month: string },
  asOf: string,
): Promise<{ invoiceId: string; dueDate: string; amount: number } | null> {
  const bill = await targetBillFor(client, c, d.billing_month, asOf)
  if (!bill) return null
  const chargeLeaseId = await leaseForCharge(client, c, bill.lease_id)
  const amount = Number(d.amount)
  const ins = await client.query<{ id: string }>(
    `INSERT INTO payments (
       invoice_id, unit_id, lease_id, tenant_id, landlord_id,
       type, amount, status, due_date, entry_description, notes, home_sale_installment_id
     ) VALUES ($1, $2, $3, $4, $5, 'home_payment', $6, 'pending', $7, 'HOMEPMT', $8, $9)
     ON CONFLICT (home_sale_installment_id) WHERE home_sale_installment_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [bill.id, c.unit_id, chargeLeaseId, c.tenant_id, c.landlord_id, amount.toFixed(2), bill.dueDate,
     `Home payment ${d.installment_number} of ${c.installments_total}`, d.id])
  if (!ins.rows.length) return null
  await client.query(
    `UPDATE home_sale_installments SET payment_id = $1 WHERE id = $2 AND payment_id IS NULL`,
    [ins.rows[0].id, d.id])
  await client.query(
    `UPDATE invoices
        SET subtotal_home_payments = COALESCE(subtotal_home_payments, 0) + $2,
            total_amount           = total_amount + $2,
            updated_at             = NOW()
      WHERE id = $1`, [bill.id, amount.toFixed(2)])
  return { invoiceId: bill.id, dueDate: bill.dueDate, amount }
}

async function attachDueInstallmentsIn(client: Client, contractId: string): Promise<{
  attached: AttachedInstallment[]; stampedOffPlatform: number; household: { tenantId: string; landlordId: string } | null
}> {
  const attached: AttachedInstallment[] = []
  // 10/12: no lease link required. The contract's lease_id is context only
  // (S651 — a sale stands on its own), and every contract the packet signs is
  // written with none; this used to require one, so a sale signed from the
  // packet could never be billed at all.
  const c = (await client.query<any>(
    `SELECT c.id, c.unit_id, c.lease_id, c.tenant_id, c.landlord_id, c.installments_total,
            c.tracked_not_billed,
            p.home_payments_own_bill AS own_bill,
            to_char(p.first_billing_cycle, 'YYYY-MM-DD') AS first_billing_cycle,
            -- 10/25: the park's TODAY (S654: the park's clock, not the
            -- server's). This was the 1st of the park's month, which meant an
            -- installment dated any later day never came due in its own month
            -- — Lisa Scheeler's falls on the 10th, so hers would have billed a
            -- month late, every month, for the life of the contract.
            to_char((NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS today
       FROM home_sale_contracts c
       JOIN units u ON u.id = c.unit_id JOIN properties p ON p.id = u.property_id
      WHERE c.id = $1 AND c.status = 'active'`, [contractId])).rows[0]
  if (!c) return { attached, stampedOffPlatform: 0, household: null }

  // S655: lines go on the buyer's bill, so this writes the household's money —
  // the household lock first, like every other writer of it.
  await lockHousehold(client, c.tenant_id, c.landlord_id)
  // 10/12 (Nic): the read above took no lock. A void of the agreement holds
  // this same household lock while it takes the sale back (lib/voidDocument
  // unwindHomeSaleOnVoid), and its deletes clear each installment's payment_id
  // — so after waiting here the installments would look unbilled again, and a
  // cancelled sale's home payments would go back on the buyer's bill. Read the
  // sale again under its row lock, now that nothing else can be mid-void, and
  // stop if it is no longer billing.
  const live = (await client.query(
    `SELECT 1 FROM home_sale_contracts WHERE id = $1 AND status = 'active' FOR UPDATE`, [c.id])).rows[0]
  if (!live) return { attached, stampedOffPlatform: 0, household: null }

  let stampedOffPlatform = 0
  if (c.first_billing_cycle) {
    stampedOffPlatform = (await client.query(
      `UPDATE home_sale_installments SET settled_off_platform_at = NOW()
        WHERE contract_id = $1 AND payment_id IS NULL AND settled_off_platform_at IS NULL
          AND billing_month < date_trunc('month', $2::date)::date`, [c.id, c.first_billing_cycle])).rowCount ?? 0
  }
  // 10/25: a contract GAM tracks but does not bill has nothing to attach.
  if (c.tracked_not_billed) {
    if (stampedOffPlatform) await reconcileHomeSaleContract(c.id, client)
    return { attached, stampedOffPlatform, household: { tenantId: c.tenant_id, landlordId: c.landlord_id } }
  }
  const due = (await client.query<any>(
    `SELECT id, installment_number, amount::text AS amount, billing_month::text AS billing_month
       FROM home_sale_installments
      WHERE contract_id = $1 AND payment_id IS NULL AND settled_off_platform_at IS NULL
        AND billing_month <= $3::date
        AND ($2::date IS NULL OR billing_month >= date_trunc('month', $2::date)::date)
      ORDER BY installment_number`, [c.id, c.first_billing_cycle, c.today])).rows

  for (const d of due) {
    // 10/25: the property's setting picks the bill (targetBillFor). No
    // primary-resident rule and no "a paid bill never grows a line" — on a
    // separate property the installment is on nobody else's document, and on a
    // bundled one it joins only a bill that is still open.
    const put = await billInstallmentOnItsOwnBill(client, c, d, c.today)
    if (!put) continue
    attached.push({ installmentNumber: d.installment_number, amount: put.amount, invoiceId: put.invoiceId, dueDate: put.dueDate })
  }
  // A stamped month counts as paid, a line on a bill as billed.
  if (attached.length || stampedOffPlatform) await reconcileHomeSaleContract(c.id, client)
  return { attached, stampedOffPlatform, household: { tenantId: c.tenant_id, landlordId: c.landlord_id } }
}

/**
 * Reconcile a contract against reality: recount billed (payment_id set) + paid
 * (linked payment settled) installments. When every installment is settled, mark
 * the contract paid_off and flip the unit to tenant-owned (the buyer now owns the
 * home). Idempotent — safe to run repeatedly (daily cron + post-settle).
 *
 * `client`: run inside the caller's transaction (the attach holds the
 * contract's row lock, so a second connection would wait on it for good).
 */
export async function reconcileHomeSaleContract(contractId: string, client?: Client): Promise<void> {
  const run = async <T = any>(sql: string, params: any[]): Promise<T[]> =>
    client ? (await client.query(sql, params)).rows as T[] : query<T>(sql, params)
  const c = (await run<any>(`SELECT id, unit_id, status, installments_total FROM home_sale_contracts WHERE id=$1`, [contractId]))[0]
  if (!c || c.status !== 'active') return

  const counts = (await run<{ billed: string; paid: string }>(
    `SELECT
        COUNT(*) FILTER (WHERE i.payment_id IS NOT NULL OR i.settled_off_platform_at IS NOT NULL) AS billed,
        COUNT(*) FILTER (WHERE p.status IN ('settled','paid_via_deposit') OR i.settled_off_platform_at IS NOT NULL) AS paid
       FROM home_sale_installments i
       LEFT JOIN payments p ON p.id = i.payment_id
      WHERE i.contract_id = $1`, [contractId]))[0]
  const billed = parseInt(counts?.billed ?? '0', 10)
  const paid = parseInt(counts?.paid ?? '0', 10)

  await run(`UPDATE home_sale_contracts SET installments_billed=$2, installments_paid=$3, updated_at=NOW() WHERE id=$1`,
    [contractId, billed, paid])

  if (paid >= c.installments_total) {
    // 10/12 (Nic): the landlord's signature starts a sale billing, so a sale
    // whose every month falls before the park's first billing cycle is fully
    // "paid outside GAM" the moment he signs — before the buyer has signed
    // anything, while the agreement can still be voided. Handing the home over
    // then would leave it with a buyer who never signed if the paper is voided
    // (a void cannot take a paid-off sale back). So the payoff waits while the
    // agreement is still open and no buyer has signed it; the daily reconcile
    // finishes it once one has. A sale with no agreement in GAM (papered
    // outside) and one the buyer signed pay off as before.
    const done = await run<{ id: string }>(
      `UPDATE home_sale_contracts hc SET status='paid_off', paid_off_at=NOW(), updated_at=NOW()
        WHERE hc.id=$1 AND hc.status='active'
          AND NOT EXISTS (
            SELECT 1 FROM lease_documents d
             WHERE d.id = hc.purchase_document_id AND d.status <> 'completed'
               AND NOT EXISTS (SELECT 1 FROM lease_document_signers s
                                WHERE s.document_id = d.id AND s.signed_at IS NOT NULL
                                  AND s.role NOT IN ('landlord', 'witness')))
        RETURNING hc.id`, [contractId])
    if (!done.length) return
    // Buyer now owns the home — flip dwelling ownership AND record the buyer as
    // the home owner (the sale document trail lives on the contract).
    await run(`UPDATE units SET dwelling_ownership='tenant', updated_at=NOW() WHERE id=$1`, [c.unit_id])
    const buyer = (await run<{ user_id: string }>(
      `SELECT t.user_id FROM home_sale_contracts hsc JOIN tenants t ON t.id = hsc.tenant_id WHERE hsc.id=$1`, [contractId]))[0]
    if (buyer?.user_id) {
      const { setHomeOwner } = await import('./homeOwnership')
      if (client) {
        // Best-effort as below, without taking the caller's transaction with it.
        await client.query('SAVEPOINT home_sale_owner')
        try {
          await setHomeOwner(client as any, { unitId: c.unit_id, ownerUserId: buyer.user_id, acquiredVia: 'financed_payoff' })
          await client.query('RELEASE SAVEPOINT home_sale_owner')
        } catch (e) { await client.query('ROLLBACK TO SAVEPOINT home_sale_owner') }
        return
      }
      const own = await getClient()
      try {
        await own.query('BEGIN')
        await setHomeOwner(own as any, { unitId: c.unit_id, ownerUserId: buyer.user_id, acquiredVia: 'financed_payoff' })
        await own.query('COMMIT')
      } catch (e) { await own.query('ROLLBACK').catch(() => {}) } finally { own.release() }
    }
  }
}

/** Reconcile every active contract (daily cron). */
export async function reconcileAllHomeSaleContracts(): Promise<void> {
  const active = await query<{ id: string }>(`SELECT id FROM home_sale_contracts WHERE status='active'`)
  for (const c of active) await reconcileHomeSaleContract(c.id)
}

/**
 * Bill every home-sale installment whose billing month has arrived and that
 * hasn't been billed yet — one standalone type='home_payment' charge per
 * installment (separate line from space rent, routes to the landlord/seller).
 * Idempotent: installment.payment_id is stamped once, so re-runs skip billed
 * rows. Auto-stops naturally when a contract has no more unbilled installments.
 *
 * `asOf` = 'YYYY-MM-DD', the park's today: bill everything due on or before it.
 * 10/25: this was read as a MONTH ('YYYY-MM-01'), which silently assumed every
 * schedule falls on the 1st. Lisa Scheeler's falls on the 10th, so every one of
 * her installments would have billed a month late — 2026-10-10 is not <=
 * 2026-10-01 — for the whole contract. A day is what the rule always meant:
 * an installment bills once its own date has arrived.
 *
 * Returns the number of installments billed.
 */
export async function billDueHomeSaleInstallments(asOf: string): Promise<number> {
  // 10/12 (Nic): "Retry every morning." A sale the landlord signed that did not
  // start on his signature is started first, so whatever of it is due bills
  // this morning with everything else. Its failure never stops the billing.
  await retryLandlordSignedHomeSaleStarts().catch(err =>
    logger.error({ err }, 'home sale: the morning retry of landlord-signed sales failed'))
  // S652 (Nic): the contract keeps its true terms — John Sheptock's started in
  // January 2021 — but GAM bills only from the property's first billing cycle.
  // Every installment before that was paid outside GAM and is stamped so, once;
  // it never bills and it counts as paid when the balance is worked out.
  await query(
    `UPDATE home_sale_installments i SET settled_off_platform_at = NOW()
       FROM home_sale_contracts c, units u, properties p
      WHERE i.contract_id = c.id AND u.id = c.unit_id AND p.id = u.property_id
        AND c.status = 'active' AND i.payment_id IS NULL AND i.settled_off_platform_at IS NULL
        AND p.first_billing_cycle IS NOT NULL
        AND i.billing_month < date_trunc('month', p.first_billing_cycle)::date`)
  const due = await query<any>(
    `SELECT i.id AS installment_id, i.installment_number, i.amount, i.billing_month::text AS billing_month,
            c.id AS contract_id, c.unit_id, c.lease_id, c.tenant_id, c.landlord_id, c.installments_total,
            -- 10/25 (Nic): the landlord's choice, per property.
            pr.home_payments_own_bill AS own_bill
       FROM home_sale_installments i
       JOIN home_sale_contracts c ON c.id = i.contract_id
       JOIN units un ON un.id = c.unit_id
       JOIN properties pr ON pr.id = un.property_id
      WHERE c.status = 'active'
        AND i.payment_id IS NULL
        AND i.settled_off_platform_at IS NULL
        AND i.billing_month <= $1::date
        -- 10/25 (Nic), Dominic Gonzalez's contract: "it is not going to go
        -- billed through the property. It's not going to get invoiced through
        -- the property. It's just going to be a ledger that keeps track." His
        -- installment is the TRUST's money, so GAM bills nothing on it — it is
        -- reminded (remindTrackedHomePayments) and marked paid by hand.
        AND NOT c.tracked_not_billed
        -- 10/25 (Nic): EVERY buyer is billed here, on the contract's own bill.
        -- This used to skip a buyer who rented the space, because their
        -- installment rode their rent invoice instead (jobs/invoiceGeneration)
        -- — and whether it rode it turned on them being the lease's PRIMARY,
        -- so a co-tenant buyer was skipped by both sides and never billed at
        -- all. A trailer payment is its own bill now, so there is no second
        -- path to defer to and nobody to miss.
      ORDER BY c.id, i.installment_number ASC`,
    [asOf])

  let billed = 0
  const touchedContracts = new Set<string>()
  for (const d of due) {
    // Bill each installment atomically: create the charge stamped with the
    // driving installment id, then stamp the installment — in one transaction.
    // The partial-unique index on payments.home_sale_installment_id makes a
    // concurrent/overlapping run (or a second cron-enabled instance) a no-op
    // via ON CONFLICT DO NOTHING, so an installment is billed at most once and
    // the tenant is never double-charged.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // The bill carries the buyer's money, so take the household lock first,
      // like every other writer of it — and like the mid-month attach does.
      await lockHousehold(client, d.tenant_id, d.landlord_id)
      const put = await billInstallmentOnItsOwnBill(
        client,
        { id: d.contract_id, unit_id: d.unit_id, lease_id: d.lease_id, tenant_id: d.tenant_id,
          landlord_id: d.landlord_id, installments_total: d.installments_total,
          own_bill: d.own_bill !== false },
        { id: d.installment_id, installment_number: d.installment_number,
          amount: d.amount, billing_month: d.billing_month },
        asOf,
      )
      if (put) {
        billed++
        touchedContracts.add(d.contract_id)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
  }
  for (const cid of touchedContracts) await reconcileHomeSaleContract(cid)
  return billed
}

/**
 * 10/25 (Nic) — THE REMINDER ON A CONTRACT GAM DOES NOT BILL.
 *
 *   "For now, with Dominic, we are going to send reminders about that contract
 *    payment being due. But it is not going to go billed through the property.
 *    It's not going to get invoiced through the property. It's just going to be
 *    a ledger that keeps track and when that payment comes in, we will mark
 *    that it was paid, but it stays off the books."
 *
 * There is no bill and no Pay Now here, so this notice IS the whole reminder:
 * it says the amount, the date, and that the landlord collects it directly.
 * Sending the buyer to a Payments page would be worse than saying nothing —
 * the payment is not on it and never will be.
 *
 * Once per installment (reminded_at), so the nightly run reminds once and not
 * every night. Stamped BEFORE the notice goes out: a reminder that fails is a
 * reminder not sent twice, which is the right way round for email volume, and
 * the ledger on the unit page shows what is due regardless.
 *
 * The landlord is deliberately not emailed. The money is theirs to collect and
 * the ledger is on the unit page; a second email per month per contract buys
 * nothing and GAM keeps its sending down. Easy to add if Nic wants it.
 */
export async function remindTrackedHomePayments(asOf: string): Promise<number> {
  const due = await query<any>(
    `SELECT i.id, i.installment_number, i.amount::text AS amount,
            i.billing_month::text AS billing_month,
            c.id AS contract_id, c.installments_total, c.landlord_id,
            u.unit_number, pr.id AS property_id, pr.name AS property_name,
            tu.id AS user_id, tu.email, tu.first_name,
            COALESCE(NULLIF(btrim(l.business_name), ''), lu.first_name || ' ' || lu.last_name) AS landlord_name
       FROM home_sale_installments i
       JOIN home_sale_contracts c ON c.id = i.contract_id
       JOIN units u  ON u.id = c.unit_id
       JOIN properties pr ON pr.id = u.property_id
       JOIN landlords l ON l.id = c.landlord_id
       JOIN users lu ON lu.id = l.user_id
       JOIN tenants t ON t.id = c.tenant_id
       JOIN users tu ON tu.id = t.user_id
      WHERE c.status = 'active'
        AND c.tracked_not_billed
        AND i.payment_id IS NULL
        AND i.settled_off_platform_at IS NULL
        AND i.reminded_at IS NULL
        AND i.billing_month <= $1::date
      ORDER BY c.id, i.installment_number`,
    [asOf])

  let sent = 0
  for (const d of due) {
    const stamped = await query(
      `UPDATE home_sale_installments SET reminded_at = NOW()
        WHERE id = $1 AND reminded_at IS NULL`, [d.id])
    if ((stamped as any).length === 0 && (stamped as any).rowCount === 0) continue
    const { createNotification } = await import('./notifications')
    const { replyToProperty } = await import('./replyRouting')
    const amount = `$${Number(d.amount).toFixed(2)}`
    const when = d.billing_month
    const where = [d.property_name, d.unit_number].filter(Boolean).join(' — ')
    try {
      await createNotification({
        userId: d.user_id,
        landlordId: d.landlord_id,
        type: 'home_payment_due',
        title: `Home payment due — ${amount}`,
        body: `Your home payment of ${amount} for ${where} was due ${when} `
            + `(payment ${d.installment_number} of ${d.installments_total}). `
            + `${d.landlord_name ?? 'Your landlord'} collects this one directly, so it is not on your GAM bill `
            + `and there is nothing to pay here — pay it the way you arranged, and it will be marked once it arrives.`,
        sendEmail: true,
        emailTo: d.email,
        emailSubject: `Home payment due — ${amount}`,
        // 10/5: a notice about somebody's home passes the property, so a reply
        // reaches the people who run it rather than GAM.
        replyTo: replyToProperty(d.property_id),
      })
      sent++
    } catch (err) {
      logger.error({ err, installmentId: d.id }, 'home sale: a tracked payment reminder did not go out')
    }
  }
  return sent
}

/**
 * 10/25 (Nic): "when that payment comes in, we will mark that it was paid, but
 * it stays off the books." The mark is settled_off_platform_at — the same stamp
 * GAM already uses for months paid before it started billing, which
 * reconcileHomeSaleContract counts as paid, so payoff and handing the home over
 * work unchanged. No invoice, no charge, no money through GAM.
 */
export async function markTrackedInstallmentPaid(
  contractId: string, installmentNumber: number, paid: boolean,
): Promise<{ installmentNumber: number; settled: boolean }> {
  const row = await queryOne<{ id: string }>(
    `SELECT i.id FROM home_sale_installments i
       JOIN home_sale_contracts c ON c.id = i.contract_id
      WHERE c.id = $1 AND c.tracked_not_billed AND i.installment_number = $2
        AND i.payment_id IS NULL`,
    [contractId, installmentNumber])
  if (!row) {
    throw new AppError(404,
      'That payment is not one this contract tracks off the books — a payment GAM billed is marked on the bill itself.')
  }
  await query(
    `UPDATE home_sale_installments
        SET settled_off_platform_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
      WHERE id = $1`, [row.id, paid])
  await reconcileHomeSaleContract(contractId)
  return { installmentNumber, settled: paid }
}

/**
 * S652 — the terms of an installment sale, and the checks that must run before
 * one can exist. Shared, because there are now two doors into a home sale.
 *
 * POST /api/home-sales is one: a landlord papering a sale on its own. The other
 * is a lease packet with an installment-sale template ticked, which is what Nic
 * asked for — "one packet, two documents, two signatures" — and which must NOT
 * be a way around the rules the first door enforces.
 *
 * Every guard below exists because of a specific decision, and duplicating them
 * at the second door would mean the next change to one of them silently applies
 * to half the product.
 */
export const homeSaleTermsSchema = z.object({
  startMonth:         z.string().regex(/^\d{4}-\d{2}-01$/),
  planType:           z.enum(['amortized', 'flat']).default('amortized'),
  salePrice:          z.number().positive().optional(),
  downPayment:        z.number().min(0).default(0),
  annualInterestRate: z.number().min(0).max(60).default(0),
  termMonths:         z.number().int().positive().max(600).optional(),
  monthlyAmount:      z.number().positive().optional(),
  numberOfPayments:   z.number().int().positive().max(600).optional(),
  tenantId:           z.string().uuid().optional(),
}).transform((b) => {
  // A flat plan is 0% interest with each installment equal to the flat amount;
  // the sale price is that amount times the number of payments.
  if (b.planType === 'flat') {
    if (b.monthlyAmount == null || b.numberOfPayments == null) {
      throw new AppError(400, 'A flat plan needs a monthly amount and a number of payments.')
    }
    return {
      ...b,
      salePrice: Math.round(b.monthlyAmount * b.numberOfPayments * 100) / 100,
      downPayment: 0,
      annualInterestRate: 0,
      termMonths: b.numberOfPayments,
    }
  }
  if (b.salePrice == null || b.termMonths == null) {
    throw new AppError(400, 'An amortized plan needs a sale price and a term.')
  }
  return { ...b, salePrice: b.salePrice, termMonths: b.termMonths }
})

/**
 * Can this unit be sold on installments at all?
 *
 * S613 (Nic, DIRECTIVE): "Financed sales scope needs to be limited to
 * converting park owned homes to tenant owned homes. We don't want it to be
 * anything to do with RVs." An RV is towed away — there is nothing to convert,
 * and financing one would make GAM the lender on a vehicle that can leave.
 */
/**
 * Both callers pass a different thing: a PoolClient (whose .query returns
 * `{ rows }`) inside a transaction, and db's `query` (which returns the rows
 * themselves) outside one. Normalizing here rather than making each caller
 * remember is the difference between a shared guard and a trap — TypeScript
 * cannot see the mismatch through `{ query: Function }`, so nothing would have
 * told anybody until it threw in production.
 */
async function rowsFrom(q: { query: Function }, sql: string, params: any[]): Promise<any[]> {
  const out = await q.query(sql, params)
  return Array.isArray(out) ? out : (out?.rows ?? [])
}

export async function assertUnitIsSaleable(
  client: { query: Function }, unitId: string,
): Promise<{ id: string; landlord_id: string; unit_number: string }> {
  const unit = (await rowsFrom(client,
    `SELECT u.id, u.landlord_id, u.dwelling_ownership, u.unit_type, u.unit_number
       FROM units u WHERE u.id = $1`, [unitId]))[0]
  if (!unit) throw new AppError(404, 'Unit not found')
  if (unit.dwelling_ownership !== 'landlord') {
    throw new AppError(409, 'This unit is already tenant-owned — there is no park-owned home to finance.')
  }
  if (unit.unit_type !== 'mobile_home') {
    throw new AppError(400,
      'A financed sale converts a park-owned HOME to tenant-owned. It is only offered on mobile homes.')
  }
  return unit
}

/**
 * Does this landlord have any standing with this buyer?
 *
 * tenantId becomes the billed obligor on every installment, so it can never be
 * an arbitrary id out of a request body (memory: gam-foreign-ref-write-scope).
 * What is required is a relationship of SOME kind — a lease of any status, an
 * open onboarding invite, or a utility agreement — not a tenancy, because a
 * buyer may own a home they do not live in.
 */
export async function assertBuyerIsKnown(
  client: { query: Function }, tenantId: string, landlordId: string,
): Promise<void> {
  const known = (await rowsFrom(client,
    `SELECT 1 WHERE
       EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                WHERE lt.tenant_id = $1 AND l.landlord_id = $2)
       OR EXISTS (SELECT 1 FROM pending_tenant_intents pti
                   WHERE pti.tenant_id = $1 AND pti.landlord_id = $2
                     AND pti.cancelled_at IS NULL)
       OR EXISTS (SELECT 1 FROM utility_service_agreements sa
                   WHERE sa.tenant_id = $1 AND sa.landlord_id = $2)
     LIMIT 1`, [tenantId, landlordId]))[0]
  if (!known) {
    throw new AppError(400,
      'That buyer has no record with you — invite them first, then sell them the home.')
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// S652 (Nic): THE PAPER IS THE RECORD.
//
// "If I want my payment to be $19 for one hundred payments I need to type
// those in ... have the data tag be the correct label where the invoice will
// go out correctly no matter what I type in that box at signing time."
//
// The installment contract's boxes tagged with sale labels are TYPED by the
// landlord at signing. When the landlord signs, those values become the sale
// record — the thing that bills each month and stops after the last payment.
// Nothing derives from an invite or a sheet; a prefilled box is only a
// suggestion the landlord may type over.
// ─────────────────────────────────────────────────────────────────────────────

export type TypedSaleTerms = {
  monthlyAmount: number | null; numberOfPayments: number | null; salePrice: number | null
  downPayment: number; annualInterestRate: number; startMonth: string | null
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']
/** "10/01/2026", "10/2026", "2026-10", "2026-10-01", "October 2026", "Oct 2026" → "2026-10-01". */
export function monthFromTyped(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  if (!t) return null
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?/.exec(t)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`
  m = /^(\d{1,2})[\/\-](?:(\d{1,2})[\/\-])?(\d{4})$/.exec(t)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-01`
  m = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(t)
  if (m) {
    const i = MONTHS.findIndex(x => x.startsWith(m![1].toLowerCase().slice(0, 3)))
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}-01`
  }
  return null
}

/** Read the sale terms off a document's fields (by lease_column). */
export function saleTermsFromFields(fields: Array<{ lease_column: string | null; value: string | null }>): TypedSaleTerms {
  const get = (col: string) => fields.find(f => f.lease_column === col)?.value ?? null
  return {
    monthlyAmount:      num(get('sale_monthly_payment')),
    numberOfPayments:   (() => { const n = num(get('sale_term_months')); return n == null ? null : Math.round(n) })(),
    salePrice:          num(get('sale_price')),
    downPayment:        num(get('sale_down_payment')) ?? 0,
    annualInterestRate: num(get('sale_interest_rate')) ?? 0,
    startMonth:         monthFromTyped(get('sale_first_payment_month')),
  }
}

/**
 * What the typed terms mean, or why they cannot bill — said in the landlord's words.
 * `tz` is the property's zone, for the default first payment month. `asOf`
 * ('YYYY-MM-DD', the park's calendar) is the day "next month" counts from —
 * the day he signed, when that is not today (the morning retry).
 */
export function resolveTypedSaleTerms(t: TypedSaleTerms, tz: string | null = null, asOf?: string | null): { planType: 'flat' | 'amortized'; salePrice: number; downPayment: number; annualInterestRate: number; termMonths: number; startMonth: string } {
  const n = t.numberOfPayments
  if (!n || n <= 0) throw new AppError(400, 'The installment contract needs the number of payments.')
  // S654: "next month" counts from the park's today. From UTC, a contract
  // signed on the last evening of a month in Phoenix skipped a month.
  const start = t.startMonth ?? monthStartOf(addDaysTo(monthStartOf(asOf ?? todayIn(tz)), 32))
  // Same amount every month, no interest: the plain case — price is the sum.
  if (t.monthlyAmount && t.monthlyAmount > 0 && (!t.annualInterestRate || t.annualInterestRate === 0)
      && (t.salePrice == null || Math.abs(t.salePrice - t.downPayment - t.monthlyAmount * n) < 1)) {
    return { planType: 'flat', salePrice: Math.round((t.monthlyAmount * n + t.downPayment) * 100) / 100,
             downPayment: t.downPayment, annualInterestRate: 0, termMonths: n, startMonth: start }
  }
  if (t.salePrice == null || t.salePrice <= 0) {
    throw new AppError(400, 'The installment contract needs either a monthly payment with no interest, or a sale price with the rate and number of payments.')
  }
  return { planType: 'amortized', salePrice: t.salePrice, downPayment: t.downPayment,
           annualInterestRate: t.annualInterestRate, termMonths: n, startMonth: start }
}

/**
 * On the landlord's signature of an installment contract: the typed terms
 * become the sale record, and the derived boxes — amount financed, final
 * payment amount and month — are stamped so the printed paper agrees with the
 * record. The record is written 'pending_signature'; the same signature then
 * starts it billing (10/12, Nic — routes/esign.ts calls activateHomeSaleContract
 * right after this), so the buyer's signature is no longer what bills it.
 */
export async function applySaleTermsFromDocument(
  documentId: string,
  /** The day he signed (park calendar), when recording later than that day — see resolveTypedSaleTerms. */
  o: { asOf?: string | null } = {},
): Promise<{ contractId: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const doc = (await client.query<any>(
      `SELECT d.id, d.unit_id, d.landlord_id, p.timezone
         FROM lease_documents d
         LEFT JOIN units u ON u.id = d.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
        WHERE d.id = $1 FOR UPDATE OF d`, [documentId])).rows[0]
    if (!doc?.unit_id) throw new AppError(400, 'This installment contract is not attached to a unit.')
    // 10/12 (Nic): this paper's sale already started — its own landlord
    // signature made it billing. A second run (a double-clicked signature, or
    // a second landlord-side signer) has nothing to record. Without this it
    // found no waiting record, tried to write a new one beside the live sale,
    // was refused, and raised a false "terms did not record" alarm.
    const started = (await client.query<{ id: string }>(
      `SELECT id FROM home_sale_contracts
        WHERE purchase_document_id = $1 AND status IN ('active', 'paid_off') LIMIT 1`, [documentId])).rows[0]
    if (started) { await client.query('COMMIT'); return { contractId: started.id } }
    const fields = (await client.query<any>(
      `SELECT id, lease_column, value FROM lease_document_fields WHERE document_id = $1 AND lease_column LIKE 'sale_%'`, [documentId])).rows
    const terms = resolveTypedSaleTerms(saleTermsFromFields(fields), doc.timezone, o.asOf)
    const buyer = (await client.query<any>(
      `SELECT t.id FROM lease_document_signers s JOIN tenants t ON t.user_id = s.user_id
        WHERE s.document_id = $1 AND s.role IN ('primary','purchaser') ORDER BY s.order_index LIMIT 1`, [documentId])).rows[0]
    if (!buyer) throw new AppError(400, 'The installment contract has no buyer on it.')

    // A pending record already on this unit gives way to the paper.
    // S654: start_month comes back as text — pg's Date for a DATE column
    // stringifies as "Thu Oct 01", which never matched the typed 'YYYY-MM-DD',
    // so a re-run cancelled the matching record and wrote a fresh one.
    const existing = (await client.query<any>(
      `SELECT id, purchase_document_id, sale_price, down_payment, annual_interest_rate, term_months,
              to_char(start_month, 'YYYY-MM-DD') AS start_month, plan_type
         FROM home_sale_contracts WHERE unit_id = $1 AND status = 'pending_signature' FOR UPDATE`, [doc.unit_id])).rows[0]
    let contract: any = null
    if (existing && existing.purchase_document_id === documentId && sameSaleTerms(existing, terms)) {
      contract = (await client.query<any>(`SELECT * FROM home_sale_contracts WHERE id = $1`, [existing.id])).rows[0]
    } else {
      if (existing) {
        await client.query(`UPDATE home_sale_contracts SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [existing.id])
      }
      contract = await createHomeSaleContract(client, {
        unitId: doc.unit_id, leaseId: null, tenantId: buyer.id, landlordId: doc.landlord_id,
        salePrice: terms.salePrice, downPayment: terms.downPayment, annualInterestRate: terms.annualInterestRate,
        termMonths: terms.termMonths, startMonth: terms.startMonth, planType: terms.planType, pendingSignature: true,
      })
      await client.query(`UPDATE home_sale_contracts SET purchase_document_id = $2, updated_at = NOW() WHERE id = $1`, [contract.id, documentId])
    }

    // The derived boxes, printed from the record.
    const financed = Number(contract.financed_amount)
    const { schedule } = computeAmortization(financed, terms.annualInterestRate, terms.termMonths)
    const last = schedule[schedule.length - 1]
    const lastMonth = (() => { const d = new Date(terms.startMonth + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + terms.termMonths - 1); return d })()
    const derived: Record<string, string> = {
      sale_financed_amount:      financed.toFixed(2),
      sale_final_payment_amount: Number(last?.amount ?? contract.monthly_payment).toFixed(2),
      sale_final_payment_month:  `${lastMonth.getUTCMonth() + 1}/1/${lastMonth.getUTCFullYear()}`,
    }
    for (const [col, val] of Object.entries(derived)) {
      await client.query(`UPDATE lease_document_fields SET value = $3 WHERE document_id = $1 AND lease_column = $2`, [documentId, col, val])
    }
    await client.query('COMMIT')
    return { contractId: contract.id }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
}
