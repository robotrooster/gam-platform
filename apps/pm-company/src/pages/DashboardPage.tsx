import { useQuery } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet } from '../lib/api'
import { Link } from 'react-router-dom'

interface Invitation { id: string; status: string; direction: string; propertyName: string; createdAt: string }
interface Payout { id: string; amount: string; status: string; arrivalDate: string | null }

export function DashboardPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id

  const invitesQ = useQuery<Invitation[]>(
    ['pm-invitations', cid],
    () => apiGet<Invitation[]>(`/pm/companies/${cid}/property-invitations`),
    { enabled: !!cid },
  )
  const payoutsQ = useQuery<Payout[]>(
    ['pm-payouts', cid],
    () => apiGet<Payout[]>(`/pm/companies/${cid}/payouts?limit=5`),
    { enabled: !!cid },
  )

  const pendingIncoming = (invitesQ.data ?? []).filter(i => i.direction === 'owner_to_pm' && i.status === 'pending')
  const pendingOutgoing = (invitesQ.data ?? []).filter(i => i.direction === 'pm_to_owner' && i.status === 'pending')

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>{activePmCompany?.name ?? 'Dashboard'}</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Multi-owner portfolio overview
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 24 }}>
        <KpiCard label="Pending invitations from owners" value={pendingIncoming.length}
                 to="/invitations" tone={pendingIncoming.length > 0 ? 'gold' : 'neutral'} />
        <KpiCard label="Outgoing invites awaiting reply" value={pendingOutgoing.length}
                 to="/invitations" tone="neutral" />
        <KpiCard label="Recent payouts" value={(payoutsQ.data ?? []).length}
                 to="/banking" tone="neutral" />
      </div>

      {pendingIncoming.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-0)', marginBottom: 8 }}>
            Action required
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12 }}>
            {pendingIncoming.length} owner{pendingIncoming.length === 1 ? '' : 's'} {pendingIncoming.length === 1 ? 'has' : 'have'} invited
            you to manage {pendingIncoming.length === 1 ? 'a property' : 'properties'}.
          </div>
          <Link to="/invitations" className="btn btn-primary btn-sm">Review invitations</Link>
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)', marginBottom: 12 }}>Getting started</div>
        <ol style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.7, paddingLeft: 18 }}>
          <li>Set up <Link to="/banking" style={{ color: 'var(--gold)' }}>banking</Link> via Stripe Connect (required before you can accept management invitations).</li>
          <li>Create your <Link to="/fee-plans" style={{ color: 'var(--gold)' }}>fee plans</Link> — the rate sheets you offer landlords.</li>
          <li>Invite <Link to="/staff" style={{ color: 'var(--gold)' }}>staff</Link> with role-appropriate access.</li>
          <li>Send property invitations to landlords, or accept incoming ones, from <Link to="/invitations" style={{ color: 'var(--gold)' }}>Property Invites</Link>.</li>
        </ol>
      </div>
    </div>
  )
}

function KpiCard({ label, value, to, tone }: { label: string; value: number; to: string; tone: 'gold' | 'neutral' }) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div className="card" style={{
        padding: 16,
        borderColor: tone === 'gold' && value > 0 ? 'var(--gold)' : undefined,
      }}>
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, color: tone === 'gold' && value > 0 ? 'var(--gold)' : 'var(--text-0)', marginTop: 6 }}>
          {value}
        </div>
      </div>
    </Link>
  )
}
