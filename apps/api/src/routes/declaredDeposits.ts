// S624 — "I paid at the bank."
//
// The tenant-facing half of bank-deposit matching. A tenant who pays their own
// rent at a branch tells GAM they did; the bank feed later proves it; the
// landlord never touches it.
//
// THE DECLARATION IS A CLAIM, NOT A PAYMENT — and everything about this file
// follows from that. Nic (S624): "it also needs a way to have protections in
// case the tenant just straight up lied and said they paid, and they never
// actually went to the bank." Nothing here credits anything, pauses a late fee,
// or touches the eviction clock. A tenant who lies gains precisely nothing,
// which is a better defense than trying to catch them. The reward for telling
// the truth is real though: a corroborated declaration earns them the date THEY
// paid rather than the date the bank got round to posting it, which on a Friday
// deposit is worth several days of late fees (services/depositBackdate.ts).

import { Router } from 'express'
import fs from 'fs'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, getScopedPropertyIds } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import {
  DEPOSITABLE_PAYMENT_METHODS, BANK_DEPOSIT_REPORT_NOT_TAKEN, DEPOSIT_AFTER_HOURS,
  DEPOSIT_HOUR_REQUIRED, isDepositHourChoice,
} from '@gam/shared'
import { DateTime } from 'luxon'
import { resolveUploadPath } from '../lib/uploadPaths'
import { bankReceiptPhotoDir, takeBankReceiptPhoto, landlordsOwnUser } from '../lib/bankReceiptPhotos'
import {
  UNCONFIRMED_STRIKE_LIMIT, DECLARATION_STRIKE_SQL, declarationStrikes,
} from '../services/declaredDepositTrust'

export const declaredDepositsRouter = Router()
declaredDepositsRouter.use(requireAuth)

/**
 * How long a claim waits for a matching deposit before it is written off.
 *
 * Generous on purpose: a branch deposit posts in a day or two, but a mailed
 * money order or a holiday weekend stretches it, and expiring an honest tenant's
 * report is a bad way to introduce them to the feature.
 */
export const DECLARATION_EXPIRY_DAYS = 7

/**
 * How many strikes a tenant may have before the button stops trusting them —
 * a report never found at the bank, or (10/5, Nic) one the bank showed on a
 * later day than the tenant gave (services/declaredDepositTrust).
 */
export { UNCONFIRMED_STRIKE_LIMIT }

/**
 * 10/5 (Nic): the deposit reference number from the bank's receipt is required
 * — it tells this deposit apart from anyone else's for the same amount.
 */
export const DECLARATION_REFERENCE_REQUIRED =
  'Enter the deposit reference number from the bank\'s receipt — it tells your deposit apart from anyone else\'s for the same amount.'

const declareSchema = z.object({
  leaseId: z.string().uuid(),
  amount: z.number().positive().max(100000),
  // The date they say they went to the bank. Never the payment date on its own —
  // it only governs once a bank row corroborates it.
  declaredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // 10/5: what they took into the bank (cash, a check, a money order).
  method: z.enum(DEPOSITABLE_PAYMENT_METHODS),
  // 10/5 (Nic): the reference number on the bank's receipt — required
  // (DECLARATION_REFERENCE_REQUIRED, checked after parsing so the refusal is
  // a sentence).
  reference: z.string().max(120).optional().nullable(),
  // 10/6 (Nic): about what time they were at the bank — an hour from 8 AM to
  // 6 PM (8–18), or 'after_hours' (after hours / ATM). Required
  // (DEPOSIT_HOUR_REQUIRED, checked after parsing so the refusal is a
  // sentence): it tells two same-amount deposits apart
  // (services/declaredDepositAssign).
  depositHour: z.union([z.number(), z.string()]).optional().nullable(),
})

/** The reported hour from the body, or null when none (or none that is offered) was picked. */
function depositHourOf(v: unknown): { hour: number | null; afterHours: boolean } | null {
  const n = typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : v
  if (!isDepositHourChoice(n)) return null
  return n === DEPOSIT_AFTER_HOURS ? { hour: null, afterHours: true } : { hour: n as number, afterHours: false }
}

