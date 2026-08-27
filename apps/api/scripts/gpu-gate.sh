#!/bin/bash
# S626 — the gate that should have existed before the third kernel panic.
#
# The Mac Studio has now panicked three times with
#   panic(cpu N): "completeMemory() prepare count underflow" @IOGPUMemory.cpp:550
# every time under sustained 36B inference, and that machine also serves
# production Postgres and the live API.
#
# WHY LOAD AVERAGE IS THE WRONG GATE, which is the mistake this replaces.
# S626 paced every job at 5s, never ran two model jobs at once, and checked
# `uptime` between every block exactly as the handoff said. Load sat at 2-3 the
# entire time and never once warned. Then the machine panicked after ~80 minutes
# of near-continuous inference. The bug is a GPU memory refcount leak that
# accumulates with CUMULATIVE ALLOCATION CHURN — load average cannot see it, so
# checking load and proceeding was false confidence dressed up as caution.
#
# What actually matters is IDLE TIME BETWEEN JOBS and MINUTES RUN PER HOUR.
# Both are tracked here, on disk, so they survive a crash and a new session.
#
#   bash apps/api/scripts/gpu-gate.sh acquire   # blocks until it is safe to run
#   bash apps/api/scripts/gpu-gate.sh release   # ALWAYS call when the job ends
#   bash apps/api/scripts/gpu-gate.sh status
#
set -uo pipefail

STATE_DIR="${GPU_GATE_STATE:-$HOME/.gam-gpu-gate}"
mkdir -p "$STATE_DIR"
LAST_END="$STATE_DIR/last-end"       # epoch seconds the previous job finished
LEDGER="$STATE_DIR/ledger"           # "epoch_start epoch_end" per completed job
RUNNING="$STATE_DIR/running"         # epoch seconds the current job started

MIN_IDLE_SEC="${GPU_MIN_IDLE_SEC:-600}"      # 10 minutes of genuine silence
MAX_MIN_PER_HOUR="${GPU_MAX_MIN_PER_HOUR:-30}"
MAX_LOAD="${GPU_MAX_LOAD:-6.0}"
now() { date +%s; }

# Minutes of GPU work recorded in the last rolling hour.
minutes_last_hour() {
  local cutoff=$(( $(now) - 3600 )) total=0 s e
  [ -f "$LEDGER" ] || { echo 0; return; }
  while read -r s e; do
    [ -z "${e:-}" ] && continue
    [ "$e" -lt "$cutoff" ] && continue
    [ "$s" -lt "$cutoff" ] && s=$cutoff
    total=$(( total + e - s ))
  done < "$LEDGER"
  echo $(( total / 60 ))
}

load_now() { uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/'; }

# ── HARD STOP, S626 ────────────────────────────────────────────────────────
# Two kernel panics in 71 minutes, both DURING a run rather than between runs.
# GPU work on this machine is disabled until Nic clears it. Delete this block,
# or set GPU_GATE_OVERRIDE=1, to re-enable — deliberately a decision somebody
# has to make on purpose.
if [ "${1:-status}" = "acquire" ] && [ "${GPU_GATE_OVERRIDE:-0}" != "1" ]; then
  echo "✗ GPU WORK IS DISABLED (S626 hard stop)."
  echo "  Panics 2026-08-27 10:05 and 11:16, both mid-run. The pacing gate did"
  echo "  not prevent either, because the smallest useful unit of GPU work here"
  echo "  — one eval, ~26 minutes of continuous inference — is already longer"
  echo "  than the machine survives. Idle gaps between jobs cannot fix that."
  echo "  Re-enable only with a deliberate GPU_GATE_OVERRIDE=1."
  exit 3
fi

case "${1:-status}" in
  acquire)
    if [ -f "$RUNNING" ]; then
      echo "✗ a GPU job is already marked running (started $(date -r "$(cat "$RUNNING")" '+%H:%M:%S'))."
      echo "  ONE MODEL JOB AT A TIME. If that job died, run: $0 release"
      exit 1
    fi
    while :; do
      idle=$(( $(now) - $( [ -f "$LAST_END" ] && cat "$LAST_END" || echo 0 ) ))
      [ "$idle" -gt 86400 ] && idle=86400
      mins=$(minutes_last_hour)
      load=$(load_now)
      reason=""
      [ "$idle" -lt "$MIN_IDLE_SEC" ] && reason="only ${idle}s idle since the last job (need ${MIN_IDLE_SEC}s)"
      [ "$mins" -ge "$MAX_MIN_PER_HOUR" ] && reason="${mins} GPU minutes used in the last hour (cap ${MAX_MIN_PER_HOUR})"
      awk -v l="$load" -v m="$MAX_LOAD" 'BEGIN{exit !(l>m)}' && reason="load ${load} is above ${MAX_LOAD}"
      if [ -z "$reason" ]; then
        echo "✓ clear to run — ${idle}s idle, ${mins}/${MAX_MIN_PER_HOUR} GPU min this hour, load ${load}"
        now > "$RUNNING"; exit 0
      fi
      echo "  waiting: $reason"
      sleep 60
    done
    ;;
  release)
    [ -f "$RUNNING" ] || { echo "nothing was marked running"; exit 0; }
    s=$(cat "$RUNNING"); e=$(now)
    echo "$s $e" >> "$LEDGER"; echo "$e" > "$LAST_END"; rm -f "$RUNNING"
    echo "✓ released — that job ran $(( (e - s) / 60 ))m$(( (e - s) % 60 ))s. Next job waits ${MIN_IDLE_SEC}s."
    ;;
  status)
    idle=$(( $(now) - $( [ -f "$LAST_END" ] && cat "$LAST_END" || echo 0 ) ))
    [ "$idle" -gt 86400 ] && idle=86400
    echo "running:        $( [ -f "$RUNNING" ] && echo "YES since $(date -r "$(cat "$RUNNING")" '+%H:%M:%S')" || echo no )"
    echo "idle since last: ${idle}s (need ${MIN_IDLE_SEC}s)"
    echo "GPU min this hr: $(minutes_last_hour)/${MAX_MIN_PER_HOUR}"
    echo "load:            $(load_now) (max ${MAX_LOAD})"
    ;;
  *) echo "usage: $0 {acquire|release|status}"; exit 2 ;;
esac
