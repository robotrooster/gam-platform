/**
 * S655 money plan, Step 13 — the credit question's arithmetic over the
 * server's per-lease quote (GET /payments/balance-context).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CREDIT_WAITING_TAIL, creditOffer, creditOnFileOf, creditRestSentence, creditSentence, creditWaitingSentence, needsRunCreditWaiting, owedOf, payAllView, planCharges, requiredOf, runOrder, type LeaseBill } from './payCredit'

const bill = (over: Partial<LeaseBill> = {}): LeaseBill => ({
  leaseId: 'L1', outstanding: 500, requiredNow: 500, carriedBalance: 0,
  usableCredit: 0, payIfUsed: 500, payIfSaved: 500, coversWholeBill: false, ...over,
})

describe('the full balance', () => {
  it('is the bill plus the old balance, before any credit', () => {
    expect(owedOf(bill({ requiredNow: 450, carriedBalance: 100, outstanding: 550, usableCredit: 50 }))).toBe(550)
  })

  it('is what is still owed when credit already paid part of a row (outstanding counts that part)', () => {
    // outstanding is the rows' gross; requiredNow is what the money still owes.
    expect(owedOf(bill({ outstanding: 500, requiredNow: 480, carriedBalance: 0 }))).toBe(480)
  })

  it('falls back to outstanding when the server sent no split', () => {
    expect(owedOf({ leaseId: 'L1', outstanding: 612.5 })).toBe(612.5)
    expect(requiredOf({ leaseId: 'L1', outstanding: 612.5, carriedBalance: 100 })).toBe(512.5)
  })
})

describe('the credit question', () => {
  it('no usable credit: no question', () => {
    const o = creditOffer([bill()])
    expect(o.usable).toBe(0)
    expect(o.coversWholeBill).toBe(false)
  })

  it('credit that pays part of the bill: Use all pays the rest, Save pays the bill', () => {
    const o = creditOffer([bill({ usableCredit: 50, payIfUsed: 450 })])
    expect(o).toMatchObject({ usable: 50, payIfUsed: 450, payIfSaved: 500, balance: 500, coversWholeBill: false })
  })

  it('credit that covers the whole bill: Pay with credit — nothing charged', () => {
    const o = creditOffer([bill({ usableCredit: 500, payIfUsed: 0, coversWholeBill: true })])
    expect(o).toMatchObject({ usable: 500, payIfUsed: 0, coversWholeBill: true })
  })

  it('the old balance is in neither figure (credit never pays it); the balance shown includes it', () => {
    const o = creditOffer([bill({ outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 500, payIfUsed: 0 })])
    expect(o).toMatchObject({ payIfUsed: 0, payIfSaved: 500, balance: 600, carried: 100, coversWholeBill: true })
  })

  it('Use all and Save it for later are on one basis: they differ by exactly the credit', () => {
    // $100 credit and $150 of old balances: "Use all $100 — pay $700" beside
    // "Save it for later — pay $800" (never $950, which made saving look $250 dearer).
    const o = creditOffer([
      bill({ leaseId: 'A', outstanding: 600, requiredNow: 500, carriedBalance: 100, usableCredit: 100, payIfUsed: 400, payIfSaved: 500 }),
      bill({ leaseId: 'B', outstanding: 350, requiredNow: 300, carriedBalance: 50, payIfUsed: 300, payIfSaved: 300 }),
    ])
    expect(o).toMatchObject({ usable: 100, payIfUsed: 700, payIfSaved: 800, balance: 950, carried: 150 })
    expect(o.payIfSaved - o.payIfUsed).toBe(o.usable)
  })

  it('Pay all adds each lease\'s own share; a lease with no credit pays its bill either way', () => {
    const o = creditOffer([
      bill({ leaseId: 'A', usableCredit: 50, payIfUsed: 450 }),
      bill({ leaseId: 'B', outstanding: 300, requiredNow: 300, payIfUsed: 300, payIfSaved: 300 }),
    ])
    expect(o).toMatchObject({ usable: 50, payIfUsed: 750, payIfSaved: 800, balance: 800, coversWholeBill: false })
  })

  it('says how much of a bigger credit can pay this bill', () => {
    expect(creditSentence(50)).toBe('You have $50.00 credit.')
    expect(creditSentence(200, 500)).toBe('You have $500.00 credit. $200.00 of it can pay this bill.')
    expect(creditSentence(200, 200)).toBe('You have $200.00 credit.')
  })

  it('says credit another bank payment still holds is waiting, in the server\'s words, and nothing when none is', () => {
    expect(creditWaitingSentence([bill({ creditWaiting: 50 })]))
      .toBe('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')
    expect(creditWaitingSentence([bill()])).toBeNull()
  })

  it('shows the server\'s own waiting sentence for one bill', () => {
    expect(creditWaitingSentence([bill({ creditWaiting: 50, creditWaitingNote: 'From the server.' })])).toBe('From the server.')
  })

  // Fix pass 2: bills that are not the server's run each report the held
  // dollars they could use — often the SAME dollars (one hold every bill could
  // use). Per landlord the largest single figure is said, never the sum; a
  // different landlord's credit is its own, so landlords add up.
  it('bills that are not the server\'s run: the largest figure per landlord, never the same held dollars twice', () => {
    expect(creditWaitingSentence([
      bill({ creditWaiting: 20, creditWaitingNote: 'a' }), bill({ leaseId: 'L2', creditWaiting: 30, creditWaitingNote: 'b' }),
    ])).toBe(`$30.00${CREDIT_WAITING_TAIL}`)
    expect(creditWaitingSentence([
      bill({ landlordId: 'LL1', creditWaiting: 50, creditWaitingNote: 'a' }),
      bill({ leaseId: 'L2', landlordId: 'LL1', creditWaiting: 50, creditWaitingNote: 'b' }),
    ])).toBe(`$50.00${CREDIT_WAITING_TAIL}`)
    expect(creditWaitingSentence([
      bill({ landlordId: 'LL1', creditWaiting: 20 }), bill({ leaseId: 'L2', landlordId: 'LL2', creditWaiting: 30 }),
    ])).toBe(`$50.00${CREDIT_WAITING_TAIL}`)
  })

  it('the waiting wording is the same as the server\'s (services/rentCharge creditWaitingSentence)', () => {
    const server = readFileSync(resolve(__dirname, '../../../api/src/services/rentCharge.ts'), 'utf8')
    expect(server).toContain(`\${money(cents)}${CREDIT_WAITING_TAIL}\``)
  })

  // Fix pass 3: the server's figures read like the page's, above $999.99 too.
  it('the waiting figure reads $1,234.00 on both sides: the server writes money as formatCurrency does', () => {
    expect(creditWaitingSentence([bill({ creditWaiting: 1234 })])).toBe(`$1,234.00${CREDIT_WAITING_TAIL}`)
    expect(creditWaitingSentence([
      bill({ creditWaiting: 1234, creditWaitingNote: 'a' }), bill({ leaseId: 'L2', creditWaiting: 1000, creditWaitingNote: 'b' }),
    ])).toBe(`$1,234.00${CREDIT_WAITING_TAIL}`)
    const server = readFileSync(resolve(__dirname, '../../../api/src/services/rentCharge.ts'), 'utf8')
    expect(server).toContain('const money = (c: number): string => formatCurrency(toDollars(c))')
  })

  // Fix pass 3: one bill — the rest of the credit on file, in the server's words.
  // autopaycredit2 review problem 3 (renamed from "…and nothing for several
  // bills"): Pay all the server sequenced says the run's one rest sentence and
  // credit on file; bills that are not its run still say nothing.
  it('says where the rest of the credit goes on one bill and on the server\'s Pay all run, nothing for other bills', () => {
    const one = bill({ creditOnFile: 100, usableCredit: 30, creditRestNote: '$20.00 of your credit is kept for a bill on another lease.' })
    expect(creditRestSentence([one])).toBe('$20.00 of your credit is kept for a bill on another lease.')
    expect(creditOnFileOf([one])).toBe(100)
    expect(creditRestSentence([bill()])).toBeNull()
    expect(creditRestSentence([one, bill({ leaseId: 'L2', creditRestNote: 'x' })])).toBeNull()
    expect(creditOnFileOf([one, bill({ leaseId: 'L2' })])).toBeNull()
    const run = { order: ['A', 'B'], runCreditOnFile: 1270, runCreditRestNote: '$600.00 of your credit stays on your account for a later bill.' }
    const a = bill({ leaseId: 'A', creditRestNote: 'a', payAll: { ...run, usableCredit: 400, payIfUsed: 100, coversWholeBill: false } })
    const b = bill({ leaseId: 'B', creditRestNote: 'b', payAll: { ...run, usableCredit: 270, payIfUsed: 230, coversWholeBill: false } })
    expect(creditRestSentence([a, b])).toBe('$600.00 of your credit stays on your account for a later bill.')
    expect(creditOnFileOf([a, b])).toBe(1270)
    expect(creditSentence(creditOffer([a, b]).usable, creditOnFileOf([a, b]), true))
      .toBe('You have $1,270.00 credit. $670.00 of it can pay these bills.')
    // An older server (no run figures): the sentence names only what the bills use.
    const old = { order: ['A', 'B'] }
    expect(creditOnFileOf([{ ...a, payAll: { ...old, usableCredit: 1, payIfUsed: 1, coversWholeBill: false } },
      { ...b, payAll: { ...old, usableCredit: 1, payIfUsed: 1, coversWholeBill: false } }])).toBeNull()
  })

  // Fix pass 3: bills that are not the server's run used to say the largest
  // single figure, which says too little when two holds each wait on a
  // different bill ($50 + $50 shown as $50). The page asks the server for
  // these exact bills' run (POST /payments/quote runLeaseIds).
  it('bills that are not the server\'s run say the run figure the server worked out for exactly these bills', () => {
    const a = bill({ leaseId: 'A', creditWaiting: 50, creditWaitingNote: 'a' })
    const b = bill({ leaseId: 'B', creditWaiting: 50, creditWaitingNote: 'b', scheduledRetries: [{ nextRetryAt: null }] })
    expect(needsRunCreditWaiting([a, b])).toBe(true)
    expect(needsRunCreditWaiting([a])).toBe(false)
    expect(needsRunCreditWaiting([bill({ leaseId: 'A' }), bill({ leaseId: 'B' })])).toBe(false)
    // The charge order: the retrying lease first.
    expect(runOrder([a, b])).toEqual(['B', 'A'])
    expect(creditWaitingSentence([a, b], { runLeaseIds: ['B', 'A'], runCreditWaiting: 100, runCreditWaitingNote: null }))
      .toBe(`$100.00${CREDIT_WAITING_TAIL}`)
    expect(creditWaitingSentence([a, b], { runLeaseIds: ['B', 'A'], runCreditWaiting: 100, runCreditWaitingNote: 'run' })).toBe('run')
    expect(creditWaitingSentence([a, b], { runLeaseIds: ['B', 'A'], runCreditWaiting: 0 })).toBeNull()
    // An answer for another set of bills (the bill changed since) is not used: the fallback says the largest.
    expect(creditWaitingSentence([a, b], { runLeaseIds: ['A', 'B'], runCreditWaiting: 100 })).toBe(`$50.00${CREDIT_WAITING_TAIL}`)
    expect(creditWaitingSentence([a, b], null)).toBe(`$50.00${CREDIT_WAITING_TAIL}`)
  })
})

describe('what each lease is charged for the answer', () => {
  it('Use all: exactly the bill less the credit, with the credit figure shown', () => {
    expect(planCharges([bill({ usableCredit: 50, payIfUsed: 450 })], 'use')).toEqual([
      { leaseId: 'L1', amount: 450, useCredit: true, expectedCredit: 50, creditOnly: false, reachesCarried: false },
    ])
  })

  it('Use all on a bill the credit covers: nothing charged on it', () => {
    expect(planCharges([bill({ usableCredit: 500, payIfUsed: 0 })], 'use')).toEqual([
      { leaseId: 'L1', amount: 0, useCredit: true, expectedCredit: 500, creditOnly: true, reachesCarried: false },
    ])
  })

  it('Save it for later: the bill, still carrying the figure it answered', () => {
    expect(planCharges([bill({ usableCredit: 50, payIfUsed: 450 })], 'save')).toEqual([
      { leaseId: 'L1', amount: 500, useCredit: false, expectedCredit: 50, creditOnly: false, reachesCarried: false },
    ])
  })

  it('Save it for later charges the figure its button named — the bill, the old balance left out', () => {
    expect(planCharges([bill({ outstanding: 650, requiredNow: 500, carriedBalance: 150, usableCredit: 50, payIfUsed: 450 })], 'save'))
      .toEqual([{ leaseId: 'L1', amount: 500, useCredit: false, expectedCredit: 50, creditOnly: false, reachesCarried: false }])
  })

  it('no credit offered: everything owed, the old balance included', () => {
    expect(planCharges([bill({ outstanding: 650, requiredNow: 500, carriedBalance: 150 })], null))
      .toEqual([{ leaseId: 'L1', amount: 650, creditOnly: false, reachesCarried: true }])
  })

  it('no credit was offered: no answer is sent (credit that appears since is asked about, not spent)', () => {
    const [line] = planCharges([bill()], null)
    expect(line.amount).toBe(500)
    expect(line).not.toHaveProperty('useCredit')
    expect(line).not.toHaveProperty('expectedCredit')
  })

  it('paying ahead (credit saved): the amount box decides the money', () => {
    expect(planCharges([bill({ usableCredit: 50, payIfUsed: 450 })], 'save', () => 1500)[0].amount).toBe(1500)
  })

  it('Pay all with Use all: each lease carries its own share; a lease the credit covers is sent at $0', () => {
    const lines = planCharges([
      bill({ leaseId: 'A', usableCredit: 50, payIfUsed: 450 }),
      bill({ leaseId: 'B', outstanding: 300, requiredNow: 300, usableCredit: 300, payIfUsed: 0, payIfSaved: 300 }),
      bill({ leaseId: 'C', outstanding: 200, requiredNow: 200, payIfUsed: 200, payIfSaved: 200 }),
    ], 'use')
    expect(lines.map((x) => [x.leaseId, x.amount, x.useCredit, x.expectedCredit, x.creditOnly])).toEqual([
      ['A', 450, true, 50, false],
      ['B', 0, true, 300, true],
      ['C', 200, false, 0, false],
    ])
  })

  it('Pay all with Use all pays the lease with a bank retry first, so the credit the retry set aside is free for the older bill', () => {
    // B's scheduled retry holds credit A (the older bill) could use. B's
    // charge replaces the retry and gives that credit back before A is sent.
    const lines = planCharges([
      bill({ leaseId: 'A', usableCredit: 80, payIfUsed: 420 }),
      bill({ leaseId: 'B', outstanding: 300, requiredNow: 300, usableCredit: 20, payIfUsed: 280, payIfSaved: 300,
        scheduledRetries: [{ nextRetryAt: '2026-10-08T12:00:00Z' }] }),
      bill({ leaseId: 'C', outstanding: 200, requiredNow: 200, payIfUsed: 200, payIfSaved: 200 }),
    ], 'use')
    expect(lines.map((x) => [x.leaseId, x.amount, x.useCredit, x.expectedCredit])).toEqual([
      ['B', 280, true, 20],
      ['A', 420, true, 80],
      ['C', 200, false, 0],
    ])
  })

  it('Pay all with Use all pays a retrying lease first even when it has no credit of its own', () => {
    const lines = planCharges([
      bill({ leaseId: 'A', usableCredit: 100, payIfUsed: 400 }),
      bill({ leaseId: 'B', outstanding: 300, requiredNow: 300, payIfUsed: 300, payIfSaved: 300,
        scheduledRetries: [{ nextRetryAt: null }] }),
    ], 'use')
    expect(lines.map((x) => [x.leaseId, x.useCredit])).toEqual([['B', false], ['A', true]])
  })

  it('Pay all with Use all skips a lease that owes only an old balance (credit cannot pay it, and it is not this payment)', () => {
    const lines = planCharges([
      bill({ leaseId: 'A', usableCredit: 50, payIfUsed: 450 }),
      bill({ leaseId: 'OLD', outstanding: 100, requiredNow: 0, carriedBalance: 100, payIfUsed: 0, payIfSaved: 0 }),
    ], 'use')
    expect(lines.map((x) => x.leaseId)).toEqual(['A'])
  })

  it('a charge that reaches an old balance goes last, after the landlord\'s other leases are claimed (S622)', () => {
    const lines = planCharges([
      bill({ leaseId: 'WITH_OLD', outstanding: 300, requiredNow: 200, carriedBalance: 100 }),
      bill({ leaseId: 'PLAIN', outstanding: 500, requiredNow: 500 }),
    ], null)
    expect(lines.map((x) => [x.leaseId, x.amount, x.reachesCarried])).toEqual([
      ['PLAIN', 500, false],
      ['WITH_OLD', 300, true],
    ])
  })
})

/**
 * The server's S622 refusal (services/rentCharge): money toward an old balance
 * is refused while ANOTHER of the same landlord's leases still owes a current
 * bill; a lease's current bill stops owing once its own charge claims it.
 * Played charge by charge, in the order planCharges sends them.
 */
