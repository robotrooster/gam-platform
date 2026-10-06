import type { PoolClient } from 'pg'
import { appendEvent, supersedeEvent } from './creditLedger'
import type { CreditEventType, CreditAttestationSource, CreditScoreDimension } from '@gam/shared'
import { getClient } from '../db'
import { recomputeAndSnapshot } from './creditScore'
import { dateIn, addDaysTo } from '../lib/timezone'
import { logger } from '../lib/logger'

// ============================================================
// Credit-ledger emitters: thin wrappers that compute the right
// event_type + dimension_tags + visibility for each workflow
// trigger and call appendEvent.
//
// Each emitter accepts an existing PoolClient so the ledger write
// is part of the same transaction as the workflow that triggered
// it (payment settlement, lease materialization, etc.).
// ============================================================

const DEFAULT_GRACE_DAYS = 5

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
 * Tier boundaries (all in days on the property's calendar):
 *   on_time:     paid on or before due_date
 *   late_grace:  paid after due_date, on or before due_date + grace_days
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
  const lastGraceDay = addDaysTo(due, args.graceDays)
  if (paid <= lastGraceDay) return 'payment_received_late_grace'
  const daysPastGrace = daysBetween(lastGraceDay, paid)
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
 */
export async function isOnboardingMonthCharge(client: Pick<PoolClient, 'query'>, paymentId: string): Promise<boolean> {
  const { rows } = await client.query<{ onboarding: boolean }>(
    `SELECT l.is_existing_tenancy
            AND date_trunc('month', p.due_date) = (
              SELECT date_trunc('month', MIN(p2.due_date)) FROM payments p2
               WHERE p2.lease_id = l.id AND p2.type = 'rent') AS onboarding
       FROM payments p JOIN leases l ON l.id = p.lease_id
      WHERE p.id = $1`, [paymentId])
  return rows[0]?.onboarding === true
}

/**
 * The note rentCharge and manualPaymentSettle write on the rest of a row that
 * was paid in part (an old balance paid down): that row carries over a bill
 * written earlier, it is not a new one.
 */
export const PART_PAID_REST_NOTE = 'What is left of the old balance after a part payment'

/**
 * 10/5 (Nic): the note manualPaymentSettle writes on the rest of a bill (rent)
 * a part payment did not cover. The rest is its own open row (is_remainder) on
 * the same bill, so late fees keep applying to it; like the rest of an old
 * balance, it carries over the bill it belongs to, so its on-time or late mark
 * — written the day it is paid, i.e. the day the bill is paid in full — counts
 * from that bill.
 */
export const PART_PAYMENT_REST_NOTE = 'What is left of this bill after a part payment'

/**
 * A payment row's kind, and the day GAM wrote the bill it belongs to on the
 * property's calendar (null when the row has no creation time). Null when the
 * row is not found.
 *
 * A bill cannot be paid before it exists, so it cannot be late before then
 * either. A longer stay's rent (bookingLeaseBilling billLongerStay) is written
 * on the day the stay grew but carries its month's own due date; paid that
 * same day it is on time, not weeks late.
 *
 * A row that carries over an older bill counts from that bill, never from the
 * day it was copied: a row reopened after a reversal (it keeps the original due
 * date so late fees count from it), and the rest of a row paid in part. Their
 * bill is the earliest row of the same lease, tenant, type, due date and
 * invoice.
 */
async function billFacts(
  client: PoolClient, paymentId: string, propertyTz: string | null | undefined,
): Promise<{ type: string; writtenOn: string | null } | null> {
  const { rows } = await client.query<{ type: string; written_at: Date | null }>(
    `SELECT p.type, CASE
              WHEN p.reversal_id IS NOT NULL
                OR (p.is_remainder AND (p.notes LIKE ($2 || '%') OR p.notes LIKE ($3 || '%')))
              THEN (SELECT MIN(f.created_at) FROM payments f
                     WHERE f.lease_id IS NOT DISTINCT FROM p.lease_id
                       AND f.tenant_id IS NOT DISTINCT FROM p.tenant_id
                       AND f.type = p.type
                       AND f.due_date = p.due_date
                       AND f.invoice_id IS NOT DISTINCT FROM p.invoice_id
                       AND f.created_at <= p.created_at)
              ELSE p.created_at
            END AS written_at
       FROM payments p
      WHERE p.id = $1`,
    [paymentId, PART_PAID_REST_NOTE, PART_PAYMENT_REST_NOTE])
  const row = rows[0]
  if (!row) return null
  const at = row.written_at
  if (!at) return { type: row.type, writtenOn: null }
  // Same fallback as classifyPaymentTier: a bad zone must not undo the settle.
  return { type: row.type, writtenOn: dayAtProperty(propertyTz, at) }
}

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

/**
 * Emit a payment event from the payment_intent.succeeded webhook.
 * Tags the payment_reliability dimension. Visibility:
 *   - on_time / late_grace → visible_to_current_landlord (positive routine)
 *   - late_* / partial / nsf / skipped → visible_to_gam_network (adverse)
 *
 * Lateness counts from the later of the due date and the day GAM wrote the
 * bill (billFacts), read on the same client. A bill written after its due
 * date (a longer stay's rent, a utility bill written late) gets its grace days
 * from the day it was written; the event then records that day as billed_on.
 * A row written after its money came in counts from its due date
 * (lateCountsFrom): it records an older bill.
 *
 * Only rent and utility rows carry a payment mark (settleHooks writes marks for
 * those alone). A late fee, a fee or a home payment the card or bank webhook
 * settles beside them writes nothing.
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
    /** S654: the property's zone, so "paid on the due date" means that day
     *  where the property is. Missing → Phoenix. */
    propertyTz?: string | null
    /** S652: a cash/check settlement the landlord recorded at the desk is
     *  landlord-attested with the check number as evidence; default Stripe. */
    attestationSource?: CreditAttestationSource
    attestationEvidence?: Record<string, unknown>
  },
): Promise<void> {
  const facts = await billFacts(client, args.paymentId, args.propertyTz)
  if (facts && facts.type !== 'rent' && facts.type !== 'utility') return
  const dueDay = calendarDay(args.dueDate)
  const writtenOn = facts?.writtenOn ?? null
  const countsFrom = lateCountsFrom(dueDay, writtenOn, dayAtProperty(args.propertyTz, args.settledAt))
  const billedLate = countsFrom !== dueDay
  const eventType = classifyPaymentTier({
    dueDate: countsFrom,
    settledAt: args.settledAt,
    graceDays: args.graceDays ?? DEFAULT_GRACE_DAYS,
    propertyTz: args.propertyTz,
  })

  const positive = isPositivePaymentTier(eventType)

  // S652 (Nic): "don't count the onboarding month for anything negative, only
  // positive." A household moved onto GAM mid-tenancy gets its first bill on
  // GAM's terms, not theirs — paying it on time is a good mark, paying it late
  // is nothing. The onboarding month is the month of the first rent charge on
  // an existing-tenancy lease.
  if (!positive && await isOnboardingMonthCharge(client, args.paymentId)) return

  const visibility = positive ? 'visible_to_current_landlord' : 'visible_to_gam_network'

  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType,
      eventData: {
        payment_id: args.paymentId,
        payment_type: args.paymentType,
        amount: typeof args.amount === 'string' ? args.amount : String(args.amount),
        // S654: the due date is a calendar day, recorded as one.
        due_date: dueDay,
        // The bill was written after its due date: lateness counted from this day.
        ...(billedLate ? { billed_on: writtenOn } : {}),
        paid_at: args.settledAt.toISOString(),
        grace_days: args.graceDays ?? DEFAULT_GRACE_DAYS,
      },
      occurredAt: args.settledAt,
      attestationSource: args.attestationSource ?? 'stripe_attested',
      attestationEvidence: args.attestationEvidence
        ?? (args.stripePaymentIntentId ? { stripe_payment_intent_id: args.stripePaymentIntentId } : {}),
      dimensionTags: ['payment_reliability'],
      networkVisibility: visibility,
    },
    client,
  )
}

