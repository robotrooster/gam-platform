/**
 * 10/20 (Nic) — BRINGING THE RESERVATIONS THAT ALREADY EXIST ONTO THE BOARD.
 *
 *   "I said import because I'm importing a fucking schedule for people that are
 *    coming. I have other reservations that are texted to me. It's two
 *    things... I do want a file importer. I do... The file importer gets all my
 *    other reservations in there that were booked first. That's what I said.
 *    The old system has all the ones that have already booked. The people that
 *    have been texting me are the newer reservations. They don't get a spot if
 *    there's no spot to put them. That's why the importer happens first, and
 *    then the typed by hand ones come after."
 *
 * TWO DOORS, AND THE ORDER IS THE POINT.
 *
 *   'file' — the old system's own export. These guests booked FIRST, so they
 *            take their sites first, and several of them were promised a space
 *            by number. This is the master schedule and it goes in before
 *            anything else competes for the board.
 *   'hand' — the newer ones sitting in Nic's text threads, typed in AFTERWARDS,
 *            into whatever is left. "They don't get a spot if there's no spot to
 *            put them."
 *
 * Both doors run through this one function, which is the whole reason the order
 * can be relied on: hand-entry is not a different kind of write that might
 * behave differently, it is the same write with one row in it. It also means
 * the rule that matters most holds for both by construction —
 *
 * ── IT SENDS NOTHING. NOT ONE EMAIL. ─────────────────────────────────────────
 *
 *   "The import does not send the emails because one, you're going to be
 *    sending emails to people that don't need them... So I don't want the import
 *    to do anything. I just want it to import straight across."
 *
 * No confirmation, no deposit link, no site reveal, no stay-assistant link, no
 * waitlist note. That is not a flag that gets passed down through a chain of
 * services — it is the absence of any call that could send: this file inserts
 * rows and does nothing else, and a test counts every send across a whole batch
 * and fails on one. The reason is on the board right now: these guests have
 * already been told they are confirmed, several have already paid Nic a
 * deposit, and a blast is the worst thing this build could do to real
 * customers.
 *
 * ── THE PROMISED SITE, WHICH IS THE DANGEROUS ONE ────────────────────────────
 *
 *   "They may have already gotten a confirmation on a space number. Our system
 *    with compression and expansion is going to kind of screw that up if they
 *    think they're locked to a specific site already."
 *
 * A row that names a space was promised that space, so it is written with
 * locked_to_unit and a lock_reason of 'promised_before_gam' —
 * services/scheduleCompression and services/holdDisplacement both refuse to
 * move a locked stay, which is what stops a guest arriving to find somebody
 * else's rig on site 14. A row that names NO space is placed by GAM (the same
 * chooseFreeSite every other door uses) and left unlocked, so the packer can
 * keep moving it.
 *
 * And the PROMISES ARE TAKEN BEFORE THE PICKS — inside one file as well as
 * across the two doors. A promise is something a guest was already told; a pick
 * is GAM's own choice and is the one that is free to move, so a pick must never
 * be the thing standing on a space somebody was told they had. assessAndWrite
 * does the desk work on every row in file order and then goes to the board in
 * two passes, promises first; the long note there says what it cost to learn.
 *
 * ── WHEN TWO CLAIMS LAND ON ONE SITE, A PERSON SETTLES IT ────────────────────
 *
 * Never a guess. A promised site that something else already holds is a BLOCKER
 * on that row with both guests named: Nic picks another space, moves the other
 * reservation, or drops the row. Nothing is displaced to make room — a wrong
 * answer here is two rigs on one site, and no amount of cleverness is worth
 * that.
 */
