/**
 * 10/19 (Nic): "I said wipe him because he signed up for the wrong thing.
 * We're not deleting stuff that's meant to be real history. He is a tenant. He
 * wanted to do the background check. He got sent the wrong link. He will never,
 * ever be a landlord. There's a difference between correcting mistakes and
 * altering legitimate history."
 *
 * Jacob Harmon was sent a LANDLORD signup link when he meant to apply as a
 * renter at Oak Park, and became a landlord account with no properties on
 * 10/19 at 11:05. The account is the mistake, not a record of anything that
 * happened, so it goes — and the address is freed so he can apply cleanly
 * through the property's own application link.
 *
 * WHAT IS KEPT, deliberately: the email GAM sent Nic ("New landlord signup —
 * Jacob Harmon") really was sent, so that row stays and only its pointer to
 * the dead company is cleared.
 *
 * CORRECTION, measured after the run: I had written here that the DELETEs
 * would be caught by the row-change journal. They are NOT. audit_row_changes
 * is on the tables that hold money (see CLAUDE.md), and `users` and
 * `landlords` carry no such trigger — the journal was empty afterwards. So the
 * account is gone with no row-level trace, and the email record above is the
 * only thing left that says this signup ever happened. That is the right
 * outcome for a mis-click, but nobody should read this file believing there is
 * an undo behind it.
 *
 * Checked first: the onboarding-call link was never clicked (click_count 0,
 * never used), so there is no appointment to cancel and nobody to tell.
 *
 *   npx ts-node -T src/scripts/oct19_undo_jacob_harmon_landlord_signup.ts           (dry run)
 *   npx ts-node -T src/scripts/oct19_undo_jacob_harmon_landlord_signup.ts --apply
 */
import { getClient, query } from '../db'

const APPLY = process.argv.includes('--apply')
const USER = 'f960fb33-357c-40bd-b337-531c748091a6'
const COMPANY = '004e02bb-269c-4d37-ac6c-a79998f77c04'

async function picture(label: string) {
  const u = await query<any>(`SELECT first_name, last_name, email, role FROM users WHERE id = $1`, [USER])
  const la = await query<any>(`SELECT id FROM landlords WHERE id = $1`, [COMPANY])
  const counts = await query<any>(`
    SELECT (SELECT COUNT(*) FROM landlord_members WHERE user_id = $1 OR landlord_id = $2)::int AS members,
           (SELECT COUNT(*) FROM landlord_onboarding_booking_tokens WHERE user_id = $1 OR landlord_id = $2)::int AS tokens,
           (SELECT COUNT(*) FROM login_email_otps WHERE user_id = $1)::int AS otps,
           (SELECT COUNT(*) FROM email_send_log WHERE landlord_id = $2)::int AS emails_pointing_at_company,
           (SELECT COUNT(*) FROM properties WHERE landlord_id = $2)::int AS properties`, [USER, COMPANY])
  const c = counts[0]
  console.log(`\n── ${label} ──`)
  console.log(`  account: ${u[0] ? `${u[0].first_name} ${u[0].last_name} <${u[0].email}> role ${u[0].role}` : 'gone'}`)
  console.log(`  company: ${la.length ? COMPANY : 'gone'} · properties on it ${c.properties}`)
  console.log(`  memberships ${c.members} · onboarding links ${c.tokens} · sign-in codes ${c.otps}`)
  console.log(`  email records still pointing at the company: ${c.emails_pointing_at_company}`)
  const free = await query<any>(`SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = '7jacobharmon7@gmail.com'`)
  console.log(`  7jacobharmon7@gmail.com taken by ${free[0].n} account(s) — ${free[0].n === 0 ? 'FREE to sign up' : 'still taken'}`)
}

async function main() {
  // A company with a property on it is somebody's real operation, never a
  // mis-click. Refuse rather than take a guess.
  const props = await query<any>(`SELECT name FROM properties WHERE landlord_id = $1`, [COMPANY])
  if (props.length) throw new Error(`that company owns ${props.length} property(ies) — not a bad signup, stopping`)

  await picture('BEFORE')
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Pass --apply.'); process.exit(0) }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    // The email was really sent: keep the row, drop only its pointer.
    const kept = await client.query(`UPDATE email_send_log SET landlord_id = NULL WHERE landlord_id = $1`, [COMPANY])
    const otps = await client.query(`DELETE FROM login_email_otps WHERE user_id = $1`, [USER])
    const toks = await client.query(`DELETE FROM landlord_onboarding_booking_tokens WHERE user_id = $1 OR landlord_id = $2`, [USER, COMPANY])
    const mems = await client.query(`DELETE FROM landlord_members WHERE user_id = $1 OR landlord_id = $2`, [USER, COMPANY])
    const cos  = await client.query(`DELETE FROM landlords WHERE id = $1`, [COMPANY])
    const usr  = await client.query(`DELETE FROM users WHERE id = $1`, [USER])
    await client.query('COMMIT')
    console.log(`\n  email records kept, pointer cleared: ${kept.rowCount}`)
    console.log(`  removed — sign-in codes ${otps.rowCount}, onboarding links ${toks.rowCount}, ` +
      `memberships ${mems.rowCount}, company ${cos.rowCount}, account ${usr.rowCount}`)
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

  await picture('AFTER')
  console.log('\nAPPLIED — he can now apply through the Oak Park application link on that same address.')
  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
