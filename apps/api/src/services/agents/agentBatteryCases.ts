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
 *     3 properties · 21 units · 6 occupied · 15 vacant
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
  /** a fact that must appear, whichever way the question was asked */
  expect?: string
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
    audience: 'tenant', id: 'deposit', needsTool: true, expect: '750',
    phrasings: [
      'how much was my security deposit?',
      "what's my deposit",
      'how much did I put down',
      'when do I get my deposit back',
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
    // How late fees WORK is a policy question the knowledge base answers.
    audience: 'tenant', id: 'late-fees-policy', needsTool: false,
    mustNotContain: ["I've escalated"],
    phrasings: [
      'how do late fees work?',
      'what happens if I pay rent late',
      'what is the late fee for',
    ],
  },
  {
    // How many days THIS tenant gets is a term of THEIR lease — 5 days here —
    // so it is a lookup, not an article. Grouping the two together was my error
    // and made the whole intent score 0/4.
    audience: 'tenant', id: 'late-fees-mine', needsTool: true, expect: '5',
    phrasings: [
      'how many days do I have before a late fee',
      'is there a grace period on my rent',
      "what's my grace period",
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
    audience: 'landlord', id: 'vacancy', needsTool: true, expect: '15',
    phrasings: [
      'how many units do I have vacant?',
      "what's vacant right now",
      'how many empty units',
      'show me my vacancies',
      'which units are sitting empty',
    ],
  },
  {
    audience: 'landlord', id: 'occupancy', needsTool: true, expect: '6',
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
    audience: 'landlord', id: 'platform-fee', needsTool: false, expect: '$2',
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
]

export const ALL_INTENTS = [...TENANT_INTENTS, ...LANDLORD_INTENTS]
export const CASE_COUNT = ALL_INTENTS.reduce((n, i) => n + i.phrasings.length, 0)
