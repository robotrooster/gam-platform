/**
 * TWO-TURN conversations: what a person says back, and whether the agent
 * finishes the job.
 *
 * Nic, S620: "our test is only gonna be as good as the landlord or tenant's
 * responses to the first responses in the first place... make sure those
 * responses stay on topic for the most part. If there's a decent segue into a
 * different topic, test a few transitional flows."
 *
 * WHY TURN TWO IS ITS OWN SUITE. Several behaviours the agents were BUILT for
 * do not exist on turn one and cannot be measured there:
 *
 *   - confirm-then-act. The guest profile says "confirm the specifics with the
 *     guest first, THEN send it", so asking "what time?" is correct on turn one
 *     and the tool only fires on turn two. The single-turn battery can assert
 *     the agent does not LIE about having filed it; it cannot assert it ever
 *     actually files it.
 *   - one question, then an ANSWER. Nic: "people will get pissed if it's just
 *     question after question. The first clarifying question points you in the
 *     right direction. The second is like, here's an answer." Asking twice is
 *     the failure, and it is invisible on turn one.
 *   - carrying the conversation. "If it's on turn six or seven and it's already
 *     narrowed it down, it can make an inferred choice based on previous
 *     context." Turn two is the smallest test of that.
 *
 * HOW THE FOLLOW-UPS ARE WRITTEN — this is the whole design.
 *
 * The agent's first reply is generated, so its exact wording varies run to run.
 * A follow-up of "11am" is worthless: if the agent happened to ask "which day?"
 * the conversation is nonsense and the case measures the harness, not the
 * agent. So every follow-up here ANSWERS THE WHOLE OPEN QUESTION the way a
 * person actually types it — "tomorrow around 11 if that works" covers a
 * question about the day, the time, or both.
 *
 * They stay ON TOPIC, per Nic. Nobody flies off the handle and nobody changes
 * the subject at random — that measures nothing. What IS here:
 *
 *   answering a clarifying question · accepting an offer the agent made ·
 *   declining one · asking the obvious next question · correcting the agent ·
 *   pushing on a hard stop (money) · and three deliberate SEGUES into an
 *   adjacent topic, which is how real conversations move.
 *
 * ASSERTIONS ARE DELIBERATELY LOOSE ON PROSE AND TIGHT ON BEHAVIOUR. Turn two
 * has more freedom in how it answers than turn one, and roughly a third of
 * everything this battery has ever flagged turned out to be my expectation
 * being wrong rather than the agent. So: assert the TOOL that must fire, and
 * assert the things that must never appear. Assert wording only where there is
 * exactly one right answer.
 */

export interface Conversation {
  audience: 'tenant' | 'landlord' | 'prospect' | 'guest' | 'visitor'
  id: string
  /** what a person opens with */
  opener: string
  /** what a REAL person says back, written to fit any reasonable first reply */
  followUp: string
  /** plain-language note on the human behaviour being tested */
  behaviour: string
  /** the tool that must run ON TURN TWO */
  expectTool?: string
  /** any one of these on turn two is acceptable */
  expectToolAny?: string[]
  /** turn two must NOT run any tool (e.g. a decline) */
  expectNoTool?: boolean
  /** a fact that must appear in the second reply */
  expect?: string
  expectAny?: string[]
  /** never acceptable in the second reply */
  mustNotContain?: string[]
  /** the second reply must not be another question — Nic's "one question, then
   *  an answer" rule. Checked as: does it END on a question with no figure? */
  mustNotAskAgain?: boolean
}

