/**
 * THE GUARD ON THE ONE NOTIFICATION LIST.
 *
 * 10/20 (Nic): "I don't want you to switch off three remaining email settings
 * when you said there's five critical things and 22 other ones that weren't even
 * on the list. Like, you're thinking too narrow. I want you to fix the root, not
 * just one off because one landlord wants a setting a certain way. We're fixing
 * root problems here."
 *
 * The root was that types were added over months while the settings pages were
 * hand-written subsets, and services/notifications treats a missing preference
 * row as email-on. So a landlord unchecked everything he could see and kept
 * getting email from twenty-two types that had no box anywhere.
 *
 * Two things stop that now, and this file is the second:
 *
 *   1. THE COMPILER. createNotification takes `type: NotificationType`, the
 *      union derived from NOTIFICATION_CATALOG. A type that is not in the
 *      catalog does not compile — `npx tsc -b` in apps/api is the real guard.
 *
 *   2. THIS FILE, for the things a type cannot catch: a type string that reaches
 *      the notify path through a cast or a raw INSERT, an entry with no human
 *      label, a critical type that does not say why it cannot be switched off,
 *      and the types production has actually sent going missing from the list.
 *
 * ── AND THE SECOND ROAD ──────────────────────────────────────────────────────
 * createNotification is ONE of two ways GAM emails somebody. The other is the
 * fifty-odd senders in services/email.ts that call send() directly and write no
 * notification row at all — the 7am overdue digest, the monthly bill, the
 * payment receipt, the signing request and its reminders, the monthly property
 * report. Every one of them still reached Blu Haws after he answered all 90 of
 * his rows, because the compiler and this file only ever looked at the first
 * road.
 *
 * So every email category is declared once in packages/shared/src/emailCategories
 * as either a notification the recipient may decline or a transactional email
 * with the reason it always goes, and the tests at the bottom of this file prove
 * three things about it: every category stamped in services/email.ts is
 * declared, every declared gate names a real catalog type, and the catalog's
 * `inAppOnly` flag matches which types actually have an emailing sender on
 * EITHER road — so a row can never again show an Email box for mail that
 * cannot arrive, or hide one for mail that can.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import {
  NOTIFICATION_CATALOG, NOTIFICATION_TYPES, NOTIFICATION_GROUPS, NOTIFICATION_GROUP_LABEL,
  CRITICAL_NOTIFICATION_TYPES, RETIRED_NOTIFICATION_TYPES,
  isKnownNotificationType, notificationLabel, notificationCatalogFor, notificationGroupsFor,
  notificationEntry, NOTIFICATION_TYPES_EMAILED_BY_CATEGORY,
  EMAIL_CATEGORY_RULES, UNGATED_NOTIFICATION_EMAIL_TYPES,
  UNGATED_NOTIFICATION_EMAIL_PREFIXES, NOTIFICATION_EMAIL_CATEGORY_PREFIX,
  emailGateFor, emailCategoryLabel,
} from '@gam/shared'

const API_SRC = join(__dirname, '..')

// ─── The scanner ────────────────────────────────────────────────────────────
//
// Pulls the `type:` string literals out of every createNotification call in a
// file, plus the ones handed to a raw `INSERT INTO notifications`. It is a
// plain function over source text so the "it fails when a type is missing" test
// below can feed it a snippet instead of breaking the real catalog.

/** The argument text inside the parens starting at `open`, quotes respected. */
function balanced(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i) }
    else if (c === '\'' || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) break
        i++
      }
    }
  }
  return src.slice(open + 1)
}

/**
 * The types one file can put on the notify path, and whether any of its call
 * sites for each type EMAILS.
 *
 * 10/20: the channel is new, and it is the whole point. The old scanner
 * answered "does a sender exist", which is why "nothing on the page is a switch
 * for email that never arrives" passed while thirty rows carried an Email box
 * for a notice that is written in the app and emailed nowhere. Unticking one of
 * those did nothing at all.
 */