/**
 * SQL: GAM is reading this company's bank — an active link that has synced at
 * least once. Only then can a report be matched (and only then does the expiry
 * job ever write one off, jobs/declaredDepositExpiry.ts). A link in error, a
 * disconnected one, or one Stripe has not finished fetching is not watching.
 */
const BANK_FEED_WATCHING_SQL = (landlordExpr: string) => `EXISTS (
  SELECT 1 FROM bank_connections c
   WHERE c.landlord_id = ${landlordExpr} AND c.status = 'active' AND c.last_synced_at IS NOT NULL)`

async function bankFeedWatching(landlordId: string): Promise<boolean> {
  const r = await queryOne<{ watching: boolean }>(
    `SELECT ${BANK_FEED_WATCHING_SQL('$1')} AS watching`, [landlordId])
  return !!r?.watching
}

/**
 * What happens to a report next, said plainly — a tenant who thinks this paid
 * their rent will stop worrying about a bill that is still due. The same words
 * for a new report and for a double tap.
 */
function whatHappensNext(bankFeedLinked: boolean): string {
  return bankFeedLinked
    ? 'Your balance stays the same until your deposit shows up in the bank — usually a day or two. We will apply it automatically, dated the day you paid when the bank shows it that day or the next business day (otherwise the bank’s date counts).'
    : 'Your landlord’s bank isn’t connected to GAM right now, so we can’t watch for this deposit ourselves. Let your landlord know you paid and keep your deposit slip — they’ll check their bank and mark your bill paid. Your balance stays the same until they do.'
}

/** The lease must actually be this tenant's, and active. */
async function assertTenantsLease(tenantId: string, leaseId: string) {
  return (await tenantsLease(tenantId, leaseId)).landlordId
}

/**
 * The tenant's own lease, its landlord, and whether its property takes rent
 * deposited at the bank — 10/6 (Nic): "Do you allow tenants to go into the
 * bank and deposit their rent for this unit or for this property?"
 * (properties.tenants_deposit_at_bank, default off).
 */
async function tenantsLease(tenantId: string, leaseId: string): Promise<{ landlordId: string; depositAtBank: boolean }> {
  const row = await queryOne<{ landlord_id: string; deposit_at_bank: boolean | null }>(
    `SELECT l.landlord_id, pr.tenants_deposit_at_bank AS deposit_at_bank
       FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE l.id = $1 AND lt.tenant_id = $2 AND lt.status = 'active'`,
    [leaseId, tenantId])
  if (!row) throw new AppError(404, 'That lease is not yours')
  return { landlordId: row.landlord_id, depositAtBank: row.deposit_at_bank === true }
}

