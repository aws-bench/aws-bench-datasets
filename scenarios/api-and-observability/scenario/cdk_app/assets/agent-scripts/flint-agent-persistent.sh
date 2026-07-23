#!/bin/bash
# Persistent Flint Agent - Intermediate version with connection maintenance

WEBSOCKET_URL="PLACEHOLDER_WEBSOCKET_ENDPOINT"
DEPLOYMENT_ID="test-deployment-001"
HOSTNAME=$(hostname)
IP_ADDRESS=$(hostname -I | awk '{print $1}')
AGENT_VERSION="9.0.0"

echo "Starting Flint Agent (Persistent Version)"
echo "WebSocket URL: $WEBSOCKET_URL"
echo "Hostname: $HOSTNAME"
echo "IP: $IP_ADDRESS"

while true; do
    echo "$(date): Connecting to WebSocket..."
    
    {
        # Send registration
        echo '{"action":"agent_connected","deploymentId":"'$DEPLOYMENT_ID'","hostname":"'$HOSTNAME'","ip":"'$IP_ADDRESS'","agentVersion":"'$AGENT_VERSION'","token":"test-token-123"}'
        
        # Keep connection alive with periodic pings
        while true; do
            sleep 10
            echo '{"action":"ping","timestamp":'$(date +%s%3N)'}'
        done
    } | websocat "$WEBSOCKET_URL" 2>&1 | while read -r line; do
        echo "$(date): $line"
    done
    
    echo "$(date): Connection closed, reconnecting in 5s..."
    sleep 5
done
