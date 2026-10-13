import type { PoolClient } from 'pg'
import { appendEvent } from './creditLedger'
import type { CreditEventType, CreditAttestationSource } from '@gam/shared'
import { recomputeAndSnapshot } from './creditScore'
import { dateIn } from '../lib/timezone'
import { logger } from '../lib/logger'
// The one lateness rule (10/12): services/lateness, re-exported by openBalances.
import { lastGraceDay, PART_PAID_REST_NOTE, PART_PAYMENT_REST_NOTE } from './lateness'

// ============================================================
// Credit-ledger emitters: thin wrappers that compute the right
// event_type + dimension_tags + visibility for each workflow
// trigger and call appendEvent.
//
// Each emitter accepts an existing PoolClient so the ledger write
// is part of the same transaction as the workflow that triggered
// it (payment settlement, lease materialization, etc.).
// ============================================================

/**
 * Classify a settled rent/utility payment into one of the five
 * payment-event tiers. Comparison basis: CALENDAR DAYS where the property
 * is. due_date is a calendar day, so the payment's settle instant is turned
 * into the property's own date before it is compared.
 *
 * S654: this used to end the due day at 23:59:59 UTC — 4:59 pm in Phoenix —
 * so rent that settled between 5 pm and midnight on its due date was put on
 * the tenant's credit record one tier late.
 *
 * 10/12 (Nic): "First LATE day = due/lateness-start + grace days (rent due the
 * 1st, 5-day grace → the 6th is late, the day late fees start)." The grace
 * days are the due day and the days after it up to the 5th; the 6th is 1 day
 * past grace. Before this the 6th read "within grace" here while the late fee
 * was already charged that night (jobs/lateFees). The boundary itself lives in
 * services/lateness (lastGraceDay; re-exported by openBalances), the one
 * lateness rule.
 *
 * Tier boundaries (all in days on the property's calendar; `dueDate` is the
 * day lateness counts from — lateCountsFrom):
 *   on_time:     paid on or before due_date
 *   late_grace:  paid after due_date, on or before the last grace day
 *                (due_date + grace_days − 1; never before due_date)
 *   late_minor:  1–3 days past the last grace day
 *   late_major:  4–15 days past the last grace day
 *   late_severe: more than 15 days past the last grace day
 */
export function classifyPaymentTier(args: {
  /** 'YYYY-MM-DD' (preferred — select due_date::text), or a Date read by its UTC day. */
  dueDate: Date | string
  settledAt: Date
  graceDays: number
  /** The property's zone (properties.timezone). Missing → Phoenix. */
  propertyTz?: string | null
}): CreditEventType {
  const due = calendarDay(args.dueDate)
  // S654: an unrecognized zone reads on Phoenix's calendar, with a warning
  // (dayAtProperty): a throw here would undo the whole settlement.
  const paid = dayAtProperty(args.propertyTz, args.settledAt, true)
  if (paid <= due) return 'payment_received_on_time'
  const lastGrace = lastGraceDay(due, args.graceDays)
  if (paid <= lastGrace) return 'payment_received_late_grace'
  const daysPastGrace = daysBetween(lastGrace, paid)
  if (daysPastGrace <= 3) return 'payment_received_late_minor'
  if (daysPastGrace <= 15) return 'payment_received_late_major'
  return 'payment_received_late_severe'
}

/**
 * An instant as a calendar day where the property is. S654: an unrecognized
 * zone (e.g. 'Arizona' typed on a CSV import) makes Intl throw; this runs
 * inside the settle transaction, so a throw would undo the whole settlement on
 * every retry. Read it on Phoenix's calendar instead (and, with `warn`, log it
 * so the bad zone gets fixed).
 */
function dayAtProperty(propertyTz: string | null | undefined, at: Date, warn = false): string {
  try {
    return dateIn(propertyTz, at)
  } catch {
    if (warn) logger.warn({ propertyTz }, '[credit-ledger] property timezone not recognized; payment tier read on Phoenix time')
    return dateIn(null, at)
  }
}

