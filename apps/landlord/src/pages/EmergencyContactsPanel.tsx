import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPut, apiPost } from '../lib/api'
import { formatPhone } from '@gam/shared'
import { toast } from '../components/dialogs'
import { SearchBox } from '../components/ListControls'
import { Phone, Check, AlertTriangle, Users } from 'lucide-react'
import { FRESH_LIST, loadFailedSentence, actionFailedSentence } from './deskErrors'

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
  tenantId: string | null          // S653: null = an owner-use space's occupant
  tenantFirst: string; tenantLast: string; tenantPhone: string | null
  unitNumber: string | null; propertyName: string | null; propertyId?: string | null
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

/**
 * A phone the way the server stores it (routes/emergencyContacts.ts PUT): the
 * digits only, a leading 1 dropped from 11. So "(520) 555-0142" typed and
 * "5205550142" stored read as the same number, and a saved row stops asking
 * to be saved.
 */
const phoneDigits = (s: string | null | undefined) => {
  const d = String(s ?? '').replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}
/** A name or relationship the way the server stores it: trimmed. */
const tidy = (s: string | null | undefined) => String(s ?? '').trim()

/** Missing first — that is the whole job of this screen. */
function rank(r: Row): number {
  // An owner-use space has nothing to edit (its occupant IS the contact): it
  // sorts after every resident row.
  if (!r.tenantId) return 5
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

/**
 * A Save or "Still good" the server refused. A 404 means the row on screen is
 * stale (routes/emergencyContacts: the resident is no longer on an active
 * lease here; nothing on file to confirm any more), so it says what is true
 * and the list is read again (the caller does). Anything else: the server's
 * own sentence, or the fallback with its step.
 */
function refusalSentence(e: any, notFound: string, fallback: string): string {
  if (e?.response?.status === 404) return `${notFound} The list has been read again.`
  return actionFailedSentence(e, fallback, 'Changing emergency contacts', 'Front desk to-do list')
}

export function EmergencyContactsPanel() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Record<string, { name: string; phone: string; rel: string }>>({})

  const { data: rows = [], isLoading, isError, error } = useQuery<Row[]>(
    'emergency-contacts', () => apiGet<Row[]>('/emergency-contacts'),
    FRESH_LIST)

  const save = useMutation(
    (body: any) => apiPut('/emergency-contacts', body),
    {
      // The draft goes once it is saved and the row has read the stored values
      // again (never a flash of the old ones): it then offers "Still good", not
      // a second Save.
      onSuccess: async (_d, body: any) => {
        toast('Saved.')
        await qc.invalidateQueries('emergency-contacts')
        dropDraft(body.tenantId)
      },
      // The roster is read again on every refusal, so a stale row shows as it is now.
      onError: (e: any) => {
        toast.error(refusalSentence(e, 'That resident is no longer on a space here.',
          'Could not save that. Try again; if it keeps happening, tell GAM support.'))
        qc.invalidateQueries('emergency-contacts')
      },
    })

  const confirm = useMutation(
    (tenantId: string) => apiPost('/emergency-contacts/confirm', { tenantId }),
    {
      onSuccess: () => { toast('Confirmed as current.'); qc.invalidateQueries('emergency-contacts') },
      onError: (e: any) => {
        toast.error(refusalSentence(e, 'There is no contact on file to confirm any more.',
          'Could not confirm that. Try again; if it keeps happening, tell GAM support.'))
        qc.invalidateQueries('emergency-contacts')
      },
    })

  const query = q.trim().toLowerCase()
  const list = (rows as Row[])
    .filter(r => !query || [
      r.tenantFirst, r.tenantLast, r.unitNumber, r.contactName, r.contactPhone,
    ].some(v => String(v ?? '').toLowerCase().includes(query)))
    .sort((a, b) => rank(a) - rank(b)
      || String(a.unitNumber ?? '').localeCompare(String(b.unitNumber ?? ''), undefined, { numeric: true }))

  // Only residents the desk can ask: an owner-use space has nothing to fill in.
  const missing = (rows as Row[]).filter(r => !!r.tenantId && !r.contactPhone).length

  // The stored values as the boxes show them (the phone written out).
  const stored = (r: Row) => ({
    name: r.contactName ?? '', phone: r.contactPhone ? (formatPhone(r.contactPhone) ?? r.contactPhone) : '',
    rel: r.contactRelationship ?? '',
  })
  const draft = (r: Row) => edit[r.tenantId ?? ''] ?? stored(r)
  const setDraft = (r: Row, patch: any) => {
    const id = r.tenantId as string
    setEdit(e => ({ ...e, [id]: { ...(e[id] ?? stored(r)), ...patch } }))
  }
  // One button back out: the boxes go back to what is on file; nothing is sent.
  function dropDraft(id: string) {
    setEdit(e => { if (!(id in e)) return e; const n = { ...e }; delete n[id]; return n })
  }

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

      {isError ? (
        // A refusal (or any failure) is said once, with the next step — never
        // an empty roster that reads as "nobody has a contact".
        <div className="card" role="alert" style={{ padding: 14, color: 'var(--danger, #dc2626)' }}>
          {loadFailedSentence(error, 'The emergency contact list', 'Front desk to-do list')}
        </div>
      ) : isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
          {query ? 'No residents match that.' : 'Nobody is on a space right now.'}
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
                // S653: an owner-use space — the occupant IS the contact; nothing to edit.
                if (!r.tenantId) {
                  return (
                    <tr key={`owner:${r.propertyId}:${r.unitNumber}`}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{r.tenantFirst}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>owner-use space</div>
                      </td>
                      <td className="mono">{r.unitNumber ?? '—'}</td>
                      <td colSpan={3} style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
                        {r.tenantPhone ? <a href={`tel:${r.tenantPhone}`} style={{ color: 'var(--text-1)' }}>{formatPhone(r.tenantPhone)}</a> : 'No phone on file — add it on the space'}
                      </td>
                      <td />
                    </tr>
                  )
                }
                const tenantId = r.tenantId as string
                const d = draft(r)
                const state = LABEL[rank(r)]
                // Compared the way the server stores them, so a formatted phone
                // or a trailing space is not a change.
                const dirty = tidy(d.name) !== tidy(r.contactName)
                  || phoneDigits(d.phone) !== phoneDigits(r.contactPhone)
                  || tidy(d.rel) !== tidy(r.contactRelationship)
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
                        onChange={e => setDraft(r, { name: e.target.value })} />
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
                        onChange={e => setDraft(r, { phone: e.target.value })} />
                      {/* S640: somebody already in the system with this name and
                          a number on file. Offered, never applied — a wrong
                          number here gets dialed on the worst day of
                          somebody's life. */}
                      {!d.phone && r.suggestion && (
                        <button type="button" className="btn btn-primary btn-sm"
                          style={{ marginTop: 4, padding: '2px 6px', fontSize: '.7rem' }}
                          onClick={() => setDraft(r, { phone: formatPhone(r.suggestion!.phone) ?? r.suggestion!.phone })}>
                          <Phone size={11} /> use {formatPhone(r.suggestion.phone)}
                          <span style={{ color: 'var(--text-3)' }}> — {r.suggestion.context}</span>
                        </button>
                      )}
                    </td>
                    <td>
                      <input className="input" style={{ maxWidth: 120 }} value={d.rel}
                        placeholder="Daughter"
                        onChange={e => setDraft(r, { rel: e.target.value })} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {dirty ? (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" disabled={save.isLoading}
                            onClick={() => save.mutate({
                              tenantId, name: d.name, phone: d.phone, relationship: d.rel,
                            })}>Save</button>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={save.isLoading}
                            title="Put back what is on file"
                            onClick={() => dropDraft(tenantId)}>Cancel</button>
                        </span>
                      ) : r.contactPhone ? (
                        <button className="btn btn-primary btn-sm" disabled={confirm.isLoading}
                          title="Still current — nothing to change"
                          onClick={() => confirm.mutate(tenantId)}>
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