export function typesEmittedIn(src: string): Array<{ type: string; emails: boolean }> {
  const found = new Map<string, boolean>()
  const add = (type: string, emails: boolean) => found.set(type, (found.get(type) ?? false) || emails)
  const re = /createNotification\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const arg = balanced(src, m.index + m[0].length - 1)
    // The first `type:` key in the object, and every quoted snake_case value on
    // that line — which is how a `cond ? 'a' : 'b'` site is picked up.
    const key = /(?<![a-zA-Z_])type\s*:\s*([^\n]*)/.exec(arg)
    if (!key) continue
    // A value like `o.decision === 'approved' ? 'sublease_approved' : 'sublease_denied'`
    // holds a literal that is a COMPARISON, not a type. Drop those first, or
    // the scanner reports 'approved' and 'completed' as notification types.
    const value = key[1].replace(/(?:===|!==|==|!=)\s*'[^']*'/g, '')
    // Does THIS site email? `sendEmail: true`, a variable, or a spread that
    // sets it — anything but a literal false. A site with no `sendEmail` at all
    // writes the in-app row and nothing else.
    const sendEmail = /(?<![a-zA-Z_])sendEmail\s*:\s*([^\n,}]*)/.exec(arg)
    const emails = !!sendEmail && sendEmail[1]!.trim() !== 'false'
    for (const lit of value.matchAll(/'([a-z][a-z0-9_]{2,})'|"([a-z][a-z0-9_]{2,})"/g)) {
      add(lit[1] ?? lit[2]!, emails)
    }
  }
  // A raw insert, e.g. services/utilityBilling writing on a caller's client.
  //
  // 10/20: `tenant_notifications` too — a SECOND notification table, read by
  // the renter-pool portal. This regex did not look at it, so 'match_interest'
  // sat in neither the catalog nor the retired list, had no switch on any page,
  // and the suite stayed green. A raw insert never emails by itself; the mail
  // that goes with one is a category in emailCategories.
  for (const ins of src.matchAll(/INSERT INTO (?:tenant_)?notifications\b[\s\S]{0,400}?'([a-z][a-z0-9_]{2,})'/g)) {
    add(ins[1]!, false)
  }
  return [...found].map(([type, emails]) => ({ type, emails }))
}

/** The type strings only, for the readers that do not care which channel. */
export function typeLiteralsEmittedIn(src: string): string[] {
  return typesEmittedIn(src).map(e => e.type)
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue }
    if (!name.endsWith('.ts')) continue
    if (name.includes('.test.')) continue
    // The demo seeder writes rows for a walkthrough; it is not a sender.
    if (full.endsWith(join('scripts', 'seedDemo.ts'))) continue
    out.push(full)
  }
  return out
}

/** Every type string the API can put on the notify path, with where it came from. */
function emittedTypes(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of sourceFiles(API_SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const t of typeLiteralsEmittedIn(src)) {
      out.set(t, [...(out.get(t) ?? []), file.slice(API_SRC.length + 1)])
    }
  }
  return out
}

/** The subset of those that some call site actually EMAILS. */
function emailingTypes(): Set<string> {
  const out = new Set<string>()
  for (const file of sourceFiles(API_SRC)) {
    for (const e of typesEmittedIn(readFileSync(file, 'utf8'))) if (e.emails) out.add(e.type)
  }
  return out
}

/**
 * Catalog entries the scanner cannot find a sender for, each with the reason it
 * stays on the page anyway. Anything else unsendable is drift in the other
 * direction — a switch for email that never arrives, which is what 'Rent failed'
 * and 'Disbursement sent' were for months — and the test below fails on it.
 */
interface IndirectSender {
  /** The file that sends it, checked below for the type string still being there. */
  readonly file: string
  /**
   * 10/20: whether that helper EMAILS, or only writes the in-app row. The
   * scanner cannot read it off a call whose type is in a variable, so it is
   * declared — and the `inAppOnly` test below holds the catalog to it, so a
   * wrong answer here shows up as a wrong Email column, not as silence.
   */
  readonly emails: boolean
}

