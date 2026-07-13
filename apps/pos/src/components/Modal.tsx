import { useEffect } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  // Optional footer slot — typically Save/Cancel buttons. Body
  // scroll happens between header and footer.
  footer?: React.ReactNode
  width?: number
}

export function Modal({ title, onClose, children, footer, width = 520 }: ModalProps) {
  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: width, maxHeight: '90vh',
          background: 'var(--bg-1)',
          border: '1px solid var(--border-1)',
          borderRadius: 12,
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-0)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <h2 style={{
            fontFamily: 'var(--font-display)', fontSize: 18,
            margin: 0, color: 'var(--text-0)',
          }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--text-2)', cursor: 'pointer',
              padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center',
            }}
            aria-label="Close"
          ><X size={18} /></button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
        {footer && (
          <div style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border-0)',
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
