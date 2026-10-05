// ── S639: ONE PAGE FOR THE FRONT COUNTER ────────────────────────────────────
//
// Nic (verbatim): "We really need an onboarding page that shows where each
// person is at in the process, like, all in one place. I know we can see our
// different things like, hey, these people have been sent leases, and then these
// people have been sent invites. It's all over the place. I need to have my
// front desk person be able to go to one page on the computer, see all the
// people that need to be contacted, and what phase they're in of the onboarding
// process so that they can be told, hey, accept your invite. Or, hey, have your
// other household member accept their invite or sign your lease."
//
// The information already existed and was scattered across three screens built
// for three different jobs: the pending pool is a PDF-upload queue, Gold Sign is
// a signature queue, and the units page is a property view. Each answers "what
// is the state of this thing"; none answers "who do I ring, and what do I say".
//
// So this is not a fourth view of the same rows — it is a CALL LIST. Every
// person is a line with the one sentence the desk needs to say to them, and the
// phases are ordered by who is genuinely blocked. Nobody at a counter should
// have to work out which of three screens holds today's phone calls.
import { useEffect, useState } from 'react'
import { useUrlTab } from '../lib/useUrlTab'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { api, apiGet, apiPatch } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { LeavingModal, type LeavingLease } from '../components/LeavingModal'
import { EmergencyContactsPanel } from './EmergencyContactsPanel'
import { SearchBox } from '../components/ListControls'
import { Phone, Mail, Search, CalendarX } from 'lucide-react'
import { TicketBreakdown, PayLinkBreakdown, InvoiceBreakdown } from '../components/BalanceBreakdowns'
import { serverTotals, deskBalanceSentence } from '../lib/creditDesk'
import { MakeDepositPanel } from './MakeDepositPanel'
import { EntityPicker, useCompanyMissing, useEntities } from '../components/EntityPicker'
import { FRESH_LIST, loadFailedSentence, actionFailedSentence, isSwitchRefusal } from './deskErrors'

type Balance = {
  tenantId: string
  firstName: string | null
  lastName: string | null
  email: string
  phone: string | null
  unitNumber: string | null
  // The property the line is owed at: a pay link's register reads name it.
  propertyId: string | null
  propertyName: string | null
  balance: string
  // S655 (Nic, 10/2): the full balance, with what their credit could pay of it
  // BESIDE it — never taken off it. creditOnAccount is everything on file.
  creditAvailable: number
  creditOnAccount: number
  oldestDueDate: string | null
  openInvoices: number
  // S652: money owed outside a rent ledger — an emailed pay link, or a
  // register ticket somebody walked away from. Settled at the register.
  payLinkId?: string | null
  payLink?: { label: string; items: any[] } | null
  ticketId?: string | null
  ticket?: { note: string | null; items: any[] } | null
}

type Row = {
  intentId: string
  firstName: string | null
  lastName: string | null
  email: string
  phone: string | null
  heldUnitNumber: string | null
  propertyName: string | null
  inviteState: 'not_invited' | 'invited' | 'accepted'
  inviteExpiresAt: string | null
  leaseDocStatus: string | null
  leaseWaitingOnRole: string | null
  leaseWaitingOnName: string | null
  householdPendingNames: string[] | null
}

// The pipeline, in the order somebody is blocked. `owed` marks the phases where
// the ball is on OUR side of the net — those sort first, because a resident
// chasing us is worse than a resident we are chasing.
/** The Front Desk's tabs (?tab=). */
type DeskTab = 'calls' | 'moveouts' | 'emergency' | 'deposit'

type PhaseId = 'overdue' | 'due' | 'not_invited' | 'awaiting_accept' | 'awaiting_household'
             | 'landlord_signs' | 'awaiting_signature' | 'awaiting_cosigner' | 'done'

// ── S639 (Nic): "anything the front desk person needs to do should be there.
// outstanding rent etc." ──
//
// Money sits at the top because it is the one thing a resident STANDING AT THE
// COUNTER is usually there for, and because it is the only row on this page
// where the desk takes an action rather than makes a request.
const PHASES: { id: PhaseId; label: string; owed?: boolean; tone: string }[] = [
  { id: 'overdue',            label: 'Owes — overdue',                      tone: 'var(--red)' },
  { id: 'due',                label: 'Owes',                                tone: 'var(--gold)' },
  { id: 'not_invited',        label: 'Needs an invite',        owed: true,  tone: 'var(--red)' },
  { id: 'landlord_signs',     label: 'Waiting on you to sign', owed: true,  tone: 'var(--gold)' },
  { id: 'awaiting_accept',    label: 'Accept the invite',                   tone: 'var(--gold)' },
  { id: 'awaiting_household', label: 'Waiting on household',                tone: 'var(--amber, #d9a441)' },
  { id: 'awaiting_signature', label: 'Sign the lease',                      tone: 'var(--gold)' },
  { id: 'awaiting_cosigner',  label: 'Waiting on co-signer',                tone: 'var(--amber, #d9a441)' },
  { id: 'done',               label: 'Nothing needed',                      tone: 'var(--green)' },
]

/** The phase's name for whoever is looking: a staffer cannot sign the owner's lease. */
const phaseLabel = (p: { id: PhaseId; label: string }, isOwner: boolean) =>
  p.id === 'landlord_signs' && !isOwner ? 'Waiting on the owner to sign' : p.label