import { parse as parseCsv } from 'csv-parse/sync'
import type { PoolClient } from 'pg'
import { DateTime } from 'luxon'
import { getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import {
  applyReservationMapping, dateIsAmbiguous, guestNameFrom, meansPaidWithoutAnAmount,
  migrationKey, parseMoney, parseNights, parseStayDate,
} from '../lib/reservationImportColumns'
import { findStayConflict, STAY_CONFLICT_MESSAGE } from './unitAvailability'
import { chooseFreeSite } from './propertyBooking'
import { scheduleStayPrice, siteIsFree } from './registerStay'

export type ReservationImportDoor = 'file' | 'hand'

/** How a deposit that never came through GAM was handed over. */
export const OFF_PLATFORM_DEPOSIT_METHODS = ['cash', 'check', 'money_order', 'bank_deposit', 'other'] as const
export type OffPlatformDepositMethod = typeof OFF_PLATFORM_DEPOSIT_METHODS[number]

/** One row on its way in — out of the file, or typed into the form. */
export interface ReservationImportRowInput {
  guestName?: string | null
  email?: string | null
  phone?: string | null
  propertyName?: string | null
  unitNumber?: string | null
  checkIn?: string | null
  checkOut?: string | null
  nights?: string | number | null
  totalAmount?: string | number | null
  depositPaid?: string | number | null
  depositMethod?: string | null
  depositRef?: string | null
  externalRef?: string | null
  notes?: string | null
  /** They have already been told they have this reservation. Default: yes. */
  toldOutsideGam?: boolean | null
  /** Columns the file carried that GAM has no field for. */
  extra?: Record<string, any> | null
}

export interface ReservationImportIssue {
  severity: 'block' | 'warn'
  field: string
  message: string
}

export interface AssessedReservationRow {
  rowIndex: number
  guestName: string
  email: string
  phone: string
  propertyName: string
  /** The space the file named, as the file wrote it. */
  unitNumber: string
  checkIn: string
  checkOut: string
  nights: number | null
  totalAmount: number | null
  depositPaid: number | null
  depositMethod: OffPlatformDepositMethod | null
  depositRef: string
  externalRef: string
  notes: string
  toldOutsideGam: boolean
  /** The site this row will land on, and the number to show for it. */
  siteId: string | null
  siteNumber: string | null
  /** They were promised this space, so nothing may move them off it. */
  lockedToSite: boolean
  /** GAM chose the site; it is not promised to them and may be moved. */
  placedByGam: boolean
  /** Already on the board from an earlier run of the same file. */
  alreadyIn: boolean
  issues: ReservationImportIssue[]
  extra: Record<string, any> | null
}

export interface ReservationImportAssessment {
  rows: AssessedReservationRow[]
  summary: {
    total: number
    blockers: number
    warnings: number
    ready: number
    alreadyIn: number
    locked: number
    placed: number
    depositsRecorded: number
    depositTotal: number
  }
  /** Things true of the FILE rather than of any one row. */
  notes: string[]
  /** Set on a commit: what actually went onto the board. */
  committed?: { created: number; skipped: number }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const str = (v: unknown) => String(v ?? '').trim()
/** A name with the spacing, case and punctuation taken out of it, for matching. */
const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Parse a file into rows GAM's fields, or say why it could not be read. */
export function parseReservationCsv(csv: string): { rows: ReservationImportRowInput[]; headers: string[]; raw: Record<string, any>[] } {
  let records: Record<string, any>[]
  try {
    records = parseCsv(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as any[]
  } catch (e: any) {
    throw new AppError(400, `That file could not be read as a CSV: ${e.message}`)
  }
  if (!records.length) throw new AppError(400, 'That file has a header row and nothing under it.')
  const headers = Object.keys(records[0])
  const mapped = applyReservationMapping(records)
  const rows: ReservationImportRowInput[] = mapped.map(m => ({
    guestName: guestNameFrom(m),
    email: str(m.email),
    phone: str(m.phone),
    propertyName: str(m.property_name),
    unitNumber: str(m.unit_number),
    checkIn: str(m.check_in),
    checkOut: str(m.check_out),
    nights: m.nights ?? null,
    totalAmount: m.total_amount ?? null,
    depositPaid: m.deposit_paid ?? null,
    // The file says a deposit is in; it does not say how it was handed over.
    // 'other' is the honest answer and the screen lets him correct it.
    depositMethod: null,
    depositRef: str(m.external_ref),
    externalRef: str(m.external_ref),
    notes: str(m.notes),
    extra: m._extra ?? null,
  }))
  return { rows, headers, raw: records.slice(0, 5) }
}

/**
 * The lease_type a stay of this length gets — the SAME three-way split the
 * reservation form uses (SchedulePage resvType), so an imported week and a
 * week taken at the desk read the same on the board.
 */
function leaseTypeForNights(nights: number): 'nightly' | 'weekly' | 'month_to_month' {
  return nights >= 30 ? 'month_to_month' : nights >= 7 ? 'weekly' : 'nightly'
}

/** Which rate has to exist for GAM to place a stay of this length. */
function stayUnitForNights(nights: number): 'night' | 'week' | 'month' {
  return nights >= 30 ? 'month' : nights >= 7 ? 'week' : 'night'
}

const nightsBetween = (checkIn: string, checkOut: string) => Math.round(
  DateTime.fromISO(checkOut).startOf('day').diff(DateTime.fromISO(checkIn).startOf('day'), 'days').days)

interface PropertyFacts {
  id: string
  landlord_id: string
  name: string
  timezone: string | null
  nightly_rate: string | null
  weekly_rate: string | null
  monthly_rate: string | null
  short_term_tax_rate: string | null
}

/**
 * EVERY SITE AT THIS PARK, BY THE NAME SOMEBODY WOULD TYPE.
 *
 * An old system writes "14", "RV 14", "Site 14" and "rv14" for the same space,
 * and Nic is not going to hand-edit 150 of them. So a site is matched on its
 * number with the spaces and the punctuation taken out, and on its bare digits
 * as well — "14" finds RV 14 as long as only one space at the park ends in 14.
 * Two that do is reported, never guessed between: a guess here puts a guest on
 * the wrong space.
 *
 * S605's print name is matched too (display_label), because that is the name the
 * lease prints and therefore the name the old system may have carried.
 */
async function siteIndex(client: Pick<PoolClient, 'query'>, propertyId: string): Promise<{
  byKey: Map<string, { id: string; unitNumber: string }[]>
}> {
  const sites = await client.query<{ id: string; unit_number: string; display_label: string | null; retired_at: string | null }>(
    `SELECT id, unit_number, display_label, retired_at FROM units WHERE property_id = $1 AND retired_at IS NULL`,
    [propertyId])
  const byKey = new Map<string, { id: string; unitNumber: string }[]>()
  const add = (key: string, site: { id: string; unitNumber: string }) => {
    if (!key) return
    const at = byKey.get(key)
    if (at) { if (!at.some(s => s.id === site.id)) at.push(site) } else byKey.set(key, [site])
  }
  for (const s of sites.rows) {
    const site = { id: s.id, unitNumber: s.unit_number }
    for (const name of [s.unit_number, s.display_label]) {
      if (!name) continue
      const squashed = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '')
      add(squashed, site)
      const digits = squashed.match(/(\d+)$/)
      if (digits) add(`#${digits[1].replace(/^0+(?=\d)/, '')}`, site)
    }
  }
  return { byKey }
}

function lookUpSite(
  index: { byKey: Map<string, { id: string; unitNumber: string }[]> },
  typed: string,
): { site: { id: string; unitNumber: string } | null; ambiguous: { id: string; unitNumber: string }[] | null } {
  const squashed = typed.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (!squashed) return { site: null, ambiguous: null }
  const exact = index.byKey.get(squashed)
  if (exact?.length === 1) return { site: exact[0], ambiguous: null }
  if (exact && exact.length > 1) return { site: null, ambiguous: exact }
  const bare = squashed.match(/^(\d+)$/)
  if (bare) {
    const byDigits = index.byKey.get(`#${bare[1].replace(/^0+(?=\d)/, '')}`)
    if (byDigits?.length === 1) return { site: byDigits[0], ambiguous: null }
    if (byDigits && byDigits.length > 1) return { site: null, ambiguous: byDigits }
  }
  return { site: null, ambiguous: null }
}

/**
 * TAKE THE SPACE BEFORE ASKING WHETHER IT IS FREE.
 *
 * The order is routes/units lockSitesForStays' and it is not a style choice:
 * the site's own row (FOR KEY SHARE) and then the site itself, because a pay
 * link being sent for a space takes the row and then waits for the space, and
 * anything that writes a stay the other way round ends both with a deadlock.
 *
 * Why it has to come BEFORE the free-check rather than after: every door that
 * writes a stay takes this same lock, so while it is held nobody else can
 * commit a reservation onto this space — which is what makes the answer to "is
 * it free" still true by the time the row is written. Checking first and locking
 * second leaves exactly the gap this whole lane exists to close: two
 * reservations, one pad.
 */
async function takeSite(client: PoolClient, siteId: string): Promise<void> {
  await client.query(`SELECT 1 FROM units WHERE id = $1 FOR KEY SHARE`, [siteId])
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unit-booking:${siteId}`])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`unit_booking:${siteId}`])
}

/** How many times a placement will try again when the space it picked was taken while it waited. */
const PLACEMENT_TRIES = 3

/**
 * THE WHOLE IMPORT, ONCE — as a preview, or for real.
 *
 * `commit: false` runs exactly the same code inside a transaction that is rolled
 * back, which is why the preview can be trusted: the sites GAM says it will
 * place people on are the sites it really picked, with the rows ahead of them in
 * the file already on the board, and an in-file collision shows up on the
 * preview screen instead of on arrival day. Nothing is written either way until
 * `commit` is true, and not one email goes out in either mode because there is
 * no send in this file to go out.
 */
export async function runReservationImport(opts: {
  landlordId: string
  propertyId: string
  door: ReservationImportDoor
  rows: ReservationImportRowInput[]
  byUserId: string
  commit: boolean
}): Promise<ReservationImportAssessment> {
  if (!opts.rows.length) throw new AppError(400, 'There are no reservations in that.')
  if (opts.rows.length > 1000) {
    throw new AppError(400, 'That is more than a thousand reservations in one go. Split the file by season or by park.')
  }
  const prop = await queryOne<PropertyFacts>(
    `SELECT id, landlord_id, name, timezone, nightly_rate::text, weekly_rate::text,
            monthly_rate::text, short_term_tax_rate::text
       FROM properties WHERE id = $1`, [opts.propertyId])
  if (!prop) throw new AppError(404, 'Property not found')
  if (prop.landlord_id !== opts.landlordId) throw new AppError(403, 'That property is not on this account.')

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const assessment = await assessAndWrite(client, prop, opts)
    if (opts.commit) {
      const blocked = assessment.rows.filter(r => r.issues.some(i => i.severity === 'block'))
      if (blocked.length) {
        await client.query('ROLLBACK')
        throw new AppError(400,
          `Row ${blocked[0].rowIndex + 1} still needs a look: ${blocked[0].issues.find(i => i.severity === 'block')!.message} `
          + `(${blocked.length} row${blocked.length === 1 ? '' : 's'} in all). Nothing was brought in.`)
      }
      await client.query('COMMIT')
    } else {
      await client.query('ROLLBACK')
    }
    return assessment
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** One row's turn on the board, once the desk work on it is done. */
interface PendingPlacement {
  row: AssessedReservationRow
  key: string | null
  checkIn: string
  checkOut: string
  nights: number
}

/**
 * A space this batch has already put somebody on — so when a second claim
 * lands on it the row can name WHO holds it and which line of the file they
 * are on, instead of leaving Nic to go and find them.
 */
interface BatchHold {
  rowIndex: number
  guestName: string
  siteId: string
  siteNumber: string
  checkIn: string
  checkOut: string
}

async function assessAndWrite(
  client: PoolClient,
  prop: PropertyFacts,
  opts: {
    landlordId: string; propertyId: string; door: ReservationImportDoor
    rows: ReservationImportRowInput[]; byUserId: string; commit: boolean
  },
): Promise<ReservationImportAssessment> {
  const index = await siteIndex(client, prop.id)
  // Every park this company runs, by its squashed name — so a row that names one
  // of the OTHERS is refused and a row that names something GAM has never heard
  // of is only queried.
  const otherParks = new Map<string, string>(
    (await client.query<{ name: string }>(
      `SELECT name FROM properties WHERE landlord_id = $1 AND id <> $2`, [opts.landlordId, prop.id]))
      .rows.map(r => [squash(r.name), r.name]))
  const notes: string[] = []
  const today = DateTime.now().setZone(prop.timezone || 'America/Phoenix').toISODate()!

  // 10/20 (Nic) — THE ORDER, SAID OUT LOUD WHERE HE CAN SEE IT. "That's why the
  // importer happens first, and then the typed by hand ones come after." A
  // texted reservation typed in before the old system's file has landed can take
  // a space an earlier booking was promised, and the only moment that is cheap
  // to fix is now. A warning, not a refusal: a park that genuinely has no old
  // file to bring in must not be locked out of typing its reservations in.
  if (opts.door === 'hand') {
    const brought = await client.query(
      `SELECT 1 FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = $1 AND b.migrated_door = 'file' LIMIT 1`, [prop.id])
    if (!brought.rows.length) {
      notes.push(
        `${prop.name}'s old schedule has not been brought in yet. The reservations in the old system were booked `
        + 'FIRST and several of them were promised a space, so bring that file in before typing these in — otherwise '
        + 'one of these can take a space an earlier booking is already promised.')
    }
  }

  const ambiguousDates = opts.rows.some(r => dateIsAmbiguous(r.checkIn) || dateIsAmbiguous(r.checkOut))
  if (ambiguousDates) {
    notes.push('Dates written 03/06/2027 are read American style — that one is March 6th, not the 3rd of June.')
  }

  const rows: AssessedReservationRow[] = []
  const keysInThisBatch = new Set<string>()
  /** Rows that got through the desk work and are owed a space, in file order. */
  const pending: PendingPlacement[] = []

  // ══ THE DESK WORK: every row, in the order the file lists them ═════════════
  //
  // Everything that can be settled by reading the row itself, and nothing that
  // has to ask the board whether a space is free. That question is asked in the
  // second pass below, where the order is different and the difference matters.
  for (let i = 0; i < opts.rows.length; i++) {
    const input = opts.rows[i]
    const issues: ReservationImportIssue[] = []
    const block = (field: string, message: string) => issues.push({ severity: 'block', field, message })
    const warn = (field: string, message: string) => issues.push({ severity: 'warn', field, message })

    const guestName = guestNameFrom({
      guest_name: input.guestName, first_name: null, last_name: null,
    })
    const email = str(input.email).toLowerCase()
    const phone = str(input.phone)
    const checkIn = parseStayDate(input.checkIn)
    let checkOut = parseStayDate(input.checkOut)
    const nightsGiven = parseNights(input.nights)

    // Departure from a night count, when that is all the file carried.
    if (!checkOut && checkIn && typeof nightsGiven === 'number') {
      checkOut = DateTime.fromISO(checkIn).plus({ days: nightsGiven }).toISODate()
    }

    if (!guestName) block('guestName', 'No name on this row — GAM cannot put a reservation on the board for nobody.')
    if (!checkIn) {
      block('checkIn', str(input.checkIn)
        ? `"${str(input.checkIn)}" could not be read as an arrival date — type it as 2027-03-06.`
        : 'No arrival date on this row.')
    }
    if (!checkOut) {
      block('checkOut', str(input.checkOut)
        ? `"${str(input.checkOut)}" could not be read as a departure date — type it as 2027-03-13.`
        : 'No departure date on this row, and no night count to work one out from.')
    }
    if (checkIn && checkOut && checkOut <= checkIn) {
      block('checkOut', 'They leave on or before the day they arrive. Check the dates.')
    }
    if (nightsGiven === undefined) warn('nights', 'The night count on this row could not be read; the dates decide.')

    const nights = checkIn && checkOut && checkOut > checkIn ? nightsBetween(checkIn, checkOut) : null
    if (nights != null && typeof nightsGiven === 'number' && nightsGiven !== nights) {
      warn('nights', `The file says ${nightsGiven} night${nightsGiven === 1 ? '' : 's'} but the dates are ${nights}. `
        + 'The dates win — check this one.')
    }
    if (checkOut && checkOut <= today) {
      warn('checkOut', 'This stay is already over. It will go on the board as history.')
    }

    // ── WHICH PARK THIS ROW IS FOR ───────────────────────────────────────────
    //
    // S633 is why this is asked at all: filing Mountain View's arrivals into Oak
    // Park's books is one wrong click and a season of wrong figures. But the
    // column that carries a park name in somebody else's export is also called
    // "Location", and a file whose Location column says "Loop B" would block
    // every row in it over nothing.
    //
    // So the test is whether the name is ANOTHER PARK ON THIS ACCOUNT. That is
    // the dangerous case and it is refused. A name GAM does not know is a label
    // out of the old system, and it gets a warning and comes in here.
    const propertyName = str(input.propertyName)
    if (propertyName && squash(propertyName) !== squash(prop.name)) {
      const elsewhere = otherParks.get(squash(propertyName))
      if (elsewhere) {
        block('propertyName', `This row says "${propertyName}", which is ${elsewhere} on this account, and you are `
          + `bringing reservations into ${prop.name}. Split the file by park.`)
      } else {
        warn('propertyName', `This row says "${propertyName}", which is not the name of any park on this account. `
          + `It is coming in at ${prop.name} — check that is right.`)
      }
    }

    // ── THE PROMISED SPACE ───────────────────────────────────────────────────
    const typedSite = str(input.unitNumber)
    let siteId: string | null = null
    let siteNumber: string | null = null
    let lockedToSite = false
    if (typedSite) {
      const found = lookUpSite(index, typedSite)
      if (found.ambiguous) {
        block('unitNumber', `"${typedSite}" matches ${found.ambiguous.map(s => s.unitNumber).join(' and ')} at `
          + `${prop.name}. Write the space out in full so nobody lands on the wrong one.`)
      } else if (!found.site) {
        block('unitNumber', `There is no space called "${typedSite}" at ${prop.name}. `
          + 'Correct it, or clear it and let GAM place them.')
      } else {
        siteId = found.site.id
        siteNumber = found.site.unitNumber
        lockedToSite = true
      }
    }

    const money = parseMoney(input.totalAmount)
    let totalAmount: number | null = money === undefined ? null : money
    if (money === undefined) {
      warn('totalAmount', `"${str(input.totalAmount)}" could not be read as a figure.`)
    }
    if (totalAmount != null && totalAmount < 0) {
      block('totalAmount', 'A stay total cannot be less than nothing.')
      totalAmount = null
    }

    // ── THE DEPOSIT THAT WAS PAID SOMEWHERE GAM WAS NOT ──────────────────────
    //
    // A file that says "Paid: Y" and nowhere says how much is the one case this
    // refuses outright. Writing the deposit as paid with no amount would leave
    // the arrival ticket raising the WHOLE stay (services/stayBalance bills
    // total minus the deposit), charging a guest their deposit twice.
    const depositMoney = parseMoney(input.depositPaid)
    let depositPaid: number | null = depositMoney === undefined ? null : depositMoney
    if (depositMoney === undefined) {
      if (meansPaidWithoutAnAmount(input.depositPaid)) {
        block('depositPaid', `This row says the deposit is paid ("${str(input.depositPaid)}") but not how much. `
          + 'Type the amount — a deposit with no figure would have the guest billed for it a second time on arrival.')
      } else {
        warn('depositPaid', `"${str(input.depositPaid)}" could not be read as a figure, so no deposit is recorded.`)
      }
    }
    if (depositPaid != null && depositPaid <= 0) depositPaid = null
    if (depositPaid != null && totalAmount != null && depositPaid > totalAmount) {
      warn('depositPaid', `The deposit on this row ($${depositPaid.toFixed(2)}) is more than the stay `
        + `($${totalAmount.toFixed(2)}). Nothing will be billed on arrival — check both figures.`)
    }
    const depositMethod = OFF_PLATFORM_DEPOSIT_METHODS.includes(str(input.depositMethod) as OffPlatformDepositMethod)
      ? str(input.depositMethod) as OffPlatformDepositMethod
      : null
    if (depositPaid != null && !depositMethod) {
      warn('depositMethod', 'How this deposit was handed over is not recorded. It is written down as taken outside '
        + 'GAM either way; say cash or check if you know which.')
    }

    if (!email) {
      warn('email', 'No email on this row. GAM cannot send this guest their confirmation, their deposit link or '
        + 'their balance on arrival day until one is on the reservation.')
    }
    if (!phone && !email) {
      warn('phone', 'No email and no phone — there is no way to reach this guest at all.')
    }

    // ── PRICE ────────────────────────────────────────────────────────────────
    //
    // THE FIGURE THE GUEST WAS ALREADY QUOTED WINS. They were told a price in
    // the old system, and re-pricing it here would put one number in their
    // confirmation and a different one on their arrival ticket. The rate card
    // only fills in a row that carries no figure at all — the same order
    // routes/units uses when a clerk prices a site that has no rate card.
    if (totalAmount == null && checkIn && checkOut && nights != null) {
      const rateSite = siteId
        ? (await client.query<any>(
            `SELECT nightly_rate, weekly_rate, monthly_rate FROM units WHERE id = $1`, [siteId])).rows[0]
        : null
      const priced = scheduleStayPrice(
        { nightly: rateSite?.nightly_rate ?? prop.nightly_rate,
          weekly: rateSite?.weekly_rate ?? prop.weekly_rate,
          monthly: rateSite?.monthly_rate ?? prop.monthly_rate },
        prop.short_term_tax_rate, checkIn, checkOut)
      if (priced.total > 0) {
        totalAmount = priced.total
        warn('totalAmount', `No figure in the file, so this is the park's own price for those nights `
          + `($${priced.total.toFixed(2)}).`)
      } else {
        warn('totalAmount', 'No figure in the file and no rate set for a stay this long, so this reservation '
          + 'carries no price. Nothing will be raised on the day they arrive until one is typed in.')
      }
    }

    // ── IS IT ALREADY ON THE BOARD? ──────────────────────────────────────────
    const key = checkIn && checkOut && guestName
      ? migrationKey({ propertyId: prop.id, externalRef: input.externalRef, guestName, checkIn, checkOut })
      : null
    let alreadyIn = false
    if (key) {
      if (keysInThisBatch.has(key)) {
        alreadyIn = true
        warn('externalRef', 'The same reservation appears earlier in this file. Only the first one goes on the board.')
      } else {
        keysInThisBatch.add(key)
        const existing = await client.query<{ id: string; unit_number: string }>(
          `SELECT b.id, u.unit_number FROM unit_bookings b JOIN units u ON u.id = b.unit_id
            WHERE b.landlord_id = $1 AND b.migration_key = $2 LIMIT 1`, [opts.landlordId, key])
        if (existing.rows.length) {
          alreadyIn = true
          warn('externalRef', `Already brought in — this guest is on the board on ${existing.rows[0].unit_number}. `
            + 'This row changes nothing.')
        }
      }
    }

    const row: AssessedReservationRow = {
      rowIndex: i,
      guestName, email, phone,
      propertyName,
      unitNumber: typedSite,
      checkIn: checkIn ?? '',
      checkOut: checkOut ?? '',
      nights,
      totalAmount,
      depositPaid,
      depositMethod,
      depositRef: str(input.depositRef),
      externalRef: str(input.externalRef),
      notes: str(input.notes),
      // Both doors are reservations the guest has ALREADY been told about — the
      // old system confirmed them, or Nic answered the text. Off is the
      // deliberate exception, per row, for somebody who has not actually heard.
      toldOutsideGam: input.toldOutsideGam !== false,
      siteId, siteNumber, lockedToSite, placedByGam: false, alreadyIn,
      issues,
      extra: input.extra ?? null,
    }
    rows.push(row)

    // A row that is otherwise sound and is actually going on gets a turn on the
    // board below. The rest never reach it: there is nothing to place.
    const sound = !issues.some(iss => iss.severity === 'block')
    if (sound && !alreadyIn && checkIn && checkOut && nights != null) {
      pending.push({ row, key, checkIn, checkOut, nights })
    }
  }

  // ══ THE BOARD: PROMISES FIRST, THEN GAM'S PICKS ═══════════════════════════
  //
  // 10/20 — WHY THIS IS A SECOND PASS AND NOT THE SAME LOOP.
  //
  // Taking the spaces in the order the file happens to list them let a row GAM
  // PLACED take a space a LATER row had been PROMISED. Mountain View's season
  // file is the case: row 3 carries no space, row 40 says "RV 01" because that
  // guest was told RV 01. Row 3 went first, the board was empty, best-fit broke
  // the tie on unit number — so row 3 landed on RV 01, and row 40, the one
  // guest of the pair who had actually been promised it, was the row refused.
  // The only ways out of that on the preview screen were to type a different
  // space over the promise or to drop the guest, and Nic could not clear row 3's
  // space to free it up because row 3 never named one. Worse, every GAM-placed
  // row marches down from the lowest numbers, which is exactly where an old
  // system's promises live.
  //
  // So a promise is settled before any pick inside one file — the same way the
  // file door goes before the hand door across files, and for the same reason.
  // A promise is something a guest was already told. A pick is GAM's own choice,
  // and GAM's choice is the one that is free to move.
  const holds: BatchHold[] = []
  const promisedThenPicked = [
    ...pending.filter(p => p.row.lockedToSite),
    ...pending.filter(p => !p.row.lockedToSite),
  ]
  for (const p of promisedThenPicked) {
    const { row, checkIn, checkOut, nights } = p
    const block = (field: string, message: string) => row.issues.push({ severity: 'block', field, message })
    const warn = (field: string, message: string) => row.issues.push({ severity: 'warn', field, message })

    if (row.siteId) {
      // The space is taken first (see takeSite) and only then asked about, so
      // the answer cannot go stale between the question and the write.
      await takeSite(client, row.siteId)
      // What the board already committed says, with its own words for every
      // reason a site is not free (a lease, the owner's use, out-of-order
      // nights, a tenant onboarding) — asked of the pool, so it reads what is
      // committed rather than this batch.
      const conflict = await findStayConflict(row.siteId, { checkIn, checkOut })
      if (conflict) {
        const who = conflict === 'booking'
          ? (await client.query<{ guest_name: string | null; status: string }>(
              `SELECT guest_name, status FROM unit_bookings
                WHERE unit_id = $1 AND status <> 'cancelled' AND check_in < $2::date AND check_out > $3::date
                ORDER BY check_in LIMIT 1`, [row.siteId, checkOut, checkIn])).rows[0]
          : null
        block('unitNumber',
          `${row.siteNumber} is not free ${checkIn} to ${checkOut} — ${STAY_CONFLICT_MESSAGE[conflict].toLowerCase()}`
          + `${who?.guest_name ? ` (${who.guest_name})` : ''}. This guest was promised ${row.siteNumber}, so nobody is `
          + 'moved automatically: give this one another space, move the other reservation, or leave this row out.')
      } else if (!await siteIsFree(client, row.siteId, checkIn, checkOut)) {
        // Only this batch can be holding it now, and after the ordering above
        // that can only be ANOTHER PROMISED row — a pick is taken after every
        // promise in the file, so a pick can no longer be the thing in the way.
        // Both guests really were promised this space, and the row says which
        // other line of the file the other one is on so Nic can read them side
        // by side. Nothing is displaced: a wrong answer here is two rigs on one
        // pad.
        const clash = holds.find(h =>
          h.siteId === row.siteId && h.checkIn < checkOut && h.checkOut > checkIn)
        block('unitNumber', `Another row in this file is already on ${row.siteNumber} over those nights`
          + `${clash ? ` — row ${clash.rowIndex + 1}, ${clash.guestName}` : ''}. `
          + 'Two reservations were promised one space — settle which one keeps it.')
      }
    } else {
      // Nobody was promised anything, so GAM picks: the same sites and the
      // same best-fit order the booking site and a pay link use
      // (services/propertyBooking chooseFreeSite). Given this transaction's
      // own client, so the rows already placed above are seen — the file's
      // own rows cannot be stacked onto one space, and neither can a pick
      // land on a space a promise in this same file has already taken.
      let picked: { id: string; unitNumber: string } | null = null
      // A candidate this row has already had to refuse. Without it the picker
      // scores every try against the same board (rankUnitsBestFit reads the
      // pool) and hands back the same space three times over, and the row ends
      // up told the park is full while other spaces sit empty.
      const refused: string[] = []
      for (let tries = 0; tries < PLACEMENT_TRIES; tries++) {
        const candidate = await chooseFreeSite(client, {
          propertyId: prop.id, landlordId: opts.landlordId,
          checkIn, checkOut, stayUnit: stayUnitForNights(nights),
          excludeUnitIds: refused,
        })
        if (!candidate) break
        // Taken, then asked again: somebody else may have committed a stay
        // onto it while this waited for the lock, and the next try sees that
        // and picks elsewhere.
        await takeSite(client, candidate.id)
        const taken = await findStayConflict(candidate.id, { checkIn, checkOut })
          || !await siteIsFree(client, candidate.id, checkIn, checkOut)
        if (!taken) { picked = candidate; break }
        refused.push(candidate.id)
      }
      if (!picked) {
        block('unitNumber', `Nothing to put them on at ${prop.name} for ${checkIn} to ${checkOut}. `
          + 'A space has to be switched on for stays and have a rate for a stay this long. '
          + 'Name a space on this row, or make room.')
      } else {
        row.siteId = picked.id
        row.siteNumber = picked.unitNumber
        row.placedByGam = true
      }
    }

    // The write. Inside the same transaction as everything above, which is what
    // lets the next placement see this one. On a preview the transaction is
    // rolled back and nothing of this survives.
    if (row.siteId && !row.alreadyIn && !row.issues.some(iss => iss.severity === 'block')) {
      const wrote = await writeMigratedReservation(
        client, { prop, row, door: opts.door, byUserId: opts.byUserId, key: p.key })
      if (!wrote) {
        // Somebody else's import put this exact reservation on the board between
        // the look above and this write. Nothing was written twice (the key's
        // unique index saw to that) and the row says so rather than claiming a
        // guest was brought in who was already there.
        row.alreadyIn = true
        warn('externalRef', 'This reservation went on the board a moment ago from somewhere else. '
          + 'Nothing was written twice.')
      } else {
        holds.push({
          rowIndex: row.rowIndex, guestName: row.guestName,
          siteId: row.siteId, siteNumber: row.siteNumber!, checkIn, checkOut,
        })
      }
    }
  }

  const blockers = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'block').length, 0)
  const warnings = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warn').length, 0)
  const going = rows.filter(r => !r.alreadyIn && !r.issues.some(i => i.severity === 'block'))
  return {
    rows,
    summary: {
      total: rows.length,
      blockers,
      warnings,
      ready: going.length,
      alreadyIn: rows.filter(r => r.alreadyIn).length,
      locked: going.filter(r => r.lockedToSite).length,
      placed: going.filter(r => r.placedByGam).length,
      depositsRecorded: going.filter(r => r.depositPaid != null).length,
      depositTotal: round2(going.reduce((s, r) => s + (r.depositPaid ?? 0), 0)),
    },
    notes,
    committed: opts.commit
      ? { created: going.length, skipped: rows.filter(r => r.alreadyIn).length }
      : undefined,
  }
}