/**
 * The day a payment's lateness counts from: its due date, or the day GAM wrote
 * the bill when that is later (a bill cannot be paid before it exists) — but
 * only when the bill was written on or before the day the money came in. A row
 * written AFTER its money arrived is a record of an older bill (history
 * recorded later: an import, a backfill, the desk writing up a payment it took
 * earlier), so it counts from its due date; otherwise a late payment recorded
 * later would read as on time. THE rule, for the emitter and the correction of
 * marks written before it.
 */
export function lateCountsFrom(dueDay: string, writtenOn: string | null, paidDay: string): string {
  return writtenOn != null && writtenOn > dueDay && writtenOn <= paidDay ? writtenOn : dueDay
}

/**
 * S652 (Nic): the onboarding month — the month of the first rent charge on an
 * existing-tenancy lease (a household moved onto GAM mid-tenancy). Positive
 * marks only there. 10/6 (Nic): exported so the late-fee delete
 * (services/lateFeeDelete) judges "the onboarding bill" by this same rule.
 * 10/12 (Nic): voided rent never decides which month that was — a rent row
 * written and voided before the real first bill made the voided month the
 * onboarding month (the bill-mark rule reads it the same way: creditBillMarks).
 * Nor does rent imported from another platform: "health starts with the first
 * bill GAM wrote" — an imported July row made July the onboarding month, so
 * the real first GAM month (paid late, no late fee) lost its protection and
 * the late-fee delete judged the wrong bill.
 */
export async function isOnboardingMonthCharge(client: Pick<PoolClient, 'query'>, paymentId: string): Promise<boolean> {
  const { rows } = await client.query<{ onboarding: boolean }>(
    `SELECT l.is_existing_tenancy
            AND date_trunc('month', p.due_date) = (
              SELECT date_trunc('month', MIN(p2.due_date)) FROM payments p2
               WHERE p2.lease_id = l.id AND p2.type = 'rent' AND p2.status <> 'voided'
                 AND p2.import_source IS NULL) AS onboarding
       FROM payments p JOIN leases l ON l.id = p.lease_id
      WHERE p.id = $1`, [paymentId])
  return rows[0]?.onboarding === true
}

/**
 * The notes written on the rest of a row paid in part (an old balance paid
 * down; a bill a part payment did not cover): that row carries over a bill
 * written earlier, it is not a new one. Defined with the lateness rule
 * (services/lateness, 10/12) and re-exported here for their writers.
 */
export { PART_PAID_REST_NOTE, PART_PAYMENT_REST_NOTE }

/**
 * S654: a due date as 'YYYY-MM-DD'. A string is taken as is. A Date is read
 * by its UTC day: that is the right day for node-pg's local-midnight DATE on
 * GAM's hosts (Phoenix and UTC) and for `new Date('YYYY-MM-DD')`.
 */
function calendarDay(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)
}

/** Whole calendar days from one 'YYYY-MM-DD' to a later one. */
function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000)
}

// ─── The payment history: ONE MARK PER BILL (10/12, Nic) ─────────────────────
//
// "the payment history should be a health percentage. one mark per invoice."
//
// Every payment-history writer below brings the BILL's mark to what the
// payment-health rule gives it (services/creditBillMarks), inside the
// caller's transaction. Before 10/12 each rent and utility row carried its own
// mark, rated here from the day and the arguments the caller passed (the day
// it settled, a late fee on the bill, a bank-validated day); the bill's own
// records decide now — the day each line was paid (a matched bank deposit's
// day first, then the receipt's postmark, then the day it settled), the day
// GAM wrote it, the grace chain, work trade, the onboarding month — exactly as
// the Rent Roll and every payment-health screen judge the same bill. A late
// fee on the bill never decides the mark (it only lets an onboarding-month bill
// count, 10/6). A row on no invoice has no bill, so no mark.
//
// The modules load lazily: creditBillMarks reads the payment-health rule
// (householdMonths → openBalances → creditUse → settleHooks), and settleHooks
// imports this file.
async function billMarks(): Promise<typeof import('./creditBillMarks')> {
  return import('./creditBillMarks')
}

/**
 * A rent or utility row settled (the card or bank webhook, the desk, credit,
 * the whole-bill rule, a bank match, a work-trade close — services/settleHooks
 * and the work-trade jobs): its bill's payment-history mark is brought to what
 * the rule gives the bill now, in the settle's own transaction (the mark moves
 * with the money). The arguments besides the row are no longer read — the
 * bill's records decide (see above); they stay so the callers need not change.
 * Run for every row of one bill, it writes the bill's mark once.
 */
