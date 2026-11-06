/**
 * The contractor marketplace, contractor side — 10/31.
 *
 * Nic's vision, dictated: "It's like searching a marketplace, like searching
 * eBay... you're browsing the marketplace for open jobs. You bid. They're all
 * private to the person so that people aren't just publicly underbidding other
 * people. It helps keep it fair. Contractors are on the platform for free. GAM
 * takes a cut of the finished job."
 *
 * WHY THIS LIVES IN THE BUSINESS PORTAL AND IS NOT PART OF IT.
 *
 * He drew the line on 10/31: "The business portal is for somebody operating
 * their small business. A landscaper trying to get more yards is going to post
 * his prices, run his customers and invoicing through there. That is
 * subscription based. Contractors that are looking for one-off jobs on bids,
 * that's a percentage of the cut. A cut of the job. It's two different things."
 * Asked where the contractor's screen should live, he chose a section in this
 * portal — so the same person can run their shop here AND bid on one-off work,
 * paying for each the way each is priced.
 *
 * Which is why this page's nav entry carries NO `feature`. Every other entry in
 * this portal is gated on a subscription feature flag; gating this one would
 * fold the marketplace into the subscription and break the distinction he just
 * drew. Joining the board is free, and the only charge is a cut of work finished.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT SHOW: any trace of another contractor's
 * bid. Not a number, not a count, not "you are the lowest". The server does not
 * send it, and nothing here asks. That omission is the product.
 */
import { useState, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPut } from '../lib/api'
import {
  CONTRACTOR_TRADES, CONTRACTOR_TRADE_LABEL,
  MARKETPLACE_JOB_STATUS_LABEL, MARKETPLACE_BID_STATUS_LABEL,
  marketplaceCutSplit,
} from '@gam/shared'
import {
  Hammer, Search, ShieldAlert, ShieldCheck, Send, X, Undo2, Play, MapPin,
} from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'

const fmt = (n: any) => n == null || n === ''
  ? '—'
  : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const lbl: CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' }

interface BoardJob {
  id: string
  title: string
  description: string
  trades: string[]
  requiresInsured: boolean
  requiresBonded: boolean
  propertyCity: string | null
  propertyState: string | null
  bidsCloseAt: string | null
  alreadyBid: boolean
  createdAt: string
}

type Tab = 'board' | 'my-bids' | 'my-jobs' | 'profile'

export function ContractorBidsPage() {
  const [tab, setTab] = useState<Tab>('board')

  const { data: me, isLoading: loadingMe } = useQuery<any>(
    'contractor-me', () => apiGet('/marketplace/me'), { retry: false })
  const { data: rate } = useQuery<{ percent: number }>(
    'marketplace-rate', () => apiGet('/marketplace/rate'))

  if (loadingMe) return <div className="page"><div className="card">Loading…</div></div>

  // No profile yet: the only thing to do is make one, so that is the whole page.
  if (!me) return <SetUpProfile rate={rate?.percent} />

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: 'board',   label: 'Open jobs' },
    { key: 'my-bids', label: 'My bids' },
    { key: 'my-jobs', label: 'Work I won' },
    { key: 'profile', label: 'My profile' },
  ]

  return (
    <div className="page">
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <Hammer size={22} /> Job Bids
        </h1>
        <p style={{ color: 'var(--text-3)', margin: '6px 0 0', maxWidth: '62ch' }}>
          Landlords post work here and you bid on it. Your bid is private — no other
          contractor sees your price. Free to use; GAM keeps{' '}
          {rate ? `${rate.percent}%` : '3%'} of a job once you finish it, and nothing
          on a job you don't win.
        </p>
      </div>

      <div className="tabs" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '16px 0' }}>
        {TABS.map(t => (
          <button key={t.key}
                  className={tab === t.key ? 'bp btn btn-primary' : 'btn btn-ghost'}
                  style={{ fontSize: '.85rem' }}
                  onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'board'   && <Board me={me} />}
      {tab === 'my-bids' && <MyBids />}
      {tab === 'my-jobs' && <MyJobs />}
      {tab === 'profile' && <Profile me={me} />}
    </div>
  )
}

// ── no profile yet ────────────────────────────────────────────

