#!/bin/bash
# S624 — run the agent eval and refuse to call a REGRESSION a pass.
#
# The eval prints a score. A score you have to remember is not a baseline, and
# this session proved it: 42/45 -> 38/45 -> 9/45 across three prompt edits, each
# one invisible in a diff and none of them caught until someone re-ran it by
# hand. Prompt changes cannot be unit-tested and they degrade tool selection
# quietly, so the only guard is a number compared against a recorded one.
#
#   bash apps/api/scripts/check-agent-eval.sh
#
# Exits non-zero if the score dropped below the baseline. Run it after ANY
# change to profiles.ts, a tool description, or the knowledge base.
set -uo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE=src/services/agents/EVAL_BASELINE.json
LOG=/tmp/gam-agent-eval-$(date +%H%M%S).log

baseline=$(node -e "console.log(require('./$BASELINE_FILE').passing)")
total=$(node -e "console.log(require('./$BASELINE_FILE').total)")

echo "── agent eval (baseline $baseline/$total) ──"
npm run agents:eval > "$LOG" 2>&1

line=$(grep -oE '[0-9]+/[0-9]+ passed' "$LOG" | tail -1)
score=${line%%/*}

if [ -z "$score" ]; then
  echo "✗ eval produced no score — see $LOG"
  exit 1
fi

echo "   scored $line"
grep -E "^  ✗" "$LOG" | sed 's/^/   /'

if [ "$score" -lt "$baseline" ]; then
  echo
  echo "✗ REGRESSION: $score < baseline $baseline."
  echo "  Revert the change, or fix it — do not stack another change on top of"
  echo "  an unmeasured one. That is how this went from 42 to 9."
  echo "  Full log: $LOG"
  exit 1
fi

if [ "$score" -gt "$baseline" ]; then
  echo
  echo "✓ improved: $score > baseline $baseline. Update $BASELINE_FILE in this commit."
fi
exit 0
