/**
 * S651 — Mattoon load, stage 2: the households.
 *
 * Thirteen occupied lots. Accounts are created SILENT — no invite token, no
 * email, nothing a tenant could act on. Nic: "don't let anything go to any
 * tenants yet."
 *
 * WHO BECOMES AN ACCOUNT. Only a person with their own email address. The sheet
 * lists two or three names on several lots but usually one mailbox, and an
 * account is a login — inventing an address for somebody so the row looks tidy
 * would either collide with a real person later or sit dead forever. The other
 * named adults are recorded against the lot and go on the lease as occupants
 * once it exists. (memory: gam-dual-role-separate-emails)
 */
import { query, getClient } from '../../db'
import fs from 'fs'
import bcrypt from 'bcryptjs'

const DRY = process.env.DRY === '1'
const SRC = __dirname + '/lots.json'
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'

/** Households where more than one person has their own mailbox. */
const EXTRA_EMAILS: Record<string, string[]> = {
  '30': ['Jeffbowman1971sr@gmail.com'],   // Kim + Jeff Bowman
}

/**
 * Whose mailbox it actually is, where the sheet's name order does not say.
 *
 * Lot 1 reads "John Sheptock / Nancy Sheptock" against one address. The account
 * created in error during setup was NANCY's, which is the evidence for whose
 * mailbox the5ways2005@ is — so she holds the account and signs, and John is
 * the occupant. (Nic: "Nancy needs to be on the lot one lease.")
 */
const PRIMARY_NAME: Record<string, string> = {
  '1': 'Nancy Sheptock',
}

function splitNames(s: string): string[] {
  return s.split(/\n|\//).map((x) => x.trim()).filter(Boolean)
}
function splitPhones(s: string | null): string[] {
  return (s ?? '').split(/\n/).map((x) => x.trim()).filter(Boolean)
}
function firstLast(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/)
  return { first: parts[0] ?? full, last: parts.slice(1).join(' ') || '' }
}

async function main() {
  const rows: any[] = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  const seen = new Set<string>()
  const occ = rows.filter((r) => {
    const ok = /^\d+$/.test(r.lot) && r.tenant && r.tenant.toLowerCase() !== 'vacant' && !seen.has(r.lot)
    if (ok) seen.add(r.lot)
    return ok
  })

  const plan: any[] = []
  for (const r of occ) {
    const names = splitNames(r.tenant)
    const phones = splitPhones(r.phone)
    // The sheet puts several addresses in one cell for some lots, and
    // EXTRA_EMAILS names the ones typed elsewhere. Dedupe: lot 30 carries both
    // Bowman addresses in the cell AND in the map, and creating Jeff twice
    // would collide on the unique index.
    const emails = [...new Set([r.email, ...(EXTRA_EMAILS[r.lot] ?? [])]
      .flatMap((e: string | null) => (e ?? '').split(/\n/))
      .map((e) => e.trim().toLowerCase()).filter(Boolean))]
    // Names that get an account, in household order, paired with a mailbox.
    const ordered = PRIMARY_NAME[r.lot]
      ? [PRIMARY_NAME[r.lot], ...names.filter((n) => n !== PRIMARY_NAME[r.lot])]
      : names
    const accounts = emails.map((email, i) => ({
      email, name: ordered[i] ?? ordered[0], phone: phones[i] ?? phones[0] ?? null,
    }))
    const occupants = ordered.slice(accounts.length)
    plan.push({ lot: r.lot, unitNumber: `Lot ${r.lot}`, accounts, occupants, raw: r })
  }

  console.log('household plan:\n')
  for (const h of plan) {
    console.log(`  Lot ${h.lot.padEnd(3)} accounts: ${h.accounts.map((a: any) => `${a.name} <${a.email}>`).join('  |  ')}`)
    if (h.occupants.length) console.log(`         occupants (no mailbox): ${h.occupants.join(', ')}`)
  }
  const total = plan.reduce((n, h) => n + h.accounts.length, 0)
  console.log(`\n${plan.length} households · ${total} accounts · ` +
              `${plan.reduce((n, h) => n + h.occupants.length, 0)} named occupants without a mailbox`)

  // Anybody already on the platform? An address that exists is a person, and
  // must not be duplicated or overwritten.
  const allEmails = plan.flatMap((h) => h.accounts.map((a: any) => a.email))
  const clash = await query<any>(
    `SELECT email FROM users WHERE lower(email) = ANY($1::text[])`, [allEmails])
  // An address already on GAM belongs to a real person and is never touched.
  // Lot 1's mailbox is one: the5ways2005@yahoo.com already exists as NANCY
  // Sheptock with role 'landlord' — created the day the property was set up,
  // never logged in, owning nothing. That is almost certainly a mis-click
  // during setup, but changing somebody's account role unattended is not a
  // call to make at 4am, so the household is left out and flagged instead.
  if (clash.length) {
    console.log(`\nALREADY ON GAM — household skipped, needs a human:`)
    for (const c of clash) {
      const who = await query<any>(
        `SELECT first_name, last_name, role, last_login_at FROM users WHERE lower(email)=$1`,
        [String(c.email).toLowerCase()])
      const w = who[0]
      const lots = plan.filter((h) => h.accounts.some((a: any) => a.email === String(c.email).toLowerCase()))
        .map((h) => `Lot ${h.lot}`).join(', ')
      console.log(`  ${c.email}  ->  ${w.first_name} ${w.last_name}, role=${w.role}, ` +
                  `last login ${w.last_login_at ?? 'never'}  (${lots})`)
    }
  }

  if (DRY) { console.log('\nDRY RUN — nothing written.'); process.exit(0) }

  const existing = new Set(clash.map((c: any) => String(c.email).toLowerCase()))
  const c = await getClient()
  let made = 0
  try {
    await c.query('BEGIN')
    // A password nobody holds. These accounts are placeholders until Blu signs
    // and the real invitation goes out, at which point the tenant sets their
    // own. Random rather than blank so no account is reachable meanwhile.
    for (const h of plan) {
      for (const a of h.accounts) {
        if (existing.has(a.email)) continue
        const { first, last } = firstLast(a.name)
        const hash = await bcrypt.hash(`mattoon-${Math.random().toString(36).slice(2)}-${Date.now()}`, 10)
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, email_verified)
           VALUES ($1,$2,'tenant',$3,$4,$5,FALSE) RETURNING id`,
          [a.email, hash, first, last, a.phone])
        await c.query(
          `INSERT INTO tenants (user_id, platform_status, onboarding_source)
           VALUES ($1,'active','onboarded')`, [u.rows[0].id])
        made++
      }
    }
    await c.query('COMMIT')
    console.log(`\ncreated ${made} account(s) — no invite token, no email sent`)
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
