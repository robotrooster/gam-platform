/**
 * The contractor marketplace, landlord side — 10/31.
 *
 * Nic's vision: put a job out, contractors bid on it privately, pick one, and
 * GAM takes 3% of the finished job. Nothing is charged for posting, and nothing
 * is charged for a job nobody finishes.
 *
 * The bids panel is the one place bid numbers appear. Contractors never see
 * each other's — that is the whole reason this exists instead of Angie's List
 * ("they're all private to the person so that people aren't just publicly
 * underbidding other people").
 *
 * The insured/bonded requirement is set PER JOB (his call, asked directly on
 * 10/31), so it sits on the post form and nothing is inherited from the
 * property. When a bid comes in from someone who does not meet it, the bid is
 * shown with the gap named in red — warn loudly, let them award it anyway. GAM
 * does not referee how a landlord runs their property.
 */
import { useState, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import {
  CONTRACTOR_TRADES, CONTRACTOR_TRADE_LABEL,
  MARKETPLACE_JOB_STATUS_LABEL, MARKETPLACE_BID_STATUS_LABEL,
  marketplaceCutSplit,
  type MarketplaceJobStatus,
} from '@gam/shared'
import {
  Hammer, Plus, X, ShieldCheck, ShieldAlert, Check, CircleDollarSign, Users,
} from 'lucide-react'
import { toast, appConfirm } from '../components/dialogs'
import { usePerms } from '../lib/permissions'

const fmt = (n: any) => n == null || n === ''
  ? '—'
  : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const lbl: CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' }

interface Job {
  id: string
  propertyId: string
  propertyName: string | null
  title: string
  description: string
  trades: string[]
  requiresInsured: boolean
  requiresBonded: boolean
  status: MarketplaceJobStatus
  bidsCloseAt: string | null
  awardedBidId: string | null
  awardedAmount: string | null
  finalAmount: string | null
  completedAt: string | null
  cutPercentSnapshot: string | null
  createdAt: string
  bidCount?: string
}

interface Bid {
  id: string
  amount: string
  notes: string | null
  daysToComplete: number | null
  insuredAtBid: boolean
  bondedAtBid: boolean
  status: string
  createdAt: string
  contractorName: string
  contractorBusinessName: string | null
  contractorRating: string | null
  contractorCompletedJobs: number | null
}

export function MarketplacePage() {
  const qc = useQueryClient()
  const perms = usePerms()
  const [posting, setPosting] = useState(false)
  const [openJobId, setOpenJobId] = useState<string | null>(null)

  const { data: jobs = [], isLoading } = useQuery<Job[]>(
    'marketplace-jobs', () => apiGet('/marketplace/jobs'))
  const { data: rate } = useQuery<{ percent: number }>(
    'marketplace-rate', () => apiGet('/marketplace/rate'))

  const taking = jobs.filter(j => j.status === 'open')
  const working = jobs.filter(j => j.status === 'awarded' || j.status === 'in_progress')
  const done = jobs.filter(j => j.status === 'completed' || j.status === 'cancelled')

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <Hammer size={22} /> Contractor Marketplace
        </h1>
        <div style={{ flex: 1 }} />
        {perms.can('marketplace.post') && (
          <button className="btn btn-primary" onClick={() => setPosting(true)}>
            <Plus size={16} /> Post a job
          </button>
        )}
      </div>

      <p style={{ color: 'var(--text-3)', maxWidth: '65ch', marginTop: 0 }}>
        Put a job out and contractors bid on it. Each bid is private — no contractor
        sees another's price. Posting is free; GAM keeps {rate ? `${rate.percent}%` : '3%'} of a
        job once it is finished, and nothing at all if it never is.
      </p>

      {isLoading && <div className="card">Loading…</div>}

      {!isLoading && jobs.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <Hammer size={30} style={{ color: 'var(--text-3)' }} />
          <h3 style={{ marginBottom: 6 }}>No jobs posted yet</h3>
          <p style={{ color: 'var(--text-3)', margin: '0 auto 16px', maxWidth: '45ch' }}>
            Post the first one and contractors in the area can bid on it.
          </p>
          {perms.can('marketplace.post') && (
            <button className="btn btn-primary" onClick={() => setPosting(true)}>
              <Plus size={16} /> Post a job
            </button>
          )}
        </div>
      )}

      <JobGroup title="Taking bids"  jobs={taking}  onOpen={setOpenJobId} />
      <JobGroup title="Work awarded" jobs={working} onOpen={setOpenJobId} />
      <JobGroup title="Finished"     jobs={done}    onOpen={setOpenJobId} />

      {posting && (
        <PostJob onClose={() => setPosting(false)} onPosted={() => {
          setPosting(false)
          qc.invalidateQueries('marketplace-jobs')
        }} />
      )}
      {openJobId && (
        <JobDetail
          jobId={openJobId}
          job={jobs.find(j => j.id === openJobId)!}
          onClose={() => setOpenJobId(null)}
        />
      )}
    </div>
  )
}

