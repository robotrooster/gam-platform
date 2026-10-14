/**
 * 10/14 (Nic): "Only the landlord can fix a birthday." A tenant's birthday
 * (tenants.date_of_birth — copied off their signed lease, services/
 * leaseBirthdates) is corrected by the landlord on the tenant's page; the
 * tenant cannot change it (they were asked "Let tenants correct their own
 * birthday on their profile?" — no). It is what the happy-birthday email
 * reads (jobs/birthdayEmails.ts).
 *
 * Who may read or fix it: the owner of a company the person has had a lease
 * with (an owner or co-owner account), or GAM admin. Team members never see
 * it — the tenant page's own payload still leaves the date of birth out.
 */
import { FALLBACK_TIMEZONE } from '@gam/shared'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { dateIn } from '../lib/timezone'

/**
 * The birthday a landlord typed: a real calendar date (YYYY-MM-DD), no earlier
 * than 1900 and before today (Phoenix's calendar, the day the birthday job
 * greets on); null or '' clears it.
 */
export function tenantBirthdayFrom(raw: unknown, now: Date = new Date()): string | null {
  if (raw === null || raw === '') return null
  const m = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new AppError(400, 'Enter the birthday as a date, like 1980-04-23.')
  }
  if (+m[1] < 1900) throw new AppError(400, 'That birthday is before 1900 — check the year.')
  if ((raw as string) >= dateIn(FALLBACK_TIMEZONE, now)) throw new AppError(400, 'That birthday is not a date in the past.')
  return raw as string
}

/** Refuses anyone but the landlord (owner) of a company this person has had a lease with, or GAM admin. */
export async function assertMayFixTenantBirthday(user: any, tenantId: string): Promise<void> {
  if (user?.role === 'tenant') throw new AppError(403, 'Your landlord keeps your birthday on file. Ask them to fix it.')
  const t = await queryOne<{ id: string }>(`SELECT id FROM tenants WHERE id = $1`, [tenantId])
  if (!t) throw new AppError(404, 'Tenant not found')
  const companies = await query<{ landlord_id: string }>(
    `SELECT DISTINCT l.landlord_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id WHERE lt.tenant_id = $1`, [tenantId])
  // No team role is passed: only an owner account (or GAM admin) passes.
  if (!companies.some(c => canManageLandlordResource(user, c.landlord_id, []))) {
    throw new AppError(403, 'Only the landlord can see or fix a tenant\'s birthday.')
  }
}

export async function readTenantBirthday(tenantId: string): Promise<string | null> {
  const r = await queryOne<{ dob: string | null }>(
    `SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS dob FROM tenants WHERE id = $1`, [tenantId])
  return r?.dob ?? null
}

export async function writeTenantBirthday(tenantId: string, dob: string | null): Promise<string | null> {
  const r = await queryOne<{ dob: string | null }>(
    `UPDATE tenants SET date_of_birth = $2::date, updated_at = NOW() WHERE id = $1
     RETURNING to_char(date_of_birth, 'YYYY-MM-DD') AS dob`, [tenantId, dob])
  return r?.dob ?? null
}
