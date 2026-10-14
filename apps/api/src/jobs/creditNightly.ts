import { recomputeAllSubjects } from '../services/creditScore'
import { refreshAllSubjectStats } from '../services/creditStats'
import { syncBillMarksNightly } from '../services/creditBillMarks'
import { recordCreditChainCheck, recordChainCheckFailed, type ChainRecordResult } from '../services/creditChainCheck'
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
//   0b. recordCreditChainCheck (10/13, Nic: "ADD the nightly chain check
//      (break flagged in the morning admin email)"): every credit record's
//      chain verified once tonight's marks are written. 10/13 evening (Nic:
//      "fold into the 8:05 MORNING admin email (not its own 3 am email)"):
//      nobody is emailed at 3 am — what it found is written down
//      (credit_chain_check_runs) and the 8:05 morning admin email names any
//      chain broken, or says the check did not run (a check that cannot
//      finish is written down as failed; a quiet morning means every chain is
//      whole). It never stops the scores and stats.
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
  /** The chain check (10/13): chains checked, whole, broken; recorded = written down for the 8:05 morning email. */
  chains: ChainRecordResult
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
  let chains: ChainRecordResult
  try {
    // Never throws by itself (a check that cannot finish is written down as
    // failed); this catch is the backstop for anything unforeseen.
    chains = await recordCreditChainCheck()
  } catch (err) {
    // Checked again tomorrow night; tonight's scores and stats still run, and
    // the 8:05 morning email says the check did not run.
    logger.error({ err }, '[credit-nightly][chains]')
    chains = { subjects: 0, whole: 0, broken: 0, recorded: await recordChainCheckFailed(err), errors: 1 }
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