function JobGroup({ title, jobs, onOpen }: {
  title: string; jobs: Job[]; onOpen: (id: string) => void
}) {
  if (jobs.length === 0) return null
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: '1rem', color: 'var(--text-2)', marginBottom: 10 }}>
        {title} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({jobs.length})</span>
      </h2>
      {/* Cards at every width, so the phone needs no separate layout and
          nothing has to be scrolled sideways to see whether bids came in. */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {jobs.map(j => <JobCard key={j.id} job={j} onOpen={onOpen} />)}
      </div>
    </section>
  )
}

function JobCard({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const bids = Number(job.bidCount ?? 0)
  return (
    <button
      onClick={() => onOpen(job.id)}
      className="card"
      style={{ textAlign: 'left', cursor: 'pointer', display: 'grid', gap: 8, width: '100%' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <strong style={{ flex: 1 }}>{job.title}</strong>
        <span className="badge">{MARKETPLACE_JOB_STATUS_LABEL[job.status]}</span>
      </div>
      <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
        {job.propertyName ?? 'Property'}
        {job.trades.length > 0 && ' · '}
        {job.trades.map(t => CONTRACTOR_TRADE_LABEL[t as never] ?? t).join(', ')}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: '.8rem' }}>
        {job.status === 'open' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: bids > 0 ? 'var(--gold)' : 'var(--text-3)' }}>
            <Users size={13} /> {bids === 0 ? 'No bids yet' : bids === 1 ? '1 bid' : `${bids} bids`}
          </span>
        )}
        {job.awardedAmount && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <CircleDollarSign size={13} /> {fmt(job.finalAmount ?? job.awardedAmount)}
          </span>
        )}
        {(job.requiresInsured || job.requiresBonded) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-3)' }}>
            <ShieldCheck size={13} />
            {job.requiresInsured && job.requiresBonded ? 'Insured + bonded'
              : job.requiresInsured ? 'Insured' : 'Bonded'}
          </span>
        )}
      </div>
    </button>
  )
}

// ── posting ───────────────────────────────────────────────────