export async function emitPaymentSettledEvent(
  client: PoolClient,
  args: {
    tenantId: string
    paymentId: string
    paymentType: 'rent' | 'utility'
    amount: string | number
    /** 'YYYY-MM-DD' preferred (S654); a Date is read by its UTC day. */
    dueDate: Date | string
    settledAt: Date
    graceDays: number | null
    stripePaymentIntentId: string | null
    propertyTz?: string | null
    attestationSource?: CreditAttestationSource
    attestationEvidence?: Record<string, unknown>
    lateFeeOnBill?: boolean
    moneyPaidAt?: Date | null
    bankValidated?: boolean
  },
): Promise<void> {
  const { syncBillMarksForPayments } = await billMarks()
  await syncBillMarksForPayments(client, [args.paymentId])
}

/**
 * The settle routine's step (services/settleHooks afterRowsSettled): the bills
 * of every row the transaction just settled are judged once, together, and
 * each bill's one mark brought to what the rule gives it. Returns what
 * changed (one entry per bill whose mark was written, corrected or withdrawn).
 */
export async function syncBillMarksAfterSettle(
  client: PoolClient, paymentIds: readonly string[], opts: { bankValidated?: boolean } = {},
): Promise<import('./creditBillMarks').BillMarkChange[]> {
  if (paymentIds.length === 0) return []
  const { syncBillMarksForPayments } = await billMarks()
  // A matched bank line pays these rows (bankDepositConfirm): their settled day
  // is the bank's, written before the match's allocation rows are.
  return syncBillMarksForPayments(client, paymentIds, opts.bankValidated ? { bankValidatedIds: paymentIds } : {})
}

/** Each charge row → the bill it is on (creditBillMarks.billKeyOfPayments; for the settle routine). */
export async function billKeysOfPayments(client: PoolClient, paymentIds: readonly string[]): Promise<Map<string, string>> {
  const { billKeyOfPayments } = await billMarks()
  return billKeyOfPayments(client, paymentIds)
}

/**
 * 10/6 (Nic) — the landlord deleted the late fee(s) on an onboarding bill. With
 * no late fee left on it, an onboarding-month bill paid late earns no mark
 * (good news only), so its mark is withdrawn; one paid on time keeps its good
 * mark. The bill is judged again by the rule (creditBillMarks), inside the
 * caller's transaction. Returns the credit subjects changed (the caller
 * recomputes their scores after its commit).
 */
export async function reRateMarksWithoutLateFee(client: PoolClient, invoiceId: string): Promise<string[]> {
  const { syncBillMarks } = await billMarks()
  const changes = await syncBillMarks(client, [invoiceId])
  return [...new Set(changes.flatMap(c => c.subjectIds))]
}

/** What reRateMarksFromBankDate did to one bill, so its Undo can put the bill back. */
export interface BankDateMarkCorrection {
  /** The first of the matched rows on the bill (records before 10/12 carry one per row). */
  paymentId: string
  /** 10/12: every matched row on the bill. */
  paymentIds?: string[]
  /** 10/12: the bill's invoice (none: a charge on no invoice). */
  invoiceId?: string
  /** The bill's mark it replaced (null: none). */
  replacedEventId: string | null
  /** The mark it wrote (null: the bill's mark was withdrawn). */
  eventId: string | null
  was: CreditEventType | null
  now: CreditEventType | null
  subjectId: string
}

/**
 * 10/6 (Nic, "Yes, build it") — a bank line the landlord logged by hand is now
 * matched to the rows it paid (services/recordedDepositMatch): "It's
 * determined by the matching transaction from the bank log." The bank's day
 * (`paidOn`) is each row's paid day — before the match's allocation rows are
 * written, so it is passed in — and each bill those rows are on is judged
 * again by the rule. Inside the caller's transaction. Returns one entry per
 * bill whose mark changed; run twice, the second run changes nothing.
 */