// POST /api/declared-deposits — "I paid at the bank"
declaredDepositsRouter.post('/', async (req, res, next) => {
  try {
    // ROLE, not just the presence of a profileId. A landlord has one too, so
    // checking only for its existence let them through here and refused them
    // later on the lease lookup — with a misleading "that lease is not yours".
    // The guard held by accident; a guard that holds by accident is one edit
    // away from not holding at all.
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only a tenant can report their own deposit')
    }
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Only a tenant can report a deposit')
    const body = declareSchema.parse(req.body)
    const reference = (body.reference ?? '').trim()
    if (!reference) throw new AppError(400, DECLARATION_REFERENCE_REQUIRED)

    const lease = await tenantsLease(tenantId, body.leaseId)
    const landlordId = lease.landlordId
    // 10/6 (Nic): only where the landlord takes rent deposited at their bank.
    if (!lease.depositAtBank) throw new AppError(409, BANK_DEPOSIT_REPORT_NOT_TAKEN)
    // 10/6 (Nic): about what time they were at the bank — required.
    const when = depositHourOf(body.depositHour)
    if (!when) throw new AppError(400, DEPOSIT_HOUR_REQUIRED)

    // A deposit cannot have happened in the future, and a date the tenant has
    // to scroll back to is almost certainly a mistake. Both are refused with a
    // sentence rather than a validation code.
    // S624 — "TOMORROW" DEPENDS ON WHERE YOU ARE STANDING.
    //
    // This compared the tenant's date against Phoenix's, and rejected anything
    // ahead of it. A tenant EAST of the property is legitimately on tomorrow's
    // date for part of every evening: someone in New York reporting a deposit at
    // 10pm is on the 27th while an Arizona property is still on the 26th, and
    // they were told their deposit was "in the future". GAM now has properties
    // in two timezones and will have more.
    //
    // It also broke the test suite after 5pm Phoenix, which is how it surfaced —
    // the deploy gate caught it before it shipped.
    //
    // One day of slack covers every US offset with room to spare, and still
    // refuses a date genuinely days out.
    const today = DateTime.now().setZone('America/Phoenix')
    const latestSensible = today.plus({ days: 1 }).toISODate()!
    if (body.declaredDate > latestSensible) {
      throw new AppError(400, 'That date is in the future — report the deposit after you have made it.')
    }
    if (body.declaredDate < today.minus({ days: 45 }).toISODate()!) {
      throw new AppError(400, 'That date is more than 45 days ago. Contact your landlord so they can look it up directly.')
    }

    // Two identical open claims are always a double-tap, never two deposits.
    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM tenant_declared_deposits
        WHERE tenant_id = $1 AND lease_id = $2 AND status = 'pending'
          AND amount = $3 AND declared_date = $4::date`,
      [tenantId, body.leaseId, body.amount.toFixed(2), body.declaredDate])
    if (dup) {
      // S655 review: a double tap gets the same next step as the first report.
      // The agent relays this reply, and without the sentence it could not
      // tell a tenant at a company with no bank read (TruBlu today) to let the
      // landlord know and keep the slip.
      const bankFeedLinked = await bankFeedWatching(landlordId)
      return res.json({
        success: true,
        data: {
          id: dup.id,
          alreadyReported: true,
          message: `You already reported this deposit. ${whatHappensNext(bankFeedLinked)}`,
          ...(bankFeedLinked ? { expiresInDays: DECLARATION_EXPIRY_DAYS } : {}),
          bankFeedLinked,
        },
      })
    }

    const strikeCount = await declarationStrikes(tenantId)

    const row = await queryOne<{ id: string }>(
      `INSERT INTO tenant_declared_deposits
         (tenant_id, lease_id, landlord_id, amount, declared_date, method, reference,
          declared_hour, declared_after_hours)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9) RETURNING id`,
      [tenantId, body.leaseId, landlordId, body.amount.toFixed(2),
       body.declaredDate, body.method, reference, when.hour, when.afterHours])

    // S655 review: the promise depends on whether GAM is reading the
    // landlord's bank. With no link (Country Acres / TruBlu today), a link in
    // error, or one Stripe has not finished fetching, nothing can match the
    // report and it never expires (jobs/declaredDepositExpiry.ts) — the
    // landlord checks their own bank and records the payment by hand. Telling
    // that tenant "we will apply it automatically" in "a day or two", with a
    // 7-day clock, was a promise GAM cannot keep. And the landlord has no
    // screen that lists reports without a bank row to match them to, so the
    // tenant is told to let them know. The wording holds for every one of
    // those cases ("isn't connected … right now"), not only for "never linked".
    const bankFeedLinked = await bankFeedWatching(landlordId)

    res.json({
      success: true,
      data: {
        id: row!.id,
        // Said plainly, because a tenant who thinks this paid their rent will
        // stop worrying about a bill that is still due.
        message: `Reported. ${whatHappensNext(bankFeedLinked)}`,
        ...(bankFeedLinked ? { expiresInDays: DECLARATION_EXPIRY_DAYS } : {}),
        bankFeedLinked,
        priorUnconfirmed: strikeCount,
        trusted: strikeCount < UNCONFIRMED_STRIKE_LIMIT,
      },
    })
  } catch (e) { next(e) }
})

// GET /api/declared-deposits — the tenant's own reports
declaredDepositsRouter.get('/', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Forbidden')
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Forbidden')
    // S655 review: each report carries its lease (the payments page lists them
    // under the lease they were made for — without it the list was always
    // empty) and whether GAM is reading that landlord's bank, so a report it
    // cannot watch for is not described as "waiting for it to appear".
    const rows = await query(
      `SELECT d.id, d.lease_id, d.amount::float AS amount,
              to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
              d.method, d.reference, d.status, d.resolution_note,
              -- 10/6 (Nic): about what time they were at the bank.
              d.declared_hour AS deposit_hour, d.declared_after_hours AS after_hours,
              to_char(d.confirmed_at,'YYYY-MM-DD') AS confirmed_on,
              ${BANK_FEED_WATCHING_SQL('d.landlord_id')} AS bank_feed_linked,
              -- 10/5 (Nic): their photo of the bank's receipt (served only to
              -- them and the landlord's own people), and the bank's date when
              -- it did not bear theirs out.
              d.receipt_photo_url,
              to_char(d.bank_posted_date,'YYYY-MM-DD') AS bank_posted_date,
              (d.false_date_flagged_at IS NOT NULL) AS bank_date_used
         FROM tenant_declared_deposits d
        WHERE d.tenant_id = $1
        ORDER BY d.created_at DESC
        LIMIT 50`, [tenantId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ─── 10/5 (Nic): the tenant's photo of the bank's receipt ─────────────────────
//
// Optional, added to their own report after it is made (the report itself is
// plain JSON). Stored like the landlord's bank-deposit photo
// (lib/bankReceiptPhotos): images only, the same size cap, an unguessable file
// name, and one authed serve route that authorizes PER ROW — the tenant who
// made the report, or that landlord's own people at a property they work at.
// Anyone else is told it is not there. Never a GAM admin from here, never a
// static URL.
const reportPhotoDir = bankReceiptPhotoDir('declared-deposit-receipts')
const takeReportPhoto = takeBankReceiptPhoto(reportPhotoDir)
const REPORT_PHOTO_PATH = '/api/declared-deposits/receipt-photos/'

// POST /api/declared-deposits/:id/receipt-photo — multipart, field 'photo'.
declaredDepositsRouter.post('/:id/receipt-photo', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant' || !req.user!.profileId) {
      throw new AppError(403, 'Only the tenant who reported the deposit can add the bank\'s receipt to it')
    }
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, 'Report not found')
    const row = await queryOne<{ status: string }>(
      `SELECT status FROM tenant_declared_deposits WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user!.profileId])
    if (!row) throw new AppError(404, 'Report not found')
    if (row.status === 'withdrawn') {
      throw new AppError(409, 'That report was taken back, so there is nothing to add a photo to.')
    }
    next()
  } catch (e) { next(e) }
}, takeReportPhoto, async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'Choose a photo of the bank\'s receipt.')
    const url = REPORT_PHOTO_PATH + req.file.filename
    const row = await queryOne<{ id: string; receipt_photo_url: string }>(
      `UPDATE tenant_declared_deposits
          SET receipt_photo_url = $3, receipt_photo_name = $4, receipt_photo_mime = $5,
              receipt_photo_size = $6, receipt_photo_uploaded_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status <> 'withdrawn'
       RETURNING id, receipt_photo_url`,
      [req.params.id, req.user!.profileId, url, String(req.file.originalname || 'receipt').slice(0, 200),
       req.file.mimetype, req.file.size])
    if (!row) throw new AppError(404, 'Report not found')
    res.json({ success: true, data: { id: row.id, receiptPhotoUrl: row.receipt_photo_url } })
  } catch (e) { next(e) }
})

