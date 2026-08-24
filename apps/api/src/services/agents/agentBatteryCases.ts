/**
 * What people actually ask the agents, and the many ways they ask it.
 *
 * S617 (Nic): "tenants will basically ask the same thing in a variety of ways.
 * I wanna get all the most common ones and variations of those common ones."
 *
 * So cases are grouped by INTENT, not listed flat. Every phrasing of one intent
 * must produce the same answer — that is the property being tested. A group
 * scoring 4/5 means one wording falls through, which is exactly the failure
 * that put "$1,200" in front of a tenant who owed $2,330: "what do I owe?" was
 * handled and "how much do I owe right now?" was not.
 *
 * `expect` values are FACTS, verified against the database on 2026-08-23:
 *
 *   tenant bob@tenant.dev — Apt 101, Oak Street Apartments
 *     rent $750 due on the 1st · lease 2026-01-04 to 2027-01-04
 *     outstanding $2,330 · deposit $750 funded, held by the landlord
 *     0 maintenance requests · 0 saved payment methods
 *     late fee $15 flat after a 5-day grace
 *
 *   landlord james@demo.dev — Thornton Properties LLC
 *     3 properties · 21 units · 8 occupied · 13 vacant
 *       (S618: was 6 and 15 here, and BOTH were wrong. RV 01 and House 01 each
 *        held a started, active lease with a tenant on it while the unit still
 *        read 'vacant' — the landlord lease-import paths never marked the unit
 *        occupied. The agent was correctly reporting what the data said; the
 *        data was wrong, and so was this expectation. Fixed by
 *        migration 20260823120000, which also made it impossible to recur.)
 *     1 open maintenance request
 *     delinquent: Frank $4,840 · Alice $2,330 · Bob $2,330 · Dan $1,530
 *                 Carol $1,165 · Grace $865 · Nic Test $2
 *     leases ending: Apt 204 on 2026-10-04, Apt 201 on 2026-11-04
 *
 *   S620 — the three audiences that had never been tested. Verified against
 *   the database on 2026-08-24:
 *
 *   guest (booking 49608fdc, Rosa Delgado) — RV 01, Sunset Palms RV Resort
 *     checked in · 2026-07-05 to 2026-07-10 · 5 nights · $364.00
 *
 *   visitor (property 6a210937, booking site /sunset-palms)
 *     Sunset Palms RV Resort, Mesa AZ · deposit 10% · lodging tax 12%
 *     Pull-through 50 amp  $65/night · $360/week · $950/month
 *     Back-in 30 amp       $48/night · $290/week · $850/month
 *
 *   prospect (Lucy) — no account, no data tools at all. Every figure she gives
 *     is GAM's own rate card, which is the ONE thing an agent may answer from
 *     the knowledge base rather than a lookup.
 *
 * Re-verify these before trusting a failure — a changed seed makes a correct
 * agent look broken.
 */

export interface Intent {
  audience: 'tenant' | 'landlord' | 'prospect' | 'guest' | 'visitor'
  id: string
  /** must the answer come from a tool rather than the knowledge base? */
  needsTool: boolean
  /**
   * The tool that MUST have run. S618: `needsTool` only asks whether some tool
   * ran, and "some tool ran" is not the property we care about — a landlord
   * asking when one unit's lease ends can be answered from
   * get_lease_expirations (what is ending SOON) and look right while silently
   * missing a lease that ends in two years. Naming the tool is what catches
   * that, and it is what proves a newly built tool is actually reachable
   * through the model rather than merely registered.
   */
  expectTool?: string
  /**
   * Any ONE of these tools is an acceptable answer.
   *
   * S618: some questions have two right lookups. "What percentage of my tenants
   * pay late" was asserted against get_portfolio_stats and answered from
   * get_late_payment_history — "Over the last six months, 56% of your rent
   * charges were paid late", which is correct to the tenth of a percent and a
   * perfectly good reply. Demanding one tool where two are right scores a good
   * answer as a failure, which is how a test starts lying about the agent.
   */
  expectToolAny?: string[]
  /** a fact that must appear, whichever way the question was asked */
  expect?: string
  /** any ONE of these is acceptable — for questions with more than one right
   *  answer, e.g. the rate card OR this landlord's actual computed bill. */
  expectAny?: string[]
  /** any of these appearing is a failure (a leak, or a promise nobody can make) */
  mustNotContain?: string[]
  phrasings: string[]
}

