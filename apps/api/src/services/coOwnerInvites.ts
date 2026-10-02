/**
 * Co-owner invitations: accepting one, and claiming one when an address is proven.
 *
 * S605 (Nic): a partner is invited to a company by email and becomes an owner of
 * it. S637 (Nic, on Dusty Rhoades): somebody invited who REGISTERS instead of
 * clicking the link must still end up an owner of the company they were invited
 * to, with no blank company of their own beside it.
 *
 * S655 SECURITY — THE CLAIM WAITS FOR PROOF OF THE ADDRESS.
 *
 * Registration used to accept the invitation inside the same transaction that
 * created the account, before anything proved the person owned the address. So
 * anybody who knew an invited address could register it first: the database
 * then recorded an account whose password THEY chose as an owner of the
 * company, and the real partner's link said "already used". What kept them out
 * was only the emailed code at sign-in — the wrong gate, and one a future
 * sign-in method (Google/Apple, a remembered device) would open.
 *
 * Registration now claims nothing. The claim happens at the step that proves
 * the address: the emailed code (routes/emailOtp.ts), or a reset/verification
 * link from that inbox (routes/auth.ts). For a real invitee that is seconds
 * after the form, on the same screen, so nothing they see changes.
 */
import type { PoolClient } from 'pg'
import { db } from '../db'
import { PLATFORM_FEE_GRACE_CYCLES, MIGRATION_WINDOW_DAYS } from '@gam/shared'
import { forgetMembership } from '../middleware/auth'

export interface CoOwnerInvitationRow {
  id: string
  landlord_id: string
  invited_by_user_id: string | null
}

/**
 * The company a brand-new landlord account gets. Moved out of /register so the
 * same company can be made later, when an invited signup's invitation turned
 * out to be gone by the time the address was proven.
 */
export async function createFoundingLandlordEntity(
  client: PoolClient,
  args: { userId: string; closerId: string | null; referredByUserId: string | null; businessName?: string | null },
): Promise<string> {
  // S568: open the onboarding reconciliation window (21 days). While it's open
  // the landlord can mark a tenant's FIRST GAM invoice paid off-platform
  // (old-system autopay overlap during a migration) — see landlords.reconciliation_until.
  // S600: open the no-double-bill onboarding grace. billing_starts_at stays NULL
  // (not billed) until the landlord goes live — first settled rent flips it
  // (webhooks.ts), else the grace-cap cron flips it at billing_grace_until:
  // first-of-month(signup) + PLATFORM_FEE_GRACE_CYCLES full cycles.
  // Superadmin-extendable for long large-portfolio setups.
  // S624: migration_window_ends_at MUST be set here. It was not, and a NULL read
  // as "window open forever" in the screening gate — so every landlord who
  // signed up after the S623 backfill had the background-check requirement
  // silently disabled for life, in contradiction of the published Terms (§9.2).
  const { rows: [l] } = await client.query<{ id: string }>(
    `INSERT INTO landlords (user_id, portfolio_manager_id, referred_by_user_id, reconciliation_until, billing_grace_until,
                            business_name, ein, migration_window_ends_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '21 days',
             (date_trunc('month', NOW()) + ($4::int * INTERVAL '1 month'))::date,
             $5, $6, NOW() + ($7::int * INTERVAL '1 day')) RETURNING id`,
    [args.userId, args.closerId, args.referredByUserId, PLATFORM_FEE_GRACE_CYCLES,
     args.businessName ?? null, null, MIGRATION_WINDOW_DAYS])
  // S553: founding owner-membership (multi-owner entities).
  await client.query(
    `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (landlord_id, user_id) DO NOTHING`,
    [l.id, args.userId])
  return l.id
}

/**
 * Make `userId` an owner of the invitation's company and mark it accepted.
 * The caller has already checked that the invitation is live and that it is
 * addressed to this account. Moved unchanged from
 * POST /landlords/member-invite/:token/accept so the link and the proven-address
 * claim do exactly the same thing.
 */
export async function acceptCoOwnerInvitation(
  client: PoolClient, inv: CoOwnerInvitationRow, userId: string,
): Promise<void> {
  // The companies this account owned BEFORE accepting — the wizard rule below
  // is about them, never about the company being joined.
  const before = (await client.query<{ landlord_id: string }>(
    `SELECT landlord_id FROM landlord_members WHERE user_id = $1
     UNION
     SELECT id           FROM landlords        WHERE user_id = $1`, [userId]))
    .rows.map(r => r.landlord_id).filter(id => id !== inv.landlord_id)

  await client.query(
    `INSERT INTO landlord_members (landlord_id, user_id, role, added_by_user_id)
     VALUES ($1, $2, 'owner', $3) ON CONFLICT (landlord_id, user_id) DO NOTHING`,
    [inv.landlord_id, userId, inv.invited_by_user_id ?? null])
  await client.query(
    `UPDATE landlord_member_invitations
        SET status='accepted', accepted_at=now(), accepted_user_id=$2, updated_at=now()
      WHERE id=$1`, [inv.id, userId])

  // S592, restored at the point of consent (S654, Nic): "I added them as a
  // co-owner. They opted to put their own other properties on the software.
  // They only found out about it because of me. So therefore I am the
  // referrer." A co-owner with no upline of their own becomes the downline of
  // the company's founding owner — only when THEY accept. First-touch wins (an
  // existing upline is never changed); a founding owner accepting into their
  // own company is a no-op.
  const founding = (await client.query<{ user_id: string }>(
    `SELECT user_id FROM landlords WHERE id = $1`, [inv.landlord_id])).rows[0]
  if (founding && founding.user_id !== userId) {
    await client.query(
      `UPDATE users SET referred_by_user_id = $1
        WHERE id = $2 AND referred_by_user_id IS NULL`,
      [founding.user_id, userId])
  }

  // S605 (Nic): "for him to just register, it would have tried to get him to
  // onboard his property, which is already onboarded because I've completed
  // Oak Park." The portal sends any landlord with onboarding_complete = false
  // to the wizard — so an invited co-owner would land in a five-step flow for a
  // company that owns nothing, to reach a property somebody else already set up.
  // S633: every company the account owns that holds no property. Each is judged
  // on its own properties, so a company that already has property keeps
  // whatever onboarding state it was in and a real onboarding is never skipped.
  if (before.length > 0) {
    await client.query(
      `UPDATE landlords l SET onboarding_complete = TRUE
        WHERE l.id = ANY($1::uuid[])
          AND l.onboarding_complete = FALSE
          AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = l.id)`,
      [before])
  }
}

