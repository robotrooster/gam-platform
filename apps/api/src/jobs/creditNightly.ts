import { recomputeAllSubjects } from '../services/creditScore'
import { refreshAllSubjectStats } from '../services/creditStats'
import { syncBillMarksNightly } from '../services/creditBillMarks'
import { flagBrokenCreditChains, flagChainCheckFailed, type ChainFlagResult } from '../services/creditChainCheck'
import { logger } from '../lib/logger'

// ============================================================
// Nightly credit-ledger recompute.
//
// Four passes per run, each failure-isolated per bill / subject by its
// service helper:
//   0. syncBillMarksNightly (10/12, Nic: "the payment history should be a
//      health percentage. one mark per invoice."): every bill whose payment
//      history can still change is judged by the payment-health rule and its
//      one mark brought to what the rule gives it — a bill that went past its
//      grace period unpaid gets its "unpaid past grace" mark here (nothing in
//      the database changes when a day passes), a bill paid in full gets its
//      on-time or late mark if no settle wrote it. Runs first, so the scores
//      and stats below read tonight's marks.
//   0b. flagBrokenCreditChains (10/13, Nic: "ADD the nightly chain check
//      (break flagged in the morning admin email)"): every credit record's
//      chain verified once tonight's marks are written; any chain broken is
//      named in one admin email (whose record, the first bad entry), nothing
//      when all are whole. A check that cannot finish sends a "did not run"
//      email instead (10/13, review: a quiet morning means every chain is
//      whole), and never stops the scores and stats.
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
  /** The chain check (10/13): chains checked, whole, broken; sent = tonight's admin email is on record. */
  chains: ChainFlagResult
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
  let chains: ChainFlagResult
  try {
    // Never throws by itself (a check that cannot finish sends its own "did
    // not run" email); this catch is the backstop for anything unforeseen.
    chains = await flagBrokenCreditChains()
  } catch (err) {
    // Checked again tomorrow night; tonight's scores and stats still run, and
    // the admins hear the check did not.
    logger.error({ err }, '[credit-nightly][chains]')
    chains = { subjects: 0, whole: 0, broken: 0, sent: await flagChainCheckFailed(err), errors: 1 }
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
    chains,
    scores: { processed: scoreResult.processed, errors: scoreResult.errors.length },
    stats: { processed: statsResult.processed, errors: statsResult.errors.length },
  }
}
