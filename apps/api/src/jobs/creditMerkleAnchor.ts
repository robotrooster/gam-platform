import { query, getClient } from '../db'
import { computeMerkleRoot } from '../services/creditLedger'

// ============================================================
// Weekly Merkle anchor cron.
//
// Computes the Merkle root over all (non-superseded) credit_events
// and writes a row to credit_merkle_anchors. Empty-ledger weeks
// still record a checkpoint (zero-root + count 0 + null event ids
// permitted by the table) — but we skip the insert when count is 0
// because credit_merkle_anchors.earliest_event_id and latest_event_id
// are NOT NULL. The first non-empty week records the first anchor.
//
// One row per run. Anchored_at = NOW(). External attestation
// (third-party timestamp service / blockchain) is reserved for v2.2;
// external_attestation column stays NULL in v1.
// ============================================================

export interface MerkleAnchorResult {
  anchored: boolean
  event_count: number
  reason?: string
}

export async function processCreditMerkleAnchor(): Promise<MerkleAnchorResult> {
  const result = await computeMerkleRoot()
  if (result.eventCount === 0 || !result.earliestEventId || !result.latestEventId) {
    return { anchored: false, event_count: 0, reason: 'ledger_empty' }
  }

  const client = await getClient()
  try {
    await client.query(
      `INSERT INTO credit_merkle_anchors (
         merkle_root, event_count_at_anchor,
         earliest_event_id, latest_event_id
       ) VALUES ($1, $2, $3, $4)`,
      [result.root, result.eventCount, result.earliestEventId, result.latestEventId],
    )
  } finally {
    client.release()
  }

  return { anchored: true, event_count: result.eventCount }
}

// Re-export query so the index file stays self-contained for future
// helper tooling that wants to read anchor history.
export { query }