function PostJob({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propertyId, setPropertyId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [trades, setTrades] = useState<string[]>([])
  const [requiresInsured, setRequiresInsured] = useState(false)
  const [requiresBonded, setRequiresBonded] = useState(false)

  const post = useMutation(
    () => apiPost('/marketplace/jobs', {
      propertyId, title, description, trades, requiresInsured, requiresBonded,
    }),
    {
      onSuccess: () => { toast('Job posted. Contractors can bid on it now.'); onPosted() },
      onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Could not post the job.'),
    })

  const ready = propertyId && title.trim().length >= 3 && description.trim().length >= 10 && trades.length > 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Post a job for bids</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <label style={lbl}>Which property</label>
            {/* No default property: picking the wrong one puts the job at the
                wrong park, and there is no "all properties" for a job that
                happens at one place. */}
            <select value={propertyId} onChange={e => setPropertyId(e.target.value)}>
              <option value="">Choose a property…</option>
              {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label style={lbl}>What needs doing</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
                   placeholder="Replace the water heater in space 12" />
          </div>

          <div>
            <label style={lbl}>The details a contractor needs to price it</label>
            <textarea rows={4} value={description} onChange={e => setDescription(e.target.value)}
                      placeholder="The 40-gallon unit is leaking from the base. Electric, in the utility closet off the back porch." />
          </div>

          <div>
            <label style={lbl}>Kind of work</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {CONTRACTOR_TRADES.map(t => {
                const on = trades.includes(t)
                return (
                  <button key={t} type="button"
                    onClick={() => setTrades(on ? trades.filter(x => x !== t) : [...trades, t])}
                    className={on ? 'btn btn-primary' : 'btn btn-ghost'}
                    style={{ fontSize: '.8rem', padding: '4px 10px' }}>
                    {CONTRACTOR_TRADE_LABEL[t]}
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12 }}>
            <label style={lbl}>Requirements for this job</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <input type="checkbox" checked={requiresInsured}
                     onChange={e => setRequiresInsured(e.target.checked)} />
              Contractor must be insured
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={requiresBonded}
                     onChange={e => setRequiresBonded(e.target.checked)} />
              Contractor must be bonded
            </label>
            <p style={{ fontSize: '.75rem', color: 'var(--text-3)', margin: '8px 0 0' }}>
              Set for this job only — nothing carries over from the property, so a
              mowing job and a gas line are judged separately. Contractors who
              don't meet it can still bid; you'll see the gap on their bid.
            </p>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || post.isLoading}
                  onClick={() => post.mutate()}>
            {post.isLoading ? 'Posting…' : 'Post for bids'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── one job, and the bids on it ───────────────────────────────

function JobDetail({ jobId, job, onClose }: { jobId: string; job: Job; onClose: () => void }) {
  const qc = useQueryClient()
  const perms = usePerms()
  const [settling, setSettling] = useState(false)
  const [finalAmount, setFinalAmount] = useState('')

  const { data: bids = [], isLoading } = useQuery<Bid[]>(
    ['marketplace-bids', jobId], () => apiGet(`/marketplace/jobs/${jobId}/bids`))
  const { data: rate } = useQuery<{ percent: number }>(
    'marketplace-rate', () => apiGet('/marketplace/rate'))

  const refresh = () => {
    qc.invalidateQueries('marketplace-jobs')
    qc.invalidateQueries(['marketplace-bids', jobId])
  }

  const award = useMutation(
    (bidId: string) => apiPost(`/marketplace/jobs/${jobId}/award`, { bidId }),
    {
      onSuccess: () => { toast('Awarded. The other contractors have been told.'); refresh() },
      onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Could not award the job.'),
    })

  const complete = useMutation(
    (amount: number | null) => apiPost(`/marketplace/jobs/${jobId}/complete`,
      amount == null ? {} : { finalAmount: amount }),
    {
      onSuccess: (r: any) => {
        const d = r?.data
        toast(d
          ? `Settled at ${fmt(d.job?.finalAmount)}. GAM's share is ${fmt(d.cutAmount)}; the contractor gets ${fmt(d.contractorNet)}.`
          : 'Job settled.')
        setSettling(false); refresh()
      },
      onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Could not settle the job.'),
    })

  const cancel = useMutation(
    () => apiPost(`/marketplace/jobs/${jobId}/cancel`, {}),
    {
      onSuccess: () => { toast('Job cancelled. Anyone who bid has been told.'); refresh(); onClose() },
      onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Could not cancel the job.'),
    })

  const awardedAmount = Number(job.awardedAmount ?? 0)
  const settleFigure = finalAmount.trim() === '' ? awardedAmount : Number(finalAmount)
  const pct = Number(job.cutPercentSnapshot ?? rate?.percent ?? 3)
  // The same arithmetic the server books with, so the figure on screen and the
  // figure written down cannot disagree.
  const preview = marketplaceCutSplit(settleFigure, pct)
  const previewCut = preview.cut

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ marginBottom: 2 }}>{job.title}</h2>
            <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
              {job.propertyName} · {MARKETPLACE_JOB_STATUS_LABEL[job.status]}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{job.description}</p>

        {(job.requiresInsured || job.requiresBonded) && (
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <ShieldCheck size={14} />
            This job asks for a contractor who is
            {job.requiresInsured && ' insured'}
            {job.requiresInsured && job.requiresBonded && ' and'}
            {job.requiresBonded && ' bonded'}.
          </div>
        )}

        {/* Settling a finished job */}
        {(job.status === 'awarded' || job.status === 'in_progress') && perms.can('marketplace.award') && (
          <div className="card" style={{ marginTop: 14 }}>
            <strong>The work is done</strong>
            {!settling && (
              <>
                <p style={{ fontSize: '.85rem', color: 'var(--text-3)', margin: '6px 0 10px' }}>
                  Awarded at {fmt(job.awardedAmount)}. Settle it when the job is finished —
                  that is when GAM's {pct}% applies.
                </p>
                <button className="btn btn-primary" onClick={() => setSettling(true)}>
                  Settle this job
                </button>
              </>
            )}
            {settling && (
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                <div>
                  <label style={lbl}>What it actually finished at</label>
                  <input type="number" step="0.01" min="0"
                         value={finalAmount}
                         placeholder={String(awardedAmount.toFixed(2))}
                         onChange={e => setFinalAmount(e.target.value)} />
                  <p style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: 4 }}>
                    Leave it as it is to settle at the awarded price. Change it if the
                    scope moved.
                  </p>
                </div>
                {/* Confirm the money IN THE PAGE before anything is committed —
                    one click must never start a money movement. */}
                <div style={{ fontSize: '.85rem', background: 'var(--bg-2)', padding: 10, borderRadius: 6 }}>
                  Settling at <strong>{fmt(settleFigure)}</strong>: the contractor gets{' '}
                  <strong>{fmt(preview.contractorNet)}</strong> and GAM's {pct}% share is{' '}
                  <strong>{fmt(previewCut)}</strong>.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={() => { setSettling(false); setFinalAmount('') }}>
                    Not yet
                  </button>
                  <button className="btn btn-primary" disabled={complete.isLoading || !Number.isFinite(settleFigure)}
                          onClick={() => complete.mutate(finalAmount.trim() === '' ? null : Number(finalAmount))}>
                    {complete.isLoading ? 'Settling…' : `Settle at ${fmt(settleFigure)}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {job.status === 'completed' && (
          <div className="card" style={{ marginTop: 14 }}>
            <strong>Finished at {fmt(job.finalAmount)}</strong>
            <div style={{ fontSize: '.85rem', color: 'var(--text-3)', marginTop: 4 }}>
              GAM's {Number(job.cutPercentSnapshot)}% share came off the contractor's payout.
              You paid the price you agreed.
            </div>
          </div>
        )}

        <h3 style={{ fontSize: '.95rem', marginTop: 20, marginBottom: 8 }}>
          Bids {bids.length > 0 && <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({bids.length})</span>}
        </h3>
        <p style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: 0 }}>
          Only you can see these. No contractor is shown another's price.
        </p>

        {isLoading && <div>Loading bids…</div>}
        {!isLoading && bids.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: '12px 0' }}>
            No bids yet. Contractors in the area see this job on their board.
          </div>
        )}

        <div style={{ display: 'grid', gap: 8 }}>
          {bids.map(b => {
            const gapInsured = job.requiresInsured && !b.insuredAtBid
            const gapBonded = job.requiresBonded && !b.bondedAtBid
            const gap = gapInsured || gapBonded
            return (
              <div key={b.id} className="card" style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '1.05rem' }}>{fmt(b.amount)}</strong>
                  <span style={{ flex: 1, color: 'var(--text-2)' }}>
                    {b.contractorBusinessName || b.contractorName}
                  </span>
                  {b.status !== 'submitted' && (
                    <span className="badge">{MARKETPLACE_BID_STATUS_LABEL[b.status as never] ?? b.status}</span>
                  )}
                </div>
                <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
                  {b.contractorCompletedJobs ? `${b.contractorCompletedJobs} finished through GAM` : 'No finished jobs through GAM yet'}
                  {b.daysToComplete ? ` · about ${b.daysToComplete} day${b.daysToComplete === 1 ? '' : 's'}` : ''}
                </div>
                {b.notes && (
                  <div style={{ fontSize: '.85rem', whiteSpace: 'pre-wrap' }}>{b.notes}</div>
                )}
                {gap && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: '.8rem',
                                color: 'var(--red-dim, #e5484d)' }}>
                    <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>
                      You asked for someone{gapInsured && ' insured'}
                      {gapInsured && gapBonded && ' and'}{gapBonded && ' bonded'}, and
                      this contractor had {gapInsured && gapBonded ? 'neither' : 'no proof of that'} on
                      file when they bid. You can still award it — it's your property.
                    </span>
                  </div>
                )}
                {job.status === 'open' && b.status === 'submitted' && perms.can('marketplace.award') && (
                  <div>
                    <button className="btn btn-primary" style={{ fontSize: '.85rem' }}
                            disabled={award.isLoading}
                            onClick={async () => {
                              const who = b.contractorBusinessName || b.contractorName
                              const ok = await appConfirm(
                                gap
                                  ? `${who} did not have the insurance or bond you asked for on file when they bid. Awarding it anyway is your call. Everyone else who bid will be told they were not chosen.`
                                  : `${who} will be told they won. Everyone else who bid will be told they were not chosen. Nothing is charged until the work is finished.`,
                                { title: `Award this job for ${fmt(b.amount)}?`, confirmLabel: 'Award the job' })
                              if (ok) award.mutate(b.id)
                            }}>
                      <Check size={14} /> Award at {fmt(b.amount)}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {job.status === 'open' && perms.can('marketplace.post') && (
          <div className="modal-foot">
            <button className="btn btn-ghost"
                    onClick={async () => {
                      const ok = await appConfirm(
                        bids.length > 0
                          ? `${bids.length === 1 ? 'The contractor who bid' : `All ${bids.length} contractors who bid`} will be told the work is off.`
                          : 'Nobody has bid on it yet.',
                        { title: 'Cancel this job?', confirmLabel: 'Cancel the job', danger: true })
                      if (ok) cancel.mutate()
                    }}>
              Cancel this job
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
