/**
 * 10/20–21 (Nic) — A DEBT SOMEBODY WALKED AWAY FROM.
 *
 *   "if somebody leaves us owing money, another landlord can see that. They
 *    just can't see specifics. They can't see an exact dollar amount. They
 *    can't see who the other landlord was. They can't see when it happened, but
 *    they can just be flagged as high risk, owes other people money. They need
 *    to settle up."
 *
 * Everything in this file exists to keep that sentence true. The amount, the
 * landlord who was owed and the dates are all in the table; none of them leaves
 * it. What another landlord gets is three words and a count.
 *
 * THE TWO DOORS, and only the first is built:
 *
 *   STEP 1 — where and when, free. "August of 2024 in Las Vegas." It names
 *   nobody and obligates nobody; it is there so a person at a counter can say
 *   "oh, THAT one" and settle it.
 *
 *   STEP 2 — the total, which buys the debt. "if you click on this and they
 *   don't pay, we're collecting that debt from you." NOT BUILT: it moves money
 *   a new way and is Nic's to approve first. `theTotal` below refuses, in
 *   words, rather than pretending the door is missing.
 */
import { query, queryOne } from '../db'
// 10/22 (Nic): two contact points agreeing, with nicknames and partial names
// counting — the name half of that rule, written down as a rule.
import { nameAgreement, normalizedEmail, normalizedPhone, type NameAgreement } from './nameMatch'

/** What ANY other landlord may know. Three words and a number of debts. */
export interface LeftOwingFlag {
  /** True when this person has walked away from money somewhere, unsettled. */
  flagged: boolean
  /** How many separate debts. Never how much, never whose, never when. */
  count: number
  /** The words a landlord reads. Fixed — nothing about this is per-case. */
  words: string
}

export const LEFT_OWING_WORDS =
  'High risk — owes other people money and needs to settle up.'

/**
 * WHO IS BEING CHECKED. An account they clicked, or just the name, email and
 * phone a clerk typed into a screening form — somebody applying at another park
 * may have no GAM account at all, and the flag has to work for them, because
 * that is the moment it matters.
 */
export interface PersonToCheck {
  userId?: string | null
  name?: string | null
  email?: string | null
  phone?: string | null
}

/** A bare user id still works: every caller that has one passes it. */
export type PersonRef = string | PersonToCheck | null | undefined

async function whoIsBeingChecked(person: PersonRef): Promise<PersonToCheck | null> {
  if (!person) return null
  const p: PersonToCheck = typeof person === 'string' ? { userId: person } : person
  if (!p.userId) return p.name || p.email || p.phone ? p : null
  // An account fills in whatever the caller did not pass.
  const u = await queryOne<{ name: string; email: string; phone: string | null }>(
    `SELECT NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') AS name,
            email, phone
       FROM users WHERE id = $1`, [p.userId])
  return {
    userId: p.userId,
    name: p.name ?? u?.name ?? null,
    email: p.email ?? u?.email ?? null,
    phone: p.phone ?? u?.phone ?? null,
  }
}

/**
 * The one thing that identifies this person across reads, so a close call is
 * raised ONCE and not again on every search. The strongest thing we have:
 * their account, else the email, else the phone.
 */
function personKey(p: PersonToCheck): string | null {
  if (p.userId) return `user:${p.userId}`
  const e = normalizedEmail(p.email)
  if (e) return `email:${e}`
  const ph = normalizedPhone(p.phone)
  return ph ? `phone:${ph}` : null
}

/** Which contact point agreed. */
export type MatchedOn = 'account' | 'email' | 'phone'

/** A debt that came up for this person, and what is to be done about it. */
export interface MatchedDebt {
  owingId: string
  matchedOn: MatchedOn
  agreement: NameAgreement
  /**
   * 'flag'   — it is them: counted, and the first door may open.
   * 'review' — close, and waiting for a person at GAM. NOTHING is shown.
   * 'no'     — a person at GAM said it is not them.
   */
  verdict: 'flag' | 'review' | 'no'
  why: string
  leftOn: string | null
  city: string | null
  state: string | null
}

