#!/bin/bash
# S415: emergency cleanup of GAM dev processes.
#
# Use this when the test suite is hitting non-deterministic schema
# drift / connection-terminated errors, or when CPU is unexpectedly
# pegged. dev.sh's cleanup runs the same logic when you start a fresh
# dev session, but this is the standalone "I just want my machine
# back" version.
#
# What it kills:
#   1. Anything listening on a GAM port (3001-3011, 4000-4001)
#   2. ts-node-dev orphan parents — these survive port-kills because
#      lsof returns the child node PID, not the ts-node-dev parent,
#      and ts-node-dev's --respawn flag immediately spawns a new child
#   3. tsc --watch shared package watcher
#   4. Stray vitest processes from prior test runs
#
# Why this matters: in S414 the suite was running at ~1300s instead
# of its true ~65s baseline because 9 month-old ts-node-dev zombies
# were starving CPU. Killing them collapsed the runtime 20x.

echo "GAM kill-all: cleaning dev processes…"

# 1. Port-bound listeners
for port in 3001 3002 3003 3004 3005 3006 3007 3008 3009 3011 4000 4001; do
  pid=$(lsof -ti tcp:$port 2>/dev/null)
  if [ -n "$pid" ]; then
    kill -9 $pid 2>/dev/null && echo "  Killed :$port (pid $pid)"
  fi
done

# 2. ts-node-dev orphan parents
if pkill -f "ts-node-dev" 2>/dev/null; then
  echo "  Killed orphan ts-node-dev parents"
fi

# 3. Shared package tsc --watch
if pkill -f "tsc.*-b.*--watch" 2>/dev/null; then
  echo "  Killed prior shared watcher"
fi

# 4. Stray vitest
if pkill -f "vitest" 2>/dev/null; then
  echo "  Killed stray vitest processes"
fi

sleep 1

# Verify nothing leftover
remaining=$(pgrep -fl "ts-node-dev|tsc.*-b.*--watch|vitest" 2>/dev/null)
if [ -n "$remaining" ]; then
  echo ""
  echo "⚠ Still alive after kill:"
  echo "$remaining"
  exit 1
fi

echo "✓ Clean."