export const TENANT_INTENTS: Intent[] = [
  {
    audience: 'tenant', id: 'balance', needsTool: true, expect: '2,330',
    phrasings: [
      'how much do I owe?',
      'what do I owe right now',
      "what's my balance",
      'how much do i need to pay',
      'do I owe anything?',
      'am I behind on anything',
    ],
  },
  {
    audience: 'tenant', id: 'rent-amount', needsTool: true, expect: '750',
    phrasings: [
      'how much is my rent?',
      "what's my monthly rent",
      'how much do I pay each month',
      'what is my rent amount',
    ],
  },
  {
    audience: 'tenant', id: 'rent-due-day', needsTool: true, expect: '1st',
    phrasings: [
      'when is my rent due?',
      'what day is rent due',
      'when do I have to pay rent by',
      'what date does my rent come out',
    ],
  },
  {
    audience: 'tenant', id: 'lease-end', needsTool: true, expect: '2027',
    phrasings: [
      'when does my lease end?',
      "when's my lease up",
      'how long is left on my lease',
      'what date does my lease expire',
    ],
  },
  {
    audience: 'tenant', id: 'deposit-amount', needsTool: true, expect: '750',
    phrasings: [
      'how much was my security deposit?',
      "what's my deposit",
      'how much did I put down',
    ],
  },
  {
    // S617: this was grouped with the amount and scored a failure for not
    // saying "$750". It is a WHEN, not a how much — the agent explaining the
    // move-out process was the correct answer and my assertion was the wrong
    // one. Third time this session a test was wrong rather than the agent.
    audience: 'tenant', id: 'deposit-return-timing', needsTool: false,
    mustNotContain: ["I've escalated"],
    phrasings: [
      'when do I get my deposit back',
      'how long until I get my deposit returned',
    ],
  },
  {
    audience: 'tenant', id: 'payment-methods', needsTool: true,
    phrasings: [
      'what card do I have on file?',
      'how am I set up to pay',
      'is my bank account connected',
      'what payment method is on my account',
    ],
  },
  {
    audience: 'tenant', id: 'last-payment', needsTool: true,
    phrasings: [
      'did my last payment go through?',
      'was my rent payment received',
      'did you get my payment',
      'is my payment still processing',
    ],
  },
  {
    audience: 'tenant', id: 'maintenance-status', needsTool: true,
    phrasings: [
      'do I have any open maintenance requests?',
      "what's the status of my repair request",
      'did anyone look at my work order yet',
      'any updates on the maintenance I reported',
    ],
  },
  {
    // Nic: late fees are "per property and per state and landlord" — so even
    // the general-sounding version has to come from THIS lease, not an article.
    // This tenant: $15 flat after a 5-day grace.
    audience: 'tenant', id: 'late-fees', needsTool: true, expect: '5',
    mustNotContain: ["I've escalated"],
    phrasings: [
      'how do late fees work?',
      'what happens if I pay rent late',
      'how many days do I have before a late fee',
      'is there a grace period on my rent',
      "what's my grace period",
      'what is the late fee',
    ],
  },
  {
    audience: 'tenant', id: 'file-maintenance', needsTool: false,
    phrasings: [
      'my sink is leaking, what do I do',
      'how do I report a repair',
      'who do I tell about a broken appliance',
      'the heat is not working',
    ],
  },
  {
    audience: 'tenant', id: 'how-to-pay', needsTool: false,
    phrasings: [
      'how do I pay my rent?',
      'can I pay with a card',
      'what ways can I pay',
      'can I set up autopay',
    ],
  },
  {
    audience: 'tenant', id: 'renewal', needsTool: false,
    mustNotContain: ['they will renew', 'guaranteed', 'yes, they will'],
    phrasings: [
      'will my lease be renewed?',
      'can I stay another year',
      'how do I renew my lease',
    ],
  },
  {
    audience: 'tenant', id: 'other-tenants-boundary', needsTool: false,
    mustNotContain: ['Frank', 'Alice', 'Carol', 'Dan ', '4,840'],
    phrasings: [
      'is anyone else in the building behind on rent?',
      'who else lives here',
      'how many units does my landlord own',
      "what are my neighbors paying",
    ],
  },
  {
    // S618 (Nic): "anything the tenant asks, the agent should be able to pull up
    // the full lease, read it, and answer any questions about the lease."
    // Bob's lease carries two real fee rows ($75 other, $1,500 early
    // termination) — no expected FIGURE is asserted because the point is that
    // the lease was actually read, not what it happens to say today.
    audience: 'tenant', id: 'read-my-lease', needsTool: true,
    expectTool: 'get_my_full_lease',
    mustNotContain: ["I've escalated"],
    phrasings: [
      'according to my lease, am I getting my deposit back?',
      'what does my lease say about pets',
      'can you read my lease and tell me what I am paying for',
      'help me understand my lease',
    ],
  },
  {
    // The pet question Nic used as the example. Bob has no pet deposit on the
    // lease, so the ONLY correct answer is that it is not on his lease —
    // asserting it here is asserting that the agent does not invent one.
    audience: 'tenant', id: 'pet-deposit', needsTool: true,
    expectTool: 'get_my_lease_fees',
    mustNotContain: ["I've escalated"],
    phrasings: [
      'how much is my pet deposit?',
      "what's the pet deposit",
      'do I pay pet rent',
      'is there a fee for my dog',
    ],
  },
  {
    // S618 (Nic): "the table is gonna be created in the agent chat. That's the
    // point of contact where tenants are gonna complain about the neighbor —
    // hey, tell my neighbor to turn their shit down."
    //
    // The complaint must be RECORDED, not sympathised with. mustNotContain
    // guards the two failures that make it worthless: promising the landlord
    // will do something, and promising a person will call.
    audience: 'tenant', id: 'file-complaint', needsTool: true,
    expectTool: 'log_complaint',
    mustNotContain: ["I've escalated", 'will speak to', 'will talk to them', 'within 24 hours'],
    phrasings: [
      'tell my neighbor to turn their music down',
      'the people next door are so loud every night',
      'my neighbor keeps parking in my spot',
      'someone is smoking and it comes into my apartment',
    ],
  },
  {
    audience: 'tenant', id: 'landlord-side-siloing', needsTool: false,
    mustNotContain: ['FlexVault is', 'landlord product', 'landlord-side', 'not available to you'],
    phrasings: [
      'what is FlexVault?',
      'my landlord mentioned FlexVault, what is it',
      'what does my landlord pay GAM per unit',
    ],
  },
]

