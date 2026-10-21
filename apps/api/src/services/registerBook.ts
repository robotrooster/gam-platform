/**
 * ONE REGISTER BOOK PER ACCOUNT — AND ONLY AS FAR AS THE CALLER'S OWN.
 *
 * 10/20 (Nic), on the register's customer list: "that could be people from my
 * other property could be customers at this property for propane. I shouldn't
 * have to toggle."
 *
 * His two parks are not two properties of one company. Mountain View RV Ranch
 * sits under Mountain View RV Park Ranch LLC and Oak Park Motel and RV sits
 * under Oak Park Motel and RV LLC — two `landlords` rows, one property each,
 * one account. Every register record, every card and every "is this one of
 * ours?" check was keyed on ONE of those rows, so the propane case he actually
 * described crossed an ENTITY boundary, not a property boundary: his Oak Park
 * resident walked up to the Mountain View counter and read as a stranger from
 * an unrelated landlord, and picking him INSERTED a second record for the same
 * man — a second charge account, a second set of saved cards, a second running
 * total. That is the per-location person-splitting we had just taken out,
 * moved one level up.
 *
 * So "this company" in the register's person model means THE COMPANIES THIS
 * ACCOUNT OWNS, as far as the caller's own reach goes. One company id still
 * goes in at every call site — the register is ringing somewhere, and a new
 * record is still FILED under the company that made it. Only the question "do
 * we already have this person?" got wider.
 *
 * WHY NOT account_companies(). That function walks every MEMBER of a company
 * and then every company those people touch, which is right for a lease
 * template (the toolkit of whoever can open it) and wrong for a customer book.
 * Oak Park has a co-owner who also owns TruBlu Management LLC in Illinois, so
 * account_companies(Oak Park) reaches Country Acres - Mattoon: one landlord
 * reading another landlord's customers.
 *
 * WHY EVERY HELPER HERE DEMANDS A CALLER.
 *
 * The first cut of this file said the opposite, in as many words: "the set is
 * the same whoever is signed in… which record a sale names cannot depend on who
 * is standing at the keyboard." It read well and it was wrong, and it broke on
 * the exact person the account_companies() paragraph above warns about — just
 * pointed the other way.
 *
 * Oak Park's registered owner is Nic, so the ownership-only set behind Oak Park
 * is {Oak Park, Mountain View}. Blu is an owner-MEMBER of Oak Park and the
 * registered owner of TruBlu Management LLC — his own company, his own
 * landlord. Standing at Oak Park's register, which he is entitled to stand at,
 * the data-only book handed him Mountain View: 65 of Nic's residents by name,
 * park and site, every one carrying the live email on their own GAM account, 42
 * the live phone, and a saved card on each chargeable at his counter. Measured
 * read-only against production. Before 10/20 every one of those reads was
 * refused.
 *
 * The sentence was half right, and the half that is right is worth keeping:
 * WHERE a sale is filed must not depend on who is at the keyboard — and it does
 * not, because the company id still goes in at every call site. WHO the
 * keyboard may read is the whole of what authorization means, and that is the
 * caller's question, every time. The data answers whose account this is; the
 * session answers who is asking; the book is the two of them met.
 *
 * A caller is REQUIRED, not defaulted, and the SQL fails closed on NULL —
 * narrowing to the one company that was passed in. Both halves are deliberate:
 * required, so a new call site is a compile error rather than a quiet leak;
 * fail-closed, so if one ever slips past the compiler it costs a clerk a click
 * and not a landlord's resident list.
 */
import type { AuthPayload } from '../middleware/auth'

/**
 * Who the book answers to: a `users.id`, or null for "this company only".
 *
 * Never a landlord_id. The thing being asked is which COMPANIES this PERSON may
 * read, so a company id on either side of that question would be begging it.
 */
export type BookCaller = string | null

/**
 * The roles that are the ACCOUNT'S OWN SIDE of the counter rather than a
 * landlord in their own right: its staff, and GAM's admins acting for it. They
 * hold no company of their own, so their reach is the account they work for —
 * which is why bookCaller hands the SQL the registered owner of that company
 * and not their own user id. 10/20 (Nic, decisions #11): "they are his
 * customers and the desk has to find them."
 *
 * A role NOT on this list and not 'landlord' gets no book at all. That is the
 * fail-closed end: a tenant, a contact, a fitness user or a business operator
 * has no business reading a register's people, and if one ever reaches a call
 * site here they read the one company the route already authorized, nothing
 * more. Adding a new staff role and forgetting this list costs that role the
 * account's book — a visible bug, never a leak.
 */
const DESK_ROLES: readonly string[] = [
  'admin', 'super_admin', 'bookkeeper', 'property_manager', 'onsite_manager', 'maintenance',
]

