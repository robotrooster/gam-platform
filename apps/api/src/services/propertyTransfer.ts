// S605 (Nic): sell a property — move the account, not the money.
//
// Nic, on the sale of Oak Park: "It's more about just transferring ownership of
// the property account and the record of deposits and leases and stuff like
// that. I think we're overcomplicating this."
//
// He's right, and the reason is that the money is already handled elsewhere: if
// rent was paid on the 1st and the sale closes on the 20th, the buyer gets a
// credit at closing. That is what a closing statement is for. GAM moves no
// funds, computes no proration and cuts no cheques.
//
// WHAT MOVES — live state the buyer is now responsible for:
//   properties, units, leases, security deposits, equipment, open maintenance.
//
// WHAT STAYS — settled financial history:
//   payments, invoices, disbursements, expenses, platform-fee accruals, other
//   income. Those record who was ACTUALLY paid. Re-pointing them at the buyer
//   would rewrite the seller's books for a period they owned the property, and
//   break every report either party has already filed.
//
// Leases move UNCHANGED — no re-papering. Most states oblige a buyer to honour
// the remaining term, and reissuing a sitting tenant's lease at a sale would
// alarm them for no reason.
//
// Rent routing needs no special handling: payouts resolve the recipient through
// leases → units → properties.landlord_id, so moving those IS the re-pointing.
import { getClient, queryOne, query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { randomInt } from 'crypto'
import { emailPropertyTransferApproval } from './email'

export type TransferResult = {
  transferId: string
  moved: Record<string, number>
  /** Set when the buyer can't yet receive rent — see the note below. */
  warning?: string
}

export async function transferProperty(args: {
  propertyId: string
  fromLandlordId: string
  toLandlordId: string
  byUserId: string
  note?: string | null
}): Promise<TransferResult> {
  const { propertyId, fromLandlordId, toLandlordId, byUserId, note } = args
  if (fromLandlordId === toLandlordId) {
    throw new AppError(400, 'That property already belongs to this account')
  }

  const buyer = await queryOne<any>(
    `SELECT l.id, l.user_id, u.connect_payouts_enabled
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [toLandlordId])
  if (!buyer) throw new AppError(404, 'Buyer account not found')

  const client = await getClient()
  const moved: Record<string, number> = {}
  try {
    await client.query('BEGIN')

    const prop = await client.query<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1 FOR UPDATE`, [propertyId])
    if (!prop.rows.length) throw new AppError(404, 'Property not found')
    if (prop.rows[0].landlord_id !== fromLandlordId) {
      throw new AppError(403, 'That property does not belong to the selling account')
    }

    // The property itself, and its management pointers — the buyer's owner user
    // becomes owner and manager of record until they delegate otherwise.
    const p = await client.query(
      `UPDATE properties
          SET landlord_id = $2, owner_user_id = $3, managed_by_user_id = $3,
              lease_signer_user_id = NULL,   -- the seller's designated signer does not come along
              updated_at = NOW()
        WHERE id = $1`, [propertyId, toLandlordId, buyer.user_id])
    moved.properties = p.rowCount ?? 0

    const u = await client.query(
      `UPDATE units SET landlord_id = $2, updated_at = NOW() WHERE property_id = $1`,
      [propertyId, toLandlordId])
    moved.units = u.rowCount ?? 0

    // Tenancies continue exactly as written.
    const l = await client.query(
      `UPDATE leases SET landlord_id = $2, updated_at = NOW()
        WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`,
      [propertyId, toLandlordId])
    moved.leases = l.rowCount ?? 0

    // Deposits: the OBLIGATION moves. No cash moves — GAM already holds it, and
    // where the landlord holds it themselves that handoff is between the two
    // owners and never touched the platform.
    const d = await client.query(
      `UPDATE security_deposits SET updated_at = NOW()
        WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`,
      [propertyId])
    moved.security_deposits = d.rowCount ?? 0

    // Equipment lives at the property and is sold with it.
    const e = await client.query(
      `UPDATE parts_inventory SET landlord_id = $2, updated_at = NOW() WHERE property_id = $1`,
      [propertyId, toLandlordId])
    moved.equipment = e.rowCount ?? 0

    // Open work the buyer inherits. Completed requests are history and stay.
    const m = await client.query(
      `UPDATE maintenance_requests SET landlord_id = $2, updated_at = NOW()
        WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)
          AND status NOT IN ('completed', 'cancelled')`,
      [propertyId, toLandlordId])
    moved.open_maintenance = m.rowCount ?? 0

    const sm = await client.query(
      `UPDATE scheduled_maintenance SET landlord_id = $2, updated_at = NOW()
        WHERE property_id = $1`, [propertyId, toLandlordId])
    moved.maintenance_schedules = sm.rowCount ?? 0

    const rec = await client.query<{ id: string }>(
      `INSERT INTO property_transfers
         (property_id, from_landlord_id, to_landlord_id, transferred_by, moved, note)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
      [propertyId, fromLandlordId, toLandlordId, byUserId, JSON.stringify(moved), note ?? null])

    await client.query('COMMIT')
    logger.info({ propertyId, fromLandlordId, toLandlordId, moved }, '[property-transfer] complete')

    return {
      transferId: rec.rows[0].id,
      moved,
      // Rent now routes to the buyer, so if they can't receive payouts yet the
      // money has nowhere to land. Reported rather than blocked: a closing does
      // not wait on someone's Stripe onboarding, and it is fixable afterwards.
      ...(buyer.connect_payouts_enabled ? {} : {
        warning: 'The new owner cannot receive payouts yet — they need to finish Stripe verification ' +
                 'before rent collected on this property can reach them.',
      }),
    }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ── S605 (Nic): CONSENT ─────────────────────────────────────────────────────
// "Anybody that has a GAM platform account as an owner or a landlord on a
// partnership needs to all have a signing or confirmation... so that one person
// can't just accidentally sell or transfer account ownership out from underneath
// other people."
//
// transferProperty() above is now the EXECUTION step and is only reached once
// every owner has confirmed. Raising a request no longer moves anything.
const TRANSFER_REQUEST_TTL_DAYS = 7

/** Six digits, from a CSPRNG — this authorises handing over an asset. */
function approvalCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export async function initiateTransfer(args: {
  propertyId: string
  fromLandlordId: string
  toLandlordId: string
  byUserId: string
  note?: string | null
}): Promise<{ requestId: string; approversNotified: number }> {
  const { propertyId, fromLandlordId, toLandlordId, byUserId, note } = args
  if (fromLandlordId === toLandlordId) {
    throw new AppError(400, 'That property already belongs to this account')
  }

  const property = await queryOne<{ name: string }>(
    `SELECT name FROM properties WHERE id = $1 AND landlord_id = $2`, [propertyId, fromLandlordId])
  if (!property) throw new AppError(404, 'Property not found under this account')

  const buyer = await queryOne<{ business_name: string | null }>(
    `SELECT business_name FROM landlords WHERE id = $1`, [toLandlordId])
  if (!buyer) throw new AppError(404, 'Buyer account not found')

  // Everyone with an ACCOUNT who owns the selling entity. Passive owners with no
  // GAM login are out of scope by definition — the platform can only ask people
  // it knows about.
  const owners = await query<{ user_id: string; email: string; first_name: string | null; last_name: string | null }>(
    `SELECT u.id AS user_id, u.email, u.first_name, u.last_name
       FROM landlord_members m JOIN users u ON u.id = m.user_id
      WHERE m.landlord_id = $1`, [fromLandlordId])
  if (!owners.length) throw new AppError(409, 'This entity has no owner accounts to confirm the sale')

  const initiator = await queryOne<{ first_name: string | null; last_name: string | null }>(
    `SELECT first_name, last_name FROM users WHERE id = $1`, [byUserId])
  const initiatorName = [initiator?.first_name, initiator?.last_name].filter(Boolean).join(' ').trim() || 'A co-owner'

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const req = await client.query<{ id: string }>(
      `INSERT INTO property_transfer_requests
         (property_id, from_landlord_id, to_landlord_id, initiated_by, note, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)
       RETURNING id`,
      [propertyId, fromLandlordId, toLandlordId, byUserId, note ?? null, String(TRANSFER_REQUEST_TTL_DAYS)])
    const requestId = req.rows[0].id

    // The approver set is FROZEN here. Adding an owner mid-flight must not
    // change what the sale needs; removing one must not let it through on fewer
    // signatures than it started with.
    for (const o of owners) {
      await client.query(
        `INSERT INTO property_transfer_approvals (request_id, user_id, code) VALUES ($1,$2,$3)`,
        [requestId, o.user_id, approvalCode()])
    }
    await client.query('COMMIT')

    const codes = await query<{ user_id: string; code: string }>(
      `SELECT user_id, code FROM property_transfer_approvals WHERE request_id = $1`, [requestId])
    const byUser = new Map(codes.map(c => [c.user_id, c.code]))
    for (const o of owners) {
      await emailPropertyTransferApproval(o.email, {
        propertyName: property.name,
        initiatorName,
        buyerName: buyer.business_name || 'the buyer',
        code: byUser.get(o.user_id) || '',
        isInitiator: o.user_id === byUserId,
      }).catch(() => { /* the request stands; codes can be resent */ })
    }

    logger.info({ propertyId, requestId, approvers: owners.length }, '[property-transfer] consent requested')
    return { requestId, approversNotified: owners.length }
  } catch (e: any) {
    await client.query('ROLLBACK')
    if (e?.code === '23505') {
      throw new AppError(409, 'A transfer of this property is already awaiting approval.')
    }
    throw e
  } finally { client.release() }
}

/**
 * Record one owner's confirmation. Executes the transfer when the LAST required
 * approval lands, inside the same call — so there is no window where a sale is
 * fully approved but not yet done.
 */
export async function approveTransfer(args: {
  requestId: string
  userId: string
  code: string
}): Promise<{ approved: number; required: number; executed: boolean; transfer?: TransferResult }> {
  const { requestId, userId, code } = args
  const req = await queryOne<any>(
    `SELECT * FROM property_transfer_requests WHERE id = $1`, [requestId])
  if (!req) throw new AppError(404, 'Transfer request not found')
  if (req.status !== 'pending') throw new AppError(409, `That transfer is already ${req.status}.`)
  if (new Date(req.expires_at) < new Date()) {
    await query(`UPDATE property_transfer_requests SET status='expired', updated_at=now() WHERE id=$1`, [requestId])
    throw new AppError(409, 'That transfer request has expired. Start a new one.')
  }

  const mine = await queryOne<any>(
    `SELECT * FROM property_transfer_approvals WHERE request_id = $1 AND user_id = $2`,
    [requestId, userId])
  if (!mine) throw new AppError(403, 'You are not an owner of the selling account')
  if (mine.declined_at) throw new AppError(409, 'You already declined this transfer')
  if (!mine.approved_at) {
    if (String(code).trim() !== mine.code) throw new AppError(400, 'That confirmation code is not correct')
    await query(
      `UPDATE property_transfer_approvals SET approved_at = now() WHERE id = $1`, [mine.id])
  }

  const tally = await queryOne<{ approved: string; required: string }>(
    `SELECT COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::text AS approved,
            COUNT(*)::text AS required
       FROM property_transfer_approvals WHERE request_id = $1`, [requestId])
  const approved = Number(tally?.approved ?? 0)
  const required = Number(tally?.required ?? 0)
  if (approved < required) return { approved, required, executed: false }

  const transfer = await transferProperty({
    propertyId: req.property_id,
    fromLandlordId: req.from_landlord_id,
    toLandlordId: req.to_landlord_id,
    byUserId: userId,
    note: req.note,
  })
  await query(
    `UPDATE property_transfer_requests
        SET status='executed', executed_at=now(), transfer_id=$2, updated_at=now()
      WHERE id=$1`, [requestId, transfer.transferId])
  return { approved, required, executed: true, transfer }
}

/** Any single owner can stop a sale — consent must be unanimous, so one refusal
 *  is decisive. Cheaper to restart a request than to undo a transfer. */
export async function declineTransfer(requestId: string, userId: string): Promise<void> {
  const mine = await queryOne<any>(
    `SELECT a.id, r.status FROM property_transfer_approvals a
       JOIN property_transfer_requests r ON r.id = a.request_id
      WHERE a.request_id = $1 AND a.user_id = $2`, [requestId, userId])
  if (!mine) throw new AppError(403, 'You are not an owner of the selling account')
  if (mine.status !== 'pending') throw new AppError(409, `That transfer is already ${mine.status}.`)
  await query(`UPDATE property_transfer_approvals SET declined_at = now() WHERE id = $1`, [mine.id])
  await query(
    `UPDATE property_transfer_requests
        SET status='cancelled', cancelled_at=now(), cancelled_by=$2, updated_at=now()
      WHERE id=$1`, [requestId, userId])
}
