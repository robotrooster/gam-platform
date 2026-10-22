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
 * Does this person have money outstanding anywhere, and is the landlord asking
 * somebody OTHER than the one owed?
 *
 * HOW SOMEBODY IS RECOGNISED — Nic overruled this on 10/22. Claude had built
 * it to match a verified GAM account and nothing else; Nic: "It's a flag only
 * matches a verified GAM account. That's not right."
 *
 * The rule is TWO CONTACT POINTS AGREEING — name + email, or name + phone:
 * "I know people can change their email and phone number and stuff, but most of
 * the time they don't change both." Partial and nickname names count, both
 * ways: Nick/Nicholas, Richard/Dick, William/Bob — "a square invoice, a lot of
 * people might treat as informal, even though it's... rent." And where it is
 * genuinely unsure, it is neither matched nor dropped: it goes to a GAM admin
 * to research. Three outcomes, never a silent guess in either direction.
 *
 * NOT YET BUILT — the account match below is the narrow first cut and is a
 * SUBSET of the rule above, so it under-matches rather than over-matches while
 * the contact-point matcher and the admin queue are built. It never flags
 * somebody the real rule would not.
 *
 * The landlord who is OWED is excluded on purpose. They already have the whole
 * story in their own "moved out, still owes" folder, with every figure in it.
 * Showing them a flag about their own debt would be telling them something they
 * know, in a form that is less useful than what they already have.
 */
export async function leftOwingFlagFor(
  userId: string | null | undefined,
  askingLandlordIds: string[],
): Promise<LeftOwingFlag> {
  const none: LeftOwingFlag = { flagged: false, count: 0, words: '' }
  if (!userId) return none
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM tenant_left_owing o
       JOIN users u ON u.id = o.user_id AND u.email_verified = TRUE
      WHERE o.user_id = $1
        AND o.settled_at IS NULL
        AND NOT (o.landlord_id = ANY($2::uuid[]))`,
    [userId, askingLandlordIds])
  const count = Number(row?.n ?? 0)
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
  userId: string
  askingLandlordIds: string[]
  byUserId: string
}): Promise<WhereAndWhen[]> {
  if (!args.askingLandlordIds.length) return []
  const rows = await query<{ id: string; left_on: string | null; city: string | null; state: string | null }>(
    `SELECT o.id, to_char(o.left_on, 'YYYY-MM-DD') AS left_on, p.city, p.state
       FROM tenant_left_owing o
       JOIN users u ON u.id = o.user_id AND u.email_verified = TRUE
       LEFT JOIN properties p ON p.id = o.property_id
      WHERE o.user_id = $1
        AND o.settled_at IS NULL
        AND NOT (o.landlord_id = ANY($2::uuid[]))
      ORDER BY o.left_on NULLS LAST`,
    [args.userId, args.askingLandlordIds])

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
