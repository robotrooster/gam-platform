// Home-ownership tracking (S568, Nic). Who owns a tenant-owned home/RV on a unit
// — the economic sublessor. Owner may be the occupant, an in-park tenant
// investor, or an external cross-park investor. Ownership is a fact about the
// chattel, independent of any lease; one active owner per unit, history retained.
import { query, queryOne } from '../db'
import { resolveOrCreateSignerUser } from './signerAccounts'
import { AppError } from '../middleware/errorHandler'

type Client = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }

/** The active home owner for a unit (or null). */
export async function getActiveHomeOwner(unitId: string) {
  return queryOne<any>(
    `SELECT ho.id, ho.owner_user_id, ho.acquired_via, ho.acquired_at, ho.sale_document_id, ho.notes,
            u.first_name, u.last_name, u.email, u.role AS owner_role
       FROM home_ownerships ho
       JOIN users u ON u.id = ho.owner_user_id
      WHERE ho.unit_id = $1 AND ho.status = 'active'
      LIMIT 1`, [unitId])
}

/** Every home a user actively owns, across all parks (investor portfolio). */
export async function getOwnedHomes(ownerUserId: string) {
  return query<any>(
    `SELECT ho.id, ho.unit_id, ho.acquired_via, ho.acquired_at,
            un.unit_number, p.name AS property_name, p.id AS property_id
       FROM home_ownerships ho
       JOIN units un ON un.id = ho.unit_id
       JOIN properties p ON p.id = un.property_id
      WHERE ho.owner_user_id = $1 AND ho.status = 'active'
      ORDER BY p.name, un.unit_number`, [ownerUserId])
}

/**
 * Record / transfer the home owner for a unit within a transaction. Any current
 * active owner is flipped to 'transferred' (retained as history), and the new
 * owner recorded. Marks the unit tenant-owned (a home has a non-landlord owner).
 * Idempotent: re-recording the SAME owner is a no-op.
 */
export async function setHomeOwner(client: Client, opts: {
  unitId: string
  ownerUserId: string
  acquiredVia?: string
  saleDocumentId?: string | null
  notes?: string | null
}): Promise<{ ownershipId: string; changed: boolean }> {
  const current = await client.query(
    `SELECT id, owner_user_id FROM home_ownerships WHERE unit_id=$1 AND status='active' LIMIT 1`, [opts.unitId])
  const cur = current.rows[0]
  if (cur && cur.owner_user_id === opts.ownerUserId) {
    return { ownershipId: cur.id, changed: false }
  }
  if (cur) {
    await client.query(
      `UPDATE home_ownerships SET status='transferred', released_at=NOW(), updated_at=NOW() WHERE id=$1`, [cur.id])
  }
  const created = await client.query(
    `INSERT INTO home_ownerships (unit_id, owner_user_id, acquired_via, sale_document_id, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [opts.unitId, opts.ownerUserId, opts.acquiredVia ?? 'recorded', opts.saleDocumentId ?? null, opts.notes ?? null])
  // A tenant-owned home now has a specific owner — reflect it on the unit.
  await client.query(`UPDATE units SET dwelling_ownership='tenant', updated_at=NOW() WHERE id=$1`, [opts.unitId])
  return { ownershipId: created.rows[0].id, changed: true }
}

/**
 * Resolve an owner by userId OR by email+name (minting a 'contact' account for a
 * new external investor — same account-gate as e-sign signers), then set them as
 * the unit's home owner. Returns the ownership + whether a new account was minted.
 */
export async function assignHomeOwnerByContact(client: Client, opts: {
  unitId: string
  ownerUserId?: string | null
  ownerName?: string | null
  ownerEmail?: string | null
  acquiredVia?: string
  saleDocumentId?: string | null
  notes?: string | null
}): Promise<{ ownershipId: string; ownerUserId: string; mintedAccount: boolean }> {
  let ownerUserId = opts.ownerUserId ?? null
  let minted = false
  if (!ownerUserId) {
    if (!opts.ownerEmail || !opts.ownerName) throw new AppError(400, 'Provide an owner account, or a name + email to create one.')
    const r = await resolveOrCreateSignerUser(client, { email: opts.ownerEmail, name: opts.ownerName })
    ownerUserId = r.userId
    minted = r.created
  }
  const { ownershipId } = await setHomeOwner(client, {
    unitId: opts.unitId, ownerUserId: ownerUserId!, acquiredVia: opts.acquiredVia,
    saleDocumentId: opts.saleDocumentId, notes: opts.notes,
  })
  return { ownershipId, ownerUserId: ownerUserId!, mintedAccount: minted }
}
