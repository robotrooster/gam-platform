import { Link, useSearchParams } from 'react-router-dom'

// Stripe redirects here after a successful invoice payment from the customer
// portal. Confirms the payment and links back to the token-scoped account.
export function InvoicePaidPage() {
  const [params] = useSearchParams()
  const invoice = params.get('invoice')
  const token = params.get('token')

  return (
    <div style={{ maxWidth: 460, margin: '64px auto', padding: 24, textAlign: 'center', color: 'var(--text-0,#e8edf7)', fontFamily: 'system-ui' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>Payment received</h1>
      <div style={{ color: 'var(--text-2,#8b97b3)', marginBottom: 20 }}>
        {invoice ? <>Invoice <b>{invoice}</b> has been paid. A receipt is on its way to your email.</>
                 : <>Your payment was received. A receipt is on its way to your email.</>}
      </div>
      {token && (
        <Link to={`/account/${token}`} style={{ display: 'inline-block', padding: '11px 22px', borderRadius: 8, background: '#5b8cff', color: '#fff', textDecoration: 'none', fontWeight: 700 }}>
          Back to your account
        </Link>
      )}
    </div>
  )
}