function SetUpProfile({ rate }: { rate?: number }) {
  return (
    <div className="page">
      <div className="card" style={{ maxWidth: 560, margin: '32px auto', textAlign: 'center' }}>
        <Hammer size={30} style={{ color: 'var(--text-3)' }} />
        <h2 style={{ marginBottom: 8 }}>Bid on one-off jobs</h2>
        <p style={{ color: 'var(--text-3)', maxWidth: '45ch', margin: '0 auto 16px' }}>
          Landlords post work — repairs, mowing, roofing, whatever they need — and you
          bid on it privately. Nobody sees anyone else's price. It costs nothing to
          join and nothing to bid; GAM keeps {rate ?? 3}% of a job once you've
          finished it.
        </p>
        <ProfileForm />
      </div>
    </div>
  )
}

function Profile({ me }: { me: any }) {
  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Your details</h3>
        <ProfileForm me={me} />
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Your paperwork</h3>
        <p style={{ fontSize: '.85rem', color: 'var(--text-3)', marginTop: 0 }}>
          Some jobs ask for a contractor who is insured or bonded. Landlords see
          whether you had it on file when you bid.
        </p>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <Standing label="Insurance" on={!!me.insuranceVerified} until={me.insuranceExpiry} />
          <Standing label="Bond"      on={!!me.bondVerified}      until={me.bondExpiry} />
        </div>
        <Credentials />
      </div>
    </div>
  )
}

function Standing({ label, on, until }: { label: string; on: boolean; until: string | null }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '.9rem' }}>
      {on ? <ShieldCheck size={16} style={{ color: 'var(--green-dim, #30a46c)' }} />
          : <ShieldAlert size={16} style={{ color: 'var(--text-3)' }} />}
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: 'var(--text-3)' }}>
        {on ? (until ? `on file to ${String(until).slice(0, 10)}` : 'on file') : 'not on file'}
      </span>
    </div>
  )
}

function ProfileForm({ me }: { me?: any }) {
  const qc = useQueryClient()
  const [name, setName] = useState(me?.name ?? '')
  const [businessName, setBusinessName] = useState(me?.businessName ?? '')
  const [phone, setPhone] = useState(me?.phone ?? '')
  const [city, setCity] = useState(me?.city ?? '')
  const [state, setState] = useState(me?.state ?? '')
  const [serviceRadiusMiles, setRadius] = useState<string>(
    me?.serviceRadiusMiles ? String(me.serviceRadiusMiles) : '')
  const [trades, setTrades] = useState<string[]>(me?.trades ?? [])

  const save = useMutation(
    () => apiPut('/marketplace/me', {
      name, businessName: businessName || null, phone: phone || null,
      city: city || null, state: state || null,
      serviceRadiusMiles: serviceRadiusMiles ? Number(serviceRadiusMiles) : null,
      trades,
    }),
    {
      onSuccess: () => { toast('Saved.'); qc.invalidateQueries('contractor-me') },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not save that.'),
    })

  const ready = name.trim().length >= 2 && trades.length > 0

  return (
    <div style={{ display: 'grid', gap: 12, textAlign: 'left' }}>
      <div>
        <label style={lbl}>Your name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Bob Kowalski" />
      </div>
      <div>
        <label style={lbl}>Business name, if you have one</label>
        {/* Optional on purpose: a one-man operation should not have to invent a
            company name to bid on a job. */}
        <input value={businessName} onChange={e => setBusinessName(e.target.value)}
               placeholder="Leave blank if it's just you" />
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
        <div>
          <label style={lbl}>Phone</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
        <div>
          <label style={lbl}>How far you'll travel</label>
          <input type="number" min="1" value={serviceRadiusMiles}
                 onChange={e => setRadius(e.target.value)} placeholder="miles" />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '2fr 1fr' }}>
        <div>
          <label style={lbl}>Town</label>
          <input value={city} onChange={e => setCity(e.target.value)} />
        </div>
        <div>
          <label style={lbl}>State</label>
          <input value={state} maxLength={2} onChange={e => setState(e.target.value.toUpperCase())} />
        </div>
      </div>
      <div>
        <label style={lbl}>What you do</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CONTRACTOR_TRADES.map(t => {
            const on = trades.includes(t)
            return (
              <button key={t} type="button"
                onClick={() => setTrades(on ? trades.filter(x => x !== t) : [...trades, t])}
                className={on ? 'bp btn btn-primary' : 'btn btn-ghost'}
                style={{ fontSize: '.8rem', padding: '4px 10px' }}>
                {CONTRACTOR_TRADE_LABEL[t]}
              </button>
            )
          })}
        </div>
      </div>
      <button className="bp btn btn-primary" disabled={!ready || save.isLoading}
              onClick={() => save.mutate()}>
        {save.isLoading ? 'Saving…' : me ? 'Save' : 'Start bidding'}
      </button>
    </div>
  )
}

