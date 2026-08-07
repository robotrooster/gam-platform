import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { Inbox, CheckCircle2, ShieldCheck, ShieldAlert, ArrowRight, Loader } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

// Response of GET /api/properties/applications (camelCased on the wire).
type Application = {
  id: string
  propertyName: string | null
  unitNumber: string | null
  firstName: string
  lastName: string
  email: string
  phone: string | null
  moveInDate: string | null
  occupants: number | null
  message: string | null
  createdAt: string
  applicantUserId: string | null
  backgroundCheckStatus: string | null
  leaseDrafted: boolean
}

const SCREENED = ['approved', 'waived']

export function ApplicationsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  const { data: apps = [], isLoading } = useQuery<Application[]>(
    'applications', () => apiGet<Application[]>('/properties/applications'))

  const onboard = useMutation(
    (id: string) => apiPost<{ leaseId: string }>(`/properties/applications/${id}/onboard`),
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('applications')
        // Land on the drafted lease so the landlord reviews terms + sends to sign.
        navigate(`/leases?open=${res.data.leaseId}`)
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not start onboarding. Please try again.'),
    })

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '8px 4px' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-0)' }}>Applications</h1>
        <p style={{ fontSize: '.85rem', color: 'var(--text-2)', marginTop: 4 }}>
          Renters who applied to your listings. Onboard one to draft their lease — it flows into your
          schedule and onboarding to-dos, the same as any other tenant.
        </p>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 14, background: 'rgba(193,18,31,.1)', border: '1px solid rgba(193,18,31,.3)', color: 'var(--text-0)', fontSize: '.85rem' }}>
          {error}
        </div>
      )}

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 40, color: 'var(--text-2)' }}>
          <Loader size={18} className="spin" /> Loading applications…
        </div>
      )}

      {!isLoading && apps.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-2)' }}>
          <Inbox size={32} style={{ opacity: .5 }} />
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginTop: 10 }}>No applications yet</div>
          <div style={{ fontSize: '.85rem', marginTop: 4 }}>Applicants from the rental marketplace show up here.</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {apps.map((a) => {
          const who = [a.firstName, a.lastName].filter(Boolean).join(' ') || 'Applicant'
          const screened = SCREENED.includes(a.backgroundCheckStatus || '')
          return (
            <div key={a.id} style={{ background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-0)' }}>{who}</span>
                  {screened ? (
                    <span title="Background check cleared" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.72rem', color: 'var(--green, #2d6a4f)', fontWeight: 600 }}>
                      <ShieldCheck size={13} /> Screened
                    </span>
                  ) : (
                    <span title="Not yet screened" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.72rem', color: 'var(--text-3)', fontWeight: 600 }}>
                      <ShieldAlert size={13} /> Not screened
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 3 }}>
                  {a.propertyName}{a.unitNumber ? ` · Unit ${a.unitNumber}` : ''} · {a.email}
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 3 }}>
                  {a.moveInDate ? `Move-in ${new Date(a.moveInDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ` : ''}
                  Applied {new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                {a.message && <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 6, fontStyle: 'italic' }}>“{a.message}”</div>}
              </div>
              <div style={{ flexShrink: 0 }}>
                {a.leaseDrafted ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.82rem', color: 'var(--green, #2d6a4f)', fontWeight: 600 }}>
                    <CheckCircle2 size={15} /> Lease drafted
                  </span>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={onboard.isLoading || !a.unitNumber}
                    onClick={() => { setError(''); onboard.mutate(a.id) }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', fontSize: '.85rem', fontWeight: 700, borderRadius: 8 }}
                    title={!a.unitNumber ? 'This application is not tied to a specific unit' : 'Draft a lease from this application'}>
                    {onboard.isLoading ? 'Starting…' : <>Onboard <ArrowRight size={15} /></>}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
