// E-sign signer accounts (S568, Nic). A landlord can only send an e-sign
// document to someone with a GAM account — never to a raw email. When the
// recipient isn't already a GAM user, we mint a free lightweight 'contact'
// account (the customer/contact pool — no landlord/tenant profile) and invite
// them to activate it. Requiring account activation before they can view or
// sign is the anti-spam / consent gate.
import crypto from 'crypto'
import bcrypt from 'bcryptjs'

type Client = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }

export interface ResolvedSigner {
  userId: string
  created: boolean          // true when a new contact account was minted
  inviteToken: string | null // set only when created — used to send the activation invite
  email: string
  name: string
}

/**
 * Resolve a signer to a GAM account by email, creating a lightweight 'contact'
 * account (in a transaction, via the passed client) when none exists. Existing
 * users of ANY role are reused as-is (a tenant/landlord signing a contract keeps
 * their role). Returns the userId + whether a fresh contact was minted (so the
 * caller can send the activation invite email post-commit).
 */
export async function resolveOrCreateSignerUser(
  client: Client,
  opts: { email: string; name: string; phone?: string | null },
): Promise<ResolvedSigner> {
  const email = opts.email.trim().toLowerCase()
  const name = opts.name.trim()

  const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [email])
  if (existing.rows.length) {
    return { userId: existing.rows[0].id, created: false, inviteToken: null, email, name }
  }

  const [first, ...rest] = name.split(/\s+/)
  const last = rest.join(' ')
  const inviteToken = crypto.randomBytes(32).toString('hex')
  // No usable password until they activate; store an unguessable random hash.
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10)

  // Store the invite on tenant_invite_token so the EXISTING e-sign send flow
  // (which reads tenant_invite_token to route unactivated signers through
  // /accept-invite → /sign) works for contacts unchanged. accept-invite is
  // role-aware, so activating stamps a 'contact' JWT, not a tenant one.
  const created = await client.query(
    `INSERT INTO users
       (email, password_hash, role, first_name, last_name, phone,
        email_verified, tenant_invite_token, tenant_invite_expires_at)
     VALUES ($1,$2,'contact',$3,$4,$5, FALSE, $6, NOW() + INTERVAL '14 days')
     RETURNING id`,
    [email, placeholderHash, first || name, last, opts.phone ?? null, inviteToken],
  )
  return { userId: created.rows[0].id, created: true, inviteToken, email, name }
}