/**
 * The address on `userId` was just proven (emailed code, reset link or
 * verification link). For a landlord account that belongs to NO company —
 * which is exactly what registering with an invited address leaves behind —
 * accept every live invitation to that address THAT WAS ALREADY WAITING WHEN
 * THE ACCOUNT WAS REGISTERED.
 *
 * That limit is the S654 consent rule. Registering with an invited address is
 * the person's consent to the invitations that made them register (S637); it
 * is not consent to whatever arrives later. A login can own no company for
 * other reasons — a co-owner removed from the only company they were in, or an
 * older account — and an invitation sent to it afterwards must not attach it
 * (and write the inviter in as its referrer) just because it signed in. Later
 * invitations are accepted the S654 way: from the link, while signed in.
 *
 * If none were claimed and this is the address's FIRST proof, the account gets
 * the company any other signup gets — unless an invitation to the address is
 * still live (one sent after registering), because then the person is joining
 * that company from its link and a blank company beside it is the S637 phantom.
 *
 * An account that already has a company is never touched: S654 says nobody is
 * attached to a company without their consent, and those people accept from
 * the link while signed in.
 *
 * S655: ONLY THE ADDRESS'S FIRST PROOF CLAIMS. The registration that the claim
 * stands in for ends at the first proof; every later sign-in is an ordinary
 * sign-in, and ordinary sign-ins attach nobody. The created_at limit below is
 * not enough on its own: re-sending an invitation refreshes its row in place
 * (new token and expiry, same created_at), so a lapsed invitation that predates
 * a company-less login came back to life on a re-send and that login's next
 * ordinary code sign-in accepted it — owner row, invitation marked accepted,
 * the inviter written in as referrer — without the link ever being opened.
 * After the first proof, every invitation is accepted the S654 way: from its
 * link, while signed in.
 *
 * (Local dev auto-verifies the address at /register, so there the first code
 * is not a first proof and an invited signup accepts from the link. Production
 * and the demo API run with NODE_ENV=production and always verify at the
 * code.)
 *
 * Returns the ids of the companies the account gained. Runs in its own
 * transaction; callers treat a failure as non-fatal (the link still works).
 */
export async function claimInvitationsOnProvenAddress(
  userId: string, opts: { firstVerification: boolean },
): Promise<string[]> {
  if (!opts.firstVerification) return []
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // Serializes two proofs racing for the same account.
    const user = (await client.query<{ email: string; role: string; referred_by_user_id: string | null }>(
      `SELECT email, role, referred_by_user_id FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0]
    if (!user || user.role !== 'landlord') { await client.query('COMMIT'); return [] }

    const owns = (await client.query(
      `SELECT 1 FROM landlord_members WHERE user_id = $1
       UNION ALL
       SELECT 1 FROM landlords        WHERE user_id = $1
       LIMIT 1`, [userId])).rows.length > 0
    if (owns) { await client.query('COMMIT'); return [] }

    // Only the invitations that were waiting when the account was registered
    // (see above). A re-sent invitation keeps its row and created_at
    // (createCoOwnerInvitation refreshes the pending row in place), so a resend
    // between the form and the code is still claimed.
    const invites = (await client.query<CoOwnerInvitationRow>(
      `SELECT i.id, i.landlord_id, i.invited_by_user_id
         FROM landlord_member_invitations i
        WHERE LOWER(i.email) = LOWER($1)
          AND i.status = 'pending'
          AND i.expires_at > now()
          AND i.created_at <= (SELECT created_at FROM users WHERE id = $2)
        ORDER BY i.created_at
        FOR UPDATE OF i`, [user.email, userId])).rows
    for (const inv of invites) await acceptCoOwnerInvitation(client, inv, userId)
    let gained = invites.map(i => i.landlord_id)

    const laterInviteWaiting = gained.length === 0
      && (await client.query(
        `SELECT 1 FROM landlord_member_invitations
          WHERE LOWER(email) = LOWER($1)
            AND status = 'pending'
            AND expires_at > now()
          LIMIT 1`, [user.email])).rows.length > 0

    if (gained.length === 0 && !laterInviteWaiting) {
      // S567: who referred this person was recorded on the account at signup
      // (users.referred_by_user_id). A landlord's code makes them the
      // referrer; a rep's code makes the rep the closing manager.
      let closerId: string | null = null
      let referredByUserId: string | null = null
      if (user.referred_by_user_id) {
        const ref = (await client.query<{ role: string }>(
          `SELECT role FROM users WHERE id = $1`, [user.referred_by_user_id])).rows[0]
        if (ref?.role === 'landlord') referredByUserId = user.referred_by_user_id
        else if (ref) closerId = user.referred_by_user_id
      }
      gained = [await createFoundingLandlordEntity(client, { userId, closerId, referredByUserId })]
    }
    await client.query('COMMIT')
    // After the commit: the next request must see the companies just gained.
    if (gained.length > 0) forgetMembership(userId)
    return gained
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
