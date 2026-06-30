import React from 'react'

// Shared error boundary (S508). Wrap the app root so a render error shows a
// contained fallback instead of a blank white screen, and wrap individual
// tiles/cards so one failing tile can't blank the whole portal.
// Theme-agnostic: uses CSS-var fallbacks so it renders in any portal.

interface Props { children: React.ReactNode; fallback?: React.ReactNode; label?: string }
interface State { hasError: boolean }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }
  static getDerivedStateFromError(): State { return { hasError: true } }
  componentDidCatch(error: unknown) {
    console.error('[ErrorBoundary]' + (this.props.label ? ' ' + this.props.label : ''), error)
  }
  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback
      return (
        <div style={{ padding: 16, margin: 8, border: '1px solid var(--border-1, #2a3040)', borderRadius: 10, background: 'var(--bg-2, #14171c)', color: 'var(--text-2, #aab1c2)', fontSize: '.85rem' }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0, #eef1f8)', marginBottom: 4 }}>Something went wrong here</div>
          <div style={{ marginBottom: 10 }}>This section failed to load. The rest of the page is unaffected.</div>
          <button onClick={() => this.setState({ hasError: false })} style={{ background: 'var(--gold, #c9a227)', color: '#0a0a0a', border: 'none', borderRadius: 7, padding: '6px 12px', fontSize: '.78rem', fontWeight: 700, cursor: 'pointer' }}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}