/**
 * EVERY DEBT THAT COULD BE THIS PERSON'S, decided by the rule.
 *
 * Nic, 10/22, overruling the first cut (which matched a verified GAM account
 * and nothing else): "It's a flag only matches a verified GAM account. That's
 * not right. It can match based on multiple contact points... if there's a name
 * match with an email or name match with a phone number, that is going to be
 * good enough for us right now."
 *
 * So: the family name and the given name agree (services/nameMatch, which knows
 * Nick/Nicholas and Richard/Dick), AND the email or the phone agrees exactly.
 * Either contact point alone is not enough and neither is a name alone — "a
 * name is not an identity", and two people called Dale Pruitt exist.
 *
 * A DEBT THE LANDLORD POINTED AT AN ACCOUNT counts on its own: they said who it
 * was when they brought it in, and that is a statement by the person who is out
 * of pocket, not a guess by us.
 *
 * ANYTHING CLOSE GOES TO A PERSON, and shows nobody anything in the meantime.
 * 10/22: "Maybe when there's a not sure call, we can leave it to the admin to
 * kind of do some research on." An initial for a first name, a brother at the
 * same phone number, a surname that changed — all of those are real, and all of
 * them are somebody's reputation, so none of them is decided here.
 *
 * `raiseReviews: false` reads without writing — for a caller that only wants to
 * know, and for the review queue itself, which must not raise rows while a
 * person is working through them.
 */
export async function debtsMatching(
  person: PersonRef,
  askingLandlordIds: string[],
  opts: { raiseReviews?: boolean } = {},
): Promise<MatchedDebt[]> {
  const p = await whoIsBeingChecked(person)
  if (!p) return []
  const key = personKey(p)
  if (!key) return []
  const email = normalizedEmail(p.email)
  const phone = normalizedPhone(p.phone)
  if (!p.userId && !email && !phone) return []

  const rows = await query<{
    id: string; who: string | null; left_on: string | null
    city: string | null; state: string | null
    matched_on: MatchedOn; review_status: string | null
  }>(
    `SELECT o.id, o.who, to_char(o.left_on, 'YYYY-MM-DD') AS left_on, pr.city, pr.state,
            CASE WHEN $1::uuid IS NOT NULL AND o.user_id = $1::uuid THEN 'account'
                 WHEN $2::text IS NOT NULL AND lower(btrim(o.email)) = $2::text THEN 'email'
                 ELSE 'phone' END AS matched_on,
            rv.status AS review_status
       FROM tenant_left_owing o
       LEFT JOIN properties pr ON pr.id = o.property_id
       LEFT JOIN tenant_left_owing_match_reviews rv
              ON rv.owing_id = o.id AND rv.person_key = $4::text
      WHERE o.settled_at IS NULL
        AND NOT (o.landlord_id = ANY($5::uuid[]))
        AND ( ($1::uuid IS NOT NULL AND o.user_id = $1::uuid)
           OR ($2::text IS NOT NULL AND lower(btrim(o.email)) = $2::text)
           OR ($3::text IS NOT NULL
               AND right(regexp_replace(COALESCE(o.phone, ''), '[^0-9]', '', 'g'), 10) = $3::text) )
      ORDER BY o.left_on NULLS LAST, o.id`,
    [p.userId ?? null, email, phone, key, askingLandlordIds])

  const out: MatchedDebt[] = []
  for (const r of rows) {
    const agreement = nameAgreement(r.who, p.name)
    const where = { leftOn: r.left_on, city: r.city, state: r.state }

    // A person at GAM has already looked at this pair. Their answer stands,
    // whichever way it went, and is not asked again.
    if (r.review_status === 'same_person') {
      out.push({ owingId: r.id, matchedOn: r.matched_on, agreement, verdict: 'flag',
        why: 'A GAM admin researched this one and said it is the same person.', ...where })
      continue
    }
    if (r.review_status === 'not_the_same_person') {
      out.push({ owingId: r.id, matchedOn: r.matched_on, agreement, verdict: 'no',
        why: 'A GAM admin researched this one and said it is somebody else.', ...where })
      continue
    }

    if (r.matched_on === 'account') {
      out.push({ owingId: r.id, matchedOn: 'account', agreement, verdict: 'flag',
        why: 'The landlord who was owed pointed this debt at this account when they brought it in.', ...where })
      continue
    }

    const point = r.matched_on === 'email' ? 'email address' : 'phone number'
    if (agreement === 'same') {
      out.push({ owingId: r.id, matchedOn: r.matched_on, agreement, verdict: 'flag',
        why: `The name and the ${point} both match.`, ...where })
      continue
    }

    const why = agreement === 'unsure'
      ? `The ${point} matches and the name is close — "${r.who ?? '(no name)'}" against "${p.name ?? '(no name)'}" — so a person needs to look.`
      : `The ${point} matches but the name does not — "${r.who ?? '(no name)'}" against "${p.name ?? '(no name)'}" — so a person needs to look.`
    out.push({ owingId: r.id, matchedOn: r.matched_on, agreement, verdict: 'review', why, ...where })
    if (opts.raiseReviews !== false) await raiseReview(r.id, p, key, r.matched_on, agreement, why)
  }
  return out
}

