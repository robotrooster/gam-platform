/**
 * 10/20 (Nic) — "HEY, THIS LOOKS LIKE THE SAME PERSON."
 *
 *   "for merging two people, bring it up to the landlord... They have the same
 *    name. Same email, or maybe the email's different, but the phone number's
 *    the same. Or maybe the phone number is off by like 1. Maybe it's a typo...
 *    But have it be always have the landlord check that the customer is the
 *    same."
 *
 * One question per card, both people side by side, and the reasons GAM is
 * asking spelled out underneath. Two answers and no third: SAME PERSON, which
 * says which of the two stays, or DIFFERENT PEOPLE, which is final — the pair
 * never comes back.
 *
 * NOTHING ON THIS SCREEN EMAILS ANYBODY, and the screen says so, because the
 * people in these pairs are mid-migration guests who have already been told
 * they have a reservation.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { Users, UserCheck, UsersRound } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { appConfirm, toast } from '../components/dialogs'
import {
  DUPLICATE_CONFIDENCE_LABEL, PERSON_SIDE_KIND_LABEL,
  type DuplicateConfidence, type PersonSideKind,
} from '@gam/shared'

type Side = {
  key: string
  kind: PersonSideKind
  name: string
  email: string | null
  phone: string | null
  reservations: number
  leases: number
  signedDocuments: number
  firstSeenAt: string | null
}

type Proposal = {
  id: string
  confidence: DuplicateConfidence
  score: number
  reasons: string[]
  a: Side | null
  b: Side | null
}

/** How sure GAM is, in a color the eye can sort by. */
const CONFIDENCE_TONE: Record<DuplicateConfidence, string> = {
  strong: 'badge-amber',
  likely: 'badge-blue',
  possible: 'badge-muted',
}

const asDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

/**
 * What this side of the pair actually has, so the landlord is choosing with the
 * facts in front of them rather than off a name. A side holding a lease or a
 * signature is the one that has to survive, and the card says why.
 */
function whatTheyHave(s: Side): string {
  const bits: string[] = []
  if (s.leases) bits.push(s.leases === 1 ? '1 lease' : `${s.leases} leases`)
  if (s.signedDocuments) bits.push(s.signedDocuments === 1 ? '1 signed document' : `${s.signedDocuments} signed documents`)
  if (s.reservations) bits.push(s.reservations === 1 ? '1 reservation' : `${s.reservations} reservations`)
  return bits.length ? bits.join(' · ') : 'Nothing on the books yet'
}

export const holdsTenancy = (s: Side | null): boolean =>
  !!s && s.kind === 'account' && (s.leases > 0 || s.signedDocuments > 0)

/**
 * Who the card suggests keeping. Never a guess the landlord cannot see: the
 * side holding the lease must survive (GAM joins two people by moving the
 * sign-in address, never the lease), then the side with an account, then the
 * side with an email address — which for two reservations is the only thing
 * that can join them at all.
 */
export function suggestedKeeper(a: Side | null, b: Side | null): 'a' | 'b' {
  if (holdsTenancy(a) !== holdsTenancy(b)) return holdsTenancy(a) ? 'a' : 'b'
  if ((a?.kind === 'account') !== (b?.kind === 'account')) return a?.kind === 'account' ? 'a' : 'b'
  if (!!a?.email !== !!b?.email) return a?.email ? 'a' : 'b'
  return 'a'
}

function PersonCard({ s, chosen, onChoose }: { s: Side; chosen: boolean; onChoose: () => void }) {
  return (
    <div
      onClick={onChoose}
      style={{
        border: `1px solid ${chosen ? 'var(--gold)' : 'var(--border-1)'}`,
        background: chosen ? 'var(--gold-bg)' : 'var(--bg-3)',
        borderRadius: 8, padding: 12, cursor: 'pointer', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <input type="radio" checked={chosen} onChange={onChoose} aria-label={`Keep ${s.name}`} />
        <span style={{ fontWeight: 600, color: 'var(--text-0)', overflowWrap: 'anywhere' }}>{s.name}</span>
      </div>
      <div className="badge badge-muted" style={{ marginBottom: 8 }}>{PERSON_SIDE_KIND_LABEL[s.kind]}</div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-2)', overflowWrap: 'anywhere' }}>
        {s.email || <span style={{ color: 'var(--text-3)' }}>No email address</span>}
      </div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
        {s.phone || <span style={{ color: 'var(--text-3)' }}>No phone number</span>}
      </div>
      <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 8 }}>{whatTheyHave(s)}</div>
      {asDay(s.firstSeenAt) && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>In your book since {asDay(s.firstSeenAt)}</div>
      )}
    </div>
  )
}