function runAgainstS622(bills: LeaseBill[], lines: ReturnType<typeof planCharges>): { paid: string[]; refused: string | null } {
  const currentOpen = new Map(bills.map((b) => [b.leaseId, requiredOf(b) > 0]))
  const landlord = new Map(bills.map((b) => [b.leaseId, b.landlordId ?? '']))
  const paid: string[] = []
  for (const x of lines) {
    const b = bills.find((l) => l.leaseId === x.leaseId)!
    if (x.amount > requiredOf(b) + 0.005) {
      const blocker = bills.find((o) => o.leaseId !== x.leaseId && landlord.get(o.leaseId) === landlord.get(x.leaseId)
        && currentOpen.get(o.leaseId))
      if (blocker) return { paid, refused: `Bring your other rent current first — ${blocker.leaseId} still owes` }
    }
    currentOpen.set(x.leaseId, false)
    paid.push(x.leaseId)
  }
  return { paid, refused: null }
}

describe('Pay all never reaches a dead end on two leases with old balances (S622)', () => {
  // Same landlord; each lease owes a current bill AND an old balance.
  const two = () => [
    bill({ leaseId: 'A', landlordId: 'LL1', unitNumber: 'MH 01', outstanding: 600, requiredNow: 500, carriedBalance: 100 }),
    bill({ leaseId: 'B', landlordId: 'LL1', unitNumber: 'MH 02', outstanding: 350, requiredNow: 300, carriedBalance: 50 }),
  ]

  it('no credit: every current bill is claimed first; one old balance rides the last charge, the other waits for after', () => {
    const lines = planCharges(two(), null)
    expect(lines.map((x) => [x.leaseId, x.amount, x.reachesCarried, x.carriedLeft ?? 0])).toEqual([
      ['A', 500, false, 100],
      ['B', 350, true, 0],
    ])
    expect(runAgainstS622(two(), lines)).toEqual({ paid: ['A', 'B'], refused: null })
  })

  it('the old plan (each charge carrying its own old balance) is the one the server refuses', () => {
    const naive = two().map((b) => ({ leaseId: b.leaseId, amount: owedOf(b), creditOnly: false, reachesCarried: true }))
    expect(runAgainstS622(two(), naive).refused).toMatch(/Bring your other rent current first/)
  })

  it('Save it for later: the bills only, and the run goes through', () => {
    const bills = two().map((b) => ({ ...b, usableCredit: b.leaseId === 'A' ? 100 : 0 }))
    const lines = planCharges(bills, 'save')
    expect(lines.map((x) => [x.leaseId, x.amount, x.reachesCarried])).toEqual([['A', 500, false], ['B', 300, false]])
    expect(runAgainstS622(bills, lines)).toEqual({ paid: ['A', 'B'], refused: null })
  })

  it('a lease owing only an old balance goes after every current-bill charge of its landlord', () => {
    const bills = [
      bill({ leaseId: 'OLD', landlordId: 'LL1', outstanding: 80, requiredNow: 0, carriedBalance: 80 }),
      ...two(),
    ]
    const lines = planCharges(bills, null)
    expect(lines.map((x) => x.leaseId)).toEqual(['A', 'B', 'OLD'])
    expect(runAgainstS622(bills, lines)).toEqual({ paid: ['A', 'B', 'OLD'], refused: null })
  })

  it('leases with different landlords each keep their own old balance (S622 is per landlord)', () => {
    const bills = [
      bill({ leaseId: 'A', landlordId: 'LL1', outstanding: 600, requiredNow: 500, carriedBalance: 100 }),
      bill({ leaseId: 'C', landlordId: 'LL2', outstanding: 450, requiredNow: 400, carriedBalance: 50 }),
    ]
    const lines = planCharges(bills, null)
    expect(lines.map((x) => [x.leaseId, x.amount, x.carriedLeft ?? 0])).toEqual([['A', 600, 0], ['C', 450, 0]])
    expect(runAgainstS622(bills, lines).refused).toBeNull()
  })

  it('three same-landlord leases: two wait, the last carries its old balance, and the run goes through', () => {
    const bills = [
      ...two(),
      bill({ leaseId: 'C', landlordId: 'LL1', outstanding: 220, requiredNow: 200, carriedBalance: 20 }),
    ]
    const lines = planCharges(bills, null)
    expect(lines.map((x) => [x.leaseId, x.amount, x.carriedLeft ?? 0])).toEqual([
      ['A', 500, 100], ['B', 300, 50], ['C', 220, 0],
    ])
    expect(runAgainstS622(bills, lines).refused).toBeNull()
  })
})

