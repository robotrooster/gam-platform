import { recomputeAllSubjects } from '../services/creditScore'
import { refreshAllSubjectStats } from '../services/creditStats'
import { syncBillMarksNightly } from '../services/creditBillMarks'
import { logger } from '../lib/logger'

// ============================================================
// Nightly credit-ledger recompute.
//
// Three passes per run, each failure-isolated per bill / subject by its
// service helper:
//   0. syncBillMarksNightly (10/12, Nic: "the payment history should be a
//      health percentage. one mark per invoice."): every bill whose payment
//      history can still change is judged by the payment-health rule and its
//      one mark brought to what the rule gives it — a bill that went past its
//      grace period unpaid gets its "unpaid past grace" mark here (nothing in
//      the database changes when a day passes), a bill paid in full gets its
//      on-time or late mark if no settle wrote it. Runs first, so the scores
//      and stats below read tonight's marks.
//   1. recomputeAllSubjects: snapshots a credit_scores row per subject
//      with active events.
//   2. refreshAllSubjectStats: upserts credit_stats per subject (the
//      payment-health figure the tenant's record and the landlord's
//      screening page show).
//
// Intended cadence: nightly at 3am Phoenix — between the lease-end
// processor (2am) and the background-check expiry (3am, also fine
// to overlap as it's not the same tables).
// ============================================================

export interface NightlyResult {
  bills: { reviewed: number; changed: number; errors: number }
  scores: { processed: number; errors: number }
  stats: { processed: number; errors: number }
}

export async function processCreditNightly(): Promise<NightlyResult> {
  let bills = { reviewed: 0, changed: 0, errors: 0 }
  try {
    const b = await syncBillMarksNightly()
    bills = { reviewed: b.reviewed, changed: b.changed, errors: b.errors }
  } catch (err) {
    // The marks wait for tomorrow; tonight's scores and stats still run.
    logger.error({ err }, '[credit-nightly][bill-marks]')
    bills = { ...bills, errors: bills.errors + 1 }
  }
  const scoreResult = await recomputeAllSubjects()
  for (const e of scoreResult.errors) {
    logger.error({ err: e.error, subject_id: e.subjectId }, '[credit-nightly][score]')
  }
  const statsResult = await refreshAllSubjectStats()
  for (const e of statsResult.errors) {
    logger.error({ err: e.error, subject_id: e.subjectId }, '[credit-nightly][stats]')
  }
  return {
    bills,
    scores: { processed: scoreResult.processed, errors: scoreResult.errors.length },
    stats: { processed: statsResult.processed, errors: statsResult.errors.length },
  }
}