const SENT_INDIRECTLY: Record<string, IndirectSender> = {
  // The type is held in a variable or handed to a local forwarding helper, so
  // the scanner cannot see a literal at the createNotification call. Every one
  // of those helpers takes NotificationType, so the COMPILER already proves
  // these are real catalog types — this names the file that sends each one, and
  // the test below fails if the type string is no longer in that file. That is
  // what stops this list going stale the way the settings pages did.
  autopay:                    { file: 'jobs/autopayRunner.ts',     emails: false },
  // returnedCheck's `tell()` passes sendEmail when the person has an address.
  bank_returned_check:        { file: 'services/returnedCheck.ts', emails: true  },
  lease_drafted_from_booking: { file: 'services/stayTerms.ts',     emails: false },
  long_stay_no_lease:         { file: 'services/stayTerms.ts',     emails: false },
  stay_utilities_not_billed:  { file: 'services/stayTerms.ts',     emails: false },
  stay_lease_not_ended:       { file: 'services/earlyCheckOut.ts', emails: false },
  stay_refund_failed:         { file: 'services/earlyCheckOut.ts', emails: false },
  stay_money_decision:        { file: 'services/earlyCheckOut.ts', emails: false },
  utility_meter_broken:       { file: 'services/utilityBilling.ts', emails: false },
  pay_link_paid_twice:        { file: 'routes/posPayLinks.ts',     emails: false },
  pay_link_over_owed:         { file: 'routes/posPayLinks.ts',     emails: false },
  pay_link_deposit_part:      { file: 'routes/posPayLinks.ts',     emails: false },
  pay_link_amount_mismatch:   { file: 'routes/posPayLinks.ts',     emails: false },
  pay_link_paid_after_close:  { file: 'routes/posPayLinks.ts',     emails: false },
}

const NO_SENDER_YET: Record<string, string> = {
  // 10/20: nothing in the API emits 'payment_failed'. It is one of Nic's five
  // critical types and the delivery code honors it, so the switch stays on the
  // page, locked, as he asked. The notices that actually carry "your rent
  // payment failed" today are ach_retries_exhausted, flexdeposit_payment_failed
  // and bank_returned_check — none of them critical. Flagged for Nic; promoting
  // them is his call, not a quiet edit here.
  payment_failed: 'declared critical by Nic (S570); no sender in the API today',
  // jobs/birthdayEmails sends this one itself (an email with no in-app row), so
  // it reads notification_preferences directly instead of createNotification.
  birthday: 'sent by jobs/birthdayEmails, which reads the preference directly',
}

// ─── The scanner itself ─────────────────────────────────────────────────────

describe('the scanner that finds notification types in the source', () => {
  it('finds a plain type, a ternary and a raw insert', () => {
    const found = typeLiteralsEmittedIn(`
      await createNotification({ userId, type: 'rent_collected', title: 'x', body: 'y' })
      await createNotification({ userId, type: cond ? 'lease_expiring' : 'lease_non_renewal', title: 'x', body: 'y' })
      await run(\`INSERT INTO notifications (user_id, type) VALUES ($1, 'utility_meter_broken')\`)
    `)
    expect(found.sort()).toEqual(
      ['lease_expiring', 'lease_non_renewal', 'rent_collected', 'utility_meter_broken'])
  })

  // The requirement, proved: a type that can be sent but is not in the list
  // fails the check. This is the shape of the failure a future session would
  // get for adding a sender without a catalog entry.
  it('FAILS when a type can be sent but is not in the list', () => {
    const found = typeLiteralsEmittedIn(
      `await createNotification({ userId, type: 'brand_new_thing', title: 'x', body: 'y' })`)
    expect(found).toContain('brand_new_thing')
    const missing = found.filter(t => !isKnownNotificationType(t))
    expect(missing).toEqual(['brand_new_thing'])
  })

  // And the same failure from the other side: dropping an entry from the list
  // while its sender is still there.
  it('FAILS when an entry is removed from the list but its sender stays', () => {
    const withoutRentCollected = NOTIFICATION_TYPES.filter(t => t !== 'rent_collected')
    const found = typeLiteralsEmittedIn(
      `await createNotification({ userId, type: 'rent_collected', title: 'x', body: 'y' })`)
    expect(found.filter(t => !withoutRentCollected.includes(t as any))).toEqual(['rent_collected'])
  })
})

// ─── The list is complete ───────────────────────────────────────────────────