export async function reRateMarksFromBankDate(
  client: PoolClient, a: { paymentIds: readonly string[]; paidOn: string },
): Promise<BankDateMarkCorrection[]> {
  if (a.paymentIds.length === 0) return []
  const { syncBillMarks, billKeyOfPayments } = await billMarks()
  const keyOf = await billKeyOfPayments(client, a.paymentIds)
  const bankDays: Record<string, string> = {}
  for (const id of a.paymentIds) bankDays[id] = a.paidOn
  const changes = await syncBillMarks(client, [...new Set(keyOf.values())], { bankDays })
  return changes.map(c => {
    const ids = [...keyOf].filter(([, k]) => k === c.billKey).map(([id]) => id).sort()
    return {
      paymentId: ids[0], paymentIds: ids, invoiceId: c.invoiceId ?? undefined,
      replacedEventId: c.supersededIds[0] ?? null, eventId: c.eventId,
      was: c.was ?? (c.wasLines.length ? c.wasLines[c.wasLines.length - 1] : null), now: c.now,
      subjectId: c.subjectIds[0],
    }
  })
}

/**
 * Undo of reRateMarksFromBankDate (the bank match it ran for was undone): the
 * bills of the rows it matched are judged again without that bank match —
 * called before the match's allocation rows are reversed, so those rows' bank
 * days are not read. Records written before 10/12 (one per row) and after
 * (one per bill) both work. Inside the caller's transaction; returns the
 * credit subjects changed.
 */
export async function undoBankDateMarks(
  client: PoolClient, corrections: readonly BankDateMarkCorrection[],
): Promise<string[]> {
  const paymentIds = [...new Set(corrections.flatMap(c => c.paymentIds ?? [c.paymentId]).filter(Boolean))]
  if (paymentIds.length === 0) return []
  const { syncBillMarksForPayments } = await billMarks()
  const changes = await syncBillMarksForPayments(client, paymentIds, { ignoreBankFor: paymentIds })
  return [...new Set(changes.flatMap(c => c.subjectIds))]
}

/** What correctMarkForLateFeeOnBill did to one row's bill. */
export interface LateFeeMarkCorrection {
  paymentId: string
  action: 'corrected' | 'written' | 'unchanged' | 'skipped'
  was: CreditEventType | null
  now: CreditEventType | null
  subjectId: string | null
  eventId: string | null
}

/**
 * 10/6 (Nic) — scripts/oct6_fix_reversed_late_fees put a reversed late fee's
 * row back on its bill; its bill's mark is brought to what the rule gives it
 * (creditBillMarks, inside the caller's transaction). 'skipped': the row is on
 * no bill; 'unchanged': the bill's mark was already right.
 */
export async function correctMarkForLateFeeOnBill(
  client: PoolClient, a: { paymentId: string; recordedAt: Date },
): Promise<LateFeeMarkCorrection> {
  const { syncBillMarks, billsOfPayments, planBillMarks } = await billMarks()
  const bills = await billsOfPayments(client, [a.paymentId])
  if (bills.length === 0) {
    return { paymentId: a.paymentId, action: 'skipped', was: null, now: null, subjectId: null, eventId: null }
  }
  const [change] = await syncBillMarks(client, bills)
  if (!change) {
    const [plan] = await planBillMarks(client, bills)
    return {
      paymentId: a.paymentId, action: 'unchanged', was: plan?.current?.eventType ?? null, now: plan?.current?.eventType ?? null,
      subjectId: plan?.current?.subjectId ?? null, eventId: plan?.current?.id ?? null,
    }
  }
  return {
    paymentId: a.paymentId, action: change.action === 'write' ? 'written' : 'corrected',
    was: change.was, now: change.now, subjectId: change.subjectIds[0] ?? null, eventId: change.eventId,
  }
}

/** Recompute the scores of the credit subjects whose marks a correction changed (after its commit). */
export async function recomputeScoresAfterCorrection(subjectIds: Iterable<string>): Promise<void> {
  for (const subjectId of new Set(subjectIds)) {
    try {
      await recomputeAndSnapshot(subjectId)
    } catch (err) {
      logger.error({ err, subjectId }, '[credit-ledger] score recompute after a mark correction failed; the nightly run will pick it up')
    }
  }
}