/** The account a company is registered to, as a caller. Null when there is no such company. */
export async function accountAsCaller(
  company: string | null | undefined,
  q: <T>(sql: string, params: unknown[]) => Promise<T[]>,
): Promise<BookCaller> {
  if (!company) return null
  const rows = await q<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [company])
  return rows[0]?.user_id ?? null
}

/**
 * Who is asking, for one request.
 *
 * A LANDLORD asks as themselves: the owner of the account reads all of its
 * companies, a co-owner reads the ones they co-own (the two branches in the
 * migration). THE DESK and GAM's admins ask as the account — see DESK_ROLES.
 * Anybody else asks as nobody, and reads the one company they were let in on.
 *
 * `company` is the company the request is acting on. For a team role it is the
 * one their token carries (canManageLandlordResource allows no other), so the
 * two agree; it is named explicitly because a lookup keyed on the thing being
 * authorized is the only one that cannot drift from it.
 *
 * SYSTEM WORK — a Stripe webhook settling a pay link, a nightly job, a
 * backfill — has no person at a keyboard and calls accountAsCaller directly.
 * Not bookCaller with whoever happened to be authenticated: on
 * POST /background/submit that is the APPLICANT, and an applicant is not the
 * desk.
 */
export async function bookCaller(
  user: AuthPayload | null | undefined,
  company: string | null | undefined,
  q: <T>(sql: string, params: unknown[]) => Promise<T[]>,
): Promise<BookCaller> {
  if (!user) return null
  if (user.role === 'landlord') return user.userId ?? null
  if (DESK_ROLES.includes(user.role)) return accountAsCaller(company ?? user.landlordId, q)
  return null
}

/**
 * Put the caller on a query's parameter list and hand back its placeholder.
 *
 * Same shape as rankSql/wordFilter in services/posPeople: the query owns its
 * params array, the helper pushes and numbers. Call it ONCE per query and pass
 * what it returns to every book helper in that query's SQL — a placeholder can
 * be read as many times as the SQL needs it.
 */
export const askingAs = (params: unknown[], caller: BookCaller): string => {
  params.push(caller)
  return `$${params.length}`
}

/** The account's companies this caller may reach, as a set an id is tested against. */
const bookSet = (company: string, caller: string): string => {
  // A bare placeholder has no column beside it to take its type from, and
  // Postgres will not guess a uuid for a set-returning argument.
  const cast = (v: string) => { const t = v.trim(); return /^\$\d+$/.test(t) ? `${t}::uuid` : t }
  return `(SELECT public.register_book_companies(${cast(company)}, ${cast(caller)}))`
}

/** `col` names a company that shares a customer book with `company`, for `caller`. */
export const inBook = (col: string, company: string, caller: string): string =>
  `${col} IN ${bookSet(company, caller)}`

/**
 * `col` names a company OUTSIDE that book. NULL is not "outside" here, the same
 * way `col <> $1` never matched a NULL: a caller that wants NULL to count as
 * elsewhere says so itself (see tenantTiedElsewhereSql and the applications it
 * reads, where a row can carry no company at all).
 *
 * Note which way this moves when the book narrows, because it is the direction
 * that matters: a sibling company the caller may not reach becomes ELSEWHERE,
 * so the escape hatch in tenantLivesHereSql (signed_by_tenant, or nothing on
 * their account came from anywhere else) CLOSES rather than opens, and a
 * landlord-signed lease at one company stops unlocking a resident of another.
 */
export const notInBook = (col: string, company: string, caller: string): string =>
  `${col} NOT IN ${bookSet(company, caller)}`

/**
 * `col` names a company in the book of ANY of `companies` (a uuid[] parameter).
 *
 * 10/20 (review) — FOR A LIST, THE SESSION'S COMPANIES ARE ONLY WHERE THE READ
 * STARTS. landlordScopeIds() answers an OWNER with every company of his
 * account, which is why the Customers tab looked right for Nic. A TEAM role
 * carries exactly one company in its token — that is the whole of a team scope
 * (lib/landlordScope) — so for the on-site manager standing at Mountain View's
 * counter, the person who actually works that tab, it answered "Mountain View"
 * and nothing else. She got one park's book while the picker beside it, which
 * asks the DATA who the account's people are, offered both. Nic: "they are his
 * customers and the desk has to find them."
 *
 * She still gets both, and now for the reason she should: she holds no company
 * of her own, so bookCaller asks on behalf of the account she works for. What
 * this no longer does is expand a CO-OWNER's own company into its account's
 * siblings — Blu's {Oak Park, TruBlu} came back out of here as {Oak Park,
 * Mountain View, TruBlu}, the same leak as everywhere else in this file,
 * arriving through the caller's own list.
 */
export const inBookOfAny = (col: string, companies: string, caller: string): string =>
  `${col} IN (SELECT b.id FROM unnest(${companies}::uuid[]) AS s(id),` +
  ` LATERAL public.register_book_companies(s.id, ${caller.trim()}::uuid) AS b(id))`
