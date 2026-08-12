#!/bin/bash
# Restart the backend server in the ymerflow-dev screen session

SCREEN_SESSION="ymerflow-dev"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! screen -list | grep -q "\.$SCREEN_SESSION\s"; then
    echo "Screen session '$SCREEN_SESSION' not found. Run ./dev/runall.sh first."
    exit 1
fi

echo "Restarting backend..."
screen -S "$SCREEN_SESSION" -p backend -X stuff $'\003'
sleep 1
screen -S "$SCREEN_SESSION" -p backend -X stuff "cd '$PROJECT_ROOT' && source env/bin/activate && ./backend/run.sh\n"
echo "Backend restarting in window 'backend'."