/**
 * One reservation onto the board — and NOTHING else. No email, no deposit link,
 * no site reveal, no lease draft, no screening, no waitlist. Nic: "the import
 * should just be an import."
 *
 * Written under the space's own lock, taken before the free-check above (see
 * takeSite for the order and why it is that way round).
 */
async function writeMigratedReservation(
  client: PoolClient,
  o: {
    prop: PropertyFacts
    row: AssessedReservationRow
    door: ReservationImportDoor
    byUserId: string
    key: string | null
  },
): Promise<boolean> {
  const { row } = o
  // The space was taken before it was asked about (takeSite above) and the lock
  // is this transaction's until it ends, so the row is written under it.
  await takeSite(client, row.siteId!)

  const nights = row.nights!
  // A deposit paid in the old system was paid before today, and the day is not
  // in the file. The day it was brought in is the honest stamp: it says "this
  // money is in" without claiming a date nobody recorded. The method and the
  // reference beside it say where it really came from.
  const wrote = await client.query(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, guest_phone,
        lease_type, check_in, check_out, booked_check_out, nights,
        total_amount, platform_fee, status, source, notes,
        locked_to_unit, lock_reason,
        deposit_amount, deposit_paid_at, deposit_off_platform_method, deposit_off_platform_ref,
        migrated_at, migrated_by, migrated_door, migration_key, told_outside_gam, import_extra_data)
     VALUES ($1,$2,$3,$4,$5,
             $6,$7,$8,$8,$9,
             $10,0,'confirmed','direct',$11,
             $12,$13,
             $14,$15,$16,$17,
             NOW(),$18,$19,$20,$21,$22::jsonb)
     ON CONFLICT (landlord_id, migration_key) WHERE migration_key IS NOT NULL DO NOTHING`,
    [
      row.siteId, o.prop.landlord_id, row.guestName, row.email || null, row.phone || null,
      leaseTypeForNights(nights), row.checkIn, row.checkOut, nights,
      row.totalAmount, row.notes || null,
      row.lockedToSite, row.lockedToSite ? 'promised_before_gam' : null,
      row.depositPaid, row.depositPaid != null ? new Date() : null,
      row.depositPaid != null ? (row.depositMethod ?? 'other') : null,
      row.depositPaid != null ? (row.depositRef || null) : null,
      o.byUserId, o.door, o.key, row.toldOutsideGam,
      row.extra ? JSON.stringify(row.extra) : null,
    ])
  return (wrote.rowCount ?? 0) > 0
}

/**
 * The review queue's record of the attempt — the same queue the tenant,
 * property and payment importers write to (services/csvImportAttempts), so a
 * reservations file from somebody else's software is reviewed in the one place
 * rather than a second one nobody remembers to look at. Best-effort, always:
 * the import itself must never fail because the queue did.
 */
export async function recordReservationImportAttempt(o: {
  landlordId: string
  headers: string[]
  sampleRows: Record<string, any>[]
  rowCount: number
  blockers: number
  warnings: number
  committed: boolean
  claimedPlatformName?: string | null
}): Promise<void> {
  try {
    const {
      recordValidateAttempt, recordCommitAttempt, notifyCsvReviewPendingIfNeeded,
    } = await import('./csvImportAttempts')
    const shared = {
      landlordId: o.landlordId,
      importType: 'reservation' as const,
      platformKey: 'generic',
      claimedPlatformName: o.claimedPlatformName ?? null,
      columnHeaders: o.headers,
      sampleRows: o.sampleRows,
      rowCount: o.rowCount,
    }
    if (o.committed) await recordCommitAttempt(shared)
    else await recordValidateAttempt({ ...shared, blockers: o.blockers, warnings: o.warnings })
    await notifyCsvReviewPendingIfNeeded({
      landlordId: o.landlordId, importType: 'reservation', platformKey: 'generic',
      source: o.committed ? 'commit' : 'validate', claimedPlatformName: o.claimedPlatformName ?? null,
    })
  } catch (err) {
    logger.error({ err, ctx: o.landlordId }, '[reservation-import] review-queue record failed')
  }
}

/** Has this park's old schedule been brought in? The schedule asks, to say so. */
export async function fileImportLanded(propertyId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM unit_bookings b JOIN units u ON u.id = b.unit_id
      WHERE u.property_id = $1 AND b.migrated_door = 'file' LIMIT 1`, [propertyId])
  return r.length > 0
}