/** Put a close call in front of a person at GAM. Once per pair, ever. */
async function raiseReview(
  owingId: string, p: PersonToCheck, key: string,
  matchedOn: MatchedOn, agreement: NameAgreement, why: string,
): Promise<void> {
  await query(
    `INSERT INTO tenant_left_owing_match_reviews
       (owing_id, user_id, person_name, person_email, person_phone, person_key,
        matched_on, name_agreement, why)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (owing_id, person_key) DO NOTHING`,
    [owingId, p.userId ?? null, p.name ?? null, p.email ?? null, p.phone ?? null,
     key, matchedOn, agreement, why],
  ).catch(() => { /* the answer the caller asked for matters more than the note */ })
}

/**
 * Does this person have money outstanding anywhere, and is the landlord asking
 * somebody OTHER than the one owed?
 *
 * The landlord who is OWED is excluded on purpose. They already have the whole
 * story in their own "moved out, still owes" folder, with every figure in it.
 * Showing them a flag about their own debt would be telling them something they
 * know, in a form that is less useful than what they already have.
 */
export async function leftOwingFlagFor(
  person: PersonRef,
  askingLandlordIds: string[],
): Promise<LeftOwingFlag> {
  const none: LeftOwingFlag = { flagged: false, count: 0, words: '' }
  if (!person || !askingLandlordIds.length) return none
  const count = (await debtsMatching(person, askingLandlordIds)).filter(d => d.verdict === 'flag').length
  return count > 0 ? { flagged: true, count, words: LEFT_OWING_WORDS } : none
}