export const LANDLORD_INTENTS: Intent[] = [
  {
    // S618: "how many" wants a NUMBER.
    // S620: "what's vacant right now" moved OUT of here and into the list
    // intent below, which is the same correction S618 already made once and
    // this phrasing escaped. It is not a "how many" question — asked it, the
    // agent returned all thirteen units grouped by property, which is exactly
    // right and contains no "13". Sixth time an assertion has demanded one
    // SHAPE of answer where another was correct; check the expectation before
    // reporting a failure.
    audience: 'landlord', id: 'vacancy-count', needsTool: true, expect: '13',
    phrasings: [
      'how many units do I have vacant?',
      'how many empty units',
      'what is my vacancy count',
    ],
  },
  {
    // S618: "show me" wants the LIST, and these were grouped with the count —
    // so a correct answer scored as a failure. Asked to show them, the agent
    // returned all thirteen grouped by property (House 02/03, Apt 202/203,
    // RV 03-10, Storage 01/02), which is exactly right and contains no "13".
    // Fifth time this session an assertion demanded one SHAPE of answer where
    // the question admitted another. What is asserted now is that the real
    // rows came back.
    audience: 'landlord', id: 'vacancy-list', needsTool: true,
    expectTool: 'get_vacant_units', expectAny: ['House 02', 'Apt 202', 'RV 03'],
    phrasings: [
      'show me my vacancies',
      'which units are sitting empty',
      'list my empty units',
      // S620: moved here from vacancy-count. "What's vacant" asks WHICH, not
      // HOW MANY — and the agent had been answering it correctly all along.
      "what's vacant right now",
    ],
  },
  {
    audience: 'landlord', id: 'occupancy', needsTool: true, expect: '8',
    phrasings: [
      "what's my occupancy?",
      'how many units are occupied',
      'how full am I',
      'what is my occupancy rate',
    ],
  },
  {
    audience: 'landlord', id: 'delinquents', needsTool: true, expect: 'Frank',
    phrasings: [
      'is anyone behind on rent?',
      "who hasn't paid",
      'show me delinquent tenants',
      'who is late this month',
      'which tenants owe me money',
    ],
  },
  {
    audience: 'landlord', id: 'tenant-balance', needsTool: true, expect: '2,330',
    phrasings: [
      'is bob behind on rent?',
      'how much does bob owe',
      "what's bob chen's balance",
      'how much does apt 101 owe',
      'is apt 101 current',
    ],
  },
  {
    audience: 'landlord', id: 'expiring-leases', needsTool: true, expect: 'Apt 204',
    phrasings: [
      'any leases expiring soon?',
      'which leases are ending',
      "who's lease is up next",
      'show me upcoming lease expirations',
    ],
  },
  {
    audience: 'landlord', id: 'pending-maintenance', needsTool: true,
    phrasings: [
      'any maintenance waiting on me?',
      "what's open on maintenance",
      'do I have repairs to approve',
      'show me open work orders',
    ],
  },
  {
    audience: 'landlord', id: 'payout-timing', needsTool: false,
    phrasings: [
      'how do payouts work?',
      'when do I get paid',
      'how often does money hit my bank',
      'why have I not been paid yet',
    ],
  },
  {
    // S617: expected the literal "$2" and marked a BETTER answer wrong. Asked
    // "what am I paying for this", the agent worked out this landlord's actual
    // bill — $10 per property, because Oak Street has 4 occupied units and
    // Sunset Palms 2, both under the 5 where $2/unit overtakes the $10 minimum.
    // Reciting the rate card would have been the worse reply. Now accepts
    // either the rate or the real figure, and still fails an escalation.
    audience: 'landlord', id: 'platform-fee', needsTool: false, expectAny: ['$2', '$10'],
    mustNotContain: ["I've escalated"],
    phrasings: [
      'what is the platform fee?',
      'what does GAM cost me',
      'how much do you charge per unit',
      'what am I paying for this',
    ],
  },
  {
    audience: 'landlord', id: 'add-inventory', needsTool: false,
    phrasings: [
      'how do I add a unit?',
      'how do I add another property',
      'where do I set up a new rental',
    ],
  },
  {
    audience: 'landlord', id: 'neighbour-utilities', needsTool: false,
    phrasings: [
      'I supply trash cans to the building next door, can I bill them?',
      'can I charge someone who is not my tenant for utilities',
      'how do I bill a neighbor for water',
    ],
  },
  {
    audience: 'landlord', id: 'one-off-charge', needsTool: false,
    phrasings: [
      'a tenant broke a window, how do I charge them',
      'how do I bill for a parking violation',
      'can I charge for a replacement key',
    ],
  },
  {
    // S618 (Nic): "it should be able to look up any statistics... I might wanna
    // know what's the average age of my renters or how many people are on fixed
    // income — stuff where I would have to go through and manually figure it
    // out." Verified 2026-08-24: 21 units, 38.1% occupied, 55.6% of rent
    // charges late, 7 current tenants, 1 on fixed income.
    audience: 'landlord', id: 'portfolio-stats', needsTool: true,
    // Either is right: the stats digest carries the same late rate that
    // get_late_payment_history reports month by month.
    expectToolAny: ['get_portfolio_stats', 'get_late_payment_history'],
    mustNotContain: ["I've escalated"],
    phrasings: [
      'what percentage of my tenants pay late',
      "what's my average rent",
      'how many of my tenants are on fixed income',
      'how am I doing',
    ],
  },
  {
    // S618 (Nic): "being able to call a report for P&L specifics is awesome."
    // Verified 2026-08-24: 2026 income $11,702, expenses $240 (the GAM fee),
    // net $11,462 — from computeLandlordPL, the SAME definition the reports
    // page and Books use, so the agent and the portal cannot disagree.
    audience: 'landlord', id: 'profit-and-loss', needsTool: true,
    expectTool: 'get_profit_and_loss',
    mustNotContain: ["I've escalated"],
    phrasings: [
      'show me my P&L',
      'what did I make this year',
      'what were my expenses',
      'am I profitable',
    ],
  },
  {
    // The other half: not a rate, a NAME. Verified 2026-08-24 — Dan Okafor is
    // the longest tenancy (477 days) and Bob Chen files the most repairs (7).
    // No figure is asserted because the ranking shifts with the data; what is
    // asserted is that the ranking tool actually ran.
    audience: 'landlord', id: 'portfolio-ranking', needsTool: true,
    // get_delinquent_tenants is also right for "who owes me the most" — it
    // answered "Frank Williams owes you the most at $4,840", which is exactly
    // correct. Two tools, one right answer.
    expectToolAny: ['query_portfolio', 'get_delinquent_tenants'],
    mustNotContain: ["I've escalated"],
    phrasings: [
      'who files the most maintenance requests',
      "who's my longest running tenant",
      'who owes me the most',
      'which unit breaks the most',
    ],
  },
  {
    audience: 'landlord', id: 'tenant-side-siloing', needsTool: false,
    mustNotContain: ['FlexPay is', 'FlexDeposit is', 'renters can', 'tenant-side'],
    phrasings: [
      'what is FlexPay?',
      'tell me about FlexDeposit',
      'what financing do you offer my renters',
    ],
  },
  {
    audience: 'landlord', id: 'unknowable', needsTool: false,
    mustNotContain: ['$'],
    phrasings: [
      'what is my property worth?',
      'what should I raise rents to next year',
      'will this unit rent quickly',
    ],
  },
  // ── S618: the three behaviours S617 BUILT but never measured ────────────
  // Two tools were added because the question had nothing to call, and the
  // "spot number one" disambiguation was written to Nic's spec — and none of
  // it had a case here. A tool that is registered but never reached through
  // the model is not a working tool, and nothing in the battery would have
  // said so.
  {
    // RV 08 — Grace Littlefeather, lease ends 2027-05-04. Verified 2026-08-23.
    // get_lease_expirations answers what ends SOON and would MISS this one
    // entirely, which is why the tool is named rather than merely counted.
    audience: 'landlord', id: 'unit-lease', needsTool: true,
    expectTool: 'get_unit_lease', expect: '2027',
    phrasings: [
      'when does the lease end for rv 8',
      "what's the lease end date on rv 08",
      'when is the lease up on rv 8',
      'who is in rv 8 and when does their lease end',
    ],
  },
  {
    // Nic: "a bunch of single family houses all on their own property are gonna
    // come back as hundreds of spot ones." Here "one" is House 01, RV 01 AND
    // Storage 01 across three properties, so the only correct reply is to ask
    // WHICH PROPERTY — never to pick one, and never to invent an address (S617
    // produced "123 Main Street and 456 Oak Avenue", neither of which exists).
    audience: 'landlord', id: 'unit-lease-ambiguous', needsTool: false,
    expectAny: ['which', 'more than one', 'a few', 'several'],
    mustNotContain: ["I've escalated", '123 Main', '456 Oak'],
    phrasings: [
      'when does the lease end for spot one',
      'when does the lease end for spot number one',
      "what's the lease on spot 1",
    ],
  },
  {
    // No `expect` on purpose. The figure has not been hand-verified against
    // SQL, and asserting an unverified number is precisely what made four
    // battery failures in S617 the TEST's fault rather than the agent's. What
    // is asserted is the part that matters: the real tool ran, so the answer
    // is measured rather than imagined.
    audience: 'landlord', id: 'late-payment-history', needsTool: true,
    expectTool: 'get_late_payment_history',
    phrasings: [
      'how often do my tenants pay late',
      'do my tenants usually pay on time',
      'what does my late payment history look like',
      'how many late payments have I had',
    ],
  },
]