describe('every notification GAM can send is in the catalog', () => {
  it('no type reaches the notify path without an entry', () => {
    const unknown: string[] = []
    for (const [type, files] of emittedTypes()) {
      if (!isKnownNotificationType(type)) unknown.push(`${type} (${files.join(', ')})`)
    }
    expect(unknown,
      'Add these to NOTIFICATION_CATALOG in packages/shared/src/notificationCatalog.ts ' +
      'with a label, a one-line "when it fires", an audience and a group — a type with no ' +
      'entry has no switch on the settings page, and a missing row means email ON.',
    ).toEqual([])
  })

  it('a retired type is never also on the page', () => {
    const both = NOTIFICATION_TYPES.filter(t => RETIRED_NOTIFICATION_TYPES.includes(t))
    expect(both).toEqual([])
  })

  it.each(Object.entries(SENT_INDIRECTLY).map(([t, s]) => [t, s.file] as const))(
    '%s is still sent from %s', (type, file) => {
      const src = readFileSync(join(API_SRC, file), 'utf8')
      expect(src.includes(`'${type}'`),
        `${type} is listed as sent from ${file}, and it is not in that file any more. ` +
        'Either point this at the file that sends it now, or retire the type.',
      ).toBe(true)
    })

  it('nothing on the page is a switch for email that never arrives', () => {
    const senders = emittedTypes()
    // THE SECOND ROAD, which the scanner above can never see. About fifty
    // senders in services/email.ts never touch createNotification — they stamp
    // a `category` on the mail and send it. Those are real notices with a real
    // switch: emailCategories declares each category's gate type and send()
    // reads the recipient's preference before the mail goes out. Ten of them
    // read as orphans here otherwise — the morning overdue digest, the monthly
    // bill, the payment receipt, the background-check result, the two e-sign
    // notices, the two renter-pool notices and the monthly property report —
    // every one of which Blu Haws was still receiving with 90 boxes unchecked.
    // Read from the declaration rather than re-listed here, so a new gated
    // category counts the moment somebody declares it. That is the only version
    // of this test that cannot go stale the way the settings pages did.
    const byEmail = new Set<string>(NOTIFICATION_TYPES_EMAILED_BY_CATEGORY)
    const orphans = NOTIFICATION_TYPES
      .filter(t => !senders.has(t) && !byEmail.has(t)
                && !(t in SENT_INDIRECTLY) && !(t in NO_SENDER_YET))
    expect(orphans,
      'Either delete these from the catalog (and add them to RETIRED_NOTIFICATION_TYPES) or ' +
      'name them in NO_SENDER_YET with the reason. A switch for a notification nothing sends ' +
      'is what "Rent failed" and "Disbursement sent" were — boxes a landlord unchecked for ' +
      'email that never existed.',
    ).toEqual([])
  })

  /**
   * ── THE EMAIL COLUMN TELLS THE TRUTH ────────────────────────────────────
   *
   * 10/20: the test above only ever asked whether SOME createNotification call
   * existed for a type — never whether any of them emailed. Thirty-two catalog
   * types had no emailing call site at all, and twenty-five of those sat on the
   * landlord's page with a tickable Email box. Unticking one did nothing,
   * because nothing has ever emailed it; two of them were boxes Blu actually
   * bothered to uncheck. By the rule that retired 'Rent failed' and
   * 'Disbursement sent' — "a box for mail that cannot arrive is noise" — those
   * thirty rows were the same defect, measured by the same test that was
   * supposed to catch it.
   *
   * They are marked `inAppOnly` now and the page prints a dash instead of a
   * box. This holds that flag to what the code actually does, on BOTH roads:
   * an emailing createNotification call site, a declared emailing helper, or a
   * category in emailCategories that gates on the type.
   */
  it('inAppOnly is set on exactly the types nothing emails', () => {
    const direct = emailingTypes()
    const byCategory = new Set<string>(NOTIFICATION_TYPES_EMAILED_BY_CATEGORY)
    const emails = (t: string) =>
      direct.has(t) || byCategory.has(t) || SENT_INDIRECTLY[t]?.emails === true

    const wronglyFlagged = NOTIFICATION_CATALOG
      .filter(e => e.inAppOnly && emails(e.type)).map(e => e.type)
    expect(wronglyFlagged,
      'These are marked inAppOnly but something emails them, so the page prints a dash where ' +
      'a person needs a switch — mail they cannot decline. Clear the flag.',
    ).toEqual([])

    const missingFlag = NOTIFICATION_CATALOG
      // The locked five are never shown with a switch at all, so the flag does
      // not apply to them; `payment_failed` has no sender yet either way.
      .filter(e => !e.critical && !e.inAppOnly && !emails(e.type)).map(e => e.type)
    expect(missingFlag,
      'Nothing emails these, so their Email box controls nothing — unticking it is a no-op and ' +
      'it inflates "N of M optional emails are on". Either give them a sender that emails, or ' +
      'mark them inAppOnly so the page prints a dash.',
    ).toEqual([])
  })

  it('a critical type is never marked inAppOnly — its email is forced on', () => {
    expect(NOTIFICATION_CATALOG.filter(e => e.critical && e.inAppOnly).map(e => e.type)).toEqual([])
  })

  it('no entry claims to be both email-only and in-app-only', () => {
    expect(NOTIFICATION_CATALOG.filter(e => e.emailOnly && e.inAppOnly).map(e => e.type)).toEqual([])
  })

  it('a retired type has really lost its sender', () => {
    const senders = emittedTypes()
    const alive = RETIRED_NOTIFICATION_TYPES
      .filter(t => senders.has(t) || t in SENT_INDIRECTLY)
    expect(alive).toEqual([])
  })

  /**
   * The types production has actually sent, read read-only out of `gam` on
   * 10/20 (SELECT DISTINCT type FROM notifications). Every one has to stay
   * nameable in plain words — the notification feed reads old rows — so a
   * future session cannot drop one from both lists and leave a landlord looking
   * at a raw enum in their bell.
   */
  const SENT_IN_PRODUCTION = [
    'autopay_failed', 'booking_change_request', 'connect_payout_paid',
    'deposit_report_unconfirmed', 'emergency_contact_refresh', 'esign_completed',
    'esign_document_declined', 'esign_request', 'gam_balance_uncollectable',
    'held_utility_prior_occupant', 'landlord_member_added', 'lease_draft_blocked',
    'lease_drafted_from_application', 'lease_drafted_from_booking', 'lease_ready_to_sign',
    'long_stay_no_lease', 'maintenance_submitted', 'maintenance_updated',
    'move_meter_reads_due', 'moveout_meter_reads_due', 'payment_recorded',
    'rent_collected', 'tenant_invite_accepted', 'utility_meter_broken',
    'utility_reading_run_opened',
  ]

  it.each(SENT_IN_PRODUCTION)('%s — sent in production, still known here', (type) => {
    expect(isKnownNotificationType(type)).toBe(true)
  })

  /**
   * And the preference rows that exist in production, same read. These are the
   * answers people have already given; every one has to still mean something or
   * read as plainly retired.
   */
  const ANSWERED_IN_PRODUCTION = [
    'ach_retries_exhausted', 'ach_retry_scheduled', 'birthday', 'bulk_message',
    'disbursement_sent', 'entry_request_responded', 'inspection_finalized',
    'inspection_scheduled_reminder', 'inspection_tenant_signed', 'lease_expiring',
    'low_stock', 'maintenance_submitted', 'maintenance_updated', 'rent_collected',
    'rent_failed', 'reservation_requested', 'tenant_invite_accepted',
  ]

  it.each(ANSWERED_IN_PRODUCTION)('%s — someone answered this one, still known here', (type) => {
    expect(isKnownNotificationType(type)).toBe(true)
  })
})

