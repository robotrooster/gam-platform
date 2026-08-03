import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { ClipboardList, Plus, Trash2, Send, Copy, BarChart3, X, GripVertical, CheckCircle2 } from 'lucide-react'
import { apiGet, apiPost, apiDelete } from '../lib/api'
import { SURVEY_STATUS_LABEL } from '@gam/shared'

// S577 — property-scoped tenant surveys (Nic). Landlord builds a Google-Forms-
// style questionnaire, sends it to ONE property's tenants, reads the results.
// Responses are never mixed across properties; "same survey elsewhere" = copy.

type QType = 'multiple_choice' | 'text'
interface QDraft { questionType: QType; prompt: string; options: string[] }
const blankQuestion = (): QDraft => ({ questionType: 'text', prompt: '', options: ['', ''] })

const STATUS_COLOR: Record<string, string> = { draft: 'var(--text-3)', sent: 'var(--gold)', closed: '#16a34a' }

export function SurveysPage() {
  const qc = useQueryClient()
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propertyFilter, setPropertyFilter] = useState('')
  const { data: surveys = [], isLoading } = useQuery<any[]>(
    ['surveys', propertyFilter],
    () => apiGet(`/surveys${propertyFilter ? `?propertyId=${propertyFilter}` : ''}`))

  const [builderOpen, setBuilderOpen] = useState(false)
  const [resultsId, setResultsId] = useState<string | null>(null)
  const [copyFor, setCopyFor] = useState<any | null>(null)

  const sendMut = useMutation((id: string) => apiPost(`/surveys/${id}/send`), {
    onSuccess: (r: any) => { qc.invalidateQueries('surveys'); setNotice(`Sent to ${r?.data?.recipients ?? 0} tenant(s).`) } })
  const closeMut = useMutation((id: string) => apiPost(`/surveys/${id}/close`), { onSuccess: () => qc.invalidateQueries('surveys') })
  const delMut = useMutation((id: string) => apiDelete(`/surveys/${id}`), { onSuccess: () => qc.invalidateQueries('surveys') })
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClipboardList size={20} style={{ color: 'var(--gold)' }} />
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700, margin: 0 }}>Surveys</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setBuilderOpen(true)}><Plus size={15} /> New Survey</button>
      </div>
      <p style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 16, maxWidth: 640 }}>
        Send a short questionnaire to a property's tenants to gather input before a change. Each survey belongs to one
        property and its responses stay separate — to run the same survey at another property, use <strong>Copy</strong>.
      </p>

      {notice && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(22,163,74,.1)', border: '1px solid #16a34a', borderRadius: 8, padding: '8px 12px', fontSize: '.8rem', marginBottom: 14 }}>
          <CheckCircle2 size={15} style={{ color: '#16a34a' }} /> {notice}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setNotice(null)}><X size={13} /></button>
        </div>
      )}

      {properties.length > 1 && (
        <select className="form-select" value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} style={{ width: 240, marginBottom: 16 }}>
          <option value="">All properties</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}

      {isLoading ? <div style={{ color: 'var(--text-3)' }}>Loading…</div>
        : surveys.length === 0 ? (
          <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)' }}>
            No surveys yet. Click <strong>New Survey</strong> to create one.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {surveys.map(s => (
              <div key={s.id} className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{s.title}</span>
                    <span style={{ fontSize: '.68rem', fontWeight: 700, textTransform: 'uppercase', color: STATUS_COLOR[s.status], border: `1px solid ${STATUS_COLOR[s.status]}`, borderRadius: 20, padding: '1px 8px' }}>
                      {SURVEY_STATUS_LABEL[s.status as keyof typeof SURVEY_STATUS_LABEL] || s.status}
                    </span>
                  </div>
                  <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 3 }}>
                    {s.property_name} · {s.question_count} question{s.question_count === 1 ? '' : 's'}
                    {s.status !== 'draft' && ` · ${s.response_count} response${s.response_count === 1 ? '' : 's'}`}
                    {s.anonymous && ' · anonymous'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {s.status === 'draft' && (
                    <button className="btn btn-primary btn-sm" onClick={() => sendMut.mutate(s.id)} disabled={sendMut.isLoading}><Send size={13} /> Send</button>
                  )}
                  {s.status !== 'draft' && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setResultsId(s.id)}><BarChart3 size={13} /> Results</button>
                  )}
                  {s.status === 'sent' && (
                    <button className="btn btn-ghost btn-sm" onClick={() => closeMut.mutate(s.id)} disabled={closeMut.isLoading}>Close</button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setCopyFor(s)} title="Copy to another property"><Copy size={13} /></button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { if (confirmDelete(s)) delMut.mutate(s.id) }} title="Delete"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}

      {builderOpen && <SurveyBuilder properties={properties} defaultPropertyId={propertyFilter} onClose={() => setBuilderOpen(false)}
        onSaved={() => { setBuilderOpen(false); qc.invalidateQueries('surveys') }} />}
      {resultsId && <ResultsModal id={resultsId} onClose={() => setResultsId(null)} />}
      {copyFor && <CopyModal survey={copyFor} properties={properties} onClose={() => setCopyFor(null)}
        onCopied={() => { setCopyFor(null); qc.invalidateQueries('surveys'); setNotice('Survey copied as a new draft.') }} />}
    </div>
  )
}

