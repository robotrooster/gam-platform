#!/usr/bin/env bash
#
# 11/5 (Nic) — THE TUNNEL KEEPS ITSELF CURRENT, AND SAYS SO EITHER WAY.
#
#   "Do you have to do the update or can you build something that automatically
#    keeps it up to date? ...whatever you think's quick and easy, but keeps us
#    knowing about stuff versus being in the dark."
#
# WHY THIS EXISTS. On 11/5 Cloudflare published an advisory: eight eMudhra
# (emSign) intermediate certificate authorities had weak private keys, and every
# cloudflared before 2026.10.2 still trusts them. GAM was running 2026.6.1 —
# four months stale — and nobody knew, because the tunnel runs with
# `--no-autoupdate` and Homebrew never upgrades anything on its own. The whole
# public face of GAM rides that one process: the marketing site, every portal,
# and the API.
#
# WHY NOT cloudflared's OWN AUTO-UPDATE. Dropping `--no-autoupdate` is the
# obvious fix and it is the wrong one here: cloudflared's self-update downloads
# and overwrites its own binary, and this binary belongs to Homebrew. The two
# fight, and the loser is a tunnel that will not start. So the update stays with
# the package manager that owns the file, and this script drives it.
#
# WHAT IT DOES, nightly: if a newer cloudflared exists, upgrade it, restart the
# tunnel onto it, and then PROVE the public side came back before calling it
# done. Nic is told when something happened and when something broke — never
# when nothing did, because a nightly "all fine" email is one nobody reads.
#
# IT VERIFIES RATHER THAN ASSUMES. The restart is the only risky second of this,
# so the script does not trust `brew upgrade` saying OK: it asks the real public
# hostnames for a real status code, the same check used by hand on 11/5.
#
# IT DOES NOT ROLL BACK. Homebrew keeps the previous version in the Cellar, so a
# rollback is one command by hand. Automating it means writing clever recovery
# that itself runs unattended at four in the morning, which is how a small
# problem becomes an outage. If the tunnel does not come back, this shouts and
# stops.
#
#   deploy/cloudflared-guard.sh --check    report only; exit 1 if behind
#   deploy/cloudflared-guard.sh            upgrade if behind, restart, verify, notify
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.gam.tunnel"
BREW="/opt/homebrew/bin/brew"
CLOUDFLARED="/opt/homebrew/bin/cloudflared"
# What has to answer afterwards. The API's root is a 404 by design, so its
# health endpoint is the one asked.
CHECKS=(
  "https://goldassetmanagement.com/|200"
  "https://api.goldassetmanagement.com/health|200"
)

installed_version(){ "$CLOUDFLARED" --version 2>/dev/null | awk '{print $3}'; }

# Every hostname answering what it should. Prints what failed; silent on success.
public_is_up(){
  local bad=0
  for c in "${CHECKS[@]}"; do
    local url="${c%|*}" want="${c#*|}"
    local got
    got="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$url" 2>/dev/null)"
    if [ "$got" != "$want" ]; then
      echo "  $url -> HTTP $got (expected $want)"
      bad=1
    fi
  done
  return $bad
}

# Reuses the deploy's own mail path (apps/api notifyNic). A mail failure never
# changes this script's result — the same rule deploy.sh follows.
tell_nic(){
  local subject="$1" body_file="$2"
  (cd "$REPO/apps/api" && npm run -s notify:nic -- "$subject" "$body_file") >/dev/null 2>&1 \
    && echo "emailed: $subject" \
    || echo "could not email: $subject"
}

HAVE="$(installed_version)"
if [ -z "$HAVE" ]; then
  echo "cloudflared is not installed at $CLOUDFLARED"
  exit 2
fi

# `brew outdated` is the whole comparison — no version parsing to get wrong, and
# it is the same source the upgrade will act on.
"$BREW" update --quiet >/dev/null 2>&1
if ! "$BREW" outdated --quiet cloudflared 2>/dev/null | grep -q '^cloudflared$'; then
  echo "cloudflared $HAVE is current"
  exit 0
fi

WANT="$("$BREW" info --quiet cloudflared 2>/dev/null | head -1 | sed -n 's/.*stable \([0-9.]*\).*/\1/p')"
echo "cloudflared $HAVE is behind${WANT:+ (newest: $WANT)}"

if [ "${1:-}" = "--check" ]; then
  exit 1
fi

REPORT="$(mktemp -t cloudflared-guard)"
{
  echo "The Cloudflare tunnel was behind and has been updated."
  echo
  echo "  was:  $HAVE"
} > "$REPORT"

if ! "$BREW" upgrade cloudflared >>"$REPORT" 2>&1; then
  { echo; echo "The upgrade itself failed. The tunnel was NOT restarted and is still"
    echo "running $HAVE, so the public sites are unaffected — but the version is"
    echo "still stale and needs a look."; } >> "$REPORT"
  cat "$REPORT"
  tell_nic "GAM tunnel — update FAILED, still on $HAVE" "$REPORT"
  exit 1
fi

NOW="$(installed_version)"
echo "  now:  $NOW" >> "$REPORT"

# The restart. KeepAlive on the launchd job brings it straight back on the new
# binary; kickstart -k is the supported way to ask for exactly that.
launchctl kickstart -k "gui/$(id -u)/$LABEL" >>"$REPORT" 2>&1
sleep 10

# Up to a minute for the tunnel to re-register with Cloudflare's edge before
# this is called a failure — a cold tunnel takes a few seconds to pick up its
# routes, and declaring an outage early would be worse than waiting.
OK=1
for _ in 1 2 3 4 5 6; do
  if FAILURES="$(public_is_up)"; then OK=0; break; fi
  sleep 8
done

if [ "$OK" -eq 0 ]; then
  { echo; echo "The tunnel restarted and every public address answered."; } >> "$REPORT"
  cat "$REPORT"
  tell_nic "GAM tunnel updated to $NOW" "$REPORT"
  exit 0
fi

{ echo
  echo "THE TUNNEL DID NOT COME BACK. The public sites are not answering:"
  echo "$FAILURES"
  echo
  echo "Nothing was rolled back. The previous version is still in Homebrew's"
  echo "Cellar, so going back is:"
  echo
  echo "  brew unlink cloudflared && brew link --overwrite cloudflared@$HAVE"
  echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
  echo
  echo "Or just re-run the restart first — the job keeps retrying on its own."
} >> "$REPORT"
cat "$REPORT"
tell_nic "GAM TUNNEL DOWN after updating to $NOW" "$REPORT"
exit 1