/**
 * What the person looking can open, so a sentence never sends them to a page
 * or a role they do not have: the owner signs leases; E-Sign opens with
 * esign.tab.documents; the register's open tickets & pay links with
 * pos.tab.register.
 */
interface Who { isOwner: boolean; canESign: boolean; canRegister: boolean }

function joinNames(list: string[]): string {
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** Where they are, and the sentence to say. One function so the badge and the
 *  script can never disagree with each other. */
function classify(r: Row, who: Who): { phase: PhaseId; say: string; noInviteButton?: boolean } {
  const first = (r.firstName || 'they').trim()
  const household = (r.householdPendingNames || []).filter(Boolean)
  const unit = r.heldUnitNumber ? ` for ${r.heldUnitNumber}` : ''

  if (r.leaseDocStatus === 'completed') {
    return { phase: 'done', say: `Lease signed${unit}. Nothing needed.` }
  }
  if (r.leaseDocStatus === 'voided') {
    // Re-sending the portal invite does not replace a voided lease, so this
    // row offers no Re-send invite button.
    return { phase: 'not_invited', noInviteButton: true,
      say: who.canESign
        ? `Their lease${unit} was voided. Send a new lease from E-Sign — re-sending the invite does not replace it.`
        : `Their lease${unit} was voided. Ask the owner or a manager to send a new lease — re-sending the invite does not replace it.` }
  }
  if (r.leaseDocStatus) {
    const role = r.leaseWaitingOnRole
    if (role === 'landlord' || role === 'witness') {
      return { phase: 'landlord_signs', say: who.isOwner
        ? `Their lease${unit} is drafted and waiting on YOUR signature.`
        : `Their lease${unit} is drafted and waiting on the owner's signature. Nothing for ${first} to do yet.` }
    }
    // Waiting on a tenant. Is it this one, or somebody else on the lease?
    const waitingName = (r.leaseWaitingOnName || '').trim().toLowerCase()
    const thisName = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim().toLowerCase()
    if (waitingName && waitingName !== thisName) {
      return { phase: 'awaiting_cosigner',
        say: `Their part is done — ${r.leaseWaitingOnName} still has to sign the lease${unit}.` }
    }
    return { phase: 'awaiting_signature',
      say: `Ask ${first} to sign their lease${unit} — the link is in their email, or they can sign in and do it from their portal.` }
  }
  if (r.inviteState === 'not_invited') {
    return { phase: 'not_invited', say: `No invite has gone out to ${first} yet. Send one.` }
  }
  if (r.inviteState === 'accepted') {
    if (household.length > 0) {
      return { phase: 'awaiting_household',
        // S647: leases draft at invite time now, so an accepted person with no
        // lease document means drafting did not happen (usually the template) —
        // not that the household is holding it up.
        say: `${first} is in. ${joinNames(household)} still ${household.length === 1 ? 'has' : 'have'} to accept their portal invite — ask ${first} to nudge them. Their lease hasn't been drafted yet; `
          + (who.canESign ? 'check E-Sign.' : 'ask the owner or a manager to check it.') }
    }
    return { phase: 'done', say: `${first} has accepted. Their lease is being prepared — nothing needed.` }
  }
  // invited, not accepted
  const exp = r.inviteExpiresAt ? new Date(r.inviteExpiresAt) : null
  const expired = exp ? exp.getTime() < Date.now() : false
  return { phase: 'awaiting_accept',
    say: expired
      // The Re-send invite button sits on this same row, for everyone who sees it.
      ? `${first}'s invite has expired. Press Re-send invite, then ask them to accept.`
      // S647: the lease no longer waits for acceptance — the landlord signs
      // first — so the old "cannot be drafted until they do" was false.
      : `Ask ${first} to accept the portal invite in their email.` }
}

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

/** A YYYY-MM-DD string as a local calendar date, never shifted by the time zone. */
const localDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
}

/** What the desk says to somebody who owes. The figure is the server's full
 *  balance — work trade already left out (a work-trade resident settles in
 *  hours, not cash, and must never be asked for money at a counter) and credit
 *  NOT taken off: their credit is said beside it, to be used only if they say
 *  so (S655, Nic 10/2). */
function classifyBalance(b: Balance, who: Who): { phase: PhaseId; say: string } | null {
  const first = (b.firstName || 'They').trim()
  const owed = Number(b.balance || 0)
  const credit = Number(b.creditAvailable || 0)
  // S652 (Nic, Blu): "why is it saying they owe rent on September 30th?" The
  // bill was due October 1st. A date-only string parsed as a Date is midnight
  // UTC, which is the evening before in Phoenix. Read it as a calendar date.
  const due = b.oldestDueDate ? localDate(b.oldestDueDate) : null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  // "It shouldn't show until it's due." A bill for next month is not something
  // to say to somebody at the counter today.
  if (due && due.getTime() > today.getTime()) return null
  const overdue = due ? due.getTime() < today.getTime() : false
  const when = due
    ? due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  // S652 (Nic): "put the pay links as an open ticket as well. That way they can
  // be resolved in person when somebody comes in." Both are settled at the
  // register, from its open list — never a rent payment.
  if (b.payLinkId) {
    return {
      phase: overdue ? 'overdue' : 'due',
      say: `${first} owes ${money(owed)} on an emailed pay link${when ? ` sent ${when}` : ''}. `
         + (who.canRegister
           ? 'They can pay the link, or settle it here: Register → open tickets & pay links.'
           : 'They can pay the link, or ask the owner or a manager to settle it at the register.'),
    }
  }
  if (b.ticketId) {
    return {
      phase: overdue ? 'overdue' : 'due',
      say: `${first} owes ${money(owed)} on a register ticket${when ? ` from ${when}` : ''}`
         + `${b.ticket?.note ? ` — ${b.ticket.note}` : ''}. `
         + (who.canRegister
           ? 'Settle it at the register from its open list.'
           : 'Ask the owner or a manager to settle it at the register.'),
    }
  }
  // Rent is pay-in-full platform-wide, so a part payment is not an option the
  // desk can offer — saying so here stops them promising one at the counter.
  return {
    phase: overdue ? 'overdue' : 'due',
    say: deskBalanceSentence({ first, owed, credit, when, overdue }),
  }
}

