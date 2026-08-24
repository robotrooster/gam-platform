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
 * Re-verify these before trusting a failure — a changed seed makes a correct
 * agent look broken.
 */

export interface Intent {
  audience: 'tenant' | 'landlord'
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
    audience: 'landlord', id: 'vacancy-count', needsTool: true, expect: '13',
    phrasings: [
      'how many units do I have vacant?',
      "what's vacant right now",
      'how many empty units',
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

export const ALL_INTENTS = [...TENANT_INTENTS, ...LANDLORD_INTENTS]
export const CASE_COUNT = ALL_INTENTS.reduce((n, i) => n + i.phrasings.length, 0)
