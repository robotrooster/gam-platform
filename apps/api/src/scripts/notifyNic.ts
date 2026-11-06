/**
 * S553: out-of-band notification to Nic via Resend — used by autonomous
 * runs (overnight eval → push chains) so completion/failure reaches him
 * away from the computer. Invoked as:
 *
 *   npm run notify:nic -- "<subject>" "<body text | path to a text file>"
 *
 * If the second arg is a readable file path, its contents become the body
 * (lets long reports avoid shell-quoting). Uses the same .env the API
 * loads; sends regardless of EMAIL_SEND_LIVE — this is an operator
 * notification, not customer mail.
 */

import fs from 'fs'
import '../db' // loads apps/api/.env via dotenv
import { Resend } from 'resend'

async function main() {
  const [subject, bodyArg] = process.argv.slice(2)
  if (!subject || !bodyArg) {
    console.error('usage: npm run notify:nic -- "<subject>" "<body or file path>"')
    process.exit(1)
  }
  const text = fs.existsSync(bodyArg) ? fs.readFileSync(bodyArg, 'utf8') : bodyArg
  const resend = new Resend(process.env.RESEND_API_KEY)
  const from = process.env.EMAIL_FROM_SUPPORT || process.env.EMAIL_FROM_NOREPLY || ''
  // 11/5 (Nic): ONE address, not two. "You keep emailing both of my emails. I
  // don't know why I need two copies. That just wastes a lot of room in our
  // resend amounts. I only need one email thread to one of the emails."
  //
  // realestaterhoades@gmail.com is the one: it is his account of record in GAM,
  // so operator mail lands in the same thread as everything else the platform
  // sends him. Changing it is this one line.
  const r = await resend.emails.send({
    from,
    to: ['realestaterhoades@gmail.com'],
    subject,
    text,
  })
  if ((r as any)?.error) {
    console.error('FAILED:', JSON.stringify((r as any).error))
    process.exit(1)
  }
  console.log('sent:', JSON.stringify((r as any)?.data ?? r))
}

main().catch((e) => { console.error('FAILED:', e?.message); process.exit(1) })
