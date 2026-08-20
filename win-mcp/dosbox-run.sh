#!/bin/bash
# Singleton DOSBox-X launcher
# Ensures only one instance runs at a time.
# Usage: ./dosbox-run.sh [dosbox-x-binary] [conf-file]
#
# Kills any previous instance (tracked by PID file), starts a new one,
# saves the PID. Exits immediately (DOSBox-X runs in background).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="${SCRIPT_DIR}/.dosbox.pid"
CONTROL_PORT="${DOSBOX_CONTROL_PORT:-10199}"
START_MINIMIZED="${DOSBOX_START_MINIMIZED:-1}"
HEADLESS="${DOSBOX_HEADLESS:-0}"
if [ -n "${1:-}" ]; then
    DOSBOX="$1"
elif [ -x "${SCRIPT_DIR}/../tools/dosbox-x-src/src/dosbox-x" ]; then
    # Prefer the locally built fork. It contains the newest control API,
    # including modifier keys and main-thread mouse click dispatch.
    DOSBOX="${SCRIPT_DIR}/../tools/dosbox-x-src/src/dosbox-x"
else
    DOSBOX="${SCRIPT_DIR}/../tools/dosbox-x"
fi
CONF="${2:-${SCRIPT_DIR}/dosbox-test.conf}"
EXTRA_CONF="${3:-}"
DOSBOX_ARGS=(-conf "$CONF")
if [ -n "$EXTRA_CONF" ]; then
    DOSBOX_ARGS+=(-conf "$EXTRA_CONF")
fi

# Ask an existing controlled instance to exit before falling back to process
# cleanup. This also makes ownership of the fixed localhost port unambiguous.
if printf 'PING\n' | nc -w 1 127.0.0.1 "$CONTROL_PORT" 2>/dev/null | grep -q '^OK PONG'; then
    printf 'QUIT\n' | nc -w 1 127.0.0.1 "$CONTROL_PORT" >/dev/null 2>&1 || true
fi

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

# Wait until the old control endpoint is gone. Do not broadly kill other
# DOSBox-X instances the user may be running for unrelated work.
for _attempt in $(seq 1 50); do
    if ! printf 'PING\n' | nc -w 1 127.0.0.1 "$CONTROL_PORT" 2>/dev/null | grep -q '^OK PONG'; then
        break
    fi
    sleep 0.1
done
if printf 'PING\n' | nc -w 1 127.0.0.1 "$CONTROL_PORT" 2>/dev/null | grep -q '^OK PONG'; then
    echo "Could not release DOSBox-X control port $CONTROL_PORT" >&2
    exit 1
fi

# Start new instance with control server enabled
cd "$SCRIPT_DIR"
if [ "$HEADLESS" = "1" ]; then
    SDL_VIDEODRIVER=dummy DOSBOX_CONTROL_PORT="$CONTROL_PORT" \
        "$DOSBOX" "${DOSBOX_ARGS[@]}" &
else
    DOSBOX_CONTROL_PORT="$CONTROL_PORT" \
        "$DOSBOX" "${DOSBOX_ARGS[@]}" &
fi
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
echo "DOSBox-X started (PID $NEW_PID)"

# Prove that the freshly launched process owns a working control endpoint.
for _attempt in $(seq 1 100); do
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
        echo "DOSBox-X exited before its control server became ready" >&2
        rm -f "$PIDFILE"
        exit 1
    fi
    if printf 'PING\n' | nc -w 1 127.0.0.1 "$CONTROL_PORT" 2>/dev/null | grep -q '^OK PONG'; then
        if ! node "${SCRIPT_DIR}/../scripts/verify-dosbox-identity.js" \
            --port "$CONTROL_PORT" --timeout 3000; then
            echo "DOSBox-X control server has an unexpected build identity" >&2
            kill "$NEW_PID" 2>/dev/null || true
            rm -f "$PIDFILE"
            exit 1
        fi
        if [ "$HEADLESS" != "1" ] && [ "$START_MINIMIZED" != "0" ]; then
            if ! printf 'MINIMIZE\n' | nc -w 3 127.0.0.1 "$CONTROL_PORT" 2>/dev/null | grep -q '^OK MINIMIZED'; then
                echo "DOSBox-X control server could not minimize its window" >&2
                kill "$NEW_PID" 2>/dev/null || true
                rm -f "$PIDFILE"
                exit 1
            fi
        fi
        exit 0
    fi
    sleep 0.1
done

echo "Fresh DOSBox-X did not claim control port $CONTROL_PORT" >&2
kill "$NEW_PID" 2>/dev/null || true
rm -f "$PIDFILE"
exit 1
