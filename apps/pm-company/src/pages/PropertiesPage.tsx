/**
 * Linked properties across all owners — properties whose
 * pm_company_id == this PM company. Read-only list for now; deeper drill-
 * downs come once we've got the property-detail surface in S159+.
 *
 * Uses the existing GET /api/properties endpoint, which returns properties
 * the caller can see. PM staff with pm_staff.permissions matching the
 * relevant property scopes will see the company's linked properties.
 */

import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { apiGet } from '../lib/api'

interface PmProperty {
  id: string
  name: string
  street1: string | null
  city: string | null
  state: string | null
  pmCompanyId: string | null
  pmFeePlanId: string | null
  totalUnits?: number
  occupiedUnits?: number
}

export function PropertiesPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id

  const propsQ = useQuery<PmProperty[]>(
    'all-properties',
    () => apiGet<PmProperty[]>('/properties'),
  )

  const linked = (propsQ.data ?? []).filter(p => p.pmCompanyId === cid)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Properties Under Management</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Properties currently linked to {activePmCompany?.name ?? 'your company'}.
        </div>
      </div>

      {propsQ.isLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}
      {propsQ.isError && (
        <div className="card" style={{ padding: 16, color: 'var(--red, #dc4c4c)' }}>
          Couldn&apos;t load properties.
        </div>
      )}

      {linked.length === 0 && !propsQ.isLoading && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ color: 'var(--text-2)', fontSize: '.88rem' }}>
            No properties linked yet. Send invitations from <a href="/invitations" style={{ color: 'var(--gold)' }}>Property Invites</a>
            {' '}or wait for owners to invite you.
          </div>
        </div>
      )}

      {linked.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Property</Th>
                <Th>Address</Th>
                <Th>Units</Th>
                <Th>Fee plan</Th>
              </tr>
            </thead>
            <tbody>
              {linked.map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td>
                    <Link to={`/properties/${p.id}`} style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                      <strong>{p.name}</strong>
                    </Link>
                  </Td>
                  <Td>{[p.street1, p.city, p.state].filter(Boolean).join(', ') || '—'}</Td>
                  <Td>
                    {p.totalUnits ?? '—'}
                    {p.occupiedUnits != null && p.totalUnits != null && (
                      <span style={{ marginLeft: 6, color: 'var(--text-3)', fontSize: '.72rem' }}>
                        ({p.occupiedUnits} occupied)
                      </span>
                    )}
                  </Td>
                  <Td style={{ fontFamily: 'JetBrains Mono', fontSize: '.72rem', color: 'var(--text-3)' }}>
                    {p.pmFeePlanId ? p.pmFeePlanId.slice(0, 8) + '…' : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 600 }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '12px 14px', fontSize: '.84rem', color: 'var(--text-1)', ...style }}>{children}</td>
)
