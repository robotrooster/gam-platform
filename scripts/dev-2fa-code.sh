#!/usr/bin/env bash
# Dev 2FA login-code lookup (S594).
#
# Email-2FA is mandatory on every portal (S578), but dev SUPPRESSES real email
# sends to the seed domains (@tenant.dev / @demo.dev / @test.dev / @x.dev /
# @poser.dev / @gam.dev) — no code ever reaches those dead inboxes. The 6-digit
# code lives in the email SUBJECT, logged to email_send_log, so pull it from
# there. Works for ANY dev login. Submit the password in the UI FIRST (that
# generates the code), then run this.
#
#   Usage: bash scripts/dev-2fa-code.sh <login-email>
#   e.g.:  bash scripts/dev-2fa-code.sh alice@tenant.dev
set -euo pipefail
email="${1:-}"
if [ -z "$email" ]; then
  echo "usage: $0 <login-email>   (e.g. alice@tenant.dev)"
  exit 1
fi
db="${DB_NAME:-gam}"
esc="${email//\'/\'\'}"   # SQL-escape single quotes
row="$(psql "$db" -t -A -c \
  "SELECT subject FROM email_send_log WHERE to_email='${esc}' AND category='login_2fa_code' ORDER BY created_at DESC LIMIT 1;")"
if [ -z "$row" ]; then
  echo "No login code found for $email. Submit the password first (that generates the code), then re-run."
  exit 1
fi
echo "$row"   # e.g. "Your GAM sign-in code: 478874"