function Credentials() {
  const qc = useQueryClient()
  const { data: creds = [] } = useQuery<any[]>(
    'contractor-credentials', () => apiGet('/marketplace/me/credentials'))
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState('license')
  const [number, setNumber] = useState('')
  const [expiresOn, setExpiresOn] = useState('')

  const add = useMutation(
    () => apiPost('/marketplace/me/credentials', { kind, number, expiresOn: expiresOn || undefined }),
    {
      onSuccess: () => {
        toast('Added. GAM will confirm it.')
        setAdding(false); setNumber(''); setExpiresOn('')
        qc.invalidateQueries('contractor-credentials')
      },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not add that.'),
    })

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border-1, #2a2a2a)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1, fontSize: '.9rem' }}>Licenses and certifications</strong>
        {!adding && (
          <button className="btn btn-ghost" style={{ fontSize: '.8rem' }}
                  onClick={() => setAdding(true)}>Add one</button>
        )}
      </div>
      {creds.length === 0 && !adding && (
        <p style={{ fontSize: '.85rem', color: 'var(--text-3)' }}>Nothing on file yet.</p>
      )}
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {creds.map(c => (
          <div key={c.id} style={{ display: 'flex', gap: 8, fontSize: '.85rem', alignItems: 'baseline' }}>
            <span style={{ flex: 1 }}>
              {c.number || '—'}
              {c.state ? ` · ${c.state}` : ''}
            </span>
            <span style={{ color: 'var(--text-3)' }}>
              {c.verifiedAt ? 'confirmed' : 'waiting on GAM'}
            </span>
          </div>
        ))}
      </div>
      {adding && (
        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <div>
            <label style={lbl}>What is it</label>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="license">Trade license</option>
              <option value="certification">Certification</option>
              <option value="registration">Registration</option>
              <option value="other">Other paperwork</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Number on it</label>
            <input value={number} onChange={e => setNumber(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Expires</label>
            <input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="bp btn btn-primary" disabled={add.isLoading}
                    onClick={() => add.mutate()}>Add</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── the board ─────────────────────────────────────────────────

function Board({ me }: { me: any }) {
  const [search, setSearch] = useState('')
  const [trade, setTrade] = useState('')
  const [bidding, setBidding] = useState<BoardJob | null>(null)

  const { data, isLoading } = useQuery<{ jobs: BoardJob[]; me: { insured: boolean; bonded: boolean } }>(
    ['marketplace-board', trade, search],
    () => apiGet(`/marketplace/board?${new URLSearchParams({
      ...(trade ? { trades: trade } : {}),
      ...(search ? { search } : {}),
    })}`))

  const jobs = data?.jobs ?? []
  const standing = data?.me ?? { insured: false, bonded: false }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 0 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search open jobs" style={{ paddingLeft: 32, width: '100%' }} />
        </div>
        <select value={trade} onChange={e => setTrade(e.target.value)} style={{ flex: '0 1 200px' }}>
          <option value="">Every kind of work</option>
          {(me.trades ?? CONTRACTOR_TRADES).map((t: string) => (
            <option key={t} value={t}>{CONTRACTOR_TRADE_LABEL[t as never] ?? t}</option>
          ))}
        </select>
      </div>

      {isLoading && <div className="card">Loading…</div>}

      {!isLoading && jobs.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 28 }}>
          <Hammer size={26} style={{ color: 'var(--text-3)' }} />
          <h3 style={{ marginBottom: 4 }}>No open jobs right now</h3>
          <p style={{ color: 'var(--text-3)', margin: 0 }}>
            {search || trade
              ? 'Nothing matches that. Try clearing the filter.'
              : 'Check back — landlords post work as it comes up.'}
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}>
        {jobs.map(j => {
          const gapInsured = j.requiresInsured && !standing.insured
          const gapBonded = j.requiresBonded && !standing.bonded
          return (
            <div key={j.id} className="card" style={{ display: 'grid', gap: 8 }}>
              <strong>{j.title}</strong>
              {(j.propertyCity || j.propertyState) && (
                <div style={{ fontSize: '.8rem', color: 'var(--text-3)', display: 'flex', gap: 4, alignItems: 'center' }}>
                  <MapPin size={12} /> {[j.propertyCity, j.propertyState].filter(Boolean).join(', ')}
                  {/* The town is given so a bid can price the drive and the
                      delivery. The exact address arrives when the job is
                      yours — said here so it does not look like missing data. */}
                  <span style={{ opacity: .7 }}>· address when you win it</span>
                </div>
              )}
              <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
                {j.description.length > 160 ? `${j.description.slice(0, 160)}…` : j.description}
              </div>
              <div style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                {j.trades.map(t => CONTRACTOR_TRADE_LABEL[t as never] ?? t).join(', ')}
              </div>

              {(gapInsured || gapBonded) && (
                <div style={{ display: 'flex', gap: 6, fontSize: '.78rem', alignItems: 'flex-start',
                              color: 'var(--text-3)' }}>
                  <ShieldAlert size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    They asked for someone{gapInsured && ' insured'}
                    {gapInsured && gapBonded && ' and'}{gapBonded && ' bonded'}. You can
                    still bid — add your paperwork to your profile and it'll show on
                    future bids.
                  </span>
                </div>
              )}

              {j.alreadyBid
                ? <div style={{ fontSize: '.85rem', color: 'var(--gold, #c9a227)' }}>Your bid is in.</div>
                : <button className="bp btn btn-primary" style={{ fontSize: '.85rem' }}
                          onClick={() => setBidding(j)}>
                    <Send size={14} /> Bid on this
                  </button>}
            </div>
          )
        })}
      </div>

      {bidding && <PlaceBid job={bidding} onClose={() => setBidding(null)} />}
    </>
  )
}

function PlaceBid({ job, onClose }: { job: BoardJob; onClose: () => void }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [days, setDays] = useState('')
  const [notes, setNotes] = useState('')

  const { data: rate } = useQuery<{ percent: number }>(
    'marketplace-rate', () => apiGet('/marketplace/rate'))
  const pct = rate?.percent ?? 3
  const n = Number(amount)
  // The same arithmetic the server books with and the landlord's screen shows.
  const split = marketplaceCutSplit(n, pct)
  const cut = n > 0 ? split.cut : 0

  const place = useMutation(
    () => apiPost(`/marketplace/board/${job.id}/bid`, {
      amount: Number(amount),
      daysToComplete: days ? Number(days) : null,
      notes: notes || null,
    }),
    {
      onSuccess: () => {
        toast('Bid sent. Only this landlord can see it.')
        qc.invalidateQueries('marketplace-board')
        qc.invalidateQueries('marketplace-my-bids')
        onClose()
      },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not send that bid.'),
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>Bid on this job</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <p style={{ color: 'var(--text-2)', marginTop: 0 }}><strong>{job.title}</strong></p>

        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label style={lbl}>Your price for the whole job</label>
            <input type="number" step="0.01" min="0" value={amount}
                   onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label style={lbl}>How many days you'd need</label>
            <input type="number" min="1" value={days} onChange={e => setDays(e.target.value)}
                   placeholder="Optional" />
          </div>
          <div>
            <label style={lbl}>Anything they should know</label>
            <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
                      placeholder="Optional — when you could start, what's included" />
          </div>

          {/* What they'd actually take home, stated before they send it. */}
          {cut > 0 && (
            <div style={{ fontSize: '.85rem', background: 'var(--bg-2, #1a1a1a)', padding: 10, borderRadius: 6 }}>
              If you win it and finish it: you keep <strong>{fmt(split.contractorNet)}</strong>, GAM's
              {' '}{pct}% is <strong>{fmt(cut)}</strong>. Nothing is charged unless you
              finish the work.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="bp btn btn-primary"
                  disabled={place.isLoading || !(Number(amount) >= 0 && amount !== '')}
                  onClick={() => place.mutate()}>
            {place.isLoading ? 'Sending…' : 'Send my bid'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── my bids ───────────────────────────────────────────────────

function MyBids() {
  const qc = useQueryClient()
  const { data: bids = [], isLoading } = useQuery<any[]>(
    'marketplace-my-bids', () => apiGet('/marketplace/my-bids'))

  const withdraw = useMutation(
    (id: string) => apiPost(`/marketplace/my-bids/${id}/withdraw`, {}),
    {
      onSuccess: () => { toast('Withdrawn.'); qc.invalidateQueries('marketplace-my-bids') },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not withdraw that.'),
    })

  if (isLoading) return <div className="card">Loading…</div>
  if (bids.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: 28 }}>
      <p style={{ color: 'var(--text-3)', margin: 0 }}>You haven't bid on anything yet.</p>
    </div>
  )

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {bids.map(b => (
        <div key={b.id} className="card" style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '1.05rem' }}>{fmt(b.amount)}</strong>
            <span style={{ flex: 1 }}>{b.title}</span>
            <span className="badge">
              {MARKETPLACE_BID_STATUS_LABEL[b.status as never] ?? b.status}
            </span>
          </div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
            {[b.propertyCity, b.propertyState].filter(Boolean).join(', ')}
            {' · '}{MARKETPLACE_JOB_STATUS_LABEL[b.jobStatus as never] ?? b.jobStatus}
          </div>
          {b.status === 'submitted' && (
            <div>
              <button className="btn btn-ghost" style={{ fontSize: '.8rem' }}
                      disabled={withdraw.isLoading}
                      onClick={async () => {
                        const ok = await appConfirm(
                          'Your price comes off this landlord\'s list. You can bid again with a different number.',
                          { title: 'Withdraw this bid?', confirmLabel: 'Withdraw it' })
                        if (ok) withdraw.mutate(b.id)
                      }}>
                <Undo2 size={13} /> Withdraw
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── work I won ────────────────────────────────────────────────

function MyJobs() {
  const qc = useQueryClient()
  const { data: jobs = [], isLoading } = useQuery<any[]>(
    'marketplace-my-jobs', () => apiGet('/marketplace/my-jobs'))

  const start = useMutation(
    (id: string) => apiPost(`/marketplace/my-jobs/${id}/start`, {}),
    {
      onSuccess: () => { toast('Marked as started.'); qc.invalidateQueries('marketplace-my-jobs') },
      onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not mark that started.'),
    })

  if (isLoading) return <div className="card">Loading…</div>
  if (jobs.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: 28 }}>
      <p style={{ color: 'var(--text-3)', margin: 0 }}>Nothing awarded to you yet.</p>
    </div>
  )

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {jobs.map(j => (
        <div key={j.id} className="card" style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ flex: 1 }}>{j.title}</strong>
            <span className="badge">{MARKETPLACE_JOB_STATUS_LABEL[j.status as never] ?? j.status}</span>
          </div>
          <div style={{ fontSize: '.85rem' }}>
            {j.status === 'completed'
              ? <>Finished at <strong>{fmt(j.finalAmount)}</strong></>
              : <>Awarded at <strong>{fmt(j.awardedAmount)}</strong></>}
          </div>
          {/* Won work carries the real address — they have to turn up. */}
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
            {j.propertyName && <div style={{ color: 'var(--text-2)' }}>{j.propertyName}</div>}
            {j.propertyStreet1 && <div>{j.propertyStreet1}{j.propertyStreet2 ? `, ${j.propertyStreet2}` : ''}</div>}
            <div>
              {[j.propertyCity, j.propertyState].filter(Boolean).join(', ')}
              {j.propertyZip ? ` ${j.propertyZip}` : ''}
            </div>
            {j.unitNumber && <div>Space {j.unitNumber}</div>}
          </div>
          {j.status === 'awarded' && (
            <div>
              <button className="bp btn btn-primary" style={{ fontSize: '.8rem' }}
                      disabled={start.isLoading}
                      onClick={() => start.mutate(j.id)}>
                <Play size={13} /> I've started
              </button>
            </div>
          )}
          {j.status === 'in_progress' && (
            <p style={{ fontSize: '.8rem', color: 'var(--text-3)', margin: 0 }}>
              The landlord settles it when the work is done.
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