function confirmDelete(_s: any) { return true } // deletion is soft (is_active=false); no native dialog per house rules

// ── Builder ──────────────────────────────────────────────────
function SurveyBuilder({ properties, defaultPropertyId, onClose, onSaved }: { properties: any[]; defaultPropertyId: string; onClose: () => void; onSaved: () => void }) {
  const [propertyId, setPropertyId] = useState(defaultPropertyId || (properties[0]?.id ?? ''))
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [questions, setQuestions] = useState<QDraft[]>([blankQuestion()])
  const [error, setError] = useState<string | null>(null)

  const saveMut = useMutation(
    () => apiPost('/surveys', {
      propertyId, title, description: description || null,
      questions: questions.map(q => ({
        questionType: q.questionType, prompt: q.prompt,
        options: q.questionType === 'multiple_choice' ? q.options.map(o => o.trim()).filter(Boolean) : [],
      })),
    }),
    { onSuccess: onSaved, onError: (e: any) => setError(e?.response?.data?.error || 'Could not save') })

  const setQ = (i: number, patch: Partial<QDraft>) => setQuestions(qs => qs.map((q, j) => j === i ? { ...q, ...patch } : q))
  const setOpt = (qi: number, oi: number, v: string) => setQuestions(qs => qs.map((q, j) => j === qi ? { ...q, options: q.options.map((o, k) => k === oi ? v : o) } : q))

  const valid = propertyId && title.trim() && questions.length > 0 && questions.every(q =>
    q.prompt.trim() && (q.questionType !== 'multiple_choice' || q.options.map(o => o.trim()).filter(Boolean).length >= 2))

  return (
    <Modal onClose={onClose} title="New Survey" wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Lbl>Property</Lbl>
            <select className="form-select" value={propertyId} onChange={e => setPropertyId(e.target.value)} style={{ width: '100%' }}>
              <option value="" disabled>Select…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', background: 'var(--bg-2)', borderRadius: 8, padding: '8px 12px' }}>
          Responses are <strong>anonymous</strong> and every question <strong>must be answered</strong> —
          tenants can reply “NA” if a question doesn’t apply.
        </div>
        <div>
          <Lbl>Title</Lbl>
          <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Pool closure scheduling" style={{ width: '100%' }} />
        </div>
        <div>
          <Lbl>Description (optional)</Lbl>
          <textarea className="form-input" value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {questions.map((q, i) => (
            <div key={i} className="card" style={{ padding: 12, background: 'var(--bg-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <GripVertical size={14} style={{ color: 'var(--text-3)' }} />
                <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Question {i + 1}</span>
                <select className="form-select" value={q.questionType} onChange={e => setQ(i, { questionType: e.target.value as QType })} style={{ width: 160, marginLeft: 6 }}>
                  <option value="text">Written answer</option>
                  <option value="multiple_choice">Multiple choice</option>
                </select>
                {questions.length > 1 && (
                  <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setQuestions(qs => qs.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                )}
              </div>
              <input className="form-input" value={q.prompt} onChange={e => setQ(i, { prompt: e.target.value })} placeholder="Question text" style={{ width: '100%', marginBottom: q.questionType === 'multiple_choice' ? 8 : 0 }} />
              {q.questionType === 'multiple_choice' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8 }}>
                  {q.options.map((o, oi) => (
                    <div key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--text-3)', flexShrink: 0 }} />
                      <input className="form-input" value={o} onChange={e => setOpt(i, oi, e.target.value)} placeholder={`Option ${oi + 1}`} style={{ flex: 1 }} />
                      {q.options.length > 2 && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== oi) })}><X size={12} /></button>
                      )}
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setQ(i, { options: [...q.options, ''] })}><Plus size={12} /> Add option</button>
                </div>
              )}
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setQuestions(qs => [...qs, blankQuestion()])}><Plus size={13} /> Add question</button>
        </div>

        {error && <div style={{ color: 'var(--red, #dc2626)', fontSize: '.8rem' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!valid || saveMut.isLoading} onClick={() => saveMut.mutate()}>
            {saveMut.isLoading ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Results ──────────────────────────────────────────────────
function ResultsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<any>(['survey-results', id], () => apiGet(`/surveys/${id}/results`))
  return (
    <Modal onClose={onClose} title={data?.survey?.title || 'Results'} wide>
      {isLoading ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : !data ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
            {data.responseCount} of {data.invited} tenant{data.invited === 1 ? '' : 's'} responded
            {data.survey.anonymous && ' · anonymous'}
          </div>
          {data.results.map((q: any) => (
            <div key={q.id} className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: '.88rem', marginBottom: 10 }}>{q.prompt}</div>
              {q.question_type === 'multiple_choice' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(() => { const total = q.tally.reduce((s: number, t: any) => s + t.count, 0) || 1
                    return q.tally.map((t: any) => (
                      <div key={t.option}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.78rem', marginBottom: 3 }}>
                          <span>{t.option}</span><span style={{ color: 'var(--text-3)' }}>{t.count} ({Math.round(t.count / total * 100)}%)</span>
                        </div>
                        <div style={{ height: 8, background: 'var(--bg-2)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${t.count / total * 100}%`, background: 'var(--gold)' }} />
                        </div>
                      </div>
                    )) })()}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {q.answers.length === 0 ? <span style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>No answers yet.</span>
                    : q.answers.map((a: any, i: number) => (
                      <div key={i} style={{ fontSize: '.8rem', padding: '6px 10px', background: 'var(--bg-2)', borderRadius: 6 }}>
                        {a.text}{a.respondent && <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}> — {a.respondent}</span>}
                      </div>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ── Copy ─────────────────────────────────────────────────────
function CopyModal({ survey, properties, onClose, onCopied }: { survey: any; properties: any[]; onClose: () => void; onCopied: () => void }) {
  const others = properties.filter(p => p.id !== survey.property_id)
  const [target, setTarget] = useState(others[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const copyMut = useMutation(() => apiPost(`/surveys/${survey.id}/copy`, { targetPropertyId: target }),
    { onSuccess: onCopied, onError: (e: any) => setError(e?.response?.data?.error || 'Could not copy') })
  return (
    <Modal onClose={onClose} title={`Copy "${survey.title}"`}>
      <p style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 12 }}>
        Creates a fresh draft of this survey at another property, with its own separate responses.
      </p>
      {others.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>You have no other property to copy to.</div> : (
        <>
          <Lbl>Copy to property</Lbl>
          <select className="form-select" value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%', marginBottom: 12 }}>
            {others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </>
      )}
      {error && <div style={{ color: 'var(--red, #dc2626)', fontSize: '.8rem', marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!target || copyMut.isLoading} onClick={() => copyMut.mutate()}>{copyMut.isLoading ? 'Copying…' : 'Copy'}</button>
      </div>
    </Modal>
  )
}

// ── shared bits ──────────────────────────────────────────────
function Lbl({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' }}>{children}</span>
}
function Modal({ children, title, onClose, wide }: { children: React.ReactNode; title: string; onClose: () => void; wide?: boolean }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, zIndex: 100, overflowY: 'auto' }} onClick={onClose}>
      <div className="card" style={{ width: '100%', maxWidth: wide ? 680 : 460, padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