/**
 * A rent or utility payment failed (the Stripe webhook: an ACH return, a
 * declined card). 10/12 (Nic): "one mark per invoice" — a failed attempt is no
 * longer its own mark (payment_failed_nsf); its bill's mark shows what came of
 * it (paid late, partly paid, or still unpaid past grace). The bill is judged
 * again here: money that was clearing on it is not any more. The arguments
 * besides the row are no longer read.
 *
 * The CALLER'S CLIENT MUST BE IN A TRANSACTION (10/12, review): the household
 * lock this takes and appendEvent's subject lock are transaction-scoped — on
 * a client with no BEGIN each is released at the end of its own statement, so
 * a webhook racing a settle for the same household could fork the hash chain
 * or leave two live marks. Returns what changed; the caller refreshes those
 * subjects' scores after its commit (recomputeScoresAfterCorrection).
 */
export async function emitPaymentFailedEvent(
  client: PoolClient,
  args: {
    tenantId: string
    paymentId: string
    paymentType: 'rent' | 'utility'
    amount: string | number
    /** 'YYYY-MM-DD' preferred (S654); a Date is read by its UTC day. */
    dueDate: Date | string
    failedAt: Date
    stripePaymentIntentId: string | null
    failureCode: string | null
    failureMessage: string | null
  },
): Promise<import('./creditBillMarks').BillMarkChange[]> {
  const { syncBillMarksForPayments } = await billMarks()
  return syncBillMarksForPayments(client, [args.paymentId])
}

/**
 * Emit a lease_signed event for one tenant subject. Each tenant signer
 * gets their own event; the landlord event is emitted separately
 * (once per lease, not once per tenant) via emitLeaseSignedLandlord.
 */
export async function emitLeaseSignedTenant(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    documentId: string
    signedAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'lease_signed',
      eventData: {
        lease_id: args.leaseId,
        document_id: args.documentId,
        signed_at: args.signedAt.toISOString(),
      },
      occurredAt: args.signedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_document_id: args.documentId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit a single lease_signed event on the landlord subject — one per
 * lease, regardless of how many tenants signed it.
 */
export async function emitLeaseSignedLandlord(
  client: PoolClient,
  args: {
    landlordId: string
    leaseId: string
    documentId: string
    signedAt: Date
    tenantCount: number
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'lease_signed',
      eventData: {
        lease_id: args.leaseId,
        document_id: args.documentId,
        signed_at: args.signedAt.toISOString(),
        tenant_count: args.tenantCount,
      },
      occurredAt: args.signedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_document_id: args.documentId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit inspection-finalized events. Called from the inspection-finalize
 * route once both tenant and landlord have signed off.
 *
 * Move-in finalize emits:
 *   - move_in_inspection_completed (tenant subject)
 *   - unit_ready_on_move_in_date (landlord subject) when conducted
 *     within 1 day of the lease start_date
 *   - move_in_photos_submitted (tenant subject) if any photos attached
 *
 * Move-out finalize emits:
 *   - move_out_inspection_completed (tenant subject)
 *   - one of move_out_condition_matches_move_in OR
 *     move_out_condition_damage_documented (tenant subject) per the
 *     comparison-inspection result
 *   - move_out_photos_submitted (tenant subject) if any photos attached
 */
export async function emitInspectionFinalizedEvents(
  client: PoolClient,
  args: {
    inspectionType: 'move_in' | 'move_out' | 'periodic'
    tenantId: string | null
    landlordId: string
    inspectionId: string
    finalizedAt: Date
    photoCount: number
    leaseStartDate?: Date | null
    matchesMoveIn?: boolean
    damageDocumented?: boolean
  },
): Promise<void> {
  if (args.inspectionType === 'periodic') return
  const evidence = { inspection_id: args.inspectionId }

  if (args.inspectionType === 'move_in' && args.tenantId) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: args.tenantId,
        eventType: 'move_in_inspection_completed',
        eventData: {
          inspection_id: args.inspectionId,
          finalized_at: args.finalizedAt.toISOString(),
        },
        occurredAt: args.finalizedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['property_care', 'tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )

    if (args.photoCount > 0) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_in_photos_submitted',
          eventData: { inspection_id: args.inspectionId, photo_count: args.photoCount },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }

    // Landlord-side: unit_ready_on_move_in_date when finalized close to
    // the lease start. We treat "close" as ±1 calendar day; the tenant
    // attesting via signature is what makes this a landlord-positive
    // event.
    if (args.leaseStartDate) {
      const dayMs = 24 * 3_600_000
      const delta = Math.abs(args.finalizedAt.getTime() - args.leaseStartDate.getTime())
      if (delta <= dayMs) {
        await appendEvent(
          {
            subjectType: 'landlord',
            subjectRefId: args.landlordId,
            eventType: 'unit_ready_on_move_in_date',
            eventData: {
              inspection_id: args.inspectionId,
              finalized_at: args.finalizedAt.toISOString(),
              lease_start_date: args.leaseStartDate.toISOString(),
            },
            occurredAt: args.finalizedAt,
            attestationSource: 'gam_workflow_auto',
            attestationEvidence: evidence,
            dimensionTags: ['property_care', 'cooperation'],
            networkVisibility: 'visible_to_current_landlord',
          },
          client,
        )
      }
    }
  }

  if (args.inspectionType === 'move_out' && args.tenantId) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: args.tenantId,
        eventType: 'move_out_inspection_completed',
        eventData: {
          inspection_id: args.inspectionId,
          finalized_at: args.finalizedAt.toISOString(),
        },
        occurredAt: args.finalizedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['property_care', 'tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )

    if (args.photoCount > 0) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_out_photos_submitted',
          eventData: { inspection_id: args.inspectionId, photo_count: args.photoCount },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }

    if (args.matchesMoveIn) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_out_condition_matches_move_in',
          eventData: { inspection_id: args.inspectionId },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    } else if (args.damageDocumented) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_out_condition_damage_documented',
          eventData: { inspection_id: args.inspectionId },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_gam_network',
        },
        client,
      )
    }
  }
}