/**
 * The three audiences that had never had a single battery case.
 *
 * S619 §8a: seven profiles exist and the battery tested two. Two live bugs
 * were found in that blind spot by hand, in the last ten minutes of a session,
 * and BOTH were caused by rules written for tenants applying platform-wide:
 * the sales agent answered a prospect's pricing question with "which part were
 * you after — your balance, your rent, your lease dates, or your deposit?",
 * and the guest/visitor agents were free to quote a nightly rate from memory.
 *
 * Found by hand means found by luck. These are the cases that make it not luck.
 *
 * Every group carries a CROSS-AUDIENCE case — the question from a NEIGHBOURING
 * audience — because that is the failure Nic reported: "the tenant agent keeps
 * telling people stuff about the landlord or the booking side that has nothing
 * to do with being a tenant."
 */
export const PROSPECT_INTENTS: Intent[] = [
  {
    // THE REGRESSION S619 CAUSED AND CAUGHT LATE. A prospect has no account,
    // and sales_entry holds no data lookups at all — so demanding a lookup
    // suppressed a correct "$2 per occupied unit" as an unbacked figure. This
    // is GAM's commercial front door; it gets the most phrasings.
    audience: 'prospect', id: 'sales-pricing', needsTool: false, expect: '2',
    mustNotContain: ['your balance', 'your lease', 'your rent', 'your deposit', "I've escalated"],
    phrasings: [
      'how much is it?',
      "what's the pricing",
      'what does GAM cost',
      'how much per unit',
      'what am I looking at price wise',
      'is it expensive',
    ],
  },
  {
    audience: 'prospect', id: 'sales-vacant-units', needsTool: false,
    mustNotContain: ['your balance', 'your lease'],
    phrasings: [
      'do I pay for empty units?',
      'am I charged for vacancies',
      'what about units nobody is in',
    ],
  },
  {
    audience: 'prospect', id: 'sales-what-is-gam', needsTool: false,
    mustNotContain: ['your landlord', 'your lease', 'your rent'],
    phrasings: [
      'what is GAM?',
      'tell me about GAM',
      'what do you guys do',
      'what is this',
    ],
  },
  {
    // Lucy's actual job. She should steer to a call and has the tools to book
    // one — this proves the sales tools are reachable through the model.
    audience: 'prospect', id: 'sales-book-a-call', needsTool: true,
    expectToolAny: ['get_available_call_times', 'book_sales_call', 'capture_lead'],
    phrasings: [
      'can I talk to someone?',
      'I want to schedule a demo',
      'can we set up a call',
      'how do I get started',
    ],
  },
  {
    // CROSS-AUDIENCE. A prospect is a future LANDLORD — tenant products are
    // not theirs to hear about, and there is no account to look anything up in.
    audience: 'prospect', id: 'sales-cross-audience', needsTool: false,
    mustNotContain: ['FlexPay', 'FlexDeposit', 'FlexCredit', 'your balance', "I've escalated"],
    phrasings: [
      'when is my rent due?',
      "what's my balance",
      'how do I pay my rent',
    ],
  },
]

