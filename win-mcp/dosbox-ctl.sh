#!/bin/bash
# DOSBox-X Control Client
# Sends a command to the DOSBox-X control server and prints the response.
# Usage: ./dosbox-ctl.sh <command>
# Example: ./dosbox-ctl.sh PING
#          ./dosbox-ctl.sh SCREENSHOT
#          ./dosbox-ctl.sh STATUS

PORT="${DOSBOX_CONTROL_PORT:-10199}"
HOST="127.0.0.1"
CMD="$*"

if [ -z "$CMD" ]; then
    echo "Usage: $0 <command>"
    echo "Commands: PING, SCREENSHOT, STATUS, QUIT"
    exit 1
fi

# Use nc (netcat) to send command and read response
echo "$CMD" | nc -w 5 "$HOST" "$PORT"