// ─── Every entry is readable ────────────────────────────────────────────────

describe('every catalog entry is fit to put in front of a person', () => {
  it.each(NOTIFICATION_CATALOG.map(e => [e.type, e] as const))('%s', (_type, entry) => {
    // memory: gam-no-raw-enums-in-ui — a label is never the stored string.
    expect(entry.label).toBeTruthy()
    expect(entry.label).not.toBe(entry.type)
    expect(entry.label).not.toMatch(/_/)
    expect(entry.label[0]).toBe(entry.label[0]!.toUpperCase())
    // One plain sentence saying what makes it fire.
    expect(entry.when.length).toBeGreaterThan(15)
    expect(entry.when.endsWith('.')).toBe(true)
    expect(NOTIFICATION_GROUPS).toContain(entry.group)
    expect(['landlord', 'tenant', 'both']).toContain(entry.audience)
  })

  it('no type is listed twice', () => {
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length)
  })

  it('every group that exists has a heading and at least one row', () => {
    for (const g of NOTIFICATION_GROUPS) expect(NOTIFICATION_GROUP_LABEL[g]).toBeTruthy()
    const used = new Set(NOTIFICATION_CATALOG.map(e => e.group))
    expect([...NOTIFICATION_GROUPS].filter(g => !used.has(g))).toEqual([])
  })

  it('a retired type still reads in plain English, never as its enum', () => {
    for (const t of RETIRED_NOTIFICATION_TYPES) {
      expect(notificationLabel(t)).not.toMatch(/_/)
    }
  })
})

