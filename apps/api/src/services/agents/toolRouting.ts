/**
 * What a person MEANS, mapped to the lookup that answers it.
 *
 * S618 (Nic): "just give it some sort of prewritten... think of the ten most
 * common ways a landlord or tenant would phrase those questions, the ones that
 * are failing right now, and have it — okay, when any sort of combination of
 * this comes up, this is what it's inferring."
 *
 * WHY THIS EXISTS. The runner already knows when a question needs a lookup
 * (`demandsAToolCall`) and can force one with tool_choice 'required'. What it
 * could not do is say WHICH lookup — so the model still chose, and choosing is
 * the step that flakes. Measured: "what's bob chen's balance" produced "I'll
 * look up Bob Chen's balance for you." and no call at all, while the same
 * question asked four other ways answered correctly. Roughly one phrasing in
 * five behaves that way. This table removes the guess: the phrasing decides the
 * tool, and the runner forces THAT one by name.
 *
 * WHAT IT DOES NOT DO — and this is the important part. It never answers
 * anything, and it never supplies a value. It only picks which lookup runs; the
 * model still writes the reply out of that tool's real result. So the worst a
 * wrong entry here can do is run the wrong query and return the wrong SHAPE of
 * fact — it can't invent a number, because no number in this file exists. That
 * is what makes a keyword table safe here when it would not be safe as an
 * answer cache.
 *
 * It is also the reason the customer-rep rule survives intact: routing "what's
 * my late fee" to get_my_lease is not the agent knowing the late fee, it is the
 * agent looking it up on THIS lease — which is exactly what Nic specified,
 * because late fees vary "per property and per state and landlord."
 *
 * ORDER MATTERS. First match wins, so the specific sits above the general:
 * "pet deposit" must be tested before "deposit", or every pet question would be
 * answered with the security deposit. Nic's own example — a word like "pet"
 * meaning "go read the fee rows on their particular lease, not the generic
 * deposit."
 *
 * AUDIENCE-SCOPED. A tenant route can never name a landlord tool and vice
 * versa, so this cannot become a way around the product siloing. The resolver
 * additionally refuses to return any tool the calling profile does not hold.
 */

import type { AgentAudience } from './types'

export interface PhraseRoute {
  /**
   * The lookups this wording calls for, in the order they should run.
   *
   * S618 (Nic): "it should be a combination of both" — the words AND what they
   * imply. "Is my landlord gonna renew?" names no tool and asks for no figure,
   * but what would actually answer it is the lease (when it ends) TOGETHER with
   * how this landlord has handled renewals before. One question, two lookups,
   * because that is what a person would go and check.
   */
  tools: string[]
  audience: AgentAudience
  /** Plain-language note on what the person is actually asking for. */
  means: string
  patterns: RegExp[]
  /**
   * Pull the lookup's argument straight out of the wording, when the wording
   * contains it.
   *
   * S618. Routing alone only helps a lookup that needs nothing from the model.
   * Measured on the real path, consistently and in both orderings: the model
   * calls the tenant lookup for "is bob behind on rent?" and refuses for
   * "how much does apt 101 owe" and "what's bob chen's balance" — the same
   * three fail every time. The tool accepts "Apt 101" perfectly well; nothing
   * was ever calling it.
   *
   * The message already says who. Reading it here is not a guess about the
   * ANSWER — the tool still resolves the identifier against this landlord's own
   * rows and comes back with a match, a partial match ("That's Bob Chen in Apt
   * 101 — different Chen?"), or nothing. A misread degrades to a clarifying
   * question, never to a wrong figure.
   */
  extractArgs?: (message: string) => Record<string, unknown> | undefined
}

/**
 * Which kind of complaint the words describe. Only ever picks the LABEL; the
 * complaint text itself is stored verbatim, so a wrong label mis-files nothing.
 */