// 10/4: "Pay all" with "Use all" is one run. The server plays it through
// (balance-context payAll): each bill's figure is the one its charge will find
// once the bills before it are charged.
describe('Pay all is sent the figures its charges will find', () => {
  const run = { order: ['OLD', 'NEW'] }
  const old = bill({ leaseId: 'OLD', outstanding: 460, requiredNow: 460, usableCredit: 0, payIfUsed: 460,
    scheduledRetries: [{ nextRetryAt: '2026-10-08T12:00:00Z' }],
    payAll: { ...run, usableCredit: 0, payIfUsed: 460, coversWholeBill: false } })
  const renewal = bill({ leaseId: 'NEW', outstanding: 480, requiredNow: 480, usableCredit: 30, payIfUsed: 450,
    creditWaiting: 50, creditWaitingNote: 'held',
    payAll: { ...run, usableCredit: 80, payIfUsed: 400, coversWholeBill: false, creditWaiting: 0, creditWaitingNote: null } })

  it('Use all: the server\'s order and figures, and each line names the leases charged before it', () => {
    expect(planCharges([renewal, old], 'use')).toEqual([
      { leaseId: 'OLD', amount: 460, useCredit: false, expectedCredit: 0, creditOnly: false, reachesCarried: false },
      { leaseId: 'NEW', amount: 400, useCredit: true, expectedCredit: 80, creditOnly: false, reachesCarried: false, afterLeaseIds: ['OLD'] },
    ])
  })

  it('the offer adds up the run\'s figures, never each bill\'s own (which may count the same dollars twice)', () => {
    expect(creditOffer([renewal, old])).toMatchObject({ usable: 80, payIfUsed: 860, payIfSaved: 940 })
  })

  it('credit the run\'s own earlier charge frees is not said to be waiting; one bill alone still says it', () => {
    expect(creditWaitingSentence([renewal, old])).toBeNull()
    expect(creditWaitingSentence([renewal])).toBe('held')
  })

  // Fix pass 2: a paused lease's bank retry holds the whole $50 credit; the
  // run is the two other bills. Each bill (and each bill's own run figure)
  // could use the same $50 — the screen must say $50 once, from the run's one
  // figure (balance-context payAll.runCreditWaiting), not $100.
  it('Pay all says the run\'s one waiting figure, not the bills\' figures added up', () => {
    const r = { order: ['A', 'B'], runCreditWaiting: 50, runCreditWaitingNote: 'run note' }
    const a = bill({ leaseId: 'A', creditOnFile: 50, creditWaiting: 50, creditWaitingNote: 'a',
      payAll: { ...r, usableCredit: 0, payIfUsed: 500, coversWholeBill: false, creditWaiting: 50, creditWaitingNote: 'a' } })
    const b = bill({ leaseId: 'B', creditOnFile: 50, creditWaiting: 50, creditWaitingNote: 'b',
      payAll: { ...r, usableCredit: 0, payIfUsed: 500, coversWholeBill: false, creditWaiting: 50, creditWaitingNote: 'b' } })
    expect(creditWaitingSentence([a, b])).toBe('run note')
    const noNote = { ...r, runCreditWaitingNote: null }
    expect(creditWaitingSentence([
      { ...a, payAll: { ...a.payAll!, ...noNote } }, { ...b, payAll: { ...b.payAll!, ...noNote } },
    ])).toBe(`$50.00${CREDIT_WAITING_TAIL}`)
    const none = { runCreditWaiting: 0, runCreditWaitingNote: null }
    expect(creditWaitingSentence([
      { ...a, payAll: { ...a.payAll!, ...none } }, { ...b, payAll: { ...b.payAll!, ...none } },
    ])).toBeNull()
  })

  it('bills that are not exactly the run the server played through keep their own figures', () => {
    const third = bill({ leaseId: 'X', usableCredit: 10, payIfUsed: 490 })
    expect(payAllView([renewal, old, third])).toEqual([renewal, old, third])
    expect(payAllView([renewal])).toEqual([renewal])
    expect(payAllView([renewal, bill({ leaseId: 'OLD' })])).toHaveLength(2)
    expect(creditOffer([renewal, bill({ leaseId: 'OLD', usableCredit: 0, payIfUsed: 500 })]).usable).toBe(30)
  })
})