function ProposalCard({ p, onAnswered }: { p: Proposal; onAnswered: () => void }) {
  const [keeperSide, setKeeperSide] = useState<'a' | 'b'>(() => suggestedKeeper(p.a, p.b))
  const [useFoldedAddress, setUseFoldedAddress] = useState(false)
  const keeper = keeperSide === 'a' ? p.a : p.b
  const folded = keeperSide === 'a' ? p.b : p.a
  const bothAccounts = p.a?.kind === 'account' && p.b?.kind === 'account'

  const same = useMutation(
    () => apiPost(`/duplicate-people/${p.id}/same-person`, {
      keeperSide,
      signInAddress: bothAccounts && useFoldedAddress ? 'folded' : 'keeper',
    }),
    {
      onSuccess: (r: any) => { toast(r?.message || 'Joined — one person.'); onAnswered() },
      onError: (e: any) => toast.error(e?.message || 'Could not join these two.'),
    })

  const different = useMutation(
    () => apiPost(`/duplicate-people/${p.id}/not-duplicate`),
    {
      onSuccess: (r: any) => { toast(r?.message || 'Noted — two different people.'); onAnswered() },
      onError: (e: any) => toast.error(e?.message || 'Could not save that.'),
    })

  const busy = same.isLoading || different.isLoading

  async function confirmSame() {
    if (!keeper || !folded) return
    const ok = await appConfirm(
      `${keeper.name} stays, and ${folded.name} is folded into them. `
      + (folded.kind === 'account'
        // 10/20: this used to promise the folded sign-in would be retired.
        // GAM only retires one when this account's book holds everything that
        // sign-in has — a sign-in is one person's for the whole platform —
        // so the promise belongs to the result, not to the question.
        ? 'Both sign-ins are kept, and their leases and signatures stay where they are. GAM will tell you exactly what happened to each one. '
        : 'Every reservation stays on the board exactly as it was booked. ')
      + 'Nothing is deleted and nobody is emailed.',
      { title: 'Same person?', confirmLabel: 'Yes — same person' })
    if (!ok) return
    same.mutate()
  }

  if (!p.a || !p.b) return null

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span className={`badge ${CONFIDENCE_TONE[p.confidence]}`}>
          {DUPLICATE_CONFIDENCE_LABEL[p.confidence]}
        </span>
        {p.reasons.map(r => (
          <span key={r} className="badge badge-muted">{r}</span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <PersonCard s={p.a} chosen={keeperSide === 'a'} onChoose={() => setKeeperSide('a')} />
        <PersonCard s={p.b} chosen={keeperSide === 'b'} onChoose={() => setKeeperSide('b')} />
      </div>

      <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginTop: 10 }}>
        The one you pick is the one that stays. {holdsTenancy(p.a) || holdsTenancy(p.b)
          ? 'The side holding the lease has to be the one that stays — GAM joins two people by moving the sign-in address, never the lease.'
          : 'Both records are kept either way; nothing is deleted.'}
      </div>

      {bothAccounts && folded?.email && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: '.82rem', color: 'var(--text-2)' }}>
          <input type="checkbox" checked={useFoldedAddress} onChange={e => setUseFoldedAddress(e.target.checked)} />
          <span>Move the sign-in address <strong>{folded.email}</strong> onto {keeper?.name}, instead of {keeper?.email || 'the current address'}.</span>
        </label>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy} onClick={confirmSame}>
          <UserCheck size={14} /> Same person — keep {keeper?.name}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => different.mutate()}>
          Different people
        </button>
      </div>
    </div>
  )
}

export default function DuplicatePeoplePage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery('duplicate-people', () => apiGet('/duplicate-people'))
  const proposals: Proposal[] = useMemo(() => (data as any)?.proposals ?? [], [data])
  const decided: any[] = (data as any)?.decided ?? []

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Possible Duplicates</h1>
          <p className="page-subtitle">
            The same person, entered twice — GAM asks, you decide. Nobody is emailed either way.
          </p>
        </div>
      </div>

      {isLoading && <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Looking…</div>}

      {!!error && (
        <div className="card" style={{ padding: 16, color: 'var(--red)' }}>
          {(error as any)?.message || 'Could not look for duplicates just now.'}
        </div>
      )}

      {!isLoading && !error && !proposals.length && (
        <div className="card empty-state" style={{ padding: 40 }}>
          <UsersRound size={40} />
          <h3>Nobody looks doubled up</h3>
          <p>
            GAM checks every name in your book against every other one — same name and email, same name and
            phone, or a phone off by a digit. Nothing matched. Worth another look after you bring in a schedule
            or type in a batch of reservations.
          </p>
        </div>
      )}

      {proposals.map(p => (
        <ProposalCard key={p.id} p={p} onAnswered={() => qc.invalidateQueries('duplicate-people')} />
      ))}

      {decided.length > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 8 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Users size={15} /> Already answered
          </div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)', margin: '4px 0 10px' }}>
            Your earlier answers. GAM does not ask about these pairs again.
          </div>
          {decided.map((d: any) => (
            <div key={d.id} style={{ borderTop: '1px solid var(--border-1)', padding: '8px 0', fontSize: '.82rem' }}>
              <span style={{ color: 'var(--text-1)' }}>
                {d.snapshot?.a?.name ?? '—'} &nbsp;·&nbsp; {d.snapshot?.b?.name ?? '—'}
              </span>
              <span className="badge badge-muted" style={{ marginLeft: 8 }}>
                {d.status === 'merged' ? 'You said: same person' : 'You said: different people'}
              </span>
              {d.status === 'merged' && Array.isArray(d.mergeOutcome?.summary) && (
                <div style={{ color: 'var(--text-3)', marginTop: 4 }}>{d.mergeOutcome.summary.join(' ')}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