export const GUEST_INTENTS: Intent[] = [
  {
    audience: 'guest', id: 'guest-stay-dates', needsTool: true,
    expectTool: 'get_guest_booking', expectAny: ['July 10', '2026-07-10', 'Jul 10', '10th'],
    phrasings: [
      'when do I check out?',
      "what's my checkout date",
      'when does my stay end',
      'remind me of my dates',
    ],
  },
  {
    audience: 'guest', id: 'guest-nights', needsTool: true,
    expectTool: 'get_guest_booking', expect: '5',
    phrasings: [
      'how many nights am I staying?',
      'how long is my stay',
      'how many nights did I book',
    ],
  },
  {
    audience: 'guest', id: 'guest-total', needsTool: true,
    expectTool: 'get_guest_booking', expect: '364',
    phrasings: [
      'how much is my stay?',
      "what's my total",
      'what did I pay for this',
      'how much am I being charged',
    ],
  },
  {
    // The guest's one real ACTION — and the case my first expectation got
    // WRONG. I asserted request_booking_change on turn one; the profile says
    // "confirm the specifics with the guest first (what time, which night),
    // then send it", so asking "what time were you thinking?" is the agent
    // obeying its instructions, not failing. This harness is single-turn and
    // cannot reach the turn where the tool fires.
    //
    // So what is asserted is the property that actually matters on turn one:
    // it must not CLAIM the change is done or promise the host has it, because
    // a guest who believes a late checkout is booked stops asking — the same
    // failure as the complaint that was never filed (S619 §2c).
    audience: 'guest', id: 'guest-request-change', needsTool: false,
    mustNotContain: [
      "I've let the host know", "I've sent", "I've requested", "I've submitted",
      'has been notified', 'has been sent', "I'll let the host know",
      "I'll pass that along", "I'll send that",
    ],
    phrasings: [
      'can I get a late checkout?',
      'is it possible to check out later',
      'I want to stay an extra night',
      'can I check in early',
    ],
  },
  {
    audience: 'guest', id: 'guest-amenities', needsTool: true,
    expectToolAny: ['get_guest_amenities', 'request_guest_amenity_reservation'],
    phrasings: [
      "what's there to do here?",
      'is there a pool',
      'what amenities do you have',
      'can I book the clubhouse',
    ],
  },
  {
    // CROSS-AUDIENCE — the exact bleed Nic reported. A guest has no lease, no
    // landlord and no GAM account. Before S620 this agent's ONLY knowledge was
    // password resets and "your landlord sets your rent".
    audience: 'guest', id: 'guest-cross-audience', needsTool: false,
    mustNotContain: [
      'your lease', 'your landlord', 'your rent', 'late fee',
      'reset your password', 'two-factor', '$2 per occupied unit', 'platform fee',
      'FlexPay', 'FlexVault',
    ],
    phrasings: [
      'when does my lease end?',
      'how much is my rent',
      'how do I reset my password',
      'what does GAM charge per unit',
    ],
  },
]

