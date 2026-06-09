import { recomputeAllSubjects } from '../services/creditScore'
import { refreshAllSubjectStats } from '../services/creditStats'
import { logger } from '../lib/logger'

// ============================================================
// Nightly credit-ledger recompute.
//
// Two passes per run, both failure-isolated per subject by their
// service helpers:
//   1. recomputeAllSubjects: snapshots a credit_scores row per subject
//      with active events.
//   2. refreshAllSubjectStats: upserts credit_stats per subject.
//
// Intended cadence: nightly at 3am Phoenix — between the lease-end
// processor (2am) and the background-check expiry (3am, also fine
// to overlap as it's not the same tables).
// ============================================================

export interface NightlyResult {
  scores: { processed: number; errors: number }
  stats: { processed: number; errors: number }
}

export async function processCreditNightly(): Promise<NightlyResult> {
  const scoreResult = await recomputeAllSubjects()
  for (const e of scoreResult.errors) {
    logger.error({ err: e.error, subject_id: e.subjectId }, '[credit-nightly][score]')
  }
  const statsResult = await refreshAllSubjectStats()
  for (const e of statsResult.errors) {
    logger.error({ err: e.error, subject_id: e.subjectId }, '[credit-nightly][stats]')
  }
  return {
    scores: { processed: scoreResult.processed, errors: scoreResult.errors.length },
    stats: { processed: statsResult.processed, errors: statsResult.errors.length },
  }
}