// GET /api/declared-deposits/receipt-photos/:filename — the photo, per row.
declaredDepositsRouter.get('/receipt-photos/:filename', async (req, res, next) => {
  try {
    const d = await queryOne<{ tenant_id: string; landlord_id: string; property_id: string | null }>(
      `SELECT d.tenant_id, d.landlord_id, u.property_id
         FROM tenant_declared_deposits d
         LEFT JOIN leases l ON l.id = d.lease_id
         LEFT JOIN units u  ON u.id = l.unit_id
        WHERE d.receipt_photo_url = $1`, [REPORT_PHOTO_PATH + req.params.filename])
    let allowed = false
    if (d && req.user!.role === 'tenant') {
      allowed = req.user!.profileId === d.tenant_id
    } else if (d && landlordsOwnUser(req.user, d.landlord_id)) {
      // A staffer assigned to some properties sees the reports made there only.
      const scoped = await getScopedPropertyIds(req.user)
      allowed = scoped === null || (!!d.property_id && scoped.includes(d.property_id))
    }
    // Someone else's photo reads as missing, never as "forbidden".
    if (!allowed) throw new AppError(404, 'Not found')
    const fp = resolveUploadPath(reportPhotoDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.setHeader('Cache-Control', 'private, no-store')
    res.sendFile(fp)
  } catch (e) { next(e) }
})

// GET /api/declared-deposits/feed/:leaseId — before reporting: can GAM watch?
//
// S655 review: the report window has to say the right thing BEFORE the tenant
// submits. With no bank to read, "we'll apply it automatically" and "the
// report will expire" are both untrue — the landlord checks their own bank
// and marks the bill paid.
declaredDepositsRouter.get('/feed/:leaseId', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Forbidden')
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Forbidden')
    const leaseId = z.string().uuid().parse(req.params.leaseId)
    const lease = await tenantsLease(tenantId, leaseId)
    const bankFeedLinked = await bankFeedWatching(lease.landlordId)
    res.json({
      success: true,
      data: {
        leaseId, bankFeedLinked, ...(bankFeedLinked ? { expiresInDays: DECLARATION_EXPIRY_DAYS } : {}),
        // 10/6 (Nic): the property takes rent deposited at the bank; false: the report is not offered.
        depositsTaken: lease.depositAtBank,
        ...(lease.depositAtBank ? {} : { notTakenMessage: BANK_DEPOSIT_REPORT_NOT_TAKEN }),
      },
    })
  } catch (e) { next(e) }
})

