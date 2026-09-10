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
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import { SearchBox } from '../components/ListControls'
import { Phone, Mail, Search } from 'lucide-react'

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
type PhaseId = 'not_invited' | 'awaiting_accept' | 'awaiting_household'
             | 'landlord_signs' | 'awaiting_signature' | 'awaiting_cosigner' | 'done'

const PHASES: { id: PhaseId; label: string; owed?: boolean; tone: string }[] = [
  { id: 'not_invited',        label: 'Needs an invite',        owed: true,  tone: 'var(--red)' },
  { id: 'landlord_signs',     label: 'Waiting on you to sign', owed: true,  tone: 'var(--gold)' },
  { id: 'awaiting_accept',    label: 'Accept the invite',                   tone: 'var(--gold)' },
  { id: 'awaiting_household', label: 'Waiting on household',                tone: 'var(--amber, #d9a441)' },
  { id: 'awaiting_signature', label: 'Sign the lease',                      tone: 'var(--gold)' },
  { id: 'awaiting_cosigner',  label: 'Waiting on co-signer',                tone: 'var(--amber, #d9a441)' },
  { id: 'done',               label: 'Nothing needed',                      tone: 'var(--green)' },
]

function joinNames(list: string[]): string {
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** Where they are, and the sentence to say. One function so the badge and the
 *  script can never disagree with each other. */
function classify(r: Row): { phase: PhaseId; say: string } {
  const first = (r.firstName || 'they').trim()
  const household = (r.householdPendingNames || []).filter(Boolean)
  const unit = r.heldUnitNumber ? ` for ${r.heldUnitNumber}` : ''

  if (r.leaseDocStatus === 'completed') {
    return { phase: 'done', say: `Lease signed${unit}. Nothing needed.` }
  }
  if (r.leaseDocStatus === 'voided') {
    return { phase: 'not_invited', say: `Their lease${unit} was voided and needs re-sending.` }
  }
  if (r.leaseDocStatus) {
    const role = r.leaseWaitingOnRole
    if (role === 'landlord' || role === 'witness') {
      return { phase: 'landlord_signs', say: `Their lease${unit} is drafted and waiting on YOUR signature.` }
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
        say: `${first} is in. Their lease drafts as soon as ${joinNames(household)} accept${household.length === 1 ? 's' : ''} their portal invite — ask ${first} to nudge them.` }
    }
    return { phase: 'done', say: `${first} has accepted. Their lease is being prepared — nothing needed.` }
  }
  // invited, not accepted
  const exp = r.inviteExpiresAt ? new Date(r.inviteExpiresAt) : null
  const expired = exp ? exp.getTime() < Date.now() : false
  return { phase: 'awaiting_accept',
    say: expired
      ? `${first}'s invite has expired. Re-send it from the pending pool, then ask them to accept.`
      : `Ask ${first} to accept the portal invite in their email — the lease cannot be drafted until they do.` }
}