function complaintCategory(m: string): string {
  if (/\b(loud|noise|noisy|music|yelling|screaming|party|parties|blasting|slamming|can'?t sleep)\b/i.test(m)) return 'noise'
  if (/\b(park\w*|my spot|my space)\b/i.test(m)) return 'parking'
  if (/\b(smoke|smoking|smell|odou?r|stink)\b/i.test(m)) return 'smell'
  if (/\b(dog|cat|pet|barking|animal)\b/i.test(m)) return 'pets'
  if (/\b(trash|garbage|rubbish|bins?)\b/i.test(m)) return 'trash'
  if (/\b(threat\w*|harass\w*|yelled at me|scared|unsafe|dangerous)\b/i.test(m)) return 'harassment'
  if (/\b(neighbou?r|next door|upstairs|downstairs)\b/i.test(m)) return 'neighbor'
  return 'other'
}

/** "apt 101", "RV 04", "spot 3", "unit 12B" — how people name a unit. */
const UNIT_RE =
  // "number"/"no."/"#" is FILLER between the noun and the identifier. Without
  // this it swallowed the filler as the identifier: "spot number one" came out
  // as unit "spot number", which then force-ran the lease lookup on nonsense
  // instead of letting the agent ask WHICH property — and "spot one" is
  // ambiguous across House 01, RV 01 and Storage 01, so asking is the correct
  // answer. Nic's own example phrasing, broken by the extractor meant to help it.
  /\b(apt|apartment|unit|lot|space|spot|site|rv|house|home|storage|cabin|suite|room)\s*(?:number|num|no\.?|#)?\s*([a-z0-9][a-z0-9-]{0,7})\b/i

/** A person's name in the shapes these questions take. */
const NAME_RE = [
  /\b(?:is|has|does|did)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\s+(?:behind|current|late|paid|owe)/i,
  /\bhow much does\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\s+owe/i,
  /\b([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)(?:'s|s')\s+(?:balance|account|standing)/i,
  /\b(?:look ?up|check on|about)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\b/i,
]

/**
 * Words that are never part of somebody's name.
 *
 * S626, and this was the whole of Nic's "narrow-then-answer" failure. The name
 * patterns allow an apostrophe inside a word — they have to, for O'Brien and
 * D'Angelo — and a two-word name is allowed for "Frank Chen". Put together on
 * "what's chen's balance?" they capture **"what's chen"**, so the agent went
 * looking for a tenant of that name, found nobody, and asked the landlord which
 * Chen they meant. His verdict: "The landlord should never have had to narrow
 * this. The question word gives away that no human is reading it."
 *
 * A person seeing "Chen's" reads a possessive and searches Chen.
 */
const NOT_A_NAME_WORD = new Set([
  'what', "what's", 'whats', 'who', "who's", 'whos', 'how', "how's", 'hows',
  'when', "when's", 'where', "where's", 'why', 'which', 'whose',
  'is', 'are', 'was', 'does', 'do', 'did', 'has', 'have', 'can', 'could',
  'tell', 'show', 'give', 'find', 'get', 'look', 'check', 'pull',
  'me', 'my', 'the', 'a', 'an', 'about', 'on', 'for', 'of', 'to', 'and',
  'so', 'ok', 'okay', 'hey', 'hi', 'please', 'up', 'out',
  'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'everybody', 'all',
  'they', 'he', 'she', 'it', 'that', 'this', 'them', 'their', 'his', 'her',
  'tenant', 'tenants', 'unit', 'lot', 'spot', 'site', 'apartment',
])

/**
 * Drop leading question words from a captured name.
 *
 * Leading only: a stop word INSIDE a name is somebody else's problem, but a
 * name that begins with one is a parse that ate the question.
 */
function cleanName(raw: string): string | undefined {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  while (words.length && NOT_A_NAME_WORD.has(words[0].toLowerCase())) words.shift()
  // And a trailing one, for "chen the tenant".
  while (words.length && NOT_A_NAME_WORD.has(words[words.length - 1].toLowerCase())) words.pop()
  if (!words.length) return undefined
  // Every remaining word being a stop word means nothing was named.
  if (words.every((w) => NOT_A_NAME_WORD.has(w.toLowerCase()))) return undefined
  return words.join(' ')
}

/** The unit if one is named, else the person, else nothing. */
function whoOrWhere(message: string): string | undefined {
  const u = UNIT_RE.exec(message)
  if (u) return `${u[1]} ${u[2]}`.replace(/\s+/g, ' ').trim()
  for (const re of NAME_RE) {
    const m = re.exec(message)
    if (!m) continue
    const cleaned = cleanName(m[1])
    if (cleaned) return cleaned
  }
  return undefined
}

/**
 * TENANT. One lease, one account — so "my" is implied in nearly everything and
 * the question is almost always WHICH FACT about that one lease.
 */
const TENANT_ROUTES: PhraseRoute[] = [
  {
    // S618 (Nic): "that's the point of contact where tenants are gonna complain
    // about the neighbor — hey, tell my neighbor to turn their shit down."
    //
    // FIRST among tenant routes: a complaint is an ACTION to take, and the
    // lookups below would otherwise swallow the words ("parking" is a lease fee
    // question until someone is parking in your spot).
    //
    // The body recorded is the tenant's message VERBATIM — this route decides
    // that a complaint was made, never what it says.
    tools: ['log_complaint'],
    audience: 'tenant',
    means: 'a complaint about a neighbour or living condition — record it, do not just sympathise',
    patterns: [
      /\b(neighbou?r|next door|upstairs|downstairs|people (above|below|next))\b[^?]{0,60}\b(loud|noise|noisy|music|yelling|screaming|party|parties|smell|smoke|smoking|park\w*|dog|bark\\w*|trash|rude)\b/i,
      /\b(loud|noise|noisy|music|yelling|screaming|party|parties|bark\\w*)\b[^?]{0,60}\b(neighbou?r|next door|upstairs|downstairs|apartment|unit|lot|spot|site)\b/i,
      /\btell (my|the) (neighbou?r|people)\b/i,
      /\b(someone|somebody|people)\b[^?]{0,40}\b(smoking|smokes|parking|parked)\b[^?]{0,30}\b(in my|my spot|comes into|into my)\b/i,
      // S626: found while adding the tenant amenity route. "someone is smoking
      // by the pool" matched NOTHING — the pattern above needs "in my spot", so
      // a complaint about behaviour in a COMMON area routed nowhere at all.
      // This is about what a person is doing, never about a facility, so it
      // cannot swallow "is there a pool".
      /\b(someone|somebody|people|kids|guests?)\b[^?]{0,30}\b(smoking|smokes|vaping|drinking|yelling|screaming|littering|speeding|trespassing)\b/i,
      /\b(parking|parked)\b[^?]{0,25}\b(in my (spot|space)|my spot)\b/i,
      /\bcan'?t sleep\b[^?]{0,40}\b(noise|loud|music|neighbou?r)\b/i,
      /\b(complain|complaint)\b[^?]{0,40}\b(about|regarding)\b/i,
      /\bkeeps? (waking|blocking|parking|blasting|slamming|barking)\b/i,
      // "the dog next door barks all day" — the animal comes BEFORE the
      // direction word, and it is "barks", not "barking".
      /\b(dog|dogs|cat|cats|animal)\b[^?]{0,40}\b(bark\w*|howl\w*|meow\w*|noise|loud|all (day|night))\b/i,
    ],
    // Verbatim. A record that quotes the tenant cannot misrepresent them, and
    // it is what the landlord should be reading anyway.
    extractArgs: (m) => ({ category: complaintCategory(m), body: m.trim() }),
  },
  {
    // Nic: "anything the tenant asks, the agent should be able to pull up the
    // full lease, read it, and answer any questions about the lease... help me
    // decipher — according to the lease, am I getting part of it back?"
    //
    // FIRST, and only for questions that appeal to the DOCUMENT or need more
    // than one part of it at once. The narrower lease routes below stay for
    // single facts: a full-lease payload on every "what's my rent" would put
    // pets, occupants and every fee row into a prompt this model already
    // struggles to call tools from.
    tools: ['get_my_full_lease'],
    audience: 'tenant',
    means: 'what the lease itself says, or an answer needing several parts of it together',
    patterns: [
      // "according to / per / under my lease" — appealing to the document.
      // NOT "does my lease", which swallowed "when does my lease end" — a date
      // question that belongs on the narrow lease route. The content sense of
      // "does my lease..." is handled below with an explicit verb.
      /\b(according to|per|under)\s+(my|the)\s+lease\b/i,
      /\bmy lease say/i,
      /\bwhat'?s? in my lease\b/i,
      /\bread (my|the) lease\b/i,
      /\b(explain|decipher|walk me through|help me understand|go over)\b[^?]{0,25}\blease\b/i,
      /\blease (terms|agreement|document|says)\b/i,
      /\bam i allowed\b/i,
      /\bdoes my lease (allow|cover|permit|say)\b/i,
      /\bwhat am i actually paying\b/i,
      /\beverything (i'?m |i am )?(paying|charged)\b/i,
    ],
  },
  {
    tools: ['get_my_lease_fees'],
    audience: 'tenant',
    means: 'a named fee or deposit that lives on their lease — pet, cleaning, parking, storage, trash',
    patterns: [
      // Nic's example: the word "pet" means go read the fee rows on THIS lease.
      /\bpet\s*(deposit|fee|rent|charge)\b/i,
      /\b(deposit|fee|charge|rent)\s*(for|on)\s*(my\s*)?(pet|dog|cat|animal)\b/i,
      /\b(dog|cat|animal)\s*(deposit|fee|rent)\b/i,
      /\bcleaning\s*(fee|deposit|charge)\b/i,
      /\b(parking|storage|garage)\s*(fee|rent|charge|spot)\b/i,
      // "what am I paying for parking" — the fee word can come first, or be
      // implied by "paying for".
      /\b(pay|paying|charged|billed)\s+for\s+(the\s+|my\s+)?(parking|storage|garage|pet|cleaning)\b/i,
      /\b(parking|storage|garage)\b[^?]{0,15}\b(cost|rate|amount)\b/i,
      /\b(trash|pest|technology|amenity|move-?in|key)\s*(fee|deposit|charge)\b/i,
      /\bwhat\s+(other\s+)?(fees|charges)\b/i,
      /\bam i (being )?charged\s+for\b/i,
      /\bextra (fees|charges)\b/i,
      /\bwhat('s| is) (this|the) (fee|charge) for\b/i,
    ],
  },
  {
    // Nic: "just because I say when is my lease over, or say something that's
    // less specific, like — is my landlord gonna renew? that's gonna say okay,
    // they should infer renewing the lease on expiration, pull up the lease.
    // Hey, your lease expires here, your landlord typically renews."
    //
    // Neither lookup alone answers it. The lease has the date; the tendency has
    // the behaviour. So both run and the agent answers with the two together.
    tools: ['get_my_lease', 'get_my_landlord_renewal_tendency'],
    audience: 'tenant',
    means: 'will they be renewed — the lease end date AND how this landlord usually behaves',
    patterns: [
      /\b(will|is|are|does|do|gonna|going to)\b[^?]{0,40}\brenew\b/i,
      /\brenew(ing|al|ed)?\b[^?]{0,25}\b(my |the )?lease\b/i,
      /\b(my |the )?lease\b[^?]{0,25}\brenew/i,
      /\bcan i stay\b/i,
      /\bwill i have to move\b/i,
      /\bam i (getting|going to get) (a |an )?(renewal|new lease)\b/i,
      /\bwhat happens (when|after) my lease (ends|is up|expires)\b/i,
      /\bwill my rent go up\b/i,
      /\bdo they usually renew\b/i,
      /\bstay another year\b/i,
      // S626 (Nic): "Should infer 'renewal' from the two messages together."
      // Almost nobody uses the word "renew" — they ask to STAY. The follow-up
      // that exposed this was "and what happens if I want to stay on after
      // that?", which matched none of the above and routed nothing, so the
      // agent invented a renewal-request feature and offered to submit it.
      /\bstay (on|longer|past|beyond|put)\b/i,
      /\b(want|like|hoping|planning|need)\b[^?]{0,20}\bto stay\b/i,
      /\bkeep (the|my) (place|apartment|unit|spot|lot)\b/i,
      /\b(extend|continue)\b[^?]{0,20}\b(my |the )?lease\b/i,
      /\bsign (a |another )?new lease\b/i,
      /\b(another|a) (year|term)\b[^?]{0,15}\blease\b/i,
      /\bafter (my |the )?lease (ends|is up|expires)\b/i,
      // The JOINED form, for a follow-up carrying no subject of its own:
      // "when does my lease end?" + "and what happens after that?". Requires
      // both halves, so it cannot fire on either sentence alone.
      /\blease\b[^?]{0,20}\b(end|ends|ending|up|expires?)\b[\s\S]{0,60}\bwhat happens\b/i,
      /\bwhen (my |the )?lease (ends|is up|expires)\b[^?]{0,25}\b(then|next|after)\b/i,
    ],
  },
  {
    // S626: there was NO route here at all, and the eval found it the hard way.
    // "what amenities can I reserve at my property?" had only ever worked
    // because the model happened to pick get_my_amenities on its own — no
    // phrase route, so no deterministic backstop and nothing for the
    // account-data safety net to force. The first prompt change of the day
    // tipped it and the case went from passing to calling nothing.
    //
    // A tool nothing routes to is a tool one prompt edit away from being
    // unreachable. The guest side has had this route since S552; the tenant
    // side never did.
    //
    // Deliberately placed AFTER the complaint route above, which is first among
    // tenant routes on purpose: "someone is smoking by the pool" is a complaint,
    // not an amenities question, and it must keep winning.
    tools: ['get_my_amenities'],
    audience: 'tenant',
    means: 'what is on the property and what the tenant can reserve',
    patterns: [
      /\b(amenit\w+|clubhouse|gym|fitness (room|center|centre)|hot tub|fire ?pit|bbq|barbecue|picnic area|common area|community room)\b/i,
      // "pool" and "laundry" are the ambiguous ones: they name a facility AND a
      // thing that breaks. A bare noun would swallow "my washer is broken",
      // which is maintenance, so these require the sentence to be ASKING about
      // the facility — the question word has to come BEFORE the noun. "is there
      // a pool" matches; "my washer is broken" does not, because the verb
      // follows the noun.
      /\b(is|are|do|does|where|when|what|which|any|have)\b[^?]{0,25}\b(pool|laundry|laundromat|washer|dryer)\b/i,
      /\b(pool|laundry|clubhouse|gym)\b[^?]{0,20}\b(hours?|open|close[sd]?|available|free|located|location|schedule)\b/i,
      /\bwhat can i (book|reserve|use)\b/i,
      /\b(book|reserve)\b[^?]{0,25}\b(the|a)\s+(pool|clubhouse|gym|room|area|court)\b/i,
      /\bmy reservations?\b/i,
      /\bwhat('?s| is) there to do\b/i,
    ],
  },
  {
    // "According to the lease, am I getting any of my deposit back?" — that is
    // the deposit AND the fee/deduction rows that decide it.
    tools: ['get_my_deposit', 'get_my_lease_fees'],
    audience: 'tenant',
    means: 'how much of the deposit comes back — needs the deposit and the deductions the lease allows',
    patterns: [
      /\bdeposit\b[^?]{0,30}\b(back|refund|return)\b/i,
      /\b(get|getting|receive)\b[^?]{0,20}\bdeposit\b[^?]{0,20}\b(back|refund)/i,
      /\bhow much of (my |the )?deposit\b/i,
      /\bdeduct\w*\b[^?]{0,25}\bdeposit\b/i,
      /\bkeep (my|the) deposit\b/i,
      /\bwhat comes out of (my |the )?deposit\b/i,
    ],
  },
  {
    tools: ['get_my_deposit'],
    audience: 'tenant',
    means: 'the security deposit specifically',
    patterns: [
      /\bsecurity deposit\b/i,
      /\bmy deposit\b/i,
      /\bthe deposit\b/i,
      /\bhow much did i put down\b/i,
      /\bdeposit back\b/i,
      /\bget my deposit\b/i,
      /\bdamage deposit\b/i,
    ],
  },
  {
    tools: ['get_my_balance_breakdown'],
    audience: 'tenant',
    means: 'what they currently owe',
    patterns: [
      /\b(what|how much) do(es)? i owe\b/i,
      /\bhow much do i (owe|need to pay|have to pay)\b/i,
      /\bmy balance\b/i,
      /\bdo i owe (anything|any money)\b/i,
      /\bam i behind\b/i,
      /\bbehind on (rent|my rent|payments)\b/i,
      /\bpast due\b/i,
      /\bcatch (up|me up) on\b/i,
      /\bhow much to (get )?current\b/i,
      /\bwhat('s| is) my (total |current )?(balance|amount due)\b/i,
    ],
  },
  {
    tools: ['get_my_payment_methods'],
    audience: 'tenant',
    means: 'what card or bank account is saved on the account',
    patterns: [
      /\b(card|bank account|payment method)\b[^?]{0,30}\b(on file|saved|connected|set ?up|linked)\b/i,
      /\bwhat (card|payment method)\b/i,
      /\bhow am i set ?up to pay\b/i,
      /\bis (my|the) (bank|account|card)\b[^?]{0,20}\b(connected|linked|working)\b/i,
      /\bdo you have my (card|bank)\b/i,
      /\bam i on autopay\b/i,
      /\bis autopay (on|set ?up|enabled)\b/i,
    ],
  },
  {
    tools: ['get_my_payments'],
    audience: 'tenant',
    means: 'whether a payment landed — history, not balance',
    patterns: [
      /\b(did|has) (my |the )?(last |recent )?payment\b[^?]{0,25}\b(go through|clear|post|process|arrive)\b/i,
      /\bdid you (get|receive) my payment\b/i,
      /\bwas my (rent |payment )?(payment )?received\b/i,
      /\bis my payment (still )?(processing|pending)\b/i,
      /\bpayment history\b/i,
      /\bwhen did i (last )?pay\b/i,
      /\bmy (last|recent) payments?\b/i,
      /\bproof (of|that i) paid\b/i,
    ],
  },
  {
    tools: ['get_my_maintenance_requests'],
    audience: 'tenant',
    means: 'the status of repairs they already reported',
    patterns: [
      /\b(open|any) (maintenance|repair|work order)\b/i,
      /\bstatus of my (repair|maintenance|work order|request)\b/i,
      /\bdid anyone (look at|fix|come)\b/i,
      /\bupdates? on (the |my )?(maintenance|repair)\b/i,
      /\bmy (maintenance|repair) requests?\b/i,
      /\bwhen (is|will) (someone|somebody|a tech)\b[^?]{0,25}\b(come|fix|be out)\b/i,
      /\bhas my (request|ticket)\b/i,
    ],
  },
  {
    tools: ['get_my_invoices'],
    audience: 'tenant',
    means: 'the bills/statements themselves',
    patterns: [
      /\bmy (invoice|bill|statement)s?\b/i,
      /\b(latest|last|recent) (invoice|bill|statement)\b/i,
      /\bcan i (see|get) (my |a )?(invoice|bill|statement|receipt)\b/i,
      /\bitemi[sz]ed\b/i,
      /\bwhat am i being billed for\b/i,
    ],
  },
  {
    // LAST among tenant routes on purpose: it is the broadest. Anything about
    // rent terms, dates or late fees that the more specific routes did not
    // claim belongs to the lease itself.
    tools: ['get_my_lease'],
    audience: 'tenant',
    means: 'the terms of their lease — rent, due day, dates, late fee, grace period',
    patterns: [
      // S620: a QUALIFIER between "my" and "rent" broke the match — "what's my
      // MONTHLY rent" routed nothing while "what's my rent" routed fine, and
      // that one phrasing was the only failure in 79 tenant cases. It is the
      // exact shape S618 built this table for: same question, one wording
      // falls through, and the tenant gets "I don't want to give you a number
      // I haven't actually checked" instead of $750.
      /\bmy (monthly |current |base |total |actual )?rent\b/i,
      /\bhow much is (the |my )?(monthly |current |base )?rent\b/i,
      /\bhow much do i pay (each|per) month\b/i,
      /\bwhen is (my )?rent due\b/i,
      /\bwhat day (is|does) rent\b/i,
      /\brent (come out|due)\b/i,
      /\bmy lease\b/i,
      /\blease (end|up|expire|start|term|dates?)\b/i,
      /\bhow long (is left|do i have) on\b/i,
      // Nic: late fees are per property, per state, per landlord — so even the
      // general-sounding wording is a LOOKUP on this lease, never an article.
      /\blate fee\b/i,
      /\bgrace period\b/i,
      /\bhow many days\b[^?]{0,30}\blate\b/i,
      /\bif i pay (rent )?late\b/i,
    ],
  },
]

/**
 * LANDLORD. Many properties, many tenants — so the decisive question is almost
 * always ONE vs ALL. "Is bob behind" and "is anyone behind" are different
 * lookups, and getting that backwards is how a landlord ends up reading the
 * whole delinquency list when they asked about one person.
 */
const LANDLORD_ROUTES: PhraseRoute[] = [
  {
    // S618 (Nic): "it should be able to look up any statistics... I might wanna
    // know what's the average age of my renters, or how many people are on
    // fixed income, or just at a glance where I would have to go through and
    // manually figure that out."
    //
    // FIRST among landlord routes: these are portfolio-wide questions, and the
    // narrower routes below own the same nouns in the singular ("is bob behind"
    // is one tenant; "what percent pay late" is the portfolio).
    // "Who is the most/least X" — a ranked list of names, not a rate. Sits
    // above the stats route because they share vocabulary ("how many
    // maintenance requests" is a rate; "WHO has the most" is a ranking).
    // The landlord's "what do I need to deal with" list. Above the ranking
    // route, which owns the word "complain" for the WHO-complains-most sense.
    // P&L before the general stats route: "what did I make" is an income
    // statement, not an occupancy digest.
    tools: ['get_profit_and_loss'],
    audience: 'landlord',
    means: 'the income statement — what came in, what went out, what is left',
    patterns: [
      /\b(p\s*(?:&|and)\s*l|p&l|profit and loss|income statement)\b/i,
      /\bwhat did i (make|earn|bring in|clear|net)\b/i,
      /\bhow much did i (make|earn|bring in|clear|net|spend)\b/i,
      /\b(my |total )?(profit|net income|bottom line)\b/i,
      /\bam i (profitable|making money|losing money)\b/i,
      /\bwhat (were|are) my (expenses|costs)\b/i,
      /\bhow much (did i spend|have i spent)\b/i,
      /\b(income|revenue) (vs|versus|against) (expenses|costs)\b/i,
      /\bshow me (my |the )?(p&l|pnl|profit)/i,
    ],
  },
  {
    // S626: get_books_summary had NO route — the same hole as the tenant
    // amenities tool. It only ever fired when the model happened to pick it,
    // and the first prompt change of the day tipped it to calling nothing.
    //
    // Placed BELOW the P&L route on purpose, and kept off its vocabulary.
    // get_profit_and_loss owns "p&l", "profit", "net income", "income
    // statement" and "what did I make" — that last one by its own comment, "an
    // income statement, not an occupancy digest". This route takes only the
    // plain-language framing P&L does not cover: "how did I do last month",
    // "how are the books looking", "biggest expenses". Sitting second means an
    // ambiguous phrasing still goes to P&L.
    tools: ['get_books_summary'],
    audience: 'landlord',
    means: 'the books — how the portfolio did over a period, in plain language',
    patterns: [
      /\bhow (did|have|are|is|was|were)\b[^?]{0,30}\b(do|doing|done|perform\w*|financially|money-?wise)\b/i,
      /\bhow('?s| is| are)\b[^?]{0,20}\bthe books\b/i,
      /\b(my |the )?books\b[^?]{0,20}\b(look\w*|summar\w+|snapshot)\b/i,
      /\b(biggest|largest|top)\b[^?]{0,20}\bexpenses?\b/i,
      /\b(income|expenses?) (breakdown|by category|categories)\b/i,
    ],
  },
  {
    tools: ['get_open_complaints'],
    audience: 'landlord',
    means: 'the complaints waiting on the landlord — their task list, not a ranking',
    patterns: [
      /\b(any|open|outstanding|new|current|pending)\s+complaints?\b/i,
      /\bcomplaints?\b[^?]{0,25}\b(waiting|open|outstanding|pending|need|unresolved)\b/i,
      /\bwhat do i need to (deal with|handle|address|take care of|look at)\b/i,
      /\b(is|are)\s+(anyone|any tenants?|my tenants?)\s+(unhappy|complaining|upset)\b/i,
      /\bshow me (the |my )?complaints?\b/i,
      /\bwhat'?s? (on my plate|outstanding|needs my attention)\b/i,
    ],
  },
  {
    tools: ['query_portfolio'],
    audience: 'landlord',
    means: 'a ranking — which tenant, unit or property is the most or least something',
    patterns: [
      /\bwho(?:'s| is| are)?\s+(?:my\s+)?(?:the\s+)?(most|least|worst|best|biggest|longest|highest|lowest|top)\b/i,
      // "which of my tenants owes the most" — the noun does not have to sit
      // directly after "which".
      /\bwhich\b[^?]{0,25}\b(tenants?|units?|propert(?:y|ies)|spots?|lots?|one)\b[^?]{0,35}\b(most|least|worst|best|longest|highest|lowest)\b/i,
      /\b(most|worst|best|top|bottom)\s+\d*\s*(tenants?|units?|properties)\b/i,
      /\brank (my|the)\b/i,
      /\blongest (running |standing )?(tenancy|tenant|lease)\b/i,
      /\bwho (has|have|files?|puts? in|submits?)\b[^?]{0,25}\bthe most\b/i,
      /\b(problem|problematic|needy|difficult|troublesome)\s+(tenants?|units?|neighbou?rs?)\b/i,
      /\bcomplain(s|ing|ed|t|ts)?\b/i,
      /\bwho (owes|pays late|is late)\s+the most\b/i,
      /\bmy (worst|best) (tenant|unit|property)\b/i,
    ],
  },
  {
    tools: ['get_portfolio_stats'],
    audience: 'landlord',
    means: 'a statistic about the whole portfolio — a rate, an average, a share',
    patterns: [
      /\b(what|whats|what's)\s+(percent|percentage|share|proportion|%)\b/i,
      /\b(percent|percentage|%)\s+of\s+(my\s+)?(tenants|renters|people|units|leases)\b/i,
      /\bwhat(?:'s| is)? (?:my|the) average\b/i,
      /\baverage (age|rent|lease|tenancy|stay|cost|time)\b/i,
      /\bhow (?:many|much)\b[^?]{0,30}\b(on average|typically|usually)\b/i,
      /\b(am i|are we) averaging\b/i,
      /\bhow am i doing\b/i,
      /\b(fixed income|ssi|ssdi|disability|social security)\b/i,
      /\bhow old are (my|the) (tenants|renters)\b/i,
      /\b(break|breaking|broke|end|ending|ended)\b[^?]{0,20}\blease(s)? early\b/i,
      /\bearly (termination|move-?outs?)\s*(rate|percentage)?\b/i,
      /\b(turnover|retention|occupancy) rate\b/i,
      /\b(stats|statistics|metrics|numbers|analytics)\b/i,
      /\brent roll (total|amount)\b|\btotal (monthly )?rent\b/i,
      /\bhow long do (my )?(tenants|renters|people) (stay|last)\b/i,
      /\bat a glance\b/i,
    ],
  },
  {
    // ONE named tenant or unit. Must sit ABOVE get_delinquent_tenants, which
    // owns the same vocabulary in the plural.
    tools: ['lookup_tenant_payment_status'],
    audience: 'landlord',
    means: 'the balance or standing of ONE named tenant or unit',
    extractArgs: (m) => { const who = whoOrWhere(m); return who ? { tenant: who } : undefined },
    patterns: [
      // "is bob behind", "how much does bob owe", "what's bob chen's balance"
      // — the exact phrasing that flaked, plus its neighbours.
      // The negative lookahead is what keeps "is ANYONE behind" out of here —
       // that is the delinquency list, and the two share every other word.
      /\bis\s+(?!anyone|anybody|any|someone|somebody|everyone|everybody|all|my|the|there|it|that|this|he|she|they)[a-z][a-z'-]+(\s+[a-z][a-z'-]+)?\s+(behind|current|late|paid up|caught up)\b/i,
      /\bhow much does\s+[a-z][a-z'-]+(\s+[a-z][a-z'-]+)?\s+owe\b/i,
      /\b[a-z][a-z'-]+('s|s')\s+(balance|account|standing)\b/i,
      /\bwhat('s| is| does)\b[^?]{0,30}\b(balance|owe)\b/i,
      /\b(apt|apartment|unit|lot|space|spot|site|rv|house|storage)\s*#?\s*\w+\b[^?]{0,25}\b(owe|balance|current|behind|paid)\b/i,
      /\bdoes\s+[a-z][a-z'-]+\s+owe\b/i,
      /\bhas\s+[a-z][a-z'-]+\s+paid\b/i,
      /\bpayment status (of|for)\b/i,
      /\bis\s+[a-z][a-z'-]+\s+paid\b/i,
      /\blook ?up\s+[a-z][a-z'-]+\b/i,
    ],
  },
  {
    tools: ['get_delinquent_tenants'],
    audience: 'landlord',
    means: 'everyone who is behind — the plural version',
    patterns: [
      /\b(is |does )?(anyone|anybody|any tenants?)\b[^?]{0,25}\b(behind|late|owe|not paid|unpaid)\b/i,
      /\bwho (hasn'?t|has not|didn'?t) paid\b/i,
      /\bwho is (late|behind)\b/i,
      /\bwho owes\b/i,
      /\bdelinquent\b/i,
      /\bwhich tenants? (owe|are behind|are late)\b/i,
      /\b(show|list) me\b[^?]{0,20}\b(delinquen|behind|late|unpaid)/i,
      /\bpast due (tenants|accounts|rent)\b/i,
      /\bcollections?\b/i,
      /\bhow many (tenants )?are behind\b/i,
    ],
  },
  {
    // ONE named unit's lease. Above get_lease_expirations, which is "ending
    // SOON" — a lease that ends in two years is invisible to that one.
    tools: ['get_unit_lease'],
    audience: 'landlord',
    means: 'the lease on ONE named unit',
    extractArgs: (m) => { const u = UNIT_RE.exec(m); return u ? { unit: `${u[1]} ${u[2]}` } : undefined },
    patterns: [
      /\b(lease|tenancy)\b[^?]{0,25}\b(for|on|in)\s+(apt|apartment|unit|lot|space|spot|site|rv|house|storage)\s*#?\s*\w+/i,
      /\b(apt|apartment|unit|lot|space|spot|site|rv|house|storage)\s*#?\s*\w+\b[^?]{0,30}\blease\b/i,
      /\bwhen does the lease\b[^?]{0,30}\b(end|expire|start)\b/i,
      /\bwho (is|lives) in\s+(apt|apartment|unit|lot|space|spot|site|rv|house|storage)\b/i,
      /\bwho'?s in\s+(apt|apartment|unit|lot|space|spot|site|rv|house|storage)\b/i,
      /\bwhat('s| is) the lease on\b/i,
      /\brent (amount )?(for|on)\s+(apt|apartment|unit|lot|space|spot|site|rv|house|storage)\b/i,
    ],
  },
  {
    tools: ['get_late_payment_history'],
    audience: 'landlord',
    means: 'the PATTERN of late payment over time, not who is late today',
    patterns: [
      /\bhow often\b[^?]{0,30}\blate\b/i,
      /\blate payment (history|rate|pattern|trend)\b/i,
      /\bdo (my |the )?tenants (usually|typically|generally|normally)\b/i,
      /\bpay on time\b/i,
      /\bhow many late payments\b/i,
      /\b(percent|percentage|%)\b[^?]{0,30}\blate\b/i,
      /\bpayment (history|trends?|patterns?)\b[^?]{0,20}\b(over|last|past)\b/i,
      /\bare (my )?tenants (paying|reliable)\b/i,
    ],
  },
  {
    tools: ['get_vacant_units'],
    audience: 'landlord',
    means: 'which units are empty',
    patterns: [
      /\bvacan(t|cy|cies)\b/i,
      /\bempty (units?|spots?|lots?|spaces?)\b/i,
      /\bunits?\s+(are\s+)?(sitting\s+)?(empty|open|available|unrented)\b/i,
      /\bwhat('s| is) (open|available|unrented)\b/i,
      /\bneed to fill\b/i,
      /\bhow many (units? )?(are )?(empty|open|unrented)\b/i,
      /\bunrented\b/i,
    ],
  },
  {
    tools: ['get_landlord_portfolio'],
    audience: 'landlord',
    means: 'the portfolio totals — occupancy, unit and property counts',
    patterns: [
      /\boccupanc(y|ies)\b/i,
      /\bhow many units (do i|are)\b/i,
      /\bhow (full|many occupied)\b/i,
      /\bunits? (are )?occupied\b/i,
      /\bhow many properties\b/i,
      /\bmy portfolio\b/i,
      /\btotal units\b/i,
      /\bportfolio (summary|overview|size)\b/i,
    ],
  },
  {
    tools: ['get_lease_expirations'],
    audience: 'landlord',
    means: 'leases ending SOON, across the portfolio',
    patterns: [
      /\bleases?\s+(are\s+|is\s+)?(expiring|ending|coming up|up)\b/i,
      /\bexpir\w+ leases?\b/i,
      /\bwho(se|'s)? lease is up\b/i,
      /\brenewals? (coming|due|up)\b/i,
      /\bupcoming (lease )?(expirations?|renewals?)\b/i,
      /\bwhat leases end\b/i,
      /\bmove-?outs? coming\b/i,
    ],
  },
  {
    tools: ['get_pending_maintenance'],
    audience: 'landlord',
    means: 'work orders waiting on the landlord',
    patterns: [
      /\b(maintenance|repairs?|work orders?)\b[^?]{0,25}\b(waiting|open|pending|to approve|need)\b/i,
      /\bopen work orders?\b/i,
      /\bwhat('s| is) open on maintenance\b/i,
      /\brepairs? to approve\b/i,
      /\bapprov\w+\b[^?]{0,20}\b(maintenance|repair)\b/i,
      /\bany maintenance\b/i,
      /\bpending (maintenance|repairs?)\b/i,
    ],
  },
  {
    tools: ['get_property_rent_roll'],
    audience: 'landlord',
    means: 'the rent roll — every unit with its rent and status',
    patterns: [
      /\brent roll\b/i,
      /\bwhat (is|are) (each|every) unit\b[^?]{0,20}\brent\b/i,
      /\bunit by unit\b/i,
      /\brents? (by|per) unit\b/i,
      /\bhow much (rent )?(am i|do i) collect\b/i,
    ],
  },
]

/**
 * S620 — the booking side and the front door.
 *
 * The phrase table shipped covering tenant and landlord, which is also exactly
 * the two audiences the battery covered. Measured on the first run that
 * included the other three: a site visitor asking "do you have anything open
 * next weekend?" called NO tool on 4 of 4 phrasings and was suppressed to
 * "I don't want to quote you a figure I haven't actually checked" — the
 * anti-fabrication guard doing its job over a hole where the routing should
 * have been. That is the booking front door answering a booking question with
 * a non-answer.
 *
 * Same shape as above: no answers, no numbers, only which lookup runs. It
 * matters more here than anywhere else, because every figure on a booking site
 * is per-property and set by that landlord — the ONE thing this model must
 * never produce from memory.
 */
const VISITOR_ROUTES: PhraseRoute[] = [
  {
    // DATES FIRST. "Can I book the 15th to the 20th" is an availability
    // question, not a rate-card question, and check_availability is the only
    // tool that prorates and adds tax. Above the rate routes deliberately:
    // a wording with dates in it should never fall through to the rate card.
    // TWO tools, and the order is the whole point. check_availability is the
    // right answer and it REQUIRES checkIn/checkOut — which only the model can
    // resolve, because "next weekend" is a date this table must never guess.
    // So when the model declines to call it, the direct-execution path skips
    // it (missing required args) and runs the rate card instead: the visitor
    // gets real published rates and a request for their dates, rather than
    // "I don't want to quote you a figure I haven't actually checked", which
    // is what 4 of 4 availability phrasings produced before this.
    //
    // Rates without dates is an honest partial answer. Silence is not.
    tools: ['check_availability', 'get_property_pricing'],
    audience: 'visitor',
    means: 'are these dates open, and what would they cost',
    patterns: [
      /\b(availab\w+|opening|open|free|vacan\w+|book\w*)\b[^?]{0,40}\b(next|this|on|for|from|in|the)\b[^?]{0,30}\b(weekend|week|month|night|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})\b/i,
      /\b(do|are) you (have|got|any)\b[^?]{0,40}\b(availab\w+|open|free|vacan\w+|room|space|site|spot)\b/i,
      /\b(anything|any sites?|any spots?|any room)\b[^?]{0,25}\b(open|free|availab\w+|left)\b/i,
      /\bcan i (book|reserve|stay|get)\b[^?]{0,40}\b(\d{1,2}(st|nd|rd|th)?|next|this)\b/i,
      /\b(from|between)\b[^?]{0,15}\b\d{1,2}(st|nd|rd|th)?\b[^?]{0,15}\b(to|until|through|-)\b[^?]{0,15}\b\d{1,2}(st|nd|rd|th)?\b/i,
      // A DATE RANGE on its own, with no "from" in front of it: "how much for
      // the 15th to the 20th". Caught by its own test — that wording fell to
      // the rate card, which cannot answer it. The rate card would have quoted
      // a nightly figure for a question about five specific nights, with no
      // proration and no tax.
      /\b\d{1,2}(st|nd|rd|th)\b\s*(?:to|until|through|thru|-|–|—)\s*(?:the\s*)?\d{1,2}(st|nd|rd|th)?\b/i,
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b\s*(?:to|until|through|thru|-|–|—)/i,
      /\b(check[- ]?in|check[- ]?out|arriv\w+|depart\w+)\b[^?]{0,30}\b\d/i,
    ],
  },
  {
    // The rate card, for "how much" with no dates attached. S618 made this
    // audience look everything up precisely so a nightly rate could never come
    // out of the model's head; without a route, "look it up" had no target.
    tools: ['get_property_pricing'],
    audience: 'visitor',
    means: "this property's published rates — nightly, weekly, monthly, deposit, tax",
    patterns: [
      /\bhow much\b/i,
      /\b(rate|rates|pricing|price|prices|cost|costs|charge)\b/i,
      /\b(per|a) (night|week|month)\b/i,
      /\b(nightly|weekly|monthly|long[- ]?term|extended)\b/i,
      /\b(deposit|tax|taxes|fee|fees)\b/i,
      /\bwhat (do|does) (it|you|a site|a spot) (cost|run|charge)\b/i,
      /\b(cheap|expensive|affordable)\b/i,
      /\b(pull[- ]?through|back[- ]?in|\d{2} ?amp)\b/i,
    ],
  },
  {
    // "What is this place" — the agent is on ONE property's site and should
    // never have to guess its name. The unresolved "[property name]" that
    // reached a customer in the S620 battery came from exactly this gap.
    tools: ['get_property_info'],
    audience: 'visitor',
    means: 'what this property is — name, where it is, what is on site',
    patterns: [
      /\b(what|where) (is|are) (this|that|the) (place|property|park|resort|site|spot|motel|address)\b/i,
      /\btell me about\b[^?]{0,25}\b(this|the|your)\b/i,
      /\bwhere (am i|are you|is it|are we)\b/i,
      /\b(amenit\w+|pool|laundry|wifi|wi-?fi|clubhouse|hookups?|shower|bathroom|pet|dog|rules?)\b/i,
      /\bwhat('?s| is) (there|here|on site|available)\b/i,
    ],
  },
]

/**
 * S620 — the guest with a booking. Every one of these is a fact ON their
 * booking, which is the definition of a lookup: two guests at the same
 * property have different dates, different nights and different totals.
 */
const GUEST_ROUTES: PhraseRoute[] = [
  {
    // ABOVE the read route: a REQUEST is not a question about the booking, and
    // "can I get a late checkout" answered from get_guest_booking is how the
    // battery saw four confident replies that changed nothing.
    tools: ['request_booking_change'],
    audience: 'guest',
    means: 'asking the host to change the stay — late checkout, early check-in, an extra night',
    patterns: [
      /\b(late|later)\b[^?]{0,20}\bcheck[- ]?out\b/i,
      /\b(early|earlier)\b[^?]{0,20}\bcheck[- ]?in\b/i,
      /\bcheck ?out (later|at \d)/i,
      /\bcheck ?in (early|earlier|at \d)/i,
      /\b(extra|another|one more|extend|add a)\b[^?]{0,20}\b(night|nights?|day|days?)\b/i,
      /\b(stay|staying)\b[^?]{0,25}\b(longer|extra|another night|an extra)\b/i,
      /\bcan i (get|have|request|ask for)\b[^?]{0,30}\b(late|early|extra|another)\b/i,
    ],
  },
  {
    tools: ['get_guest_booking'],
    audience: 'guest',
    means: "the facts on this guest's own stay — dates, nights, unit, total",
    patterns: [
      /\b(check[- ]?in|check[- ]?out|checkin|checkout)\b/i,
      /\bmy (stay|booking|reservation|dates|trip)\b/i,
      /\bhow (many|long)\b[^?]{0,25}\b(nights?|days?|stay\w*)\b/i,
      /\bwhen (do|does|am|is)\b[^?]{0,25}\b(i|my)\b[^?]{0,20}\b(leave|arrive|check|stay|start|end)\b/i,
      /\b(how much|what.{0,12}(total|owe|paid|charged|cost))\b/i,
      /\b(what|which) (unit|site|spot|space|rv)\b/i,
      /\bremind me\b/i,
    ],
  },
  {
    tools: ['get_guest_amenities'],
    audience: 'guest',
    means: 'what is on the property and whether it can be reserved',
    patterns: [
      /\b(amenit\w+|pool|laundry|clubhouse|gym|hot tub|fire ?pit|wifi|wi-?fi|shower|bathroom)\b/i,
      /\bwhat('?s| is) there to do\b/i,
      /\bcan i (book|reserve|use)\b[^?]{0,30}\b(the|a)\b/i,
    ],
  },
]

/**
 * S620 — the prospect. Lucy holds NO data lookups, so almost nothing here is a
 * lookup: her figures are GAM's own rate card, the one thing an agent may
 * answer from the knowledge base (see demandsAToolCall's platform exemption).
 *
 * The exception is her actual job. Measured: asked "can I talk to someone?"
 * and "I want to schedule a demo", the sales agent called NOTHING on 4 of 4
 * and replied "Want me to grab you a time?" — an offer to book against no
 * calendar, on the commercial front door. Booking a call IS a tool call.
 */
const PROSPECT_ROUTES: PhraseRoute[] = [
  {
    tools: ['get_available_call_times'],
    audience: 'prospect',
    means: 'they want to speak to a person — offer real times off the real calendar',
    patterns: [
      /\b(talk|speak|chat)\b[^?]{0,25}\b(to|with)\b[^?]{0,20}\b(someone|somebody|a (real )?person|a human|sales|the team|a strategist|rep)\b/i,
      /\b(schedule|book|set ?up|arrange|grab|get)\b[^?]{0,25}\b(a )?(call|demo|meeting|time|appointment|walkthrough)\b/i,
      /\b(demo|consultation)\b/i,
      /\bcan we (talk|meet|call|chat)\b/i,
      /\bwhen (can|could) (we|i)\b[^?]{0,20}\b(talk|meet|call|chat)\b/i,
      /\bwhat times?\b[^?]{0,25}\b(availab\w+|open|work)\b/i,
      /\bhow do i get started\b/i,
      /\b(sign|signing) up\b/i,
    ],
  },
]

const ALL_ROUTES: PhraseRoute[] = [
  ...TENANT_ROUTES, ...LANDLORD_ROUTES,
  ...VISITOR_ROUTES, ...GUEST_ROUTES, ...PROSPECT_ROUTES,
]

/**
 * Which lookup does this message call for?
 *
 * Returns undefined when nothing matches — the common case for anything this
 * table does not cover, and the runner then falls back to its previous
 * behaviour (force SOME tool and let the model pick). This is additive: it can
 * make the choice more certain, never less.
 *
 * `available` is the calling profile's own tool list. A route whose tool the
 * profile does not hold is skipped rather than forced, so this can never ask an
 * agent to call something it was not given — the bug S617 hit when a landlord
 * agent was told to call tenant tools.
 */
/**
 * The lookups a wording calls for.
 *
 * Delegates to routePlan — S618: these were two separate loops over ALL_ROUTES
 * and they drifted the moment one was improved. The pronoun normalisation went
 * into routePlan (which the runner uses) and not into this one (which the tests
 * use), so "who owes me the most" routed correctly in production and wrongly in
 * the test, and the test was the thing telling us it worked. One loop.
 */
export function routeToTools(
  message: string,
  audience: AgentAudience,
  available: readonly string[] = [],
): string[] {
  return routePlan(message, audience, available).tools
}

/**
 * The lookups for a wording AND the arguments the wording supplies.
 * `args` is undefined when the route takes none or the message did not say.
 */
/**
 * Filler that changes nothing about which lookup answers the question.
 *
 * S618 (Nic): "the word me shouldn't matter in this search scenario on who owes
 * me the most money, because the agent is only scoped to that landlord's
 * portfolio anyway. The word me seems irrelevant in this search."
 *
 * Exactly right, and the first fix here was the wrong shape: "who owes me the
 * most" failed to route, and I added `(\s+me)?` to that one pattern — which
 * fixes one sentence and leaves "who owes me the most money", "which of my
 * tenants owes me", and every other placement still broken.
 *
 * So every pattern is tried against the message AND against a version with the
 * object pronouns removed. "me/us" name the landlord, who is the only person
 * this agent can see. "my/our" are NOT stripped — a tenant's "my balance" and
 * "my lease" are load-bearing, and the tenant routes are built on them.
 */
function withoutFiller(message: string): string {
  return message.replace(/\b(?:me|us)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim()
}

export function routePlan(
  message: string,
  audience: AgentAudience,
  available: readonly string[] = [],
  /**
   * S626: what the person said on the PREVIOUS turn, for anaphora only.
   *
   * The table has only ever seen the current message, and a follow-up routinely
   * does not carry its own subject. "and what happens if I want to stay on
   * after that?" — "that" is the lease end date, named one turn earlier. Read
   * alone the sentence is about nothing, so the table returned no tools, the
   * safety net had nothing to force, and the agent answered from memory by
   * inventing a renewal request it then offered to submit.
   *
   * Nic's note on this exact conversation: "Should infer 'renewal' from the two
   * messages together."
   *
   * Used STRICTLY as a fallback, and this is what makes it safe: it is
   * consulted only when the message on its own matched nothing at all, so it
   * can add routing where there was none and can never override a route the
   * current message already chose. A genuine change of subject still routes on
   * its own words.
   */
  previousUserMessage?: string,
): { tools: string[]; args?: Record<string, unknown> } {
  if (!message) return { tools: [] }
  const direct = matchRoutes(message, audience, available)
  if (direct) return direct
  if (previousUserMessage?.trim()) {
    // Args still come from the CURRENT wording — the previous turn supplies the
    // subject, never the values.
    const joined = `${previousUserMessage.trim()} ${message.trim()}`
    // Skip any route the PREVIOUS message already matched on its own. The
    // routes are ordered, and without this the joined sentence simply re-matches
    // the earlier turn: "when does my lease end? and what happens after that?"
    // hits the lease-end route first and answers the question that was already
    // answered — the repeat bug again, one layer down. What we want is the route
    // the follow-up UNLOCKED, so the turn that has already been served is
    // excluded from the running.
    // Stage one: what did the follow-up UNLOCK? Skipping the routes the
    // previous message already matched finds a genuinely new subject.
    const unlocked = matchRoutes(joined, audience, available, previousUserMessage)
    if (unlocked) return { tools: unlocked.tools, args: matchRoutes(message, audience, available)?.args }
    // Stage two: THE DRILL-DOWN. "how many units are vacant?" then "which of
    // those are at Sunset Palms?" is the same question narrowed to one
    // property, so the route that served the first turn is exactly the right
    // one — the second turn only changes an argument. Stage one deliberately
    // excludes it, which would have left the commonest landlord follow-up in
    // the portfolio routing nothing at all. Reached only when nothing else
    // matched, so a real change of subject still wins on its own words.
    const narrowed = matchRoutes(joined, audience, available)
    if (narrowed) {
      // Arguments come from THIS turn — the previous one supplies the query,
      // this one supplies what to filter it to.
      return { tools: narrowed.tools, args: narrowed.extractFrom?.(message) ?? narrowed.args }
    }
  }
  return { tools: [] }
}

function matchRoutes(
  message: string,
  audience: AgentAudience,
  available: readonly string[],
  /** Ignore routes this text already matches — see the carry-over note above. */
  alreadyServed?: string,
): {
  tools: string[]
  args?: Record<string, unknown>
  /** The matched route's own extractor, so a drill-down can re-read the new turn. */
  extractFrom?: (message: string) => Record<string, unknown> | undefined
} | null {
  const have = new Set(available)
  const stripped = withoutFiller(message)
  const servedStripped = alreadyServed ? withoutFiller(alreadyServed) : ''
  for (const route of ALL_ROUTES) {
    if (route.audience !== audience) continue
    if (alreadyServed && route.patterns.some(
      (re) => re.test(alreadyServed) || re.test(servedStripped))) continue
    // Match on what was said, or on the same sentence without the pronouns
    // that name the person the agent is already scoped to.
    if (!route.patterns.some((re) => re.test(message) || re.test(stripped))) continue
    const usable = have.size ? route.tools.filter((t) => have.has(t)) : route.tools
    if (!usable.length) continue
    // Arguments come from the ORIGINAL wording — a complaint is recorded in the
    // tenant's real words, not a stripped version of them.
    return { tools: usable, args: route.extractArgs?.(message), extractFrom: route.extractArgs }
  }
  return null
}

/** First (primary) lookup for a wording, or undefined. */
export function routeToTool(
  message: string,
  audience: AgentAudience,
  available: readonly string[] = [],
): string | undefined {
  return routeToTools(message, audience, available)[0]
}

/** Exposed for the guard tests, which assert the table itself stays coherent. */
export const ROUTES_FOR_TEST = ALL_ROUTES