// ─── The five Nic named ─────────────────────────────────────────────────────

describe('the five GAM always sends', () => {
  it('is exactly the five Nic named — adding or dropping one is his call', () => {
    expect([...CRITICAL_NOTIFICATION_TYPES].sort()).toEqual([
      'autopay_failed', 'flexpay_bill_covered', 'flexpay_ended', 'flexpay_pull_retry',
      'payment_failed',
    ])
  })

  it('each one says why it cannot be switched off, in words a person reads', () => {
    for (const t of CRITICAL_NOTIFICATION_TYPES) {
      const entry = notificationEntry(t)!
      expect(entry.whyAlways, `${t} needs whyAlways — the page prints it`).toBeTruthy()
      expect(entry.whyAlways!.length).toBeGreaterThan(25)
    }
  })

  it('each one is on a settings page, not hidden', () => {
    const shown = new Set([
      ...notificationCatalogFor('landlord').map(e => e.type),
      ...notificationCatalogFor('tenant').map(e => e.type),
    ])
    for (const t of CRITICAL_NOTIFICATION_TYPES) expect(shown.has(t)).toBe(true)
  })
})

// ─── Both audiences get a whole page ────────────────────────────────────────

describe('both portals show a whole page, not a subset', () => {
  it('every type lands on at least one audience', () => {
    const shown = new Set([
      ...notificationCatalogFor('landlord', { isAccountHolder: true }).map(e => e.type),
      ...notificationCatalogFor('tenant').map(e => e.type),
    ])
    expect(NOTIFICATION_TYPES.filter(t => !shown.has(t))).toEqual([])
  })

  it.each(['landlord', 'tenant'] as const)('%s has rows in several groups', (audience) => {
    const groups = notificationGroupsFor(audience)
    expect(groups.length).toBeGreaterThan(3)
    expect(groups.flatMap(g => g.entries).length).toBeGreaterThan(20)
  })

  it('a team member loses only the account holder’s own notices', () => {
    const owner = notificationCatalogFor('landlord', { isAccountHolder: true }).map(e => e.type)
    const staff = notificationCatalogFor('landlord', { isAccountHolder: false }).map(e => e.type)
    expect(owner.filter(t => !staff.includes(t))).toEqual(['birthday'])
  })
})

// ─── The second road: every email category is declared ──────────────────────
//
// 10/20 (Nic): "you're thinking too narrow. I want you to fix the root."
//
// createNotification was never the only way GAM emails somebody. Every email
// goes through one send() in services/email.ts, and about fifty of its callers
// are senders in their own right — they stamp a `category` and send. The
// catalog, the compiler, the settings pages and the tests above were all blind
// to them, which is why the 7am overdue digest, the monthly bill, every payment
// receipt, the signing request, four signing reminders and the monthly property
// report all kept reaching a landlord who had answered every box on his page.
//
// Each category is declared exactly once in packages/shared/src/emailCategories:
// a `gate` naming the notification type whose row switches it off, or `always`
// with the reason it cannot be. These three tests are what make that complete.