export function FrontDeskPage() {
  const qc = useQueryClient()
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
  const [sentTo, setSentTo] = useState<Record<string, 'sending' | 'sent' | 'error'>>({})
  const resend = useMutation(
    (intentId: string) => apiPatch(`/landlords/me/pending-intents/${intentId}/contact`, { resend: true }),
    {
      onMutate: (id: string) => { setSentTo(m => ({ ...m, [id]: 'sending' })) },
      onSuccess: (_d, id) => {
        setSentTo(m => ({ ...m, [id]: 'sent' }))
        qc.invalidateQueries('pending-tenants')
      },
      onError: (_e, id) => { setSentTo(m => ({ ...m, [id]: 'error' })) },
    },
  )

  const { data: rows = [], isLoading } = useQuery<Row[]>(
    'pending-tenants', () => apiGet<Row[]>('/landlords/me/pending-tenants'),
    { refetchOnWindowFocus: true })
  const [q, setQ] = useState('')
  const [phase, setPhase] = useState<PhaseId | 'all'>('all')
  const [openProps, setOpenProps] = useState<Record<string, boolean>>({})

  const query = q.trim().toLowerCase()
  const classified = (rows as Row[]).map(r => ({ r, ...classify(r) }))
  // A search looks at everybody, whatever phase or property — the desk is
  // holding a name, not a filter.
  const matches = classified.filter(({ r }) => !query || [
    r.firstName, r.lastName, `${r.firstName ?? ''} ${r.lastName ?? ''}`,
    r.email, r.phone, r.heldUnitNumber,
  ].some(v => String(v ?? '').toLowerCase().includes(query)))
  const shown = query ? matches : matches.filter(c => phase === 'all' || c.phase === phase)

  const counts = (id: PhaseId) => classified.filter(c => c.phase === id).length
  const toCall = classified.filter(c => c.phase !== 'done').length

  // One section per property, ordered by who has work owed by US first.
  const groups = (() => {
    const m = new Map<string, typeof shown>()
    for (const c of shown) {
      const k = c.r.propertyName || 'No property'
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Front Desk{singleProperty ? ` · ${groups[0].name}` : ''}
          </h1>
          <p className="page-subtitle">
            {isLoading ? 'Loading…' : `${toCall} ${toCall === 1 ? 'person needs' : 'people need'} contacting`}
          </p>
        </div>
      </div>

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
            <button type="button" onClick={() => setPhase('all')}
              className={`btn btn-sm ${phase === 'all' ? 'btn-primary' : 'btn-ghost'}`}>
              Everyone ({classified.length})
            </button>
            {PHASES.filter(p => counts(p.id) > 0).map(p => (
              <button key={p.id} type="button" onClick={() => setPhase(p.id)}
                className={`btn btn-sm ${phase === p.id ? 'btn-primary' : 'btn-ghost'}`}>
                {p.label} ({counts(p.id)})
              </button>
            ))}
          </>
        )}
      </div>

      {isLoading ? (
        <div className="card"><div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div></div>
      ) : shown.length === 0 ? (
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
                    {g.owed} waiting on you
                  </span>
                )}
              </button>
              )}

              {(singleProperty || sectionOpen(g.name)) && (
                <div style={{ padding: '0 16px 12px' }}>
                  {g.list.map(({ r, phase: ph, say }) => {
                    const meta = PHASES.find(p => p.id === ph)!
                    const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.email
                    return (
                      <div key={r.intentId} style={{
                        display: 'flex', gap: 14, alignItems: 'flex-start',
                        padding: '11px 0', borderTop: '1px solid var(--border-0)',
                      }}>
                        <div style={{ minWidth: 150 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{name}</div>
                          <div style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>
                            {r.heldUnitNumber || '—'}
                          </div>
                        </div>
                        <div style={{ minWidth: 150, fontSize: '.78rem' }}>
                          {/* Both contact routes, one click each — this is a page
                              somebody works a phone from. */}
                          {r.phone && (
                            <div><a href={`tel:${r.phone}`} style={{ color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <Phone size={12} /> {r.phone}
                            </a></div>
                          )}
                          <div><a href={`mailto:${r.email}`} style={{ color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 5, wordBreak: 'break-all' }}>
                            <Mail size={12} /> {r.email}
                          </a></div>
                        </div>
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <span style={{
                            fontSize: '.72rem', fontWeight: 700, color: meta.tone,
                            textTransform: 'uppercase', letterSpacing: '.04em',
                          }}>{meta.label}</span>
                          <div style={{ fontSize: '.85rem', color: 'var(--text-1)', marginTop: 3, lineHeight: 1.5 }}>
                            {say}
                          </div>
                        </div>
                        {/* Only where an invite is the thing that is stuck. A
                            lease waiting on a signature is not fixed by another
                            invite email. */}
                        {(ph === 'awaiting_accept' || ph === 'not_invited') && (
                          <div style={{ minWidth: 128, textAlign: 'right' }}>
                            {sentTo[r.intentId] === 'sent' ? (
                              <span style={{ fontSize: '.78rem', color: 'var(--green)', fontWeight: 600 }}>
                                ✓ Invite re-sent
                              </span>
                            ) : (
                              <button type="button" className="btn btn-primary btn-sm"
                                disabled={sentTo[r.intentId] === 'sending'}
                                onClick={() => resend.mutate(r.intentId)}
                                title={`Send ${r.email} a brand-new invite link — the old one stops working`}>
                                {sentTo[r.intentId] === 'sending' ? 'Sending…' : 'Re-send invite'}
                              </button>
                            )}
                            {sentTo[r.intentId] === 'error' && (
                              <div style={{ fontSize: '.74rem', color: 'var(--red)', marginTop: 4 }}>
                                Could not send — try the pending pool.
                              </div>
                            )}
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
    </div>
  )
}
