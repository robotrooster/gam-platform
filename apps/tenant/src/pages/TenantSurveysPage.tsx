import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { ClipboardList, CheckCircle2, ChevronRight, ArrowLeft } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

// S577 — tenant side of property-scoped surveys. Lists surveys the landlord
// sent to this tenant's property and lets the tenant answer once.

export function TenantSurveysPage() {
  const [openId, setOpenId] = useState<string | null>(null)
  if (openId) return <SurveyForm id={openId} onBack={() => setOpenId(null)} />
  return <SurveyList onOpen={setOpenId} />
}

function SurveyList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: surveys = [], isLoading } = useQuery<any[]>('tenant-surveys', () => apiGet('/surveys/tenant/mine'))
  if (isLoading) return <div style={{ color: 'var(--t3)' }}>Loading…</div>
  if (surveys.length === 0) return (
    <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', border: '1px solid var(--b0)', borderRadius: 12 }}>
      No surveys right now. Your landlord will send one here when they want your input.
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {surveys.map(s => (
        <button key={s.id} onClick={() => onOpen(s.id)}
          style={{ textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, border: '1px solid var(--b0)', background: 'var(--bg1)', cursor: 'pointer' }}>
          <ClipboardList size={20} style={{ color: 'var(--gold)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, color: 'var(--t0)' }}>{s.title}</div>
            {s.description && <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginTop: 2 }}>{s.description}</div>}
            <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 3 }}>{s.questionCount} question{s.questionCount === 1 ? '' : 's'}</div>
          </div>
          {s.responded
            ? <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '.74rem', color: '#16a34a', fontWeight: 600 }}><CheckCircle2 size={15} /> Done</span>
            : <ChevronRight size={18} style={{ color: 'var(--t3)' }} />}
        </button>
      ))}
    </div>
  )
}

function SurveyForm({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient()
  const { data: survey, isLoading } = useQuery<any>(['tenant-survey', id], () => apiGet(`/surveys/tenant/${id}`))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const submitMut = useMutation(
    () => apiPost(`/surveys/tenant/${id}/respond`, {
      answers: Object.entries(answers).map(([questionId, answerText]) => ({ questionId, answerText })),
    }),
    { onSuccess: () => { qc.invalidateQueries('tenant-surveys'); qc.invalidateQueries(['tenant-survey', id]) },
      onError: (e: any) => setError(e?.response?.data?.error || 'Could not submit') })

  if (isLoading) return <div style={{ color: 'var(--t3)' }}>Loading…</div>
  if (!survey) return <BackBar onBack={onBack} />

  if (survey.responded || submitMut.isSuccess) return (
    <div>
      <BackBar onBack={onBack} />
      <div style={{ padding: 32, textAlign: 'center' }}>
        <CheckCircle2 size={40} style={{ color: '#16a34a', marginBottom: 12 }} />
        <div style={{ fontWeight: 700, color: 'var(--t0)', fontSize: '1.05rem' }}>Thanks — your response is in.</div>
        <div style={{ fontSize: '.82rem', color: 'var(--t3)', marginTop: 6 }}>Your landlord can see the results.</div>
      </div>
    </div>
  )

  // S577: every question must be answered (tenant types "NA" if it doesn't apply).
  const missingRequired = (survey.questions || []).some((q: any) => !(answers[q.id] || '').trim())

  return (
    <div>
      <BackBar onBack={onBack} />
      <h2 style={{ fontFamily: 'var(--font-d)', fontSize: '1.2rem', fontWeight: 800, color: 'var(--t0)', marginBottom: 4 }}>{survey.title}</h2>
      {survey.description && <p style={{ fontSize: '.85rem', color: 'var(--t3)', marginBottom: 10 }}>{survey.description}</p>}
      <p style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 18 }}>
        Your responses are <strong>anonymous</strong>. Every question is required — type <strong>NA</strong> if one doesn’t apply.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {(survey.questions || []).map((q: any, i: number) => (
          <div key={q.id} style={{ padding: 16, borderRadius: 12, border: '1px solid var(--b0)', background: 'var(--bg1)' }}>
            <div style={{ fontWeight: 600, color: 'var(--t0)', marginBottom: 10 }}>
              {i + 1}. {q.prompt} {q.required && <span style={{ color: 'var(--gold)' }}>*</span>}
            </div>
            {/* S583: wire format is camelCase (API global camelize) — reading
                q.question_type made this always false, so multiple-choice
                questions rendered as a free-text box; the tenant's typed answer
                then failed the server's "must be one of the options" check. */}
            {q.questionType === 'multiple_choice' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(Array.isArray(q.options) ? q.options : []).map((o: string) => (
                  <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '.88rem', color: 'var(--t1)', cursor: 'pointer' }}>
                    <input type="radio" name={q.id} checked={answers[q.id] === o} onChange={() => setAnswers(a => ({ ...a, [q.id]: o }))} />
                    {o}
                  </label>
                ))}
              </div>
            ) : (
              <textarea className="input" value={answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                rows={3} placeholder="Your answer" style={{ width: '100%', resize: 'vertical' }} />
            )}
          </div>
        ))}
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: '.82rem', marginTop: 14 }}>{error}</div>}
      <button className="btn-p" style={{ marginTop: 18, width: '100%', padding: '12px' }}
        disabled={missingRequired || submitMut.isLoading} onClick={() => { setError(null); submitMut.mutate() }}>
        {submitMut.isLoading ? 'Submitting…' : 'Submit response'}
      </button>
    </div>
  )
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: '.82rem', marginBottom: 14, padding: 0 }}>
      <ArrowLeft size={15} /> Back to surveys
    </button>
  )
}