export const TENANT_CONVERSATIONS: Conversation[] = [
  {
    audience: 'tenant', id: 'balance-then-pay-half',
    behaviour: 'told what they owe, asks to split it — the single most natural reaction to a big number',
    opener: 'how much do I owe?',
    followUp: 'can I just pay half now and the rest next week?',
    // STANDING DIRECTIVE, platform-wide: rent is pay-in-full only. No
    // per-property toggle. It protects the eviction clock. An agent that says
    // "sure, partial is fine" has made a promise the payment rail refuses.
    mustNotContain: [
      'you can pay half', 'partial payment is', 'yes, you can split',
      "that's fine", 'I can set that up', "I've arranged",
    ],
  },
  {
    audience: 'tenant', id: 'late-fee-then-waive',
    behaviour: 'hears the late fee, immediately asks for it to be waived — pushing on a money hard stop',
    opener: 'what is my late fee?',
    followUp: 'any chance you can take that off? it was only two days late',
    // Money moves to a person. The agent may NOT promise the outcome.
    expectToolAny: ['escalate', 'escalate_to_human'],
    mustNotContain: [
      "I've removed", "I've waived", "I'll waive", 'has been waived',
      'I can remove that', 'consider it done',
    ],
  },
  {
    audience: 'tenant', id: 'lease-end-then-renewal',
    behaviour: 'SEGUE — gets the lease end date, naturally asks what happens next',
    opener: 'when does my lease end?',
    followUp: 'and what happens if I want to stay on after that?',
    expectToolAny: ['get_my_lease', 'get_my_full_lease', 'get_my_landlord_renewal_tendency'],
    mustNotContain: ["I've renewed", 'I have renewed', "I've extended"],
  },
  {
    audience: 'tenant', id: 'maintenance-then-accept',
    behaviour: 'CONFIRMS something already done — the agent filed it on turn one, so turn two must not file it again',
    opener: 'my kitchen sink has been leaking since yesterday',
    // S624 (Nic): the old follow-up was "yes please, go ahead and put that in
    // for me", written as though the agent had OFFERED. It had already FILED —
    // so the case was unrealistic and the repeat it provoked was partly the
    // test's fault. What IS real is the tenant confirming, and the agent filing
    // a SECOND request off the back of it. That duplicate is the defect worth
    // holding: a real row on the landlord's board and a maintenance history
    // that disagrees with itself.
    followUp: 'ok great, thanks — so that is definitely logged?',
    // The offer must become a real row on turn ONE. "I'll file that" with
    // nothing behind it is the failure that put an empty complaints table in
    // front of a tenant who thought they had filed one.
    expectTool: 'file_maintenance_request',
    mustNotContain: [
      "I'll file", "I'll get that", "I'll put that in", "I'll submit",
      // Filing it twice, or announcing a second filing.
      "I've filed another", "filed a second", "submitted another",
    ],
  },
  {
    audience: 'tenant', id: 'deposit-then-correction',
    behaviour: 'CORRECTS the agent — thinks the number is wrong and asks it to check the document',
    opener: 'how much is my pet deposit?',
    followUp: "that doesn't sound right to me — can you check what my actual lease says?",
    // Appealing to the DOCUMENT should reach the full lease, not a re-read of
    // the same narrow field.
    expectToolAny: ['get_my_full_lease', 'get_my_lease_fees', 'get_my_lease'],
    mustNotContain: ["I've corrected", "I've updated", "I've changed"],
  },
  {
    audience: 'tenant', id: 'balance-then-decline',
    behaviour: 'DECLINES the offer — the agent must let it go, not keep selling',
    opener: 'what do I owe right now?',
    followUp: "no thanks, I'll sort it out myself later",
    expectNoTool: true,
    mustNotContain: ['are you sure', 'I really recommend', 'you should pay', 'I must insist'],
  },
]

export const LANDLORD_CONVERSATIONS: Conversation[] = [
  {
    audience: 'landlord', id: 'narrow-then-answer',
    behaviour: "THE case for Nic's rule — agent asks which Chen, landlord says which, and must now ANSWER",
    opener: "what's chen's balance?",
    followUp: 'the one in apt 101',
    // Nic: "The first clarifying question points you in the right direction.
    // The second is like, here's an answer." Asking again is the failure.
    expectToolAny: ['lookup_tenant_payment_status', 'get_delinquent_tenants'],
    expect: '2,330',
    mustNotAskAgain: true,
  },
  {
    audience: 'landlord', id: 'vacancy-then-drill-down',
    behaviour: 'gets the portfolio number, drills into one property — the normal way a landlord narrows',
    opener: 'how many units do I have vacant?',
    followUp: 'which of those are at sunset palms?',
    expectToolAny: ['get_vacant_units', 'get_property_rent_roll', 'query_portfolio', 'get_landlord_portfolio'],
    mustNotContain: ['Oak Street', 'Copper Canyon'],
  },
  {
    audience: 'landlord', id: 'delinquent-then-notice',
    behaviour: 'sees who is behind and asks for the obvious action on one of them',
    opener: 'who is behind on rent?',
    followUp: 'can you put together a notice for frank?',
    expectToolAny: ['draft_tenant_notice', 'escalate', 'escalate_to_human'],
    // A notice is a legal instrument. Claiming it was SENT when it was only
    // drafted is the dangerous version of this.
    mustNotContain: ["I've sent", "I've served", 'has been sent to Frank', "I've mailed"],
  },
  {
    audience: 'landlord', id: 'pl-then-expenses',
    behaviour: 'SEGUE — gets a P&L that says no expenses are recorded, asks how to fix that',
    opener: 'show me my profit and loss for this year',
    followUp: 'how do I get my expenses in there?',
    // The P&L refuses to call income "profit" with no expenses entered. The
    // follow-up must not invent a walkthrough of a screen — the guardrail
    // against confidently wrong UI tours.
    mustNotContain: ["I've added", "I've imported", "I've entered"],
  },
  {
    audience: 'landlord', id: 'expirations-then-one-unit',
    behaviour: 'SEGUE — from what is expiring to the specifics of one of them',
    opener: 'what leases are expiring soon?',
    followUp: 'tell me more about the apt 204 one',
    expectToolAny: ['get_unit_lease', 'get_lease_expirations', 'lookup_tenant_payment_status'],
    mustNotAskAgain: true,
  },
]

