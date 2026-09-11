import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPut, apiPost } from '../lib/api'
import { formatPhone } from '@gam/shared'
import { toast } from '../components/dialogs'
import { SearchBox } from '../components/ListControls'
import { Phone, Check, AlertTriangle, Users } from 'lucide-react'

/**
 * S640 — the emergency contact list, as a Front Desk sub-tab.
 *
 * Nic: "we wanna have a page that is accessible... maybe a sub tab in the front
 * desk page. That way my front desk help Lisa Scheeler can see that, and have
 * permission to edit and update fields that are blank... when people come in to
 * pay rent in person, Lisa can just say, hey, just in case we ever need
 * emergency contact information, who would you like us to contact."
 *
 * So it is built for a person standing at a counter with somebody in front of
 * them: the missing ones first, because those are the conversation to have; one
 * row per resident; and the edit is two boxes on the row itself rather than a
 * modal to open and dismiss while a resident waits.
 */
type Row = {
  tenantId: string
  tenantFirst: string; tenantLast: string; tenantPhone: string | null
  unitNumber: string | null; propertyName: string | null
  contactId: string | null
  contactName: string | null
  contactPhone: string | null
  contactRelationship: string | null
  contactRaw: string | null
  contactSource: string | null
  contactConfirmedAt: string | null
  sharedWithCount: number
  suggestion: { phone: string; fromName: string; context: string } | null
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** Missing first — that is the whole job of this screen. */
function rank(r: Row): number {
  if (!r.contactPhone && !r.contactName) return 0   // nothing at all
  if (!r.contactPhone) return 1                     // a name we cannot ring
  if (!r.contactConfirmedAt) return 2               // never confirmed by a person
  if (Date.now() - new Date(r.contactConfirmedAt).getTime() > YEAR_MS) return 3
  return 4
}

const LABEL: Record<number, { text: string; tone: string }> = {
  0: { text: 'Nothing on file',   tone: 'var(--danger, #dc2626)' },
  1: { text: 'No phone number',   tone: 'var(--amber)' },
  2: { text: 'Never confirmed',   tone: 'var(--text-3)' },
  3: { text: 'Over a year old',   tone: 'var(--amber)' },
  4: { text: 'Confirmed',         tone: 'var(--green)' },
}

export function EmergencyContactsPanel() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Record<string, { name: string; phone: string; rel: string }>>({})

  const { data: rows = [], isLoading } = useQuery<Row[]>(
    'emergency-contacts', () => apiGet<Row[]>('/emergency-contacts'),
    { refetchOnWindowFocus: true })

  const save = useMutation(
    (body: any) => apiPut('/emergency-contacts', body),
    {
      onSuccess: () => { toast('Saved.'); qc.invalidateQueries('emergency-contacts') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not save that.'),
    })

  const confirm = useMutation(
    (tenantId: string) => apiPost('/emergency-contacts/confirm', { tenantId }),
    {
      onSuccess: () => { toast('Confirmed as current.'); qc.invalidateQueries('emergency-contacts') },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not confirm that.'),
    })

  const query = q.trim().toLowerCase()
  const list = (rows as Row[])
    .filter(r => !query || [
      r.tenantFirst, r.tenantLast, r.unitNumber, r.contactName, r.contactPhone,
    ].some(v => String(v ?? '').toLowerCase().includes(query)))
    .sort((a, b) => rank(a) - rank(b)
      || String(a.unitNumber ?? '').localeCompare(String(b.unitNumber ?? ''), undefined, { numeric: true }))

  const missing = (rows as Row[]).filter(r => !r.contactPhone).length

  const draft = (r: Row) => edit[r.tenantId] ?? {
    name: r.contactName ?? '', phone: r.contactPhone ?? '', rel: r.contactRelationship ?? '',
  }
  const setDraft = (id: string, patch: any) =>
    setEdit(e => ({ ...e, [id]: { ...(e[id] ?? { name: '', phone: '', rel: '' }), ...patch } }))

  return (
    <div>
      <div className="filter-bar">
        <SearchBox value={q} onChange={setQ} placeholder="Resident, unit or contact…" />
        {missing > 0 && (
          <span style={{ fontSize: '.78rem', color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={13} />
            {missing} {missing === 1 ? 'resident has' : 'residents have'} no number to call
          </span>
        )}
      </div>

      {/* The line to say out loud. Nic asked for the conversation, not just the
          field: "just in case we ever need emergency contact information, who
          would you like us to contact." */}
      {missing > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, fontSize: '.82rem', color: 'var(--text-2)' }}>
          When they're at the counter: <em>"While you're here — if there were ever an emergency,
          who should we call for you?"</em> A name and a number is enough.
        </div>
      )}

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
          No residents match that.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Resident</th><th>Unit</th><th>Emergency contact</th>
                <th>Phone</th><th>Relationship</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => {
                const d = draft(r)
                const state = LABEL[rank(r)]
                const dirty = d.name !== (r.contactName ?? '')
                  || d.phone !== (r.contactPhone ?? '')
                  || d.rel !== (r.contactRelationship ?? '')
                return (
                  <tr key={r.tenantId}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>
                        {r.tenantFirst} {r.tenantLast}
                      </div>
                      <div style={{ fontSize: '.7rem', color: state.tone }}>{state.text}</div>
                    </td>
                    <td className="mono">{r.unitNumber ?? '—'}</td>
                    <td>
                      <input className="input" style={{ minWidth: 160 }} value={d.name}
                        placeholder="Who should we call?"
                        onChange={e => setDraft(r.tenantId, { name: e.target.value })} />
                      {/* What the lease actually said, when it is not simply the
                          name — "Wife", "NA", a number with nobody attached.
                          The desk can see the question was asked and answered
                          badly, which is different from never asked. */}
                      {r.contactRaw && r.contactRaw.trim() !== (r.contactName ?? '').trim() && (
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 2 }}>
                          lease said: “{r.contactRaw.trim()}”
                        </div>
                      )}
                      {r.sharedWithCount > 1 && (
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 2,
                                      display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Users size={11} /> also the contact for {r.sharedWithCount - 1} other
                          {r.sharedWithCount - 1 === 1 ? ' household' : ' households'}
                        </div>
                      )}
                    </td>
                    <td>
                      <input className="input" style={{ minWidth: 140 }} value={d.phone}
                        placeholder="(520) 555-0142"
                        onChange={e => setDraft(r.tenantId, { phone: e.target.value })} />
                      {/* S640: somebody already in the system with this name and
                          a number on file. Offered, never applied — a wrong
                          number here gets dialled on the worst day of
                          somebody's life. */}
                      {!d.phone && r.suggestion && (
                        <button type="button" className="btn btn-ghost btn-sm"
                          style={{ marginTop: 4, padding: '2px 6px', fontSize: '.7rem' }}
                          onClick={() => setDraft(r.tenantId, { phone: r.suggestion!.phone })}>
                          <Phone size={11} /> use {formatPhone(r.suggestion.phone)}
                          <span style={{ color: 'var(--text-3)' }}> — {r.suggestion.context}</span>
                        </button>
                      )}
                    </td>
                    <td>
                      <input className="input" style={{ maxWidth: 120 }} value={d.rel}
                        placeholder="Daughter"
                        onChange={e => setDraft(r.tenantId, { rel: e.target.value })} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {dirty ? (
                        <button className="btn btn-primary btn-sm" disabled={save.isLoading}
                          onClick={() => save.mutate({
                            tenantId: r.tenantId, name: d.name, phone: d.phone, relationship: d.rel,
                          })}>Save</button>
                      ) : r.contactPhone ? (
                        <button className="btn btn-ghost btn-sm" disabled={confirm.isLoading}
                          title="Still current — nothing to change"
                          onClick={() => confirm.mutate(r.tenantId)}>
                          <Check size={12} /> Still good
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
