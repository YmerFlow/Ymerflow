#!/bin/bash
# Stop all YmerFlow development services

SCREEN_SESSION="nagelfluh-dev"

echo "Stopping YmerFlow development services..."

# Kill screen session if it exists
if screen -list | grep -q "\.$SCREEN_SESSION\s"; then
    echo "Stopping screen session: $SCREEN_SESSION"
    screen -X -S "$SCREEN_SESSION" quit
    echo "✓ Screen session stopped"
else
    echo "Screen session '$SCREEN_SESSION' not found"
fi

# Note: this only stops the local dev services (backend/frontend/monitor screen windows). The
# bootstrap-provisioned cluster backends (storage/registry/cluster) keep running independently.

echo ""
echo "Dev services stopped. Bootstrap-provisioned cluster resources remain running."
echo ""
echo "To tear down the provisioned backends (storage, registry, jobs/Kueue), run:"
echo "  ./dev/cleanup-all.sh"
echo ""
echo "To also stop/delete the cluster itself (e.g. a local Minikube VM: 'minikube stop'),"
echo "do so manually — see the guidance printed by ./dev/cleanup-all.sh."
