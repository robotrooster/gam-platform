#!/usr/bin/env bash
# S628 — run the two-turn conversations ONE AT A TIME, slowly.
#
# Nic: "do it extremely slow to not overcook the computer... one conversation at
# a time... over the next hour or hour and a half."
#
# One conversation PER PROCESS, not one process running all of them. The panics
# came from sustained continuous allocation against the 36B; a process that
# starts, does two generations, and exits leaves the GPU genuinely idle in
# between rather than merely paused inside a long-lived job. The S626 note is
# explicit that idle gaps cannot protect a job longer than the box survives —
# so the answer is to not have a long job.
#
#   bash scripts/slow-conversations.sh [sleep-seconds]
set -uo pipefail
cd "$(dirname "$0")/.."
SLEEP="${1:-90}"
LOG=/tmp/conversations.log
touch "$LOG"   # append across resumes; the transcripts are the record

# Optional second arg: a space-separated list of ids to run instead of all.
# Used to resume after the model server aborted mid-run (Metal GPU OOM), and to
# re-queue whatever ran during the outage.
if [ -n "${2:-}" ]; then
  IDS="$2"
else
IDS=$(node -e "
require('ts-node').register({transpileOnly:true,compilerOptions:{module:'commonjs'}});
const {ALL_CONVERSATIONS}=require('./src/services/agents/agentConversationCases');
console.log(ALL_CONVERSATIONS.map(c=>c.id).join(' '));")
fi

TOTAL=$(echo "$IDS" | wc -w | tr -d ' ')
# WAIT FOR THE MODEL BEFORE THE FIRST CONVERSATION.
# Resuming at 15:01 while the server was still coming back from an OOM cost a
# conversation to a dead endpoint — and an outage transcript looks exactly like
# an agent that refused to call its tools, which is the wrong conclusion to draw
# from a real-looking failure.
for _ in $(seq 1 60); do
  curl -sf -m 3 -o /dev/null http://localhost:8080/v1/models && break
  sleep 2
done
curl -sf -m 3 -o /dev/null http://localhost:8080/v1/models \
  || { echo "model endpoint down — refusing to start" | tee -a "$LOG"; exit 1; }

echo "═══ $TOTAL conversations, one at a time, ${SLEEP}s between ═══" | tee -a "$LOG"
echo "started $(date '+%H:%M:%S')" | tee -a "$LOG"

N=0
for ID in $IDS; do
  N=$((N+1))
  echo "" >> "$LOG"
  echo "───────── [$N/$TOTAL] $ID  $(date '+%H:%M:%S') ─────────" >> "$LOG"
  # AGENT_EVAL_PAUSE_MS=0: there is only one conversation in this process, so
  # the harness's own inter-case pause has nothing to pace.
  AGENT_EVAL_PAUSE_MS=0 DB_NAME=gam AGENT_TWO_PASS="${AGENT_TWO_PASS:-0}" \
    npx ts-node src/services/agents/agentConversations.ts "$ID" \
    >> "$LOG" 2>&1
  # Was the machine still alive? A panic takes the whole box, so this line not
  # appearing is itself the signal.
  echo "[$N/$TOTAL] done $(date '+%H:%M:%S')  load:$(uptime | sed 's/.*averages: //')" >> "$LOG"
  # BOUNCE THE MODEL EVERY FEW CONVERSATIONS.
  #
  # mlx_lm.server grows its prompt cache ~5.5 GB per sequence and never evicts:
  # 0, 5.5, 11.0 … 49.9, then Metal command-buffer OOM and launchd restarts it
  # at 0. On a 96 GB box with a 27.7 GB model and a ~72 GB GPU wired limit, that
  # lands every ninth conversation.
  #
  # --prompt-cache-bytes LOOKS like the fix and is not. It is applied at
  # server.py:795, inside the BATCHED path only. These requests are single and
  # sequential, so they take _serve_single and never reach the trim — the cap
  # was set to 16 GiB and the cache still reached 44.7 GB.
  #
  # So reset it deliberately rather than by crashing. Same effect, chosen
  # moment, and no conversation is lost to an outage mid-generation. Patching
  # mlx-lm is the real fix and is not something to do in the middle of a test
  # run.
  if [ $((N % 10)) -eq 0 ] && [ "$N" -lt "$TOTAL" ]; then
    echo "[cache] bouncing the model after $N conversations" >> "$LOG"
    launchctl bootout "gui/$(id -u)/com.gam.model" 2>/dev/null
    sleep 3
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gam.model.plist"
    for _ in $(seq 1 40); do
      curl -sf -m 3 -o /dev/null http://localhost:8080/v1/models && break
      sleep 2
    done
    echo "[cache] model back at $(date '+%H:%M:%S')" >> "$LOG"
  fi
  [ "$N" -lt "$TOTAL" ] && sleep "$SLEEP"
done
echo "" >> "$LOG"
echo "═══ finished $(date '+%H:%M:%S') ═══" >> "$LOG"
