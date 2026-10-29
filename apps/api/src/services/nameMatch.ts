/**
 * 10/22 (Nic) — DO TWO NAMES MEAN THE SAME PERSON?
 *
 * Asked by the left-owing flag, where the whole rule is TWO CONTACT POINTS
 * AGREEING — name + email, or name + phone:
 *
 *   "I know people can change their email and phone number and stuff, but most
 *    of the time they don't change both. And so if there's a name match with an
 *    email or name match with a phone number, that is going to be good enough
 *    for us right now."
 *
 * And the names will not be typed the same way twice:
 *
 *   "If it's Nick Rhodes with the email and Nicholas Rhodes with the same
 *    email, that needs to count as a match. Or people that are, shorthand,
 *    Richard being Dick or William being Bob or whatever... people on informal
 *    stuff, a lot of people will put a nickname. And a square invoice, a lot of
 *    people might treat as informal, even though it's, even if it's rent, you
 *    know, a lot of landlords don't run things professionally."
 *
 * THREE ANSWERS, NEVER TWO. 10/22: "Maybe when there's a not sure call, we can
 * leave it to the admin to kind of do some research on." So this returns 'same'
 * or 'different' where it is sure, and 'unsure' where a person should look —
 * and the caller never guesses in either direction.
 *
 * IT IS A RULE, NOT A SCORE. No fuzzy distance, no threshold, no percentage: a
 * written-down set of nicknames and three written-down tests. The same two
 * names give the same answer today, on the deploy gate, and in a year. (10/22,
 * Nic: "there needs to be a set of rules that something is derived from, and it
 * needs to handle it accurately every single time.")
 */

/** How sure we are that two names are one person. */
export type NameAgreement = 'same' | 'unsure' | 'different'

/**
 * NAMES THAT ARE THE SAME NAME. Each line is one person's names: anything on a
 * line matches anything else on it.
 *
 * Hand-written on purpose. A library would bring a scoring model and a
 * surprise; this list is the rule, it is auditable, and adding a name is one
 * line. Nic's own three are here: Nick/Nicholas, Richard/Dick, William/Bob.
 */