export const GUEST_CONVERSATIONS: Conversation[] = [
  {
    audience: 'guest', id: 'late-checkout-commit',
    behaviour: 'THE confirm-then-act case — gives the specifics, so the request must actually be sent',
    opener: 'can I get a late checkout?',
    // Answers day AND time at once, so it fits whichever the agent asked.
    followUp: 'on my checkout day, around 11 if that works',
    expectTool: 'request_booking_change',
    // A guest who believes it is arranged stops asking. Nothing may claim it
    // is done unless the tool actually ran.
    mustNotContain: ["I'll let the host know", "I'll pass that along", "I'll send that"],
  },
  {
    audience: 'guest', id: 'amenity-then-book',
    behaviour: 'hears an amenity exists and asks to reserve it — accepting with specifics',
    opener: 'is there a pool here?',
    followUp: 'can you book it for me tomorrow afternoon?',
    expectToolAny: ['request_guest_amenity_reservation', 'get_guest_amenities'],
    mustNotContain: ["I've booked", "I've reserved", 'is reserved for you'],
  },
  {
    audience: 'guest', id: 'stay-then-extend',
    behaviour: 'SEGUE — checks their dates, then decides they want longer',
    opener: 'when do I check out?',
    followUp: 'actually could I keep it one more night after that?',
    expectTool: 'request_booking_change',
    mustNotContain: ["I've extended", 'your stay is extended', "I've added"],
  },
]

export const VISITOR_CONVERSATIONS: Conversation[] = [
  {
    audience: 'visitor', id: 'rates-then-dates',
    behaviour: 'gets the rate card and supplies real dates — the quote must become a real total',
    opener: 'how much per night?',
    followUp: "we'd be coming in on the 15th and leaving the 20th",
    expectTool: 'check_availability',
    mustNotContain: ["I've booked", "I've reserved", "I've held"],
  },
  {
    audience: 'visitor', id: 'quote-then-book',
    behaviour: 'gives the month when asked, then says yes — the agent must not have told them their dates were in the past',
    opener: 'do you have a pull through site available the 15th to the 20th?',
    // S624 (Nic): the old follow-up was "yeah let's go ahead and book that",
    // said to an agent that had given them NO information — nobody does that,
    // and that bad follow-up is what provoked the verbatim repeat. Rewritten to
    // the real exchange: a bare day number is ambiguous, the agent should ASK
    // WHICH MONTH rather than declare the dates past, and the customer answers.
    followUp: 'september — the 15th through the 20th',
    // Confirm-first is REQUIRED: read back type, dates, total and deposit and
    // get an explicit yes before create_booking_checkout. Asking for the name
    // and email is also correct. Booking without either is the failure.
    mustNotContain: [
      'card number', 'credit card', 'enter your card', "I've charged",
      // Never tell a customer trying to give you money that their dates have
      // already happened — ask which month instead.
      'in the past', 'already passed', 'past date',
    ],
  },
  {
    audience: 'visitor', id: 'rates-then-monthly',
    behaviour: 'SEGUE — nightly rates prompt the longer-stay question',
    opener: 'what are your nightly rates?',
    followUp: 'what would it be if we stayed a whole month?',
    expectToolAny: ['get_property_pricing', 'check_availability'],
    expectAny: ['950', '850'],
  },
]

export const PROSPECT_CONVERSATIONS: Conversation[] = [
  {
    audience: 'prospect', id: 'pricing-then-scale',
    behaviour: 'hears the price and volunteers their portfolio — the qualifying moment',
    opener: 'how much does GAM cost?',
    followUp: "I've got about 40 RV sites in arizona",
    // MY EXPECTATION WAS WRONG. I asserted a tool and the agent was right not
    // to call one: Lucy's prompt says call capture_lead "once you've got
    // contact info and they're interested", and she has no name or email yet.
    // What she produced — "RV parks are right in our wheelhouse... want me to
    // grab you a time?" — is near-verbatim her own example dialogue.
    //
    // So what is asserted is the behaviour that actually matters here: she
    // engages the scale she was told and steers to a call, without inventing
    // a quote for 40 sites or pretending to have booked anything.
    expectAny: ['call', 'strategist', 'time', 'RV'],
    mustNotContain: [
      'your balance', 'your lease', 'your rent',
      "I've booked", "I've scheduled", "you're all set", "I've captured",
    ],
  },
  {
    audience: 'prospect', id: 'call-then-pick-time',
    behaviour: 'THE booking case — asks for a call, then picks when',
    opener: 'can I talk to someone?',
    followUp: 'tuesday afternoon would work for me',
    // MY EXPECTATION CONTRADICTED MY OWN COMMENT. I wrote "asking for them is
    // right" and then asserted a tool anyway. book_sales_call REQUIRES a name
    // and email and the prospect has given neither, so "I'll need your name
    // and email to book the call" is the correct turn-two move — the booking
    // itself lands on turn three, which this two-turn harness cannot reach.
    //
    // Asserted instead: it moves toward booking and does not claim a call
    // exists. A third turn is what would prove book_sales_call fires.
    expectAny: ['name', 'email'],
    mustNotContain: ["you're all set", "I've booked", 'is confirmed', "I've scheduled", 'is on the calendar'],
  },
]

export const ALL_CONVERSATIONS: Conversation[] = [
  ...TENANT_CONVERSATIONS, ...LANDLORD_CONVERSATIONS,
  ...GUEST_CONVERSATIONS, ...VISITOR_CONVERSATIONS, ...PROSPECT_CONVERSATIONS,
]
