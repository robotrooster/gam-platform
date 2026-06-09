/**
 * Cascade lease_tenants state when a lease_document is voided.
 *
 * Pure data-layer helper. Does NOT touch lease_documents itself — caller
 * is responsible for the lease_documents UPDATE (which varies: void_reason
 * is caller-supplied in the manual void route, fixed string in the auto-void
 * scheduler).
 *
 * Cases:
 *   addendum_add    -> pending_add row becomes 'void' (preserves audit trail)
 *   addendum_remove -> pending_remove row reverts to 'active', clears pointer
 *   addendum_terms  -> no cascade (no lease_tenants side effects)
 *   original_lease  -> no cascade (lease_tenants created on execution only)
 *
 * Querier shape matches both `query` and `client.query` so callers can pass
 * either a transaction client or the raw query function.
 */
type Querier = (sql: string, params?: any[]) => Promise<any>

export async function cascadeLeaseTenantsOnVoid(
  q: Querier,
  doc: { id: string; document_type: string }
): Promise<void> {
  switch (doc.document_type) {
    case 'addendum_add': {
      // The pending_add row (if any) becomes 'void' — preserves audit trail
      // that this tenant tried to join but the addendum was cancelled.
      // Leave add_document_id populated intentionally for auditability.
      await q(
        `UPDATE lease_tenants
           SET status='void', updated_at=NOW()
         WHERE add_document_id=$1 AND status='pending_add'`,
        [doc.id])
      break
    }
    case 'addendum_remove': {
      // The pending_remove row reverts to active. Null out remove_document_id
      // because the row returns to normal and should not carry a stale pointer.
      await q(
        `UPDATE lease_tenants
           SET status='active',
               remove_document_id=NULL,
               updated_at=NOW()
         WHERE remove_document_id=$1 AND status='pending_remove'`,
        [doc.id])
      break
    }
    // addendum_terms + original_lease: no cascade needed
  }
}
