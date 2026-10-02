/**
 * S537 / W-70: in-app replacements for native browser dialogs.
 *
 * STANDING RULE (S536, Nic-locked): never alert()/confirm()/prompt().
 * Safari suppresses repeat dialogs and wrapped apps (iOS WKWebView /
 * Android WebView) drop them entirely → silent no-ops.
 *
 * Usage — both are drop-in one-liners at old callsites:
 *   toast( 'Saved.' )                    // success (gold accent)
 *   toast.error('Could not save')        // error (red accent)
 *   if (!(await appConfirm('Delete this meter?'))) return
 *
 * <DialogHost/> renders the toast stack + the active confirm modal and
 * is mounted once in Layout. The module-level bus means callsites need
 * no context/hooks — mechanical replacement of the native calls.
 */
// S622 (Nic): these sat at z-index 300/310, below full-screen editors that use
// 1000 — so "Replace the current fields with auto-placed ones?" rendered BEHIND
// the e-sign template editor. The click appeared to do nothing at all: no
// dialog, no error, no confirmation, and the work silently waiting on an answer
// nobody could see. A modal question and a toast must outrank every surface
// that can raise them, so both now sit above anything the app draws.
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

type ToastMsg = { id: number; text: string; kind: 'info' | 'error' }
type ConfirmReq = {
  id: number
  message: string
  title: string
  confirmLabel: string
  danger: boolean
  resolve: (ok: boolean) => void
}
type PromptReq = {
  id: number
  message: string
  title: string
  defaultValue: string
  resolve: (value: string | null) => void
}

let nextId = 1
let pushToast: ((t: ToastMsg) => void) | null = null
let pushConfirm: ((c: ConfirmReq) => void) | null = null
let pushPrompt: ((c: PromptReq) => void) | null = null

export function toast(text: string) {
  pushToast?.({ id: nextId++, text, kind: 'info' })
}
toast.error = (text: string) => {
  pushToast?.({ id: nextId++, text, kind: 'error' })
}

export function appConfirm(
  message: string,
  opts: { title?: string; confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!pushConfirm) { resolve(false); return }
    pushConfirm({
      id: nextId++,
      message,
      title: opts.title ?? 'Please confirm',
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      danger: opts.danger ?? false,
      resolve,
    })
  })
}

/** In-app replacement for window.prompt — resolves the entered string,
 *  or null on cancel (same contract as the native call). */
export function appPrompt(
  message: string,
  opts: { title?: string; defaultValue?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!pushPrompt) { resolve(null); return }
    pushPrompt({
      id: nextId++,
      message,
      title: opts.title ?? 'Input needed',
      defaultValue: opts.defaultValue ?? '',
      resolve,
    })
  })
}

export function DialogHost() {
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null)
  const [promptReq, setPromptReq] = useState<PromptReq | null>(null)
  const [promptValue, setPromptValue] = useState('')

  useEffect(() => {
    pushToast = (t) => {
      setToasts((prev) => [...prev.slice(-3), t])
      // S605 (Nic): "it popped up with a red error message, but it disappeared
      // before I could get a good look at it." Every toast auto-dismissed at 5s,
      // including errors — which are the ones that carry information the user
      // has to ACT on, and are often long enough that 5s isn't reading time.
      // Errors now stay until dismissed; confirmations still fade.
      if (t.kind !== 'error') {
        setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 5000)
      }
    }
    pushConfirm = (c) => setConfirmReq((prev) => {
      // one at a time — a second request while one is open resolves false
      if (prev) { c.resolve(false); return prev }
      return c
    })
    pushPrompt = (c) => setPromptReq((prev) => {
      if (prev) { c.resolve(null); return prev }
      setPromptValue(c.defaultValue)
      return c
    })
    return () => { pushToast = null; pushConfirm = null; pushPrompt = null }
  }, [])

  const settle = (ok: boolean) => {
    confirmReq?.resolve(ok)
    setConfirmReq(null)
  }

  return (
    <>
      {/* toast stack */}
      <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 5000, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', pointerEvents: 'none' }}>
        {toasts.map((t) => (
          // Click anywhere to dismiss — required for errors, which no longer
          // time out, and harmless for the rest.
          <div key={t.id}
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            title="Click to dismiss"
            style={{
              pointerEvents: 'auto', maxWidth: 480, padding: '10px 16px', borderRadius: 8,
              background: 'var(--bg-1)', color: 'var(--text-0)', fontSize: '.85rem', lineHeight: 1.45,
              border: `1px solid ${t.kind === 'error' ? 'var(--red, #dc2626)' : 'var(--gold)'}`,
              boxShadow: '0 8px 30px rgba(0,0,0,.45)', cursor: 'pointer',
              display: 'flex', gap: 12, alignItems: 'flex-start',
            }}>
            <span style={{ flex: 1 }}>{t.text}</span>
            {t.kind === 'error' && (
              <span style={{ color: 'var(--text-3)', fontSize: '1rem', lineHeight: 1, marginTop: 1 }}>×</span>
            )}
          </div>
        ))}
      </div>

      {/* prompt modal */}
      {promptReq && (
        <div onClick={() => { promptReq.resolve(null); setPromptReq(null) }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5100, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.5)', padding: '16px 20px' }}>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>{promptReq.title}</div>
            <div style={{ fontSize: '.85rem', color: 'var(--text-1)', lineHeight: 1.5, marginBottom: 10, whiteSpace: 'pre-wrap' }}>{promptReq.message}</div>
            <input className="form-input" autoFocus value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { promptReq.resolve(promptValue); setPromptReq(null) } }}
              style={{ width: '100%', marginBottom: 14 }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => { promptReq.resolve(null); setPromptReq(null) }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { promptReq.resolve(promptValue); setPromptReq(null) }}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* confirm modal */}
      {confirmReq && (
        <div onClick={() => settle(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5100, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ padding: '16px 20px 0', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {confirmReq.danger && <AlertTriangle size={18} style={{ color: 'var(--red, #dc2626)', flexShrink: 0, marginTop: 2 }} />}
              <div>
                <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>{confirmReq.title}</div>
                <div style={{ fontSize: '.85rem', color: 'var(--text-1)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{confirmReq.message}</div>
              </div>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => settle(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => settle(true)}
                style={confirmReq.danger ? { background: 'var(--red, #dc2626)', borderColor: 'var(--red, #dc2626)', color: '#fff' } : undefined}>
                {confirmReq.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