/** On time or within grace: a good mark the current landlord sees. Anything later is adverse. */
function isPositivePaymentTier(t: CreditEventType): boolean {
  return t === 'payment_received_on_time' || t === 'payment_received_late_grace'
}

const LATE_PAYMENT_TIERS = [
  'payment_received_late_minor', 'payment_received_late_major', 'payment_received_late_severe',
] as const

/** One late mark re-rated from the day its bill was written. */
export interface LateMarkCorrection {
  eventId: string
  /** The mark that replaces it; null on a dry run. */
  correctedEventId: string | null
  tenantId: string
  paymentId: string
  dueDate: string
  billedOn: string
  was: CreditEventType
  now: CreditEventType
}

/**
 * Corrects the late marks already on tenants' credit records for bills GAM
 * wrote after their due date, written before emitPaymentSettledEvent counted
 * lateness from the day the bill was written. A bill paid the day it was
 * written got a late mark the GAM network sees.
 *
 * Each active late mark (late_minor, late_major, late_severe) on a rent or
 * utility row is rated again exactly as the emitter rates a payment today:
 * from the later of the due date and the day the bill was written (billFacts),
 * unless the row was written after the money came in (lateCountsFrom), with
 * the mark's own grace days and payment time. When the tier changes, a
 * corrected mark is appended (same payment, payment time and evidence; it
 * records billed_on and the mark it corrects) and the old mark is superseded
 * with 'data_entry_error_corrected', so scores skip it. The chain is never
 * rewritten. A mark whose tier does not change is left alone, and a mark that
 * already records billed_on was rated under the current rule. A mark that is
 * still late in the household's onboarding month is left alone too: the
 * emitter writes nothing there now, and no late mark is written in its place.
 *
 * Run once at deploy, dry run first. A second run finds nothing. Scores of the
 * tenants whose marks changed are recomputed after the commit (a recompute
 * that fails is logged; the nightly score run picks it up).
 */