export function FrontDeskPage() {
  const qc = useQueryClient()
  // S654 (Nic): "it'd be nice if they were all clickable so the front desk
  // could really see… what the electric is, any late fees." The amount opens
  // the same line-item view the Balances page has: invoice lines, a pay link's
  // items, or a register ticket's. One at a time — a counter looks one person up.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // ── S639 (Nic): "add a resend invite button so the front desk person can be
  // useful in case the old one happens to have expired or accidentally been
  // deleted or whatever. I don't want the front desk person held up on a
  // technicality." ──
  //
  // The one action worth having here. Everything else on this page is read-only
  // on purpose — a counter should not be able to cancel somebody's invite by
  // misclicking — but re-sending is safe by construction: it issues a FRESH
  // token to the address already on file, so the worst case is the resident
  // getting a second email, and the best case is the desk fixing the call while
  // the person is still on the phone.
  // Who may see what — read before the call-list queries, so a staffer who
  // holds no call-list key never asks the server for lists it would refuse.
  const { can, isOwner } = usePerms()
  const who: Who = { isOwner, canESign: can('esign.tab.documents'), canRegister: can('pos.tab.register') }
  const [sentTo, setSentTo] = useState<Record<string, 'sending' | 'sent' | 'held' | 'error'>>({})
  // Why a re-send failed, said once with the step that works: on the row, or
  // — when the list read again no longer holds that person (the owner
  // cancelled the invite meanwhile) — once above the list, by name.
  // `reason` is why; `rowTail` and `next` are said only on the row (while the
  // person is still on the list): "The list shows where they are now." and the
  // step that works there ("Try again…", "Ask the owner or a manager…"). Once
  // the list read again no longer holds them, both would be false — there is
  // no invite left to try again — so the banner says the reason, that they are
  // gone and what to do instead (lostTail), and nothing else.
  const [sendError, setSendError] = useState<Record<string, { reason: string; rowTail: string; next: string; name: string }>>({})
  const dropSendError = (id: string) => setSendError(m => { const n = { ...m }; delete n[id]; return n })
  const resend = useMutation(
    (v: { intentId: string; name: string }) =>
      apiPatch(`/landlords/me/pending-intents/${v.intentId}/contact`, { resend: true }),
    {
      onMutate: ({ intentId: id }) => {
        setSentTo(m => ({ ...m, [id]: 'sending' }))
        dropSendError(id)
      },
      onSuccess: (d: any, { intentId: id }) => {
        // S648: nothing is emailed before the landlord signs the lease.
        setSentTo(m => ({ ...m, [id]: d?.resent ? 'sent' : 'held' }))
        qc.invalidateQueries('pending-tenants')
      },
      onError: (e: any, { intentId: id, name }) => {
        setSentTo(m => ({ ...m, [id]: 'error' }))
        // The row may be stale (they signed, the invite is gone): the call
        // list is read again on every refusal, so the row shows where they
        // are now.
        qc.invalidateQueries('pending-tenants')
        const status: number | undefined = e?.response?.status
        // A refusal for good (any 4xx: "They have already signed — their
        // account is their own now.", "That invite no longer exists.") is
        // said as the server said it — trying again will not change it.
        // Only a failure that may pass says to try again: no answer, a
        // server fault, a timeout (408) or "too many requests" (429, the
        // API's rate limit), which passes on its own.
        // The pending pool is named only for somebody who can open it
        // (tenants.create); a front-desk-only staffer is pointed at a person
        // instead of a page they cannot reach.
        const final = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
        // The route's own bare "Forbidden" is not a switch: the invite is
        // another company's (the staffer's companies changed, or the list
        // was stale). Said in plain words, never the raw word.
        const bareForbidden = status === 403 && /^forbidden\.?$/i.test(String(e?.response?.data?.error ?? '').trim())
        const tryAgain = can('tenants.create')
          ? 'Try again, or re-send it from the pending pool.'
          : 'Try again; if it keeps failing, ask the owner or a manager to re-send it.'
        const switchRefusal = isSwitchRefusal(e)
        const reason = switchRefusal
          ? actionFailedSentence(e, '', 'Re-sending an invite', 'Front desk to-do list')
          : bareForbidden
            ? 'That invite belongs to a company you are not on, so it cannot be re-sent from here.'
            : final
              ? actionFailedSentence(e, 'The invite could not be sent', 'Re-sending an invite', 'Front desk to-do list')
              // The rate limit answers with no sentence of its own, and no
              // answer at all carries only the browser's words: plain ones instead.
              : status === 429
                ? 'GAM was too busy to send it just now.'
                : status === undefined
                  ? 'GAM did not answer, so the invite may not have gone.'
                  : actionFailedSentence(e, 'The invite could not be sent', 'Re-sending an invite', 'Front desk to-do list')
        const rowTail = !switchRefusal && (bareForbidden || final) ? ' The list shows where they are now.' : ''
        // The step that works on the row: a failure that may pass is tried
        // again; another company's invite is re-sent by that company's owner
        // or a manager. A refusal for good otherwise is its own last word.
        const next = switchRefusal ? ''
          : bareForbidden ? ' If they should still get one, ask the owner or a manager to re-send it.'
            : final ? '' : ` ${tryAgain}`
        setSendError(m => ({ ...m, [id]: { reason, rowTail, next, name } }))
      },
    },
  )

  // Who may see what (read at the top of the page: the re-send's error names
  // the pending pool only for somebody who can open it).
  const canMarkLeaving = can('front_desk.mark_leaving') || can('leases.edit')
  const canSeeCalls = can('front_desk.view') || can('tenants.create')
  // decisions.md #48.2 (line 20: "staff tick what went in the bag"): whoever
  // takes payments makes the bank deposit for the cash they took — here, at the
  // counter, without the owner-only bank matching.
  const canBankCash = can('take_payment')
  // GET /balances is served to balances.view alone ("Amounts owed need 'View
  // who owes + contact'"), so a call-list staffer without it never asks: a
  // refused request must not read as "nobody owes anything".
  const canSeeOwed = canSeeCalls && can('balances.view')

  // Read again every time the tab is looked at (FRESH_LIST): somebody who just
  // paid on another page must not still show as owing here.
  const { data: rows = [], isLoading, isError: callsFailed, error: callsError, refetch: refetchCalls } = useQuery<Row[]>(
    'pending-tenants', () => apiGet<Row[]>('/landlords/me/pending-tenants'),
    { ...FRESH_LIST, enabled: canSeeCalls })
  // S639: the money half. Same endpoint the outstanding-balances page uses, so
  // the counter and the office can never quote different numbers — and it is
  // already property-scoped and already excludes work trade. (No payments
  // still clearing: those are paid, not today's to-dos.) decisions #25: a total
  // across people comes only from the server, which sends it to owners and
  // property managers alone — this page never adds the rows up itself.
  const { data: balanceRes, isLoading: owedIsLoading, isError: owedFailed, error: owedError, refetch: refetchOwed } = useQuery(
    ['outstanding-balances', 'desk'],
    () => api.get('/balances').then(r => r.data as { data: Balance[]; meta?: unknown }),
    { ...FRESH_LIST, enabled: canSeeOwed })
  // One sentence for each list the server would not give: its own reason, then
  // the next step (a 403 names the switch, and that signing in again picks up a
  // switch just turned on). Never an empty list that reads as "nobody to call".
  // Two refusals for the same reason are said once.
  const listErrors = [...new Set([
    callsFailed ? loadFailedSentence(callsError, 'The call list', 'Front desk to-do list') : null,
    owedFailed ? loadFailedSentence(owedError, 'Who owes money', 'View who owes + contact') : null,
  ].filter((x): x is string => !!x))]
  const listError = listErrors.length > 0
  // A re-send refusal whose person the list read again no longer holds (the
  // invite was cancelled meanwhile): said once above the list, naming them —
  // it would otherwise vanish with the row.
  const lostSendErrors = Object.entries(sendError)
    .filter(([id]) => sentTo[id] === 'error' && !(rows as Row[]).some(r => r.intentId === id))
  // What is true once they are off the list, and the step that works: there is
  // no invite left to re-send, so a new one has to be made — from the pending
  // pool by somebody who can open it, otherwise by the owner or a manager.
  const lostTail = (name: string) => {
    const first = name.split(' ')[0] || name
    return ` ${first} is no longer on this list, so there is no invite to re-send. `
      + (can('tenants.create')
        ? 'If they should still get one, invite them again from the pending pool.'
        : 'If they should still get one, ask the owner or a manager to invite them again.')
  }
  // Loading until BOTH halves are in: an empty call list with the balances
  // still on their way must never read as "nobody owes" (no count of 0, no
  // "Nobody here").
  const loading = isLoading || (canSeeOwed && owedIsLoading)
  const balances: Balance[] = balanceRes?.data ?? []
  const owedTotal = serverTotals(balanceRes?.meta)?.owed ?? null
  const [q, setQ] = useState('')
  const [phase, setPhase] = useState<PhaseId | 'all'>('all')
  const [openProps, setOpenProps] = useState<Record<string, boolean>>({})

  const query = q.trim().toLowerCase()
  // One list, two sources. A person can legitimately appear twice — owing money
  // AND owing a signature are two separate things to say to them — so they are
  // not merged into one row that would have to pick which matters more.
  const classified: Array<{ key: string; r: Row | null; b: Balance | null
                            phase: PhaseId; say: string; noInviteButton?: boolean
                            name: string; email: string; phone: string | null
                            unit: string | null; property: string | null }> = [
    ...(balances as Balance[]).flatMap(b => {
      const c = classifyBalance(b, who)
      if (!c) return []
      return [{
        key: `bal:${b.payLinkId ?? b.ticketId ?? b.tenantId}`, r: null, b, ...c,
        name: `${b.firstName ?? ''} ${b.lastName ?? ''}`.trim() || b.email,
        email: b.email, phone: b.phone, unit: b.unitNumber, property: b.propertyName,
      }]
    }),
    ...(rows as Row[]).map(r => {
      const c = classify(r, who)
      return {
        key: `int:${r.intentId}`, r, b: null, ...c,
        name: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.email,
        email: r.email, phone: r.phone, unit: r.heldUnitNumber, property: r.propertyName,
      }
    }),
  ]
  // A search looks at everybody, whatever phase or property — the desk is
  // holding a name, not a filter.
  const matches = classified.filter(c => !query ||
    [c.name, c.email, c.phone, c.unit].some(v => String(v ?? '').toLowerCase().includes(query)))
  const shown = query ? matches : matches.filter(c => phase === 'all' || c.phase === phase)

  const counts = (id: PhaseId) => classified.filter(c => c.phase === id).length
  const toCall = classified.filter(c => c.phase !== 'done').length

  // One section per property, ordered by who has work owed by US first.
  const groups = (() => {
    const m = new Map<string, typeof shown>()
    for (const c of shown) {
      const k = c.property || 'No property'
      if (!m.has(k)) m.set(k, [] as any)
      ;(m.get(k) as any).push(c)
    }
    const order = (p: PhaseId) => PHASES.findIndex(x => x.id === p)
    return [...m.entries()]
      .map(([name, list]) => ({
        name,
        list: [...list].sort((a, b) => order(a.phase) - order(b.phase)),
        owed: list.filter(c => PHASES.find(p => p.id === c.phase)?.owed).length,
      }))
      .sort((a, b) => (b.owed - a.owed) || a.name.localeCompare(b.name))
  })()
  const sectionOpen = (n: string) => (query ? true : openProps[n] !== false)
  // ── S639 (Nic): NO CHOICE THEY COULD GET WRONG ─────────────────────────────
  //
  // "I want them scoped to the specific property. I don't want any filters that
  // they have to choose... I'm basically having the system hand hold my people so
  // that they can't screw anything up. The less things that it's possible for
  // somebody to screw up, the bigger your talent pool is for helping run your
  // business. So we're trying to expand the talent pool by shrinking the
  // requirements."
  //
  // The API now returns only the parks this person works at, so somebody scoped
  // to Mountain View gets one group — and a collapsible header over a single
  // group is a control with exactly one setting, which is a thing to click
  // wrongly and nothing else. It disappears; the page simply IS their park.
  const singleProperty = groups.length === 1

  // ── S640 (Nic): EMERGENCY CONTACTS LIVE HERE ───────────────────────────────
  //
  // "We wanna have a page that is accessible... somewhere near the front desk
  // type page or maybe a sub tab in the front desk page. That way my front desk
  // help Lisa Scheeler can see that."
  //
  // A sub-tab rather than its own nav entry, because it is the same job: things
  // to say to the person standing in front of you. It also means one permission
  // switch covers both, which is the rule for this role — the fewer things there
  // are to get wrong, the wider the pool of people who can do it.
  // ── S653 (Nic): MOVE-OUTS LIVE HERE TOO ────────────────────────────────────
  //
  // "They're going to come in and say, hey, I'm pulling out Saturday with like
  // maybe three or four days notice, if that. We need the front desk to be able
  // to mark it as, hey, they're leaving then."
  //
  // Same job as the call list — the person is standing at the counter — so it
  // is a tab here, gated on its own key (front_desk.mark_leaving). Somebody
  // holding only that key lands on it directly.
  // (The keys are read at the top of the page, before the call-list queries.)
  // Somebody who only takes payments lands on the bank deposit, not on a tab
  // they hold no key for.
  //
  // Every tab is shown only to whoever the server serves it to, so no tab ever
  // opens on a refusal that reads as an empty list: the call list and the
  // emergency contacts are both served to front_desk.view / tenants.create
  // (routes/landlords.ts pending-tenants, routes/emergencyContacts.ts), the
  // move-outs to front_desk.mark_leaving / leases.edit (routes/leases.ts
  // desk/residents), and the bank deposit to take_payment.
  const allowed: Record<DeskTab, boolean> = {
    calls: canSeeCalls, moveouts: canMarkLeaving, emergency: canSeeCalls, deposit: canBankCash,
  }
  const firstTab: DeskTab | null = (['calls', 'moveouts', 'deposit'] as const).find(t => allowed[t]) ?? null
  const [urlTab, setTab] = useUrlTab<DeskTab>(
    'tab', firstTab ?? 'calls', ['calls','moveouts','emergency','deposit'])
  // A saved address to a tab this person holds no key for opens their own
  // first tab instead.
  const tab: DeskTab | null = allowed[urlTab] ? urlTab : firstTab
  // The call list's queries live on the page, so switching tabs does not
  // remount them: coming back to the Call list tab reads both lists again
  // (react-query joins a read already in flight, so the first open asks once).
  useEffect(() => {
    if (tab !== 'calls') return
    if (canSeeCalls) void refetchCalls()
    if (canSeeOwed) void refetchOwed()
  }, [tab])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Front Desk{singleProperty ? ` · ${groups[0].name}` : ''}
          </h1>
          {/* The count comes from the call list; somebody without it is told nothing about calls. */}
          {canSeeCalls && !listError && <p className="page-subtitle">
            {loading ? 'Loading…' : (
              <>
                {toCall} {toCall === 1 ? 'person needs' : 'people need'} contacting
                {owedTotal !== null && owedTotal > 0 && (
                  <> · <strong style={{ color: 'var(--gold)' }}>{money(owedTotal)}</strong> to collect</>
                )}
              </>
            )}
          </p>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {canSeeCalls && (
          <button type="button" onClick={() => setTab('calls')}
            className={`btn btn-sm ${tab === 'calls' ? 'btn-primary' : 'btn-ghost'}`}>
            Call list{toCall > 0 && !listError && !loading ? ` (${toCall})` : ''}
          </button>
        )}
        {canMarkLeaving && (
          <button type="button" onClick={() => setTab('moveouts')}
            className={`btn btn-sm ${tab === 'moveouts' ? 'btn-primary' : 'btn-ghost'}`}>
            Move-outs
          </button>
        )}
        {allowed.emergency && (
          <button type="button" onClick={() => setTab('emergency')}
            className={`btn btn-sm ${tab === 'emergency' ? 'btn-primary' : 'btn-ghost'}`}>
            Emergency contacts
          </button>
        )}
        {canBankCash && (
          <button type="button" onClick={() => setTab('deposit')}
            className={`btn btn-sm ${tab === 'deposit' ? 'btn-primary' : 'btn-ghost'}`}>
            Make a bank deposit
          </button>
        )}
      </div>

      {tab === null ? (
        // Reached Front Desk with no key for any of its tabs (for example an
        // onboarding key only): say so, and what to ask for.
        <div className="card" style={{ padding: 24, color: 'var(--text-2)' }}>
          Nothing on the Front Desk is turned on for you yet. Ask the owner to turn on
          "Front desk to-do list", "Mark a resident as leaving" or "Record a cash / check payment" for you.
        </div>
      ) : tab === 'deposit' ? <DeskDepositPanel /> : tab === 'emergency' ? <EmergencyContactsPanel /> : tab === 'moveouts' ? <MoveOutsPanel /> : (
      <>
      {listErrors.map(e => (
        <div key={e} className="card" role="alert" style={{ padding: 14, marginBottom: 12, color: 'var(--danger, #dc2626)' }}>{e}</div>
      ))}
      {lostSendErrors.map(([id, e]) => (
        <div key={`resend-${id}`} className="card" role="alert"
          style={{ padding: 14, marginBottom: 12, color: 'var(--red)',
            display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Only the reason and what is true now: "Try again" would point at
              an invite that is no longer there. */}
          <span>Re-sending {e.name}'s invite: {e.reason}{lostTail(e.name)}</span>
          <button type="button" className="btn btn-ghost btn-sm"
            aria-label={`Put away the message about ${e.name}`}
            onClick={() => dropSendError(id)}>
            ×
          </button>
        </div>
      ))}
      {/* A call-list staffer without "View who owes" is told the money lines are
          left out, so an empty list never reads as "nobody owes". */}
      {!canSeeOwed && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, fontSize: '.82rem', color: 'var(--text-2)' }}>
          Who owes money is not shown here. Ask the owner to turn on "View who owes + contact" for you.
        </div>
      )}
      <div className="filter-bar">
        <SearchBox value={q} onChange={setQ} placeholder="Name, email, phone or unit…" />
        {query ? (
          <span style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>
            searching everyone · {shown.length} match{shown.length === 1 ? '' : 'es'}
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }}
              onClick={() => setQ('')}>Clear</button>
          </span>
        ) : (
          <>
            {/* A count is said only when both lists are in: with one refused
                or still loading, a number would be half the truth. */}
            <button type="button" onClick={() => setPhase('all')}
              className={`btn btn-sm ${phase === 'all' ? 'btn-primary' : 'btn-ghost'}`}>
              Everyone{listError || loading ? '' : ` (${classified.length})`}
            </button>
            {PHASES.filter(p => counts(p.id) > 0).map(p => (
              <button key={p.id} type="button" onClick={() => setPhase(p.id)}
                className={`btn btn-sm ${phase === p.id ? 'btn-primary' : 'btn-ghost'}`}>
                {phaseLabel(p, isOwner)}{listError || loading ? '' : ` (${counts(p.id)})`}
              </button>
            ))}
          </>
        )}
      </div>

      {loading ? (
        <div className="card"><div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div></div>
      ) : listError && shown.length === 0 ? null : shown.length === 0 ? (
        <div className="empty-state" style={{ padding: 48 }}>
          <Search size={40} />
          <h3>Nobody here</h3>
          <p>{query ? 'No one matches that search.' : 'Nobody is in this phase right now.'}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {groups.map(g => (
            <div key={g.name} style={{ borderTop: '1px solid var(--border-0)' }}>
              {/* S639: one park, no header. The title already says where they
                  are, and a toggle with one option is only a way to hide the
                  list from yourself. */}
              {!singleProperty && (
              <button type="button"
                onClick={() => setOpenProps(o => ({ ...o, [g.name]: o[g.name] === false }))}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                         background: 'transparent', border: 'none', cursor: 'pointer',
                         padding: '12px 16px', textAlign: 'left', color: 'var(--text-0)' }}>
                <span style={{ color: 'var(--text-3)', fontSize: '.8rem', width: 12 }}>
                  {sectionOpen(g.name) ? '▾' : '▸'}
                </span>
                <span style={{ fontWeight: 700 }}>{g.name}</span>
                <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                  {g.list.length} {g.list.length === 1 ? 'person' : 'people'}
                </span>
                {g.owed > 0 && (
                  <span style={{ fontSize: '.76rem', fontWeight: 700, color: 'var(--gold)' }}>
                    {isOwner ? `${g.owed} waiting on you` : `${g.owed} need an invite or the owner's signature`}
                  </span>
                )}
              </button>
              )}

              {(singleProperty || sectionOpen(g.name)) && (
                <div style={{ padding: '0 16px 12px' }}>
                  {g.list.map(({ key, r, b, phase: ph, say, noInviteButton, name, email, phone, unit }) => {
                    const meta = PHASES.find(p => p.id === ph)!
                    const open = !!b && openKey === key
                    return (
                      <div key={key} style={{ borderTop: '1px solid var(--border-0)' }}>
                      {/* S654 (Nic): "the front desk page is still not clickable for the
                          line item breakdown" — only the amount was, with a small hint.
                          The whole row opens it now, like the Balances page, with the
                          caret by the name; buttons and links inside keep their own job. */}
                      <div
                        onClick={e => {
                          if (!b) return
                          if ((e.target as HTMLElement).closest('a,button,input,select')) return
                          setOpenKey(open ? null : key)
                        }}
                        title={b ? (open ? 'Hide the charges' : 'See every charge behind this amount') : undefined}
                        style={{
                          display: 'flex', gap: 14, alignItems: 'flex-start',
                          padding: '11px 0', cursor: b ? 'pointer' : 'default',
                        }}>
                        <div style={{ minWidth: 150 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>
                            {b && <span style={{ color: 'var(--text-3)', marginRight: 6, fontSize: '.7rem' }}>{open ? '▾' : '▸'}</span>}
                            {name}
                          </div>
                          <div style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>
                            {unit || '—'}
                          </div>
                          {/* The amount, big enough to read across a counter. */}
                          {b && (
                            <button type="button" onClick={() => setOpenKey(open ? null : key)}
                              title={open ? 'Hide the charges' : 'See every charge behind this amount'}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: meta.tone, marginTop: 2 }}>
                                {money(Number(b.balance || 0))}
                              </div>
                              <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                                {open ? '▾ hide the charges' : '▸ what\u2019s on it'}
                              </div>
                            </button>
                          )}
                        </div>
                        <div style={{ minWidth: 150, fontSize: '.78rem' }}>
                          {/* Both contact routes, one click each — this is a page
                              somebody works a phone from. */}
                          {phone && (
                            <div><a href={`tel:${phone}`} style={{ color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <Phone size={12} /> {phone}
                            </a></div>
                          )}
                          <div><a href={`mailto:${email}`} style={{ color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 5, wordBreak: 'break-all' }}>
                            <Mail size={12} /> {email}
                          </a></div>
                        </div>
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <span style={{
                            fontSize: '.72rem', fontWeight: 700, color: meta.tone,
                            textTransform: 'uppercase', letterSpacing: '.04em',
                          }}>{phaseLabel(meta, isOwner)}</span>
                          <div style={{ fontSize: '.85rem', color: 'var(--text-1)', marginTop: 3, lineHeight: 1.5 }}>
                            {say}
                          </div>
                          {/* Why a re-send failed, said once on the row — it stays
                              when the list read again moves the row to another
                              phase (they signed meanwhile) and the button goes. */}
                          {r && sentTo[r.intentId] === 'error' && sendError[r.intentId] && (
                            <div role="alert" style={{ fontSize: '.78rem', color: 'var(--red)', marginTop: 4 }}>
                              {sendError[r.intentId].reason}{sendError[r.intentId].rowTail}{sendError[r.intentId].next}
                            </div>
                          )}
                        </div>
                        {/* Only where an invite is the thing that is stuck. A
                            lease waiting on a signature is not fixed by another
                            invite email. */}
                        {r && !noInviteButton && (ph === 'awaiting_accept' || ph === 'not_invited') && (
                          <div style={{ minWidth: 128, textAlign: 'right' }}>
                            {sentTo[r.intentId] === 'sent' ? (
                              <span style={{ fontSize: '.78rem', color: 'var(--green)', fontWeight: 600 }}>
                                ✓ Invite re-sent
                              </span>
                            ) : sentTo[r.intentId] === 'held' ? (
                              <span style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                                Goes out when the lease is signed
                              </span>
                            ) : (
                              <button type="button" className="btn btn-primary btn-sm"
                                disabled={sentTo[r.intentId] === 'sending'}
                                onClick={() => resend.mutate({ intentId: r.intentId, name })}
                                title={`Send ${email} a brand-new invite link — the old one stops working`}>
                                {sentTo[r.intentId] === 'sending' ? 'Sending…' : 'Re-send invite'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      {open && b && (
                        <div style={{ background: 'rgba(255,255,255,.015)', borderRadius: 8, marginBottom: 10 }}>
                          {b.payLinkId
                            ? <PayLinkBreakdown id={b.payLinkId} link={b.payLink as any} propertyId={b.propertyId} />
                            : b.ticketId
                              ? <TicketBreakdown ticket={b.ticket as any} />
                              : b.tenantId
                                ? <InvoiceBreakdown tenantId={b.tenantId} />
                                : null}
                        </div>
                      )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  )
}

// ── decisions.md #48.2: the bank deposit, at the counter ──────────────────────
// The same "Make a bank deposit" the owner has on the Bank page, without the
// bank's own deposits (those stay the owner's). An account that owns several
// companies names the one whose cash is going in first; a team login's company
// comes from the server, so a staffer gets the panel straight away and never
// asks for the company list (/landlords/me/entities is the owner's: a team
// login would only be refused, retried and kept on "Loading…").
function DeskDepositPanel() {
  const { isOwner } = usePerms()
  return isOwner
    ? <OwnerDeskDepositPanel />
    : <MakeDepositPanel entityId="" canMatchBank={false} />
}

function OwnerDeskDepositPanel() {
  const [entityId, setEntityId] = useState('')
  // Wait for the company list before mounting the panel: until it arrives an
  // owner of several companies would read as "nothing to choose" and the panel
  // would ask the server for cash with no company, flashing its refusal.
  const entities = useEntities()
  const missing = useCompanyMissing(entityId)
  // One company: the picker names it on its next render, so the panel waits for
  // that instead of fetching once with no company and again with it.
  const settling = entities.isLoading || ((entities.data?.length ?? 0) === 1 && !entityId)
  return (
    <div>
      <EntityPicker value={entityId} onChange={setEntityId} label="Company"
        note="Each company banks its own cash." />
      {settling
        ? <div className="card" style={{ padding: 20, color: 'var(--text-2)' }}>Loading…</div>
        : missing
        ? <div className="card" style={{ padding: 20, color: 'var(--text-2)' }}>
            Choose the company whose cash is going to the bank.
          </div>
        : <MakeDepositPanel key={entityId || 'none'} entityId={entityId} canMatchBank={false} />}
    </div>
  )
}

// ── S653: the Move-outs tab ───────────────────────────────────────────────────
// Find the household (name, email, phone or space), tap the day they said.
// Whoever already has a day on file sits at the top so the desk can see who is
// going this week — and call it off when somebody changes their mind.
const sayShort = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function MoveOutsPanel() {
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<LeavingLease | null>(null)
  const query = q.trim()
  const { data: rows = [], isLoading, isError, error } = useQuery<any[]>(
    ['desk-residents', query],
    () => apiGet<any[]>(`/leases/desk/residents${query ? `?q=${encodeURIComponent(query)}` : ''}`),
    { ...FRESH_LIST, keepPreviousData: true })

  const leaving = rows.filter(r => r.moveOutNoticeAt)
  const staying = rows.filter(r => !r.moveOutNoticeAt)
  const toLease = (r: any): LeavingLease => ({
    leaseId: r.leaseId, unitNumber: r.unitNumber, propertyName: r.propertyName, names: r.names || r.email,
    startDate: r.startDate, endDate: r.endDate, moveOutNoticeAt: r.moveOutNoticeAt,
    moveOutNoticeNote: r.moveOutNoticeNote, moveOutNoticePrevEndDate: r.moveOutNoticePrevEndDate, markedBy: r.markedBy,
  })

  const Row = ({ r }: { r: any }) => (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border-0)' }}>
      <div style={{ minWidth: 170 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{r.names || r.email}</div>
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>{r.unitNumber} · {r.propertyName}</div>
      </div>
      <div style={{ minWidth: 150, fontSize: '.78rem' }}>
        {r.phone && <div><a href={`tel:${r.phone}`} style={{ color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 5 }}><Phone size={12} /> {r.phone}</a></div>}
        {r.email && <div><a href={`mailto:${r.email}`} style={{ color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 5, wordBreak: 'break-all' }}><Mail size={12} /> {r.email}</a></div>}
      </div>
      <div style={{ flex: 1, fontSize: '.82rem', color: 'var(--text-1)' }}>
        {r.moveOutNoticeAt ? (
          <>
            <span style={{ fontWeight: 800, color: 'var(--gold)' }}>Leaving {sayShort(r.endDate)}</span>
            {r.moveOutNoticeNote && <span style={{ color: 'var(--text-3)' }}> · “{r.moveOutNoticeNote}”</span>}
          </>
        ) : r.endDate ? (
          <span style={{ color: 'var(--text-3)' }}>Lease runs to {sayShort(r.endDate)}</span>
        ) : (
          <span style={{ color: 'var(--text-3)' }}>Month to month</span>
        )}
      </div>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setPick(toLease(r))}>
        {r.moveOutNoticeAt ? 'Change / call off' : 'Leaving on…'}
      </button>
    </div>
  )

  return (
    <>
      <div className="filter-bar">
        <SearchBox value={q} onChange={setQ} placeholder="Who's leaving? Name, email, phone or space…" />
      </div>
      {isError ? (
        // The server's own reason, then the next step — never "Nobody found".
        <div className="card" role="alert" style={{ padding: 14, color: 'var(--danger, #dc2626)' }}>
          {loadFailedSentence(error, 'The move-out list', 'Mark a resident as leaving')}
        </div>
      ) : isLoading && rows.length === 0 ? (
        <div className="card"><div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div></div>
      ) : rows.length === 0 ? (
        <div className="empty-state" style={{ padding: 48 }}>
          <CalendarX size={40} />
          <h3>Nobody found</h3>
          <p>{query ? 'No one on a space matches that.' : 'Nobody is on a space right now.'}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: '0 16px 12px' }}>
          {leaving.length > 0 && (
            <>
              <div style={{ padding: '12px 0 4px', fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Leaving ({leaving.length})
              </div>
              {leaving.map(r => <Row key={r.leaseId} r={r} />)}
            </>
          )}
          {staying.length > 0 && (
            <>
              <div style={{ padding: '12px 0 4px', fontSize: '.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                On a space ({staying.length})
              </div>
              {staying.map(r => <Row key={r.leaseId} r={r} />)}
            </>
          )}
        </div>
      )}
      {pick && <LeavingModal lease={pick} onClose={() => setPick(null)} />}
    </>
  )
}