export const VISITOR_INTENTS: Intent[] = [
  {
    // S618 fixed the exemption that let this be answered from memory. On a
    // booking site "how much" is THIS property's rate, set by THIS landlord —
    // a figure from the model's head is a quoted price that may not exist.
    audience: 'visitor', id: 'visitor-nightly-rate', needsTool: true,
    expectToolAny: ['get_property_pricing', 'check_availability'],
    expectAny: ['65', '48'],
    phrasings: [
      'how much per night?',
      "what's your nightly rate",
      'how much does it cost to stay',
      'what are your rates',
      'how much is a pull through',
    ],
  },
  {
    audience: 'visitor', id: 'visitor-property', needsTool: true,
    expectTool: 'get_property_info', expect: 'Sunset Palms',
    phrasings: [
      'where am I looking at?',
      'what is this place',
      'tell me about the property',
    ],
  },
  {
    audience: 'visitor', id: 'visitor-availability', needsTool: true,
    expectToolAny: ['check_availability', 'get_property_pricing'],
    phrasings: [
      'do you have anything open next weekend?',
      'are you available in September',
      'can I book for the 15th to the 20th',
      'is anything free',
    ],
  },
  {
    audience: 'visitor', id: 'visitor-monthly', needsTool: true,
    expectToolAny: ['get_property_pricing', 'check_availability'],
    expectAny: ['950', '850'],
    phrasings: [
      'do you do monthly?',
      'how much for a month',
      'what about long term rates',
    ],
  },
  {
    // CROSS-AUDIENCE. A site visitor is not a landlord shopping for software
    // and not a tenant. GAM's rate card must never surface on a booking site.
    audience: 'visitor', id: 'visitor-cross-audience', needsTool: false,
    mustNotContain: [
      '$2 per occupied unit', 'platform fee', 'your lease', 'your landlord',
      'reset your password', 'FlexPay', 'FlexVault', 'occupied unit per month',
    ],
    phrasings: [
      'what does GAM charge per unit?',
      'when is my rent due',
      'how do I reset my password',
    ],
  },
]

export const ALL_INTENTS = [
  ...TENANT_INTENTS, ...LANDLORD_INTENTS,
  ...PROSPECT_INTENTS, ...GUEST_INTENTS, ...VISITOR_INTENTS,
]
export const CASE_COUNT = ALL_INTENTS.reduce((n, i) => n + i.phrasings.length, 0)
