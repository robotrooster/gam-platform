// S605 (Nic): sell a property — move the account, not the money.
//
// Nic, on the sale of Oak Park: "It's more about just transferring ownership of
// the property account and the record of deposits and leases and stuff like
// that. I think we're overcomplicating this."
//
// He's right, and the reason is that the money is already handled elsewhere: if
// rent was paid on the 1st and the sale closes on the 20th, the buyer gets a
// credit at closing. That is what a closing statement is for. GAM moves no
// funds, computes no proration and cuts no checks.
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
// Leases move UNCHANGED — no re-papering. Most states oblige a buyer to honor
// the remaining term, and reissuing a sitting tenant's lease at a sale would
// alarm them for no reason.
//
// Rent routing needs no special handling: payouts resolve the recipient through
// leases → units → properties.landlord_id, so moving those IS the re-pointing.
import type { PoolClient } from 'pg'
import { getClient, queryOne, query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { randomInt } from 'crypto'
import { emailPropertyTransferApproval, emailPropertyTransferOffer } from './email'

export type TransferResult = {
  transferId: string
  moved: Record<string, number>
  /** Set when the buyer can't yet receive rent — see the note below. */
  warning?: string
}

type TransferArgs = {
  propertyId: string
  fromLandlordId: string
  toLandlordId: string
  byUserId: string
  note?: string | null
}

export async function transferProperty(args: TransferArgs): Promise<TransferResult> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const result = await transferPropertyWith(client, args)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * The move itself, on the caller's transaction. S655: the consent steps below
 * lock the request row and execute inside the SAME transaction, so the last
 * seller confirmation and the buyer's acceptance can never both execute a
 * sale, nor both miss it.
 */
async function transferPropertyWith(client: PoolClient, args: TransferArgs): Promise<TransferResult> {
  const { propertyId, fromLandlordId, toLandlordId, byUserId, note } = args
  if (fromLandlordId === toLandlordId) {
    throw new AppError(400, 'That property already belongs to this account')
  }

  const buyer = (await client.query<any>(
    `SELECT l.id, l.user_id, u.connect_payouts_enabled
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [toLandlordId])).rows[0]
  if (!buyer) throw new AppError(404, 'Buyer account not found')

  const moved: Record<string, number> = {}
  {
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
//
// ── S655: AND THE RECEIVING SIDE ────────────────────────────────────────────
// S605 built consent for the SELLER only. The last seller confirmation executed
// the sale straight onto whatever account the typed email belonged to: the
// buyer was never emailed, never asked, and had no screen to refuse it — while
// a property they can never delete, its leases and every tenant's record, its
// deposit obligations and GAM's monthly platform fee for its units all landed
// on them. A mistyped email handed every tenant's data to an unrelated landlord.
//
// Now a sale to ANOTHER account names the buyer's login. The buyer is emailed
// their own code, sees the transfer on their Properties page, chooses which of
// their companies takes it, and accepts. Nothing executes until both sides are
// done, in either order. One owner of the receiving company accepting is
// enough (Nic) — the same as any other act that company takes; the selling
// side stays unanimous.
//
// A move between two companies of the SAME account (Oak Park → Mountain View)
// names the receiving company up front. The initiating owner owns both sides,
// so there is no buyer step.
const TRANSFER_REQUEST_TTL_DAYS = 7

/** Six digits, from a CSPRNG — this authorizes handing over an asset. */
function approvalCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

type Runner = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }

/** Every company this login owns: member rows plus the companies it founded. */
async function companiesOwnedBy(userId: string, run?: Runner): Promise<string[]> {
  const sql = `SELECT landlord_id AS id FROM landlord_members WHERE user_id = $1
               UNION
               SELECT id FROM landlords WHERE user_id = $1`
  const rows = run ? (await run.query(sql, [userId])).rows : await query<{ id: string }>(sql, [userId])
  return rows.map((r: any) => r.id)
}

export async function initiateTransfer(args: {
  propertyId: string
  fromLandlordId: string
  byUserId: string
  note?: string | null
  /** A company the initiating account owns — a move between your own companies. */
  toLandlordId?: string | null
  /** Another account's login. The buyer accepts with their own emailed code. */
  toUserId?: string | null
}): Promise<{ requestId: string; approversNotified: number; awaitingBuyer: boolean }> {
  const { propertyId, fromLandlordId, byUserId, note } = args
  const toLandlordId = args.toLandlordId || null
  const toUserId = args.toUserId || null
  if (!!toLandlordId === !!toUserId) {
    throw new AppError(400, 'Name either one of your own companies or the email of the person receiving it.')
  }

  const property = await queryOne<{ name: string }>(
    `SELECT name FROM properties WHERE id = $1 AND landlord_id = $2`, [propertyId, fromLandlordId])
  if (!property) throw new AppError(404, 'Property not found under this account')

  let receiverName: string
  let buyerEmail: string | null = null
  if (toLandlordId) {
    if (fromLandlordId === toLandlordId) {
      throw new AppError(400, 'That property already belongs to this account')
    }
    // Checked against the DATABASE, not the caller's session: only a company
    // the initiating login actually owns can skip the buyer's acceptance.
    if (!(await companiesOwnedBy(byUserId)).includes(toLandlordId)) {
      throw new AppError(403,
        'You can only move a property straight to a company you own. To transfer it to someone else, enter their email.')
    }
    const company = await queryOne<{ business_name: string | null }>(
      `SELECT business_name FROM landlords WHERE id = $1`, [toLandlordId])
    if (!company) throw new AppError(404, 'Company not found')
    receiverName = company.business_name || 'your other company'
  } else {
    const buyer = await queryOne<{ id: string; email: string; role: string; first_name: string | null; last_name: string | null }>(
      `SELECT id, email, role, first_name, last_name FROM users WHERE id = $1`, [toUserId])
    if (!buyer || buyer.role !== 'landlord') {
      throw new AppError(404,
        'No landlord account with that email. The buyer needs to register on GAM before the property can be transferred to them.')
    }
    if (buyer.id === byUserId) {
      throw new AppError(400,
        'That is your own login. To move a property between your own companies, choose the company instead.')
    }
    buyerEmail = buyer.email
    receiverName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || buyer.email
  }

  // Everyone with an ACCOUNT who owns the selling entity. Passive owners with no
  // GAM login are out of scope by definition — the platform can only ask people
  // it knows about. S655: the founding login counts too (landlords.user_id) —
  // read from landlord_members alone, a company with no member row could not
  // sell at all.
  const owners = await query<{ user_id: string; email: string; first_name: string | null; last_name: string | null }>(
    `SELECT u.id AS user_id, u.email, u.first_name, u.last_name
       FROM users u
      WHERE u.id IN (SELECT m.user_id FROM landlord_members m WHERE m.landlord_id = $1
                     UNION
                     SELECT l.user_id FROM landlords l WHERE l.id = $1 AND l.user_id IS NOT NULL)`,
    [fromLandlordId])
  if (!owners.length) throw new AppError(409, 'This entity has no owner accounts to confirm the sale')

  const initiator = await queryOne<{ first_name: string | null; last_name: string | null }>(
    `SELECT first_name, last_name FROM users WHERE id = $1`, [byUserId])
  const initiatorName = [initiator?.first_name, initiator?.last_name].filter(Boolean).join(' ').trim() || 'A co-owner'
  const seller = await queryOne<{ business_name: string | null }>(
    `SELECT business_name FROM landlords WHERE id = $1`, [fromLandlordId])

  const buyerCode = toUserId ? approvalCode() : null
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const req = await client.query<{ id: string }>(
      `INSERT INTO property_transfer_requests
         (property_id, from_landlord_id, to_landlord_id, to_user_id, initiated_by, note, expires_at,
          buyer_code, buyer_accepted_at, buyer_accepted_by)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval,
               $8,
               CASE WHEN $3::uuid IS NOT NULL THEN now() END,
               CASE WHEN $3::uuid IS NOT NULL THEN $5::uuid END)
       RETURNING id`,
      [propertyId, fromLandlordId, toLandlordId, toUserId, byUserId, note ?? null,
       String(TRANSFER_REQUEST_TTL_DAYS), buyerCode])
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
        buyerName: receiverName,
        code: byUser.get(o.user_id) || '',
        isInitiator: o.user_id === byUserId,
      }).catch(() => { /* the request stands; codes can be resent */ })
    }
    // The buyer's own code, to the buyer's own stored address — never the
    // seller's, and never returned by any endpoint.
    if (buyerEmail && buyerCode) {
      await emailPropertyTransferOffer(buyerEmail, {
        propertyName: property.name,
        sellerName: seller?.business_name || initiatorName,
        code: buyerCode,
      }).catch(() => { /* the request stands; the buyer sees it on their Properties page */ })
    }

    logger.info({ propertyId, requestId, approvers: owners.length, awaitingBuyer: !!toUserId },
      '[property-transfer] consent requested')
    return { requestId, approversNotified: owners.length, awaitingBuyer: !!toUserId }
  } catch (e: any) {
    await client.query('ROLLBACK')
    if (e?.code === '23505') {
      throw new AppError(409, 'A transfer of this property is already awaiting approval.')
    }
    throw e
  } finally { client.release() }
}

export type ConsentResult = {
  approved: number
  required: number
  executed: boolean
  /** Every seller has confirmed; the buyer has not accepted yet. */
  awaitingBuyer: boolean
  transfer?: TransferResult
}

/** Why a request that is no longer pending can't be acted on — in words, never
 *  the raw status value. */
function notPendingMessage(status: string): string {
  switch (status) {
    case 'executed': return 'That transfer already went through.'
    case 'cancelled': return 'That transfer was already called off.'
    case 'expired': return 'That transfer request has expired. Start a new one.'
    default: return 'That transfer is no longer waiting on anyone.'
  }
}

/** Lock the request row for this transaction; refuse anything not pending. */
async function lockPendingRequest(client: PoolClient, requestId: string): Promise<any> {
  const req = (await client.query<any>(
    `SELECT * FROM property_transfer_requests WHERE id = $1 FOR UPDATE`, [requestId])).rows[0]
  if (!req) throw new AppError(404, 'Transfer request not found')
  if (req.status !== 'pending') throw new AppError(409, notPendingMessage(req.status))
  if (new Date(req.expires_at) < new Date()) {
    await client.query(
      `UPDATE property_transfer_requests SET status='expired', updated_at=now() WHERE id=$1`, [requestId])
    await client.query('COMMIT')
    throw new AppError(409, 'That transfer request has expired. Start a new one.')
  }
  return req
}

/**
 * Execute when BOTH sides are done — every seller confirmed and the receiving
 * side accepted — on the caller's locked transaction. Called after either
 * side's step, so the order does not matter.
 */
async function executeIfReady(client: PoolClient, req: any, byUserId: string): Promise<ConsentResult> {
  const tally = (await client.query<{ approved: string; required: string }>(
    `SELECT COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::text AS approved,
            COUNT(*)::text AS required
       FROM property_transfer_approvals WHERE request_id = $1`, [req.id])).rows[0]
  const approved = Number(tally?.approved ?? 0)
  const required = Number(tally?.required ?? 0)
  const sellersDone = required > 0 && approved >= required
  const buyerDone = !!req.buyer_accepted_at && !!req.to_landlord_id
  if (!sellersDone || !buyerDone) {
    return { approved, required, executed: false, awaitingBuyer: sellersDone && !buyerDone }
  }
  const transfer = await transferPropertyWith(client, {
    propertyId: req.property_id,
    fromLandlordId: req.from_landlord_id,
    toLandlordId: req.to_landlord_id,
    byUserId,
    note: req.note,
  })
  await client.query(
    `UPDATE property_transfer_requests
        SET status='executed', executed_at=now(), transfer_id=$2, updated_at=now()
      WHERE id=$1`, [req.id, transfer.transferId])
  return { approved, required, executed: true, awaitingBuyer: false, transfer }
}

/**
 * Record one SELLING owner's confirmation. Executes the transfer when this is
 * the last thing missing, inside the same transaction — so there is no window
 * where a sale is fully agreed but not yet done.
 */
export async function approveTransfer(args: {
  requestId: string
  userId: string
  code: string
}): Promise<ConsentResult> {
  const { requestId, userId, code } = args
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const req = await lockPendingRequest(client, requestId)
    const mine = (await client.query<any>(
      `SELECT * FROM property_transfer_approvals WHERE request_id = $1 AND user_id = $2`,
      [requestId, userId])).rows[0]
    if (!mine) throw new AppError(403, 'You are not an owner of the selling account')
    if (mine.declined_at) throw new AppError(409, 'You already declined this transfer')
    if (!mine.approved_at) {
      if (String(code).trim() !== mine.code) throw new AppError(400, 'That confirmation code is not correct')
      await client.query(
        `UPDATE property_transfer_approvals SET approved_at = now() WHERE id = $1`, [mine.id])
    }
    const out = await executeIfReady(client, req, userId)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/**
 * S655 — the BUYER accepts, with the code emailed to them, into one of the
 * companies their own account owns (read from the database). With a single
 * company there is nothing to choose; with several, they must say which. It
 * can never be the selling company.
 */
export async function acceptTransfer(args: {
  requestId: string
  userId: string
  code: string
  receivingLandlordId?: string | null
}): Promise<ConsentResult & { receivingLandlordId: string }> {
  const { requestId, userId, code } = args
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const req = await lockPendingRequest(client, requestId)
    if (!req.to_user_id || req.to_user_id !== userId) {
      throw new AppError(403, 'This transfer is not addressed to you.')
    }
    if (!req.buyer_accepted_at) {
      if (!req.buyer_code || String(code).trim() !== req.buyer_code) {
        throw new AppError(400, 'That acceptance code is not correct')
      }
      const owned = await companiesOwnedBy(userId, client)
      let target: string
      if (args.receivingLandlordId) {
        if (!owned.includes(args.receivingLandlordId)) throw new AppError(403, 'That company is not yours.')
        target = args.receivingLandlordId
      } else if (owned.length === 1) {
        target = owned[0]
      } else if (owned.length === 0) {
        throw new AppError(409, 'Your account has no company to receive the property yet.')
      } else {
        throw new AppError(400, 'Choose which of your companies takes it.')
      }
      if (target === req.from_landlord_id) {
        throw new AppError(400, 'That company is the one transferring it. Choose a different company.')
      }
      await client.query(
        `UPDATE property_transfer_requests
            SET to_landlord_id = $2, buyer_accepted_at = now(), buyer_accepted_by = $3, updated_at = now()
          WHERE id = $1`, [requestId, target, userId])
      req.to_landlord_id = target
      req.buyer_accepted_at = new Date()
    }
    const out = await executeIfReady(client, req, userId)
    await client.query('COMMIT')
    return { ...out, receivingLandlordId: req.to_landlord_id }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/**
 * One endpoint confirms for either side. The selling owner's code goes to the
 * seller step; the buyer's login goes to the buyer step. A login that is both
 * (a co-owner of the seller who is also the named buyer) is routed by which of
 * their two codes they entered.
 */
export async function confirmTransfer(args: {
  requestId: string
  userId: string
  code: string
  receivingLandlordId?: string | null
}): Promise<ConsentResult & { side: 'seller' | 'buyer' }> {
  const r = await queryOne<{ to_user_id: string | null; seller_code_matches: boolean }>(
    `SELECT r.to_user_id,
            EXISTS (SELECT 1 FROM property_transfer_approvals a
                     WHERE a.request_id = r.id AND a.user_id = $2 AND a.code = $3) AS seller_code_matches
       FROM property_transfer_requests r WHERE r.id = $1`,
    [args.requestId, args.userId, String(args.code).trim()])
  if (!r) throw new AppError(404, 'Transfer request not found')
  if (r.to_user_id === args.userId && !r.seller_code_matches) {
    return { ...(await acceptTransfer(args)), side: 'buyer' }
  }
  return { ...(await approveTransfer(args)), side: 'seller' }
}

/** Any single owner can stop a sale — consent must be unanimous, so one refusal
 *  is decisive. Cheaper to restart a request than to undo a transfer.
 *  S655: the named buyer can refuse it too. */
export async function declineTransfer(requestId: string, userId: string): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Locked like the confirm steps (approveTransfer / acceptTransfer hold the
    // same row lock while they execute the sale). A decline that lands while
    // the other side's confirmation is moving the property waits for it, then
    // sees the sale went through and says so — it can never report "declined,
    // nothing moved" over a property that has moved. Who may decline is
    // checked before the status, so a stranger learns nothing about it.
    const req = (await client.query<{ status: string; to_user_id: string | null }>(
      `SELECT status, to_user_id FROM property_transfer_requests WHERE id = $1 FOR UPDATE`,
      [requestId])).rows[0]
    const mine = req ? (await client.query<{ id: string }>(
      `SELECT id FROM property_transfer_approvals WHERE request_id = $1 AND user_id = $2`,
      [requestId, userId])).rows[0] : undefined
    const isBuyer = !!req && req.to_user_id === userId
    if (!req || (!mine && !isBuyer)) throw new AppError(403, 'You are not an owner of the selling account')
    if (req.status !== 'pending') throw new AppError(409, notPendingMessage(req.status))
    if (mine) {
      await client.query(`UPDATE property_transfer_approvals SET declined_at = now() WHERE id = $1`, [mine.id])
    }
    const cancelled = await client.query(
      `UPDATE property_transfer_requests
          SET status='cancelled', cancelled_at=now(), cancelled_by=$2, updated_at=now()
        WHERE id=$1 AND status='pending'`, [requestId, userId])
    if (!cancelled.rowCount) throw new AppError(409, 'That transfer is no longer waiting on anyone.')
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/**
 * S655 — transfers waiting on THIS login to accept, for the buyer's Properties
 * page. What the buyer needs to decide and nothing about the tenants: the
 * property, the seller, how many units and live leases, the deposits that come
 * with it, the note, the expiry, and how far the seller's owners have got.
 */
export async function listIncomingTransfers(userId: string): Promise<any[]> {
  return query<any>(
    `SELECT r.id, r.note, r.expires_at, r.created_at, r.buyer_accepted_at,
            p.name AS property_name, p.city, p.state,
            COALESCE(fl.business_name, 'A GAM landlord') AS seller_name,
            (SELECT COUNT(*)::int FROM units u WHERE u.property_id = p.id AND u.retired_at IS NULL) AS unit_count,
            (SELECT COUNT(*)::int FROM leases l JOIN units u ON u.id = l.unit_id
              WHERE u.property_id = p.id AND l.status = 'active') AS active_lease_count,
            (SELECT COUNT(*)::int FROM security_deposits d JOIN units u ON u.id = d.unit_id
              WHERE u.property_id = p.id AND d.status IN ('pending','funded','partial')) AS deposit_count,
            (SELECT COALESCE(SUM(d.collected_amount), 0)::text FROM security_deposits d JOIN units u ON u.id = d.unit_id
              WHERE u.property_id = p.id AND d.status IN ('pending','funded','partial')) AS deposit_total,
            (SELECT COUNT(*)::int FROM property_transfer_approvals a
              WHERE a.request_id = r.id AND a.approved_at IS NOT NULL) AS seller_approved,
            (SELECT COUNT(*)::int FROM property_transfer_approvals a
              WHERE a.request_id = r.id) AS seller_required
       FROM property_transfer_requests r
       JOIN properties p ON p.id = r.property_id
       JOIN landlords fl ON fl.id = r.from_landlord_id
      WHERE r.to_user_id = $1 AND r.status = 'pending' AND r.expires_at > now()
      ORDER BY r.created_at DESC`,
    [userId])
}