// DELETE /api/declared-deposits/:id — "actually, I hadn't paid yet"
declaredDepositsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Forbidden')
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Forbidden')
    // Withdrawn, never deleted (standing retention rule) — and only while it is
    // still a claim. A confirmed report is a settled payment and is not the
    // tenant's to take back.
    const row = await queryOne<{ id: string }>(
      `UPDATE tenant_declared_deposits
          SET status = 'withdrawn', resolution_note = 'Withdrawn by the tenant',
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING id`, [req.params.id, tenantId])
    if (!row) throw new AppError(409, 'That report can no longer be withdrawn')
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/declared-deposits/landlord — reports the landlord should know about
//
// Two things a landlord genuinely needs: what has been claimed but not yet
// proved, and what never arrived. The second is the only fraud signal here, and
// it is a signal, not a verdict — a money order genuinely can go astray.
declaredDepositsRouter.get('/landlord/open', async (req, res, next) => {
  try {
    const landlordId = req.user!.role === 'landlord'
      ? req.user!.profileId : req.user!.landlordId
    if (!landlordId || !canManageLandlordResource(req.user, landlordId)) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query(
      `SELECT d.id, d.amount::float AS amount,
              to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
              d.method, d.reference, d.status,
              -- 10/6 (Nic): about what time they were at the bank.
              d.declared_hour AS deposit_hour, d.declared_after_hours AS after_hours,
              u.unit_number,
              TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name,
              -- 10/5: this landlord's own reports only — never another company's.
              (SELECT COUNT(*) FROM tenant_declared_deposits x
                WHERE x.tenant_id = d.tenant_id AND x.landlord_id = d.landlord_id
                  AND ${DECLARATION_STRIKE_SQL('x')})::int
                AS prior_unconfirmed,
              -- 10/5 (Nic): the tenant's photo of the bank's receipt, and the
              -- flag when the bank showed the deposit on a later day than they said.
              d.receipt_photo_url,
              to_char(d.bank_posted_date,'YYYY-MM-DD') AS bank_posted_date,
              (d.false_date_flagged_at IS NOT NULL) AS date_flagged
         FROM tenant_declared_deposits d
         JOIN leases l ON l.id = d.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN tenants t ON t.id = d.tenant_id
         JOIN users usr ON usr.id = t.user_id
        WHERE d.landlord_id = $1
          AND (d.status IN ('pending','unconfirmed') OR d.false_date_flagged_at IS NOT NULL)
          -- A staffer assigned to some properties sees the reports made there only.
          AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
        -- 10/5: open reports first (a flagged confirmed one never ages out, and
        -- must not push a live report off the list), then the newest.
        ORDER BY (d.status IN ('pending','unconfirmed')) DESC, d.declared_date DESC, d.id
        LIMIT 200`, [landlordId, await getScopedPropertyIds(req.user)])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