export const NICKNAMES: readonly (readonly string[])[] = [
  ['robert', 'rob', 'robbie', 'bob', 'bobby'],
  ['richard', 'rich', 'richie', 'rick', 'ricky', 'dick', 'dickie'],
  ['william', 'will', 'willie', 'bill', 'billy', 'bob', 'liam'],
  ['nicholas', 'nick', 'nic', 'nicky', 'niko'],
  ['michael', 'mike', 'mick', 'micky', 'mikey'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny', 'jon'],
  ['jonathan', 'jon', 'jonny', 'johnny'],
  ['joseph', 'joe', 'joey'],
  ['charles', 'charlie', 'chuck', 'chas', 'chip'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy', 'ned'],
  ['theodore', 'ted', 'teddy', 'theo'],
  ['thomas', 'tom', 'tommy'],
  ['anthony', 'tony'],
  ['daniel', 'dan', 'danny'],
  ['donavan', 'donovan', 'don', 'van'],
  ['david', 'dave', 'davey'],
  ['donald', 'don', 'donnie'],
  ['frederick', 'fred', 'freddy', 'fritz'],
  ['gerald', 'gerry', 'jerry'],
  ['gregory', 'greg', 'gregg'],
  ['henry', 'hank', 'harry', 'hal'],
  ['lawrence', 'larry', 'laurence', 'lon'],
  ['leonard', 'leo', 'lenny', 'len'],
  ['matthew', 'matt', 'matty'],
  ['patrick', 'pat', 'paddy', 'rick'],
  ['peter', 'pete'],
  ['philip', 'phillip', 'phil'],
  ['raymond', 'ray'],
  ['ronald', 'ron', 'ronnie'],
  ['samuel', 'sam', 'sammy'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['timothy', 'tim', 'timmy'],
  ['walter', 'walt', 'wally'],
  ['zachary', 'zach', 'zack', 'zak'],
  ['albert', 'al', 'bert', 'albie'],
  ['alexander', 'alex', 'al', 'xander', 'sandy'],
  ['andrew', 'andy', 'drew'],
  ['arthur', 'art', 'artie'],
  ['benjamin', 'ben', 'benny', 'benji'],
  ['bradley', 'brad'],
  ['christopher', 'chris', 'kit', 'topher'],
  ['douglas', 'doug'],
  ['eugene', 'gene'],
  ['francis', 'franklin', 'frank', 'frankie'],
  ['harold', 'harry', 'hal'],
  ['herbert', 'herb', 'bert'],
  ['howard', 'howie'],
  ['jeffrey', 'jeff', 'geoffrey', 'geoff'],
  ['kenneth', 'ken', 'kenny'],
  ['louis', 'lewis', 'lou', 'louie'],
  ['martin', 'marty'],
  ['nathaniel', 'nathan', 'nate', 'nat'],
  ['norman', 'norm'],
  ['randall', 'randolph', 'randy'],
  ['rodney', 'rod'],
  ['russell', 'russ', 'rusty'],
  ['terrence', 'terence', 'terry'],
  ['vincent', 'vince', 'vinny'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betty', 'betsy', 'eliza', 'libby'],
  ['margaret', 'maggie', 'meg', 'peggy', 'marge', 'margie'],
  ['katherine', 'catherine', 'kathryn', 'kate', 'katie', 'kathy', 'cathy', 'kay', 'kit'],
  ['deborah', 'debra', 'deb', 'debbie'],
  ['jennifer', 'jen', 'jenny', 'jenna'],
  ['jessica', 'jess', 'jessie'],
  ['patricia', 'pat', 'patty', 'tricia', 'trish'],
  ['barbara', 'barb', 'babs'],
  ['susan', 'sue', 'susie', 'suzy', 'suzanne'],
  ['christine', 'christina', 'chris', 'chrissy', 'tina'],
  ['dorothy', 'dot', 'dottie', 'dolly'],
  ['virginia', 'ginny', 'ginger'],
  ['sandra', 'sandy'],
  ['cynthia', 'cindy'],
  ['rebecca', 'becky', 'becca', 'beck'],
  ['pamela', 'pam'],
  ['kimberly', 'kim'],
  ['stephanie', 'steph'],
  ['michelle', 'shelly'],
  ['amanda', 'mandy'],
  ['victoria', 'vicky', 'vicki', 'tori'],
  ['theresa', 'teresa', 'terry', 'tess', 'tracy'],
  ['eleanor', 'ellie', 'nell', 'nora'],
  ['joanne', 'joanna', 'jo', 'joan'],
  ['judith', 'judy'],
  ['laura', 'lauren', 'laurie'],
  ['mary', 'molly', 'polly', 'mamie'],
  ['nancy', 'nan'],
  ['frances', 'fran', 'francie'],
  ['constance', 'connie'],
  ['charlotte', 'lottie', 'charlie'],
  ['caroline', 'carolyn', 'carrie', 'cari'],
  ['isabella', 'isabel', 'izzy', 'bella', 'belle'],
  ['madeline', 'madelyn', 'maddie'],
  ['natalie', 'nat'],
  ['samantha', 'sam', 'sammy'],
  ['angela', 'angie'],
  ['melissa', 'mel', 'missy'],
  ['veronica', 'ronnie', 'roni'],
] as const

/** Suffixes that are not part of a name. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'md', 'dds', 'phd', 'esq'])
/** Titles people put on an invoice. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'rev', 'sir'])

/**
 * The words of a name, lower-cased, stripped of accents, punctuation, titles
 * and suffixes. "Mr. Dale P. Pruitt, Jr." → ['dale', 'p', 'pruitt'].
 */
export function nameWords(raw: string | null | undefined): string[] {
  if (!raw) return []
  return String(raw)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // café → cafe
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')                        // drop digits and punctuation
    .replace(/['-]/g, '')                               // O'Brien → obrien, Smith-Jones → smithjones
    .split(/\s+/)
    .filter(w => w && !SUFFIXES.has(w) && !TITLES.has(w))
}

const SAME_AS = (() => {
  const m = new Map<string, Set<number>>()
  NICKNAMES.forEach((group, i) => {
    for (const n of group) {
      if (!m.has(n)) m.set(n, new Set())
      m.get(n)!.add(i)
    }
  })
  return m
})()

/** Two given names that are one person's: equal, a nickname pair, or a shortening. */
export function firstNamesAgree(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // On the same nickname line.
  const ga = SAME_AS.get(a), gb = SAME_AS.get(b)
  if (ga && gb) { for (const i of ga) if (gb.has(i)) return true }
  // A plain shortening nobody needs a list for: Nic/Nicholas, Rob/Robert,
  // Steph/Stephanie. Three letters at least — "Jo" is its own name, and "A"
  // against "Andrew" is an initial, which is the unsure case below.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 3 && long.startsWith(short)
}

/** One letter standing in for a name: "D", "D." */
const isInitialOf = (a: string, b: string): boolean =>
  (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))

/**
 * Does this debt's name and this person's name mean one person?
 *
 *   'same'      — the family name matches and the given name matches (itself, a
 *                 nickname, or a shortening). Flag it.
 *   'unsure'    — close but not decidable by rule: an initial for a given name,
 *                 one name against two, or a family name that matches with a
 *                 different given name (a brother, a spouse, a junior). A
 *                 person at GAM looks at it.
 *   'different' — nothing in common. Never flag, never queue.
 *
 * The FAMILY name is required either way: it is the one part people do not
 * shorten. A married name is a real change and lands in 'unsure' through the
 * one-word rule, which is where a human belongs.
 */
export function nameAgreement(
  debtName: string | null | undefined,
  personName: string | null | undefined,
): NameAgreement {
  const a = nameWords(debtName), b = nameWords(personName)
  if (!a.length || !b.length) return 'different'

  const lastA = a[a.length - 1], lastB = b[b.length - 1]
  const firstA = a[0], firstB = b[0]

  // ONE WORD ON EITHER SIDE. "Pruitt" against "Dale Pruitt" — the same family
  // name and nothing else to go on, or a first name that happens to match.
  if (a.length === 1 || b.length === 1) {
    const one = a.length === 1 ? firstA : firstB
    const other = a.length === 1 ? b : a
    return other.includes(one) ? 'unsure' : 'different'
  }

  if (lastA !== lastB) {
    // Different family names. The only thing worth a human's time is the same
    // given name with a changed surname — a marriage — and only because a
    // contact point already agreed for this to be asked at all.
    return firstNamesAgree(firstA, firstB) ? 'unsure' : 'different'
  }

  if (firstNamesAgree(firstA, firstB)) return 'same'
  if (isInitialOf(firstA, firstB)) return 'unsure'
  // Same family name, a given name that is genuinely another name. Brothers
  // share an address and a phone; so do fathers and sons.
  return 'unsure'
}

/** An email as it is compared: trimmed and lower-cased, nothing cleverer. */
export const normalizedEmail = (e: string | null | undefined): string | null => {
  const s = (e ?? '').trim().toLowerCase()
  return s.includes('@') ? s : null
}

/**
 * A phone as it is compared: its last ten digits, so +1 (602) 555-9999,
 * 6025559999 and 1-602-555-9999 are one number. Fewer than ten digits is not a
 * phone number anybody can be matched on.
 */
export const normalizedPhone = (p: string | null | undefined): string | null => {
  const digits = (p ?? '').replace(/[^0-9]/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}
