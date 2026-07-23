#!/bin/bash
# Professional Flint Agent - Maintains persistent connection with proper heartbeat

WEBSOCKET_URL="PLACEHOLDER_WEBSOCKET_ENDPOINT"
DEPLOYMENT_ID="test-deployment-001"
HOSTNAME=$(hostname)
IP_ADDRESS=$(hostname -I | awk '{print $1}')
AGENT_VERSION="9.0.0"
HEARTBEAT_INTERVAL=30
RECONNECT_DELAY=5

echo "Starting Flint Agent (Professional Version)"
echo "WebSocket URL: $WEBSOCKET_URL"
echo "Hostname: $HOSTNAME"
echo "IP: $IP_ADDRESS"
echo "Heartbeat interval: ${HEARTBEAT_INTERVAL}s"

# Named pipes for bidirectional communication
PIPE_IN="/tmp/ws_in_$$"
PIPE_OUT="/tmp/ws_out_$$"
mkfifo "$PIPE_IN" "$PIPE_OUT"

cleanup() {
    echo "$(date): Cleaning up..."
    rm -f "$PIPE_IN" "$PIPE_OUT"
    kill $(jobs -p) 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

connect_websocket() {
    echo "$(date): Establishing WebSocket connection..."
    
    # Start websocat in background
    websocat "$WEBSOCKET_URL" < "$PIPE_IN" > "$PIPE_OUT" 2>&1 &
    WS_PID=$!
    
    # Wait a moment for connection to establish
    sleep 2
    
    if ! kill -0 $WS_PID 2>/dev/null; then
        echo "$(date): Failed to establish connection"
        return 1
    fi
    
    # Send registration
    echo "$(date): Sending registration..."
    echo '{"action":"agent_connected","deploymentId":"'$DEPLOYMENT_ID'","hostname":"'$HOSTNAME'","ip":"'$IP_ADDRESS'","agentVersion":"'$AGENT_VERSION'","token":"test-token-123"}' > "$PIPE_IN"
    
    return 0
}

send_heartbeat() {
    while true; do
        sleep $HEARTBEAT_INTERVAL
        if kill -0 $WS_PID 2>/dev/null; then
            echo "$(date): Sending heartbeat..."
            echo '{"action":"heartbeat","timestamp":'$(date +%s%3N)'}' > "$PIPE_IN"
        else
            echo "$(date): WebSocket process died, breaking heartbeat loop"
            break
        fi
    done
}

read_messages() {
    while read -r line; do
        echo "$(date): Received: $line"
        
        # Parse message type
        if echo "$line" | grep -q '"type":"registration_success"'; then
            echo "$(date): Registration successful!"
        elif echo "$line" | grep -q '"type":"heartbeat_ack"'; then
            echo "$(date): Heartbeat acknowledged"
        fi
    done < "$PIPE_OUT"
    
    echo "$(date): Message reader exited"
}

# Main connection loop
while true; do
    if connect_websocket; then
        echo "$(date): Connected successfully"
        
        # Start heartbeat sender in background
        send_heartbeat &
        HEARTBEAT_PID=$!
        
        # Read messages (blocks until connection closes)
        read_messages
        
        # Connection closed, cleanup
        kill $HEARTBEAT_PID 2>/dev/null
        kill $WS_PID 2>/dev/null
        wait $WS_PID 2>/dev/null
    fi
    
    echo "$(date): Connection lost, reconnecting in ${RECONNECT_DELAY}s..."
    sleep $RECONNECT_DELAY
done