/** STEP ONE: the month and the place. No amount, nobody named. */
export interface WhereAndWhen {
  owingId: string
  /** "August of 2024" — the month, never the day. */
  when: string | null
  /** "Las Vegas, NV" — the town, never the park and never the landlord. */
  where: string | null
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']

/** "2024-08-14" → "August of 2024". Deliberately not the day. */
export function monthInWords(isoDate: string | null): string | null {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null
  const [y, m] = isoDate.split('-')
  const month = MONTHS[Number(m) - 1]
  return month ? `${month} of ${y}` : null
}

/**
 * Open the first door. Free, logged, and repeatable for the same landlord —
 * pressing it twice tells them the same thing and takes on nothing.
 */
export async function whereAndWhen(args: {
  /** An account, or the name/email/phone a clerk typed. */
  userId?: string | null
  person?: PersonToCheck
  askingLandlordIds: string[]
  byUserId: string
}): Promise<WhereAndWhen[]> {
  if (!args.askingLandlordIds.length) return []
  // THE SAME RECOGNITION THE FLAG USES, so the door opens on exactly the debts
  // the flag counted. A debt waiting for a GAM admin opens NOTHING: it may not
  // be this person, and "August of 2024 in Las Vegas" about a stranger's debt
  // is the one thing this whole file exists to prevent.
  const rows = (await debtsMatching(args.person ?? args.userId, args.askingLandlordIds))
    .filter(d => d.verdict === 'flag')
    .map(d => ({ id: d.owingId, left_on: d.leftOn, city: d.city, state: d.state }))

  // Written down because a landlord who looked should be on the record as
  // having looked — and because the second door, when it lands, has to be able
  // to say who had already opened the first.
  for (const r of rows) {
    await query(
      `INSERT INTO tenant_left_owing_reveals (owing_id, landlord_id, user_id, door)
       VALUES ($1, $2, $3, 'where_and_when')
       ON CONFLICT (owing_id, landlord_id, door) DO NOTHING`,
      [r.id, args.askingLandlordIds[0], args.byUserId]).catch(() => { /* the answer matters more than the note */ })
  }

  return rows.map(r => ({
    owingId: r.id,
    when: monthInWords(r.left_on),
    where: [r.city, r.state].filter(Boolean).join(', ') || null,
  }))
}

/**
 * ── THE QUEUE A PERSON AT GAM WORKS THROUGH ─────────────────────────────────
 *
 * 10/22 (Nic): "Maybe when there's a not sure call, we can leave it to the
 * admin to kind of do some research on."
 *
 * A GAM admin sees EVERYTHING here — the amount, the landlord, the dates, both
 * names side by side — because that is what research takes, and because the
 * rule that keeps all of it back is a rule about other LANDLORDS. Platform,
 * landlord and tenant each see their own; this is the platform's own desk.
 */
export interface MatchReview {
  id: string
  owingId: string
  /** The name on the debt, and the name of the person being checked. */
  debtName: string | null
  personName: string | null
  personEmail: string | null
  personPhone: string | null
  /** Which contact point agreed, and how close the names came. */
  matchedOn: MatchedOn
  nameAgreement: NameAgreement
  why: string
  /** The research material: a GAM admin may see the lot. */
  amount: number
  owedTo: string | null
  leftOn: string | null
  where: string | null
  source: string
  raisedAt: string
}

/** Everything still waiting for a person, oldest first. */
export async function openMatchReviews(limit = 200): Promise<MatchReview[]> {
  const rows = await query<any>(
    `SELECT rv.id, rv.owing_id, rv.person_name, rv.person_email, rv.person_phone,
            rv.matched_on, rv.name_agreement, rv.why,
            to_char(rv.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS raised_at,
            o.who AS debt_name, o.amount::float AS amount,
            to_char(o.left_on, 'YYYY-MM-DD') AS left_on,
            o.source_kind || ':' || o.source_key AS source,
            pr.city, pr.state,
            NULLIF(TRIM(COALESCE(ou.first_name, '') || ' ' || COALESCE(ou.last_name, '')), '') AS owed_to
       FROM tenant_left_owing_match_reviews rv
       JOIN tenant_left_owing o ON o.id = rv.owing_id
       LEFT JOIN properties pr ON pr.id = o.property_id
       LEFT JOIN landlords l ON l.id = o.landlord_id
       LEFT JOIN users ou ON ou.id = l.user_id
      WHERE rv.status = 'open'
        AND o.settled_at IS NULL
      ORDER BY rv.created_at
      LIMIT $1`, [Math.min(Math.max(1, limit), 500)])
  return rows.map(r => ({
    id: r.id,
    owingId: r.owing_id,
    debtName: r.debt_name,
    personName: r.person_name,
    personEmail: r.person_email,
    personPhone: r.person_phone,
    matchedOn: r.matched_on,
    nameAgreement: r.name_agreement,
    why: r.why,
    amount: Number(r.amount),
    owedTo: r.owed_to,
    leftOn: r.left_on,
    where: [r.city, r.state].filter(Boolean).join(', ') || null,
    source: r.source,
    raisedAt: r.raised_at,
  }))
}

/**
 * The answer. 'same_person' makes the debt count for every landlord who asks
 * from here on — it is a fact about the person, not about whoever happened to
 * be asking when it came up — and 'not_the_same_person' puts it away for good.
 *
 * It does NOT move the amount, raise a new debt or settle one. A decision here
 * only answers "is this the same human being", which is the one question a
 * matcher cannot answer by rule. (10/22: the figure is frozen at import and
 * cannot move inside GAM at all.)
 *
 * Deciding twice is refused rather than silently overwritten: a reversal is a
 * conversation, not a double-click.
 */
export async function decideMatchReview(args: {
  reviewId: string
  samePerson: boolean
  byUserId: string
  note?: string | null
}): Promise<{ decided: boolean; why: string }> {
  const r = await queryOne<{ id: string }>(
    `UPDATE tenant_left_owing_match_reviews
        SET status = $2, decided_by = $3, decided_at = NOW(), decided_note = $4, updated_at = NOW()
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [args.reviewId, args.samePerson ? 'same_person' : 'not_the_same_person',
     args.byUserId, args.note ?? null])
  if (!r) {
    return { decided: false, why: 'That one has already been decided, or it is not on the list any more.' }
  }
  return {
    decided: true,
    why: args.samePerson
      ? 'Recorded as the same person — every landlord who asks from now on sees the flag.'
      : 'Recorded as somebody else — this debt will not follow them.',
  }
}

/**
 * STEP TWO — THE TOTAL, WHICH BUYS THE DEBT. NOT BUILT.
 *
 * Nic, 10/21: "only click this box if the tenant's willing to pay for it,
 * because the money, they can pay you and we'll collect the money from you. But
 * if you click on this and they don't pay, we're collecting that debt from you.
 * You're going to be paying that debt on that tenant's behalf. Only open it if
 * you're ready to freaking rock and roll."
 *
 * That is money moving a way it has never moved in GAM: a receivable raised
 * against one landlord for another landlord's bad debt, collected by GAM and
 * paid across. It needs his go-ahead on the mechanics before it exists —
 * what happens when the applicant pays the original landlord directly, whether
 * the figure can still move after it was revealed, and how it is collected from
 * a landlord whose own payouts are small.
 *
 * It throws rather than returning nothing, so that nobody wires a button to it
 * believing the door is open.
 */
export async function theTotal(): Promise<never> {
  throw new Error(
    'Revealing the total means taking on the debt, and that part is not built yet. '
    + 'The first door — where and when it happened — is the one that is open.')
}