const EMAIL_SERVICE = join(API_SRC, 'services', 'email.ts')

/** Every `category:` value stamped in services/email.ts. */
function categoriesStampedInEmailService(): { literals: string[]; dynamic: string[] } {
  const src = readFileSync(EMAIL_SERVICE, 'utf8')
  const literals = new Set<string>()
  const dynamic = new Set<string>()
  for (const m of src.matchAll(/category:\s*'([a-z][a-z0-9_]*)'/g)) literals.add(m[1]!)
  // A template literal — `notif_${type}`, `flexsuite_${product}_...` — cannot
  // be read off the source. They are named here so the test says which one is
  // uncovered rather than silently ignoring the interesting cases.
  for (const m of src.matchAll(/category:\s*(`[^`]*`|ctx\.category[^,}\n]*)/g)) {
    const expr = m[1]!.trim()
    // `category: ctx.category ?? null` inside a logger call is a diagnostic,
    // not a send. Only an expression that can name a real category counts.
    if (/\?\?\s*null$/.test(expr)) continue
    dynamic.add(expr)
  }
  return { literals: [...literals].sort(), dynamic: [...dynamic].sort() }
}

describe('every email GAM can send has been decided, not just the notifications', () => {
  it('every category stamped in services/email.ts is declared', () => {
    const { literals } = categoriesStampedInEmailService()
    // Enough of them that a regression here is obvious rather than a rounding error.
    expect(literals.length).toBeGreaterThan(50)
    const undeclared = literals.filter(c => emailGateFor(c).kind === 'undeclared')
    expect(undeclared,
      'Declare each of these in packages/shared/src/emailCategories.ts: either `gate` with the ' +
      'notification type whose row on the settings page switches it off (and a catalog entry for ' +
      'that type), or `always` with the reason the recipient cannot decline it. An undeclared ' +
      'category is an email nobody was ever asked about — the exact thing that was wrong.',
    ).toEqual([])
  })

  it('the template-literal categories are the two that are accounted for', () => {
    const { dynamic } = categoriesStampedInEmailService()
    // `notif_${type}` is the notification road, decided by createNotification
    // before the mail is handed over. The flexsuite one is an enrollment
    // confirmation carrying the agreement the tenant just signed; both of its
    // products are declared. `ctx.category ?? 'pos_receipt'` is the register
    // receipt. If a THIRD dynamic category appears, this test names it so
    // somebody decides what it is rather than it defaulting to "always send".
    expect(dynamic.sort()).toEqual([
      '`flexsuite_${args.product}_enrollment_confirmation`',
      '`notif_${opts.notificationType}`',
      "ctx.category ?? 'pos_receipt'",
    ])
    for (const product of ['flexpay', 'flexdeposit']) {
      expect(emailGateFor(`flexsuite_${product}_enrollment_confirmation`).kind).toBe('always')
    }
    expect(emailGateFor('pos_receipt').kind).toBe('always')
  })

  it('every declared gate names a real catalog type with a row on a settings page', () => {
    const shown = new Set([
      ...notificationCatalogFor('landlord', { isAccountHolder: true }).map(e => e.type),
      ...notificationCatalogFor('tenant').map(e => e.type),
    ])
    const broken: string[] = []
    for (const [category, rule] of Object.entries(EMAIL_CATEGORY_RULES)) {
      if (!rule.gate) continue
      if (!shown.has(rule.gate)) broken.push(`${category} → ${rule.gate}`)
    }
    expect(broken,
      'A gate that names a type with no row on either page is a switch nobody can reach — ' +
      'worse than no gate, because the code believes somebody was asked.',
    ).toEqual([])
  })

  it('every notif_ type is a catalog type, or declared as not a person’s notification', () => {
    // sendNotificationEmail stamps `notif_<type>`. createNotification is its
    // main caller and the compiler covers that one. Two others are not
    // notifications at all — GAM's operational alerts to its own super_admins,
    // and a guest's one-hour claim window — so they have no catalog entry and
    // nothing upstream reads a preference for them. They are declared instead
    // of being silently waved through by the `notif_` prefix.
    const stamped = new Set<string>()
    for (const file of sourceFiles(API_SRC)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/notificationType:\s*(?:'([a-z][a-z0-9_]*)'|`([a-z][a-z0-9_]*)\$\{)/g)) {
        stamped.add(m[1] ?? m[2]!)
      }
    }
    expect(stamped.size).toBeGreaterThan(0)
    const undecided = [...stamped].filter(t =>
      !isKnownNotificationType(t)
      && !(t in UNGATED_NOTIFICATION_EMAIL_TYPES)
      && !UNGATED_NOTIFICATION_EMAIL_PREFIXES.some(prefix => t.startsWith(prefix))
      // `admin_${opts.category}` reaches this as the prefix 'admin_' itself.
      && t !== 'admin_')
    expect(undecided,
      'These are emailed as ' + NOTIFICATION_EMAIL_CATEGORY_PREFIX + '<type> without going through ' +
      'createNotification, so no preference was read and there is no catalog entry to read one ' +
      'from. Either give them a catalog entry, or name them in ' +
      'UNGATED_NOTIFICATION_EMAIL_TYPES with the reason.',
    ).toEqual([])
  })

  it('a gated category and its notification agree about who can decline it', () => {
    // The critical five are forced on wherever the decision is made, so a
    // category that gates on one of them is honest only because the gate itself
    // skips them. Named here so the two places cannot drift.
    for (const [category, rule] of Object.entries(EMAIL_CATEGORY_RULES)) {
      if (!rule.gate) continue
      const entry = notificationEntry(rule.gate)!
      expect(entry, `${category} gates on ${rule.gate}, which is not in the catalog`).toBeTruthy()
      // A category that emails a type means that type is NOT in-app-only.
      expect(entry.inAppOnly,
        `${category} emails ${rule.gate}, so ${rule.gate} must not be marked inAppOnly — ` +
        'the page would print a dash where the switch belongs.',
      ).toBeUndefined()
    }
  })

  it('every always-send category says why, in words a person can read', () => {
    for (const [category, rule] of Object.entries(EMAIL_CATEGORY_RULES)) {
      if (rule.gate) continue
      expect(rule.always!.length,
        `${category} is declared always-send with no real reason. The reason is the review: ` +
        'somebody has to be able to read it and disagree.',
      ).toBeGreaterThan(30)
      expect(rule.always!.endsWith('.')).toBe(true)
    }
  })

  it('no category prints as its stored string', () => {
    // memory: gam-no-raw-enums-in-ui. The landlord's Email Delivery Issues
    // table printed 'late_payment_notice' under eighty rows of plain English.
    for (const category of Object.keys(EMAIL_CATEGORY_RULES)) {
      const label = emailCategoryLabel(category)
      expect(label).toBeTruthy()
      expect(label).not.toBe(category)
      expect(label).not.toMatch(/_/)
      expect(label[0]).toBe(label[0]!.toUpperCase())
    }
    // And a notification's own category reads as that notification's label.
    expect(emailCategoryLabel('notif_rent_collected')).toBe('Rent collected')
    // Even an unknown one never shows an enum.
    expect(emailCategoryLabel('something_nobody_declared')).toBe('Something nobody declared')
    expect(emailCategoryLabel(null)).not.toMatch(/_/)
  })

  it('the gate sends a transactional email and declines a switched-off notification', () => {
    expect(emailGateFor('login_2fa_code')).toMatchObject({ kind: 'always' })
    expect(emailGateFor('late_payment_notice')).toEqual({ kind: 'preference', type: 'late_balance_digest' })
    expect(emailGateFor('notif_rent_collected')).toEqual({ kind: 'decided_upstream' })
    // GAM's own alerts to its staff, and a guest's claim window: on the notif_
    // road but never through createNotification, so nothing upstream asked.
    expect(emailGateFor('notif_admin_esign_lease_build_failed')).toMatchObject({ kind: 'always' })
    expect(emailGateFor('notif_waitlist_claim_link')).toMatchObject({ kind: 'always' })
    // The failure a future session gets for writing a sender without deciding.
    expect(emailGateFor('a_brand_new_sender')).toEqual({ kind: 'undeclared' })
  })
})
