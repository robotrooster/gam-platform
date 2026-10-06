import { Router } from 'express'
import { z } from 'zod'
import { extractUploadFilename, resolveUploadPath } from '../lib/uploadPaths'
import { packageSiblings } from '../services/signingPackages'
import { advancePacket, announcePacketIfComplete } from '../services/packetRelay'
import {
  LeaseDocumentType,
  UnitType,
  UNIT_TYPES,
  LeaseColumn,
  LeaseColumnVals,
  LEASE_COLUMN_CATEGORY,
  isScreeningFeeText,
  LEASE_COLUMN_LABEL,
  LEASE_COLUMN_VALUE_BEARING_CATEGORIES,
  WRITABLE_LEASE_COLUMN_SPECS,
  FEE_ROW_SPECS,
  UTILITY_ROW_SPECS,
  validateLeaseDocumentForSend,
  STANDALONE_DOCUMENT_TYPES,
  NO_LEASE_DOCUMENT_TYPES,
  LEASE_TEMPLATE_PURPOSES,
  isValidSignerRole,
  MIGRATION_WINDOW_DAYS,
  leaseColumnDisplayValue,
  isAutoFilledLeaseColumn,
  FEE_TYPES,
  FEE_TYPE_META, MONEY_KINDS, isMoneyBoxColumn,
  moveInDefaults,
  leaseDueDay,
  dueDayLabel,
  parseDueDay,
  GENERIC_SIGNER_ROLES,
  DISCLOSURE_TYPES,
  DISCLOSURE_TYPE_LABEL,
  TEMPLATE_APPLIES_TO,
  printedUnitNumber,
  documentDateToIso,
  isoToDocumentDate,
} from '@gam/shared'
// S655: new leases for a household already living there (renewals).
import { NEW_LEASE_RENT_MODES, newLeaseRent, renewalSchedule, renewalBillingSummary, UNIT_TYPE_LABEL, humanize } from '@gam/shared'
import { todayIn, dateIn } from '../lib/timezone'
import { query, queryOne, getClient } from '../db'
import { generateMoveInInvoice } from '../jobs/moveInBundle'
import { requireAuth, requirePerm, userHasPerm } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { stampPdf } from '../services/pdfStamp'
import { resolveLateFeePolicyForUnit, lateFeePolicyToPrefills } from '../services/lateFeePolicy'
import { suggestUnitPrefill } from '../services/leasePrefill'
import { detectPropertyFromPdf } from '../services/templatePropertyDetect'
import { createAdminNotification } from '../services/adminNotifications'
import { emailSigningRequest, emailSigningCompleted, emailSigningReminder } from '../services/email'
import { replyToProperty, type ReplyTo } from '../services/replyRouting'
import { portalUrl } from '../lib/portalUrls'
import { createNotification } from '../services/notifications'
import crypto from 'crypto'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { logger } from '../lib/logger'
import { draftHouseholdLease, resolveHouseholdByEmail, draftPendingForUnitType } from '../services/householdLeaseDraft'
import { activateHomeSaleContract } from '../services/homeSale'
import { releaseSuspendedChargesForLease } from '../services/utilityBilling'
import { landlordSigningContact } from '../services/landlordSigningContact'
import { landlordForRequest, landlordScopeIds, resolveLandlordTarget, landlordIdForProperty, landlordIdForUnit, ownsLandlord, fileUnderCompany } from '../lib/landlordScope'
import { NOT_A_RESIDENT_ACCOUNT } from '../jobs/leaseParser/resolveIntent'

export const esignRouter = Router()

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const LANDLORD_APP_URL = process.env.LANDLORD_APP_URL || 'http://localhost:3001'
const TENANT_APP_URL   = process.env.TENANT_APP_URL   || 'http://localhost:3002'

// Signer roles: exactly one 'primary', zero-or-more 'co_tenant_N', at least one
// 'landlord', optional 'witness'. Template slots that aren't filled at document
// creation time get their fields pruned (see POST /documents).
const TENANT_ROLE_PATTERN = /^(primary|co_tenant_\d+)$/
function isTenantRole(role: string): boolean { return TENANT_ROLE_PATTERN.test(role) }

// ─────────────────────────────────────────────────────────────
// S654 — WHO A COMPANY MAY PUT ON ITS DOCUMENT, AND WHERE THEIR MAIL GOES
// ─────────────────────────────────────────────────────────────
//
// A signer row is a door. Its user id says whose signature the document
// collects; its email is where the signing link goes — and, for a resident who
// never set up their account, the password link too. Both used to come straight
// from the request body. Landlord B looked up landlord A's invitee through
// /witnesses/provision, listed them as the primary tenant with B's own address
// in the email box, signed, and the relay mailed A's live password link to B.
//
// So every route that takes signers from the body runs these two checks, and
// createDocumentRecord stores a non-landlord signer's own account address
// whatever the body said:
//   - a tenant role (primary, co_tenant_N) is a resident's login, never a
//     landlord's or a staff member's (409 NOT_A_RESIDENT_ACCOUNT);
//   - a witness is never a landlord or staff login (the same rule
//     /witnesses/provision applies);
//   - a resident's login never signs for the landlord, and the landlord's
//     seat goes only to an owner or staff login on the document company's own
//     account, at that login's own address, or the property's lease-signing
//     address for the login the property names as its signer
//     (assertLandlordSigners);
//   - a resident (a login with a tenant profile) must already belong to this
//     company: a lease, an invite or a draft lease with it. Anyone else is
//     another company's resident, or nobody's yet — invite them first.
//
// A login with no tenant profile (a witness set up through /witnesses/provision,
// or a contact the standalone flow just made) is not a resident, so it needs no
// tie. Whatever it is mailed goes to its own address, and a password link only
// under services/tenantLeaseLink's rules.

/** Logins that may stand in a resident's or a witness's place on a document. */
const RESIDENT_TYPE_LOGINS = new Set(['tenant', 'contact'])

const WITNESS_NOT_A_STAFF_LOGIN =
  "This email belongs to a landlord or staff login on GAM, so it can't be used for a witness. Use the witness's own email."
const RESIDENT_CANNOT_SIGN_FOR_LANDLORD =
  "A resident's account can't sign for the landlord. Use the landlord's or a staff member's own login."
function notThisCompanysResident(who: string): string {
  return `${who} has no lease, invite or draft lease with this company, so they can't be put on its documents. Invite them first.`
}

const SIGNER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SignerAccount = { id: string; role: string; email: string; has_tenant: boolean }
type RowsQuery = (sql: string, params: any[]) => Promise<any[]>
const poolRows: RowsQuery = (sql, params) => query<any>(sql, params)

/**
 * S654: load each signer's account and refuse the wrong KIND of login for the
 * role it is put in. Returns the accounts by id for assertResidentsBelong.
 * `q` reads inside the caller's transaction when it has made accounts there.
 */
async function assertSignerLogins(
  signers: Array<{ userId?: string; role: string; name?: string }>,
  q: RowsQuery = poolRows,
): Promise<Map<string, SignerAccount>> {
  const ids = signers.map(s => s.userId).filter((id): id is string => !!id)
  const noAccount = (s: { name?: string }) =>
    new AppError(400, `${s.name?.trim() || 'A signer'} has no GAM account.`)
  for (const s of signers) {
    if (s.userId && !SIGNER_UUID_RE.test(s.userId)) throw noAccount(s)
  }
  const rows: SignerAccount[] = ids.length ? await q(
    `SELECT u.id, u.role, u.email,
            EXISTS (SELECT 1 FROM tenants t WHERE t.user_id = u.id) AS has_tenant
       FROM users u WHERE u.id = ANY($1::uuid[])`, [ids]) : []
  const byId = new Map(rows.map(r => [r.id, r]))
  for (const s of signers) {
    if (!s.userId) continue
    const a = byId.get(s.userId)
    if (!a) throw noAccount(s)
    if (s.role === 'landlord') {
      if (RESIDENT_TYPE_LOGINS.has(a.role)) throw new AppError(409, RESIDENT_CANNOT_SIGN_FOR_LANDLORD)
    } else if (isTenantRole(s.role)) {
      if (a.role !== 'tenant') throw new AppError(409, NOT_A_RESIDENT_ACCOUNT)
    } else if (s.role === 'witness') {
      if (!RESIDENT_TYPE_LOGINS.has(a.role)) throw new AppError(409, WITNESS_NOT_A_STAFF_LOGIN)
    }
  }
  return byId
}

/**
 * S654: the residents among `ids` who belong to `own` — a lease, a live invite
 * or a draft lease with one of those companies.
 */
async function residentsTiedHere(ids: string[], own: string[], q: RowsQuery = poolRows): Promise<Set<string>> {
  const companies = Array.from(new Set(own.filter(Boolean)))
  if (!ids.length || !companies.length) return new Set()
  const rows = await q(
    `SELECT t.user_id FROM tenants t
       JOIN lease_tenants lt ON lt.tenant_id = t.id
       JOIN leases l ON l.id = lt.lease_id
      WHERE t.user_id = ANY($1::uuid[]) AND l.landlord_id = ANY($2::uuid[])
     UNION
     SELECT t.user_id FROM tenants t
       JOIN pending_tenant_intents i ON i.tenant_id = t.id
      WHERE t.user_id = ANY($1::uuid[]) AND i.landlord_id = ANY($2::uuid[])
        AND i.cancelled_at IS NULL
     UNION
     SELECT d.tenant_user_id FROM pending_lease_drafts d
      WHERE d.tenant_user_id = ANY($1::uuid[]) AND d.landlord_id = ANY($2::uuid[])`,
    [ids, companies])
  return new Set(rows.map((r: any) => r.user_id))
}

/**
 * S654: a resident on a document must already be this company's. `own` is the
 * document's company plus the companies the acting account holds — the same
 * set every other door counts as "this company".
 */
async function assertResidentsBelong(
  signers: Array<{ userId?: string; role: string; name?: string }>,
  accounts: Map<string, SignerAccount>,
  own: string[],
  q: RowsQuery = poolRows,
): Promise<void> {
  const residents = signers.filter(s => s.userId && s.role !== 'landlord'
    && accounts.get(s.userId)?.role === 'tenant' && accounts.get(s.userId)?.has_tenant)
  if (!residents.length) return
  const tied = await residentsTiedHere(residents.map(s => s.userId!), own, q)
  const stranger = residents.find(s => !tied.has(s.userId!))
  if (stranger) throw new AppError(409, notThisCompanysResident(stranger.name?.trim() || 'This person'))
}

const LANDLORD_SEAT_NOT_THIS_COMPANY =
  "Only an owner or staff member of this company can sign for the landlord. Use your own login or one of your team's."
const LANDLORD_SEAT_WRONG_ADDRESS =
  "The landlord's signing link can only go to that login's own email, or to this property's lease-signing email when the property's own signer holds the seat."

/**
 * S654: the landlord's seat on a document.
 *
 * assertSignerLogins only kept a resident's login out of it, so landlord B put
 * landlord A's login in the landlord seat with attacker@evil.test as the
 * address. The row was stored at that address, /send mailed it A's row token,
 * B could sign B's document as A, and A — now a signer — could read it.
 *
 * So the seat goes only to a login on the document company's own account: an
 * owner (landlords.user_id, or landlord_members) of a company in
 * account_companies(document company), or a team member scoped to one — the
 * same people who already sign there (services/leaseSigner hands the seat to a
 * property's on-site manager). Its link goes only to that login's own address,
 * or, for the one login the property names as its signer
 * (services/landlordSigningContact), the property's lease-signing address.
 * Anything else is 409.
 *
 * S654 round 8: the lease-signing address was accepted for ANY login allowed
 * in the seat. The property owner chooses that address, so another company's
 * person who had been attached to this account (a co-owner add, a team invite
 * accepted with no login) had their row token mailed to wherever the owner
 * pointed it, and anyone holding that link signed as them. The address now
 * goes with the login landlordSigningContact names for the property, the same
 * owner and address pair the renewal, work-trade and auto-draft paths produce.
 * Everyone else reaches the seat only at their own users.email.
 *
 * Each landlord signer's email is set to the stored address it matched, and a
 * blank one to the login's own address, since createDocumentRecord stores the
 * landlord row at the address it is handed.
 */
async function assertLandlordSigners(
  signers: Array<{ userId?: string; role: string; email?: string | null }>,
  doc: { landlordId: string; unitId?: string | null },
  q: RowsQuery = poolRows,
): Promise<void> {
  const seats = signers.filter(s => s.role === 'landlord' && s.userId)
  if (!seats.length) return
  const rows: Array<{ id: string; email: string }> = await q(
    `WITH co AS (SELECT account_companies($2::uuid) AS id)
     SELECT u.id, u.email FROM users u
      WHERE u.id = ANY($1::uuid[])
        AND (   EXISTS (SELECT 1 FROM landlords l
                         WHERE l.user_id = u.id AND l.id IN (SELECT id FROM co))
             OR EXISTS (SELECT 1 FROM landlord_members m
                         WHERE m.user_id = u.id AND m.landlord_id IN (SELECT id FROM co))
             OR EXISTS (SELECT 1 FROM property_manager_scopes s
                         WHERE s.user_id = u.id AND s.landlord_id IN (SELECT id FROM co))
             OR EXISTS (SELECT 1 FROM onsite_manager_scopes s
                         WHERE s.user_id = u.id AND s.landlord_id IN (SELECT id FROM co))
             OR EXISTS (SELECT 1 FROM maintenance_worker_scopes s
                         WHERE s.user_id = u.id AND s.landlord_id IN (SELECT id FROM co))
             OR EXISTS (SELECT 1 FROM bookkeeper_scopes s
                         WHERE s.user_id = u.id AND s.landlord_id IN (SELECT id FROM co)))`,
    [seats.map(s => s.userId), doc.landlordId])
  const ours = new Map(rows.map(r => [r.id, r.email]))
  const contact = doc.unitId
    ? await landlordSigningContact(doc.landlordId, { unitId: doc.unitId },
        { query: async (sql: string, params: any[]) => ({ rows: await q(sql, params) }) })
    : null
  const onSite = contact?.delegatedEmail?.trim() || null
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  for (const s of seats) {
    const own = ours.get(s.userId!)
    if (!own) throw new AppError(409, LANDLORD_SEAT_NOT_THIS_COMPANY)
    const given = String(s.email ?? '').trim()
    if (!given || same(given, own)) s.email = own
    // S654: the property's lease-signing address only for the property's own
    // named signer, never for any other login in the seat.
    else if (onSite && contact && s.userId === contact.userId && same(given, onSite)) s.email = onSite
    else throw new AppError(409, LANDLORD_SEAT_WRONG_ADDRESS)
  }
}

/**
 * S654: where a signer's mail goes. Anyone but the landlord is reached only at
 * the address on their own account, never one a signer row or a request
 * carried. The landlord's row may hold the property's on-site signing address
 * (services/landlordSigningContact), so it keeps its own.
 */
async function signerDeliveryAddress(s: { role: string; email: string; user_id: string }): Promise<string> {
  if (s.role === 'landlord') return s.email
  const u = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [s.user_id])
  return u?.email ?? s.email
}

// 10/5: replies reach the people who run this property (services/replyRouting) —
// a resident's, co-signer's or witness's copy; the landlord's own copy stays GAM's.
async function signerReplyTo(
  signer: { role: string; user_id?: string | null }, propertyId: string | null | undefined,
): Promise<ReplyTo | undefined> {
  if (signer.role === 'landlord') return undefined
  // A landlord-side login signing in a generic role (seller, party_N, custom)
  // is still the landlord side: its replies stay with GAM support.
  if (signer.user_id) {
    const u = await queryOne<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [signer.user_id]).catch(() => null)
    if (u && u.role !== 'tenant' && u.role !== 'contact') return undefined
  }
  return replyToProperty(propertyId)
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

type Bucket = 'residential' | 'storage' | 'commercial'
function bucketFor(unitType: UnitType): Bucket {
  if (unitType === 'storage') return 'storage'
  if (unitType === 'commercial') return 'commercial'
  return 'residential'
}

/**
 * For a SET of tenants signing a new lease together, check each one's existing
 * active/pending leases for bucket-overlap. If ANY tenant conflicts, return
 * the conflict. Prevents double-booking roommates.
 */
async function canTenantsSignNewLease(
  tenantIds: string[],
  newUnitId: string,
  newStartDate: string | Date,
  newEndDate: string | Date | null,
  // S655: one lease or several. A NEW LEASE for a household already living
  // there passes the lease it follows too (renews_lease_id): that lease ends the
  // day before the new one starts (services/renewalSuccessor), so it is not a
  // double-booking — a month-to-month has no end date to compare until then.
  // Every OTHER lease still counts, including a second new lease of the same one.
  excludeLeaseIds?: string | Array<string | null | undefined>,
  // S655 (Nic, 10/2: "imports are NEVER blocked"): tenants whose overlap with
  // ANOTHER company's lease is theirs to settle when they sign — people whose
  // own signature is what starts this lease (residentsWhoSignFirst). Their
  // same-company overlaps still count.
  opts: { residentDecides?: string[] } = {},
): Promise<{ ok: boolean; reason?: string; conflictingTenantId?: string; conflictingLeaseId?: string; crossCompany?: boolean }> {
  if (!tenantIds.length) return { ok: false, reason: 'No tenants provided' }
  const excluded = (Array.isArray(excludeLeaseIds) ? excludeLeaseIds : [excludeLeaseIds])
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
  // S654: compare calendar days as 'YYYY-MM-DD'. This mixed a field read at
  // UTC midnight with pg dates at local midnight, and a '-' (month-to-month)
  // end became an Invalid Date that never overlapped anything. '-' and blank
  // mean no end date. A pg DATE (callers pass lease rows) is local midnight.
  const day = (v: string | Date | null): string | null =>
    v instanceof Date
      ? (Number.isNaN(v.getTime()) ? null
          : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`)
      : leaseFieldDate(v)
  const bStart = day(newStartDate)
  const bEnd   = day(newEndDate)
  const newUnit = await queryOne<any>(
    `SELECT u.unit_type, p.landlord_id FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
    [newUnitId])
  if (!newUnit) return { ok: false, reason: 'Unit not found' }
  // S654: an unreadable start is refused here, on send, sign and build alike.
  if (!bStart) return { ok: false, reason: 'The lease start date is not a date.' }
  // S654: so is an end date that names no real day (callers pass '-' as null).
  if (!bEnd && typeof newEndDate === 'string' && newEndDate.trim() !== '') {
    return { ok: false, reason: 'The lease end date is not a date.' }
  }
  const newBucket = bucketFor(newUnit.unit_type)

  for (const tenantId of tenantIds) {
    const actives = await query<any>(`
      SELECT l.id, l.start_date::text AS start_date, l.end_date::text AS end_date,
        l.landlord_id, l.unit_id, u.unit_type, u.unit_number,
        tu.first_name || ' ' || tu.last_name as tenant_name
      FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users tu ON tu.id = t.user_id
      WHERE lt.tenant_id = $1
        AND lt.status IN ('active','pending_add')
        AND l.status IN ('active','pending')
        AND NOT (l.id = ANY($2::uuid[]))`,
      [tenantId, excluded])

    for (const l of actives as any[]) {
      if (bucketFor(l.unit_type) !== newBucket) continue
      // S553 (Nic, Oak Park): SAME-LANDLORD overlap on a DIFFERENT unit is
      // deliberate — a landlord drafting a second lease for their own
      // tenant (e.g. space rent on two mobile homes) is doing it on
      // purpose, and the tenant still signs the printed document. The
      // guard's real targets stay blocked: cross-landlord double-booking,
      // and two active leases on the SAME unit.
      if (l.landlord_id === newUnit.landlord_id && l.unit_id !== newUnitId) continue
      const aStart: string = l.start_date
      const aEnd: string | null = l.end_date
      // Inclusive: a lease ending the day another starts still overlaps.
      const overlaps =
        (aEnd === null || aEnd >= bStart) &&
        (bEnd === null || bEnd >= aStart)
      if (overlaps) {
        // S655: another company's unit is that company's business — say there
        // is an overlapping lease elsewhere, never which unit it is.
        const sameAccount = l.landlord_id === newUnit.landlord_id || !!(await queryOne<{ one: number }>(
          `SELECT 1 AS one FROM account_companies($1::uuid) c(id) WHERE c.id = $2`, [newUnit.landlord_id, l.landlord_id]))
        if (!sameAccount && opts.residentDecides?.includes(tenantId)) continue
        return {
          crossCompany: !sameAccount,
          ok: false,
          reason: sameAccount
            ? `Tenant ${l.tenant_name} has an overlapping ${newBucket} lease (Unit ${l.unit_number}).`
            : `Tenant ${l.tenant_name} has an overlapping ${newBucket} lease with another company. It has to end before this lease starts.`,
          conflictingTenantId: tenantId,
          conflictingLeaseId: l.id
        }
      }
    }
  }
  return { ok: true }
}

/**
 * S655 (Nic, 10/2): "Imports are NEVER blocked." The tenants on this document
 * who sign their own lease first — another company's resident, whose own
 * signature is what starts it (services/newLeaseInvite tenantsNeedingOwnSignature).
 * A lease they still hold with that other company is theirs to settle when
 * they sign; it never refuses the landlord's send or signature, because
 * nothing issues before they sign. Their own signature still checks it. If the
 * check fails, nobody is excused (the refusal stands).
 */
async function residentsWhoSignFirst(documentId: string, tenants: Array<{ userId: string; tenantId: string } | null>): Promise<string[]> {
  const { tenantsNeedingOwnSignature } = await import('../services/newLeaseInvite')
  const waiting = await tenantsNeedingOwnSignature(documentId).catch(() => [] as Array<{ userId: string }>)
  const users = new Set(waiting.map(w => w.userId))
  return tenants.filter((t): t is { userId: string; tenantId: string } => !!t && users.has(t.userId)).map(t => t.tenantId)
}

async function checkPlatformBlock(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const tenant = await queryOne<any>(
    'SELECT platform_status FROM tenants WHERE user_id=$1', [userId])
  if (!tenant) return { ok: true } // not a tenant (landlord signer)
  if (tenant.platform_status === 'blocked') {
    return { ok: false, reason: 'Your GAM account has an outstanding balance. Contact support to resolve.' }
  }
  if (tenant.platform_status === 'suspended') {
    return { ok: false, reason: 'Your GAM account is suspended. Contact support.' }
  }
  return { ok: true }
}

/**
 * Resolve the primary tenant signer + all co-tenant signers from a document,
 * loading their tenant_id for each. Returns null if required tenants are missing.
 */
async function getDocumentTenantSigners(documentId: string): Promise<{
  primary: { signerId: string; userId: string; tenantId: string; name: string; email: string } | null,
  coTenants: Array<{ signerId: string; userId: string; tenantId: string; name: string; email: string; role: string }>
}> {
  const rows = await query<any>(`
    SELECT s.id as signer_id, s.user_id, s.role, s.name, s.email, t.id as tenant_id
    FROM lease_document_signers s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN tenants t ON t.user_id = s.user_id
    WHERE s.document_id=$1
    ORDER BY s.order_index`, [documentId])

  let primary = null
  const coTenants: any[] = []
  for (const r of rows as any[]) {
    if (!isTenantRole(r.role)) continue
    const record = { signerId: r.signer_id, userId: r.user_id, tenantId: r.tenant_id, name: r.name, email: r.email, role: r.role }
    if (r.role === 'primary') primary = record
    else coTenants.push(record)
  }
  return { primary, coTenants }
}

/**
 * INSERT a lease_documents row + signers + template-derived fields atomically.
 * Pure data-layer helper — no business validation, no type-specific rules.
 * Caller must validate everything first (signer composition, overlap, platform
 * blocks, roster invariants) and must open the transaction. Helper only writes.
 *
 * Returns the created lease_documents row.
 */
/**
 * S654: the calendar day a lease date field names, as 'YYYY-MM-DD'. Document
 * dates are M/D/YYYY (S636) and older values can be ISO; anything else falls
 * back to the old local-time parse. Never read through UTC midnight. A day
 * that does not exist ('2/30/2027') is null, not a date Postgres refuses later.
 */
function leaseFieldDate(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const ymd = /^(\d{4}-\d{2}-\d{2})/.exec(t)?.[1] || documentDateToIso(t)
  if (ymd) {
    const [y, m, d] = ymd.split('-').map(Number)
    const back = new Date(Date.UTC(y, m - 1, d))
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d
      ? ymd : null
  }
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * S652 — a lease cannot be issued already over.
 *
 * Blu signed Country Acres MH 06 with an end date of 8/1/2026 and MH 17 with
 * 2/26/2026, on 9/22/2026. The landlord's signature issued both leases, that
 * night's lease-end job found them past their end, expired them, removed
 * Curtis Clabough and Cameron Valdez from their homes and marked both sites
 * vacant. Nothing said a word until October's invoices went missing.
 *
 * An end date on or before today is refused where the dates are read — at
 * send and at every signature — with the date in the sentence. '-' (month to
 * month) and a blank end date pass.
 */
export function assertLeaseNotAlreadyOver(endVal: string | null | undefined, today: string = todayIn(null)): void {
  const raw = (endVal ?? '').trim()
  if (!raw || raw === '-') return
  // S654: compare calendar days — the PROPERTY's today (callers pass it) against
  // the day the field names. Two Date objects read an ISO end date at UTC
  // midnight, the evening before in Phoenix, so a lease ending tomorrow was
  // refused as already over.
  const end = leaseFieldDate(raw)
  if (!end) return
  if (end <= today) {
    throw new AppError(400,
      `This lease ends ${raw}, which has already passed. A lease cannot be issued already over — enter the current term, or "-" for month to month.`)
  }
}

export async function createDocumentRecord(client: any, opts: {
  landlordId: string,
  templateId: string | null,
  unitId: string | null,
  leaseId: string | null,
  title: string,
  basePdfUrl: string | null,
  documentType: LeaseDocumentType,
  targetLeaseTenantId: string | null,
  promoteLeaseTenantId: string | null,
  // W-7 (S531): set when this original_lease document renews an existing
  // lease — completion copies the predecessor's deposits + the lease-end
  // processor hands the unit off instead of vacating.
  renewsLeaseId?: string | null,
  // S604 (Nic): the landlord ALREADY holds this tenant's deposit — migration
  // onboarding. The lease still states the deposit; it just isn't billed.
  depositAlreadyHeld?: boolean,
  signers: Array<{ userId: string, role: string, name: string, email: string, phone?: string | null, orderIndex?: number }>,
  // S629: values stamped onto placed fields at draft time, keyed by
  // lease_column. It was always read (see the late-fee and renewal prefills
  // below, which write into it) but never declared, so a caller passing it —
  // the home-sale purchase agreement — was a type error while the mechanism
  // underneath worked perfectly well.
  prefillValues?: Record<string, string>,
  // S641: this document is one item of a signing package. The group id is the
  // bundle's shared identity — deliberately a column rather than another table,
  // since a bundle needs an identity and an order and nothing else a row on the
  // document cannot carry. Note this is the PERPENDICULAR relation to
  // document_batches, which sends one template out to many units.
  packageGroupId?: string | null,
  packageId?: string | null,
  packageSortOrder?: number | null,
  // What the signer actually agreed to, so "has this changed since?" has
  // something to compare against at renewal.
  templateVersion?: number | null,
}): Promise<any> {
  // S629 (Nic): "it does not render the PDF to even see what you're signing."
  //
  // The document had NO base_pdf_url — its template had one and nothing copied
  // it down. The manual create route takes the PDF from the request body
  // because the UI supplies it; every programmatic caller passed null, so an
  // auto-drafted lease was a set of signature fields floating over nothing.
  //
  // Inherited here rather than at each call site, because the same hole exists
  // in all of them — the auto-draft on invite-accept, the renewal draft, and
  // the home-sale purchase agreement. A document made FROM a template is made
  // from that template's paper.
  let basePdfUrl = opts.basePdfUrl
  if (!basePdfUrl && opts.templateId) {
    const t = await client.query(
      `SELECT base_pdf_url FROM lease_templates WHERE id = $1`, [opts.templateId])
    basePdfUrl = t.rows[0]?.base_pdf_url ?? null
  }

  // INSERT lease_documents — includes document_type and addendum-specific FKs
  const doc = await client.query(`
    INSERT INTO lease_documents (
      template_id, landlord_id, unit_id, lease_id,
      title, base_pdf_url,
      document_type, target_lease_tenant_id, promote_lease_tenant_id,
      renews_lease_id, deposit_already_held,
      package_group_id, package_id, package_sort_order, template_version
    ) VALUES ($1,$2,$3,$4, $5,$6, $7,$8,$9, $10,$11, $12,$13,$14,$15)
    RETURNING *`,
    [
      opts.templateId, opts.landlordId, opts.unitId, opts.leaseId,
      opts.title, basePdfUrl,
      opts.documentType, opts.targetLeaseTenantId, opts.promoteLeaseTenantId,
      opts.renewsLeaseId || null,
      opts.depositAlreadyHeld === true,
      opts.packageGroupId ?? null, opts.packageId ?? null,
      opts.packageSortOrder ?? null, opts.templateVersion ?? null
    ]).then((r: any) => r.rows[0])

  // S605 (Nic): "if a previous run drafted the lease, then it should know that
  // now that it's saving it." ANY original lease created for a unit — drafted
  // here, or sent by hand through e-sign — closes out that unit's waiting
  // invites. Without this, a manually-sent lease left its rows open forever and
  // every future template save retried and skipped the same unit.
  //
  // This choke point is the right home for it: every lease document in the
  // system is created through this function, so no path can leave stale rows.
  if (opts.unitId && opts.documentType === 'original_lease') {
    await client.query(
      `UPDATE pending_lease_drafts
          SET resolved_at = now(), resolved_document_id = $2
        WHERE unit_id = $1 AND resolved_at IS NULL`, [opts.unitId, doc.id])
  }

  // INSERT signers
  for (const s of opts.signers) {
    const token = crypto.randomBytes(32).toString('hex')
    // S654: anyone but the landlord is stored at the address on their own
    // account. The email a caller passes is never where a resident's signing
    // link (or password link) goes — that is how landlord B had landlord A's
    // invitee's link mailed to B. The landlord's row keeps the address given:
    // it may be the property's on-site signer (services/landlordSigningContact).
    const own = s.role === 'landlord' ? null : await client.query(
      'SELECT email FROM users WHERE id = $1', [s.userId]).then((r: any) => r.rows[0])
    await client.query(`
      INSERT INTO lease_document_signers
        (document_id, user_id, role, name, email, phone, order_index, token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [doc.id, s.userId, s.role, s.name, own?.email ?? s.email, s.phone || null, s.orderIndex || 1, token])
  }

  // S535 (Nic): PROPERTY-LEVEL late fees — anti-discrimination. When the
  // property has a late-fee policy, it OVERRIDES any caller-supplied
  // late-fee prefills so every document drafted at the property carries
  // identical late terms. The signed lease snapshot remains the billing
  // source (lease-is-law — you bill what the tenant signed); this choke
  // point is where uniformity is enforced going forward. The fields lock
  // in the signing UI — the landlord changes the POLICY on the property,
  // never the individual lease.
  if (opts.unitId) {
    // S535: late fees resolve per (property, UNIT TYPE) row ONLY — no
    // property-wide default, no per-lease values, no carry-over from a
    // predecessor. Every bound late-fee field is baselined to 'N/A'
    // (= this class has no late fee) and the resolved policy overlays
    // when one exists. The unit's type pulls the fee policy the same
    // way it pulls the template.
    const pv: Record<string, string> = (opts as any).prefillValues = (opts as any).prefillValues || {}
    for (const k of Object.keys(pv)) if (k.startsWith('late_fee_')) delete pv[k]
    for (const tag of ['late_fee_grace_days', 'late_fee_initial_flat', 'late_fee_initial_percent',
      'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly',
      'late_fee_accrual_percent_daily', 'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly',
      'late_fee_cap_flat', 'late_fee_cap_percent']) {
      pv[tag] = 'N/A'
    }
    const plf = await resolveLateFeePolicyForUnit(opts.unitId, client)
    if (plf) {
      const policyPrefills = lateFeePolicyToPrefills(plf)
      // S535 (Nic): the late fee must appear IN the lease document —
      // court enforcement goes by the signed document, never by how
      // the software is configured. If the policy produces values the
      // chosen template can't display, drafting REFUSES rather than
      // silently producing an unenforceable (or fee-less) lease.
      if (opts.documentType === 'original_lease') {
        const policyTags = Object.keys(policyPrefills)
        const bound = opts.templateId
          ? await client.query(
              `SELECT lease_column FROM lease_template_fields
                WHERE template_id = $1 AND lease_column = ANY($2)`,
              [opts.templateId, policyTags]).then((r: any) => new Set(r.rows.map((x: any) => x.lease_column)))
          : new Set<string>()
        // S622: a template can satisfy this in PROSE. Most leases print the late
        // charge as a clause, never as a blank, so no field can exist to bind —
        // and refusing on that basis blocks drafting for a document that states
        // the policy perfectly well in words. The guard's purpose is that the
        // terms APPEAR in the signed document; a clause does that.
        const proseTerms = opts.templateId
          ? await client.query('SELECT late_fee_terms FROM lease_templates WHERE id=$1', [opts.templateId])
              .then((r: any) => r.rows[0]?.late_fee_terms ?? null)
          : null
        const missing = proseTerms ? [] : policyTags.filter(t => !bound.has(t))
        if (missing.length > 0) {
          const labels = missing.map(t => LEASE_COLUMN_LABEL[t as LeaseColumn] || t).join(', ')
          const typeLabel = plf.unit_type ? String(plf.unit_type).replace('_', ' ') : 'this unit type'
          throw new AppError(400,
            `The ${typeLabel} late-fee policy must appear IN the lease document — courts enforce the document, not software settings. ` +
            (opts.templateId
              ? `This template is missing: ${labels}. Add those fields in the template editor, or remove the late-fee policy for ${typeLabel}.`
              : `Use a template with late-fee fields (${labels}).`))
        }
      }
      Object.assign(pv, policyPrefills)
    }
  }

  // S556/S558 (Nic): auto-populate lease boxes from the assigned unit's data so
  // the landlord doesn't retype what the unit already knows — rent, derived
  // security deposit (unit rent × the template's stated deposit_months, S558),
  // unit number, property name/address. Only for ORIGINAL leases: renewals
  // prefill from the prior lease, and a rent increase surfaces a landlord-
  // confirmed deposit top-up, never a silent change. Caller-supplied values
  // always win (we only fill blanks), so the Document Values form can still
  // override anything.
  if (opts.unitId && opts.documentType === 'original_lease') {
    const pv: Record<string, string> = (opts as any).prefillValues = (opts as any).prefillValues || {}
    const suggested = await suggestUnitPrefill(opts.unitId, client, opts.templateId)
    for (const [col, val] of Object.entries(suggested)) {
      if (val && (pv[col] == null || pv[col] === '')) pv[col] = val // caller-supplied wins
    }
    // S582 forced "1st" here. S648 (Nic): the property decides — the 1st, a
    // fixed day, or each tenant's move-in day — and the landlord may change it
    // for one tenant on the lease. An onboarding resident keeps the property's
    // fixed day: their GAM start date is not when they moved in.
    //
    // S652 (Nic): unless the landlord said on the INVITE which day this
    // household is due — a park that bills each tenant on their own date
    // onboards with residents who are already on those dates. That day wins
    // over both rules.
    if (pv.rent_due_day == null || pv.rent_due_day === '') {
      const rule = await client.query(
        `SELECT p.rent_due_mode, p.rent_due_day,
                EXISTS (SELECT 1 FROM pending_tenant_intents i WHERE i.unit_id = u.id
                          AND i.cancelled_at IS NULL AND i.resolved_at IS NULL
                          AND COALESCE(i.is_existing_tenancy, false)) AS existing,
                (SELECT MAX(i.rent_due_day) FROM pending_tenant_intents i WHERE i.unit_id = u.id
                    AND i.cancelled_at IS NULL AND i.resolved_at IS NULL) AS invite_day
           FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
        [opts.unitId]).then((r: any) => r.rows[0])
      pv.rent_due_day = dueDayLabel(rule?.invite_day != null ? Number(rule.invite_day) : leaseDueDay({
        mode: rule?.existing ? 'fixed_day' : (rule?.rent_due_mode ?? 'fixed_day'),
        propertyDay: rule?.rent_due_day ?? 1,
        // S654: a caller-supplied start can be M/D/YYYY — read it as a calendar day.
        startIso: leaseFieldDate(pv.start_date),
      }))
    }
  }

  // Copy template fields — match by signer_role, prune unused role slots
  if (opts.templateId) {
    const filledRoles = new Set(opts.signers.map(s => s.role))

    // S652 — A ROLE THAT BINDS TO NOTHING IS A BUG, NOT AN EMPTY SLOT.
    //
    // Pruning unused role slots is correct and deliberate: a one-tenant lease
    // should not carry co_tenant_3's signature box. But the same silence hid a
    // real defect for thirteen Country Acres leases. draftHouseholdLease
    // labeled every resident 'tenant' while templates bind to 'primary' and
    // 'co_tenant_N', so NOT ONE tenant field matched — no name, no initials, no
    // signature date — and the documents went out looking finished. 70 of 125
    // fields vanished without a word.
    //
    // An ABSENT role is fine. An UNKNOWN one never is: it can only mean the
    // caller and the templates disagree about the vocabulary, and every field
    // for the real role is about to be dropped. Fail where it is cheap.
    const KNOWN_SIGNER_ROLES = new Set([
      'landlord', 'primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3',
      ...GENERIC_SIGNER_ROLES,
    ])
    const unknown = [...filledRoles].filter(r => r && !KNOWN_SIGNER_ROLES.has(r))
    if (unknown.length) {
      throw new AppError(500,
        `Cannot build this document: signer role${unknown.length > 1 ? 's' : ''} `
        + `"${unknown.join('", "')}" match no field on any template. `
        + 'Tenants are primary / co_tenant_1..3.')
    }
    const tmplFields = await client.query(
      'SELECT * FROM lease_template_fields WHERE template_id=$1',
      [opts.templateId]).then((r: any) => r.rows)
    const docSigners = await client.query(
      'SELECT * FROM lease_document_signers WHERE document_id=$1',
      [doc.id]).then((r: any) => r.rows)

    const prefillValues: Record<string,string> = { ...((opts as any).prefillValues || {}) }

    // S629 (Nic): "the unit number is editable still. It needs to be linked to
    // the unit that I selected when the invite went out — it's where you got
    // the name for this lease in the first place."
    //
    // unit_number has always been an IDENTITY column, and the signing page
    // locks identity fields — but only once they hold a value. Nothing filled
    // them, so they arrived empty and therefore typeable: a landlord could put
    // any unit number on a lease drafted for a specific space.
    //
    // Every identity fact this document already knows is stamped here, for any
    // landlord's template that has a box for it. Not overriding anything a
    // caller passed explicitly — a renewal or a send form still wins.
    if (opts.unitId) {
      const ctx = await client.query(
        `SELECT u.unit_number, u.display_label,
                u.rent_amount, u.security_deposit, p.name AS property_name,
                CONCAT_WS(', ', p.street1, NULLIF(p.street2,''), p.city, p.state, p.zip) AS property_address,
                -- S641: the printed name under a landlord signature is whoever
                -- signs, which is the property's named on-site signer when it
                -- has one. This used to take the account owner unconditionally,
                -- printing the owner's name over somebody else's signature.
                TRIM(COALESCE(NULLIF(p.lease_signing_name, ''),
                              CONCAT_WS(' ', lu.first_name, lu.last_name))) AS landlord_name
           FROM units u
           JOIN properties p ON p.id = u.property_id
           LEFT JOIN landlords l ON l.id = u.landlord_id
           LEFT JOIN users lu ON lu.id = l.user_id
          WHERE u.id = $1`, [opts.unitId]).then((r: any) => r.rows[0])
      if (ctx) {
        // S632 (Nic): "The box on the first page that says RV space should just
        // have a number and not the word RV by it, because it says RV Space
        // number right before that point. The space number three is overlapping
        // the word RV that's already printed on the document."
        //
        // A lease form names the kind of space in its own printed text — "RV
        // Space #___", "Unit #___" — so stamping the full label into the box
        // after it prints the type twice, and on a tight box the value lands on
        // top of the word. The box wants the number.
        //
        // Nic (S632, decided): "Having just the unit number is fine because the
        // template is already labeled as a lease for that type of unit. The back
        // end already marks it as a template for a specific type of unit, and
        // that bullet point already says it's for an RV space. You can just put
        // the number in that spot for all future reference."
        //
        // He is right that the type is never in doubt: templates are bound to a
        // unit type (S535 refuses a mismatched pairing outright) and the form's
        // own text names the space. So the box gets the number and nothing else.
        // S652 (Nic): the printed name is the park's own word, not the
        // platform's. "They can call it lot one on the lease, but it needs to be
        // mobile home one in the system so that we are accurately treating like
        // unit types the same consistency platform wide... I don't give a shit
        // what's on the actual lease, as long as the tenant knows what they're
        // paying for."
        //
        // So the query above reads display_label first. MH 01 in every schedule,
        // every availability check and every packet; "Lot 1" on the page, which
        // is what the sign on the space says. Stripping the word still applies —
        // the form already prints "Lot #" beside the box (S632).
        const identity: Record<string, string | null> = {
          unit_number: printedUnitNumber(ctx.display_label, ctx.unit_number),
          property_name: ctx.property_name,
          property_address: ctx.property_address,
          landlord_name: ctx.landlord_name,
        }
        for (const [col, val] of Object.entries(identity)) {
          if (val && prefillValues[col] == null) prefillValues[col] = String(val)
        }

        // S636 (Nic): THE UNIT'S RENT IS THE LEASE'S OPENING FIGURE.
        //
        // "He has a special deal with my grandpa where he pays $300 a month plus
        // the electricity... I need that to be edited in the unit details and
        // showing in the lease when he accepts the portal invite."
        //
        // An auto-drafted lease left rent BLANK and the landlord typed it at
        // signing, so a per-unit arrangement recorded on the unit never reached
        // the paper unless they remembered it at the moment of signing — and a
        // typo there becomes the signed rent. Seeding it from the unit makes the
        // record the starting point.
        //
        // A DEFAULT, not a lock: it stays editable on the document (S534 keeps
        // prefilled fields clickable), and whatever is signed wins and writes
        // back to the unit at execution. Skipped when the sender already supplied
        // a value, so an explicit send always beats the unit's figure.
        //
        // S637: the DEPOSIT is seeded only for a genuinely new tenancy.
        //
        // Seeding it from the unit alongside the rent (S636) charged Cameron
        // Gaefcke $350 on a lease that papers a tenancy already in place — the
        // unit carries a standing deposit figure for NEW residents, and every
        // Oak Park space carries $350, so every existing resident signing an
        // onboarding lease would be billed a deposit they never owed and in
        // most cases already paid the landlord years ago. Fifteen leases signed
        // before this behaved correctly because nothing prefilled the box.
        //
        // Rent is different and stays unconditional: it is what they pay every
        // month either way, and the unit record is the authority for it (S636).
        // A deposit is a one-time charge that an existing tenancy does not
        // generate at all. The landlord can still type one into the document.
        const existingTenancy = await client.query(
          `SELECT bool_or(COALESCE(is_existing_tenancy, false)) AS existing
             FROM pending_tenant_intents
            WHERE unit_id = $1 AND cancelled_at IS NULL AND resolved_at IS NULL`,
          [opts.unitId]).then((r: any) => r.rows[0]?.existing === true)

        // S652 (Nic, DIRECTIVE): "we're not doing a security deposit for
        // returning customers. People that are using a returning slot get an
        // exemption on security deposit. New people have the security deposit."
        //
        // The returning-resident invite (the landlord's attestation that
        // skipped the background check) is recorded on the resident's intent
        // at this property — not on the unit — so it is looked up through the
        // residents on THIS document. Donald Hamp's lease for Mountain View
        // RV 47 drafted with the park's $200 for a guest who comes every year.
        // Still only a default: the landlord can type a deposit in.
        const residentIds = (opts.signers ?? []).filter((sg: any) => sg.role !== 'landlord' && sg.role !== 'witness').map((sg: any) => sg.userId).filter(Boolean)
        const returningResident = residentIds.length ? await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM pending_tenant_intents i
               JOIN tenants t ON t.id = i.tenant_id
               JOIN units un ON un.id = $2
              WHERE t.user_id = ANY($1::uuid[]) AND i.cancelled_at IS NULL
                AND i.waive_reason = 'returning_resident'
                AND (i.property_id = un.property_id OR i.unit_id = un.id)) AS r`,
          [residentIds, opts.unitId]).then((r: any) => r.rows[0]?.r === true) : false

        // RENEWAL (Nic: "people get billed on their due date according to how
        // the landlord sets the property"): the household already lives here.
        // A renewal is not a move-in, so nothing a NEW resident is charged
        // starts on its page — the deposit carries from the old lease (the
        // renewal draft states what is held), and the property's fee list for
        // new residents is not theirs. The landlord can still type a charge.
        const renewal = !!opts.renewsLeaseId
        const noNewResidentCharges = existingTenancy || renewal

        for (const [col, val] of Object.entries({
          rent_amount:      ctx.rent_amount,
          security_deposit: (noNewResidentCharges || returningResident) ? null : ctx.security_deposit,
        })) {
          if (val != null && Number(val) > 0 && prefillValues[col] == null) {
            prefillValues[col] = Number(val).toFixed(2)
          }
        }

        // S648 (Nic): THE FEE BOXES START FROM THE PROPERTY'S FEE LIST.
        //
        //   "We want the boxes to be pre-filled in on page eight. Correctly
        //    have them at zero for onboarding tenants."
        //
        // A new tenancy takes each fee this property charges for this KIND of
        // unit (property_fee_schedules, per unit type — "a pet deposit on an
        // apartment is gonna only apply to apartments"). The boxes stay
        // editable; whatever is signed is what bills.
        //
        // An existing tenancy paid its move-in charges years ago, so every
        // move-in fee box starts at $0 — which parses to no charge at signing.
        // Its monthly and move-out fees are left for the landlord: a standing
        // price for new residents is not evidence of what a sitting one pays.
        //
        // other_fee is skipped: the property can list several, and a lease form
        // has one box, usually printed for something specific ("Guest fee").
        if (opts.documentType === 'original_lease') {
          const schedule = noNewResidentCharges ? [] : await client.query(
            `SELECT pfs.fee_type, pfs.amount
               FROM property_fee_schedules pfs
               JOIN units u ON u.property_id = pfs.property_id AND u.unit_type = pfs.unit_type
              WHERE u.id = $1 AND pfs.fee_type <> 'other_fee'`,
            [opts.unitId]).then((r: any) => r.rows as Array<{ fee_type: string; amount: string }>)
          for (const r of schedule) {
            if (prefillValues[r.fee_type] == null) prefillValues[r.fee_type] = Number(r.amount).toFixed(2)
          }
          if (noNewResidentCharges) {
            for (const tag of FEE_TYPES) {
              if (tag === 'security_deposit' || tag === 'other_fee') continue
              if (FEE_TYPE_META[tag].dueTiming !== 'move_in') continue
              if (prefillValues[tag] == null) prefillValues[tag] = '0.00'
            }
          }

          // S648: page 8's rent lines start from the lease's own terms. The
          // deposit copy and the total are stamped after the fields exist
          // (restampMoveInBoxes, below).
          const prop = await client.query(
            `SELECT p.move_in_collects_next_period AS on, p.rent_due_mode FROM units u
               JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [opts.unitId])
            .then((r: any) => r.rows[0])
          // A renewal's page 8 bills no rent: the nightly run bills it on the
          // household's own due dates (restampMoveInBoxes keeps it at $0).
          const d = renewal ? { firstMonthRent: 0, proration: 0 } : moveInDefaults({
            rent: Number(prefillValues.rent_amount ?? ctx.rent_amount ?? 0),
            // S654: document dates are M/D/YYYY, which parseIso can't read.
            startIso: leaseFieldDate(prefillValues.start_date),
            existingTenancy, collectsNextPeriod: prop?.on === true,
            dueDay: parseDueDay(prefillValues.rent_due_day) ?? 1,
            mode: existingTenancy ? 'fixed_day' : prop?.rent_due_mode,
          })
          if (prefillValues.move_in_first_month_rent == null)
            prefillValues.move_in_first_month_rent = d.firstMonthRent.toFixed(2)
          if (prefillValues.move_in_proration == null)
            prefillValues.move_in_proration = d.proration.toFixed(2)
        }
      }
    }

    // S629 (Nic): "link each one in order to the tenant that potentially got
    // the invite. Have it be prefilled so nobody fills it out. I already
    // spelled their name right once when I sent the invite, so I don't wanna
    // have to do it again. And the boxes linked to cosigner three and four,
    // those just don't even appear when there's no invites."
    //
    // The four tenant-name blanks on a lease form are the roster, in order.
    // They were landlord-role text fields mapped to nothing and marked
    // required, so a one-tenant lease asked the landlord to type three names
    // that do not exist — or write N/A three times on somebody's lease.
    //
    // Filled from the signers, and OMITTED where there is no such tenant, the
    // same way a co-tenant's signature field is already omitted. Nobody types a
    // name that the system took at invite time.
    /**
 * S652 — everybody who lives here, once each, signers first.
 *
 * Case-insensitive on the compare so "nancy sheptock" from a sheet does not
 * become a second Nancy beside the signer.
 */
function mergeNames(roster: string[], supplied: unknown): string {
  const extra = String(supplied ?? '').split(',').map(n => n.trim()).filter(Boolean)
  const out: string[] = []
  for (const n of [...roster, ...extra]) {
    if (!out.some(o => o.toLowerCase() === n.toLowerCase())) out.push(n)
  }
  return out.join(', ')
}

const TENANT_NAME_COLUMNS = ['tenant_name', 'tenant_2_name', 'tenant_3_name', 'tenant_4_name']
    const TENANT_ORDER = ['primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3']
    const rosterNames = TENANT_ORDER
      .map(role => (docSigners as any[]).find((s: any) => s.role === role)?.name)
      .filter(Boolean) as string[]
    // Taken at invite time, like the names — nobody retypes an address either.
    const primaryEmail = (docSigners as any[]).find((s: any) => s.role === 'primary')?.email
    if (primaryEmail && prefillValues.tenant_email == null) prefillValues.tenant_email = primaryEmail

    for (const f of tmplFields as any[]) {
      if (f.signer_role && !filledRoles.has(f.signer_role)) continue
      const nameSlot = f.lease_column ? TENANT_NAME_COLUMNS.indexOf(f.lease_column) : -1
      // No tenant in that slot on this lease: the blank does not belong on this
      // document at all. Skipped rather than left empty and required.
      if (nameSlot >= 0 && !rosterNames[nameSlot]) continue
      const signer = (docSigners as any[]).find((s: any) => s.role === f.signer_role)
      // If this field is bound to a lease_column and the send form supplied a value,
      // persist it now so it auto-renders for signers. Signature/initial/date_signed
      // are filled by signers themselves and are never prefilled here.
      // S635 (Nic): "month to month printed raw on all the leases I just sent."
      // Every tagged value goes through the display map on its way onto the
      // page — an enum reaches the signed document as English or not at all.
      const prefill = nameSlot >= 0
        ? rosterNames[nameSlot]
        : f.lease_column === 'occupant_names'
          // S635: one line naming the whole household, in invite order. The
          // form asks who lives here; the roster is the answer, and the
          // landlord does not retype it.
          //
          // S652 — THE ROSTER IS NOT THE WHOLE HOUSEHOLD, and this box was the
          // one place that mattered. An adult with no email address never
          // becomes a signer, so they are not in rosterNames — and this line
          // overrode anything the caller supplied, silently, which is how John
          // Sheptock came off his own lease twice. Nic, both times: "you didn't
          // add john as authorized occupant. why?"
          //
          // A caller who names the household KNOWS something this function
          // cannot: who lives there without an account. So their value wins,
          // and is merged with the roster rather than replacing it, because the
          // form is asking who lives here and the answer is everybody.
          ? (mergeNames(rosterNames, prefillValues.occupant_names) || null)
          : f.lease_column && prefillValues[f.lease_column] != null
            ? leaseColumnDisplayValue(f.lease_column, prefillValues[f.lease_column])
            // S641 (Nic): the template's own starting answer, for the boxes that
            // are ticked on every lease at a property — "tenant is responsible
            // for box one electricity, box two water, box three sewer". Last in
            // the chain on purpose: a known fact about this lease always beats a
            // template's assumption. Signature, initial and date fields are
            // filled by the signer and never reach here with a default.
            : (f.default_value ?? null)
      await client.query(`
        INSERT INTO lease_document_fields
          (document_id, template_field_id, signer_id, field_type, signer_role, label, lease_column,
           page, x, y, width, height, required, font_css, value, options, parent_field_id, parent_option,
           checkbox_mark)
        VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [doc.id, f.id, signer?.id || null, f.field_type, f.signer_role, f.label, f.lease_column,
         f.page, f.x, f.y, f.width, f.height, f.required, f.font_css, prefill, f.options ?? null,
         // parent_field_id references the parent TEMPLATE field id; the sign UI
         // matches child.parent_field_id to the parent doc field's template_field_id.
         f.parent_field_id ?? null, f.parent_option ?? null,
         // the document keeps its own copy, so editing a template never
         // redraws a lease somebody already signed
         f.checkbox_mark ?? 'x'])
    }
    // S648: the computed page 8 boxes, from the values just placed.
    if (opts.documentType === 'original_lease') {
      const { restampMoveInBoxes } = await import('../services/moveInBoxes')
      await restampMoveInBoxes(client, doc.id)
    }
  }

  return doc
}

/**
 * Build lease_tenants rows (and possibly a new lease) from a completed document.
 * Dispatcher — opens the transaction, loads the doc, routes to the appropriate
 * execute function by document_type. Each execute function receives the open
 * client and must NOT manage transaction lifecycle.
 * Throws AppError on any failure, rolling back so we never leave half-built state.
 */
async function resolveScopeToUnitIds(
  client: any,
  landlordId: string,
  scopeType: 'units' | 'property' | 'landlord_all',
  scopeRef: any
): Promise<string[]> {
  if (scopeType === 'units') {
    const unitIds = scopeRef?.unit_ids;
    if (!Array.isArray(unitIds) || unitIds.length === 0) {
      throw new Error("scope_ref.unit_ids must be a non-empty array");
    }
    const deduped = [...new Set(unitIds)];
    const result = await client.query(
      "SELECT id FROM units WHERE id = ANY($1::uuid[]) AND landlord_id = $2",
      [deduped, landlordId]
    );
    if (result.rows.length !== deduped.length) {
      const found = new Set(result.rows.map((r: any) => r.id));
      const missing = deduped.filter((id) => !found.has(id));
      throw new Error(`Units not found or not owned by landlord: ${missing.join(', ')}`);
    }
    return deduped;
  }
  if (scopeType === 'property') {
    const propertyId = scopeRef?.property_id;
    if (!propertyId || typeof propertyId !== 'string') {
      throw new Error("scope_ref.property_id is required");
    }
    const prop = await client.query(
      "SELECT id FROM properties WHERE id = $1 AND landlord_id = $2",
      [propertyId, landlordId]
    );
    if (prop.rows.length === 0) {
      throw new Error("Property not found or not owned by landlord");
    }
    const units = await client.query(
      "SELECT id FROM units WHERE property_id = $1 AND landlord_id = $2",
      [propertyId, landlordId]
    );
    return units.rows.map((r: any) => r.id);
  }
  if (scopeType === 'landlord_all') {
    const units = await client.query(
      "SELECT id FROM units WHERE landlord_id = $1",
      [landlordId]
    );
    return units.rows.map((r: any) => r.id);
  }
  throw new Error(`Unknown scope_type: ${scopeType}`);
}

async function resolveUnitsToApplicableLeases(
  client: any,
  landlordId: string,
  unitIds: string[]
): Promise<Array<{ id: string; unit_id: string; status: string }>> {
  if (unitIds.length === 0) {
    return [];
  }
  const result = await client.query(
    `SELECT id, unit_id, status
     FROM leases
     WHERE unit_id = ANY($1::uuid[])
       AND landlord_id = $2
       AND status IN ('pending', 'active')
     ORDER BY created_at ASC`,
    [unitIds, landlordId]
  );
  return result.rows;
}

export async function buildLeaseFromDocument(documentId: string): Promise<{
  leaseId: string; status: string; primaryTenantId: string; alreadyBuilt: boolean
  /** S652: a packet document signed before its lease has issued — nothing to bind to yet, nothing wrong. */
  deferred?: boolean
}> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // S581 (sweep, Nic): serialize finalization of THIS document. Completion is
    // detected POST-commit with a check-then-act COUNT (see the sign route), so
    // a duplicate or racing final signature — a double-click, or two tied-order
    // co-tenants both submitting last — can have two requests each observe "all
    // signed" and both land here. The lease INSERT below has NO DB backstop
    // (there is no unique link document→lease, and no one-active-lease-per-unit
    // constraint), so the second build materialized a SECOND lease + a SECOND
    // move-in invoice: double deposit + double first-month rent + double PM
    // leasing fee. This xact advisory lock makes the second builder wait for the
    // first to COMMIT; the already-built short-circuit below then no-ops it.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`esign_finalize:${documentId}`])

    const doc = await client.query(
      `SELECT d.*, u.unit_type, p.timezone AS property_timezone
       FROM lease_documents d LEFT JOIN units u ON u.id = d.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE d.id=$1`, [documentId]).then(r => r.rows[0])
    if (!doc) throw new AppError(404, 'Document not found')

    // Idempotent finalization for EVERY document_type. finalized_at is stamped
    // at the END of a successful build below, inside THIS txn — so it commits
    // before the advisory lock releases. A duplicate/concurrent finalization that
    // acquires the lock next sees it set and returns the already-built result
    // instead of applying the document a SECOND time: a second lease + move-in
    // invoice (original_lease), a re-added/removed tenant or re-applied term
    // change (addendums), or a re-activated sublease. The duplicate caller skips
    // all one-time side effects, so the returned ids only need to identify the
    // built artifact (lease for lease/addendum docs, subleases row for subleases).
    if (doc.finalized_at) {
      let leaseId = doc.lease_id ?? ''
      let status = 'active'
      let primaryTenantId = ''
      if (doc.document_type === 'sublease_agreement') {
        const sub = await client.query(
          `SELECT id, status, sublessor_tenant_id FROM subleases WHERE sublease_document_id = $1 LIMIT 1`,
          [documentId]).then((r: any) => r.rows[0])
        if (sub) { leaseId = sub.id; status = sub.status; primaryTenantId = sub.sublessor_tenant_id ?? '' }
      } else if (doc.lease_id) {
        const ex = await client.query(
          `SELECT l.status,
                  (SELECT lt.tenant_id FROM lease_tenants lt
                    WHERE lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
                    ORDER BY lt.added_at LIMIT 1) AS primary_tenant_id
             FROM leases l WHERE l.id = $1`, [doc.lease_id]).then((r: any) => r.rows[0])
        if (ex) { status = ex.status; primaryTenantId = ex.primary_tenant_id ?? '' }
      }
      await client.query('COMMIT')
      return { leaseId, status, primaryTenantId, alreadyBuilt: true }
    }

    // ── S652: A PACKET DOCUMENT BINDS TO THE PACKET'S LEASE ──────────────
    //
    // The disclosures and the installment contract are drafted beside the lease
    // BEFORE the lease exists (services/packetDraft.ts), so they carry no
    // lease_id. Blu signed four of them on MH 06 and each one raised "Lease did
    // not issue — Addendum has no parent lease_id", a critical alert for a
    // document that had nothing to issue. The packet's lease is the parent:
    // once it has issued, every sibling is stamped with it; signed before that,
    // a sibling simply waits — the lease's own issuance stamps it below.
    if (!doc.lease_id && doc.package_group_id && doc.document_type !== 'original_lease') {
      const parent = await client.query(
        `SELECT lease_id FROM lease_documents
          WHERE package_group_id = $1 AND document_type = 'original_lease' AND lease_id IS NOT NULL
          ORDER BY created_at LIMIT 1`, [doc.package_group_id]).then((r: any) => r.rows[0])
      if (parent?.lease_id) {
        await client.query(`UPDATE lease_documents SET lease_id = $2, updated_at = NOW() WHERE id = $1`, [doc.id, parent.lease_id])
        doc.lease_id = parent.lease_id
      } else {
        await client.query('COMMIT')
        return { leaseId: '', status: 'deferred', primaryTenantId: '', alreadyBuilt: false, deferred: true }
      }
    }

    let result: { leaseId: string; status: string; primaryTenantId: string }
    switch (doc.document_type) {
      case 'original_lease':
        result = await executeOriginalLease(client, doc)
        // S652: the packet's other documents now have a lease to belong to.
        if (doc.package_group_id) {
          await client.query(
            `UPDATE lease_documents SET lease_id = $2, updated_at = NOW()
              WHERE package_group_id = $1 AND lease_id IS NULL AND id <> $3`,
            [doc.package_group_id, result.leaseId, doc.id])
        }
        break
      case 'addendum_add':
        result = await executeAddendumAdd(client, doc)
        break
      case 'addendum_remove':
        result = await executeAddendumRemove(client, doc)
        break
      case 'addendum_terms':
        result = await executeAddendumTerms(client, doc)
        break
      case 'sublease_agreement': {
        // S251: sublease completion. Different shape from lease docs —
        // there's no lease build; we flip the linked subleases row to
        // 'active' and stamp the document URL. Return shape stays
        // lease-shaped (`leaseId`=sublease_id) so the dispatcher's
        // return signature doesn't need to change; downstream
        // consumers that key on it for sublease docs are aware.
        // S337: pass the open client so the sublease flip runs inside
        // buildLeaseFromDocument's BEGIN/COMMIT and rolls back atomically
        // if anything downstream fails.
        const { executeSubleaseAgreementCompletion } = await import('../services/subleaseDocuments')
        const sub = await executeSubleaseAgreementCompletion({ documentId: doc.id }, client)
        // Get the sublessor_tenant_id for the lease-shaped return.
        const subleaseRow = await client.query(
          'SELECT sublessor_tenant_id FROM subleases WHERE id=$1',
          [sub.subleaseId]).then((r: any) => r.rows[0])
        result = {
          leaseId:         sub.subleaseId,
          status:          sub.status,
          primaryTenantId: subleaseRow?.sublessor_tenant_id ?? '',
        }
        break
      }
      default:
        throw new AppError(400, `Unknown document_type: ${doc.document_type}`)
    }

    // S581: mark the document finalized so a duplicate/concurrent build no-ops
    // (checked under the advisory lock at the top). Same txn as the build.
    await client.query('UPDATE lease_documents SET finalized_at = NOW() WHERE id = $1', [documentId])
    await client.query('COMMIT')
    return { ...result, alreadyBuilt: false }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * S111: post a one-time leasing fee for the contracted PM company when
 * applicable. Reads properties.pm_company_id + pm_fee_plan_id via the unit;
 * checks the plan's leasing_fee_amount; posts allocation_pm_company_fee
 * ledger entry to the PM company's payout user. No-op for self-managed
 * properties or plans without a leasing fee.
 */
async function postLeasingFeeIfApplicable(client: any, leaseId: string, unitId: string): Promise<void> {
  const r = await client.query(`
    SELECT p.id AS property_id,
           p.pm_company_id, p.pm_fee_plan_id,
           c.bank_account_id AS pm_bank_account_id,
           ba.user_id AS pm_payout_user_id,
           fp.leasing_fee_amount
      FROM units u
      JOIN properties p ON p.id = u.property_id
 LEFT JOIN pm_companies c ON c.id = p.pm_company_id
 LEFT JOIN pm_fee_plans fp ON fp.id = p.pm_fee_plan_id
 LEFT JOIN user_bank_accounts ba ON ba.id = c.bank_account_id
     WHERE u.id = $1`, [unitId])
  if (r.rowCount === 0) return
  const row = r.rows[0]
  if (!row.pm_company_id || !row.pm_fee_plan_id) return
  if (row.leasing_fee_amount === null || parseFloat(row.leasing_fee_amount) <= 0) return
  if (!row.pm_payout_user_id) {
    throw new AppError(409,
      `PM company ${row.pm_company_id} has no bank routing — cannot post leasing fee.`)
  }

  const amount = round2Esign(parseFloat(row.leasing_fee_amount))

  // Per-user advisory lock — same key allocation.ts uses.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`user_balance:${row.pm_payout_user_id}`]
  )
  const prev = await client.query(
    `SELECT balance_after FROM user_balance_ledger
      WHERE user_id=$1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [row.pm_payout_user_id]
  )
  const prevBal = prev.rows[0] ? parseFloat(prev.rows[0].balance_after) : 0
  const newBal = round2Esign(prevBal + amount)

  await client.query(
    `INSERT INTO user_balance_ledger
       (user_id, type, amount, balance_after, reference_id, reference_type,
        property_id, bank_account_id, notes)
     VALUES ($1, 'allocation_pm_company_fee', $2, $3, $4, 'lease',
             $5, $6, $7)`,
    [row.pm_payout_user_id, amount, newBal, leaseId, row.property_id,
     row.pm_bank_account_id,
     `PM company leasing fee on lease ${leaseId} (plan ${row.pm_fee_plan_id})`]
  )
}

function round2Esign(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Execute an original_lease document: INSERT a new leases row + lease_tenants
 * rows for every tenant signer. Sets unit status to active if lease starts
 * today/past. Receives the already-open client — caller owns transaction.
 */
async function executeOriginalLease(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.unit_id) throw new AppError(400, 'Document has no unit — cannot build lease')

  // Read all field values mapped to lease columns
  const fields = await client.query(
    `SELECT lease_column, value, signer_role FROM lease_document_fields
     WHERE document_id=$1 AND lease_column IS NOT NULL`, [doc.id]).then((r: any) => r.rows)
  // Drop identity + signature tags; writable + fee_row + utility_row tags
  // all populate `vals`. WRITABLE_LEASE_COLUMN_SPECS / FEE_ROW_SPECS /
  // UTILITY_ROW_SPECS each only read their own per-tag key from vals, so
  // sharing the dict across all three downstream consumers is safe.
  // S334 fix-it-right: previously this filter kept only 'writable', which
  // silently zeroed out lease_fees + lease_utility_responsibilities at
  // every completion (S28 chain wired but never executed). No production
  // exposure because pre-launch.
  const vals: LeaseColumnVals = {}
  // S622: this loop used to be `vals[col] = f.value` — last row wins, on a query
  // with no ORDER BY. A template whose move-in table tagged four different
  // amounts as rent_amount ("First month's rent", "Rent pre-payment",
  // "Proration", "Total due") would therefore set the tenant's MONTHLY RENT from
  // whichever row Postgres returned last. The placer now allows only one owner
  // per money column, but a template can also be hand-edited, so refuse the
  // ambiguity here rather than resolve it arbitrarily: silently charging a
  // tenant the move-in total every month is far worse than failing to build.
  //
  // Duplicates that AGREE are harmless (the same figure restated on the lease).
  const seen: Record<string, string> = {}
  for (const f of fields) {
    const col = f.lease_column as LeaseColumn | null
    if (!col) continue
    if (!(col in LEASE_COLUMN_CATEGORY)) continue
    const cat = LEASE_COLUMN_CATEGORY[col]
    if (cat === 'identity' || cat === 'signature') continue
    if (f.value == null) continue
    const v = String(f.value).trim()
    if (col in seen && seen[col] !== v) {
      throw new AppError(400,
        `This lease has two different values tagged "${col}" (${seen[col]} and ${v}). ` +
        `Open the template, and leave that tag on only the field that states the lease's ${col} — ` +
        `the others can stay as plain text boxes.`)
    }
    seen[col] = v
    vals[col] = f.value
  }

  // Gather all tenant signers
  const tenantRows = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, s.order_index, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1
     ORDER BY s.order_index`, [doc.id]).then((r: any) => r.rows)

  const tenantSigners = tenantRows.filter((r:any) => isTenantRole(r.role))
  const primarySigner = tenantSigners.find((r:any) => r.role === 'primary')
  if (!primarySigner) throw new AppError(400, 'No primary tenant signer found')
  if (!primarySigner.tenant_id) throw new AppError(400, `Primary signer ${primarySigner.email} has no tenant profile`)
  for (const t of tenantSigners) {
    if (!t.tenant_id) throw new AppError(400, `Signer ${t.email} has no tenant profile`)
  }

  // Platform block check on every tenant
  for (const t of tenantSigners) {
    const blk = await checkPlatformBlock(t.user_id)
    if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
  }

  // Required fields
  const startDate = vals.start_date
  const rentAmount = vals.rent_amount
  if (!startDate) throw new AppError(400, 'Template missing start_date field — cannot build lease')
  if (!rentAmount) throw new AppError(400, 'Template missing rent_amount field — cannot build lease')

  // Overlap check across EVERY tenant
  const allTenantIds = tenantSigners.map((t:any) => t.tenant_id)
  // S654: '-' is month to month (no end date), as on the send and sign paths.
  const endForOverlap = vals.end_date && String(vals.end_date).trim() !== '-' ? vals.end_date : null
  // S655: a new lease for a household already living there is not an overlap
  // with the lease it follows (renewalSuccessor ends that one the day before).
  const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startDate, endForOverlap, [doc.renews_lease_id])
  if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')

  // Status: future start → pending, today/past → active.
  // S654: "today" is the PROPERTY's calendar day, compared as dates — not the
  // API host's midnight against a field parsed in whatever zone it lands.
  const startIso = leaseFieldDate(startDate)
  const leaseStatus = startIso && startIso > todayIn(doc.property_timezone) ? 'pending' : 'active'

  // INSERT lease — writable-column portion dynamically assembled from the
  // shared spec registry. Adding a new writable value to WRITABLE_LEASE_COLUMN_SPECS
  // in @gam/shared automatically wires it into lease creation; no change here.
  // Object.entries preserves insertion order → column list and values align pairwise.
  const writableCols: string[] = []
  const writablePlaceholders: string[] = []
  const writableValues: (string | number | boolean | null)[] = []
  let paramIdx = 1
  for (const [, spec] of Object.entries(WRITABLE_LEASE_COLUMN_SPECS)) {
    const parsed = spec.parse(vals)
    for (const [col, val] of Object.entries(parsed)) {
      writableCols.push(col)
      writablePlaceholders.push('$' + paramIdx)
      writableValues.push(val)
      paramIdx++
    }
  }
  // S648: a lease with no readable due day takes the property's rule.
  //
  // RENEWAL first (Nic: "people get billed on their due date according to how
  // the landlord sets the property"): a renewal is not a move-in, so with no
  // due-day box on the form the household keeps the day it is already on — a
  // move-in-day tenant the day they first moved in, a fixed-day tenant the
  // property's day. Reading the renewal's start instead moved a tenant due on
  // the 1st to the 15th and billed June 15–30 twice. A due-day box on the form
  // is how a landlord changes it.
  const carriedDueDay: number | null = !writableCols.includes('rent_due_day') && doc.renews_lease_id
    ? await client.query(`SELECT rent_due_day FROM leases WHERE id = $1`, [doc.renews_lease_id])
        .then((r: any) => r.rows[0]?.rent_due_day ?? null)
    : null
  if (carriedDueDay != null) {
    writableCols.push('rent_due_day')
    writablePlaceholders.push('$' + paramIdx)
    writableValues.push(Number(carriedDueDay))
    paramIdx++
  }
  if (!writableCols.includes('rent_due_day')) {
    const rule = await client.query(
      `SELECT p.rent_due_mode, p.rent_due_day FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`, [doc.unit_id]).then((r: any) => r.rows[0])
    const intentRule = await client.query(
      `SELECT bool_or(COALESCE(is_existing_tenancy, false)) AS e, MAX(rent_due_day) AS invite_day
         FROM pending_tenant_intents
        WHERE unit_id = $1 AND cancelled_at IS NULL`, [doc.unit_id]).then((r: any) => r.rows[0])
    const existingRule = intentRule?.e === true
    writableCols.push('rent_due_day')
    writablePlaceholders.push('$' + paramIdx)
    // S652: the day stated on the invite, when there is one.
    writableValues.push(intentRule?.invite_day != null ? Number(intentRule.invite_day) : leaseDueDay({
      mode: existingRule ? 'fixed_day' : (rule?.rent_due_mode ?? 'fixed_day'),
      propertyDay: rule?.rent_due_day ?? 1,
      // S654: a M/D/YYYY start could not be read, so every move_in_day lease fell back to the 1st.
      startIso: leaseFieldDate(vals.start_date),
    }))
    paramIdx++
  }
  // Fixed-shape tail columns (not driven by lease_column fields)
  // S647: has every non-landlord signer finished? At issuance the answer is no —
  // the landlord has just signed and the tenant has not seen it yet.
  const tenantHasSigned = await client.query(
    `SELECT COUNT(*)::int AS outstanding FROM lease_document_signers
      WHERE document_id = $1 AND role <> 'landlord' AND status <> 'signed'`,
    [doc.id]).then((r: any) => r.rows[0].outstanding === 0)

  const tailCols = ['unit_id', 'landlord_id', 'status']
  const tailValues: (string | null)[] = [doc.unit_id, doc.landlord_id, leaseStatus]
  const tailPlaceholders = tailCols.map((_, i) => '$' + (paramIdx + i))

  const lease = await client.query(
    `INSERT INTO leases (
       ${writableCols.join(', ')},
       ${tailCols.join(', ')},
       signed_by_landlord, signed_by_tenant, signed_at,
       needs_review
     ) VALUES (
       ${writablePlaceholders.join(', ')},
       ${tailPlaceholders.join(', ')},
       TRUE, $${paramIdx + tailCols.length}, $${paramIdx + tailCols.length + 1},
       FALSE
     ) RETURNING id, status`,
    // S647: these used to be hardcoded TRUE, TRUE, NOW() because a lease could
    // only be built once every signer was done. The landlord's signature now
    // builds it, so the tenant's may genuinely still be outstanding — and the
    // lease PDF prints these two flags as the signature block. Writing TRUE
    // there would put a signature on a document nobody signed.
    [...writableValues, ...tailValues, tenantHasSigned, tenantHasSigned ? new Date() : null]
  ).then((r: any) => r.rows[0])

  // S631 (Nic): carry "this papers an existing tenancy" from the invite onto the
  // lease. The invite is where the landlord said which it was; the lease is
  // where every downstream reader — move-in billing today, an onboarding-cohort
  // report next year — needs to find it without reconstructing it from dates.
  // Any intent for this unit that this signing resolves; onboarding invites are
  // per unit and per resident, so the flag agrees across them.
  {
    const intent = await client.query(
      `SELECT bool_or(COALESCE(is_existing_tenancy, false)) AS existing
         FROM pending_tenant_intents
        WHERE unit_id = $1 AND cancelled_at IS NULL
          AND (resolved_at IS NULL OR resolved_lease_id = $2)`,
      [doc.unit_id, lease.id])
    // A renewal is not an onboarding, whatever invite is still open on the
    // unit: its billing continues the household's schedule (below), and the
    // onboarding first-bill rules must never reach it.
    if (intent.rows[0]?.existing && !doc.renews_lease_id) {
      await client.query('UPDATE leases SET is_existing_tenancy = TRUE WHERE id=$1', [lease.id])
    }
  }

  // RENEWAL: link the tenancy. The new lease continues the one it renews —
  // the nightly bill run reads this link to bill one schedule across both
  // leases (invoiceGeneration, isRenewalSuccessor), the lease-end job to hand
  // the open items over, and the renewal-tendency report to count it.
  if (doc.renews_lease_id) {
    await client.query('UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1', [lease.id, doc.renews_lease_id])
    // The landlord's cap on how much paid-ahead money each bill may use goes
    // with the household: the hand-off moves the paid-ahead credit to this
    // lease, and with no cap here the first bill would swallow all of it.
    await client.query(
      `UPDATE leases SET prepaid_monthly_draw = COALESCE(prepaid_monthly_draw,
              (SELECT prepaid_monthly_draw FROM leases WHERE id = $2))
        WHERE id = $1`, [lease.id, doc.renews_lease_id])
    // S655 (Nic, 10/2): the lease it follows ends the day before this one
    // starts. Normally that is written on the start date by the 2am job; a new
    // lease signed on or after its own start date closes it now.
    if (lease.status === 'active') {
      const { closePredecessorOfStartedRenewals } = await import('../services/renewalSuccessor')
      await closePredecessorOfStartedRenewals(client.query.bind(client),
        { renewalLeaseId: lease.id, today: todayIn(doc.property_timezone) })
    }
  }

  // ── S638 (Nic): A SIGNED LEASE CLOSES THE INVITE ────────────────────────
  //
  //   "Stuff doesn't go away after it's completed. Like, Tyler Rhoades is still
  //    on there even though he's accepted his tenant portal invite."
  //
  // Only the PDF-IMPORT path ever set resolved_at. Every lease signed
  // electronically left its intent open forever, so the pending pool kept
  // showing residents who had finished months of onboarding — 34 of them, each
  // with a live lease. The invite has done its job the moment the lease exists.
  {
    const closed = await client.query(
      `UPDATE pending_tenant_intents
          SET resolved_at = NOW(), resolved_lease_id = $1,
              parser_status = 'resolved', updated_at = NOW()
        WHERE tenant_id = ANY($2::uuid[])
          AND unit_id = $3
          AND cancelled_at IS NULL AND resolved_at IS NULL
        RETURNING id`,
      [lease.id, tenantSigners.map((t: any) => t.tenant_id), doc.unit_id])
    if (closed.rowCount) {
      logger.info({ leaseId: lease.id, intents: closed.rowCount },
        '[esign] invite(s) closed by the signed lease')
    }
  }

  // S631 (Nic, DIRECTIVE): "Let's flag on invite so that no matter when they
  // accept it, the work-trade agreement has inserted it slightly before the
  // invoice is created... That way it's automatically in a suspended state."
  //
  // Created HERE — after the lease exists, before generateMoveInInvoice below —
  // because that is the only window in which both facts are true: there is a
  // lease for the agreement to attach to, and no invoice has been written yet.
  // The move-in invoice reads this agreement to decide late_fee_exempt, so the
  // first invoice is exempt from birth rather than being repaired afterwards.
  //
  // The agreement starts on the LEASE's start date, not today: the trade covers
  // the tenancy, and a later start would leave the first cycle chargeable —
  // precisely the gap this is here to close.
  {
    const wtIntent = await client.query(
      `SELECT work_trade_hours_target, work_trade_duties, work_trade_covered_charges,
              work_trade_tracks_hours
         FROM pending_tenant_intents
        WHERE unit_id = $1 AND is_work_trade = TRUE AND cancelled_at IS NULL
          AND (resolved_at IS NULL OR resolved_lease_id = $2)
        LIMIT 1`,
      [doc.unit_id, lease.id])
    if (wtIntent.rows[0]) {
      const propDefault = await client.query(
        `SELECT p.work_trade_hours_target FROM properties p
           JOIN units u ON u.property_id = p.id WHERE u.id = $1`, [doc.unit_id])
      // S635 (Nic): WHAT THE TRADE COVERS RIDES FROM THE INVITE.
      //
      // This used to pass no covered_charges at all, so every agreement took the
      // column default — rent, fees and every utility. For an arrangement like
      // Mountain View's MH 01 ("covers electricity and propane") that silently
      // suspended the RENT too, on the resident's first invoice, and the mistake
      // shows up as somebody who was never billed for what they owe. NULL on the
      // intent still means "not stated" and still takes the table default, so an
      // invite flagged before this existed behaves exactly as it did.
      const covers: string[] | null = wtIntent.rows[0].work_trade_covered_charges ?? null
      // S637: the parent switch rides in too. NULL on the intent means "not
      // stated" and creates a normal tracked agreement, so invites written
      // before this behave exactly as they did.
      const tracksHours = wtIntent.rows[0].work_trade_tracks_hours !== false
      // 10/6: the ONE insert of an agreement's terms (services/stayWorkTrade) —
      // the hours default to the property's setting, the covered charges to
      // everything — shared with the Work Trade page and a work trade on a stay.
      const { insertWorkTradeAgreement } = await import('../services/stayWorkTrade')
      await insertWorkTradeAgreement(client, {
        unitId: doc.unit_id, tenantId: primarySigner.tenant_id, landlordId: doc.landlord_id,
        duties: wtIntent.rows[0].work_trade_duties || null, startDate, endDate: null,
        hoursTarget: wtIntent.rows[0].work_trade_hours_target ?? propDefault.rows[0]?.work_trade_hours_target ?? null,
        tracksHours, coveredCharges: covers,
      })
    }
  }

  // S577: stamp late_fee_accrual_from onto the lease from the (property, unit_type)
  // policy. It's a computation QUALIFIER on the daily-accrual clause, not a
  // fillable box — so it rides directly from the policy rather than a template
  // field (keeping existing late-fee templates draftable / document-first intact).
  // The retroactive nature is rendered into the late-fee clause text the tenant
  // signs (services/leasePdf.ts). Resolved at sign-completion; policy rarely
  // changes between draft and sign, and existing signed leases keep 'grace_end'.
  {
    const plf = await resolveLateFeePolicyForUnit(doc.unit_id, client)
    if (plf && plf.late_fee_accrual_from && plf.late_fee_accrual_from !== 'grace_end') {
      await client.query('UPDATE leases SET late_fee_accrual_from=$1 WHERE id=$2',
        [plf.late_fee_accrual_from, lease.id])
    }
  }

  // S196: security_deposit is now part of FEE_ROW_SPECS, which the
  // loop below iterates and inserts into lease_fees automatically.
  // The S195 dual-write helper call has been removed here — FEE_ROW
  // pipeline is the canonical path.

  // INSERT lease_tenants rows — one per signer, with per-tenant supersedes chain
  for (const t of tenantSigners) {
    const priorLt = await client.query(`
      SELECT id FROM lease_tenants
      WHERE tenant_id=$1 AND status='removed'
      ORDER BY removed_at DESC NULLS LAST, created_at DESC
      LIMIT 1`, [t.tenant_id]).then((r: any) => r.rows[0])

    const role = t.role === 'primary' ? 'primary' : 'co_tenant'
    await client.query(`
      INSERT INTO lease_tenants (
        lease_id, tenant_id, role, status,
        added_at, added_reason, financial_responsibility,
        add_document_id, supersedes_lease_tenant_id
      ) VALUES ($1,$2,$3,'active', NOW(), 'original', 'joint_several', $4, $5)`,
      [lease.id, t.tenant_id, role, doc.id, priorLt?.id || null])
  }

  // Link document → lease
  await client.query('UPDATE lease_documents SET lease_id=$1 WHERE id=$2', [lease.id, doc.id])

  // S652 — A HOME SALE DRAFTED BEFORE THE LEASE EXISTED NOW GETS ITS LEASE.
  //
  // Nic, on sending a lease and an installment contract as one packet to a
  // brand-new tenant: "I don't understand why it's any different for a brand
  // new tenancy or onboarding. It's still two signatures for two separate
  // documents. What does being a new tenant have to do with it?"
  //
  // Nothing, is the answer — but the plumbing assumed otherwise. A purchase
  // agreement can be drafted with no lease (home_sale_contracts.lease_id is
  // nullable and POST /home-sales has never required one), and for a NEW
  // tenancy there is nothing to point at yet, because the lease does not exist
  // until this signature creates it. Left alone, the contract would bill
  // installments against a null lease for the rest of its term: charges with
  // nothing to group them under, on a tenant portal built around a lease.
  //
  // So the lease adopts them the moment it exists. Scoped to this unit and the
  // people on this lease — a contract for a DIFFERENT tenant on the same unit
  // (the previous owner still paying off a home) must not be dragged onto a new
  // resident's lease.
  await client.query(
    `UPDATE home_sale_contracts hsc
        SET lease_id = $1, updated_at = NOW()
      WHERE hsc.lease_id IS NULL
        AND hsc.unit_id = $2
        AND hsc.status IN ('pending_signature', 'active')
        AND EXISTS (
          SELECT 1 FROM lease_tenants lt
           WHERE lt.lease_id = $1 AND lt.tenant_id = hsc.tenant_id)`,
    [lease.id, doc.unit_id])


  // S655 (decisions 10/2): a balance owed on the landlord's OLD system, from
  // the tenant CSV's draft roster, posts as ONE charge on this household's
  // lease now that the lease exists — on the landlord's signature, or on the
  // resident's own when they belong to another company. Same shape as a
  // landlord-entered carried balance; nothing posts for anyone without one.
  if (!doc.renews_lease_id) {
    const { postRosterOpeningBalance } = await import('../services/newLeaseInvite')
    await postRosterOpeningBalance(client, {
      leaseId: lease.id, unitId: doc.unit_id, landlordId: doc.landlord_id,
      tenantId: primarySigner.tenant_id, timezone: doc.property_timezone ?? null,
    })
  }

  // ────────────────────────────────────────────────────────────────────────
  // S111: PM company leasing fee. If this property is contracted to a PM
  // company on a plan with leasing_fee_amount set, post a one-time
  // 'allocation_pm_company_fee' ledger entry. Fires regardless of the
  // plan's primary fee_type — composite plans (e.g. flat_monthly +
  // leasing_fee_amount) both fire monthly and on lease creation.
  // reference_id = lease.id, reference_type = 'lease' so it doesn't
  // collide with rent-payment or monthly-accrual ledger references.
  // Idempotent via the lease.id reference (lease can only be created
  // once; if buildLeaseFromDocument is retried after a partial failure,
  // the surrounding tx ROLLBACKs the whole chain).
  await postLeasingFeeIfApplicable(client, lease.id, doc.unit_id)

  // ────────────────────────────────────────────────────────────────────────
  // S28: write lease_fees rows from FEE_ROW_SPECS
  // Each spec returns null when the tag is not bound; non-null = INSERT.
  // S154: each row is compared against the property's fee schedule
  // (anti-discrimination policy). If amount/timing/refundable doesn't
  // match a corresponding schedule row, is_override is flagged TRUE so
  // landlord can document the rationale post-finalize.
  // ────────────────────────────────────────────────────────────────────────
  // S648: the schedule is per unit type — compare against this unit's rows.
  const unitRow: { property_id: string; unit_type: string } | undefined = await client.query(
    `SELECT property_id, unit_type FROM units WHERE id = $1`,
    [doc.unit_id],
  ).then((r: any) => r.rows[0])
  const scheduleRows: any[] = unitRow
    ? await client.query(
        `SELECT fee_type, slot_index, description, amount, is_refundable, due_timing
           FROM property_fee_schedules
          WHERE property_id = $1 AND unit_type = $2`,
        [unitRow.property_id, unitRow.unit_type],
      ).then((r: any) => r.rows)
    : []
  // Index by fee_type for single-instance types (slot_index=0).
  // other_fee comparison is best-effort: match the first slot since the
  // doc parser only produces one other_fee row per lease.
  const scheduleByType: Record<string, any> = {}
  for (const s of scheduleRows) {
    if (!scheduleByType[s.fee_type]) scheduleByType[s.fee_type] = s
  }

  // S653 (Nic): the landlord's tag on each money box — fee / deposit / prepaid —
  // decides what the money IS. Read off the template the document came from.
  const boxKinds: Record<string, any> = {}
  if (doc.template_id) {
    const kindRows = await client.query(
      `SELECT lease_column, money_kind FROM lease_template_fields
        WHERE template_id = $1 AND money_kind IS NOT NULL AND lease_column IS NOT NULL`, [doc.template_id])
    for (const r of kindRows.rows as any[]) boxKinds[r.lease_column] = r.money_kind
  }
  // S653: the box's own printed label ("Rent pre-payment", "Pet deposit") is
  // what the tenant sees on the invoice and receipt — not the tag's name.
  const boxLabels: Record<string, string> = {}
  for (const r of (await client.query(
    `SELECT lease_column, label FROM lease_document_fields
      WHERE document_id = $1 AND lease_column IS NOT NULL AND label IS NOT NULL`, [doc.id])).rows as any[]) {
    if (!boxLabels[r.lease_column]) boxLabels[r.lease_column] = String(r.label).trim()
  }
  for (const [, spec] of Object.entries(FEE_ROW_SPECS)) {
    const parsed = spec.parse(vals, boxKinds)
    if (!parsed) continue

    // S534: on a RENEWAL the deposit printed in the document is the
    // CARRIED deposit — the tenant already paid it on the predecessor
    // lease and the money never moves. NEVER re-bill the carried amount;
    // the renews_lease_id carry-forward INSERT (after invoice generation)
    // copies the predecessor's rows instead. The double-count guard:
    //   doc value == carried → nothing bills (pure carry)
    //   doc value >  carried → bill ONLY the difference as a tagged
    //     top-up row, and raise the custody target so the settlement
    //     helper records the pull (a 'funded' row flips to 'partial'
    //     until the top-up lands)
    //   doc value <  carried → no automatic refund; the landlord
    //     processes a partial return from the deposit tools (the sign
    //     flow's overlay says exactly this before they enter a number)
    if (doc.renews_lease_id && parsed.due_timing === 'move_in' && parsed.is_refundable) {
      const carried = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM lease_fees
          WHERE lease_id=$1 AND fee_type=$2 AND due_timing='move_in' AND is_refundable=TRUE`,
        [doc.renews_lease_id, parsed.fee_type],
      ).then((r: any) => Number(r.rows[0]?.total || 0))
      const delta = Math.round((Number(parsed.amount) - carried) * 100) / 100
      if (delta > 0) {
        // money_kind rides with it: without it the row took the column default
        // ('fee'), and a pet-deposit increase billed as the landlord's own
        // money instead of a deposit held for the household (S653).
        await client.query(
          `INSERT INTO lease_fees (
             lease_id, fee_type, amount, is_refundable, due_timing, description, is_override, money_kind
           ) VALUES ($1, $2, $3, TRUE, 'move_in', $4, FALSE, $5)`,
          [lease.id, parsed.fee_type, delta.toFixed(2),
           `[deposit top-up on renewal] $${carried.toFixed(2)} carried + $${delta.toFixed(2)} newly billed`,
           parsed.money_kind],
        )
        await client.query(
          `UPDATE security_deposits
              SET total_amount = total_amount + $2::numeric,
                  status = CASE WHEN status = 'funded' THEN 'partial' ELSE status END,
                  updated_at = NOW()
            WHERE lease_id = $1 AND flex_deposit_enabled = FALSE`,
          [doc.renews_lease_id, delta.toFixed(2)],
        )
      }
      continue
    }

    // Determine override flag: TRUE when no schedule row exists OR
    // amount / timing / refundable differs.
    const sched = scheduleByType[parsed.fee_type]
    let isOverride = true
    if (sched
        && Number(sched.amount) === Number(parsed.amount)
        && sched.is_refundable === parsed.is_refundable
        && sched.due_timing === parsed.due_timing) {
      isOverride = false
    }
    // If property has no schedule at all, treat as not-an-override
    // (no policy to deviate from). Only flag when a schedule exists
    // for this fee_type AND the lease row differs.
    if (!sched) isOverride = false

    await client.query(
      `INSERT INTO lease_fees (
         lease_id, fee_type, amount, is_refundable, due_timing, is_override, money_kind, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [lease.id, parsed.fee_type, parsed.amount, parsed.is_refundable, parsed.due_timing, isOverride, parsed.money_kind,
       boxLabels[parsed.fee_type] ?? null]
    )
  }

  // ────────────────────────────────────────────────────────────────────────
  // S622: conditional fees the template states in PROSE — no blank, so no
  // tagged field could ever carry them. The landlord confirmed these on the
  // template; every lease sent from it inherits them.
  //
  // Written in the SAME shape the import path uses (resolveIntent, S550):
  // other_fee / move_out / condition_text verbatim. That shape is what makes
  // the deposit-return sum skip them until a human assesses the condition as
  // failed at the move-out inspection — unassessed or met never charges.
  //
  // Nic's requirement, and the reason this is here and not only on import:
  // "some leases are gonna be imported, scanned PDFs, and other ones are gonna
  // be electronic signature. It needs to work both ways universally."
  // ────────────────────────────────────────────────────────────────────────
  // S622: LEASE IS LAW. When the template states its late-fee terms in prose,
  // those words are what the parties signed, so they are what GAM charges —
  // stamped onto the lease rather than left to the property policy, which may
  // say something else. Oak Park's clause reads "$5.00 per day … not received by
  // the due date" while the property policy carried a five-day grace; the
  // document wins.
  if (doc.template_id) {
    const lft = await client.query(
      'SELECT late_fee_terms FROM lease_templates WHERE id=$1', [doc.template_id]
    ).then((r: any) => r.rows[0]?.late_fee_terms ?? null)
    if (lft) {
      await client.query(
        `UPDATE leases SET
           late_fee_enabled        = TRUE,
           late_fee_grace_days     = COALESCE($2, late_fee_grace_days),
           late_fee_initial_amount = COALESCE($3, late_fee_initial_amount),
           late_fee_initial_type   = COALESCE($4, late_fee_initial_type),
           late_fee_accrual_amount = COALESCE($5, late_fee_accrual_amount),
           late_fee_accrual_type   = COALESCE($6, late_fee_accrual_type),
           late_fee_accrual_period = COALESCE($7, late_fee_accrual_period)
         WHERE id = $1`,
        [lease.id, lft.graceDays, lft.initialAmount, lft.initialType,
         lft.accrualAmount, lft.accrualType, lft.accrualPeriod])
    }
  }

  if (doc.template_id) {
    const tcf = await client.query(
      `SELECT label, amount, condition_text FROM lease_template_conditional_fees
        WHERE template_id = $1`, [doc.template_id]).then((r: any) => r.rows)
    for (const cf of tcf as any[]) {
      // S622 belt-and-braces: screening fees are already filtered out before a
      // landlord ever confirms one, but a row could be inserted by hand or
      // predate that filter. A background-check fee must never become a charge.
      if (isScreeningFeeText(cf.condition_text)) continue
      await client.query(
        `INSERT INTO lease_fees
           (lease_id, fee_type, amount, is_refundable, due_timing, description, condition_text)
         VALUES ($1, 'other_fee', $2, FALSE, 'move_out', $3, $4)`,
        [lease.id, cf.amount, String(cf.label).slice(0, 120), String(cf.condition_text).slice(0, 1000)])
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // S28: write lease_utility_responsibilities rows from UTILITY_ROW_SPECS
  // One row per tagged utility recording who is contractually responsible.
  // Meter pointer (lease_utility_assignments) is a separate operational
  // concern set by landlord later.
  // ────────────────────────────────────────────────────────────────────────
  for (const [, spec] of Object.entries(UTILITY_ROW_SPECS)) {
    const parsed = spec.parse(vals)
    if (!parsed) continue
    await client.query(
      `INSERT INTO lease_utility_responsibilities (
         lease_id, utility_type, tenant_responsible
       ) VALUES ($1, $2, $3)`,
      [lease.id, parsed.utility_type, parsed.tenant_responsible]
    )
  }

  // If activating now, set unit status
  if (leaseStatus === 'active') {
    await client.query(
      `UPDATE units SET status='active', updated_at=NOW() WHERE id=$1`,
      [doc.unit_id])
  }

  // S636 (Nic, DIRECTIVE): THE SIGNED RENT IS THE UNIT'S RENT.
  //
  // "The lease document says $589, and that's what the rent should be. But the
  // unit details are showing her balance as $460. We need a way to make those
  // synchronous at all times... if I type something else in the new document
  // that's going out — maybe I forgot to update the unit details — it needs to
  // automatically update the corresponding unit details to match."
  //
  // Execution wrote the amount onto the LEASE and left `units.rent_amount`
  // stale, so MH 09 was papered at $589 while every unit-level screen still said
  // $460. The signed document is the authority (see the lease-is-law rule), so
  // it wins here rather than being reconciled by hand later.
  //
  // Only when the document actually states one — a renewal or addendum that
  // leaves rent alone must not blank the unit's figure.
  if (doc.unit_id && Number(vals.rent_amount) > 0) {
    await client.query(
      `UPDATE units SET rent_amount = $2, updated_at = NOW()
        WHERE id = $1 AND rent_amount IS DISTINCT FROM $2`,
      [doc.unit_id, Number(vals.rent_amount)])
  }

  // ────────────────────────────────────────────────────────────────────────
  // S28: generate move-in invoice on the same transaction. Reads
  // lease_fees rows we just inserted via the same client (visible because
  // shared connection at READ COMMITTED). Throws on failure → outer
  // buildLeaseFromDocument catches → entire chain rolls back atomically.
  // ────────────────────────────────────────────────────────────────────────
  const rentAmountNum = Number(vals.rent_amount)
  if (!Number.isFinite(rentAmountNum) || rentAmountNum <= 0) {
    throw new AppError(400, `Invalid rent_amount: ${vals.rent_amount}`)
  }
  // ────────────────────────────────────────────────────────────────────────
  // S604 (Nic): DEPOSIT ALREADY IN CUSTODY — migration onboarding.
  //
  // A landlord moving EXISTING tenants onto GAM has them e-sign a new lease.
  // Without this, generateMoveInInvoice bills the security deposit to a tenant
  // whose deposit the landlord has held for years. Oak Park would have invoiced
  // 19 sitting tenants $350 each on day one.
  //
  // The lease still STATES the deposit (the lease_fees row above is written
  // normally) so the signed document is correct and the move-out sweep still
  // sees it — only the BILLING is suppressed.
  //
  // Implemented by pre-creating the custody row as already funded and marking it
  // 'carried_forward', which is the same signal the S516 double-charge guard in
  // generateMoveInInvoice already honors for a deposit carried between GAM
  // leases. Reusing that guard rather than adding a second suppression path
  // keeps one code path responsible for "never bill a deposit twice".
  if (doc.deposit_already_held) {
    const depFee = await client.query(
      `SELECT amount::text AS amount FROM lease_fees
        WHERE lease_id = $1 AND fee_type = 'security_deposit' AND due_timing = 'move_in'
        LIMIT 1`,
      [lease.id])
    const heldAmount = Number((depFee.rows[0] as any)?.amount ?? 0)
    if (heldAmount > 0 && primarySigner.tenant_id) {
      // held_by mirrors the S604 custody gate: GAM only takes custody where the
      // state permits its vehicle. A migrated deposit the landlord physically
      // holds stays with the landlord regardless, so this is landlord-held.
      // security_deposits has NO unique constraint on lease_id, so this is a
      // check-then-act rather than an upsert. Safe: buildLeaseFromDocument runs
      // inside one transaction holding an advisory lock on this document.
      const existingDep = await client.query(
        `SELECT id FROM security_deposits WHERE lease_id = $1 LIMIT 1`, [lease.id])
      if (existingDep.rows[0]) {
        await client.query(
          `UPDATE security_deposits
              SET total_amount = $2, collected_amount = $2, status = 'funded',
                  held_by = 'landlord', portability_status = 'carried_forward',
                  updated_at = NOW()
            WHERE id = $1`,
          [(existingDep.rows[0] as any).id, heldAmount.toFixed(2)])
      } else {
        await client.query(
          `INSERT INTO security_deposits
             (unit_id, lease_id, tenant_id, total_amount, collected_amount,
              status, held_by, portability_status)
           VALUES ($1, $2, $3, $4, $4, 'funded', 'landlord', 'carried_forward')`,
          [doc.unit_id, lease.id, primarySigner.tenant_id, heldAmount.toFixed(2)])
      }
    }
  }

  // ── S636: RELEASE HELD UTILITIES *BEFORE* THE INVOICE IS BUILT ──────────
  //
  // Nic, on RV 28 the day the Coveys signed: "the suspended utilities are not
  // showing on their invoice. Why is there no water or electricity on there?"
  //
  // S634 already taught generateMoveInInvoice to pick up unbilled utility_bills
  // for the lease — but the release that CREATES those rows ran post-commit,
  // after this call. So the invoice queried a lease that had no utility bills
  // yet and wrote $0. Both happened in the same second, which is what made it
  // look like it had worked.
  //
  // It looked like it worked for a second reason: RV 02 (the lease that
  // prompted S634) had its utilities put on its invoice BY HAND, not by this
  // code. The fix shipped, was never exercised by a real signing, and the next
  // signing failed identically.
  //
  // Runs on the signing transaction's client so the rows are visible to the
  // invoice built immediately below. Best-effort: a share that will not release
  // stays HELD rather than vanishing, and the post-commit pass further down
  // remains as the backstop for anything left behind.
  if (doc.unit_id && primarySigner?.tenant_id) {
    try {
      await releaseSuspendedChargesForLease({
        unitId: doc.unit_id, leaseId: lease.id,
        tenantId: primarySigner.tenant_id, landlordId: doc.landlord_id,
        client,
      })
    } catch (e) {
      logger.error({ err: e, leaseId: lease.id },
        '[utility] pre-invoice release failed — shares stay held for the post-commit pass')
    }
  }

  // S196: security_deposit no longer passed as a separate input — it
  // flows in via the lease_fees move_in iteration inside
  // generateMoveInInvoice.
  // S647: pass the date POSTGRES STORED, not the raw field string.
  //
  // `startDate` is whatever was typed into the document. RV 09 held
  // "10/01/2026" — a US-format date the lease column parsed correctly to
  // 2026-10-01, while the invoice used the raw string. existingTenancyCycle
  // compares cycles as STRINGS, so "2026-09-01" > "10/01/2001" came out true
  // and a tenancy starting 1 October was invoiced for September. A month of
  // rent, billed to somebody who does not live there yet.
  //
  // The lease row is the only thing that has already been through date
  // parsing, so it is the only safe source. Reading it back also costs nothing
  // next to being wrong about which month a resident owes.
  const storedStart: string = await client.query(
    `SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM leases WHERE id = $1`,
    [lease.id]).then((r: any) => r.rows[0].d)

  // RENEWAL: the move-in bill carries no rent — only one-time money the
  // landlord put on the renewal (a deposit increase, a fee typed on the form),
  // and none at all when there is none. The renewal's rent is the nightly
  // run's, on the household's own due dates.
  await generateMoveInInvoice(
    {
      lease_id: lease.id,
      unit_id: doc.unit_id,
      tenant_id: primarySigner.tenant_id,
      landlord_id: doc.landlord_id,
      rent_amount: rentAmountNum,
      start_date: storedStart,
    },
    client,
    { renewal: !!doc.renews_lease_id },
  )

  // W-7 (S531): renewal completion — the deposit carries forward. Copy the
  // predecessor's refundable move-in deposits onto the new lease AFTER
  // move-in invoice generation, so the renewal records what the household
  // already holds without billing it again: a later renewal bills only an
  // increase over these rows, and the security-deposit row is the move-out
  // fallback when there is no custody record. These rows are a record, not
  // the money. A pet, key or cleaning deposit is returned at move-out from
  // its SETTLED payment, which stays on the lease it was paid on — so the
  // deposit return has to follow supersedes_lease_id back to find it.
  // Also close the loop on the renewal request.
  if (doc.renews_lease_id) {
    // S534: a same-type "deposit top-up" row (delta billing when the
    // landlord raised the deposit in the renewal doc) must NOT block the
    // carry-forward copy — only a previously-carried row of the same
    // fee_type does (idempotency on retries).
    // money_kind is copied too: a carried pet deposit is still a deposit.
    await client.query(`
      INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, description, money_kind)
      SELECT $1, fee_type, amount, is_refundable, due_timing,
             COALESCE(description, '') || ' [carried forward from previous lease]', money_kind
      FROM lease_fees
      WHERE lease_id=$2 AND due_timing='move_in' AND is_refundable=TRUE
        AND fee_type NOT IN (
          SELECT fee_type FROM lease_fees
           WHERE lease_id=$1
             AND COALESCE(description, '') NOT LIKE '%[deposit top-up%')`,
      [lease.id, doc.renews_lease_id])
    // S534: REBIND the custody record to the successor lease. The
    // security_deposits row carries the money, the funded/partial
    // status, and the statutory interest accrual chain — deposit-return
    // and the monthly interest cron both look it up BY lease_id, so
    // leaving it on the expiring predecessor would (a) lose the
    // accrued interest + collected amount at the renewed lease's
    // move-out and (b) orphan the accrual clock. Rebinding the SAME row
    // keeps the interest clock continuous from original receipt — the
    // real-world standard (a renewal is a continuing tenancy; the
    // deposit is never returned/re-collected, so accrual never resets).
    // FlexDeposit custody rows are excluded — their lease linkage is
    // managed by the FlexDeposit forwarding flow.
    await client.query(`
      UPDATE security_deposits
         SET lease_id = $1, updated_at = NOW()
       WHERE lease_id = $2
         AND flex_deposit_enabled = FALSE
         AND status IN ('pending', 'partial', 'funded', 'claimed')`,
      [lease.id, doc.renews_lease_id])
    await client.query(
      `UPDATE lease_renewal_requests SET status='completed', resolved_at=NOW(), updated_at=NOW()
       WHERE lease_id=$1 AND status IN ('requested','approved')`, [doc.renews_lease_id])
    // The old lease should run out its clock, not auto-extend into the
    // successor's term.
    await client.query(
      `UPDATE leases SET auto_renew=FALSE, auto_renew_mode=NULL, updated_at=NOW()
       WHERE id=$1 AND status='active'`, [doc.renews_lease_id])
  }

  // Credit ledger: emit lease_signed for every tenant signer + a
  // single event for the landlord. Same transaction — if the ledger
  // writes fail, the whole lease materialization rolls back. Imported
  // lazily to keep esign.ts top-level imports tidy.
  const { emitLeaseSignedTenant, emitLeaseSignedLandlord } =
    await import('../services/creditLedgerEmitters')
  const signedAt = new Date()
  for (const t of tenantSigners) {
    await emitLeaseSignedTenant(client, {
      tenantId:    t.tenant_id,
      leaseId:     lease.id,
      documentId:  doc.id,
      signedAt,
    })
  }
  await emitLeaseSignedLandlord(client, {
    landlordId:   doc.landlord_id,
    leaseId:      lease.id,
    documentId:   doc.id,
    signedAt,
    tenantCount:  tenantSigners.length,
  })

  return { leaseId: lease.id, status: leaseStatus, primaryTenantId: primarySigner.tenant_id }
}

/**
 * Execute an addendum_add: flip the pre-created pending_add lease_tenants row
 * to active. Parent lease untouched. Caller owns transaction.
 *
 * Preconditions (validated at creation time but re-verified here):
 *  - doc.lease_id non-null
 *  - exactly one lease_tenants row exists with add_document_id=doc.id, status=pending_add
 *  - parent lease status='active'
 *  - every signer has a tenant profile, no platform blocks
 *  - new tenant has no bucket-overlapping active/pending lease elsewhere
 */
async function executeAddendumAdd(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.lease_id) throw new AppError(400, 'Addendum has no parent lease_id')
  if (!doc.unit_id) throw new AppError(400, 'Addendum has no unit_id')

  // Parent lease must still be active
  const lease = await client.query(
    `SELECT id, status, start_date, end_date, unit_id FROM leases WHERE id=$1`,
    [doc.lease_id]).then((r: any) => r.rows[0])
  if (!lease) throw new AppError(404, 'Parent lease not found')
  if (lease.status !== 'active') {
    throw new AppError(409, `Cannot add tenant: parent lease is ${lease.status}, not active`)
  }
  if (lease.unit_id !== doc.unit_id) {
    throw new AppError(500, 'Addendum unit_id does not match parent lease unit_id')
  }

  // Find the pending_add row keyed to this document
  const pendingRows = await client.query(
    `SELECT id, tenant_id FROM lease_tenants
     WHERE add_document_id=$1 AND status='pending_add'`,
    [doc.id]).then((r: any) => r.rows)
  if (pendingRows.length === 0) {
    throw new AppError(500, 'No pending_add row found for this addendum — creation logic failed')
  }
  if (pendingRows.length > 1) {
    throw new AppError(500, 'Multiple pending_add rows for this addendum — data corruption')
  }
  const pendingRow = pendingRows[0]

  // Gather all signers (new tenant + existing active tenants + landlord)
  const allSigners = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1
     ORDER BY s.order_index`, [doc.id]).then((r: any) => r.rows)

  const tenantSigners = allSigners.filter((r: any) => isTenantRole(r.role))
  for (const t of tenantSigners) {
    if (!t.tenant_id) throw new AppError(400, `Signer ${t.email} has no tenant profile`)
  }

  // Platform-block check every tenant signer (incl. new tenant) — safety belt
  for (const t of tenantSigners) {
    const blk = await checkPlatformBlock(t.user_id)
    if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
  }

  // Sanity: the pending_add row's tenant_id must match one of the signers
  const newTenantMatch = tenantSigners.find((t: any) => t.tenant_id === pendingRow.tenant_id)
  if (!newTenantMatch) {
    throw new AppError(500, 'pending_add row tenant_id does not match any signer')
  }

  // Overlap re-check for the new tenant only (belt & suspenders vs creation-time check).
  // Excludes the current lease so it does not self-conflict via the pending_add row.
  const ov = await canTenantsSignNewLease(
    [pendingRow.tenant_id], doc.unit_id,
    lease.start_date, lease.end_date || null,
    lease.id
  )
  if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')

  // Flip pending_add → active
  await client.query(
    `UPDATE lease_tenants
     SET status='active', added_at=NOW()
     WHERE id=$1`,
    [pendingRow.id])

  // Current primary on the (now-expanded) lease
  const primary = await client.query(
    `SELECT tenant_id FROM lease_tenants
     WHERE lease_id=$1 AND role='primary' AND status='active'
     LIMIT 1`,
    [lease.id]).then((r: any) => r.rows[0])
  if (!primary) throw new AppError(500, 'Lease has no active primary after addendum_add')

  return { leaseId: lease.id, status: lease.status, primaryTenantId: primary.tenant_id }
}

/**
 * Execute an addendum_remove: flip the target lease_tenants row to removed,
 * optionally promote a new primary. Parent lease untouched. Caller owns transaction.
 *
 * Preconditions (validated at creation but re-verified here):
 *  - doc.lease_id non-null
 *  - doc.target_lease_tenant_id non-null (enforced by lease_documents CHECK constraint)
 *  - target row exists, status=pending_remove, belongs to doc.lease_id
 *  - parent lease status='active'
 *  - if target is current primary: doc.promote_lease_tenant_id non-null and valid
 *  - every signer has a tenant profile, no platform blocks
 */
async function executeAddendumRemove(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.lease_id) throw new AppError(400, 'Addendum has no parent lease_id')
  if (!doc.target_lease_tenant_id) throw new AppError(400, 'addendum_remove has no target_lease_tenant_id')

  const lease = await client.query(
    `SELECT id, status FROM leases WHERE id=$1`,
    [doc.lease_id]).then((r: any) => r.rows[0])
  if (!lease) throw new AppError(404, 'Parent lease not found')
  if (lease.status !== 'active') {
    throw new AppError(409, `Cannot remove tenant: parent lease is ${lease.status}, not active`)
  }

  const target = await client.query(
    `SELECT id, lease_id, tenant_id, role, status, remove_document_id
     FROM lease_tenants WHERE id=$1`,
    [doc.target_lease_tenant_id]).then((r: any) => r.rows[0])
  if (!target) throw new AppError(404, 'Target lease_tenants row not found')
  if (target.lease_id !== doc.lease_id) {
    throw new AppError(500, 'Target row does not belong to this lease')
  }
  if (target.status !== 'pending_remove') {
    throw new AppError(409, `Target tenant is ${target.status}, not pending_remove — addendum out of sync`)
  }
  if (target.remove_document_id !== doc.id) {
    throw new AppError(500, 'Target row remove_document_id does not match this addendum')
  }

  const allSigners = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1`, [doc.id]).then((r: any) => r.rows)
  const tenantSigners = allSigners.filter((r: any) => isTenantRole(r.role))
  for (const t of tenantSigners) {
    if (!t.tenant_id) throw new AppError(400, `Signer ${t.email} has no tenant profile`)
    const blk = await checkPlatformBlock(t.user_id)
    if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
  }

  if (target.role === 'primary') {
    if (!doc.promote_lease_tenant_id) {
      throw new AppError(400, 'Cannot remove primary tenant without promote_lease_tenant_id')
    }
    const promote = await client.query(
      `SELECT id, lease_id, role, status FROM lease_tenants WHERE id=$1`,
      [doc.promote_lease_tenant_id]).then((r: any) => r.rows[0])
    if (!promote) throw new AppError(404, 'Promote target row not found')
    if (promote.lease_id !== doc.lease_id) {
      throw new AppError(400, 'Promote target does not belong to this lease')
    }
    if (promote.status !== 'active') {
      throw new AppError(400, `Promote target status is ${promote.status}, must be active`)
    }
    if (promote.role !== 'co_tenant') {
      throw new AppError(400, `Promote target role is ${promote.role}, must be co_tenant`)
    }

    // Flip target to removed FIRST — clears the lease_tenants_primary_active
    // partial unique index, THEN promote co_tenant to primary.
    await client.query(
      `UPDATE lease_tenants
       SET status='removed', removed_at=NOW(), removed_reason='moved_out'
       WHERE id=$1`,
      [target.id])
    await client.query(
      `UPDATE lease_tenants SET role='primary' WHERE id=$1`,
      [promote.id])
  } else {
    if (doc.promote_lease_tenant_id) {
      throw new AppError(400, 'promote_lease_tenant_id set but target is not primary')
    }
    await client.query(
      `UPDATE lease_tenants
       SET status='removed', removed_at=NOW(), removed_reason='moved_out'
       WHERE id=$1`,
      [target.id])
  }

  const primary = await client.query(
    `SELECT tenant_id FROM lease_tenants
     WHERE lease_id=$1 AND role='primary' AND status='active'
     LIMIT 1`,
    [lease.id]).then((r: any) => r.rows[0])
  if (!primary) throw new AppError(500, 'Lease has no active primary after addendum_remove')

  return { leaseId: lease.id, status: lease.status, primaryTenantId: primary.tenant_id }
}

/**
 * Execute an addendum_terms document: no roster mutation, no lease mutation.
 * The signed PDF itself is the legal instrument — execution just confirms the
 * document completion and returns the parent lease's current state.
 * Caller owns transaction.
 */
async function executeAddendumTerms(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.lease_id) throw new AppError(400, 'Addendum has no parent lease_id')

  const lease = await client.query(
    `SELECT id, status FROM leases WHERE id=$1`,
    [doc.lease_id]).then((r: any) => r.rows[0])
  if (!lease) throw new AppError(404, 'Parent lease not found')

  // Terms addendum is valid on any lease status that accepts amendments.
  // Block terminal states in case lease transitioned between creation and signing.
  // S71: 'voided' branch dropped — leases_status_check only allows
  // pending/active/expired/terminated, so 'voided' was unreachable.
  //
  // S652: a state/federal DISCLOSURE amends nothing — it is a signed notice
  // that rides in the packet — so the lease's status has no bearing on it.
  // Five of Country Acres' signed disclosures sat in execution_failed because
  // their lease had expired between issuance and the last signature.
  const purpose = doc.template_id
    ? await client.query(`SELECT purpose FROM lease_templates WHERE id=$1`, [doc.template_id]).then((r: any) => r.rows[0]?.purpose ?? null)
    : null
  const isDisclosure = purpose === 'state_disclosure' || purpose === 'federal_disclosure'
  if (!isDisclosure && (lease.status === 'expired' || lease.status === 'terminated')) {
    throw new AppError(409, `Cannot amend terms: lease is ${lease.status}`)
  }

  const primary = await client.query(
    `SELECT tenant_id FROM lease_tenants
     WHERE lease_id=$1 AND role='primary' AND status='active'
     LIMIT 1`,
    [lease.id]).then((r: any) => r.rows[0])
  if (!primary) throw new AppError(500, 'Lease has no active primary for addendum_terms completion')

  // S581 (Nic): a terms addendum can carry a MONEY change (an optional recurring
  // charge like parking, or a base-rent change like an AZ mobile-home space-rent
  // increase). Those were drafted as pending scheduled_lease_changes at creation;
  // now that both parties have signed, promote them to 'scheduled' so the nightly
  // job applies them to billing on the landlord-set effective date. No-op for a
  // non-money addendum.
  const { activateScheduledChangesForDocument, createLeaseNoticesForDocument } =
    await import('../services/scheduledLeaseChanges')
  await activateScheduledChangesForDocument(client, doc.id)

  // S581: a NOTICE addendum (landlord-issued, no tenant signature) gives each
  // active tenant a blocking portal notice to view + acknowledge — proof they were
  // noticed of a change they didn't have to agree to.
  if (doc.delivery_mode === 'notice') {
    await createLeaseNoticesForDocument(client, doc.id, lease.id)
  }

  return { leaseId: lease.id, status: lease.status, primaryTenantId: primary.tenant_id }
}

// ─────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────

// S235: witness signer provisioning. Witnesses are external parties
// (property staff, notaries, neighbors) who attest to a signing without
// being tenants, landlords, or platform staff. They need a `users` row
// to satisfy the lease_document_signers.user_id FK + the esign /documents
// userId-required validation, but NOT a `tenants` row (the existing
// /tenants/invite path was wrong for them — required unitId and bound
// the user as a tenant, with all the tenant-side implications). This
// endpoint creates the minimal user account, idempotent on email, with
// role='tenant' (the generic CHECK-allowed role) but no tenants row.
// The signing role on `lease_document_signers.role='witness'` is what
// drives field assignments — users.role is irrelevant for that path.
esignRouter.post('/witnesses/provision', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { email, firstName, lastName } = req.body
    if (!email || !firstName) {
      throw new AppError(400, 'email and firstName required')
    }
    const emailNorm = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      throw new AppError(400, 'Invalid email format')
    }

    // Reuse an account already on this address (one per address in any case).
    //
    // S654: this used to hand back the id of ANY account, whatever its role
    // and whoever's it was — the first step of landlord B putting landlord A's
    // invitee on B's lease. Now:
    //   - a landlord or staff login is never a witness (409);
    //   - a resident (a login with a tenant profile) is reused only when they
    //     already belong to this company — a lease, an invite or a draft lease
    //     with it — and never by another company;
    //   - a witness-only login or a contact is reused as it is.
    // A reused account gets nothing that carries a link: no token is minted,
    // read or returned here, only the id the document needs.
    const existing = await queryOne<{ id: string; role: string; has_tenant: boolean }>(
      `SELECT u.id, u.role, EXISTS (SELECT 1 FROM tenants t WHERE t.user_id = u.id) AS has_tenant
         FROM users u WHERE lower(u.email) = $1`,
      [emailNorm])
    if (existing) {
      if (!RESIDENT_TYPE_LOGINS.has(existing.role)) throw new AppError(409, WITNESS_NOT_A_STAFF_LOGIN)
      if (existing.role === 'tenant' && existing.has_tenant) {
        const tied = await residentsTiedHere([existing.id], landlordScopeIds(req.user!))
        if (!tied.has(existing.id)) throw new AppError(409, notThisCompanysResident('This person'))
      }
      return res.json({ success: true, data: { userId: existing.id, reused: true } })
    }

    const tempHash = '$2b$10$placeholder_invite_pending'
    const created = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'tenant', $3, $4)
       RETURNING id`,
      [emailNorm, tempHash, String(firstName).trim(), String(lastName || '').trim()])
    res.status(201).json({ success: true, data: { userId: created!.id, reused: false } })
  } catch (e) { next(e) }
})

// W-33 (S529): resolve SIGNERS from the lease, not from hand-typed emails.
// ?unitId=X → that unit's active lease + all its active tenants;
// ?propertyId=Y → one group per active lease at the property (the
// property-wide addendum send fans out one document per group).
esignRouter.get('/recipients', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { unitId, propertyId } = req.query as { unitId?: string; propertyId?: string }
    if (!unitId && !propertyId) throw new AppError(400, 'unitId or propertyId required')
    // S633: a read — every company the account owns.
    const landlordIds = landlordScopeIds(req.user!)
    if (!landlordIds.length) throw new AppError(403, 'Forbidden')
    const params: any[] = [landlordIds]
    const filter = unitId
      ? `AND l.unit_id = $${params.push(unitId)}`
      : `AND u.property_id = $${params.push(propertyId)}`
    const rows = await query<any>(`
      SELECT l.id AS lease_id, l.unit_id, u.unit_number, p.id AS property_id, p.name AS property_name,
             vlat.role, t.id AS tenant_id, t.user_id, us.first_name, us.last_name, us.email
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
        JOIN tenants t ON t.id = vlat.tenant_id
        JOIN users us ON us.id = t.user_id
       WHERE l.landlord_id = $1 AND l.status = 'active' ${filter}
       ORDER BY u.unit_number, vlat.role`, params)
    // group by lease
    const groups = new Map<string, any>()
    for (const r of rows) {
      if (!groups.has(r.lease_id)) {
        groups.set(r.lease_id, { leaseId: r.lease_id, unitId: r.unit_id, unitNumber: r.unit_number,
          propertyId: r.property_id, propertyName: r.property_name, tenants: [] })
      }
      groups.get(r.lease_id).tenants.push({
        tenantId: r.tenant_id, userId: r.user_id, firstName: r.first_name,
        lastName: r.last_name, email: r.email, role: r.role,
      })
    }
    res.json({ success: true, data: Array.from(groups.values()) })
  } catch (e) { next(e) }
})

esignRouter.get('/templates', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    // S535: ?unitType=<type> narrows to templates COMPATIBLE with that
    // unit type (its own type + universal NULL templates).
    const unitTypeFilter = typeof req.query.unitType === 'string' && (UNIT_TYPES as readonly string[]).includes(req.query.unitType)
      ? req.query.unitType : null
    // S535: ?propertyId narrows to templates usable AT that property
    // (locked to it + unlocked NULL templates).
    const propertyFilter = typeof req.query.propertyId === 'string' && req.query.propertyId ? req.query.propertyId : null
    // S576 (B-8): ?purpose=lease|work_trade_addendum narrows by template kind so
    // the renewal picker shows only lease forms, and the addendum resolver finds
    // only work-trade forms. Omitted = all (the Templates management tab).
    const purposeFilter = typeof req.query.purpose === 'string' && (LEASE_TEMPLATE_PURPOSES as readonly string[]).includes(req.query.purpose)
      ? req.query.purpose : null
    const templates = await query<any>(`
      SELECT t.*, COUNT(f.id)::int as field_count, p.name AS property_name
      FROM lease_templates t
      LEFT JOIN lease_template_fields f ON f.template_id = t.id
      LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.landlord_id = ANY($1::uuid[]) AND t.is_active = TRUE
        AND ($2::text IS NULL OR t.unit_type IS NULL OR t.unit_type = $2)
        AND ($3::uuid IS NULL OR t.property_id IS NULL OR t.property_id = $3)
        AND ($4::text IS NULL OR t.purpose = $4)
      -- S652: alphabetical. It was newest-first, which Nic read as "mostly
      -- alphabetical except the one I added last" — an order nobody chose.
      GROUP BY t.id, p.name ORDER BY lower(t.name)`, [landlordScopeIds(req.user!), unitTypeFilter, propertyFilter, purposeFilter])
    // S622: the prose-stated conditional fees the landlord confirmed, so the
    // editor can show what is already tracked and not re-ask on every open.
    if (templates.length > 0) {
      const cfRows = await query<any>(
        `SELECT template_id, id, label, amount::text AS amount, condition_text
           FROM lease_template_conditional_fees WHERE template_id = ANY($1::uuid[])`,
        [templates.map((t: any) => t.id)])
      const byTemplate: Record<string, any[]> = {}
      for (const r of cfRows) {
        (byTemplate[r.template_id] ||= []).push({
          id: r.id, label: r.label, amount: Number(r.amount), conditionText: r.condition_text,
        })
      }
      for (const t of templates as any[]) t.conditional_fees = byTemplate[t.id] || []
    }
    res.json({ success: true, data: templates })
  } catch (e) { next(e) }
})

/**
 * GET /api/esign/disclosures — every slot, and whether this landlord filled it.
 *
 * S652 (Nic): "Say there's 15 different disclosures, maybe only two of them are
 * required in their area. We're not enforcing it, but they could upload the
 * other 13 to kind of fill out the robustness of their operation."
 *
 * So this returns the whole list with what they hold against each, and says
 * NOTHING about which ones they need. No state, no requirement, no warning
 * color — a landlord looking at an empty slot is looking at a document they
 * have not uploaded, not a compliance failure. What they do about it is theirs.
 */
esignRouter.get('/disclosures', requireAuth, requirePerm('leases.create'), async (req: any, res, next) => {
  try {
    const held = await query<{ disclosure_type: string; applies_to: string; id: string; name: string; state_code: string | null }>(
      `SELECT disclosure_type, applies_to, id, name, state_code
         FROM lease_templates
        WHERE landlord_id = ANY($1::uuid[]) AND is_active = TRUE AND disclosure_type IS NOT NULL
        ORDER BY name`,
      [landlordScopeIds(req.user!)])
    res.json({ success: true, data: DISCLOSURE_TYPES.map(type => {
      const docs = held.filter(h => h.disclosure_type === type)
      return {
        type,
        label: DISCLOSURE_TYPE_LABEL[type],
        documents: docs.map(d => ({
          id: d.id, name: d.name, appliesTo: d.applies_to,
          // null = the form travels: federal, or the landlord's own wording.
          stateCode: d.state_code,
        })),
        // Which states this landlord holds a specific form for, so somebody
        // operating in three states can see where the gaps in their own filing
        // are. Still says nothing about where one is needed.
        states: [...new Set(docs.map(d => d.state_code).filter(Boolean))],
        // A disclosure that reads differently for a sale than for a rental
        // needs both to be complete. Stated as a fact about what they hold,
        // never as something they are missing.
        hasSale:   docs.some(d => d.applies_to === 'sale'   || d.applies_to === 'any'),
        hasRental: docs.some(d => d.applies_to === 'rental' || d.applies_to === 'any'),
      }
    }) })
  } catch (e) { next(e) }
})

/**
 * S652 — A GOVERNMENT FORM'S WORDS STAY THE GOVERNMENT'S. ITS BOXES ARE THE LANDLORD'S.
 *
 * Nic: "the library should only be government published documents that
 * something we're not altering at all." A template carrying library_document_id
 * is GAM's copy of somebody else's document on this landlord's shelf, and what
 * is fixed is the DOCUMENT — the PDF, and the name and description that say
 * which document it is.
 *
 * The boxes are NOT fixed, and the first version of this got that wrong by
 * locking them too. Nic: "When I say they can't edit it on the documents, I mean
 * they can't edit the text of the document because it's a government published
 * form. They can add the necessary initial boxes or potentially an
 * acknowledgment checkbox... just including it with the signature in the packet
 * with no actual initial on the page itself is going to be argued that it was
 * never received from somebody down the line." Placing an initial on the page is
 * how a landlord proves delivery, so taking that away defeated the point. GAM
 * ships default boxes; the landlord adds, moves or removes them freely.
 *
 * The message says where to go for the one thing that IS refused, because a
 * landlord wanting different wording is not doing anything wrong — they just
 * need their own form, uploaded like their own lease.
 */
const LIBRARY_FIXED_FIELDS = ['name', 'description', 'basePdfUrl', 'pageCount'] as const
function assertLibraryDocumentUnchanged(t: { library_document_id?: string | null; name?: string }, body: any) {
  if (!t?.library_document_id) return
  const touched = LIBRARY_FIXED_FIELDS.filter(k => body?.[k] !== undefined)
  if (!touched.length) return
  throw new AppError(409,
    `"${t.name || 'This form'}" is published by a government agency and GAM keeps its text exactly as issued. ` +
    `You can add, move or remove signature and initial boxes on it. To use different wording, upload your own version as a template.`)
}

// GET /api/esign/sleeves — the Templates page: every state the landlord holds
// property in, its sleeves for the unit types they run there (filled or empty),
// the government's forms as sleeves that come filled, and anything that fits no
// sleeve under `other`. See services/documentSleeves.
esignRouter.get('/sleeves', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { sleevesForLandlord } = await import('../services/documentSleeves')
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    res.json({ success: true, data: await sleevesForLandlord(exec, landlordScopeIds(req.user!)) })
  } catch (e) { next(e) }
})

// PUT /api/esign/sleeves/:id/cover { templateIds } — which of the landlord's own
// documents already contain this one ("it's in my lease"). Replaces the set;
// [] uncovers. See services/documentSleeves.setSleeveCoverings.
esignRouter.put('/sleeves/:id/cover', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { setSleeveCoverings } = await import('../services/documentSleeves')
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    const ids = Array.isArray(req.body?.templateIds) ? req.body.templateIds.map(String) : null
    if (!ids) throw new AppError(400, 'templateIds must be a list (empty to clear)')
    await setSleeveCoverings(exec, landlordScopeIds(req.user!), req.params.id, ids)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/esign/library — the WHOLE government library, for the Templates page.
// Says what exists, where it is from and who published it. Says nothing about
// what is required. operatingStates lets the page open the states they are in.
esignRouter.get('/library', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { libraryCatalog } = await import('../services/disclosureLibrary')
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    const { docs, operatingStates } = await libraryCatalog(exec, landlordScopeIds(req.user!))
    // The standard envelope. The portal's apiGet unwraps `.data`, so a bare
    // object read as undefined and rendered an empty library.
    res.json({ success: true, data: {
      operatingStates,
      documents: docs.map((d: any) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        disclosureType: d.disclosure_type,
        disclosureLabel: DISCLOSURE_TYPE_LABEL[d.disclosure_type as keyof typeof DISCLOSURE_TYPE_LABEL] ?? d.disclosure_type,
        jurisdiction: d.jurisdiction,
        appliesTo: d.applies_to,
        unitTypes: d.unit_types,
        publishedBy: d.source_name,
        sourceUrl: d.source_url,
        publicationRef: d.publication_ref,
        pdfUrl: d.base_pdf_url,
        pageCount: d.page_count,
        effectiveFrom: d.effective_from,
        version: d.version,
        adoptedTemplateId: d.adopted_template_id,
        fieldCount: d.adopted_template_id ? d.adopted_field_count : null,
        signable: d.signable !== false,
      })),
    } })
  } catch (e) { next(e) }
})

// POST /api/esign/library/adopt — put a published form on the shelf.
//
// Takes `documentId` from the screen, or `formName` the way somebody says it
// out loud. The second one is why this is one route and not two: an action whose
// only handle is a uuid "from a lookup" is an action nobody can actually reach
// by talking, which is how the existing template actions ended up unreachable.
// Resolution refuses to guess — no match and two matches both name what IS on
// the shelf rather than picking one.
esignRouter.post('/library/adopt', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const scope = landlordScopeIds(req.user!)
    if (!scope.length) throw new AppError(403, 'Forbidden')
    const { adoptLibraryDocument, libraryForLandlord } = await import('../services/disclosureLibrary')
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }

    let documentId: string | undefined = req.body?.documentId
    if (!documentId) {
      const spoken = String(req.body?.formName ?? '').trim()
      if (!spoken) throw new AppError(400, 'Name the form, or pass documentId')
      const shelf = await libraryForLandlord(exec, scope)
      const needle = spoken.toLowerCase()
      const hits = shelf.filter((d: any) => String(d.name).toLowerCase().includes(needle))
      if (hits.length === 0) {
        throw new AppError(404,
          `No form called "${spoken}". On the shelf: ${shelf.map((d: any) => d.name).join('; ') || 'nothing yet'}.`)
      }
      if (hits.length > 1) {
        throw new AppError(409,
          `"${spoken}" matches more than one: ${hits.map((d: any) => d.name).join('; ')}. Which one?`)
      }
      documentId = hits[0].id
    }

    // S652: WHICH company takes the copy. A state form goes to the company that
    // runs property in that state; a federal one to the company running the
    // state the screen is working in (the package or slot's state). Before
    // this it was always the first company listed — Blu's Illinois package
    // could be handed an Oak Park copy and then refused it as "not yours".
    const docRow = await queryOne<{ jurisdiction: string }>(
      `SELECT jurisdiction FROM disclosure_library_documents WHERE id=$1`, [documentId])
    const wantState = docRow && docRow.jurisdiction !== 'US'
      ? docRow.jurisdiction
      : (typeof req.body?.stateCode === 'string' ? req.body.stateCode.toUpperCase() : null)
    // Already on the account's shelf under any company? That copy IS the
    // account's copy — never make a second.
    const heldAnywhere = await queryOne<{ id: string }>(
      `SELECT id FROM lease_templates WHERE library_document_id=$1 AND landlord_id = ANY($2::uuid[]) AND is_active
        ORDER BY created_at LIMIT 1`, [documentId, scope])
    if (heldAnywhere && !req.body?.landlordId) {
      return res.json({ success: true, data: { templateId: heldAnywhere.id, alreadyHeld: true } })
    }
    const landlordId = await fileUnderCompany(req.user!, { explicit: req.body?.landlordId, state: wantState }, query)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const out = await adoptLibraryDocument(client as any, landlordId, documentId!)
      await client.query('COMMIT')
      res.json({ success: true, data: out })
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

esignRouter.post('/templates', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    let { name, description, basePdfUrl, pageCount, unitType, propertyId, depositMonths, defaultTermMonths, purpose,
            disclosureType, appliesTo, stateCode } = req.body
    if (!name) throw new AppError(400, 'Template name required')
    // S652: uploaded INTO a sleeve. The sleeve already says what this document
    // is — "Arizona: RV Spot Lease" is an RV-spot lease for Arizona — so those
    // facts come from it and the landlord is not asked to repeat them.
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    const { sleeveDefaults, placeTemplate } = await import('../services/documentSleeves')
    const sleeve = req.body?.sleeveId ? await sleeveDefaults(exec, String(req.body.sleeveId)) : null
    if (sleeve) {
      purpose = sleeve.purpose
      unitType = sleeve.unitType ?? unitType ?? null
      stateCode = sleeve.stateCode
      disclosureType = sleeve.disclosureType
      appliesTo = sleeve.appliesTo
    }
    // S576 (B-8): 'lease' (default) or 'work_trade_addendum' — the landlord's
    // own work-trade addendum form, auto-attached to a renewal on lease expiry.
    const tmplPurpose = purpose || 'lease'
    if (!(LEASE_TEMPLATE_PURPOSES as readonly string[]).includes(tmplPurpose)) {
      throw new AppError(400, `purpose must be one of ${LEASE_TEMPLATE_PURPOSES.join(', ')}`)
    }
    // S652 (Nic): "These are categories to be filled... some of these are
    // required in some areas. We don't police what's required where." A slot a
    // landlord chose to fill, and nothing more — no state mapping, no required
    // flag. `appliesTo` is the one that does real work: the SALE version of a
    // disclosure belongs in front of a buyer and the RENTAL version in front of
    // a renter, which is what lets a packet assemble itself.
    const disclosure = disclosureType == null || disclosureType === ''
      ? null : String(disclosureType)
    if (disclosure != null && !(DISCLOSURE_TYPES as readonly string[]).includes(disclosure)) {
      throw new AppError(400, `disclosureType must be one of ${DISCLOSURE_TYPES.join(', ')}, or null`)
    }
    const applies = appliesTo == null || appliesTo === '' ? 'any' : String(appliesTo)
    if (!(TEMPLATE_APPLIES_TO as readonly string[]).includes(applies)) {
      throw new AppError(400, `appliesTo must be one of ${TEMPLATE_APPLIES_TO.join(', ')}`)
    }
    // S652: the state a form was WRITTEN for. Null means it travels — a federal
    // form like lead-based paint, or a notice the landlord wrote themselves.
    const stCode = stateCode == null || stateCode === '' ? null : String(stateCode).toUpperCase()
    if (stCode != null && !/^[A-Z]{2}$/.test(stCode)) {
      throw new AppError(400, 'stateCode must be a two-letter state code, or null for any state')
    }

    // S558: the deposit multiplier ("N months' rent") is a lease term on the
    // template. Optional (NULL = landlord fills the deposit manually); 0..12.
    const depMonths = depositMonths === undefined || depositMonths === null || depositMonths === ''
      ? null : Number(depositMonths)
    if (depMonths != null && (!Number.isFinite(depMonths) || depMonths < 0 || depMonths > 12)) {
      throw new AppError(400, 'depositMonths must be a number between 0 and 12, or null')
    }
    // S558: default lease term carried on the template. NULL = month-to-month;
    // 1..120 = fixed N-month term. (Designate a template as its unit type's
    // default separately via POST /templates/:id/set-default.)
    const termMonths = defaultTermMonths === undefined || defaultTermMonths === null || defaultTermMonths === ''
      ? null : Number(defaultTermMonths)
    if (termMonths != null && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120)) {
      throw new AppError(400, 'defaultTermMonths must be an integer 1..120, or null for month-to-month')
    }
    // S535: templates are per unit TYPE (null = universal) — an RV spot
    // lease isn't an apartment lease. Drafting validates the pairing.
    if (unitType != null && !(UNIT_TYPES as readonly string[]).includes(unitType)) {
      throw new AppError(400, `unitType must be one of ${UNIT_TYPES.join(', ')} or null`)
    }
    // S535: optional PROPERTY lock (null = any property) — the form
    // carries a property's name/address, so it belongs to that property.
    // S633: a template belongs to a company. When it is locked to a property,
    // that property's company IS the answer; otherwise the account names one
    // (silently, if it owns only one). A template filed under the wrong company
    // is invisible to the properties that need it.
    // S652: uploaded into a state's slot → that state's company.
    const templateLandlordId = await fileUnderCompany(req.user!, {
      explicit: req.body?.landlordId, propertyId: propertyId ? String(propertyId) : null,
      state: sleeve?.stateCode ?? stCode }, query)
    const t = await queryOne<any>(`
      INSERT INTO lease_templates (landlord_id, name, description, base_pdf_url, page_count, unit_type, property_id, deposit_months, default_term_months, purpose,
                                   disclosure_type, applies_to, state_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [templateLandlordId, name, description||null, basePdfUrl||null, pageCount||1, unitType||null, propertyId||null, depMonths, termMonths, tmplPurpose,
       disclosure, applies, stCode])
    // S652: into the sleeve it was uploaded to, or the one it plainly belongs in.
    if (sleeve) await query(`UPDATE lease_templates SET sleeve_id=$2 WHERE id=$1`, [t.id, sleeve.sleeveId])
    else await placeTemplate(exec, t.id)
    // S652: read it for the documents it already contains (services/sleeveDetection).
    if (t.base_pdf_url) {
      const { detectCoverings } = await import('../services/sleeveDetection')
      await detectCoverings(exec, t.id)
    }

    // S629 (Nic): "when you add a template for a unit type and there is no
    // default, it should automatically become the default."
    //
    // He invited a household, they accepted, and the lease did not draft —
    // because a template existed for the unit type but nothing was marked
    // default. A lone template that is not the default is never what anyone
    // means: there is nothing for it to be second to. The FIRST one for a
    // (unit type, property) becomes the default on its own; a later one does
    // not steal the slot, which is the "ask if you want to supersede it" half
    // and belongs to the person, not to us.
    let autoDefaulted = false
    if (unitType) {
      const existingDefault = await queryOne<{ id: string }>(
        `SELECT id FROM lease_templates
          WHERE landlord_id=$1 AND unit_type=$2 AND property_id IS NOT DISTINCT FROM $3
            AND is_unit_type_default = TRUE AND is_active <> FALSE AND id <> $4
          LIMIT 1`,
        [templateLandlordId, unitType, propertyId || null, t.id])
      if (!existingDefault) {
        await query(`UPDATE lease_templates SET is_unit_type_default=TRUE, updated_at=NOW() WHERE id=$1`, [t.id])
        t.is_unit_type_default = true
        autoDefaulted = true
        // And draft anything that was waiting on exactly this.
        await draftPendingForUnitType({
          landlordId: templateLandlordId, unitType, propertyId: propertyId || null,
        }).catch(() => null)
      }
    }
    res.status(201).json({ success: true, data: { ...t, autoDefaulted } })
  } catch (e) { next(e) }
})

esignRouter.get('/templates/:id', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.id, landlordScopeIds(req.user!)])
    if (!template) throw new AppError(404, 'Template not found')
    const fields = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order, y', [template.id])
    res.json({ success: true, data: { ...template, fields } })
  } catch (e) { next(e) }
})

esignRouter.patch('/templates/:id', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount, isActive, unitType, depositMonths, defaultTermMonths } = req.body
    const t = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.id, landlordScopeIds(req.user!)])
    if (!t) throw new AppError(404, 'Template not found')
    assertLibraryDocumentUnchanged(t, req.body)
    // S652 — REPLACE THE PDF, KEEP THE BOXES. Boxes are stored by page and
    // position, apart from the PDF, so a corrected or next-year version slots in
    // underneath them. The one way that goes wrong is a box on a page the new
    // file no longer has; refuse that rather than strand it.
    if (basePdfUrl && basePdfUrl !== t.base_pdf_url && pageCount) {
      const beyond = await queryOne<{ page: number }>(
        `SELECT max(page)::int AS page FROM lease_template_fields WHERE template_id=$1`, [t.id])
      if (beyond?.page && beyond.page > Number(pageCount)) {
        throw new AppError(409, `The new PDF has ${pageCount} page${Number(pageCount) === 1 ? '' : 's'} but boxes sit on page ${beyond.page}. Use a version with the same pages, or move those boxes first.`)
      }
    }
    if (unitType !== undefined && unitType !== null && !(UNIT_TYPES as readonly string[]).includes(unitType)) {
      throw new AppError(400, `unitType must be one of ${UNIT_TYPES.join(', ')} or null`)
    }
    // S558: deposit_months editable here. undefined = leave as-is; null/'' clears
    // it (landlord fills deposit manually); a number 0..12 sets the multiplier.
    let depMonths = t.deposit_months
    if (depositMonths !== undefined) {
      depMonths = depositMonths === null || depositMonths === '' ? null : Number(depositMonths)
      if (depMonths != null && (!Number.isFinite(depMonths) || depMonths < 0 || depMonths > 12)) {
        throw new AppError(400, 'depositMonths must be a number between 0 and 12, or null')
      }
    }
    // S558: default_term_months editable here. undefined = leave as-is; null/''
    // = month-to-month; 1..120 = fixed term.
    let termMonths = t.default_term_months
    if (defaultTermMonths !== undefined) {
      termMonths = defaultTermMonths === null || defaultTermMonths === '' ? null : Number(defaultTermMonths)
      if (termMonths != null && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120)) {
        throw new AppError(400, 'defaultTermMonths must be an integer 1..120, or null for month-to-month')
      }
    }
    const updated = await queryOne<any>(`
      UPDATE lease_templates SET name=$1, description=$2, base_pdf_url=$3, page_count=$4, is_active=$5,
             unit_type=$6, deposit_months=$7, default_term_months=$8, updated_at=NOW()
      WHERE id=$9 RETURNING *`,
      [name??t.name, description??t.description, basePdfUrl??t.base_pdf_url, pageCount??t.page_count, isActive??t.is_active,
       unitType===undefined ? t.unit_type : unitType, depMonths, termMonths, t.id])
    // S652: a new PDF is a new document — re-read it, so a section dropped from
    // next year's lease un-ticks the sleeve it used to fill (Nic: "it needs to
    // reread that and deselect the options that are no longer applicable").
    // Retiring the template drops its automatic coverings the same way.
    if ((basePdfUrl && basePdfUrl !== t.base_pdf_url) || isActive === false) {
      const { detectCoverings } = await import('../services/sleeveDetection')
      const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
      await detectCoverings(exec, t.id)
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// S558: designate this template as the DEFAULT for its unit type (the "primary
// <unit type> lease"). Radio behavior: clears any other default for the same
// (landlord, unit_type, property_id) first, then sets this one — atomic. Pass
// { isDefault: false } to un-designate. A default requires a specific unit_type
// (a universal/null-unit_type template can't be a unit-type default).
esignRouter.post('/templates/:id/set-default', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  const client = await getClient()
  try {
    const makeDefault = req.body?.isDefault !== false // default true
    const t = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.id, landlordScopeIds(req.user!)])
    if (!t) throw new AppError(404, 'Template not found')
    if (makeDefault && !t.unit_type) {
      throw new AppError(400, 'Set the template’s unit type before making it a default — a default is per unit type.')
    }
    await client.query('BEGIN')
    if (makeDefault) {
      // Clear the current default for this (landlord, unit_type, property_id).
      // property_id compared with IS NOT DISTINCT FROM so NULL matches NULL.
      await client.query(
        `UPDATE lease_templates SET is_unit_type_default=false, updated_at=NOW()
          WHERE landlord_id=$1 AND unit_type=$2 AND property_id IS NOT DISTINCT FROM $3
            AND is_unit_type_default=true AND id<>$4`,
        [t.landlord_id, t.unit_type, t.property_id, t.id])
    }
    const updated = await client.query(
      `UPDATE lease_templates SET is_unit_type_default=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [makeDefault, t.id])
    await client.query('COMMIT')

    // S605 (Nic): "if somebody does forget to add the template first... when
    // they add it, it refires." Every unit of this type with tenants invited but
    // no lease drafted gets drafted now. Outside the transaction and fully
    // best-effort — setting a default template must succeed even if drafting
    // hits a snag, and the retry is repeatable.
    let retried: { drafted: number; skipped: number } | null = null
    if (makeDefault && t.unit_type) {
      retried = await draftPendingForUnitType({
        landlordId: t.landlord_id,
        unitType: t.unit_type,
        propertyId: t.property_id ?? null,
      }).catch(() => null)
    }
    res.json({ success: true, data: updated.rows[0], pendingDrafts: retried })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.delete('/templates/:id', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    // S652 — Nic: "They should be in the templates and not deletable from the
    // templates." A government form is part of every landlord's library, the
    // way a dictionary is part of a desk; removing it from one account would
    // only mean it has to be found again. Their OWN templates delete as before.
    const lib = await queryOne<any>(
      'SELECT name FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[]) AND library_document_id IS NOT NULL',
      [req.params.id, landlordScopeIds(req.user!)])
    if (lib) throw new AppError(409, `"${lib.name}" is a government form in your library and stays there. Leave it out of a package if you don't use it.`)
    await query('UPDATE lease_templates SET is_active=FALSE WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.id, landlordScopeIds(req.user!)])
    res.json({ success: true })
  } catch (e) { next(e) }
})

esignRouter.put('/templates/:id/fields', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { fields } = req.body
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.id, landlordScopeIds(req.user!)])
    if (!template) throw new AppError(404, 'Template not found')

    for (const f of (fields || [])) {
      if (f.leaseColumn && !(f.leaseColumn in LEASE_COLUMN_CATEGORY)) {
        throw new AppError(400, `Invalid lease_column: ${f.leaseColumn}`)
      }
      // S568: accept lease roles (landlord/witness/tenant) AND generic roles
      // (seller/purchaser/party_N/custom) so one template engine serves both
      // leases and standalone contracts. isValidSignerRole allows sane labels.
      if (f.signerRole && !(f.signerRole === 'landlord' || isTenantRole(f.signerRole) || isValidSignerRole(f.signerRole))) {
        throw new AppError(400, `Invalid signer_role: ${f.signerRole}`)
      }
    }

    // S641: a version is what makes "has this changed since they agreed to it"
    // answerable, which is how park rules decide whether to come back around at
    // renewal — and the same question covers a mid-tenancy change, so there is
    // no second mechanism for publishing new rules.
    await query('UPDATE lease_templates SET version = version + 1 WHERE id = $1', [template.id])
    await query('DELETE FROM lease_template_fields WHERE template_id=$1', [template.id])
    // Two-pass so conditional (nested) fields can link to their parent: a full
    // replace regenerates DB ids, so children reference the parent by its
    // stable CLIENT key (clientId), which we map to the new DB id after insert.
    const clientToDbId = new Map<string, string>()
    const inserted: Array<{ f: any; dbId: string }> = []
    for (const f of (fields || [])) {
      const row = await queryOne<{ id: string }>(`INSERT INTO lease_template_fields
        (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order, font_css, options,
         default_value, checkbox_mark, money_kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        // S636 (Nic): an IDENTITY column belongs to nobody, enforced on the way
        // in. The editor clears the role when the label is picked, but a template
        // saved before that shipped — or by any other client — would otherwise
        // keep signer_role='landlord' on a box the landlord can never usefully
        // fill. `required` goes too: the value arrives from the invite, so asking
        // a signer to complete it is wrong.
        // S652 (Nic): FIXED TEXT belongs to the landlord — printed on every
        // document from the template, changeable by the landlord on one lease
        // with a deliberate click, never a box anyone must fill.
        [template.id, f.fieldType,
         f.fieldType === 'fixed_text' ? 'landlord' : isAutoFilledLeaseColumn(f.leaseColumn) ? null : f.signerRole,
         f.label||null, f.leaseColumn||null,
         f.page||1, f.x, f.y, f.width||200, f.height||50,
         (f.fieldType === 'fixed_text' || isAutoFilledLeaseColumn(f.leaseColumn)) ? false : (f.required??true),
         f.sortOrder||0, f.fontCss||null,
         f.options||null,
         // S641: the template's own starting answer. A box the landlord ticks
         // on every lease at a property should arrive ticked. A signature or
         // initial can never carry one — those are the signer's act, and a
         // pre-filled signature is not a signature.
         (f.fieldType === 'signature' || f.fieldType === 'initials' || f.fieldType === 'date')
           ? null
           : (f.defaultValue ?? null),
         // S652: a CHOICE group's boxes are marked X, a check, or the signer's
         // initials (Blu's lead-paint form initials the option that applies).
         (f.checkboxMark === 'check' || f.checkboxMark === 'initials') ? f.checkboxMark : 'x',
         // S653: the landlord's tag on a money box; only meaningful on a fee tag.
         (isMoneyBoxColumn(f.leaseColumn) && (MONEY_KINDS as readonly string[]).includes(f.moneyKind)) ? f.moneyKind : null])
      if (f.clientId != null) clientToDbId.set(String(f.clientId), row!.id)
      inserted.push({ f, dbId: row!.id })
    }
    // Second pass: resolve parent links now that every field has a DB id.
    for (const { f, dbId } of inserted) {
      const parentKey = f.parentClientId != null ? String(f.parentClientId) : null
      if (parentKey && clientToDbId.has(parentKey)) {
        await query('UPDATE lease_template_fields SET parent_field_id=$1, parent_option=$2 WHERE id=$3',
          [clientToDbId.get(parentKey), f.parentOption || null, dbId])
      }
    }
    // S622: conditional fees the landlord kept from the prose scan. Full
    // replace, same as the fields above — the editor sends the surviving set, so
    // removing one in the UI removes it here. Omitting the key entirely leaves
    // the stored set alone (a caller that predates this field must not wipe it).
    // S622: the late-fee terms the template states in prose, saved with the
    // fields so drafting can rely on them.
    if (req.body.lateFeeTerms !== undefined) {
      await query('UPDATE lease_templates SET late_fee_terms=$2 WHERE id=$1',
        [template.id, req.body.lateFeeTerms ? JSON.stringify(req.body.lateFeeTerms) : null])
    }
    if (Array.isArray(req.body.conditionalFees)) {
      await query('DELETE FROM lease_template_conditional_fees WHERE template_id=$1', [template.id])
      for (const cf of req.body.conditionalFees) {
        const amount = Number(cf?.amount)
        const conditionText = String(cf?.conditionText ?? '').trim()
        if (!Number.isFinite(amount) || amount <= 0 || !conditionText) continue
        await query(
          `INSERT INTO lease_template_conditional_fees (template_id, label, amount, condition_text)
           VALUES ($1, $2, $3, $4)`,
          [template.id, String(cf?.label ?? 'Lease condition fee').slice(0, 120),
           amount, conditionText.slice(0, 1000)])
      }
    }

    const updated = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order', [template.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// S556: auto-place e-sign field boxes on the template's raw lease PDF. Reads
// the PDF, runs the deterministic detection + in-house model-tagging pass, and
// RETURNS proposed fields (does NOT save). The landlord loads them into the
// editor, adjusts, then the existing PUT /fields persists. Spec:
// ~/gam/AUTO_FIELD_PLACEMENT_SPEC.md.
// S582: ASYNC. Validate + enqueue a job, fire the model run WITHOUT awaiting, and
// return the jobId immediately. The editor polls the GET below until it leaves
// 'processing'. Decoupling the model work from the HTTP request means no request
// is ever held open long enough for Cloudflare's ~100s edge timeout to bite, and
// the model can take its natural time (better labels, never truncated).
esignRouter.post('/templates/:id/auto-fields', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.id, landlordScopeIds(req.user!)])
    if (!template) throw new AppError(404, 'Template not found')
    if (!template.base_pdf_url) throw new AppError(400, 'Template has no base PDF — upload one first')
    const filename = extractUploadFilename(template.base_pdf_url)
    if (!filename) throw new AppError(400, 'Template PDF path is not a local upload')
    if (!fs.existsSync(path.join(uploadDir, filename))) throw new AppError(404, 'Template PDF file not found on disk')

    const { createAutoFieldJob, runAutoFieldJob } = await import('../services/autoFieldJobs')
    const jobId = await createAutoFieldJob(template.id, template.landlord_id)
    // Detached — runAutoFieldJob catches its own errors onto the job row.
    void runAutoFieldJob(jobId)
    res.status(202).json({ success: true, data: { jobId, status: 'processing' } })
  } catch (e) { next(e) }
})

// S582: poll the placement job. Returns { status, result?, error? }; the editor
// loads result.fields once status === 'done'.
esignRouter.get('/templates/:id/auto-fields/:jobId', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { getAutoFieldJob } = await import('../services/autoFieldJobs')
    const job = await getAutoFieldJob(req.params.jobId, landlordScopeIds(req.user!))
    if (!job || job.template_id !== req.params.id) throw new AppError(404, 'Job not found')
    // S622: pagesTotal/pagesDone let the editor show real progress instead of an
    // unlabeled spinner. pagesTotal is null until the PDF has been parsed.
    res.json({ success: true, data: {
      status: job.status, result: job.result, error: job.error,
      pagesTotal: job.pages_total ?? null, pagesDone: job.pages_done ?? 0,
    } })
  } catch (e) { next(e) }
})

// S556: suggested lease field values derived from a unit, so the send form can
// pre-fill rent / derived deposit / unit# / property before the landlord even
// types. Same computation the server seeds with at document creation.
esignRouter.get('/units/:unitId/prefill-suggestions', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const unit = await queryOne<{ id: string }>(
      'SELECT id FROM units WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [req.params.unitId, landlordScopeIds(req.user!)])
    if (!unit) throw new AppError(404, 'Unit not found')
    // S558: deposit derives from the selected template's deposit_months, so the
    // send form passes ?templateId when a template is chosen (deposit box fills
    // once both unit + template are picked; without a template it stays blank).
    const templateId = typeof req.query.templateId === 'string' ? req.query.templateId : null
    const suggestions = await suggestUnitPrefill(req.params.unitId, null, templateId)
    res.json({ success: true, data: suggestions })
  } catch (e) { next(e) }
})

esignRouter.delete('/templates/:id/fields/:fieldId', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    // S393 fix: verify template ownership before deleting a field.
    // Pre-fix, a caller knowing both a stranger template UUID and a
    // field UUID matching that template could DELETE the stranger's
    // field — the SQL only required (fieldId, templateId) match.
    // Same class as the S390 variants cross-tenant fix on
    // pos_item_variants.
    const template = await queryOne<{ id: string }>(
      'SELECT id FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])',
      [req.params.id, landlordScopeIds(req.user!)])
    if (!template) throw new AppError(404, 'Template not found')
    await query('DELETE FROM lease_template_fields WHERE id=$1 AND template_id=$2', [req.params.fieldId, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────

esignRouter.get('/documents', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const docs = await query<any>(`
      SELECT d.*, u.unit_number, p.name as property_name,
        COUNT(DISTINCT s.id)::int as signer_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status='signed')::int as signed_count,
        -- S632 (Nic): "Where as the landlord can I sign the lease inside the
        -- app? I see one in progress and two pending, and I need to sign my half
        -- of those two." He could not, from anywhere. The signing route existed
        -- and took a document id; nothing in the product linked to it, so the
        -- only way in was an emailed link. This says whether THIS caller still
        -- owes a signature, so the row can offer one.
        EXISTS (
          SELECT 1 FROM lease_document_signers ms
           WHERE ms.document_id = d.id
             AND ms.role = 'landlord'
             AND ms.status IS DISTINCT FROM 'signed'
        ) AS landlord_must_sign,
        -- ── S638 (Nic): WHO IS IN IT, AND WHO ARE WE WAITING ON ──────────────
        --
        --   "From this screen I can't see who's in what unit and who we're
        --    waiting on for signature... these people don't show up in the
        --    master schedule until after they're completed. Even if I remember
        --    the people in the spot, I might not remember the signing order."
        --
        -- A row said "2/3 signed" and stopped there, so chasing a lease meant
        -- opening it to find out whose turn it was. The whole roster comes back
        -- in signing order, plus the one person it currently sits with.
        (SELECT json_agg(json_build_object(
                  'name', x.name, 'role', x.role, 'status', x.status,
                  'email', x.email,
                  'signedAt', x.signed_at, 'invitedAt', x.invite_sent_at)
                ORDER BY x.order_index)
           FROM lease_document_signers x WHERE x.document_id = d.id) AS signers,
        (SELECT x.name FROM lease_document_signers x
          WHERE x.document_id = d.id AND x.status <> 'signed'
          ORDER BY x.order_index LIMIT 1) AS waiting_on
      FROM lease_documents d
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_document_signers s ON s.document_id = d.id
      WHERE d.landlord_id = ANY($1::uuid[])
        -- S652 (Blu, via Nic): "All the voided ones that are showing in his
        -- history, he wants those deleted... we only want to keep expired ones
        -- for history of tenancy. We don't want to keep voided ones that never
        -- were fully executed. It's just clutter." A voided document never
        -- became an agreement (a completed one cannot be voided), so it has no
        -- place in the landlord's list. The row itself is kept — GAM never
        -- erases — it just is not shown.
        AND d.status <> 'voided'
      GROUP BY d.id, u.unit_number, p.name
      ORDER BY d.created_at DESC`, [landlordScopeIds(req.user!)])
    res.json({ success: true, data: docs })
  } catch (e) { next(e) }
})

/**
 * Create a document from a template.
 * Signer validation:
 *   - Every signer must have a userId (GAM account required)
 *   - Exactly one role='primary'
 *   - At least one role='landlord'
 *   - co_tenant_N roles: zero or more, must match pattern co_tenant_1..N
 *   - Optional role='witness'
 * Template fields assigned to signer roles that aren't filled get pruned
 * (so a template with co_tenant_1..4 slots used on a 2-tenant document only
 *  copies fields for primary + co_tenant_1).
 */
esignRouter.get('/batches', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const batches = await query<any>(`
      SELECT
        b.id, b.title, b.template_id, b.scope_type, b.scope_ref,
        b.status, b.created_at, b.voided_at,
        COUNT(d.id)::int AS document_count,
        COUNT(d.id) FILTER (WHERE d.status = 'completed')::int AS completed_count,
        COUNT(d.id) FILTER (WHERE d.status IN ('pending','sent','in_progress'))::int AS pending_count,
        COUNT(d.id) FILTER (WHERE d.status = 'voided')::int AS voided_count
      FROM document_batches b
      LEFT JOIN lease_documents d ON d.batch_id = b.id
      WHERE b.landlord_id = ANY($1::uuid[])
      GROUP BY b.id
      ORDER BY b.created_at DESC`,
      [landlordScopeIds(req.user!)])
    res.json({ success: true, data: batches })
  } catch (e) {
    next(e)
  }
})

/**
 * Resolve a unit_id from prefillValues at send time.
 * If prefillValues.unit_number is present, match against landlord's units.
 * - 0 matches → throws 400
 * - 1 match → returns that unitId
 * - >1 matches → requires prefillValues.property_address to disambiguate via
 *   case-insensitive partial match on composed street1+street2+city+state+zip.
 * Returns null when unit_number is not provided (caller falls back to the unitId
 * already on the request body from the tenant-lookup path).
 */
// S633: matches across every company the ACCOUNT owns. A landlord typing a unit
// number into the Document Values form is naming a space they own — which
// company holds it is not something they should have to have selected first.
// Ambiguity across companies falls through to the same address disambiguator
// that already handles ambiguity within one.
async function resolveUnitFromPrefill(
  landlordIds: string[],
  prefillValues: Record<string,string>
): Promise<string|null> {
  const unitNumber = (prefillValues?.unit_number || '').trim()
  if (!unitNumber) return null
  // S632: documents now show the bare number ("03"), so that is what a landlord
  // will type back into the Document Values form. Match the stored label exactly
  // OR by its digits, so "03" and "RV 03" both find RV 03. Ambiguity is still
  // refused rather than guessed — "03" matching both RV 03 and MH 03 falls
  // through to the property-address disambiguator below, exactly as before.
  const matches = await query<any>(
    `SELECT u.id, u.unit_number, p.street1, p.street2, p.city, p.state, p.zip, p.name AS property_name
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = ANY($1::uuid[])
        AND (u.unit_number = $2
             OR regexp_replace(u.unit_number, '^[A-Za-z]+\\s*', '') = $2)`,
    [landlordIds, unitNumber]
  )
  if (matches.length === 0) {
    throw new AppError(400, `No unit matches unit number '${unitNumber}' for this landlord.`)
  }
  if (matches.length === 1) return matches[0].id
  // Ambiguous — require property_address disambiguator
  const addressHint = (prefillValues?.property_address || '').trim()
  if (!addressHint) {
    throw new AppError(400, `Ambiguous: ${matches.length} units match '${unitNumber}'. Specify the Property address in Document Values.`)
  }
  const hint = addressHint.toLowerCase()
  const filtered = matches.filter((m: any) => {
    const composed = [m.street1, m.street2, m.city, m.state, m.zip].filter(Boolean).join(' ').toLowerCase()
    return composed.includes(hint)
  })
  if (filtered.length === 0) {
    throw new AppError(400, `No unit '${unitNumber}' matches property address containing '${addressHint}'.`)
  }
  if (filtered.length > 1) {
    throw new AppError(400, `Still ambiguous: ${filtered.length} units match '${unitNumber}' at addresses containing '${addressHint}'. Be more specific.`)
  }
  return filtered[0].id
}

esignRouter.post('/documents', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { templateId, unitId, title, signers, basePdfUrl, prefillValues, depositAlreadyHeld } = req.body
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    // Validate signer shape
    const primaryCount = signers.filter((s: any) => s.role === 'primary').length
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (primaryCount !== 1) throw new AppError(400, 'Exactly one primary tenant signer required')
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }
    // S654: the right kind of login in each role (see assertSignerLogins).
    const signerAccounts = await assertSignerLogins(signers)

    // Resolve each tenant signer's tenant profile (validates they have one)
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
    }

    // Resolve PDF source — template default falls through if no explicit basePdfUrl
    let pdfUrl = basePdfUrl
    let tmplUnitType: string | null = null
    let tmplPropertyId: string | null = null
    let tmplPurpose = 'lease'
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])', [templateId, landlordScopeIds(req.user!)])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
      tmplUnitType = tmpl.unit_type || null
      tmplPropertyId = tmpl.property_id || null
      tmplPurpose = tmpl.purpose || 'lease'
    }

    // Unit resolver — if the template binds unit_number and the landlord filled
    // it in the Document Values form, match against this landlord's units. On
    // success, override any unitId that came from the tenant-lookup fallback.
    const resolvedUnitId = await resolveUnitFromPrefill(landlordScopeIds(req.user!), prefillValues || {})
    const finalUnitId = resolvedUnitId || unitId || null
    // S633: the document belongs to the company that owns the unit it is being
    // sent for — derived, and authorized by the same check. With no unit (a
    // standalone form), the account names the company.
    const docLandlordId = finalUnitId
      ? await landlordIdForUnit(req.user!, finalUnitId, query)
      : await landlordForRequest(req, 'document')
    // S654: a resident on this document must already be this company's, and
    // the landlord's seat is this company's own login at its own address.
    await assertResidentsBelong(signers, signerAccounts, [docLandlordId, ...landlordScopeIds(req.user!)])
    await assertLandlordSigners(signers, { landlordId: docLandlordId, unitId: finalUnitId })

    // S535: templates are per unit type and may be property-locked —
    // refuse incompatible pairings (NULLs fit everything).
    if ((tmplUnitType || tmplPropertyId) && finalUnitId) {
      const u = await queryOne<{ unit_type: string | null; property_id: string }>(
        'SELECT unit_type, property_id FROM units WHERE id=$1', [finalUnitId])
      if (tmplUnitType && u?.unit_type && u.unit_type !== tmplUnitType) {
        throw new AppError(400,
          `This template is for ${tmplUnitType.replace('_', ' ')} units — the selected unit is ${u.unit_type.replace('_', ' ')}. Pick a matching or universal template.`)
      }
      if (tmplPropertyId && u && u.property_id !== tmplPropertyId) {
        throw new AppError(400,
          'This template is locked to a different property than the selected unit. Pick that property\'s template or an unlocked one.')
      }
    }

    // S576 (B-8): purpose-aware. A NON-lease template (a work-trade addendum
    // form) AMENDS the tenant's existing active lease — so the normal e-sign
    // send flow produces an addendum_terms document ON that lease, never a new
    // original_lease (Nic: "picking the addendum template should just work").
    // Falls back cleanly to a new lease for ordinary lease templates.
    let docType: LeaseDocumentType = 'original_lease'
    let docLeaseId: string | null = null
    let wtAgreementId: string | null = null
    if (tmplPurpose === 'work_trade_addendum') {
      const primarySigner = (signers as any[]).find(s => s.role === 'primary')
      if (!primarySigner?.userId) throw new AppError(400, 'An addendum needs the tenant on the existing lease as the primary signer.')
      if (!finalUnitId) throw new AppError(400, 'Could not resolve which unit this addendum is for.')
      const t = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE user_id=$1', [primarySigner.userId])
      if (!t) throw new AppError(400, 'Primary signer has no tenant profile.')
      const activeLease = await queryOne<{ id: string }>(`
        SELECT l.id FROM leases l JOIN lease_tenants lt ON lt.lease_id=l.id
         WHERE l.unit_id=$1 AND lt.tenant_id=$2 AND l.status='active' AND lt.status='active'
         ORDER BY l.start_date DESC LIMIT 1`, [finalUnitId, t.id])
      if (!activeLease) throw new AppError(409, 'No active lease for this tenant on this unit — an addendum amends an existing lease, so add or renew the lease first.')
      docType = 'addendum_terms'
      docLeaseId = activeLease.id
      // Link it to an active work-trade agreement if one exists (so the system
      // knows it's THE work-trade addendum) — same stamp the dedicated flow uses.
      const agr = await queryOne<{ id: string }>(
        `SELECT id FROM work_trade_agreements WHERE unit_id=$1 AND tenant_id=$2 AND status='active' LIMIT 1`,
        [finalUnitId, t.id])
      wtAgreementId = agr?.id || null
    }

    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: docLandlordId,
      templateId: templateId || null,
      unitId: finalUnitId,
      leaseId: docLeaseId,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: docType,
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      // S604: migration onboarding — the landlord already holds this deposit,
      // so state it on the lease but never bill it. Only meaningful on an
      // original_lease; an addendum has no move-in invoice.
      depositAlreadyHeld: docType === 'original_lease' && depositAlreadyHeld === true,
      signers,
      prefillValues: prefillValues || {}
    } as any)
    if (wtAgreementId) {
      await client.query('UPDATE lease_documents SET work_trade_agreement_id=$1 WHERE id=$2', [wtAgreementId, doc.id])
    }

    // ── S641: the rest of the package ────────────────────────────────────────
    //
    // Nic: "when the lease is autodrafted, it combines them all together…
    // otherwise a lot of people are gonna be like, well, I already signed the
    // lease, what's this for?"
    //
    // packageTemplateIds is what the landlord left TICKED on the draft
    // checklist, so an item that does not apply to this tenant is simply
    // absent. Same signers, same group, inside the same transaction — a
    // half-assembled package is worse than none, because somebody would sign
    // part of an agreement.
    const packageTemplateIds: string[] = Array.isArray(req.body?.packageTemplateIds)
      ? req.body.packageTemplateIds.filter((t: any) => typeof t === 'string' && t !== templateId)
      : []
    const packageDocs: any[] = []
    if (packageTemplateIds.length) {
      const groupId = crypto.randomUUID()
      // The lease itself is item zero of its own bundle.
      await client.query(
        `UPDATE lease_documents SET package_group_id=$1, package_id=$2, package_sort_order=0,
                template_version=(SELECT version FROM lease_templates WHERE id=$3)
          WHERE id=$4`,
        [groupId, req.body?.packageId ?? null, templateId || null, doc.id])

      // Ownership-checked in one query rather than trusting the body: a package
      // must never reach for another landlord's form.
      const extras = await client.query(
        `SELECT id, name, base_pdf_url, purpose, version
           FROM lease_templates
          WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND is_active = TRUE`,
        [packageTemplateIds, docLandlordId]).then((r: any) => r.rows)
      if (extras.length !== new Set(packageTemplateIds).size) {
        throw new AppError(403, 'One of those documents is not yours')
      }

      // Keep the landlord's own ordering from the package definition.
      const orderById = new Map<string, number>()
      const defined = await client.query(
        `SELECT template_id, sort_order FROM document_package_items WHERE package_id = $1`,
        [req.body?.packageId ?? null]).then((r: any) => r.rows).catch(() => [])
      for (const d of defined) orderById.set(d.template_id, Number(d.sort_order))
      extras.sort((a: any, b: any) => (orderById.get(a.id) ?? 999) - (orderById.get(b.id) ?? 999))

      // S652 — AN INSTALLMENT SALE IN THE PACKET NEEDS ITS CONTRACT, OR IT
      // BILLS NOTHING AND SAYS NOTHING.
      //
      // Nic wants one packet, two documents, two signatures, and for that to
      // work on a brand-new tenancy exactly as it does on an old one: "It's
      // still two signatures for two separate documents. What does being a new
      // tenant have to do with it?"
      //
      // The trap is that ticking an installment-sale template produced a
      // beautiful signable agreement with NO home_sale_contracts row behind it.
      // Signing it called activateHomeSaleContract, which found nothing on that
      // document and returned quietly. Signed by everybody, billing nobody, and
      // silent about it — which is how Country Acres ended up with eleven
      // contracts that had to be voided.
      //
      // So the terms come in with the draft, or the draft is refused. A refusal
      // is recoverable; a signed agreement that bills nothing is discovered
      // months later by somebody wondering where the money is.
      const installmentTemplate = extras.find((t: any) => t.purpose === 'installment_sale')
      let homeSaleContract: any = null
      let homeSalePrefill: Record<string, string> = {}
      if (installmentTemplate) {
        const { homeSaleTermsSchema, assertUnitIsSaleable, assertBuyerIsKnown } = await import('../services/homeSale')
        // S652 (Nic): terms are TYPED on the contract at signing and become the
        // record then. Terms given here only prefill the boxes.
        if (req.body?.homeSale && homeSaleTermsSchema.safeParse(req.body.homeSale).success) {
        const terms = homeSaleTermsSchema.parse(req.body.homeSale)
        const tenantIdForSale = terms.tenantId
          ?? signers.find((sg: any) => sg.role === 'tenant' || sg.role === 'primary')?.tenantId
          ?? null
        if (!finalUnitId) throw new AppError(400, 'An installment sale needs a unit.')
        await assertUnitIsSaleable(client, finalUnitId)
        if (tenantIdForSale) await assertBuyerIsKnown(client, tenantIdForSale, docLandlordId)
        homeSalePrefill = {
          sale_price:               Number(terms.salePrice).toFixed(2),
          sale_down_payment:        Number(terms.downPayment).toFixed(2),
          sale_term_months:         String(terms.termMonths),
          sale_interest_rate:       String(terms.annualInterestRate),
          sale_first_payment_month: String(terms.startMonth),
          ...(terms.planType === 'flat' && req.body.homeSale.monthlyAmount != null
            ? { sale_monthly_payment: Number(req.body.homeSale.monthlyAmount).toFixed(2) } : {}),
        }
        }
      }

      let order = 1
      for (const t of extras) {
        packageDocs.push(await createDocumentRecord(client, {
          landlordId: docLandlordId,
          templateId: t.id,
          unitId: finalUnitId,
          leaseId: docLeaseId,
          title: t.name,
          basePdfUrl: t.base_pdf_url || null,
          // Everything that rides alongside a lease is an addendum to it unless
          // it is a standalone instrument in its own right. An installment sale
          // is the latter — that separability is the entire point at Country
          // Acres, where lot rent and the trailer are currently one flat figure.
          documentType: t.purpose === 'installment_sale' ? 'purchase_agreement' : 'addendum_terms',
          targetLeaseTenantId: null,
          promoteLeaseTenantId: null,
          signers,
          prefillValues: t.purpose === 'installment_sale'
            ? { ...(prefillValues || {}), ...homeSalePrefill }
            : (prefillValues || {}),
          packageGroupId: groupId,
          packageId: req.body?.packageId ?? null,
          packageSortOrder: order++,
          templateVersion: Number(t.version) || 1,
        } as any))
      }

      // Bind the contract to the agreement that proves it. Done after the loop
      // because the document does not exist until createDocumentRecord runs,
      // and activateHomeSaleContract finds the contract BY that document id.
      if (homeSaleContract) {
        const saleDoc = packageDocs.find((d: any) => d.document_type === 'purchase_agreement')
        if (!saleDoc) throw new AppError(500, 'The purchase agreement was not created')
        await client.query(
          `UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`,
          [homeSaleContract.id, saleDoc.id])
      }
    }

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc, package: packageDocs })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────
// POST /api/esign/standalone-documents  — S568 (Nic): generic e-sign
// ─────────────────────────────────────────────────────────────
// Create a NON-lease document (purchase agreement, bill of sale, general
// contract) with ARBITRARY signers + roles — the generic e-sign engine. Binds
// to no lease/unit; reuses createDocumentRecord (its lease-only blocks are gated
// on unitId/original_lease, so they're skipped) and the existing generic
// /documents/:id/send + token signing flow. Enables financed-home purchase
// agreements (seller=landlord, purchaser=tenant) and resident-to-resident sales
// (landlord just facilitates). Signers must be existing GAM users for now
// (userId required — the same rule leases use before signing); external-party-
// by-email is the next increment.
esignRouter.post('/standalone-documents', requireAuth, requirePerm('esign.template_manage'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = z.object({
      title:        z.string().trim().min(1).max(160),
      documentType: z.enum(STANDALONE_DOCUMENT_TYPES as unknown as [string, ...string[]]),
      templateId:   z.string().uuid().nullable().optional(),
      basePdfUrl:   z.string().nullable().optional(),
      // A signer is identified by email + name + role. No userId needed — every
      // signer is resolved to (or minted as) a GAM account; raw emails never
      // receive a document (anti-spam / consent gate). userId may be supplied to
      // pin an existing account.
      signers: z.array(z.object({
        userId: z.string().uuid().optional(),
        role:   z.string().trim().min(1).max(40),
        name:   z.string().trim().min(1),
        email:  z.string().email(),
        phone:  z.string().max(40).nullable().optional(),
        orderIndex: z.number().int().positive().optional(),
      })).min(1).max(10),
    }).parse(req.body)

    // S652: filed under the template's company when there is one, else
    // wherever fits — never a "which company" refusal (Nic).
    const tmplCo = body.templateId ? await queryOne<{ landlord_id: string }>(
      'SELECT landlord_id FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])',
      [body.templateId, landlordScopeIds(req.user as any)]) : null
    if (body.templateId && !tmplCo) throw new AppError(404, 'Template not found')
    const landlordId = tmplCo?.landlord_id
      ?? await fileUnderCompany(req.user as any, { explicit: (req.body as any)?.landlordId }, query)

    for (const s of body.signers) {
      if (!isValidSignerRole(s.role)) throw new AppError(400, `Invalid signer role: ${s.role}`)
    }
    // Distinct roles — the engine matches template fields to signers by role.
    const roles = body.signers.map(s => s.role)
    if (new Set(roles).size !== roles.length) throw new AppError(400, 'Each signer must have a distinct role.')

    // If a template is supplied it must belong to this landlord.
    if (body.templateId) {
      // (checked against the whole account above)
    }

    await client.query('BEGIN')
    // Resolve every signer to a GAM account — minting a free 'contact' (customer
    // pool) when the email is new. Track the newly-minted ones to invite them.
    const { resolveOrCreateSignerUser } = await import('../services/signerAccounts')
    const newContacts: Array<{ email: string; name: string; inviteToken: string }> = []
    const resolvedSigners = []
    for (let i = 0; i < body.signers.length; i++) {
      const s = body.signers[i]
      let userId = s.userId
      if (!userId) {
        const r = await resolveOrCreateSignerUser(client as any, { email: s.email, name: s.name, phone: s.phone ?? null })
        userId = r.userId
        if (r.created && r.inviteToken) newContacts.push({ email: r.email, name: r.name, inviteToken: r.inviteToken })
      }
      resolvedSigners.push({ userId: userId!, role: s.role, name: s.name, email: s.email, orderIndex: s.orderIndex ?? i + 1 })
    }
    // S654: a pinned userId is a door onto any account. The right kind of login
    // in each role, and a resident only when they are already this company's.
    // A contact minted just above is not a resident, so it passes. Read inside
    // this transaction, where those new accounts live.
    const txRows: RowsQuery = (sql, params) => client.query(sql, params).then((r: any) => r.rows)
    const standaloneAccounts = await assertSignerLogins(resolvedSigners, txRows)
    await assertResidentsBelong(resolvedSigners, standaloneAccounts,
      [landlordId, ...landlordScopeIds(req.user as any)], txRows)
    await assertLandlordSigners(resolvedSigners, { landlordId, unitId: null }, txRows)

    const doc = await createDocumentRecord(client, {
      landlordId,
      templateId: body.templateId ?? null,
      unitId: null,
      leaseId: null,
      title: body.title,
      basePdfUrl: body.basePdfUrl ?? null,
      documentType: body.documentType as any,
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers: resolvedSigners,
    })
    await client.query('COMMIT')

    // The activation invite is NOT sent here — it fires when the landlord SENDS
    // the document (POST /documents/:id/send), which routes an unactivated signer
    // through /accept-invite (their tenant_invite_token) → set password → /sign.
    // So creating the doc just mints the pooled contact accounts; sending invites.
    res.json({ success: true, data: { ...doc, mintedContacts: newContacts.length } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

/**
 * S655: can this NEW LEASE (a document with renews_lease_id) still be canceled?
 * Null when it can; otherwise the refusal, in plain words with the next step.
 * ONE test for POST /documents/:id/void and for the new-lease window
 * (GET /documents/renewal-context → can_cancel), so the window never shows a
 * button the server refuses.
 *
 *   - From its START DATE it cannot be canceled: the 2am job has already ended
 *     the lease before it (the day before the start), and the hand-off may still
 *     be waiting on that lease's last bill. Canceling then left the old lease
 *     ending with nothing to hand over to — the next night's lease-end job read
 *     it as a MOVE-OUT: unit vacant, a deposit return drafted, work trade paused,
 *     on a household that is staying. So the test is the start date itself (by
 *     the property's calendar and by the database's, whichever has turned first —
 *     the 2am job reads the database's), not whether the hand-off has finished.
 *     From then on it ends like any lease in force, with a leaving date.
 *   - The lease before it has already ended some other way (expired): canceling
 *     would leave the household on no lease. Not when it ENDED EARLY
 *     ('terminated' — the household ended it, or another lease replaced it):
 *     nobody is staying on to take the new lease up, so canceling it is exactly
 *     right (and the 15-minute job does it anyway when nobody has signed —
 *     scheduler.processNewLeaseSignings).
 *   - Anyone in the household has signed it: a document a tenant has signed is
 *     never thrown away (S558 — lib/voidDocument refuses it too).
 *   - Money has already been paid on it: lib/unwindIssuedLease refuses the void
 *     (a refund, not a void). Without this the window offered Cancel and the
 *     press came back "Create a superseding document instead" — no next step
 *     for staff.
 */
async function newLeaseCancelRefusal(
  q: (sql: string, params?: any[]) => Promise<{ rows: any[] }>,
  doc: { id: string; status?: string | null; lease_id?: string | null; renews_lease_id?: string | null },
): Promise<string | null> {
  if (!doc.renews_lease_id) return null
  if (doc.status === 'voided') return 'This new lease was already canceled. Nothing else to do.'
  if (doc.status === 'completed') {
    return 'Everyone has signed this new lease, so it can\'t be canceled. If they are leaving, write down the day they go ' +
      'on the new lease once it starts (Leases → Change → They\'re leaving on…).'
  }
  let startWords: string | null = null
  let unitLabel: string | null = null
  let endedEarly = false
  if (doc.lease_id) {
    const nl = (await q(
      `SELECT to_char(nl.start_date, 'YYYY-MM-DD') AS start_date, nl.status, nl.signed_by_landlord,
              ol.status AS old_status, (nl.start_date <= CURRENT_DATE) AS reached_by_db,
              COALESCE(p.timezone, 'America/Phoenix') AS tz,
              COALESCE(u.display_label, u.unit_number) AS unit_label
         FROM leases nl
         JOIN leases ol ON ol.id = $2
         LEFT JOIN units u ON u.id = nl.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
        WHERE nl.id = $1`,
      [doc.lease_id, doc.renews_lease_id])).rows[0]
    const live = !!nl && (nl.status === 'pending' || nl.status === 'active')
    // A new lease whose household ended the lease before it early never comes
    // into force unless one of them signs it (activatePendingLeases), so its
    // start date passing alone does not make it theirs.
    const tookOver = live && (nl.status === 'active'
      || (nl.signed_by_landlord === true && nl.old_status !== 'terminated' && (nl.reached_by_db === true
            || (!!nl.start_date && nl.start_date <= todayIn(nl.tz)))))
    if (tookOver) {
      return `This new lease took over on ${longDateWords(nl.start_date)} — the lease before it ended the day before — ` +
        `so it can't be canceled: the household would be left with no lease. If they are leaving, write down the day ` +
        `they go on the new lease: Leases → Change → They're leaving on…`
    }
    if (live && nl.old_status !== 'active' && nl.old_status !== 'terminated') {
      return `The lease before this one has already ended, so canceling this new lease would leave the household with no lease. ` +
        `If they are leaving, write down the day they go on the new lease once it starts on ${longDateWords(nl.start_date)} ` +
        `(Leases → Change → They're leaving on…).`
    }
    if (nl?.start_date) startWords = longDateWords(nl.start_date)
    unitLabel = nl?.unit_label ?? null
    endedEarly = nl?.old_status === 'terminated'
  }
  const tenantSigned = (await q(
    `SELECT 1 FROM lease_document_signers
      WHERE document_id = $1 AND signed_at IS NOT NULL AND role NOT IN ('landlord','witness') LIMIT 1`,
    [doc.id])).rows[0]
  if (tenantSigned) {
    return 'Someone in the household has signed this new lease, so it can\'t be canceled — a lease a tenant has signed is ' +
      `never thrown away. If they are leaving, write down the day they go on the new lease once it starts` +
      `${startWords ? ` on ${startWords}` : ''} (Leases → Change → They're leaving on…).`
  }
  // Money that actually moved on it (a deposit top-up paid early, say):
  // lib/unwindIssuedLease refuses the void over it, because undoing a payment is
  // a refund, not a void. The same test (renewalSuccessor.moneyPaidOnLease), in
  // words that say who can do it.
  if (doc.lease_id) {
    const { moneyPaidOnLease, sayMoney } = await import('../services/renewalSuccessor')
    const paid = await moneyPaidOnLease(q, doc.lease_id)
    if (paid) {
      return `${sayMoney(paid.total)} has already been paid on this new lease, so it can't be canceled until that money is ` +
        `returned or moved — GAM support does that. Email support@goldassetmanagement.com and name ` +
        `${unitLabel ?? 'the space'}. ` +
        (endedEarly ? 'Once it is sorted, the new lease is canceled for you.' : 'Once it is sorted, you can cancel it here.')
    }
  }
  return null
}

// S534 (Nic): one-minute renewal support. One fetch gives the decision
// modal everything it needs: any OPEN renewal draft for the lease (so a
// second visit OPENS the draft instead of dead-ending on the duplicate-
// draft 409 — the "buried resolve" complaint), plus the template the
// current lease was executed from (preselected so renewing reuses the
// same template by default).
esignRouter.get('/documents/renewal-context/:leaseId', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>(
      `SELECT l.id, l.landlord_id, u.property_id, COALESCE(p.timezone, 'America/Phoenix') AS tz
         FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
        WHERE l.id = $1`, [req.params.leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    await assertWorksAtProperty(req.user, lease.property_id, 'That household is at a property you do not work at.')

    const openDraft = await queryOne<any>(`
      SELECT d.id, d.status, d.title, d.lease_id,
             (SELECT s.status FROM lease_document_signers s
               WHERE s.document_id = d.id AND s.role = 'landlord'
               ORDER BY s.order_index LIMIT 1) AS landlord_signer_status,
             -- S655: what the window says about it — when it starts and whether
             -- the household has signed (a landlord-signed one is issued).
             to_char(nl.start_date, 'YYYY-MM-DD') AS start_date,
             nl.rent_amount::text AS rent_amount,
             EXISTS (SELECT 1 FROM lease_document_signers t
                      WHERE t.document_id = d.id AND t.role NOT IN ('landlord','witness')
                        AND t.status = 'signed') AS tenant_signed,
             -- The start-date test newLeaseCancelRefusal uses: once its start
             -- date has come it is the household's lease (the window says so).
             (nl.signed_by_landlord IS TRUE AND nl.status IN ('pending','active')
               AND (nl.status = 'active' OR nl.start_date <= GREATEST(CURRENT_DATE, $2::date))) AS started
        FROM lease_documents d
        LEFT JOIN leases nl ON nl.id = d.lease_id
       WHERE d.renews_lease_id = $1 AND d.status NOT IN ('completed','voided')
       ORDER BY d.created_at DESC LIMIT 1`, [lease.id, todayIn(lease.tz)])
    // Whether the window may offer "Cancel the new lease": exactly the void
    // route's test (newLeaseCancelRefusal), and when it can't, that route's own
    // words — so the button is never shown only to be refused.
    if (openDraft) {
      const refusal = !userHasPerm(req.user, 'esign.void')
        // The cancel route needs this permission (requirePerm('esign.void')).
        ? 'Canceling a new lease needs the "Void documents" permission. Ask the account owner to cancel it, or to give you that permission.'
        : await newLeaseCancelRefusal(
            async (sql, params) => ({ rows: await query<any>(sql, params) }),
            { id: openDraft.id, status: openDraft.status, lease_id: openDraft.lease_id, renews_lease_id: lease.id })
      openDraft.can_cancel = refusal === null
      openDraft.cancel_refusal = refusal
    }
    // S655: a new lease everyone has signed, waiting to start (or started).
    // Nothing to decide — the window just says so.
    const signedNext = openDraft ? null : await queryOne<any>(`
      SELECT to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.rent_amount::text AS rent_amount
        FROM leases s
       WHERE s.supersedes_lease_id = $1 AND s.status IN ('pending','active') AND s.signed_by_landlord = TRUE
       ORDER BY s.start_date LIMIT 1`, [lease.id])
    const prior = await queryOne<any>(`
      SELECT d.template_id, t.name AS template_name
        FROM lease_documents d
        JOIN lease_templates t ON t.id = d.template_id
       WHERE d.lease_id = $1 AND d.status = 'completed' AND d.template_id IS NOT NULL
       ORDER BY d.completed_at DESC NULLS LAST, d.created_at DESC LIMIT 1`, [lease.id])

    res.json({ success: true, data: {
      openDraft: openDraft || null,
      signedNext: signedNext || null,
      priorTemplateId: prior?.template_id ?? null,
      priorTemplateName: prior?.template_name ?? null,
    }})
  } catch (e) { next(e) }
})

// W-7 (S531): renewal decision → drafted lease. Creates an original_lease
// document for the SAME unit + active roster with the renewal form's terms
// prefilled (per lease-is-law the new terms live in the drafted lease).
// Carry-over: identity fields, term settings, and the current lease's
// recurring / move-out lease_fees prefill from the predecessor; refundable
// move-in deposits are NOT prefilled (they'd re-bill at completion) — they
// copy forward at execution via renews_lease_id. The draft is left in
// 'draft' status: the landlord reviews + sends from the E-Sign page
// (landlord signs first per S28).
//
// S655 (Nic, 10/2): this is "a new lease" for a household already living
// there — month-to-month included. It takes over on its start date and bills
// its rent whether or not the tenant signs; the lease it follows ends the day
// before (services/renewalSuccessor). The tenant reads it as a new lease, never
// as an ending, so the document is titled "New Lease". The same drafting backs
// the park-wide sender below.

/**
 * S655: a staff member scoped to some properties drafts, previews and reads new
 * leases only there — the same rule routes/leases.ts holds. The park-wide
 * preview lists every resident's name and rent, so it must never answer for a
 * park the caller does not work at. Owners are unrestricted.
 */
async function assertWorksAtProperty(user: any, propertyId: string | null | undefined, refusal: string): Promise<void> {
  const { getScopedPropertyIds } = await import('../middleware/auth')
  const scoped = await getScopedPropertyIds(user)
  if (scoped && (!propertyId || !scoped.includes(propertyId))) throw new AppError(403, refusal)
}

/** A unit type as the landlord reads it ('rv_spot' → "RV Spot"), never the raw value. */
function unitTypeWords(t: string | null | undefined): string {
  if (!t) return 'any kind of'
  return (UNIT_TYPE_LABEL as Record<string, string>)[t] ?? humanize(t)
}

/** "January 1, 2027" from 'YYYY-MM-DD'. */
function longDateWords(iso: string): string {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** A lease's status as words a landlord reads. */
const LEASE_STATUS_WORDS: Record<string, string> = {
  pending: 'not started yet', expired: 'over', terminated: 'ended', draft: 'still a draft',
}

/**
 * Draft (but do not send) a new lease for the household on `leaseId`. The
 * single path leaves the start date and rent to the landlord's signing pass
 * (defaults below); the park-wide sender passes both. Every refusal is one
 * plain sentence with the next step.
 */
async function draftNewLeaseForHousehold(user: any, opts: {
  leaseId: string; templateId: string
  startIso?: string | null; rentAmount?: number | null
}): Promise<any> {
  const { leaseId, templateId } = opts
  const lease = await queryOne<any>(`
    SELECT l.*, u.unit_number, u.unit_type, u.property_id, p.name AS property_name,
           p.street1, p.city, p.state, p.zip, p.timezone AS property_timezone
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE l.id=$1`, [leaseId])
  if (!lease) throw new AppError(404, 'Lease not found')
  if (!canManageLandlordResource(user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
  await assertWorksAtProperty(user, lease.property_id, 'That household is at a property you do not work at.')
  if (lease.status !== 'active') {
    throw new AppError(409,
      `This lease is ${LEASE_STATUS_WORDS[lease.status] ?? 'not in force'}, so there is nothing for a new lease to follow on from.`)
  }
  // A stay booked at the front desk is a guest's stay with a check-out date,
  // not a resident's lease — it is changed from the booking, never re-leased.
  if (lease.lease_source === 'booking_draft') {
    throw new AppError(409,
      'This is a stay booked at the front desk, not a resident\'s lease. Change its dates or rate from the booking instead.')
  }
  // S655: they told the desk they are leaving. A new lease and a move-out
  // cannot both be true; the desk mark is undone first, on purpose.
  if (lease.move_out_notice_at && lease.end_date) {
    throw new AppError(409,
      `Unit ${lease.unit_number} is down as leaving on ${isoToDocumentDate(String(dateIso(lease.end_date)))}. ` +
      `If they are staying, call that off first (Leases → Change → Leaving date — change or call off), then start the new lease.`)
  }

  // A second open new-lease draft for the same lease is a mistake.
  const openDraft = await queryOne<any>(`
    SELECT id FROM lease_documents
    WHERE renews_lease_id=$1 AND status NOT IN ('completed','voided')`, [leaseId])
  if (openDraft) {
    throw new AppError(409,
      'A new lease for this household is already in progress. Open it from Leases → Change → New lease from a date… to finish or cancel it.')
  }
  // ...and one already signed by everyone, waiting to start, is too.
  const { newLeaseFollowing } = await import('../services/renewalSuccessor')
  const following = await newLeaseFollowing(async (sql, params) => ({ rows: await query<any>(sql, params) }), leaseId)
  if (following) {
    throw new AppError(409,
      `This household already has a new lease starting ${longDateWords(following.start_date)}.`)
  }

  const tmpl = await queryOne<any>(
    'SELECT * FROM lease_templates WHERE id=$1 AND landlord_id IN (SELECT account_companies($2))', [templateId, lease.landlord_id])
  if (!tmpl) throw new AppError(404, 'Template not found')
  if (!tmpl.base_pdf_url) throw new AppError(400, 'Template has no base PDF')
  // S535: templates are per unit type — refuse an incompatible pairing
  // (universal NULL templates fit every unit).
  if (tmpl.unit_type && lease.unit_type && tmpl.unit_type !== lease.unit_type) {
    throw new AppError(400,
      `Template "${tmpl.name}" is for ${unitTypeWords(tmpl.unit_type)} spaces — this space is ${unitTypeWords(lease.unit_type)}. Pick a matching or universal template.`)
  }
  // S535: property-locked templates only draft at THEIR property —
  // the form's own text names the property, so the wrong pairing is
  // always a mistake.
  if (tmpl.property_id && tmpl.property_id !== lease.property_id) {
    throw new AppError(400,
      `Template "${tmpl.name}" is locked to another property — this unit is at ${lease.property_name}. Pick that property's template or an unlocked one.`)
  }
  // The new terms are entered in the document, so the template must carry
  // the fields the completion chain requires.
  const requiredCols = await query<any>(
    `SELECT DISTINCT lease_column FROM lease_template_fields
     WHERE template_id=$1 AND lease_column IN ('rent_amount','start_date')`, [templateId])
  if ((requiredCols as any[]).length < 2) {
    throw new AppError(400, 'Template must include Rent Amount and Start Date fields — the new terms are set in the drafted lease itself')
  }

  // Signers = landlord + the current active roster, same roles.
  // S630: signing routes per property, so an on-site manager signs for their
  // own property without the portfolio login. Falls back to the account email.
  const landlordUser = await landlordSigningContact(
    lease.landlord_id, { propertyId: lease.property_id ?? null, unitId: lease.unit_id ?? null })
  if (!landlordUser) throw new AppError(500, 'Landlord user not found')
  const roster = await query<any>(`
    SELECT lt.role, u.id AS user_id, u.first_name, u.last_name, u.email, u.phone
    FROM lease_tenants lt
    JOIN tenants t ON t.id = lt.tenant_id
    JOIN users u ON u.id = t.user_id
    WHERE lt.lease_id=$1 AND lt.status='active'
    ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END`, [leaseId])
  if ((roster as any[]).length === 0) throw new AppError(409, 'This lease has nobody on it to sign a new lease.')
  const signers = [
    { userId: landlordUser.userId, role: 'landlord', name: landlordUser.name, email: landlordUser.email, phone: landlordUser.phone, orderIndex: 1 },
    ...(roster as any[]).map((r: any, i: number) => ({
      userId: r.user_id, role: r.role, name: `${r.first_name} ${r.last_name}`,
      email: r.email, phone: r.phone, orderIndex: i + 2,
    })),
  ]

  // Prefill: identity + carried-over settings ONLY. The new terms
  // (rent_amount / start_date / end_date / lease_type) stay blank —
  // the landlord fills them in the document.
  const primary = (roster as any[])[0]
  const prefillValues: Record<string, string> = {
    tenant_name:      `${primary.first_name} ${primary.last_name}`,
    tenant_email:     primary.email || '',
    // S641 (Nic): "Nobody who's signing the landlord side of the legal
    // document signs Oak Park Motel and RV. They sign their name as the agent
    // of the landlord. So it needs to show the printed version of the name of
    // the person signing."
    //
    // This used to reach past the signing contact and take the ACCOUNT
    // OWNER's name, on the reasoning that delegating delivery does not change
    // who the landlord is. True of the landlord as a PARTY — and irrelevant
    // to this box, which sits under a signature line and must name whoever
    // actually put ink on it. Once a property routes signing to an on-site
    // manager, the old behavior printed the owner's name over somebody
    // else's signature. `name` already resolves to the property's signer when
    // one is named, and to the owner otherwise.
    landlord_name:    landlordUser.name,
    unit_number:      lease.unit_number,
    property_name:    lease.property_name || '',
    property_address: [lease.street1, lease.city, lease.state, lease.zip].filter(Boolean).join(', '),
    rent_due_day:     String(lease.rent_due_day ?? 1),
    auto_renew:       lease.auto_renew ? 'true' : 'false',
    notice_days_required:   String(lease.notice_days_required ?? 30),
    expiration_notice_days: String(lease.expiration_notice_days ?? 60),
  }
  if (lease.auto_renew && lease.auto_renew_mode) prefillValues.auto_renew_mode = lease.auto_renew_mode

  // S535 (Nic): CROSS-TEMPLATE renewal — the landlord may renew onto an
  // entirely different/updated template ("change in form"). Prefill
  // EVERY lease column derivable from the predecessor so a new form's
  // bound fields populate automatically; anything underivable (e.g.
  // custom_text, a fee the old lease never had) is typed by the
  // landlord during their signing pass — the tagged-field completeness
  // gate moved from /send to the landlord's sign submit.
  if (lease.lease_type) prefillValues.lease_type = lease.lease_type
  // S535: late fees deliberately NOT carried from the predecessor —
  // they stamp from the CURRENT (property, unit type) policy inside
  // createDocumentRecord ('N/A' when the class has no policy row).
  // Utility responsibilities → 'tenant' / 'landlord' (UTILITY_ROW_SPECS
  // treats 'tenant' as tenant_responsible=TRUE).
  const utilRows = await query<{ utility_type: string; tenant_responsible: boolean }>(
    `SELECT utility_type, tenant_responsible FROM lease_utility_responsibilities WHERE lease_id=$1`, [leaseId])
  const UTIL_TAG: Record<string, string> = {
    water: 'utility_water_responsibility', gas: 'utility_gas_responsibility',
    electric: 'utility_electric_responsibility', sewer: 'utility_sewer_responsibility',
    trash: 'utility_trash_responsibility',
  }
  for (const u of utilRows as any[]) {
    const tag = UTIL_TAG[u.utility_type]
    if (tag) prefillValues[tag] = u.tenant_responsible ? 'tenant' : 'landlord'
  }

  // S534 (Nic): the renewal defaults to the predecessor's terms — the
  // landlord quick-edits what changed in the doc and signs. Rent
  // defaults to the CURRENT rent (raise it in the doc if it changes);
  // this also satisfies the send route's all-tagged-fields-have-values
  // check so draft → auto-send → sign flows without a stop.
  // S655: the park-wide sender sets the new rent for everyone at once.
  prefillValues.rent_amount = (opts.rentAmount != null ? Number(opts.rentAmount) : Number(lease.rent_amount)).toFixed(2)

  // Term mirrors the predecessor — new start = the day after the old
  // end, same duration (a 1-year lease renews as 1 year). Prefills are
  // defaults, not law: the landlord edits them in the doc like any
  // field. S655: the park-wide sender names the start date; a fixed term
  // keeps its length from there, a month-to-month stays month to month.
  const oldStartIso = lease.start_date ? dateIso(lease.start_date) : null
  const oldEndIso = lease.end_date ? dateIso(lease.end_date) : null
  // The term the household SIGNED. A lease holding over has an end date carried
  // past it (renewalSuccessor.holdOverUntilNewLeaseStarts); measured from that,
  // each new lease would grow by the holdover.
  const signedEndIso = lease.holdover_signed_end_date ? dateIso(lease.holdover_signed_end_date) : oldEndIso
  if (oldEndIso && oldStartIso && signedEndIso) {
    const termDays = isoDayDiff(oldStartIso, signedEndIso)
    // From the day after the lease they are on now ends (held over or not).
    const newStartIso = opts.startIso ?? isoAddDays(oldEndIso, 1)
    prefillValues.start_date = isoToDocumentDate(newStartIso)
    prefillValues.end_date   = isoToDocumentDate(isoAddDays(newStartIso, termDays))
  } else if (!oldEndIso) {
    // S535 (Nic): month-to-month predecessor — '-' is the explicit
    // "no end date" entry (execution maps it to end_date NULL +
    // lease_type month_to_month).
    // S536 (Nic): the new lease takes effect at the end of NEXT month by
    // default — one drafted today runs from the first of the month after
    // next (drafted Jul 10 → effective Sep 1). Default only — the landlord
    // edits it in the doc. GAM never gates on legality (S655): no notice
    // rule decides the date.
    // S654: counted from the PROPERTY's today, not the API host's clock.
    if (opts.startIso) {
      prefillValues.start_date = isoToDocumentDate(opts.startIso)
    } else {
      const [ty, tm] = todayIn(lease.property_timezone).split('-').map(Number)
      const effIdx = (tm - 1) + 2
      prefillValues.start_date = isoToDocumentDate(
        `${ty + Math.floor(effIdx / 12)}-${String((effIdx % 12) + 1).padStart(2, '0')}-01`)
    }
    prefillValues.end_date = '-'
  }

  // S534/S535 (Nic): show the CARRIED deposits on the renewal document,
  // per fee_type (security_deposit, pet_deposit, key_deposit, …) so a
  // template binding any deposit field populates with its own carried
  // amount. Custody never moves on a renewal (the fee rows copy forward
  // at execution, tagged, AFTER the move-in invoice); the per-type
  // delta guard in buildLeaseFromDocument means these values can never
  // double-charge — only an INCREASE bills, and only the difference.
  const depositRows = await query<{ fee_type: string; total: string }>(`
    SELECT fee_type, SUM(amount)::text AS total FROM lease_fees
     WHERE lease_id=$1 AND due_timing='move_in' AND is_refundable=TRUE
     GROUP BY fee_type`, [leaseId])
  for (const d of depositRows as any[]) {
    const total = Number(d.total || 0)
    if (total > 0) prefillValues[d.fee_type] = total.toFixed(2).replace(/\.00$/, '')
  }
  if (!prefillValues.security_deposit) prefillValues.security_deposit = 'N/A'

  // Carry recurring + move-out/other lease_fees forward as prefills (they
  // bill on their own timing — nothing re-bills at completion). Move-in
  // fees are excluded: refundable deposits copy at execution instead, and
  // non-refundable move-in fees don't recur on a renewal.
  const feeRows = await query<any>(`
    SELECT fee_type, amount FROM lease_fees
    WHERE lease_id=$1 AND due_timing != 'move_in'`, [leaseId])
  for (const f of feeRows as any[]) {
    prefillValues[f.fee_type] = String(f.amount)
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id,
      templateId,
      unitId: lease.unit_id,
      leaseId: null,
      // S655: the household reads "New Lease", never an ending.
      title: `New Lease — Unit ${lease.unit_number}${lease.property_name ? ' — ' + lease.property_name : ''}`,
      basePdfUrl: tmpl.base_pdf_url,
      documentType: 'original_lease',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      renewsLeaseId: leaseId,
      signers,
      prefillValues,
    } as any)
    // An open tenant-initiated renewal request is now being acted on.
    await client.query(
      `UPDATE lease_renewal_requests SET status='approved', resolved_at=NOW(), updated_at=NOW()
       WHERE lease_id=$1 AND status='requested'`, [leaseId])
    await client.query('COMMIT')
    return doc
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** A pg DATE (local midnight) or 'YYYY-MM-DD…' as 'YYYY-MM-DD'. */
function dateIso(v: string | Date): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  return String(v).slice(0, 10)
}
function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}
function isoDayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

esignRouter.post('/documents/renewal', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    // GAM standard (Nic, S531): THE LEASE IS THE DOCUMENT. This endpoint
    // collects NO terms — no rent, no dates. It drafts the document with
    // identity + carry-over facts prefilled; the landlord types the new
    // rent/dates INTO the drafted lease during their landlord-first
    // signing pass (the sign flow's field inputs + required-field
    // validation are the only place terms are entered).
    const { leaseId, templateId } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required')
    if (!templateId) throw new AppError(400, 'templateId required — pick the lease template to draft from')
    const doc = await draftNewLeaseForHousehold(req.user, { leaseId, templateId })
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    next(e)
  }
})

// ── S655: THE PARK-WIDE SENDER ───────────────────────────────────────────
//
// Nic's direction: "new lease for every resident at this property, starting
// <date>, rent <amount or +%>", the landlord signs each in one pass.
//
// Preview first (nothing is written): one row per household on a lease in force
// at the property, with the new rent, the form it will be drafted on, and —
// where it cannot go — the reason in plain words. Create drafts the ones the
// landlord kept, sends each to the landlord's own signing queue (no email: they
// are at the screen), and returns them in space order for the one-pass signing.

const newLeaseBatchSchema = z.object({
  propertyId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rentMode: z.enum(NEW_LEASE_RENT_MODES),
  rentValue: z.number().finite().optional().nullable(),
  /** Create only: the households the landlord kept in. */
  leaseIds: z.array(z.string().uuid()).optional(),
})

interface NewLeaseBatchRow {
  leaseId: string
  unitNumber: string
  tenantNames: string
  currentRent: number
  newRent: number
  templateId: string | null
  templateName: string | null
  ok: boolean
  reason: string | null
  /** A household that holds over first: "Signed through <end>; stays on today's rent until <start − 1>."
   *  (Already holding over: "Its signed lease ended <end>; it stays on today's rent until <start − 1>.") */
  note: string | null
}

async function planNewLeaseBatch(user: any, body: z.infer<typeof newLeaseBatchSchema>): Promise<{
  propertyName: string; startDate: string; rows: NewLeaseBatchRow[]
}> {
  const prop = await queryOne<any>(
    `SELECT id, name, landlord_id, COALESCE(timezone, 'America/Phoenix') AS tz FROM properties WHERE id = $1`,
    [body.propertyId])
  if (!prop) throw new AppError(404, 'Property not found')
  if (!canManageLandlordResource(user, prop.landlord_id)) throw new AppError(403, 'Not your property')
  await assertWorksAtProperty(user, prop.id, 'That property is not one you work at.')
  const start = leaseFieldDate(body.startDate)
  if (!start) throw new AppError(400, 'The start date is not a real date.')
  if (start <= todayIn(prop.tz)) throw new AppError(400, 'Pick a start date after today.')
  if (body.rentMode === 'amount' && !(Number(body.rentValue) > 0)) {
    throw new AppError(400, 'Type the new monthly rent.')
  }
  if (body.rentMode === 'percent' && !(Number.isFinite(Number(body.rentValue)) && Number(body.rentValue) > -100)) {
    throw new AppError(400, 'Type the percent to raise each rent by.')
  }

  const leases = await query<any>(`
    SELECT l.id, l.rent_amount::text AS rent_amount, l.unit_id, u.unit_type, l.lease_type,
           to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
           -- The end the household SIGNED. A term already holding over has an
           -- end date moved past it (renewalSuccessor.holdOverUntilNewLeaseStarts);
           -- that held-over day is never called the end of the signed lease.
           to_char(l.holdover_signed_end_date, 'YYYY-MM-DD') AS holdover_signed_end_date,
           COALESCE(u.display_label, u.unit_number) AS unit_number,
           (SELECT string_agg(TRIM(tu.first_name || ' ' || COALESCE(tu.last_name, '')), ', '
                              ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END)
              FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users tu ON tu.id = t.user_id
             WHERE lt.lease_id = l.id AND lt.status = 'active') AS tenant_names,
           (SELECT d.template_id FROM lease_documents d
             WHERE d.lease_id = l.id AND d.status = 'completed' AND d.template_id IS NOT NULL
             ORDER BY d.completed_at DESC NULLS LAST, d.created_at DESC LIMIT 1) AS prior_template_id
      FROM leases l
      JOIN units u ON u.id = l.unit_id
     WHERE u.property_id = $1 AND l.status = 'active'
       -- A stay booked at the front desk is a guest's, not a resident's lease.
       AND l.lease_source <> 'booking_draft'
     ORDER BY COALESCE(u.display_label, u.unit_number)`, [prop.id])

  // The lease forms this property can use, with the two fields a new lease needs.
  const templates = await query<any>(`
    SELECT t.id, t.name, t.unit_type, t.property_id
      FROM lease_templates t
     WHERE t.landlord_id IN (SELECT account_companies($1)) AND t.is_active = TRUE
       AND t.purpose = 'lease' AND t.base_pdf_url IS NOT NULL
       AND (t.property_id IS NULL OR t.property_id = $2)
       AND (SELECT COUNT(DISTINCT f.lease_column) FROM lease_template_fields f
             WHERE f.template_id = t.id AND f.lease_column IN ('rent_amount','start_date')) = 2
     ORDER BY lower(t.name)`, [prop.landlord_id, prop.id])
  // Same priority as the single new-lease window: the form the current lease
  // was signed on → one locked to this property for this kind of space → one
  // for this kind of space → the only form there is.
  const pick = (unitType: string | null, prior: string | null): any | null => {
    const fits = (t: any) => !t.unit_type || !unitType || t.unit_type === unitType
    if (prior) { const p = templates.find((t: any) => t.id === prior && fits(t)); if (p) return p }
    const propExact = templates.find((t: any) => t.property_id === prop.id && t.unit_type && t.unit_type === unitType)
    if (propExact) return propExact
    const exact = templates.find((t: any) => t.unit_type && t.unit_type === unitType)
    if (exact) return exact
    const universal = templates.filter((t: any) => !t.unit_type)
    return universal.length === 1 ? universal[0] : null
  }

  const { assertNewLeaseDates, newLeaseFollowing } = await import('../services/renewalSuccessor')
  const rq = async (sql: string, params?: any[]) => ({ rows: await query<any>(sql, params) })
  const rows: NewLeaseBatchRow[] = []
  for (const l of leases as any[]) {
    const currentRent = Number(l.rent_amount) || 0
    const newRent = newLeaseRent(currentRent, body.rentMode, body.rentValue ?? null)
    const t = pick(l.unit_type, l.prior_template_id)
    let reason: string | null = null
    const fixedTerm = !!l.end_date && l.lease_type !== 'month_to_month'
    const signedEnd: string | null = l.holdover_signed_end_date ?? l.end_date
    const heldOver = fixedTerm && !!l.holdover_signed_end_date
    if (!l.tenant_names) reason = 'Nobody is on this lease to sign.'
    else if (!t) reason = `No lease form fits ${unitTypeWords(l.unit_type)} spaces — add one on the GoldSign page.`
    // A signed fixed term runs to its end (renewalSuccessor.assertNewLeaseDates).
    // Said here in the list's own words: this household's new lease goes on its
    // own, from its row, once the batch date is not inside their term.
    else if (fixedTerm && signedEnd && start <= signedEnd) {
      reason = `On a signed lease through ${longDateWords(signedEnd)}. Its new lease can start ${longDateWords(isoAddDays(signedEnd, 1))} — ` +
        'send that one from its own row (Change → New lease from a date…).'
    }
    else {
      const open = await queryOne<any>(
        `SELECT 1 FROM lease_documents WHERE renews_lease_id = $1 AND status NOT IN ('completed','voided') LIMIT 1`, [l.id])
      const following = open ? null : await newLeaseFollowing(rq, l.id)
      if (open) reason = 'A new lease for this household is already in progress.'
      else if (following) reason = `Already has a new lease starting ${longDateWords(following.start_date)}.`
      else {
        try { await assertNewLeaseDates(rq, { renewsLeaseId: l.id, startIso: start }) }
        catch (e: any) { reason = e instanceof AppError ? e.message : 'This lease cannot take a new lease right now.' }
      }
    }
    // A signed term that ends before the day before the start holds over at
    // today's rent until then (decisions 10/2 #7) — said on its row. One already
    // holding over says when its signed lease ended, never the held-over day.
    const holdsOver = reason === null && fixedTerm && (heldOver || l.end_date < isoAddDays(start, -1))
    rows.push({
      leaseId: l.id, unitNumber: l.unit_number, tenantNames: l.tenant_names || '—',
      currentRent, newRent, templateId: t?.id ?? null, templateName: t?.name ?? null,
      ok: reason === null, reason,
      note: !holdsOver ? null
        : heldOver
          ? `Its signed lease ended ${longDateWords(signedEnd!)}; it stays on today's rent until ${longDateWords(isoAddDays(start, -1))}.`
          : `Signed through ${longDateWords(signedEnd!)}; stays on today's rent until ${longDateWords(isoAddDays(start, -1))}.`,
    })
  }
  return { propertyName: prop.name, startDate: start, rows }
}

esignRouter.post('/documents/renewal-batch/preview', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const parsed = newLeaseBatchSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'Pick the property, the start date and how the rent is set.')
    res.json({ success: true, data: await planNewLeaseBatch(req.user, parsed.data) })
  } catch (e) { next(e) }
})

esignRouter.post('/documents/renewal-batch', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const parsed = newLeaseBatchSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'Pick the property, the start date and how the rent is set.')
    // Planned again here, from the database as it is now — never from what the
    // screen showed a minute ago.
    const plan = await planNewLeaseBatch(req.user, parsed.data)
    const keep = parsed.data.leaseIds ? new Set(parsed.data.leaseIds) : null
    const created: Array<{ documentId: string; leaseId: string; unitNumber: string }> = []
    const skipped: Array<{ leaseId: string; unitNumber: string; reason: string }> = []
    for (const r of plan.rows) {
      if (keep && !keep.has(r.leaseId)) continue
      if (!r.ok || !r.templateId) { skipped.push({ leaseId: r.leaseId, unitNumber: r.unitNumber, reason: r.reason ?? 'Not ready.' }); continue }
      try {
        const doc = await draftNewLeaseForHousehold(req.user, {
          leaseId: r.leaseId, templateId: r.templateId, startIso: plan.startDate, rentAmount: r.newRent })
        // Into the landlord's own signing queue — no email, they are signing now,
        // and one notification for the whole batch (below), not one per draft.
        await autoSendDraftedDocument(doc.id, { emailFirstSigner: false, notifyFirstSigner: false })
        created.push({ documentId: doc.id, leaseId: r.leaseId, unitNumber: r.unitNumber })
      } catch (e: any) {
        skipped.push({ leaseId: r.leaseId, unitNumber: r.unitNumber,
          reason: e instanceof AppError ? e.message : 'Could not draft this one — try it again from its own row.' })
        if (!(e instanceof AppError)) logger.error({ err: e, leaseId: r.leaseId }, '[esign] park-wide new lease draft failed')
      }
    }
    // ONE notification per person the drafts wait on ("one email per thing",
    // S652 — the same for the bell): "N new leases at <property> are waiting
    // for your signature", never one per household.
    if (created.length > 0) {
      try {
        const waiting = await query<{ user_id: string; n: number }>(
          `SELECT user_id, COUNT(*)::int AS n FROM lease_document_signers
            WHERE document_id = ANY($1::uuid[]) AND role = 'landlord' AND status = 'sent' AND user_id IS NOT NULL
            GROUP BY user_id`, [created.map(c => c.documentId)])
        const startWords = longDateWords(plan.startDate)
        for (const w of waiting) {
          await createNotification({
            userId: w.user_id,
            type: 'esign_request',
            title: w.n === 1 ? 'A new lease is ready to sign' : `${w.n} new leases are ready to sign`,
            body: `${plan.propertyName}: ${w.n === 1 ? 'a new lease' : `${w.n} new leases`} starting ${startWords} ` +
              `${w.n === 1 ? 'is' : 'are'} waiting for your signature. Nothing reaches a household until you sign theirs.`,
            data: { documentIds: created.map(c => c.documentId), propertyId: parsed.data.propertyId },
            actionUrl: '/esign',
          }).catch(err => logger.error({ err }, '[esign] park-wide new lease notification failed'))
        }
      } catch (err) {
        logger.error({ err }, '[esign] park-wide new lease notification failed')
      }
    }
    res.status(201).json({ success: true, data: { created, skipped } })
  } catch (e) { next(e) }
})
esignRouter.post('/documents/addendum-add', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { leaseId, templateId, title, signers, basePdfUrl } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_add')
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    // 1. Lease exists, landlord owns it, status=active
    const lease = await queryOne<any>(
      'SELECT id, landlord_id, unit_id, status, start_date, end_date FROM leases WHERE id=$1',
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    if (lease.status !== 'active') {
      throw new AppError(409, `Cannot add tenant: lease is ${lease.status}, not active`)
    }

    // 2. Current active roster (user_ids we expect to see in the signer list)
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, lt.role, t.user_id
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    if ((currentRoster as any[]).length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
    }
    const currentUserIds = new Set((currentRoster as any[]).map((r: any) => r.user_id))
    const currentTenantIds = new Set((currentRoster as any[]).map((r: any) => r.tenant_id))

    // 3. Signer shape validation
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }
    // S654: the right kind of login in each role, and a resident (a witness
    // included) only when they are already this company's.
    {
      const accounts = await assertSignerLogins(signers)
      await assertResidentsBelong(signers, accounts, [lease.landlord_id, ...landlordScopeIds(req.user!)])
      await assertLandlordSigners(signers, { landlordId: lease.landlord_id, unitId: lease.unit_id })
    }

    // 4. Resolve each tenant signer's tenant profile
    const tenantSigners: Array<{ userId: string, tenantId: string, role: string, email: string, name: string }> = []
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
      tenantSigners.push({ userId: s.userId, tenantId: t.id, role: s.role, email: s.email, name: s.name })
    }
    if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')

    // 5. Every current active tenant must be a signer on this addendum
    const signerUserIds = new Set(tenantSigners.map(t => t.userId))
    for (const r of currentRoster as any[]) {
      if (!signerUserIds.has(r.user_id)) {
        throw new AppError(400, `Current tenant (user ${r.user_id}) must sign addendum — all roommates sign roster changes`)
      }
    }

    // 6. Exactly ONE tenant signer is not currently on the roster — that's the new tenant
    const newTenants = tenantSigners.filter(t => !currentTenantIds.has(t.tenantId))
    if (newTenants.length === 0) {
      throw new AppError(400, 'No new tenant in signer list — addendum_add requires exactly one new tenant')
    }
    if (newTenants.length > 1) {
      throw new AppError(400, `Multiple new tenants in signer list (${newTenants.length}) — addendum_add accepts exactly one`)
    }
    const newTenant = newTenants[0]

    // 7. New tenant not already in a pending/active state on this lease
    const existing = await queryOne<any>(`
      SELECT id, status FROM lease_tenants
      WHERE lease_id=$1 AND tenant_id=$2
        AND status IN ('pending_add','active','pending_remove')`,
      [leaseId, newTenant.tenantId])
    if (existing) {
      throw new AppError(409, `Tenant ${newTenant.email} is already on this lease (status: ${existing.status})`)
    }

    // 8. Overlap check for new tenant — excludes current lease to avoid self-conflict
    const ov = await canTenantsSignNewLease(
      [newTenant.tenantId], lease.unit_id,
      lease.start_date, lease.end_date || null,
      lease.id)
    if (!ov.ok) throw new AppError(409, ov.reason || 'New tenant has overlapping lease')

    // 9. Platform-block check every tenant signer
    for (const t of tenantSigners) {
      const blk = await checkPlatformBlock(t.userId)
      if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
    }

    // Resolve PDF
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id IN (SELECT account_companies($2))',
        [templateId, lease.landlord_id])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // Transaction: create document + insert pending_add row atomically
    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id,
      templateId: templateId || null,
      unitId: lease.unit_id,
      leaseId: lease.id,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'addendum_add',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers
    })

    await client.query(`
      INSERT INTO lease_tenants (
        lease_id, tenant_id, role, status,
        added_reason, financial_responsibility,
        add_document_id
      ) VALUES ($1,$2,'co_tenant','pending_add', 'roommate_added', 'joint_several', $3)`,
      [lease.id, newTenant.tenantId, doc.id])

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-remove', requireAuth, requirePerm('leases.terminate'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { leaseId, targetLeaseTenantId, promoteLeaseTenantId, templateId, title, signers, basePdfUrl } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_remove')
    if (!targetLeaseTenantId) throw new AppError(400, 'targetLeaseTenantId required for addendum_remove')
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    // 1. Lease exists, landlord owns, status=active
    const lease = await queryOne<any>(
      'SELECT id, landlord_id, unit_id, status FROM leases WHERE id=$1',
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    if (lease.status !== 'active') {
      throw new AppError(409, `Cannot remove tenant: lease is ${lease.status}, not active`)
    }

    // 2. Current active roster
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, lt.role, t.user_id
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    const rosterRows = currentRoster as any[]
    if (rosterRows.length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
    }

    // 3. Minimum-2 rule — cannot remove if it would leave zero active tenants
    if (rosterRows.length < 2) {
      throw new AppError(400, 'Cannot remove the only tenant on this lease — use lease termination instead')
    }

    // 4. Target row validation: exists, on this lease, currently active (not already pending_remove)
    const target = rosterRows.find(r => r.lt_id === targetLeaseTenantId)
    if (!target) {
      // Possible: target exists but is pending_remove, or on a different lease, or doesn't exist at all
      const dbTarget = await queryOne<any>(
        'SELECT id, lease_id, status FROM lease_tenants WHERE id=$1',
        [targetLeaseTenantId])
      if (!dbTarget) throw new AppError(404, 'Target lease_tenant row not found')
      if (dbTarget.lease_id !== leaseId) throw new AppError(400, 'Target does not belong to this lease')
      throw new AppError(409, `Target tenant is ${dbTarget.status}, not active — cannot initiate removal`)
    }

    // 5. Primary-removal rule — if target is primary, promote required and must be active co_tenant on this lease
    if (target.role === 'primary') {
      if (!promoteLeaseTenantId) {
        throw new AppError(400, 'Removing the primary tenant requires promoteLeaseTenantId (successor primary)')
      }
      const promote = rosterRows.find(r => r.lt_id === promoteLeaseTenantId)
      if (!promote) {
        throw new AppError(400, 'Promote target must be an active tenant on this lease')
      }
      if (promote.role !== 'co_tenant') {
        throw new AppError(400, `Promote target role is ${promote.role}, must be co_tenant`)
      }
      if (promote.lt_id === target.lt_id) {
        throw new AppError(400, 'Promote target cannot be the same as the removal target')
      }
    } else {
      if (promoteLeaseTenantId) {
        throw new AppError(400, 'promoteLeaseTenantId set but target is not primary')
      }
    }

    // 6. Signer shape validation
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }
    // S654: the right kind of login in each role, and a resident (a witness
    // included) only when they are already this company's.
    {
      const accounts = await assertSignerLogins(signers)
      await assertResidentsBelong(signers, accounts, [lease.landlord_id, ...landlordScopeIds(req.user!)])
      await assertLandlordSigners(signers, { landlordId: lease.landlord_id, unitId: lease.unit_id })
    }

    // 7. Resolve each tenant signer's tenant profile
    const tenantSigners: Array<{ userId: string, tenantId: string, role: string, email: string, name: string }> = []
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
      tenantSigners.push({ userId: s.userId, tenantId: t.id, role: s.role, email: s.email, name: s.name })
    }
    if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')

    // 8. Signer composition rule — all current active tenants (INCLUDING target) must sign,
    //    and no tenant signer can be someone not currently on the lease
    const signerUserIds = new Set(tenantSigners.map(t => t.userId))
    const signerTenantIds = new Set(tenantSigners.map(t => t.tenantId))
    for (const r of rosterRows) {
      if (!signerUserIds.has(r.user_id)) {
        throw new AppError(400, `Current tenant (user ${r.user_id}) must sign addendum — all active tenants (including the one being removed) sign`)
      }
    }
    for (const t of tenantSigners) {
      const onRoster = rosterRows.find((r: any) => r.tenant_id === t.tenantId)
      if (!onRoster) {
        throw new AppError(400, `Signer ${t.email} is not currently on this lease — only current tenants sign removal addendums`)
      }
    }

    // 9. Platform-block check every tenant signer
    for (const t of tenantSigners) {
      const blk = await checkPlatformBlock(t.userId)
      if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
    }

    // Resolve PDF
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id IN (SELECT account_companies($2))',
        [templateId, lease.landlord_id])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // Transaction: create document + flip target to pending_remove atomically
    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id,
      templateId: templateId || null,
      unitId: lease.unit_id,
      leaseId: lease.id,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'addendum_remove',
      targetLeaseTenantId: target.lt_id,
      promoteLeaseTenantId: promoteLeaseTenantId || null,
      signers
    })

    await client.query(`
      UPDATE lease_tenants
      SET status='pending_remove', remove_document_id=$1
      WHERE id=$2 AND status='active'`,
      [doc.id, target.lt_id])

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-terms/batch', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { title, templateId, scopeType, scopeRef } = req.body

    // 1. Body shape validation
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new AppError(400, 'title is required')
    }
    if (!templateId || typeof templateId !== 'string') {
      throw new AppError(400, 'templateId is required')
    }
    if (!scopeType || !['units', 'property', 'landlord_all'].includes(scopeType)) {
      throw new AppError(400, 'scopeType must be one of: units, property, landlord_all')
    }

    // S633: a batch addendum writes a document against EVERY lease in scope, so
    // "landlord_all" has to mean one named company — an account that owns two
    // would otherwise paper both companies' residents from one click. Named
    // explicitly, or the account's only company when it has one.
    const landlordId = await landlordForRequest(req, 'addendum batch')
    const landlordUserId = req.user!.userId

    // 2. Template ownership
    const tmpl = await queryOne<any>(
      'SELECT * FROM lease_templates WHERE id=$1 AND landlord_id = ANY($2::uuid[])',
      [templateId, landlordScopeIds(req.user!)])
    if (!tmpl) throw new AppError(404, 'Template not found')

    // 3. Landlord user record for signer construction
    const landlordUser = await queryOne<any>(
      'SELECT id, first_name, last_name, email FROM users WHERE id=$1',
      [landlordUserId])
    if (!landlordUser) throw new AppError(500, 'Landlord user record not found')
    const landlordSigner = {
      userId: landlordUser.id,
      role: 'landlord',
      name: `${landlordUser.first_name} ${landlordUser.last_name}`,
      email: landlordUser.email,
      orderIndex: 1,
    }

    // 4. Resolve scope -> unit_ids
    let unitIds: string[]
    try {
      unitIds = await resolveScopeToUnitIds(client, landlordId, scopeType, scopeRef)
    } catch (e: any) {
      throw new AppError(409, e.message)
    }

    // 5. Resolve unit_ids -> applicable leases (pending/active only)
    const leases = await resolveUnitsToApplicableLeases(client, landlordId, unitIds)

    // 6. Refuse if empty scope
    if (leases.length === 0) {
      throw new AppError(409, 'No applicable leases in scope')
    }

    // 7. Load roster for every lease (single query, grouped in memory)
    const leaseIds = leases.map(l => l.id)
    const rosterRows = await query<any>(`
      SELECT lt.id AS lt_id, lt.lease_id, lt.tenant_id, lt.role AS lt_role,
             t.user_id, u.first_name, u.last_name, u.email
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id = ANY($1::uuid[]) AND lt.status = 'active'`,
      [leaseIds])

    // Group by lease_id
    const rostersByLease = new Map<string, any[]>()
    for (const r of rosterRows as any[]) {
      if (!rostersByLease.has(r.lease_id)) rostersByLease.set(r.lease_id, [])
      rostersByLease.get(r.lease_id)!.push(r)
    }

    // 8. Validation sweep — every lease has >=1 active tenant with full user data
    for (const lease of leases) {
      const roster = rostersByLease.get(lease.id) || []
      if (roster.length === 0) {
        throw new AppError(409, `Lease ${lease.id} has no active tenants — cannot batch terms addendum`)
      }
      for (const r of roster) {
        if (!r.user_id || !r.email || !r.first_name || !r.last_name) {
          throw new AppError(409, `Lease ${lease.id} tenant ${r.tenant_id} missing required user data — contact support`)
        }
      }
    }

    // 9. Platform-block check every unique tenant user across the batch
    const uniqueTenantUserIds = new Set<string>()
    for (const r of rosterRows as any[]) uniqueTenantUserIds.add(r.user_id)
    for (const uid of uniqueTenantUserIds) {
      const blk = await checkPlatformBlock(uid)
      if (!blk.ok) {
        const row = (rosterRows as any[]).find(r => r.user_id === uid)
        throw new AppError(403, `${row.first_name} ${row.last_name}: ${blk.reason}`)
      }
    }

    // 10. Transaction: one batch row + N doc rows atomically
    await client.query('BEGIN')

    const batchInsert = await client.query(`
      INSERT INTO document_batches (landlord_id, title, template_id, scope_type, scope_ref)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id`,
      [landlordId, title.trim(), templateId, scopeType, scopeRef ? JSON.stringify(scopeRef) : null])
    const batchId: string = batchInsert.rows[0].id

    const documentIds: string[] = []

    for (const lease of leases) {
      const roster = rostersByLease.get(lease.id)!
      const tenantSigners = roster.map((r, idx) => ({
        userId: r.user_id,
        role: idx === 0 ? 'primary' : `co_tenant_${idx}`,
        name: `${r.first_name} ${r.last_name}`,
        email: r.email,
        orderIndex: idx + 2,
      }))

      const signers = [landlordSigner, ...tenantSigners]

      const doc = await createDocumentRecord(client, {
        landlordId,
        templateId,
        unitId: lease.unit_id,
        leaseId: lease.id,
        title: title.trim(),
        basePdfUrl: tmpl.base_pdf_url || null,
        documentType: 'addendum_terms',
        targetLeaseTenantId: null,
        promoteLeaseTenantId: null,
        signers,
      })

      // Stamp batch_id on the just-created document
      await client.query(
        'UPDATE lease_documents SET batch_id=$1 WHERE id=$2',
        [batchId, doc.id])

      documentIds.push(doc.id)
    }

    await client.query('COMMIT')
    res.status(201).json({
      success: true,
      data: { batchId, documentCount: documentIds.length, documentIds }
    })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-terms', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { leaseId, templateId, title, basePdfUrl } = req.body
    // S581: signers may be OMITTED — the money-add-on flow lets the backend resolve
    // them from the lease (landlord + tenants), so the landlord screen just says
    // "leaseId + mode + changes". Explicit signers still supported (the send flow).
    let signers = req.body.signers as any[] | undefined
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_terms')
    if (!title) throw new AppError(400, 'title required')

    // S581: delivery mode determined up-front (drives auto-signer resolution).
    // 'agreement' = tenant opts in + signs; 'notice' = landlord issues, no tenant
    // signature. Landlord chooses per add-on, per their local law (never GAM by state).
    const mode: 'agreement' | 'notice' = req.body.mode === 'notice' ? 'notice' : 'agreement'

    // S581 (Nic): optional MONEY changes this addendum carries — an added recurring
    // charge (parking/garage) or a base-rent change (e.g. AZ mobile-home space rent).
    // Each has a landlord-set effective_date; on completion the nightly job applies
    // it to billing on that date (auto-apply). Validated + stored as pending
    // 'draft' rows below, activated when both parties sign.
    const scheduledChanges = (req.body.scheduledChanges ?? []) as any[]
    const changesSpec = z.array(z.discriminatedUnion('changeType', [
      z.object({
        changeType:    z.literal('rent'),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        newRentAmount: z.number().nonnegative(),
      }),
      z.object({
        changeType:     z.literal('recurring_fee'),
        effectiveDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        // Must be a RECURRING (monthly_ongoing) lease_fees fee_type — the value
        // the apply job writes into lease_fees, which is CHECK-constrained. Only
        // the recurring subset is valid here (deposits / one-time fees excluded).
        feeType:        z.enum([
          'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
          'trash_fee', 'pest_control_fee', 'technology_fee', 'other_fee',
        ]),
        feeAmount:      z.number().nonnegative(),
        feeDescription: z.string().max(200).optional(),
      }),
    ])).parse(scheduledChanges)

    // 1. Lease exists, landlord owns it. Status restriction intentionally omitted —
    //    terms amendments are valid on any lease status (pending/active alike).
    const lease = await queryOne<any>(
      'SELECT id, landlord_id, unit_id, status FROM leases WHERE id=$1',
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    // S71: 'voided' branch dropped — unreachable per leases_status_check.
    if (lease.status === 'expired' || lease.status === 'terminated') {
      throw new AppError(409, `Cannot amend terms: lease is ${lease.status}`)
    }

    // 2. Current active roster — every active tenant must sign a terms change.
    //    (name/email included so we can auto-assemble signers below.)
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, t.user_id,
             u.first_name, u.last_name, u.email
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    const rosterRows = currentRoster as any[]
    if (rosterRows.length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
    }

    // S581: auto-resolve signers when the caller omits them (money-add-on flow).
    // Landlord always signs. AGREEMENT also needs every active tenant to sign;
    // a NOTICE is landlord-only (no tenant signature). Roles: first tenant is
    // 'primary', the rest 'co_tenant' — matching the addendum signer contract.
    if (!signers?.length) {
      const ll = await queryOne<{ user_id: string; first_name: string; last_name: string; email: string }>(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.email
           FROM landlords la JOIN users u ON u.id = la.user_id WHERE la.id = $1`,
        [lease.landlord_id])
      if (!ll) throw new AppError(500, 'Landlord account not found')
      // S652 (Blu, "Country Acres Addendum Troy — MH 22"): every signer built
      // here landed at signing position 1, so the send step refused it —
      // "no signer may share the landlord's signing position." The landlord is
      // position 1; each tenant follows, as every other drafting path does.
      const built: any[] = [{
        userId: ll.user_id, role: 'landlord', orderIndex: 1,
        name: `${ll.first_name ?? ''} ${ll.last_name ?? ''}`.trim() || ll.email, email: ll.email,
      }]
      if (mode === 'agreement') {
        // Signer roles MUST match TENANT_ROLE_PATTERN /^(primary|co_tenant_\d+)$/ —
        // the literal 'co_tenant' is NOT a valid signer role and would trip the
        // "Invalid signer role" guard below, so a 2+-tenant agreement addendum
        // would 400. First tenant = primary, the rest = co_tenant_1, co_tenant_2, …
        rosterRows.forEach((r: any, i: number) => built.push({
          userId: r.user_id, role: i === 0 ? 'primary' : `co_tenant_${i}`, orderIndex: i + 2,
          name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email, email: r.email,
        }))
      }
      signers = built
    }

    // 3. Signer shape validation
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }
    // S654: the right kind of login in each role, and a resident (a witness
    // included) only when they are already this company's.
    {
      const accounts = await assertSignerLogins(signers)
      await assertResidentsBelong(signers, accounts, [lease.landlord_id, ...landlordScopeIds(req.user!)])
      await assertLandlordSigners(signers, { landlordId: lease.landlord_id, unitId: lease.unit_id })
    }

    // 4. Resolve each tenant signer's tenant profile
    const tenantSigners: Array<{ userId: string, tenantId: string, role: string, email: string, name: string }> = []
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
      tenantSigners.push({ userId: s.userId, tenantId: t.id, role: s.role, email: s.email, name: s.name })
    }
    // S581: a NOTICE is landlord-issued and NOT optional, so it needs no tenant
    // signature. AGREEMENT mode keeps the "every active tenant must sign" rule
    // (a rule the tenant is agreeing to). For a notice the affected tenants are
    // still notified — a blocking portal notice is created on completion.
    if (mode === 'agreement') {
      if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')
      // 5. Signer composition — all current active tenants must sign, no outsiders
      const signerUserIds = new Set(tenantSigners.map(t => t.userId))
      for (const r of rosterRows) {
        if (!signerUserIds.has(r.user_id)) {
          throw new AppError(400, `Current tenant (user ${r.user_id}) must sign terms addendum — all active tenants sign rule changes`)
        }
      }
    }
    for (const t of tenantSigners) {
      const onRoster = rosterRows.find((r: any) => r.tenant_id === t.tenantId)
      if (!onRoster) {
        throw new AppError(400, `Signer ${t.email} is not currently on this lease — only current tenants sign terms addendums`)
      }
    }

    // 6. Platform-block check every tenant signer
    for (const t of tenantSigners) {
      const blk = await checkPlatformBlock(t.userId)
      if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
    }

    // Resolve PDF
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id IN (SELECT account_companies($2))',
        [templateId, lease.landlord_id])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // S582: document-first for money add-ons. When the addendum carries a money
    // change and the landlord supplied NO base PDF/template (the MoneyAddonModal
    // path), GENERATE an addendum PDF that PRINTS the exact change + effective
    // date + signature fields — so the tenant signs a document that states the
    // term (memory gam-document-first-enforcement: courts enforce the document,
    // not the software config). The field boxes come back to be persisted below.
    let generatedFields: import('../services/moneyAddonPdf').MoneyAddonFieldBox[] = []
    if (changesSpec.length > 0 && !pdfUrl) {
      const { generateMoneyAddonPdf } = await import('../services/moneyAddonPdf')
      const gen = await generateMoneyAddonPdf({
        leaseId: lease.id,
        title,
        mode,
        changes: changesSpec as any,
        signers: signers.map((s: any) => ({ role: s.role, name: s.name })),
      })
      pdfUrl = gen.fileUrl
      generatedFields = gen.fields
    }

    // Transaction: just create the document. No lease_tenants mutation for terms addendums.
    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id,
      templateId: templateId || null,
      unitId: lease.unit_id,
      leaseId: lease.id,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'addendum_terms',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers
    })

    // S581: mark a landlord-issued NOTICE so completion creates the tenant
    // blocking-notice (and no tenant signature is expected). Agreement is default.
    if (mode === 'notice') {
      await client.query(`UPDATE lease_documents SET delivery_mode='notice' WHERE id=$1`, [doc.id])
    }

    // S582: persist the generated PDF's signature/date fields, bound to each
    // signer row (roles are 1:1 with signers here — landlord + primary +
    // co_tenant_N). Skips any field whose role isn't a signer on this document
    // (a notice generates only a landlord block, so nothing is skipped there).
    if (generatedFields.length > 0) {
      const signerRows = await client.query(
        'SELECT id, role FROM lease_document_signers WHERE document_id=$1', [doc.id],
      ).then((r: any) => r.rows as Array<{ id: string; role: string }>)
      const idByRole = new Map(signerRows.map(s => [s.role, s.id]))
      for (const f of generatedFields) {
        const signerId = idByRole.get(f.signerRole)
        if (!signerId) continue
        await client.query(`
          INSERT INTO lease_document_fields
            (document_id, signer_id, field_type, signer_role, label, lease_column,
             page, x, y, width, height, required)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [doc.id, signerId, f.fieldType, f.signerRole, f.label, f.leaseColumn,
           f.page, f.x, f.y, f.width, f.height, f.required])
      }
    }

    // S581: record the money changes as pending 'draft' rows tied to this
    // addendum. They activate to 'scheduled' when both parties sign (see
    // executeAddendumTerms) and apply on their effective date. Same txn as the doc.
    if (changesSpec.length > 0) {
      const { createDraftScheduledChange } = await import('../services/scheduledLeaseChanges')
      for (const ch of changesSpec) {
        await createDraftScheduledChange(client, lease.id, doc.id, ch as any)
      }
    }

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// S576 (B-8): send a WORK-TRADE ADDENDUM. Because a work-trade agreement
// requires an ACTIVE lease, the addendum is just a plain lease TERMS addendum on
// that lease — the proven addendum_terms path (no standalone-completion issues).
// Everything resolves server-side (lease + signers) so the landlord only picks
// their addendum form and clicks send. The document is stamped with
// work_trade_agreement_id so the system KNOWS it's this agreement's addendum
// (no name-guessing) — powering the "addendum on file" surface + renewal
// auto-carry. Create-only; the caller then POSTs /documents/:id/send.
esignRouter.post('/documents/work-trade-addendum', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { workTradeAgreementId, templateId } = req.body
    if (!workTradeAgreementId) throw new AppError(400, 'workTradeAgreementId required')
    if (!templateId) throw new AppError(400, 'templateId required — pick your work-trade addendum form')

    const agr = await queryOne<any>(`
      SELECT wta.id, wta.unit_id, wta.tenant_id, wta.landlord_id, wta.status,
             un.unit_number, p.name AS property_name
        FROM work_trade_agreements wta
        JOIN units un ON un.id = wta.unit_id
        JOIN properties p ON p.id = un.property_id
       WHERE wta.id=$1`, [workTradeAgreementId])
    if (!agr) throw new AppError(404, 'Work-trade agreement not found')
    if (!canManageLandlordResource(req.user, agr.landlord_id)) throw new AppError(403, 'Not your agreement')
    // S633: the company is the agreement's own — derived, not taken from session
    // state, and already authorized by the line above.
    const landlordId: string = agr.landlord_id
    if (agr.status !== 'active') throw new AppError(409, `Agreement is ${agr.status} — resume or renew the lease before sending an addendum`)

    // The gate guarantees an active lease for this tenant on this unit.
    const lease = await queryOne<any>(`
      SELECT l.id, l.unit_id FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
      WHERE l.unit_id=$1 AND lt.tenant_id=$2 AND l.status='active' AND lt.status='active'
      ORDER BY l.start_date DESC LIMIT 1`, [agr.unit_id, agr.tenant_id])
    if (!lease) throw new AppError(409, 'No active lease for this tenant on this unit — renew the lease first')

    const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id IN (SELECT account_companies($2))', [templateId, landlordId])
    if (!tmpl) throw new AppError(404, 'Template not found')
    if (tmpl.purpose !== 'work_trade_addendum') throw new AppError(400, 'Pick a Work-Trade Addendum form (set Form Type = Work-Trade Addendum on the template)')
    if (!tmpl.base_pdf_url) throw new AppError(400, 'That addendum form has no PDF — add one in the template editor')

    const landlordUser = await landlordSigningContact(
      landlordId, { propertyId: lease.property_id ?? null, unitId: lease.unit_id ?? null })
    if (!landlordUser) throw new AppError(500, 'Landlord user not found')
    const roster = await query<any>(`
      SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, lt.role
        FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users u ON u.id = t.user_id
       WHERE lt.lease_id=$1 AND lt.status='active'
       ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END`, [lease.id])
    if ((roster as any[]).length === 0) throw new AppError(409, 'Lease has no active tenants to sign the addendum')
    const signers = [
      { userId: landlordUser.userId, role: 'landlord', name: landlordUser.name, email: landlordUser.email, phone: landlordUser.phone, orderIndex: 1 },
      ...(roster as any[]).map((r: any, i: number) => ({
        userId: r.user_id, role: r.role, name: `${r.first_name} ${r.last_name}`,
        email: r.email, phone: r.phone, orderIndex: i + 2,
      })),
    ]

    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId, templateId, unitId: lease.unit_id, leaseId: lease.id,
      title: `Work-Trade Addendum — Unit ${agr.unit_number}${agr.property_name ? ' — ' + agr.property_name : ''}`,
      basePdfUrl: tmpl.base_pdf_url, documentType: 'addendum_terms',
      targetLeaseTenantId: null, promoteLeaseTenantId: null, signers,
    })
    await client.query('UPDATE lease_documents SET work_trade_agreement_id=$1 WHERE id=$2', [workTradeAgreementId, doc.id])
    await client.query('COMMIT')
    res.status(201).json({ success: true, data: { ...doc, work_trade_agreement_id: workTradeAgreementId } })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// S576 (B-8): after a RENEWAL completes, auto-DRAFT (never auto-send) a fresh
// work-trade addendum on the new lease when the tenant's work-trade agreement is
// still ACTIVE — the arrangement carries across the renewal, but the landlord
// eyeballs the draft and sends it, exactly like the renewal itself (Nic). Leaves
// it as an unsent `pending` document that the Work Trade page surfaces as
// "review & send" + a dashboard to-do. Best-effort: never throws into the e-sign
// completion flow. If the landlord has no work-trade addendum FORM, it drafts
// nothing (the manual "Add a form" surface covers that).
export async function autoDraftWorkTradeAddendumForRenewal(newLeaseId: string): Promise<void> {
  const lease = await queryOne<any>(`
    SELECT l.id, l.unit_id, l.landlord_id, u.unit_type, u.property_id, u.unit_number, p.name AS property_name
      FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=u.property_id
     WHERE l.id=$1`, [newLeaseId])
  if (!lease) return
  const agr = await queryOne<any>(`
    SELECT wta.id FROM work_trade_agreements wta
     WHERE wta.unit_id=$1 AND wta.status='active'
       AND wta.tenant_id IN (SELECT tenant_id FROM lease_tenants WHERE lease_id=$2 AND status='active')
     LIMIT 1`, [lease.unit_id, newLeaseId])
  if (!agr) return
  // Idempotent: don't re-draft if a live addendum already exists on this lease.
  const dupe = await queryOne<any>(
    `SELECT id FROM lease_documents WHERE work_trade_agreement_id=$1 AND lease_id=$2 AND status NOT IN ('voided') LIMIT 1`,
    [agr.id, newLeaseId])
  if (dupe) return
  // Resolve the landlord's work-trade addendum form — most specific first
  // (property match, then unit-type match, then universal), newest as tiebreak.
  const tmpl = await queryOne<any>(`
    SELECT * FROM lease_templates
     WHERE landlord_id=$1 AND is_active=TRUE AND purpose='work_trade_addendum'
       AND base_pdf_url IS NOT NULL
       AND (unit_type IS NULL OR unit_type=$2)
       AND (property_id IS NULL OR property_id=$3)
     ORDER BY (property_id=$3) DESC NULLS LAST, (unit_type=$2) DESC NULLS LAST, created_at DESC
     LIMIT 1`, [lease.landlord_id, lease.unit_type, lease.property_id])
  if (!tmpl) return
  const landlordUser = await landlordSigningContact(
    lease.landlord_id, { propertyId: lease.property_id ?? null, unitId: lease.unit_id ?? null })
  if (!landlordUser) return
  const roster = await query<any>(`
    SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, lt.role
      FROM lease_tenants lt JOIN tenants t ON t.id=lt.tenant_id JOIN users u ON u.id=t.user_id
     WHERE lt.lease_id=$1 AND lt.status='active'
     ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END`, [newLeaseId])
  if ((roster as any[]).length === 0) return
  const signers = [
    { userId: landlordUser.userId, role: 'landlord', name: landlordUser.name, email: landlordUser.email, phone: landlordUser.phone, orderIndex: 1 },
    ...(roster as any[]).map((r: any, i: number) => ({ userId: r.user_id, role: r.role, name: `${r.first_name} ${r.last_name}`, email: r.email, phone: r.phone, orderIndex: i + 2 })),
  ]
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id, templateId: tmpl.id, unitId: lease.unit_id, leaseId: newLeaseId,
      title: `Work-Trade Addendum — Unit ${lease.unit_number}${lease.property_name ? ' — ' + lease.property_name : ''}`,
      basePdfUrl: tmpl.base_pdf_url, documentType: 'addendum_terms',
      targetLeaseTenantId: null, promoteLeaseTenantId: null, signers,
    } as any)
    await client.query('UPDATE lease_documents SET work_trade_agreement_id=$1 WHERE id=$2', [agr.id, doc.id])
    await client.query('COMMIT')
    logger.info(`[LeaseRenewal] Auto-drafted work-trade addendum ${doc.id} on renewed lease ${newLeaseId} (agreement ${agr.id}) — awaiting landlord review + send`)
  } catch (e) {
    await client.query('ROLLBACK')
    logger.error({ err: e }, '[LeaseRenewal][wt-addendum-autodraft]')
  } finally {
    client.release()
  }
}

esignRouter.get('/documents/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = d.landlord_id
      JOIN users lu ON lu.id = la.user_id
      WHERE d.id = $1`, [req.params.id])
    if (!doc) throw new AppError(404, 'Document not found')

    const isOwner = ownsLandlord(req.user!, doc.landlord_id)
    const isSigner = await queryOne<any>('SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND user_id=$2', [doc.id, req.user!.userId])
    if (!isOwner && !isSigner) throw new AppError(403, 'Not authorized for this document')

    // S654: never the token. This was SELECT *, so every signer's signing
    // token went to the owner and to every other signer — and a token is a
    // full stand-in for its signer (S629). Resident Y read the landlord row's
    // token and signed B's lease as the landlord; owner B read X's and signed
    // as X. No screen reads a token from here (a signer's own link comes from
    // GET /sign), so none is returned, not even the caller's own.
    //
    // Where and from what browser someone signed is the company's audit
    // trail: the owner sees it on every row, a co-signer only on their own.
    const signers = await query<any>(
      `SELECT id, document_id, user_id, role, name, email, phone, order_index, status,
              invite_sent, invite_sent_at, viewed_at, signed_at, signature_data,
              reminder_sent_at, reminder_count, declined_at, decline_reason, created_at,
              CASE WHEN $2::boolean OR user_id = $3 THEN ip_address END AS ip_address,
              CASE WHEN $2::boolean OR user_id = $3 THEN user_agent END AS user_agent
         FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`,
      [doc.id, isOwner, req.user!.userId])
    const fields  = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1 ORDER BY page, y', [doc.id])
    res.json({ success: true, data: { ...doc, signers, fields } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// SEND DOCUMENT
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/esign/documents/:id/remind — push a reminder by hand.
 *
 * S642 (Nic): "we need to send the lease out to people in progress. They all
 * timed out over the weekend. Is it worth adding a button on landlord side to
 * manually push?"
 *
 * Yes, and for a stronger reason than convenience. The automatic reminder has a
 * CEILING — five, then it stops — and that ceiling is right: a reminder that
 * arrives forever is not a reminder, and S639 fixed a loop that sent 74 emails
 * to one person in eight days. But a ceiling with no human override means the
 * platform's answer to "they still have not signed" is permanent silence. Nine
 * residents sat unreachable for five days because of exactly that.
 *
 * So the ceiling governs the CRON, and a person can always push. Pushing also
 * resets the counter, because somebody re-engaged by hand deserves the normal
 * follow-up again rather than staying muted forever.
 *
 * It emails the signer whose turn it actually is. A co-tenant waiting on the
 * primary is not chased ahead of turn — that is how a household gets two
 * contradictory asks in one day.
 */
esignRouter.post('/documents/:id/remind', requireAuth, requirePerm('esign.send'), async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.id, d.title, d.status, d.landlord_id, d.voided_at,
             u.unit_number, u.property_id, p.name AS property_name,
             COALESCE(NULLIF(la.business_name,''), lu.first_name||' '||lu.last_name) AS landlord_name
        FROM lease_documents d
        LEFT JOIN units u ON u.id = d.unit_id
        LEFT JOIN properties p ON p.id = u.property_id
        JOIN landlords la ON la.id = d.landlord_id
        JOIN users lu ON lu.id = la.user_id
       WHERE d.id = $1 AND d.landlord_id = ANY($2::uuid[])`,
      [req.params.id, landlordScopeIds(req.user!)])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'completed') throw new AppError(409, 'Everyone has already signed this.')
    if (doc.voided_at || doc.status === 'voided') throw new AppError(409, 'This document was voided.')

    // Whose turn it is: invited and not yet acted, lowest order first. A
    // 'pending' signer has not been reached yet and is waiting on somebody
    // ahead of them.
    const signer = await queryOne<any>(`
      SELECT id, user_id, name, email, token, role, reminder_sent_at
        FROM lease_document_signers
       WHERE document_id = $1 AND status IN ('sent','viewed')
       ORDER BY order_index LIMIT 1`, [req.params.id])
    if (!signer) throw new AppError(409, 'Nobody is waiting to sign right now.')

    // A person clicking twice must not mail twice. Not a ceiling — a debounce.
    if (signer.reminder_sent_at &&
        Date.now() - new Date(signer.reminder_sent_at).getTime() < 60 * 60 * 1000) {
      throw new AppError(429,
        `${signer.name} was reminded within the last hour. Give them a little time.`)
    }

    const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : doc.title
    // S654: only ever to the address on the signer's own account.
    const sendTo = await signerDeliveryAddress(signer)
    // S647: same one-link rule as the relay (services/tenantLeaseLink).
    let signingUrl = `${portalUrl('landlord')}/sign/${signer.token || doc.id}`
    let needsSetup = false
    if (signer.role !== 'landlord' && signer.role !== 'witness') {
      const { tenantLeaseLink } = await import('../services/tenantLeaseLink')
      const link = await tenantLeaseLink({
        userId: signer.user_id, documentId: doc.id, signerToken: signer.token, sendTo })
      signingUrl = link.url
      needsSetup = link.needsSetup
    }

    await emailSigningReminder(sendTo, signer.name, doc.title, unitLabel,
      doc.landlord_name, signingUrl, { landlordId: doc.landlord_id, documentId: doc.id, needsSetup,
        replyTo: await signerReplyTo(signer, doc.property_id) })

    await query(
      `UPDATE lease_document_signers
          SET reminder_count = 0, reminder_sent_at = NOW() WHERE id = $1`, [signer.id])

    res.json({ success: true, data: { sentTo: sendTo, name: signer.name } })
  } catch (e) { next(e) }
})

esignRouter.post('/documents/:id/send', requireAuth, requirePerm('esign.send'), async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, u.property_id, p.name as property_name, p.timezone AS property_timezone,
             lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1 AND d.landlord_id = ANY($2::uuid[])`, [req.params.id, landlordScopeIds(req.user!)])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'completed') throw new AppError(400, 'Document already completed')
    if (doc.status === 'voided')    throw new AppError(400, 'Document has been voided')
    if (doc.status === 'execution_failed') throw new AppError(400, 'Document execution failed - create a new document instead')

    // Fast-fail overlap pre-check before we start emailing anyone
    const { primary, coTenants } = await getDocumentTenantSigners(doc.id)
    if (primary && doc.unit_id) {
      // Try to infer proposed start/end from field defaults if available
      const vals = await query<any>(`
        SELECT lease_column, value FROM lease_document_fields
        WHERE document_id=$1 AND lease_column IN ('start_date','end_date') AND value IS NOT NULL`, [doc.id])
      const startVal = (vals as any[]).find(v => v.lease_column === 'start_date')?.value
      const endVal   = (vals as any[]).find(v => v.lease_column === 'end_date')?.value
      if (doc.document_type === 'original_lease') assertLeaseNotAlreadyOver(endVal, todayIn(doc.property_timezone))
      if (startVal) {
        const allTenantIds = [primary.tenantId, ...coTenants.map(c => c.tenantId)]
        // S535: '-' end date = month-to-month (no end date) — never cast it as a date.
        // S647: exclude this document's own lease for the same reason as the
        // sign path — after issuance the document has one, and re-sending it
        // must not read that as a conflict with itself.
        // S655: and, for a new lease of a household already living there, the
        // lease it follows (it ends the day before this one starts).
        let ov = await canTenantsSignNewLease(
          allTenantIds, doc.unit_id, startVal,
          endVal && endVal.trim() !== '-' ? endVal : null,
          [doc.lease_id, doc.renews_lease_id])
        // S655: another company's lease is the resident's to settle when they sign.
        if (!ov.ok && ov.crossCompany) {
          ov = await canTenantsSignNewLease(
            allTenantIds, doc.unit_id, startVal,
            endVal && endVal.trim() !== '-' ? endVal : null,
            [doc.lease_id, doc.renews_lease_id],
            { residentDecides: await residentsWhoSignFirst(doc.id, [primary, ...coTenants]) })
        }
        if (!ov.ok) throw new AppError(409, `Cannot send: ${ov.reason}`)
        // S655: the dates a new lease must make sense against the one it
        // follows — until the landlord has signed (after that the terms are
        // locked and the lease is issued; a re-send only re-mails it).
        const startIso = leaseFieldDate(startVal)
        if (doc.renews_lease_id && startIso && !doc.issued_at) {
          const { assertNewLeaseDates } = await import('../services/renewalSuccessor')
          await assertNewLeaseDates(async (sql, params) => ({ rows: await query<any>(sql, params) }),
            { renewsLeaseId: doc.renews_lease_id, startIso })
        }

        // ────────────────────────────────────────────────────────────────────
        // S622: SCREENING GATE (Business Terms §9.2).
        //
        // Nic: "after the onboarding window is closed, all applicants must
        // complete the background check to actually have the lease going."
        //
        // Enforced at SEND, not at finalize, on purpose: refusing after every
        // party has signed strands a signed lease and helps nobody. Here the
        // landlord simply cannot invite an unscreened applicant yet.
        //
        // MIGRATED TENANTS ARE EXEMPT. A tenancy that began before the landlord
        // joined GAM was formed off-Platform, and we do not retroactively
        // condition it on a report. The window is each landlord's OWN onboarding
        // date, so it stays correct for everyone who joins later rather than
        // hanging off a global cutoff that ages badly.
        //
        // Renewals are exempt too — renews_lease_id means an existing tenant,
        // who was either screened already or is themselves a migrated tenancy.
        // Read the flag as opt-OUT, not opt-in. This is a platform rule stated in
        // the Business Terms; the row exists so that DISABLING it is a deliberate,
        // recorded act. isFeatureEnabled() returns false for a missing row, which
        // would mean an unrun migration silently switches the rule off — the
        // failure mode we least want on a compliance gate. Absent row = ON.
        const flag = await queryOne<{ enabled: boolean }>(
          `SELECT enabled FROM system_features WHERE key = 'screening_required_for_new_leases'`)
        const gateOn = flag ? flag.enabled === true : true
        if (gateOn && doc.document_type === 'original_lease' && !doc.renews_lease_id) {
          const ll = await queryOne<{ created_at: string; migration_window_ends_at: string | null }>(
            `SELECT created_at, migration_window_ends_at FROM landlords WHERE id = $1`, [doc.landlord_id])
          // S654: calendar days, not instants. `new Date('2026-10-02')` is UTC
          // midnight — the evening before in Phoenix — so after 5 pm a lease
          // starting tomorrow read as starting before a landlord who joined
          // today, and slipped the screening gate as "migrated".
          const leaseStart = leaseFieldDate(startVal)
          const onboardedAt = ll ? new Date(ll.created_at) : null
          // S624: DERIVE the window when the column is null rather than treating
          // null as "open forever".
          //
          // That fail-open default is what let a signup bug become a compliance
          // hole: nothing set the column at signup, so every landlord created
          // after the S623 backfill was permanently inside their onboarding
          // window and never had to screen anybody. The gate looked correct and
          // caught nobody — the same failure mode the feature-flag default just
          // above this deliberately avoids ("absent row = ON").
          //
          // Deriving from created_at gives the identical answer the backfill
          // migration computed, so a missing column can never again mean a
          // missing rule.
          const windowEnds = ll?.migration_window_ends_at
            ? new Date(ll.migration_window_ends_at)
            : (onboardedAt
                ? new Date(onboardedAt.getTime() + MIGRATION_WINDOW_DAYS * 86400000)
                : null)

          // A tenancy counts as MIGRATED — and is exempt — on any of:
          //
          //  1. The onboarding window is still open. For a period after joining,
          //     a landlord is transcribing tenancies that already exist. This is
          //     the case the first cut got wrong: Oak Park onboarded 2026-08-14
          //     and is papering 30 sitting tenants with documents dated today.
          //     The tenancy is old even though the paperwork is new.
          //  2. The landlord marked that they already hold this tenant's deposit
          //     — an explicit assertion that the tenant was already living there,
          //     and it holds even after the window closes.
          //  3. The lease genuinely starts before the landlord joined GAM (on or
          //     before their join day — the old instant compare, start-of-day
          //     against the join moment, meant the same thing).
          const windowOpen = !windowEnds || new Date() < windowEnds
          const isMigrated =
            windowOpen ||
            doc.deposit_already_held === true ||
            (!!onboardedAt && !!leaseStart && leaseStart <= dateIn(doc.property_timezone, onboardedAt))
          if (!isMigrated) {
            // LEFT JOIN, deliberately: a signer with no tenants row certainly has
            // no background check either. An inner join would have let exactly
            // the least-established applicants through — the gate would have
            // looked correct and caught nobody.
            //
            // S655: only a check THIS account may rely on — one run for any of
            // its companies, or a renter-pool check: run through GAM's pool
            // intake (no company; the is_system pool account) with the
            // applicant's consent to share. Another company's approval never
            // counts, even with its share box ticked: each company's
            // screening decision is its own. Same rule as pooledCheckSql()
            // in services/onboardingWindow.ts.
            const unscreened = await query<{ name: string }>(
              `SELECT s.name
                 FROM lease_document_signers s
                 LEFT JOIN tenants t ON t.user_id = s.user_id
                WHERE s.document_id = $1
                  AND s.role <> 'landlord' AND s.role <> 'witness'
                  AND NOT EXISTS (
                    SELECT 1 FROM background_checks bc
                     WHERE bc.tenant_id = t.id
                       AND bc.status IN ('approved', 'completed', 'clear')
                       AND ((bc.consent_pool = true
                             AND (bc.landlord_id IS NULL
                                  OR bc.landlord_id IN (SELECT pl.id FROM landlords pl WHERE pl.is_system = true)))
                            OR bc.landlord_id IN (SELECT public.account_companies($2::uuid)))
                  )`, [doc.id, doc.landlord_id])
            if (unscreened.length > 0) {
              const who = unscreened.map(u => u.name).join(', ')
              // S654: the landlord's window is account-level — name its day on
              // GAM's home calendar, not the UTC one (a 6 pm signup read a day late).
              const closed = windowEnds ? dateIn(null, windowEnds) : 'your onboarding'
              throw new AppError(409,
                `Cannot send: ${who} ${unscreened.length === 1 ? 'has' : 'have'} not completed a background check. ` +
                `Your onboarding migration window closed on ${closed}, so new applicants must be screened before ` +
                `a lease is sent (Business Terms §9.2). If this tenant was already living in the unit, mark that ` +
                `you already hold their deposit on the send form and they are treated as an existing tenancy.`)
            }
          }
        }
      }
    }

    const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index', [doc.id])

    // ────────────────────────────────────────────────────────────────────────
    // S28: Landlord-first signer check — LEASE documents only.
    // Landlord fills the writable/fee/utility values during template completion
    // and signs first to lock the inputs. Tenants then sign accepting those
    // values. If a tenant signed first, they would either sign blank fields
    // or the landlord could alter values after acceptance — both unacceptable.
    // S568: standalone documents (purchase agreements, contracts) have no
    // landlord party + no lease-value fields, so this ordering rule does not
    // apply — they sign in whatever order the creator set.
    // ────────────────────────────────────────────────────────────────────────
    const isStandaloneDoc = (STANDALONE_DOCUMENT_TYPES as readonly string[]).includes(doc.document_type)
    if (!isStandaloneDoc) {
      const sortedSigners = [...(signers as any[])].sort(
        (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)
      )
      const firstByOrder = sortedSigners[0]
      if (!firstByOrder) throw new AppError(400, 'No signers configured')
      if (firstByOrder.role !== 'landlord') {
        throw new AppError(
          400,
          'Landlord must be the first signer. Reorder signers so the landlord signs first.'
        )
      }
      // S535 (Nic): a tied order_index would let a tenant sign in parallel
      // with the landlord — the landlord's slot must be strictly first.
      const tenantAtOrBeforeLandlord = sortedSigners.some(
        (sg: any) => sg.role !== 'landlord' && (sg.order_index ?? 0) <= (firstByOrder.order_index ?? 0)
      )
      if (tenantAtOrBeforeLandlord) {
        throw new AppError(400, 'The landlord must sign before all other signers — no signer may share the landlord\'s signing position.')
      }
    } else if (signers.length === 0) {
      throw new AppError(400, 'No signers configured')
    }

    // ────────────────────────────────────────────────────────────────────────
    // S28 → S535: tagged value-bearing fields must be filled before the
    // TENANT sees the document — but the landlord signs FIRST and types
    // terms INTO the doc (lease-is-law), so landlord-role tagged fields
    // may legitimately be empty at send (e.g. a cross-template renewal
    // binding a field the predecessor can't derive). Those are enforced
    // at the landlord's sign submit instead (POST /sign). Non-landlord
    // tagged fields still must arrive filled here.
    // ────────────────────────────────────────────────────────────────────────
    const fieldRows = await query<{ lease_column: LeaseColumn | null; value: string | null; signer_role: string | null }>(
      'SELECT lease_column, value, signer_role FROM lease_document_fields WHERE document_id=$1',
      [doc.id]
    )
    const violations = validateLeaseDocumentForSend(
      (fieldRows as any[]).filter(r => r.signer_role !== 'landlord') as any)
    if (violations.length > 0) {
      const labels = violations.map(v => LEASE_COLUMN_LABEL[v.lease_column])
      throw new AppError(
        400,
        `Cannot send: ${violations.length} tagged field(s) need values: ${labels.join(', ')}`
      )
    }

    const firstSigner = (signers as any[]).find(s => s.order_index === 1) || (signers as any[])[0]
    if (!firstSigner) throw new AppError(400, 'No signers configured')

    const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : (doc.title || 'GAM Document')

    // Branch signing URL: unactivated tenants land on /accept-invite first, then get redirected to /sign
    // S410 (S377): read tenant_invite_token (was email_verify_token).
    const firstSignerUser = await queryOne<any>('SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [firstSigner.user_id])
    const signingUrl = signingUrlFor(firstSigner, doc.id, firstSignerUser)
    // S654: a standalone document can open with a resident or another party —
    // they are reached only at the address on their own account.
    const firstSignerAddress = await signerDeliveryAddress(firstSigner)

    await emailSigningRequest(firstSignerAddress, firstSigner.name, doc.title, unitLabel, doc.landlord_name, signingUrl,
      { landlordId: doc.landlord_id, documentId: doc.id, replyTo: await signerReplyTo(firstSigner, doc.property_id) })
    await createNotification({
      userId: firstSigner.user_id,
      type: 'esign_request',
      title: 'Document ready to sign',
      body: `${doc.landlord_name} sent you "${doc.title}" for ${unitLabel}.`,
      data: { documentId: doc.id },
      sendEmail: false
    })

    await query("UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])
    await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1", [firstSigner.id])

    // ── S651: WHO SENT THIS LEASE OUT, AND WHEN ─────────────────────────────
    //
    // Sending a lease for signature wrote no audit row at all. A legal document
    // went to a real person and nothing recorded who caused it — which means
    // the only account of it is whoever happens to remember.
    //
    // Found because I did exactly that: signed in as a landlord to send his own
    // leases, and then could not prove from the system what I had touched.
    //
    // Nic, on why it matters beyond that: "when I authorize you to do something
    // like this on behalf of a landlord down the road — I had permission from
    // him because we're friends. Another landlord may not grant me that
    // permission, or I may need to talk to them first. And I want a record of
    // when that happened, so we can corroborate emails or phone calls to the
    // time that something actually happened."
    //
    // So this records the acting account, the document, who it went to and the
    // IP — enough to line up against a phone log or an email thread months
    // later. Best-effort: a failed audit write must never stop a lease going
    // out, and the send has already happened by this line.
    await query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, ip_address)
       VALUES ($1, 'document.sent_for_signature', 'lease_document', $2, $3::jsonb, $4)`,
      [req.user!.userId, doc.id,
       JSON.stringify({
         title: doc.title,
         landlordId: doc.landlord_id,
         documentType: doc.document_type,
         sentTo: firstSignerAddress,
         sentToRole: firstSigner.role,
         sentToName: firstSigner.name,
         actingRole: req.user!.role,
         actingEmail: req.user!.email ?? null,
       }),
       (req.ip ?? '').slice(0, 64) || null]).catch(() => {})

    res.json({ success: true, data: { sentTo: firstSignerAddress } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// VOID
// ─────────────────────────────────────────────────────────────

esignRouter.post('/documents/:id/void', requireAuth, requirePerm('esign.void'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { reason } = req.body

    await client.query('BEGIN')

    const doc = await client.query(
      'SELECT * FROM lease_documents WHERE id=$1 AND landlord_id = ANY($2::uuid[])',
      [req.params.id, landlordScopeIds(req.user!)]
    ).then((r: any) => r.rows[0])
    if (!doc) throw new AppError(404, 'Document not found')

    // S655: a NEW LEASE for a household already living there — the refusals
    // live in newLeaseCancelRefusal, the same test the new-lease window reads
    // (renewal-context can_cancel), so the window never offers a cancel this
    // route would refuse.
    if (doc.renews_lease_id) {
      const refusal = await newLeaseCancelRefusal(client.query.bind(client), doc)
      if (refusal) throw new AppError(409, refusal)
    }

    // S29 item 6 / S558 / S581 / S647 / S652: every step of a void lives in
    // lib/voidDocument, so a script clearing a packet runs the same ones. Read
    // that file for why each exists — including the one that was missing.
    const { voidDocument } = await import('../lib/voidDocument')
    await voidDocument(client.query.bind(client), doc, reason || null)

    await client.query('COMMIT')
    res.json({ success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────
// SIGNING
// ─────────────────────────────────────────────────────────────


/**
 * S629 (Nic): "I need to be able to sign from clicking a link in the email,
 * because that is how other people are gonna also sign. Nobody's gonna log in
 * and see 'oh, I've gotta sign my lease now.'"
 *
 * The signing link was hard-coded to the TENANT app for every signer — but the
 * first signer on a lease is the LANDLORD, so the landlord was emailed a link
 * into the tenant portal, which their account cannot sign in. LANDLORD_APP_URL
 * has existed all along and was never used here.
 *
 * A tenant who has not activated yet still lands on /accept-invite first and is
 * carried through to the document afterwards — signing is the reason they were
 * invited, so it should not dead-end at a password screen.
 */
/**
 * S629 (Nic): "why the hell would I log in, open the lease for unit 24 and press
 * send? It needs to be auto sent."
 *
 * He is right — the decision was made when he invited the household. A drafted
 * lease that waits for a button is a step that exists for nobody: the landlord
 * has to notice a notification, find the document, and press Send before the
 * email chain that does the actual work can start.
 *
 * This is the send route's body, minus the HTTP: mark the document sent, mark
 * the first signer invited, and email them their link. Everything after that is
 * unchanged — each signature emails the next signer in turn.
 *
 * Best-effort by contract: it returns false rather than throwing, because it
 * runs inside the tenant's accept transaction. A lease that drafted but failed
 * to send must still exist and still be sendable by hand; losing the draft
 * because an email bounced would be worse than the button it replaces.
 */
export async function autoSendDraftedDocument(
  documentId: string,
  // S647: a draft made the moment the landlord clicks Invite does not need an
  // email telling that same landlord to sign it — they are looking at the
  // "Waiting on you to sign" list it just joined. Worse, a household invited one
  // person at a time redrafts as each member is added, so emailing on every
  // draft sends a signing link for copies that get voided seconds later. The
  // S620 reason for the email — the tenant accepted while the landlord was out —
  // still holds on the ACCEPT path, which keeps the default.
  // S655: the park-wide new-lease sender drafts one per household and sends the
  // landlord ONE notification for the lot (one per draft put forty in the bell
  // while they were already signing them).
  opts: { emailFirstSigner?: boolean; notifyFirstSigner?: boolean } = {},
): Promise<boolean> {
  const emailFirstSigner = opts.emailFirstSigner !== false
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name AS property_name,
             TRIM(COALESCE(lu.first_name,'') || ' ' || COALESCE(lu.last_name,'')) AS landlord_name
        FROM lease_documents d
        LEFT JOIN units u ON u.id = d.unit_id
        LEFT JOIN properties p ON p.id = u.property_id
        LEFT JOIN landlords l ON l.id = d.landlord_id
        LEFT JOIN users lu ON lu.id = l.user_id
       WHERE d.id = $1`, [documentId])
    if (!doc || doc.status !== 'pending') return false

    const signers = await query<any>(
      `SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [documentId])
    const firstSigner = signers.find(s => s.order_index === 1) || signers[0]
    if (!firstSigner) return false

    // The landlord-first rule the send route enforces. If a draft somehow comes
    // out mis-ordered it stays pending for a human rather than going out wrong.
    if (firstSigner.role !== 'landlord') {
      logger.warn({ documentId, firstRole: firstSigner.role },
        '[esign] auto-send skipped — landlord is not the first signer')
      return false
    }

    const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : (doc.title || 'GAM Document')
    const signerUser = await queryOne<any>(
      'SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [firstSigner.user_id])
    const url = signingUrlFor(firstSigner, doc.id, signerUser)

    if (emailFirstSigner) {
      await emailSigningRequest(firstSigner.email, firstSigner.name, doc.title, unitLabel,
        doc.landlord_name, url, { landlordId: doc.landlord_id, documentId: doc.id })
    }
    if (opts.notifyFirstSigner !== false) {
      await createNotification({
        userId: firstSigner.user_id,
        type: 'esign_request',
        title: 'Document ready to sign',
        body: `${doc.landlord_name} sent you "${doc.title}" for ${unitLabel}.`,
        data: { documentId: doc.id },
        actionUrl: '/esign',
      }).catch(() => {})
    }
    await query("UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])
    await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1",
      [firstSigner.id])
    logger.info({ documentId, to: firstSigner.email }, '[esign] drafted lease auto-sent to the first signer')
    return true
  } catch (e) {
    logger.error({ err: e, documentId }, '[esign] auto-send failed — the draft stays pending and can be sent by hand')
    return false
  }
}

export function signingUrlFor(signer: { role: string; token?: string | null }, documentId: string,
                       user: { email_verified?: boolean; tenant_invite_token?: string | null } | null): string {
  // S629: the TOKEN, not the document id — that is what makes the link work
  // without a login. Falls back to the document id only if a signer somehow has
  // no token, where the recipient at least reaches the document after signing in.
  const ref = signer.token || documentId
  if (signer.role === 'landlord' || signer.role === 'witness') {
    return `${LANDLORD_APP_URL}/sign/${ref}`
  }
  // An unactivated tenant can now sign straight from the link too: the signing
  // token is their identity for this document, so there is no reason to make
  // them set a password before they can read what they are signing.
  return `${TENANT_APP_URL}/sign/${ref}`
}


/**
 * S629 (Nic): "the link in the email is not to the correct thing — it just has
 * me sign in to the landlord portal. The signing should almost be outside of
 * logging in. When I click the link in the email it needs to take me right to
 * select my font, my initials, and sign it."
 *
 * He is describing how every e-sign product works, and the schema was built for
 * it: lease_document_signers.token is a 64-hex secret, UNIQUE, with its own
 * index. No route ever used it — every signing route required a session, so an
 * emailed link landed on a login page.
 *
 * The token IS the identity for these three routes. It arrives in the path
 * where a document id would, and is told apart by shape (64 hex versus a UUID),
 * so the handlers below are untouched: they look a signer up by
 * (document_id, user_id) and this supplies both.
 *
 * Safe because these handlers use req.user for exactly two things — that signer
 * lookup and a platform-block check, both keyed on the user id. There is no
 * permission or landlord-scope check to widen. The token grants ONE signer
 * access to ONE document, which is precisely what was emailed to them.
 */
const SIGNER_TOKEN_RE = /^[a-f0-9]{64}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function authOrSignerToken(req: any, res: any, next: any) {
  const supplied = String(req.params.documentId || '')
  // S637: the path segment is either a document UUID or a 64-hex signer token.
  // Anything else went straight through to a uuid-typed query and came back a
  // 500 — "invalid input syntax for type uuid". Eleven of those in one evening,
  // every one of them the literal string "undefined", from a Review & Sign
  // button reading a field its endpoint does not return. The frontend bug is
  // fixed; this makes the shape unreachable rather than merely unused, and a
  // malformed link now says so instead of looking like the server fell over.
  if (!SIGNER_TOKEN_RE.test(supplied) && !UUID_RE.test(supplied)) {
    return res.status(404).json({ success: false, error: 'That signing link is not valid.' })
  }
  if (!SIGNER_TOKEN_RE.test(supplied)) return requireAuth(req, res, next)
  try {
    let signer = await queryOne<any>(
      `SELECT s.*, d.status AS doc_status, d.package_group_id, d.package_sort_order FROM lease_document_signers s
         JOIN lease_documents d ON d.id = s.document_id
        WHERE s.token = $1`, [supplied])
    if (!signer) return res.status(404).json({ success: false, error: 'That signing link is not valid.' })
    if (signer.doc_status === 'voided') {
      // S652 (Nic, Blu): a document re-drafted from an updated template keeps
      // its place in the packet; an old link to it is not dead, it is out of
      // date. Forward to the replacement — same packet, same slot, same
      // signer — so an email from this morning still opens this afternoon's
      // copy. Only a document with no replacement is truly gone.
      const replacement = signer.package_group_id ? await queryOne<any>(
        `SELECT s.*, d.status AS doc_status FROM lease_documents d
           JOIN lease_document_signers s ON s.document_id = d.id AND s.user_id = $3
          WHERE d.package_group_id = $1 AND d.package_sort_order = $2
            AND d.status <> 'voided' AND d.voided_at IS NULL
          ORDER BY d.created_at DESC LIMIT 1`,
        [signer.package_group_id, signer.package_sort_order ?? 0, signer.user_id]) : null
      if (!replacement) {
        return res.status(410).json({ success: false, error: 'This document was voided and can no longer be signed.' })
      }
      signer = replacement
    }
    req.params.documentId = signer.document_id
    req.user = { userId: signer.user_id, role: 'signer', email: signer.email, profileId: null }
    req.signerToken = supplied
    return next()
  } catch (e) { return next(e) }
}

esignRouter.get('/sign/:documentId', authOrSignerToken, async (req, res, next) => {
  try {
    const signer = await queryOne<any>(`
      SELECT * FROM lease_document_signers
      WHERE document_id=$1 AND user_id=$2`,
      [req.params.documentId, req.user!.userId])
    if (!signer) throw new AppError(403, 'You are not a signer on this document')

    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, p.state as property_state,
             p.landlord_id as property_landlord_id, p.timezone AS property_timezone,
             lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    if (!doc) throw new AppError(404, 'Document not found')

    // S235: read-only re-open. Pre-S235 the GET threw on terminal states
    // (signed / completed / voided / execution_failed), so a tenant who'd
    // signed could never re-open the doc to see what they'd agreed to.
    // Now the route serves a read-only payload for those states, with
    // all-roles fields (so the user sees the full executed state, not
    // just their own role's slots) and the executed_pdf_url when ready.
    const docTerminal =
      doc.status === 'completed' || doc.status === 'voided' || doc.status === 'execution_failed'
    const signerTerminal = signer.status === 'signed' || signer.status === 'declined'

    // ── S637 (Nic, DIRECTIVE): YOU CANNOT FILL IN A DOCUMENT THAT ISN'T YOURS YET ──
    //
    //   "I've had multiple people today tell me they signed the lease, and I
    //    know they didn't... it's letting them fill it all out, but they just
    //    can't complete it for signature until after I do. Completion is the
    //    only thing gated on a signing order, not actually receiving the email."
    //
    // He is right about the symptom and half right about the cause. The EMAILS
    // are strictly sequential — the relay only invites the next signer once the
    // previous one signs, and the data bears that out. What was not gated is
    // this READ: any signer holding a link or reaching the document from their
    // portal got a fully fillable page whether or not it was their turn, and
    // only the submit refused them. So they filled everything in, hit a wall at
    // the end, and told Nic they had signed.
    //
    // Same two rules the submit enforces (S535), applied here: an earlier
    // order_index still unsigned, or any unsigned landlord on a tenant's view.
    // Not a new restriction — it is the existing restriction, made visible
    // before someone wastes their time instead of after.
    //
    // S655, the same idea for a NEW LEASE whose lease before it ENDED EARLY
    // while nobody in the household had signed it: the submit refuses every
    // tenant signature on it (it is being canceled — renewalSuccessor
    // .followsLeaseEndedEarlyUnsigned), so someone opening an old emailed link
    // reads it, with that reason in the same words, instead of filling it all
    // in and being refused at the end. `closedReason` says why; it wins over
    // `waitingOn` — no turn is coming.
    let closedReason: string | null = null
    if (!docTerminal && !signerTerminal && doc.renews_lease_id && doc.lease_id && isTenantRole(signer.role)) {
      const { followsLeaseEndedEarlyUnsigned, NEW_LEASE_AFTER_EARLY_END_CANNOT_SIGN } =
        await import('../services/renewalSuccessor')
      const gone = await queryOne(
        `SELECT 1 FROM leases nl WHERE nl.id = $1 AND ${followsLeaseEndedEarlyUnsigned('nl')}`, [doc.lease_id])
      if (gone) closedReason = NEW_LEASE_AFTER_EARLY_END_CANNOT_SIGN
    }
    let waitingOn: string | null = null
    if (!docTerminal && !signerTerminal && !closedReason) {
      const blocker = await queryOne<{ name: string; role: string }>(
        `SELECT name, role FROM lease_document_signers
          WHERE document_id = $1 AND status != 'signed'
            AND (order_index < $2 OR (role = 'landlord' AND $3::boolean))
          ORDER BY order_index LIMIT 1`,
        [doc.id, signer.order_index, isTenantRole(signer.role)])
      if (blocker) waitingOn = blocker.role === 'landlord' ? 'the landlord' : blocker.name
    }
    const readOnly = docTerminal || signerTerminal || waitingOn !== null || closedReason !== null

    // S636 (Nic): THE SIGNER SEES THE WHOLE DOCUMENT, not just their own slots.
    //
    // This returned ONLY the current signer's fields, so a tenant received none
    // of the landlord's boxes — and every value the landlord had filled in
    // rendered as an empty blank on the page they were about to sign. Nic: "They
    // can't see what the rent is. They can't see what the guest fee is... the
    // whole point of the landlord signing it first is so that the tenant can see
    // what they're signing."
    //
    // Everyone now gets every field. `mine` says which ones this signer may
    // fill; the rest are theirs to READ. That is not a new trust boundary — the
    // sign submit has always written `AND signer_role = <caller's role>`, so a
    // value outside your own role silently no-ops however it is posted.
    const fields = await query<any>(
      `SELECT * FROM lease_document_fields WHERE document_id=$1 ORDER BY page, y`,
      [doc.id])
    for (const f of fields as any[]) {
      f.mine = readOnly ? false : (f.signer_role === signer.role)
    }

    // S535: value-bearing tagged fields (writable / fee_row / utility_row)
    // are ALWAYS required for the landlord's pass — the sign submit
    // enforces completeness regardless of the template's required flag,
    // so the UI counter and Next Field must agree ("N/A" / "0" are valid
    // entries for fields that don't apply). Presentation-level only.
    if (!readOnly && signer.role === 'landlord') {
      for (const f of fields as any[]) {
        if (f.lease_column
            && LEASE_COLUMN_VALUE_BEARING_CATEGORIES.includes(LEASE_COLUMN_CATEGORY[f.lease_column as LeaseColumn])) {
          f.required = true
        }
      }
    }

    // S637: stamp the view even when it is not yet their turn — they really did
    // open it, and that is worth knowing. Only a terminal state suppresses it.
    if (!docTerminal && !signerTerminal && signer.status === 'sent') {
      await query("UPDATE lease_document_signers SET status='viewed', viewed_at=NOW() WHERE id=$1", [signer.id])
    }

    // S194: deposit-interest context for the signer. When this is an
    // original_lease or addendum_terms document at a property in a
    // state with a statutory rate (or per-landlord override), surface
    // the rate so the tenant knows up-front what interest their deposit
    // will accrue. Skipped for documents at properties without a rate
    // (most states have no statute) or document types where deposit
    // terms don't apply (addendum_add / addendum_remove are tenant-
    // roster changes, not term changes).
    let deposit_interest_context: any = null
    const showsDepositTerms = doc.document_type === 'original_lease' || doc.document_type === 'addendum_terms'
    if (showsDepositTerms && doc.property_state) {
      // S654: the rate year in effect where the PROPERTY is — the UTC year
      // turned over at 5 pm Phoenix on December 31.
      const currentYear = Number(todayIn(doc.property_timezone).slice(0, 4))
      const statutory = await queryOne<{
        annual_rate_pct:  string
        statute_citation: string
      }>(
        `SELECT annual_rate_pct::text AS annual_rate_pct, statute_citation
           FROM state_deposit_interest_rates
          WHERE state_code = $1 AND effective_year = $2
          LIMIT 1`,
        [doc.property_state, currentYear],
      )
      if (statutory) {
        deposit_interest_context = {
          source:           'statutory',
          state_code:       doc.property_state,
          effective_year:   currentYear,
          annual_rate_pct:  statutory.annual_rate_pct,
          statute_citation: statutory.statute_citation,
        }
      } else if (doc.property_landlord_id) {
        // Fall through to landlord override.
        const override = await queryOne<{
          annual_rate_pct: string
          source_notes:    string | null
        }>(
          `SELECT annual_rate_pct::text AS annual_rate_pct, source_notes
             FROM landlord_deposit_interest_rate_overrides
            WHERE landlord_id = $1 AND state_code = $2 AND effective_year = $3
            LIMIT 1`,
          [doc.property_landlord_id, doc.property_state, currentYear],
        )
        if (override) {
          deposit_interest_context = {
            source:           'landlord_override',
            state_code:       doc.property_state,
            effective_year:   currentYear,
            annual_rate_pct:  override.annual_rate_pct,
            statute_citation: null,
            source_notes:     override.source_notes,
          }
        }
      }
    }

    // S534: on a renewal doc, tell the signing UI what deposit is
    // already held so the deposit field shows the double-count overlay
    // (equal carries · higher bills only the difference · lower needs a
    // manual partial return).
    let carried_deposit: number | null = null
    let carried_rent: number | null = null
    if (doc.renews_lease_id) {
      // Scoped to the security_deposit fee_type — the overlay sits on
      // that field and the delta guard compares per type (S535).
      const cd = await queryOne<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM lease_fees
          WHERE lease_id=$1 AND fee_type='security_deposit'
            AND due_timing='move_in' AND is_refundable=TRUE`,
        [doc.renews_lease_id])
      carried_deposit = Number(cd?.total || 0)
      // S535: the predecessor's rent powers the increase presets
      // (+3/5/10%, flat $) on the rent field in the signing pass.
      const cr = await queryOne<{ rent_amount: string }>(
        `SELECT rent_amount::text AS rent_amount FROM leases WHERE id=$1`,
        [doc.renews_lease_id])
      carried_rent = Number(cr?.rent_amount || 0)
    }

    // S655: A NEW LEASE'S FIRST BILL, worked out here, for both signing pages.
    // The tenant usually opens the emailed link with no session, and the page
    // could not read the current lease to say when the new rent starts — so it
    // stated a rule instead of the date. The facts come from the server now:
    // the current lease's end and due day (a month-to-month has no end until the
    // new lease starts; it then ends the day before), the terms on this
    // document, the sentence the bill run's own arithmetic produces, and each
    // money box's tag (deposit / prepaid / fee) so the landlord's page bills
    // only a deposit INCREASE exactly as the server will.
    let renewal_billing: any = null
    if (doc.renews_lease_id) {
      const prev = await queryOne<{ end_date: string | null; rent_due_day: number | null; rent_amount: string; status: string }>(
        `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date, rent_due_day, rent_amount::text AS rent_amount, status
           FROM leases WHERE id = $1`, [doc.renews_lease_id])
      // The current lease's last day. While it is in force that is ALWAYS the
      // day before the new start, whatever its printed end — a month-to-month
      // ends then, and a signed term that runs out sooner holds over at its old
      // rent until then (decisions 10/2 #7: never a gap). So it is sent as null
      // — "the day before whatever start is typed" — because the landlord's page
      // works the bill out again as the start box changes. A lease already over
      // keeps its real last day.
      const prevLastDay = prev && prev.status !== 'active' ? prev.end_date : null
      const valueOf = (col: string): string | null => {
        const f = (fields as any[]).find(x => x.lease_column === col && x.value != null && String(x.value).trim() !== '')
        return f ? String(f.value) : null
      }
      const startIso = leaseFieldDate(valueOf('start_date'))
      const rentNum = Number(String(valueOf('rent_amount') ?? '').replace(/[$,\s]/g, ''))
      const prevDay = prev?.rent_due_day != null ? Number(prev.rent_due_day) : null
      const newDay = parseDueDay(valueOf('rent_due_day')) ?? prevDay ?? 1
      // A list, not a map: the wire camelizes object KEYS, and these keys are
      // lease column names the page matches exactly.
      const kinds = doc.template_id
        ? await query<{ lease_column: string; money_kind: string }>(
            `SELECT DISTINCT lease_column, money_kind FROM lease_template_fields
              WHERE template_id = $1 AND money_kind IS NOT NULL AND lease_column IS NOT NULL`, [doc.template_id])
        : []
      let summary: string | null = null
      if (startIso && rentNum > 0) {
        const sched = renewalSchedule({
          oldEnd: prevLastDay, oldDueDay: prevDay ?? newDay,
          newStart: startIso, newDueDay: newDay, rent: rentNum,
        })
        summary = renewalBillingSummary(sched, rentNum, newDay)
      }
      // Every deposit-type box the current lease already holds, by type: page 8
      // bills only an INCREASE over these.
      const carriedDeposits = await query<{ fee_type: string; amount: string }>(
        `SELECT fee_type, SUM(amount)::text AS amount FROM lease_fees
          WHERE lease_id = $1 AND due_timing = 'move_in' AND is_refundable = TRUE
          GROUP BY fee_type`, [doc.renews_lease_id])
      renewal_billing = {
        carried_deposits: carriedDeposits.map(r => ({ fee_type: r.fee_type, amount: Number(r.amount) })),
        previous_end_date: prevLastDay,
        previous_due_day: prevDay,
        previous_rent: prev ? Number(prev.rent_amount) : null,
        start_date: startIso,
        // Its start date has come (by the property's calendar): it is the
        // household's lease now, so the page says so instead of "nothing
        // changes before then".
        started: !!startIso && startIso <= todayIn(doc.property_timezone),
        rent: rentNum > 0 ? rentNum : null,
        due_day: newDay,
        summary,
        box_money_kinds: kinds,
      }
    }

    // S535: property late-fee POLICY for the signing UI — when set, the
    // doc's late-fee fields render locked (uniform terms per property,
    // fair-housing) and clicking one explains the policy + the exact
    // day the fee starts given this lease's due day and grace period.
    let property_late_fee: any = null
    if (doc.unit_id) {
      // S535: per-(property, unit type) resolution — no property default.
      // When no policy row exists for this class, return a none-marker so
      // the signing UI still locks the fields and explains the absence.
      property_late_fee = await resolveLateFeePolicyForUnit(doc.unit_id)
      if (!property_late_fee) {
        const u = await queryOne<any>(
          `SELECT u.unit_type, p.name AS property_name
             FROM units u JOIN properties p ON p.id = u.property_id
            WHERE u.id = $1`, [doc.unit_id])
        if (u) property_late_fee = { none: true, unit_type: u.unit_type, property_name: u.property_name }
      }
    }

    // S637: `waitingOn` names who the document is with, so the page can say
    // "waiting on the landlord" instead of showing a form that cannot be
    // submitted. readOnly already covers the mechanics; this covers the telling.
    // S641: the other documents in this bundle, so the signer sees "2 of 4" and
    // one ceremony rather than a series of unrelated requests arriving days
    // apart. Nic: "a lot of people are gonna be like, well, I already signed the
    // lease, what's this for?"
    const packageDocs = doc.package_group_id ? await packageSiblings(doc.id, signer.user_id) : []

    // S648: page 8 locks differently for an onboarding resident.
    const { isExistingTenancyDocument } = await import('../services/moveInBoxes')
    const existing_tenancy = doc.document_type === 'original_lease'
      ? await isExistingTenancyDocument({ query: async (t: string, v: any[]) => ({ rows: await query<any>(t, v) }) }, doc.id)
      : false
    // S648: how this property sets due days, so the page can follow the start date.
    const rent_due_mode = doc.unit_id
      ? (await queryOne<{ m: string }>(
          `SELECT p.rent_due_mode AS m FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
          [doc.unit_id]))?.m ?? 'fixed_day'
      : 'fixed_day'
    res.json({ success: true, data: { signer, document: doc, fields, deposit_interest_context, carried_deposit, carried_rent, renewal_billing, property_late_fee, existing_tenancy, rent_due_mode, readOnly, waitingOn, closedReason, packageDocs } })
  } catch (e) { next(e) }
})

esignRouter.post('/sign/:documentId', authOrSignerToken, async (req, res, next) => {
  const client = await getClient()
  let txnDone = false
  try {
    const { fieldValues } = req.body

    await client.query('BEGIN')

    // Phase A: pre-validation reads (inside txn for read-your-writes consistency)
    const signerRes = await client.query(
      `SELECT * FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`,
      [req.params.documentId, req.user!.userId])
    const signer = signerRes.rows[0]
    if (!signer) throw new AppError(403, 'You are not a signer on this document')
    if (signer.status === 'signed') throw new AppError(400, 'Already signed')

    // S535: hard turn enforcement. Order was previously enforced only by
    // the invite relay (next signer emailed after the previous one signs)
    // — the submit route itself never checked, so a signer who knew the
    // documentId could sign out of order via the API and (worst case) a
    // tenant could accept a lease whose landlord-typed terms weren't
    // locked in yet (the exact S28 landlord-first failure mode).
    const priorUnsigned = await client.query(
      `SELECT 1 FROM lease_document_signers
        WHERE document_id=$1 AND order_index < $2 AND status != 'signed'
        LIMIT 1`,
      [signer.document_id, signer.order_index])
    if (priorUnsigned.rows.length > 0) {
      throw new AppError(403, 'Not your turn to sign yet — an earlier signer has not completed')
    }

    // S535 (Nic): a tenant NEVER signs before the landlord — blanket rule
    // on top of the order_index turn check above, which a tied
    // order_index could slip past. Any unsigned landlord-role signer on
    // the document blocks every tenant-role signature. Sublease
    // agreements are naturally unaffected (no landlord signer row).
    if (isTenantRole(signer.role)) {
      const unsignedLandlord = await client.query(
        `SELECT 1 FROM lease_document_signers
          WHERE document_id=$1 AND role='landlord' AND status != 'signed'
          LIMIT 1`,
        [signer.document_id])
      if (unsignedLandlord.rows.length > 0) {
        throw new AppError(403, 'The landlord signs first — you will be notified when the document is ready for your signature')
      }
    }

    // Platform block check on tenant roles. checkPlatformBlock uses the
    // non-transactional query() — acceptable because tenant.platform_status
    // is set by separate flows and the read-after-write race is benign here.
    if (isTenantRole(signer.role)) {
      const blk = await checkPlatformBlock(req.user!.userId)
      if (!blk.ok) throw new AppError(403, blk.reason || 'Account blocked from signing')
    }

    const docRes = await client.query(`
      SELECT d.*, u.unit_number, u.unit_type, u.property_id, p.name as property_name, p.timezone AS property_timezone,
        lu.first_name || ' ' || lu.last_name as landlord_name, lu.email as landlord_email
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    const doc = docRes.rows[0]
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'voided') throw new AppError(400, 'Document has been voided')
    if (doc.status === 'execution_failed') throw new AppError(400, 'Document execution failed - contact your landlord')

    // S655: a NEW LEASE whose lease before it ENDED EARLY while nobody in the
    // household had signed it: nobody is staying on to take it up, it never
    // starts, and it is being canceled (scheduler.processNewLeaseSignings). A
    // signature now — from the emailed link, in the minutes before the cancel,
    // or while money paid on it holds the cancel — would make it stand
    // (someoneSignedNewLease) and bill a household that has gone.
    if (doc.renews_lease_id && doc.lease_id && isTenantRole(signer.role)) {
      const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
      const gone = (await client.query(
        `SELECT 1 FROM leases nl WHERE nl.id = $1 AND ${followsLeaseEndedEarlyUnsigned('nl')}`, [doc.lease_id])).rows[0]
      if (gone) {
        throw new AppError(409,
          'The lease this new lease was to follow has ended, so it can no longer be signed — it is being canceled. ' +
          'If you meant to stay, contact the office.')
      }
    }

    // Re-check overlap on EVERY signing (another roommate may have taken a conflicting lease
    // between send time and now). Helpers below use non-transactional query() —
    // same pattern as platform block, acceptable race window.
    //
    // S647: EXCLUDE THIS DOCUMENT'S OWN LEASE. Since the landlord's signature
    // issues the lease, by the time the tenant signs there IS an active lease
    // on this unit for these people — the one they are about to sign. Without
    // the exclusion this guard reads that as a double-booking and refuses the
    // tenant their own signature, which is how issuance quietly became "the
    // tenant can never execute anything.
    const { primary, coTenants } = await getDocumentTenantSigners(doc.id)
    if (primary && doc.unit_id) {
      // Check the dates being SIGNED, not only the ones already saved. The
      // landlord types the dates in this very submit; checking the saved
      // values let "6/31/2026", or a start overlapping the lease being renewed,
      // through the signature — and then the lease could not be issued and the
      // document sat stuck until voided. Refused here, the landlord can still
      // fix the box. A submitted value counts only where this signer may write
      // it (their own role's box, unsigned or signed by them) — the same rule
      // the field UPDATE below applies.
      const dateRows = (await client.query(`
        SELECT id, lease_column, value, signer_role, signed_at, signer_id FROM lease_document_fields
        WHERE document_id=$1 AND lease_column IN ('start_date','end_date')`, [doc.id])).rows as any[]
      const submittedDates = new Map<string, string>()
      for (const fv of (fieldValues || [])) {
        if (fv?.fieldId && fv.value != null && String(fv.value).trim() !== '') submittedDates.set(fv.fieldId, String(fv.value))
      }
      const effectiveDate = (col: string): string | undefined => {
        const typed = dateRows.find(r => r.lease_column === col && submittedDates.has(r.id)
          && r.signer_role === signer.role && (r.signed_at == null || r.signer_id === signer.id))
        if (typed) return submittedDates.get(typed.id)
        return dateRows.find(r => r.lease_column === col && r.value != null && String(r.value).trim() !== '')?.value
      }
      const startVal = effectiveDate('start_date')
      const endVal   = effectiveDate('end_date')
      if (doc.document_type === 'original_lease') assertLeaseNotAlreadyOver(endVal, todayIn(doc.property_timezone))
      if (startVal) {
        const allTenantIds = [primary.tenantId, ...coTenants.map(c => c.tenantId)]
        // S535: '-' end date = month-to-month (no end date) — never cast it as a date.
        // S655: a new lease for a household already living there does not
        // overlap the lease it follows — that one ends the day before.
        let ov = await canTenantsSignNewLease(
          allTenantIds, doc.unit_id, startVal,
          endVal && endVal.trim() !== '-' ? endVal : null,
          [doc.lease_id, doc.renews_lease_id])
        // S655 (Nic, 10/2: "imports are NEVER blocked"): a lease the resident
        // still holds with ANOTHER company never refuses the landlord's
        // signature when the resident's own signature is what starts this one
        // (nothing issues before they sign). Their signature is checked as
        // always, and that is where they settle it.
        //
        // Nor anyone ELSE's signature on the lease. A household member signing
        // ahead of them (this company's resident, listed first) was refused
        // over a lease that is not theirs and that they cannot end, the refusal
        // told them about the other person's home elsewhere, and the other
        // person never reached their own turn — the lease sat with nothing on
        // screen saying why. Only the signer's OWN overlap stops their
        // signature. Nothing issues on theirs: the landlord's issuance waits
        // for those residents, the last of their own signatures is what issues
        // it (lastOwnSignature below), and the build re-checks every tenant.
        const ownTenantId = isTenantRole(signer.role)
          ? [primary, ...coTenants].find(t => t?.userId === signer.user_id)?.tenantId
          : undefined
        if (!ov.ok && ov.crossCompany) {
          const decides = (await residentsWhoSignFirst(doc.id, [primary, ...coTenants]))
            .filter(id => id !== ownTenantId)
          ov = await canTenantsSignNewLease(
            allTenantIds, doc.unit_id, startVal,
            endVal && endVal.trim() !== '-' ? endVal : null,
            [doc.lease_id, doc.renews_lease_id],
            { residentDecides: decides })
        }
        // Their own home elsewhere, said to them in their own words, with what
        // to do next. Which company and which unit stay unsaid.
        if (!ov.ok && ov.crossCompany && ownTenantId && ov.conflictingTenantId === ownTenantId) {
          throw new AppError(409,
            'You still have a lease with another company that overlaps this one, so you can\'t sign this lease yet. ' +
            'That lease has to end before this one starts: ask that landlord to end it, or ask this landlord to move this lease\'s start date.')
        }
        if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')
        // S655: the landlord's signature issues it, so the dates are checked
        // against the lease it follows now, while the box can still be fixed.
        // The tenant signs terms already locked — never refused for them.
        const startIso = leaseFieldDate(startVal)
        if (doc.renews_lease_id && signer.role === 'landlord' && startIso) {
          const { assertNewLeaseDates } = await import('../services/renewalSuccessor')
          await assertNewLeaseDates(client.query.bind(client) as any,
            { renewsLeaseId: doc.renews_lease_id, startIso })
        }
      }
    }

    // S29 item 3: Server-side required-field validation. Frontend gates on this
    // but malicious clients can bypass the gate. Verify every required field
    // assigned to this signer's role will have a non-empty value after this
    // submission completes (either submitted now or already in the DB).
    // S556: a required CONDITIONAL child (nested radio) is only enforced when
    // its parent's effective selection == the child's trigger option — a hidden
    // child (e.g. auto_renew_mode when the lease is month-to-month) is skipped.
    const allFieldsRes = await client.query(`
      SELECT id, template_field_id, parent_field_id, parent_option, label, field_type, signer_role, required, value, options, lease_column
      FROM lease_document_fields WHERE document_id=$1`, [doc.id])
    // S652 (Blu, MH 18): lease_column was missing from this SELECT, so the
    // typed-sale-terms check below saw no tagged boxes at all and rejected
    // every installment contract with "needs the number of payments" — after
    // the landlord had typed it. Four tries, no message on screen.
    const allFields = allFieldsRes.rows as any[]
    const submittedById = new Map<string, string>()
    for (const fv of (fieldValues || [])) {
      if (fv.value != null && String(fv.value).trim() !== '') {
        submittedById.set(fv.fieldId, String(fv.value))
      }
    }
    const effVal = (f: any): string | null => {
      const s = submittedById.get(f.id)
      if (s != null && String(s).trim() !== '') return String(s)
      return (f.value != null && String(f.value).trim() !== '') ? String(f.value) : null
    }
    // child.parent_field_id references the parent's TEMPLATE field id
    const byTemplateFieldId = new Map<string, any>()
    for (const f of allFields) if (f.template_field_id) byTemplateFieldId.set(f.template_field_id, f)
    const isActive = (f: any): boolean => {
      if (!f.parent_field_id) return true
      const parent = byTemplateFieldId.get(f.parent_field_id)
      if (!parent) return true // parent pruned/missing → degrade to always-shown
      // S652: a child of a CHOICE box shows when that box is the one chosen.
      if (parent.field_type === 'choice') return effVal(parent) != null
      return effVal(parent) === f.parent_option
    }
    // S652 (Nic): a choice group — several boxes, pick one — is required as a
    // GROUP: one of its boxes must be marked, never each of them. "Both of them
    // need an initial, like whichever option is correct."
    const choiceKey = (f: any) => `${f.signer_role}:${f.options ?? f.id}`
    const missingRequired: string[] = []
    const groupsChecked = new Set<string>()
    for (const f of allFields) {
      if (f.signer_role !== signer.role || !f.required) continue
      if (!isActive(f)) continue // hidden conditional child is not required
      if (f.field_type === 'choice') {
        const key = choiceKey(f)
        if (groupsChecked.has(key)) continue
        groupsChecked.add(key)
        const chosen = allFields.some(g => g.field_type === 'choice' && choiceKey(g) === key && effVal(g) != null)
        if (!chosen) missingRequired.push(`a choice for ${f.options || f.label || 'the group'}`)
        continue
      }
      if (effVal(f) == null) missingRequired.push(f.label || `${f.field_type} field`)
    }
    if (missingRequired.length > 0) {
      throw new AppError(400, `Missing required fields: ${missingRequired.join(', ')}`)
    }
    // S652 (Nic): the landlord TYPES the sale terms on the installment contract
    // and they become the record. Read them now, while he can still fix a box,
    // rather than after his signature is on the paper.
    if (signer.role === 'landlord' && doc.document_type === 'purchase_agreement') {
      const { saleTermsFromFields, resolveTypedSaleTerms } = await import('../services/homeSale')
      resolveTypedSaleTerms(saleTermsFromFields(
        allFields.filter((f: any) => f.lease_column && String(f.lease_column).startsWith('sale_'))
                 .map((f: any) => ({ lease_column: f.lease_column, value: effVal(f) }))))
    }

    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress
    const ua = req.headers['user-agent']

    // Phase B: atomic writes — fields, signer status, document status.
    // S29 item 2: Field-value spoofing fix. The original UPDATE matched only
    // on field id + document id, which let a malicious signer overwrite ANY
    // field — including ones already signed by another party. Two extra
    // conditions on the WHERE:
    //   - signer_role match: you can only update fields assigned to your role
    //   - signed_at IS NULL OR signer_id=you: only touch unsigned fields, or
    //     fields you yourself previously signed.
    // Spoof attempts silently no-op (filtered out by the WHERE).
    for (const fv of (fieldValues || [])) {
      // S637: font_css carries the signature style the signer actually picked.
      // COALESCE so a submission without one never wipes a template's own font.
      await client.query(`
        UPDATE lease_document_fields
        SET value=$1, signed_at=NOW(), signer_id=$2,
            font_css = COALESCE($6, font_css)
        WHERE id=$3 AND document_id=$4
          AND signer_role=$5
          AND (signed_at IS NULL OR signer_id=$2)`,
        [fv.value, signer.id, fv.fieldId, doc.id, signer.role, fv.fontCss ?? null])
    }

    // S556: clear any conditional child whose parent is no longer at its
    // trigger option, so a stale/contradictory sub-answer never lands in the
    // signed lease (Nic: clear-on-parent-change). Uses the post-submission
    // effective values computed above.
    for (const f of allFields) {
      if (f.parent_field_id && !isActive(f) && effVal(f) != null) {
        await client.query('UPDATE lease_document_fields SET value=NULL WHERE id=$1 AND document_id=$2', [f.id, doc.id])
      }
    }

    // S648 (Nic): page 8's computed boxes follow what was just signed — the
    // deposit copies page 2, the total adds up, an onboarding resident's
    // move-in lines stay at the month's rent and $0.
    if (signer.role === 'landlord') {
      const { restampMoveInBoxes } = await import('../services/moveInBoxes')
      await restampMoveInBoxes(client, doc.id)
    }

    // S535: the LANDLORD-first signing pass is where lease terms are
    // typed into the doc (send no longer requires landlord-role tagged
    // fields to be prefilled — cross-template renewals may bind fields
    // the predecessor can't derive). The lock-before-tenant invariant
    // (S28) is enforced HERE: after the landlord's values land, every
    // tagged value-bearing field must be filled or the sign rolls back.
    if (signer.role === 'landlord') {
      const taggedRows = await client.query(
        `SELECT template_field_id, parent_field_id, parent_option, lease_column, value FROM lease_document_fields WHERE document_id=$1`,
        [doc.id])
      // S556: exclude inactive conditional children — a hidden sub-radio (its
      // parent isn't at the trigger option) is not a required lease term.
      const rows = taggedRows.rows as any[]
      const byTfid = new Map<string, any>()
      for (const r of rows) if (r.template_field_id) byTfid.set(r.template_field_id, r)
      const activeRows = rows.filter((r) => {
        if (!r.parent_field_id) return true
        const p = byTfid.get(r.parent_field_id)
        if (!p) return true
        const pv = p.value != null && String(p.value).trim() !== '' ? String(p.value) : null
        return pv === r.parent_option
      })
      const unfilled = validateLeaseDocumentForSend(activeRows as any)
      if (unfilled.length > 0) {
        const labels = unfilled.map(v => LEASE_COLUMN_LABEL[v.lease_column])
        throw new AppError(400, `Fill these lease terms before signing: ${labels.join(', ')}`)
      }
    }

    await client.query(`
      UPDATE lease_document_signers
      SET status='signed', signed_at=NOW(), ip_address=$1, user_agent=$2
      WHERE id=$3`,
      [ip, ua, signer.id])

    // S650 (Nic): signing IS the verification. "These people are not gonna get
    // on there and verify an account later on." The signing link went to their
    // inbox and they opened it and signed a lease with it — a stronger proof of
    // the address than a verification click — so the account stops being one
    // that login will refuse. Ellen Gregory (Oak Park MH 02) hit exactly that
    // wall with a password she had just reset.
    if (signer.user_id) {
      await client.query(
        `UPDATE users SET email_verified = TRUE,
                          email_verified_at = COALESCE(email_verified_at, NOW()),
                          updated_at = NOW()
          WHERE id = $1 AND email_verified = FALSE`, [signer.user_id])
    }

    await client.query("UPDATE lease_documents SET status='in_progress', updated_at=NOW() WHERE id=$1", [doc.id])

    await client.query('COMMIT')
    txnDone = true

    // Phase C: post-commit side effects (off-txn). The signature is durable
    // at this point; downstream failures (email, PDF stamp, lease build) get
    // their own handling without rolling back the signature.

    // S576 (B-8): standalone contracts and work-trade addenda produce NO lease —
    // the signed PDF is the legal instrument. Hoisted out of the completion
    // block in S647 because issuance below needs the same test.
    const isNoLeaseDoc = (NO_LEASE_DOCUMENT_TYPES as readonly string[]).includes(doc.document_type)

    // ── S647: THE LANDLORD'S SIGNATURE ISSUES THE LEASE ──────────────────
    //
    // Nic (DIRECTIVE): "Bill it out to everybody upon my signature." And on the
    // ordering: "My signature is done before they even accept — that way their
    // accept and sign is all one flow."
    //
    // The lease and its move-in invoice used to wait for the LAST signer, so a
    // household that accepted a portal invite and never signed produced nothing
    // billable at all. Thirteen are sitting in that state today. Now the
    // landlord's signature is what makes the tenancy real; the tenant's
    // signature executes the document and is recorded honestly, but no longer
    // decides whether anyone can be billed.
    //
    // This is NOT a second billing path. generateMoveInInvoice is still called
    // from exactly one place — buildLeaseFromDocument — and all that changed is
    // when that runs. A tenant finishing later hits the builder's own
    // finalized_at short-circuit and bills nobody twice.
    // S652 (Nic): the installment contract's typed terms become the sale record
    // on the landlord's signature; the tenant's signature then starts billing.
    if (signer.role === 'landlord' && doc.document_type === 'purchase_agreement') {
      try {
        const { applySaleTermsFromDocument } = await import('../services/homeSale')
        await applySaleTermsFromDocument(doc.id)
      } catch (e: any) {
        logger.error({ err: e, documentId: doc.id }, '[HomeSale] typed terms did not become a sale record')
        await createAdminNotification({
          severity: 'critical', category: 'home_sale_terms_failed',
          title: `Installment contract signed but its terms did not record — document ${doc.id}`,
          body: e.message, context: { document_id: doc.id },
        }).catch(() => {})
      }
    }

    // ── S655 (Nic, 10/2): "NOBODY IS ATTACHED TO A COMPANY WITHOUT THEIR
    // OWN SIGNATURE." ─────────────────────────────────────────────────────
    //
    // Imports are never blocked, so a lease can be drafted for somebody who
    // already has a GAM account with ANOTHER company (a tenant of another
    // park, a neighbor on its utilities, its invitee). For them the landlord's
    // signature does not issue the lease: nothing is billed and they are not
    // made this company's tenant until they sign it themselves. The all-signed
    // path below builds and bills it then, exactly once. Everyone else is
    // unchanged (S647: the landlord's signature issues). If the check itself
    // fails, the lease waits for their signature — never the other way round.
    const ownSignatureFirst = signer.role === 'landlord' && !isNoLeaseDoc
      ? await (await import('../services/newLeaseInvite')).tenantsNeedingOwnSignature(doc.id)
          .catch((err: any) => {
            logger.error({ err, documentId: doc.id }, '[ESIGN] own-signature check failed — issuance waits for the tenants')
            return [{ userId: '', name: '' }]
          })
      : []
    if (ownSignatureFirst.length > 0) {
      logger.info({ documentId: doc.id, waitingOn: ownSignatureFirst.length },
        '[ESIGN] issuance waits for the residents\' own signatures (another company\'s account)')
    }

    // S655: and the LAST of those own signatures issues it. A mixed household
    // (this company's resident beside another company's) waited at the
    // landlord's signature only for the person whose consent was missing; once
    // they sign, the lease issues and bills exactly as the landlord's signature
    // would have — not when every co-tenant has finally signed. Only for a
    // document that was held for exactly that reason (the person who just
    // signed is one the check counts), the landlord has signed, it has not
    // issued, and someone is still to sign (when nobody is, the all-signed
    // path below builds it).
    let lastOwnSignature = false
    if (isTenantRole(signer.role) && signer.user_id && !isNoLeaseDoc && !doc.renews_lease_id
        && (doc.document_type === 'original_lease' || doc.document_type === 'addendum_add')) {
      try {
        const st = await queryOne<{ held: boolean }>(
          `SELECT (d.issued_at IS NULL AND d.finalized_at IS NULL
                   AND EXISTS (SELECT 1 FROM lease_document_signers s
                                WHERE s.document_id = d.id AND s.role = 'landlord' AND s.status = 'signed')
                   AND EXISTS (SELECT 1 FROM lease_document_signers s
                                WHERE s.document_id = d.id AND s.status <> 'signed')) AS held
             FROM lease_documents d WHERE d.id = $1`, [doc.id])
        if (st?.held) {
          const { tenantsNeedingOwnSignature } = await import('../services/newLeaseInvite')
          const counted = await tenantsNeedingOwnSignature(doc.id, { alsoSignedUserId: signer.user_id })
          lastOwnSignature = counted.length > 0 && counted.every(p => p.userId === signer.user_id)
        }
      } catch (err: any) {
        // The signature stands; the lease issues on the last signature instead.
        logger.error({ err, documentId: doc.id }, '[ESIGN] own-signature re-check failed — issuance waits for every signer')
      }
    }

    if (!isNoLeaseDoc && ((signer.role === 'landlord' && ownSignatureFirst.length === 0) || lastOwnSignature)) {
      try {
        const issued = await buildLeaseFromDocument(doc.id)
        if (!issued.deferred) await query(
          `UPDATE lease_documents SET issued_at = COALESCE(issued_at, NOW()), updated_at = NOW()
            WHERE id = $1`, [doc.id])

        // The held utility shares belong on the first invoice, and the first
        // invoice now exists (S629's rule, applied at the moment it becomes
        // true rather than at execution). Best-effort: a failure leaves them
        // HELD and visible, never written off.
        if (issued.leaseId && doc.unit_id && !issued.alreadyBuilt) {
          try {
            const lease = await queryOne<{ landlord_id: string }>(
              `SELECT landlord_id FROM leases WHERE id = $1`, [issued.leaseId])
            const primary = await queryOne<{ tenant_id: string }>(
              `SELECT tenant_id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
              [issued.leaseId])
            if (lease && primary) {
              await releaseSuspendedChargesForLease({
                unitId: doc.unit_id, leaseId: issued.leaseId,
                tenantId: primary.tenant_id, landlordId: lease.landlord_id,
              })
            }
          } catch (e) {
            logger.error({ err: e, leaseId: issued.leaseId },
              '[utility] releasing held shares at issuance failed — they stay held')
          }
        }
      } catch (e: any) {
        // The landlord's signature is durable and stays. What failed is the
        // lease materializing, which is the same condition the execution path
        // already treats as critical — surfaced, not swallowed.
        logger.error({ err: e, documentId: doc.id, reason: e.message },
          '[ESIGN] issuance build failed')
        await createAdminNotification({
          severity: 'critical',
          category: 'esign_issuance_build_failed',
          title:    `Lease did not issue on ${lastOwnSignature ? "the resident's own" : 'landlord'} signature for document ${doc.id}`,
          body:     e.message,
          context:  { document_id: doc.id },
        }).catch(() => {})
      }
    }

    const remaining = await queryOne<any>(
      "SELECT COUNT(*)::int as count FROM lease_document_signers WHERE document_id=$1 AND status != 'signed'",
      [doc.id])

    if (remaining?.count === 0) {
      // S29 item 5: Build lease BEFORE marking document completed. If build
      // fails, park the doc in execution_failed state for admin investigation.
      // Signatures are real but no lease record exists, so 'completed' would
      // be a lie. Tenant frontend still gets completed:true (their work is
      // done); the failure is a landlord/admin-side issue surfaced in the
      // landlord dashboard via execution_failed status.
      // S576 (B-8): no-lease document types (standalone contracts +
      // work_trade_addendum) produce NO lease record — the signed PDF is the
      // legal instrument. buildLeaseFromDocument's switch has no case for them
      // and would throw 'Unknown document_type', dumping a fully-signed doc into
      // execution_failed. Skip the build entirely; these complete cleanly and
      // still get their PDF stamped below. leaseResult stays null (no lease id).
      let leaseResult: { leaseId: string; status: string; primaryTenantId: string; alreadyBuilt: boolean } | null = null
      if (!isNoLeaseDoc) {
        try {
          leaseResult = await buildLeaseFromDocument(doc.id)
        } catch (e: any) {
          logger.error('[ESIGN] buildLeaseFromDocument failed for document', doc.id, '-', e.message)
          // S132: critical — signed document but no lease materialized.
          // Tenant signed a legal contract that didn't translate to an
          // active lease in the system. Manual remediation needed.
          await createAdminNotification({
            severity: 'critical',
            category: 'esign_lease_build_failed',
            title:    `Lease build failed for signed document ${doc.id}`,
            body:     e.message,
            context:  { document_id: doc.id },
          })
          await query(
            "UPDATE lease_documents SET status='execution_failed', execution_failed_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2",
            [`Lease build failed: ${e.message}`, doc.id])
          return res.json({ success: true, data: { completed: true, executionFailed: true, reason: e.message } })
        }

        // S581 guarded the one-time side effects (PM transfer, PDF stamp,
        // completion emails) against a concurrent final signature by testing
        // `alreadyBuilt`. S647 broke that test: the landlord's signature now
        // builds every lease at issuance, so `alreadyBuilt` is TRUE on every
        // ordinary execution and this would have skipped the stamp and the
        // emails for all of them.
        //
        // The thing actually being guarded is the completion TRANSITION, so
        // guard that instead: claim it with a compare-and-swap and let whoever
        // wins run the side effects. This is strictly stronger than the old
        // test — it also catches a race between two finalizers where neither
        // had built anything.
        const claimed = await query<{ id: string }>(
          `UPDATE lease_documents
              SET status='completed', completed_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND status <> 'completed'
            RETURNING id`, [doc.id])
        if (claimed.length === 0) {
          return res.json({ success: true, data: { completed: true, leaseId: leaseResult?.leaseId, deduped: true } })
        }

        // S647: everyone has signed, so say so on the lease. It was written
        // signed_by_tenant = FALSE at issuance, and the lease PDF prints these
        // two flags as its signature block.
        if (leaseResult?.leaseId) {
          await query(
            `UPDATE leases SET signed_by_tenant = TRUE,
                               signed_at = COALESCE(signed_at, NOW()),
                               updated_at = NOW()
              WHERE id = $1`, [leaseResult.leaseId])
        }

        // S119 post-commit: fire Stripe Transfer for any PM company leasing
        // fee that landed on the ledger as a ghost. Only fires when the
        // property is contracted to a PM company with leasing_fee_amount > 0.
        // No-lease docs never reach here — there is no lease to attribute a
        // leasing fee to (leaseResult is null).
        try {
          const { firePmTransfersForReference } = await import('../services/stripeConnect')
          await firePmTransfersForReference('lease', leaseResult.leaseId)
        } catch (e) {
          logger.error({ err: e, ctx: leaseResult.leaseId }, '[pm_transfer] post-commit firing failed for lease')
          await createAdminNotification({
            severity: 'warn',
            category: 'pm_transfer_post_commit_failed',
            title:    `PM leasing fee transfer failed for lease ${leaseResult.leaseId}`,
            body:     e instanceof Error ? e.message : String(e),
            context:  { lease_id: leaseResult.leaseId, document_id: doc.id },
          })
        }
      }

      // (completion was claimed above for lease-producing docs; a no-lease doc
      // has no builder to run, so it claims here instead.)
      if (isNoLeaseDoc) {
        const claimedNoLease = await query<{ id: string }>(
          `UPDATE lease_documents
              SET status='completed', completed_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND status <> 'completed'
            RETURNING id`, [doc.id])
        if (claimedNoLease.length === 0) {
          return res.json({ success: true, data: { completed: true, deduped: true } })
        }
      }

      // S629 (Nic): "a pending unit should have the amount of water show as
      // temporary suspension back end and be billed with the first invoice as
      // soon as acceptance happens."
      //
      // While they were invited but unsigned, their utility share was counted
      // into the RUBS split — so their neighbors were charged correctly — and
      // held with no invoice behind it. Signing is what gives it somewhere to
      // go, so it lands on their first invoice now.
      //
      // Post-commit and best-effort, like the neighbors here: the signature is
      // recorded and must never be rolled back over a utility charge. A row
      // that fails stays HELD rather than vanishing, so nothing is silently
      // written off.
      if (leaseResult?.leaseId && doc.unit_id) {
        try {
          const lease = await queryOne<{ landlord_id: string }>(
            `SELECT landlord_id FROM leases WHERE id = $1`, [leaseResult.leaseId])
          const primary = await queryOne<{ tenant_id: string }>(
            `SELECT tenant_id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
            [leaseResult.leaseId])
          if (lease && primary) {
            await releaseSuspendedChargesForLease({
              unitId: doc.unit_id, leaseId: leaseResult.leaseId,
              tenantId: primary.tenant_id, landlordId: lease.landlord_id,
            })
          }
        } catch (e) {
          logger.error({ err: e, leaseId: leaseResult.leaseId },
            '[utility] releasing held shares failed — they stay held')
        }
      }

      // S629 (Nic): a signed PURCHASE AGREEMENT is what starts a financed home
      // sale billing. The contract has been sitting in pending_signature with
      // its terms and no schedule; this writes the installments and makes it
      // active, so what gets billed is what was signed.
      //
      // Best-effort and post-commit like the neighbors here: the signature is
      // already recorded and must not be rolled back if scheduling fails.
      // activateHomeSaleContract is idempotent, and a failure leaves the
      // contract pending — visible, and retryable — rather than half-billed.
      if (doc.document_type === 'purchase_agreement') {
        try {
          await activateHomeSaleContract(doc.id)
        } catch (e) {
          logger.error({ err: e, documentId: doc.id }, '[HomeSale][activate-on-signature]')
          await createAdminNotification({
            severity: 'warn',
            category: 'home_sale_activation_failed',
            title:    `Home-sale billing not started for signed agreement ${doc.id}`,
            body:     e instanceof Error ? e.message : String(e),
            context:  { document_id: doc.id },
          }).catch(() => {})
        }
      }

      // S576 (B-8): a completed RENEWAL means the new lease now exists — if the
      // tenant's work-trade agreement is still active, auto-draft a fresh
      // work-trade addendum on it for the landlord to review + send. Best-effort,
      // post-commit: never affects the renewal's own completion.
      if (doc.renews_lease_id && leaseResult?.leaseId) {
        try {
          await autoDraftWorkTradeAddendumForRenewal(leaseResult.leaseId)
        } catch (e) {
          logger.error({ err: e }, '[LeaseRenewal][wt-addendum-autodraft-call]')
        }
      }

      // Stamp PDF
      let executedUrl: string | null = null
      try {
        if (doc.base_pdf_url) {
          const allFields = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1', [doc.id])
          const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc.id])
          const sourcePdfPath = extractUploadFilename(doc.base_pdf_url)
          if (sourcePdfPath) {
          const sourcePath = path.join(uploadDir, sourcePdfPath)
          if (fs.existsSync(sourcePath)) {
            const executedFilename = 'executed-' + doc.id + '.pdf'
            const outputPath = path.join(uploadDir, executedFilename)
            const signerInfo = (allSigners as any[]).map(s => ({ name:s.name, email:s.email, role:s.role, signed_at:s.signed_at }))
            await stampPdf(sourcePath, (allFields as any[]).map(f => ({
              page: parseInt(f.page)||1, x: parseFloat(f.x)||0, y: parseFloat(f.y)||0,
              width: parseFloat(f.width)||100, height: parseFloat(f.height)||30,
              field_type: f.field_type, value: f.value, font_css: f.font_css,
              checkbox_mark: f.checkbox_mark
            })), signerInfo, outputPath)
            executedUrl = '/api/esign/files/' + executedFilename
            await query('UPDATE lease_documents SET executed_pdf_url=$1 WHERE id=$2', [executedUrl, doc.id])
          }
          }
        }
      } catch(e) { logger.error({ err: e }, '[ESIGN] PDF stamp failed:') }

      const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc.id])
      const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : doc.title
      // S636 (Nic): the executed copy goes out as an ATTACHMENT — read once for
      // every signer. Best-effort: a missing or unreadable file must never stop
      // the completion email, which is also how the parties learn it is done.
      let executedBytes: Buffer | null = null
      if (executedUrl) {
        try {
          const fname = executedUrl.split('/').pop()!
          const fpath = resolveUploadPath(uploadDir, fname)
          if (fpath && fs.existsSync(fpath)) executedBytes = fs.readFileSync(fpath)
        } catch (e) { logger.error({ err: e, documentId: doc.id }, '[ESIGN] could not attach the executed PDF') }
      }
      // S652 (Nic): a packet speaks ONCE — when its last document completes,
      // every signer hears; a document inside a packet says nothing on its own.
      const packetGroup = doc.package_group_id as string | null
      if (packetGroup) {
        await announcePacketIfComplete(packetGroup, (role) => isTenantRole(role)
          ? (process.env.TENANT_APP_URL || 'https://tenant.goldassetmanagement.com') + '/lease'
          : (process.env.LANDLORD_APP_URL || 'https://landlord.goldassetmanagement.com') + '/esign')
      }
      if (!packetGroup) for (const s of allSigners as any[]) {
        // S636 (Nic): "It says click to download and view your lease, and it
        // provides a link that does absolutely nothing from the tenant portal."
        //
        // Two dead links in one call. `executedUrl` is a RELATIVE path
        // (/api/esign/files/…), which resolves to nothing from an email client —
        // and even absolute it is an AUTHED route, so a click carrying no Bearer
        // token could never fetch it. The fallback was worse: portalUrl defaulted
        // to http://localhost:3002 and nothing was passed, so the alternative
        // button pointed at the recipient's own machine.
        //
        // Send them to their portal instead, where they are signed in and the
        // download button is already authed properly. Landlords to the landlord
        // portal, everyone else to the tenant one.
        const portalHome = isTenantRole(s.role)
          ? (process.env.TENANT_APP_URL || 'https://tenant.goldassetmanagement.com') + '/lease'
          : (process.env.LANDLORD_APP_URL || 'https://landlord.goldassetmanagement.com') + '/esign'
        // S654: the executed copy rides along, so it goes only to the address on
        // each signer's own account (the landlord's row keeps its own).
        await emailSigningCompleted(await signerDeliveryAddress(s), s.name, doc.title, unitLabel, undefined, portalHome,
          { landlordId: doc.landlord_id, documentId: doc.id, replyTo: await signerReplyTo(s, doc.property_id) },
          executedBytes ?? undefined)
        await createNotification({
          userId: s.user_id,
          type: 'esign_completed',
          title: 'Document fully executed',
          body: `"${doc.title}" has been signed by all parties.`,
          data: { documentId: doc.id, leaseId: leaseResult?.leaseId || null },
          sendEmail: false
        })
      }

      res.json({ success: true, data: { completed: true, leaseId: leaseResult?.leaseId, leaseStatus: leaseResult?.status } })
    } else {
      // S652 (Nic): "it needs to be bundled as a true package." A packet
      // document hands on as a PACKET — the next signer is invited once, when
      // everyone before them has finished every document (services/packetRelay).
      // Only a standalone document still relays itself.
      if (doc.package_group_id) await advancePacket(doc.package_group_id)
      const nextSigner = doc.package_group_id ? null : await queryOne<any>(`
        SELECT * FROM lease_document_signers
        WHERE document_id=$1 AND status='pending'
        ORDER BY order_index LIMIT 1`, [doc.id])
      let nextSignerAddress: string | undefined
      if (nextSigner) {
        const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : doc.title
        // S647: a tenant who has not set up their account gets ONE email that
        // sets it up and lands them on this lease (services/tenantLeaseLink) —
        // not a bare signing link on top of the portal invite they already got.
        //
        // S654: and only ever to the address on their own account. The signer
        // row's address once came from the request body, which is how landlord
        // B had landlord A's invitee's live password link mailed to B.
        nextSignerAddress = await signerDeliveryAddress(nextSigner)
        let nextSigningUrl: string
        let needsSetup = false
        if (nextSigner.role === 'landlord' || nextSigner.role === 'witness') {
          const nextSignerUser = await queryOne<any>('SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [nextSigner.user_id])
          nextSigningUrl = signingUrlFor(nextSigner, doc.id, nextSignerUser)
        } else {
          const { tenantLeaseLink } = await import('../services/tenantLeaseLink')
          const link = await tenantLeaseLink({
            userId: nextSigner.user_id, documentId: doc.id, signerToken: nextSigner.token,
            sendTo: nextSignerAddress })
          nextSigningUrl = link.url
          needsSetup = link.needsSetup
        }
        // S655: a new lease for a household already living there is announced
        // as one — "nothing changes today; from <date> the new lease takes over"
        // — never as a lease to start, and never as an ending.
        const newLeaseTerms = doc.renews_lease_id && isTenantRole(nextSigner.role)
          ? await queryOne<{ start_date: string; rent_amount: string; tz: string }>(
              `SELECT to_char(l.start_date, 'YYYY-MM-DD') AS start_date, l.rent_amount::text AS rent_amount,
                      COALESCE(p.timezone, 'America/Phoenix') AS tz
                 FROM lease_documents d JOIN leases l ON l.id = d.lease_id
                 LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id
                WHERE d.id = $1`, [doc.id])
          : null
        if (newLeaseTerms) {
          const { emailNewLeaseSigningRequest } = await import('../services/email')
          await emailNewLeaseSigningRequest(nextSignerAddress, nextSigner.name, unitLabel, doc.landlord_name, nextSigningUrl,
            { startDate: newLeaseTerms.start_date, rent: newLeaseTerms.rent_amount,
              // Signed on or after its start date: it is their lease already.
              started: newLeaseTerms.start_date <= todayIn(newLeaseTerms.tz),
              landlordId: doc.landlord_id, documentId: doc.id, needsSetup,
              replyTo: await signerReplyTo(nextSigner, doc.property_id) })
        } else {
          await emailSigningRequest(nextSignerAddress, nextSigner.name, doc.title, unitLabel, doc.landlord_name, nextSigningUrl,
            { landlordId: doc.landlord_id, documentId: doc.id, needsSetup, replyTo: await signerReplyTo(nextSigner, doc.property_id) })
        }
        await createNotification({
          userId: nextSigner.user_id,
          type: 'esign_request',
          title: 'Document ready to sign',
          body: `"${doc.title}" is awaiting your signature.`,
          data: { documentId: doc.id },
          sendEmail: false
        })
        await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1", [nextSigner.id])
        // S637 (Nic): STAMP THE DOCUMENT TOO, if nothing has yet.
        //
        // "I have three completed ones that don't even show when they were
        //  sent... the only dates that should be blank are the ones that have
        //  yet to complete."
        //
        // Only the two /send routes set sent_at, so a draft the landlord opens
        // and signs HIMSELF never passes through either: he has no invite, the
        // tenant is emailed from right here as the next signer, and the document
        // completes having never been marked sent. Three Oak Park leases read
        // that way — RV 02, RV 03 and RV 36.
        //
        // This IS the moment it went out for such a document, so record it —
        // and only when empty, so a real send date is never overwritten by a
        // later signer in the chain.
        await query(
          "UPDATE lease_documents SET sent_at = COALESCE(sent_at, NOW()), updated_at=NOW() WHERE id=$1",
          [doc.id])
      }
      res.json({ success: true, data: { completed: false, nextSigner: nextSignerAddress } })
    }
  } catch (e) {
    if (!txnDone) {
      try { await client.query('ROLLBACK') } catch {}
    }
    next(e)
  } finally {
    client.release()
  }
})

// S652 (Nic): "make it so that nobody can ever decline any document. They just
// don't complete the signature if they're choosing not to."
//
// This used to be the S234 decline path: one signer's refusal voided the whole
// document, which is how Jeff Bowman's "Decline" on MH 30's lead-paint sales
// disclosure killed a document Blu and Kim had already signed. There is no
// decline any more, on any sign page, for anyone. The route stays only so an
// old client gets a sentence instead of a 404.
esignRouter.post('/sign/:documentId/decline', authOrSignerToken, async (_req, _res, next) => {
  next(new AppError(410, 'Documents cannot be declined. If you are not going to sign, leave it unsigned and tell your landlord.'))
})

// ─────────────────────────────────────────────────────────────
// PENDING QUEUES
// ─────────────────────────────────────────────────────────────

esignRouter.get('/pending', requireAuth, async (req, res, next) => {
  try {
    const pending = await query<any>(`
      SELECT d.id as document_id, s.role, s.status, d.title, d.base_pdf_url,
        u.unit_number, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name,
        -- S655: a new lease for the household they already live in. The tenant
        -- portal shows it as a banner and a "next lease" card, never as the
        -- signing lock-in a brand-new tenant gets.
        d.renews_lease_id
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = d.landlord_id
      JOIN users lu ON lu.id = l.user_id
      WHERE s.user_id = $1
        -- S636 (Nic): "It shows now, but it wasn't showing even in the pending
        -- state before."
        --
        -- 'pending' was excluded, so a lease that drafted but was never sent was
        -- invisible here AND unmailed — it existed and no one could learn that
        -- from either direction. That is precisely how the auto-send bug went
        -- unnoticed: every lease drafted on acceptance sat unsent and unlisted.
        -- The send is fixed, but mail can still fail, and a lease the landlord
        -- cannot see is worse than one they can sign early.
        AND s.status IN ('pending','sent','viewed')
        AND d.status NOT IN ('completed','voided')
      ORDER BY s.created_at DESC`, [req.user!.userId])
    res.json({ success: true, data: pending })
  } catch(e) { next(e) }
})

esignRouter.get('/landlord-pending', requireAuth, requirePerm('leases.sign'), async (req, res, next) => {
  try {
    // S633: every company the account owns, and this caller as the signer.
    // Resolving "the landlord's user" through one entity meant a co-owner or a
    // second company's documents never appeared in the signing queue.
    const scopeIds = landlordScopeIds(req.user!)
    const pending = await query<any>(`
      SELECT d.id as document_id, s.status, s.name, d.title, d.status as doc_status,
        u.unit_number, p.name as property_name, d.base_pdf_url,
        -- S655: the portal tells a new lease for a sitting household apart by
        -- this link, never by the title's wording.
        d.renews_lease_id,
        (SELECT name FROM lease_document_signers WHERE document_id=d.id AND role='primary' LIMIT 1) as primary_tenant_name,
        (SELECT status FROM lease_document_signers WHERE document_id=d.id AND role='primary' LIMIT 1) as primary_tenant_status
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE d.landlord_id = ANY($1::uuid[])
        AND s.user_id = $2
        AND s.status IN ('sent','viewed')
        AND d.status NOT IN ('completed','voided')
      ORDER BY s.created_at DESC`, [scopeIds, req.user!.userId])
    res.json({ success: true, data: pending })
  } catch(e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// FILE UPLOAD
// ─────────────────────────────────────────────────────────────

const uploadDir = path.join(process.cwd(), 'uploads', 'leases')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req: any, file: any, cb: any) => {
    // S394 fix: force .pdf extension based on MIME, NOT from attacker-
    // controlled originalname. Pre-fix, a caller could upload a file
    // with mimetype=application/pdf (passes fileFilter) and
    // originalname=evil.html, and the saved filename would carry the
    // .html extension. GET /files/:filename serves via res.sendFile
    // which auto-detects Content-Type from extension → text/html →
    // XSS in the authorized viewer's browser (signer or landlord).
    // Same class as the S380 avatar-upload finding.
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2)
    cb(null, unique + '.pdf')
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    if (file.mimetype === 'application/pdf') cb(null, true)
    else cb(new Error('PDF only'))
  }
})

esignRouter.post('/upload', requireAuth, requirePerm('leases.create'), upload.single('file'), async (req: any, res: any, next: any) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    // S652 — A PDF LOCKED AGAINST EDITING CAN NEVER BE SIGNED. Signing stamps
    // names, initials and dates onto the page (services/pdfStamp, pdf-lib), and
    // pdf-lib refuses an encrypted file — so a locked PDF uploaded as a template
    // would be accepted here and fail the moment the last person signed. Found
    // stocking the library: one of Illinois' radon pamphlets is locked. Say so
    // now, while the landlord can still save an unlocked copy.
    {
      const { PDFDocument } = await import('pdf-lib')
      try { await PDFDocument.load(fs.readFileSync(req.file.path)) }
      catch (e: any) {
        try { fs.unlinkSync(req.file.path) } catch { /* already gone */ }
        if (/encrypt/i.test(String(e?.message))) {
          throw new AppError(400, 'This PDF is locked against editing, so signatures can\'t be added to it. Open it and save or print it to a new PDF, then upload that copy.')
        }
        throw new AppError(400, 'That file could not be read as a PDF.')
      }
    }
    const fileUrl = '/api/esign/files/' + req.file.filename
    let pageCount = 1
    try {
      const fileBuffer = fs.readFileSync(req.file.path).toString('binary')
      const matches = fileBuffer.match(/\/Type\s*\/Page[^s]/g)
      if (matches) pageCount = matches.length
    } catch(e) { /* fallback to 1 */ }
    // S535: read the PDF's text for the landlord's property name/address —
    // lease forms usually carry it, and a unique match auto-locks the
    // template to that property in the create modal. Best-effort.
    const detectedProperty = await detectPropertyFromPdf(
      landlordScopeIds(req.user!), fs.readFileSync(req.file.path))
    res.json({ success: true, data: { url: fileUrl, filename: req.file.originalname, size: req.file.size, pageCount, detectedProperty } })
  } catch (e) { next(e) }
})


/**
 * S629: the same signer-token identity, for a file request.
 *
 * The signing page fetches the PDF it is asking somebody to sign, and that
 * route authorizes per row — the caller must be the landlord OR a signer on a
 * document referencing the file. A signer arriving from an emailed link has no
 * session, so the token comes on the query string instead and stands in for
 * one. The per-row check below is untouched and still does the deciding: the
 * token identifies WHO is asking, never WHAT they may see.
 */
async function authOrSignerTokenQuery(req: any, res: any, next: any) {
  const t = String(req.query?.t || '')
  if (!SIGNER_TOKEN_RE.test(t)) return requireAuth(req, res, next)
  try {
    const signer = await queryOne<any>(
      `SELECT user_id, email FROM lease_document_signers WHERE token = $1`, [t])
    if (!signer) return res.status(404).json({ success: false, error: 'That signing link is not valid.' })
    req.user = { userId: signer.user_id, role: 'signer', email: signer.email, profileId: null }
    return next()
  } catch (e) { return next(e) }
}

esignRouter.get('/files/:filename', authOrSignerTokenQuery, async (req: any, res: any, next: any) => {
  try {
    // Files live in uploads/leases (uploads + executed PDFs) OR
    // uploads/subleases (generated sublease agreements — see
    // services/subleaseDocuments.ts, which stores fileUrl as
    // '/api/esign/files/<filename>' but writes the bytes to the
    // subleases dir). Pre-S535 the subleases lookup was missing, so
    // every generated sublease agreement 404'd here before the auth
    // check ever ran.
    let filePath = resolveUploadPath(uploadDir, req.params.filename)
    if (!filePath) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(filePath)) {
      const subleasePath = resolveUploadPath(
        path.join(process.cwd(), 'uploads', 'subleases'), req.params.filename)
      if (subleasePath && fs.existsSync(subleasePath)) filePath = subleasePath
      else throw new AppError(404, 'File not found')
    }

    // Authorization (S535 rework): the caller must be the owning landlord
    // (or their team member — staff carry req.user.landlordId), OR a
    // signer on a document using this file. Files are matched against
    // lease_documents base/executed URLs AND lease_templates.base_pdf_url
    // — template PDFs previously had no auth path at all, so the
    // template-gallery preview of an uploaded template could never
    // render. Also fixed here: the old LIMIT 1 lookup checked only the
    // FIRST document row sharing a base_pdf_url, so a legitimate signer
    // on the second+ document drafted from the same template 403'd.
    const userId = req.user!.userId
    const role = req.user!.role
    const filename = req.params.filename
    const urlSuffix = '/api/esign/files/' + filename
    // S633: the account's companies, not one. Still authorized PER ROW below —
    // the document must belong to a company this caller owns, or they must be a
    // signer on it. Widening the scope does not widen who may read a file.
    const scopeLandlordIds = landlordScopeIds(req.user!)

    const exists = await queryOne<any>(`
      SELECT 1 FROM lease_documents WHERE base_pdf_url = $1 OR executed_pdf_url = $1
      UNION ALL
      SELECT 1 FROM lease_templates WHERE base_pdf_url = $1
      UNION ALL
      SELECT 1 FROM disclosure_library_documents WHERE base_pdf_url = $1
      LIMIT 1`, [urlSuffix])
    if (!exists) throw new AppError(404, 'File not found')

    const authorized = await queryOne<any>(`
      SELECT 1 FROM lease_documents d
       WHERE (d.base_pdf_url = $1 OR d.executed_pdf_url = $1)
         AND ((COALESCE(array_length($2::uuid[], 1), 0) > 0 AND d.landlord_id = ANY($2::uuid[]))
              OR EXISTS (SELECT 1 FROM lease_document_signers s
                          WHERE s.document_id = d.id AND s.user_id = $3))
      UNION ALL
      SELECT 1 FROM lease_templates t
       WHERE t.base_pdf_url = $1 AND COALESCE(array_length($2::uuid[], 1), 0) > 0 AND t.landlord_id = ANY($2::uuid[])
      UNION ALL
      -- S652: a form on the government shelf is readable by any signed-in user
      -- — a landlord looking at it before putting it on their shelf, and a
      -- tenant reading the landlord-tenant act for their home from the portal.
      -- It is a public agency document; the login is still required (nothing
      -- public without one), but no ownership is, because nobody owns it.
      SELECT 1 FROM disclosure_library_documents g
       WHERE g.base_pdf_url = $1
      LIMIT 1`, [urlSuffix, scopeLandlordIds, userId])
    if (!authorized) throw new AppError(403, 'Not authorized to view this file')

    res.sendFile(filePath)
  } catch (e) { next(e) }
})

// ── S605 (Nic): DRAFT A HOUSEHOLD LEASE FROM THE UNIT TYPE'S TEMPLATE ────────
//
// Closes the invite → lease gap. Nic wanted the chain to run itself after one
// click, and to be built GENERICALLY: "the chain needs to look for that unit
// type's default lease template. When nothing is set, it can't fire, but you can
// build the structure so that as soon as I add a template it would fire."
//
// So this never asks WHICH template — it resolves the default for the unit's
// type and reports plainly when a landlord hasn't configured one. Landlords with
// templates get drafts today; landlords without get a message naming what to set
// up, and the same call starts working the moment they set it.
//
// Returns 200 with drafted:false rather than an error when no template exists:
// the invites DID go out and the accounts ARE real, so this is information about
// an optional next step, not a failure of the thing the landlord just did.
//
// S654: requireAuth was missing, so req.user was never set and every call came
// back 401 — and the landlord app signs out on any 401, so inviting a household
// to a unit logged the landlord out. With a session, it must also hold the line
// every other door holds: a resident goes on this company's lease only once
// they are this company's (resolveHouseholdByEmail only skips residents
// actively leased elsewhere, so it accepted landlord A's invitee for B's unit).
esignRouter.post('/draft-household', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const body = z.object({
      unitId: z.string().uuid(),
      // Household order — first email is the primary resident.
      emails: z.array(z.string().email()).min(1).max(8),
      homeSale: z.any().optional(),
      packageTemplateIds: z.array(z.string().uuid()).max(40).optional(),
    }).parse(req.body)

    const unit = await queryOne<any>(
      `SELECT u.id, p.landlord_id FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`, [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const residents = await resolveHouseholdByEmail(unit.landlord_id, body.emails)
    if (!residents.length) {
      return res.json({ success: true, data: { drafted: false,
        reason: 'None of those residents have tenant accounts under this landlord yet.' } })
    }
    // S654: the seats draftHouseholdLease gives them (primary, co_tenant_N),
    // put through the same checks as a hand-built document.
    const seats = residents.map((r, i) => ({
      userId: r.userId, name: r.name, role: i === 0 ? 'primary' : `co_tenant_${i}`,
    }))
    const accounts = await assertSignerLogins(seats)
    await assertResidentsBelong(seats, accounts, [unit.landlord_id, ...landlordScopeIds(req.user!)])
    const result = await draftHouseholdLease({
      landlordId: unit.landlord_id, unitId: body.unitId, residents, homeSale: body.homeSale ?? null,
      packageTemplateIds: body.packageTemplateIds ?? null,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})