/**
 * Emit tenancy_ended_with_balance for the tenant subject. Fired by a
 * post-termination detector when the tenant has unsettled invoices
 * for the terminated lease.
 */
export async function emitTenancyEndedWithBalanceEvent(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    expectedTotal: number
    receivedTotal: number
    delta: number
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'tenancy_ended_with_balance',
      eventData: {
        lease_id: args.leaseId,
        expected_total: args.expectedTotal,
        received_total: args.receivedTotal,
        delta: args.delta,
        settlement_status: 'unpaid',
      },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: { lease_id: args.leaseId },
      dimensionTags: ['payment_reliability', 'tenancy_stability'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit balance_paid_post_move for the tenant subject. Fired when a
 * previously-flagged outstanding balance returns to zero post-termination.
 */
export async function emitBalancePaidPostMoveEvent(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'balance_paid_post_move',
      eventData: { lease_id: args.leaseId },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: { lease_id: args.leaseId },
      dimensionTags: ['payment_reliability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit lease_terminated_natural events for every active tenant on the
 * lease + a single landlord event. Fires from processLeaseEnds when
 * a lease ends without auto-renew (natural expiry).
 */
export async function emitLeaseTerminatedNaturalEvents(
  client: PoolClient,
  args: {
    leaseId: string
    landlordId: string
    tenantIds: string[]
    terminatedAt: Date
  },
): Promise<void> {
  const evidence = { lease_id: args.leaseId }
  for (const tid of args.tenantIds) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: tid,
        eventType: 'lease_terminated_natural',
        eventData: { lease_id: args.leaseId, terminated_at: args.terminatedAt.toISOString() },
        occurredAt: args.terminatedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_gam_network',
      },
      client,
    )
  }
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'lease_terminated_natural',
      eventData: { lease_id: args.leaseId, terminated_at: args.terminatedAt.toISOString() },
      occurredAt: args.terminatedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: evidence,
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit lease_renewed events when auto-renewal fires (extend_same_term
 * branch of processLeaseEnds). Per-tenant + single landlord event.
 */
export async function emitLeaseRenewedEvents(
  client: PoolClient,
  args: {
    leaseId: string
    landlordId: string
    tenantIds: string[]
    renewedAt: Date
  },
): Promise<void> {
  const evidence = { lease_id: args.leaseId }
  for (const tid of args.tenantIds) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: tid,
        eventType: 'lease_renewed',
        eventData: { lease_id: args.leaseId, renewed_at: args.renewedAt.toISOString() },
        occurredAt: args.renewedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )
  }
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'lease_renewed',
      eventData: { lease_id: args.leaseId, renewed_at: args.renewedAt.toISOString() },
      occurredAt: args.renewedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: evidence,
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit lease_anniversary events on a tenant subject. Fired by an annual
 * detector cron — once per (lease_id, anniversary_year). Caller ensures
 * idempotency by checking the chain for an existing event with matching
 * event_data.anniversary_year.
 */
export async function emitLeaseAnniversaryEvent(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    anniversaryYear: number
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'lease_anniversary',
      eventData: {
        lease_id: args.leaseId,
        anniversary_year: args.anniversaryYear,
      },
      occurredAt: args.occurredAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_id: args.leaseId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit entry-request events when the tenant grants or denies access.
 * Both pieces are simultaneously visible:
 *   - tenant scores entry_request_granted_within_window when the
 *     decision is granted AND the response landed before the proposed
 *     window started (tenant cooperated in time)
 *   - tenant emits entry_request_denied (no score; denial is a right)
 */
export async function emitEntryRequestResponseEvents(
  client: PoolClient,
  args: {
    tenantId: string
    requestId: string
    decision: 'granted' | 'denied'
    respondedAt: Date
    proposedWindowStart: Date
  },
): Promise<void> {
  if (args.decision === 'granted') {
    const respondedInTime = args.respondedAt.getTime() < args.proposedWindowStart.getTime()
    if (respondedInTime) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'entry_request_granted_within_window',
          eventData: {
            entry_request_id: args.requestId,
            responded_at: args.respondedAt.toISOString(),
          },
          occurredAt: args.respondedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: { entry_request_id: args.requestId },
          dimensionTags: ['cooperation'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }
    return
  }
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'entry_request_denied',
      eventData: {
        entry_request_id: args.requestId,
        responded_at: args.respondedAt.toISOString(),
      },
      occurredAt: args.respondedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { entry_request_id: args.requestId },
      dimensionTags: ['cooperation'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit landlord-side entry-record events. Called when the landlord
 * posts the actual entry moment. Logic:
 *   - within proposed window AND request status was 'granted'
 *     → proper_entry_notice_given (+25, full trust)
 *   - outside proposed window OR no grant
 *     → entry_compliance_breach (-10%, network visible)
 */
export async function emitEntryRecordedEvents(
  client: PoolClient,
  args: {
    landlordId: string
    requestId: string
    enteredAt: Date
    proposedWindowStart: Date
    proposedWindowEnd: Date
    grantedDecision: 'granted' | 'denied' | null
  },
): Promise<{ outcome: 'compliant' | 'breach' }> {
  const within =
    args.enteredAt.getTime() >= args.proposedWindowStart.getTime() &&
    args.enteredAt.getTime() <= args.proposedWindowEnd.getTime()
  const compliant = within && args.grantedDecision === 'granted'

  if (compliant) {
    await appendEvent(
      {
        subjectType: 'landlord',
        subjectRefId: args.landlordId,
        eventType: 'proper_entry_notice_given',
        eventData: {
          entry_request_id: args.requestId,
          entered_at: args.enteredAt.toISOString(),
        },
        occurredAt: args.enteredAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: { entry_request_id: args.requestId },
        dimensionTags: ['cooperation'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )
    return { outcome: 'compliant' }
  }

  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'entry_compliance_breach',
      eventData: {
        entry_request_id: args.requestId,
        entered_at: args.enteredAt.toISOString(),
        within_window: within,
        granted_decision: args.grantedDecision,
      },
      occurredAt: args.enteredAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { entry_request_id: args.requestId },
      dimensionTags: ['cooperation'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
  return { outcome: 'breach' }
}

/**
 * Emit recurring_repair_same_issue against the landlord subject.
 * Caller (the daily detector cron) determines the duplicate set;
 * this just persists the event with the prior+current request ids.
 */
export async function emitRecurringRepairEvent(
  client: PoolClient,
  args: {
    landlordId: string
    priorRequestId: string
    currentRequestId: string
    category: string
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'recurring_repair_same_issue',
      eventData: {
        prior_request_id: args.priorRequestId,
        current_request_id: args.currentRequestId,
        category: args.category,
      },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: {
        prior_request_id: args.priorRequestId,
        current_request_id: args.currentRequestId,
      },
      dimensionTags: ['property_care'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit habitability_complaint_unresolved_30d. Idempotency is handled
 * by the caller (the detector cron checks if a previous emission exists
 * for the same request_id before firing).
 */
export async function emitHabitabilityUnresolvedEvent(
  client: PoolClient,
  args: {
    landlordId: string
    requestId: string
    category: string
    daysOpen: number
    detectedAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'habitability_complaint_unresolved_30d',
      eventData: {
        maintenance_request_id: args.requestId,
        category: args.category,
        days_open: args.daysOpen,
      },
      occurredAt: args.detectedAt,
      attestationSource: 'system_derived',
      attestationEvidence: { maintenance_request_id: args.requestId },
      dimensionTags: ['property_care'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit multi_landlord_history_clean against the tenant subject. One-time
 * (lifetime) event per tenant — the detector keeps it idempotent.
 */
export async function emitMultiLandlordHistoryCleanEvent(
  client: PoolClient,
  args: {
    tenantId: string
    landlordCount: number
    cleanLeaseCount: number
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'multi_landlord_history_clean',
      eventData: {
        distinct_landlord_count: args.landlordCount,
        clean_lease_count: args.cleanLeaseCount,
      },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: {
        distinct_landlord_count: args.landlordCount,
        clean_lease_count: args.cleanLeaseCount,
      },
      dimensionTags: ['tenancy_stability', 'community_fit'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Classify maintenance resolution speed into a tier. Default SLA
 * window is 7 days end-to-end; future per-landlord SLA configuration
 * can be threaded through the slaHours arg.
 */
export function classifyMaintenanceTier(args: {
  createdAt: Date
  resolvedAt: Date
  slaHours?: number
}): 'within_24h' | 'within_72h' | 'within_sla' | 'breach_sla' {
  const sla = args.slaHours ?? 24 * 7
  const elapsedHours =
    (args.resolvedAt.getTime() - args.createdAt.getTime()) / 3_600_000
  if (elapsedHours <= 24) return 'within_24h'
  if (elapsedHours <= 72) return 'within_72h'
  if (elapsedHours <= sla) return 'within_sla'
  return 'breach_sla'
}

/**
 * Emit maintenance events at status transition. Submission and
 * acknowledgment are NOT emitted (informational only per the locked
 * "score outcomes, not unilateral actions" rule).
 *
 * Resolution emits:
 *   - landlord-side: maintenance_response_within_sla / 24h / 72h /
 *     breach_sla based on time-to-first-response (caller passes
 *     the tier classification — this service stays free of the
 *     SLA-config lookup).
 *   - tenant-side resolution_confirmed fires LATER, when the tenant
 *     confirms the fix held (separate flow).
 */
export async function emitMaintenanceResolvedEvents(
  client: PoolClient,
  args: {
    landlordId: string
    requestId: string
    resolvedAt: Date
    responseTier: 'within_24h' | 'within_72h' | 'within_sla' | 'breach_sla'
  },
): Promise<void> {
  const tierMap: Record<typeof args.responseTier, CreditEventType> = {
    within_24h: 'maintenance_response_24h',
    within_72h: 'maintenance_response_72h',
    within_sla: 'maintenance_response_within_sla',
    breach_sla: 'maintenance_response_breach_sla',
  }
  const eventType = tierMap[args.responseTier]
  const visibility =
    args.responseTier === 'breach_sla'
      ? 'visible_to_gam_network'
      : 'visible_to_current_landlord'

  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType,
      eventData: {
        maintenance_request_id: args.requestId,
        resolved_at: args.resolvedAt.toISOString(),
        response_tier: args.responseTier,
      },
      occurredAt: args.resolvedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { maintenance_request_id: args.requestId },
      dimensionTags: ['cooperation', 'property_care'],
      networkVisibility: visibility,
    },
    client,
  )
}
