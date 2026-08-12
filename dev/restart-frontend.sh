#!/bin/bash
# Restart the frontend dev server in the ymerflow-dev screen session

SCREEN_SESSION="ymerflow-dev"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! screen -list | grep -q "\.$SCREEN_SESSION\s"; then
    echo "Screen session '$SCREEN_SESSION' not found. Run ./dev/runall.sh first."
    exit 1
fi

echo "Restarting frontend..."
screen -S "$SCREEN_SESSION" -p frontend -X stuff $'\003'
sleep 1
screen -S "$SCREEN_SESSION" -p frontend -X stuff "cd '$PROJECT_ROOT/frontend' && npm start\n"
echo "Frontend restarting in window 'frontend'."