export async function correctLateMarksForBillsWrittenLate(
  opts: { dryRun: boolean },
): Promise<LateMarkCorrection[]> {
  const client = await getClient()
  const out: LateMarkCorrection[] = []
  const subjects = new Set<string>()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{
      id: string; event_type: CreditEventType; event_data: Record<string, unknown>; occurred_at: Date
      attestation_source: CreditAttestationSource; attestation_evidence: Record<string, unknown>
      dimension_tags: string[]; subject_id: string; tenant_id: string
      payment_id: string; due_date: string; timezone: string | null
    }>(
      `SELECT e.id, e.event_type, e.event_data, e.occurred_at, e.attestation_source,
              e.attestation_evidence, e.dimension_tags, e.subject_id, s.subject_ref_id AS tenant_id,
              p.id AS payment_id, p.due_date::text AS due_date, pr.timezone
         FROM credit_events e
         JOIN credit_subjects s ON s.id = e.subject_id AND s.subject_type = 'tenant'
         JOIN payments p ON p.id::text = e.event_data->>'payment_id'
         LEFT JOIN units u ON u.id = p.unit_id
         LEFT JOIN properties pr ON pr.id = u.property_id
        WHERE e.superseded_by IS NULL
          AND e.event_type = ANY($1::text[])
          AND NOT (e.event_data ? 'billed_on')
          AND p.type IN ('rent', 'utility')
        ORDER BY e.recorded_at, e.id
        FOR UPDATE OF e`,
      [LATE_PAYMENT_TIERS])
    for (const e of rows) {
      const facts = await billFacts(client, e.payment_id, e.timezone)
      const paidAtRaw = e.event_data.paid_at
      const paidAt = typeof paidAtRaw === 'string' && !Number.isNaN(Date.parse(paidAtRaw))
        ? new Date(paidAtRaw) : e.occurred_at
      // The emitter's own rule: a row written after its money came in records
      // an older bill and keeps counting from its due date.
      const countsFrom = lateCountsFrom(e.due_date, facts?.writtenOn ?? null, dayAtProperty(e.timezone, paidAt))
      if (countsFrom === e.due_date) continue
      const billedOn = countsFrom
      const graceRaw = Number(e.event_data.grace_days)
      const graceDays = Number.isFinite(graceRaw) ? graceRaw : DEFAULT_GRACE_DAYS
      const now = classifyPaymentTier({ dueDate: billedOn, settledAt: paidAt, graceDays, propertyTz: e.timezone })
      if (now === e.event_type) continue
      // Still late in the onboarding month: the emitter writes no mark at all
      // there now (S652), so a late mark is never written in its place. The
      // old mark stays as it is (the ledger has no way to withdraw a mark
      // without a replacement).
      if (!isPositivePaymentTier(now) && await isOnboardingMonthCharge(client, e.payment_id)) continue

      let correctedEventId: string | null = null
      if (!opts.dryRun) {
        const corrected = await appendEvent(
          {
            subjectType: 'tenant',
            subjectRefId: e.tenant_id,
            eventType: now,
            eventData: { ...e.event_data, due_date: e.due_date, billed_on: billedOn, corrects_event_id: e.id },
            occurredAt: e.occurred_at,
            attestationSource: e.attestation_source,
            attestationEvidence: e.attestation_evidence,
            dimensionTags: e.dimension_tags as CreditScoreDimension[],
            networkVisibility: isPositivePaymentTier(now) ? 'visible_to_current_landlord' : 'visible_to_gam_network',
          },
          client,
        )
        correctedEventId = corrected.eventId
        await supersedeEvent(client, e.id, corrected.eventId, 'data_entry_error_corrected')
        subjects.add(e.subject_id)
      }
      out.push({
        eventId: e.id, correctedEventId, tenantId: e.tenant_id, paymentId: e.payment_id,
        dueDate: e.due_date, billedOn, was: e.event_type, now,
      })
    }
    await client.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  if (subjects.size > 0) {
    for (const subjectId of subjects) {
      try {
        await recomputeAndSnapshot(subjectId)
      } catch (err) {
        logger.error({ err, subjectId }, '[credit-ledger] score recompute after a late-mark correction failed; the nightly run will pick it up')
      }
    }
  }
  return out
}

/**
 * Emit a payment_failed_nsf event when a Stripe ACH payment fails.
 * Distinguished from `payment_skipped` (which fires when a tenant
 * never initiates a payment for a due lease_fee — that's emitted
 * by the late-payment scheduler, not the webhook).
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
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'payment_failed_nsf',
      eventData: {
        payment_id: args.paymentId,
        payment_type: args.paymentType,
        amount: typeof args.amount === 'string' ? args.amount : String(args.amount),
        due_date: calendarDay(args.dueDate),
        failed_at: args.failedAt.toISOString(),
        failure_code: args.failureCode,
        failure_message: args.failureMessage,
      },
      occurredAt: args.failedAt,
      attestationSource: 'stripe_attested',
      attestationEvidence: args.stripePaymentIntentId
        ? { stripe_payment_intent_id: args.stripePaymentIntentId }
        : {},
      dimensionTags: ['payment_reliability'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
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
