/**
 * PM portal property drilldown — one-shot fetch from
 * GET /api/pm/companies/:cid/properties/:propertyId/drilldown.
 * Renders units / active leases / recent maintenance / MTD fee impact.
 */

import { useQuery } from 'react-query'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { apiGet } from '../lib/api'

const fmt = (n: any) => n != null
  ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : '—'

interface Drilldown {
  property: {
    id: string
    name: string
    street1: string | null
    city: string | null
    state: string | null
    zip: string | null
    type: string | null
    pmFeePlanName: string | null
    pmFeeType: string | null
    pmFeePercent: string | null
    pmFeeFlatAmount: string | null
    totalUnits: number
    occupiedUnits: number
  }
  units: Array<{
    id: string
    unitNumber: string
    status: string
    rentAmount: string | null
    tenantFirst: string | null
    tenantLast: string | null
  }>
  activeLeases: Array<{
    id: string
    unitNumber: string
    startDate: string
    endDate: string | null
    monthlyRent: string
    status: string
    tenantFirst: string | null
    tenantLast: string | null
  }>
  recentMaintenance: Array<{
    id: string
    title: string
    status: string
    priority: string
    category: string
    unitNumber: string
    createdAt: string
    completedAt: string | null
    estimatedCost: string | null
    actualCost: string | null
  }>
  mtdFeeImpact: {
    gross: number
    pmCompanyCut: number
    ownerNet: number
    paymentCount: number
  }
}

export function PropertyDetailPage() {
  const { id: propertyId } = useParams()
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id

  const dQ = useQuery<Drilldown>(
    ['pm-property-drilldown', cid, propertyId],
    () => apiGet<Drilldown>(`/pm/companies/${cid}/properties/${propertyId}/drilldown`),
    { enabled: !!cid && !!propertyId },
  )

  if (dQ.isLoading) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Loading…</div>
  if (dQ.isError || !dQ.data) {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 16, color: 'var(--red, #dc4c4c)' }}>
          Couldn&apos;t load property — it may no longer be linked to {activePmCompany?.name ?? 'your company'}.{' '}
          <Link to="/properties" style={{ color: 'var(--gold)' }}>Back to properties</Link>
        </div>
      </div>
    )
  }
  const d = dQ.data

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 18 }}>
        <Link to="/properties" style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>← Properties</Link>
        <h1 style={{ margin: '6px 0 0', fontSize: '1.4rem', color: 'var(--text-0)' }}>
          {d.property.name}
        </h1>
        <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginTop: 4 }}>
          {[d.property.street1, d.property.city, d.property.state, d.property.zip].filter(Boolean).join(', ') || '—'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Kpi label="Units" value={`${d.property.occupiedUnits} / ${d.property.totalUnits}`} sub="occupied" />
        <Kpi label="MTD gross collected" value={fmt(d.mtdFeeImpact.gross)} sub={`${d.mtdFeeImpact.paymentCount} payment${d.mtdFeeImpact.paymentCount === 1 ? '' : 's'}`} />
        <Kpi label="MTD PM fee" value={fmt(d.mtdFeeImpact.pmCompanyCut)} sub={d.property.pmFeePlanName ?? '—'} tone="gold" />
        <Kpi label="MTD owner net" value={fmt(d.mtdFeeImpact.ownerNet)} sub="goes to landlord" />
      </div>

      <Section title="Units">
        {d.units.length === 0 ? <Empty>No units on this property.</Empty> : (
          <Table>
            <thead><tr><Th>Unit</Th><Th>Status</Th><Th>Rent</Th><Th>Primary tenant</Th></tr></thead>
            <tbody>
              {d.units.map(u => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td><strong>{u.unitNumber}</strong></Td>
                  <Td><span className="badge" style={{ background: u.status === 'active' ? 'rgba(46,163,90,.18)' : 'var(--bg-2)' }}>{u.status}</span></Td>
                  <Td style={{ fontFamily: 'JetBrains Mono' }}>{fmt(u.rentAmount)}</Td>
                  <Td>{[u.tenantFirst, u.tenantLast].filter(Boolean).join(' ') || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Active leases">
        {d.activeLeases.length === 0 ? <Empty>No active leases on this property.</Empty> : (
          <Table>
            <thead><tr><Th>Unit</Th><Th>Tenant</Th><Th>Rent</Th><Th>Start</Th><Th>End</Th></tr></thead>
            <tbody>
              {d.activeLeases.map(l => (
                <tr key={l.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td><strong>{l.unitNumber}</strong></Td>
                  <Td>{[l.tenantFirst, l.tenantLast].filter(Boolean).join(' ') || '—'}</Td>
                  <Td style={{ fontFamily: 'JetBrains Mono' }}>{fmt(l.monthlyRent)}</Td>
                  <Td>{new Date(l.startDate).toLocaleDateString()}</Td>
                  <Td>{l.endDate ? new Date(l.endDate).toLocaleDateString() : 'Month-to-month'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Recent maintenance">
        {d.recentMaintenance.length === 0 ? <Empty>No maintenance requests in the recent history.</Empty> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Unit</Th><Th>Title</Th><Th>Priority</Th><Th>Status</Th><Th>Cost</Th></tr></thead>
            <tbody>
              {d.recentMaintenance.map(m => (
                <tr key={m.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td>{new Date(m.createdAt).toLocaleDateString()}</Td>
                  <Td>{m.unitNumber}</Td>
                  <Td>{m.title}</Td>
                  <Td><span className="badge" style={{ background: m.priority === 'emergency' ? 'rgba(220,76,76,.18)' : m.priority === 'high' ? 'rgba(245,158,11,.18)' : 'var(--bg-2)' }}>{m.priority}</span></Td>
                  <Td><span className="badge" style={{ background: m.status === 'completed' ? 'rgba(46,163,90,.18)' : 'var(--bg-2)' }}>{m.status}</span></Td>
                  <Td style={{ fontFamily: 'JetBrains Mono' }}>{fmt(m.actualCost ?? m.estimatedCost)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'gold' }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: 6, color: tone === 'gold' ? 'var(--gold)' : 'var(--text-0)' }}>{value}</div>
      {sub && <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text-0)', marginBottom: 8 }}>{title}</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}
function Table({ children }: { children: React.ReactNode }) {
  return <table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table>
}
function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 600, background: 'var(--bg-2)' }}>{children}</th>
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: '12px 14px', fontSize: '.84rem', color: 'var(--text-1)', ...style }}>{children}</td>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 16, fontSize: '.82rem', color: 'var(--text-3)' }}>{children}</div>
}
