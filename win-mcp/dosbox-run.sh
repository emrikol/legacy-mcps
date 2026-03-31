#!/bin/bash
# Singleton DOSBox-X launcher
# Ensures only one instance runs at a time.
# Usage: ./dosbox-run.sh [dosbox-x-binary] [conf-file]
#
# Kills any previous instance (tracked by PID file), starts a new one,
# saves the PID. Exits immediately (DOSBox-X runs in background).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="${SCRIPT_DIR}/.dosbox.pid"
DOSBOX="${1:-${SCRIPT_DIR}/../tools/dosbox-x}"
CONF="${2:-${SCRIPT_DIR}/dosbox-test.conf}"

# Kill existing instance if running
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Killing existing DOSBox-X (PID $OLD_PID)..."
        kill -9 "$OLD_PID" 2>/dev/null
        sleep 1
    fi
    rm -f "$PIDFILE"
fi

# Also kill any stray dosbox-x processes from our tools dir
pkill -f "tools/dosbox-x" 2>/dev/null

# Start new instance with control server enabled
cd "$SCRIPT_DIR"
DOSBOX_CONTROL_PORT="${DOSBOX_CONTROL_PORT:-10199}" "$DOSBOX" -conf "$CONF" &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
echo "DOSBox-X started (PID $NEW_PID)"
